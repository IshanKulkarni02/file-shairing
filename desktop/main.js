'use strict';

/**
 * Electron main process: owns the server's lifecycle instead of it being a
 * bare CLI process. The window is a control panel — Status, Accounts,
 * Devices, Library, Settings — not the phone-facing gallery, which stays
 * exactly what it always was and is what the server keeps serving to every
 * other device on the network.
 */

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, dialog, clipboard } = require('electron');
const path = require('path');
const QRCode = require('qrcode');

// app.getName() falls back to a generic "Electron" unless this is set
// explicitly — it only infers the name from package.json when launched as
// `electron .`, not `electron desktop/main.js` (how dev and the packaged
// build both actually start it). Setting it directly keeps userData's
// location identical in dev and once packaged, rather than depending on how
// the process happened to be invoked.
app.setName('LANShare');

// The desktop app's own writable data — config.json, session records, and
// (by default) the library — lives in Electron's standard per-user data
// directory, never inside the app's install folder, which is often
// read-only and is not where anyone expects their photos to end up.
//
// This MUST run before lib/config.js is required anywhere in this process:
// it reads LANSHARE_HOME once, at module load time.
process.env.LANSHARE_HOME = app.getPath('userData');

const configLib = require('../lib/config');
const serverApp = require('../lib/server-app');
const net = require('../lib/net');
const ffmpeg = require('../lib/ffmpeg');
const accounts = require('../lib/accounts');
const sessions = require('../lib/sessions');
const library = require('../lib/library');

const { config, generated } = configLib.loadOrCreate();

let mainWindow = null;
let tray = null;
let serverHandle = null;
// Distinguishes "the user chose Quit" from "the window's close button was
// clicked" — the latter should respect the close-to-tray setting instead of
// always exiting.
let quitting = false;

// Every start/stop/restart queues onto this instead of running immediately.
// Without it, two operations landing close together — Settings saving a new
// port at the same moment a Library move finishes and restarts the server —
// could each see serverHandle as null and both call serverApp.start(config),
// racing to bind the same port twice. Public start/stop go through this;
// restartServer and the library:move handler use the *Impl functions
// directly so their own stop-then-start sequence is one atomic entry in the
// queue rather than two entries another operation could land between.
let serverOpChain = Promise.resolve();
function serialize(fn) {
  const result = serverOpChain.then(fn, fn);
  serverOpChain = result.catch(() => {});
  return result;
}

async function startServerImpl() {
  if (serverHandle) return serverHandle;
  serverHandle = await serverApp.start(config);
  return serverHandle;
}

async function stopServerImpl() {
  if (!serverHandle) return;
  await serverHandle.stop();
  serverHandle = null;
}

const startServer = () => serialize(startServerImpl);
const stopServer = () => serialize(stopServerImpl);

function restartServer() {
  return serialize(async () => {
    const wasRunning = Boolean(serverHandle);
    await stopServerImpl();
    if (wasRunning) await startServerImpl();
  });
}

/** Where the library actually is right now, whether or not the server is running. */
function libraryPath() {
  return serverHandle?.LIBRARY ?? path.resolve(config.library);
}

/**
 * The renderer is sandboxed and cannot require('qrcode') itself, so the QR
 * image is rendered here, as a data URL the <img> tag can use directly.
 */
async function currentStatus() {
  const addresses = net.lanAddresses().map((a) => a.address);
  const primary = addresses[0] || '127.0.0.1';
  const primaryUrl = `http://${primary}:${config.port}`;

  let qrDataUrl = null;
  if (serverHandle) {
    try {
      qrDataUrl = await QRCode.toDataURL(primaryUrl, { margin: 1, scale: 6 });
    } catch {
      qrDataUrl = null; // A missing QR image is cosmetic, never worth failing status over.
    }
  }

  return {
    running: Boolean(serverHandle),
    port: config.port,
    httpsPort: serverHandle?.httpsPort ?? null,
    addresses,
    mdnsHost: net.mdnsHost(),
    primaryUrl,
    qrDataUrl,
    library: libraryPath(),
    ffmpegReady: ffmpeg.tools().available,
    closeToTray: config.closeToTray,
    startOnLogin: config.startOnLogin,
    sessionDays: config.sessionDays,
    httpsEnabled: Boolean(config.httpsPort),
    // Only non-null on the very first run ever — the caller should show it
    // once and never be able to fetch it again after this process exits.
    generatedPassword: generated,
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 720,
    minWidth: 420,
    minHeight: 560,
    title: 'LANShare',
    icon: path.join(__dirname, 'ui', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));

  // Closing the window means different things depending on the setting: hide
  // to the tray and keep serving, or actually quit and stop the server. The
  // choice is read fresh here rather than captured once, so flipping the
  // setting takes effect on the very next close, same session.
  mainWindow.on('close', (event) => {
    if (quitting || !config.closeToTray) return;
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'ui', 'icon.png'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('LANShare');
  tray.on('click', showWindow);
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  const running = Boolean(serverHandle);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open LANShare', click: showWindow },
    { type: 'separator' },
    {
      label: running ? 'Stop server' : 'Start server',
      click: async () => {
        if (running) await stopServer(); else await startServer();
        refreshTrayMenu();
        notifyRenderer();
      },
    },
    { type: 'separator' },
    { label: 'Quit LANShare', click: () => { quitting = true; app.quit(); } },
  ]));
}

function showWindow() {
  if (!mainWindow) { createWindow(); return; }
  mainWindow.show();
  mainWindow.focus();
}

function notifyRenderer() {
  mainWindow?.webContents.send('status-changed');
}

// ---------------------------------------------------------------------------
// IPC — the only surface the renderer can reach, via preload's contextBridge
// ---------------------------------------------------------------------------

ipcMain.handle('status', () => currentStatus());

ipcMain.handle('server:start', async () => {
  await startServer();
  refreshTrayMenu();
  return currentStatus();
});

ipcMain.handle('server:stop', async () => {
  await stopServer();
  refreshTrayMenu();
  return currentStatus();
});

ipcMain.handle('app:quit', () => { quitting = true; app.quit(); });

ipcMain.handle('dialog:pickFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('clipboard:copy', (event, text) => { clipboard.writeText(String(text)); });

// --- accounts ----------------------------------------------------------------
// The desktop app manages accounts directly against the same in-memory
// config object the running server reads on every request — no login flow
// of its own is needed, since being able to launch this app on this machine
// already implies at least as much trust as knowing the admin password.

// Electron wraps a thrown error's message with an "Error invoking remote
// method '<channel>': " prefix, which is not something to show someone as
// an error message. Domain errors (a taken username, the last admin
// account) are caught here and returned as a plain {ok:false, error} shape
// instead; anything unexpected still throws, so a real bug is still loud in
// the console rather than silently swallowed.
function guarded(fn) {
  return async (...args) => {
    try {
      return { ok: true, ...(await fn(...args)) };
    } catch (err) {
      if (err instanceof accounts.AccountError || err instanceof library.LibraryError) {
        return { ok: false, error: err.message };
      }
      throw err;
    }
  };
}

ipcMain.handle('accounts:list', () => accounts.list(config));

ipcMain.handle('accounts:create', guarded((event, input) =>
  ({ account: accounts.create(config, input) })));

ipcMain.handle('accounts:update', guarded((event, username, patch) => {
  const updated = accounts.update(config, username, patch);
  // Mirrors the HTTP route in lib/server-app.js: requireAuth already re-reads
  // account.disabled fresh from config.users on every request, so this is
  // cleanup for the Devices list, not what actually blocks access. See the
  // longer comment on the equivalent HTTP route for why a role demotion
  // deliberately does not revoke.
  if (patch?.disabled === true) sessions.revokeAllForUser(username);
  return { account: updated };
}));

ipcMain.handle('accounts:remove', guarded((event, username) => {
  accounts.remove(config, username);
  sessions.revokeAllForUser(username);
  return {};
}));

// --- sessions / devices --------------------------------------------------

ipcMain.handle('sessions:list', () => sessions.list());
ipcMain.handle('sessions:revoke', (event, id) => sessions.revoke(id));

// --- library ---------------------------------------------------------------

ipcMain.handle('library:open', () => shell.openPath(libraryPath()));

ipcMain.handle('library:stats', async () => {
  const dir = libraryPath();
  const [total, cache, trash] = await Promise.all([
    library.getStats(dir),
    library.getCacheStats(dir),
    library.getTrashStats(dir),
  ]);
  return { path: dir, total, cache, trash };
});

ipcMain.handle('library:clearCache', () => library.clearThumbnailCache(libraryPath()));
ipcMain.handle('library:emptyTrash', () => library.emptyTrash(libraryPath()));

ipcMain.handle('library:move', guarded((event, { newPath, mode }) => serialize(async () => {
  const wasRunning = Boolean(serverHandle);
  await stopServerImpl();
  try {
    const result = await library.moveLibrary(libraryPath(), newPath, mode);
    config.library = path.resolve(newPath);
    configLib.save(config);
    return result;
  } finally {
    // Whether the move succeeded or failed, the server should end up running
    // again if it was running before — a failed move must not leave the
    // library offline on top of not having moved.
    if (wasRunning) await startServerImpl();
    refreshTrayMenu();
    notifyRenderer();
  }
})));

// --- settings --------------------------------------------------------------

ipcMain.handle('settings:get', () => ({
  port: config.port,
  httpsPort: config.httpsPort,
  sessionDays: config.sessionDays,
  closeToTray: config.closeToTray,
  startOnLogin: config.startOnLogin,
}));

ipcMain.handle('settings:update', async (event, patch) => {
  const needsRestart = (
    (patch.port !== undefined && patch.port !== config.port)
    || (patch.httpsPort !== undefined && patch.httpsPort !== config.httpsPort)
  );

  if (patch.port !== undefined) config.port = Number(patch.port);
  if (patch.httpsPort !== undefined) config.httpsPort = Number(patch.httpsPort);
  if (patch.sessionDays !== undefined) config.sessionDays = Number(patch.sessionDays);
  if (patch.closeToTray !== undefined) config.closeToTray = Boolean(patch.closeToTray);

  if (patch.startOnLogin !== undefined) {
    config.startOnLogin = Boolean(patch.startOnLogin);
    // Electron's own login-item API — no extra dependency, and it is what
    // actually registers with Windows (or macOS); just storing the setting
    // in config.json would not make the OS do anything.
    app.setLoginItemSettings({ openAtLogin: config.startOnLogin });
  }

  configLib.save(config);
  if (needsRestart) await restartServer();
  refreshTrayMenu();
  notifyRenderer();
  return currentStatus();
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  createWindow();
  createTray();

  // The page usually finishes loading well before the server does (starting
  // HTTPS means generating or reading a certificate), so 'did-finish-load'
  // typically fires *during* the startServer() await below. Registering a
  // `.once()` listener only after that await would miss an event that
  // already happened, and the renderer's first paint would be stuck showing
  // "Stopped" forever with nothing left to correct it. Capturing the event
  // as a promise right away, then awaiting it afterwards, is correct
  // regardless of which finishes first.
  const windowReady = new Promise((resolve) => {
    mainWindow.webContents.once('did-finish-load', resolve);
  });

  await startServer();
  refreshTrayMenu();
  await windowReady;
  notifyRenderer();
});

app.on('activate', () => {
  // macOS convention: clicking the dock icon with no window open reopens one.
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  // With close-to-tray on, the window's own 'close' handler already hid it
  // instead of letting it close, so reaching here means either that setting
  // is off (closing the window is meant to quit) or the platform closed it
  // some other way — either way, stop serving rather than run headless with
  // no window and no tray entry pointing back to it.
  if (!config.closeToTray) { quitting = true; app.quit(); }
});

app.on('before-quit', async (event) => {
  if (!serverHandle) return;
  quitting = true;
  event.preventDefault();
  await stopServer();
  app.quit();
});
