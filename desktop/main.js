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
const fs = require('fs');
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
const vaults = require('../lib/vaults');
const locations = require('../lib/locations');
const syncTargets = require('../lib/sync-targets');
const syncEngine = require('../lib/sync');
const autostart = require('../lib/autostart');

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

  // A sync the watcher starts on its own has to show up on the Sync screen,
  // or the app looks idle while it is busy copying gigabytes.
  if (serverHandle.syncWatcher) {
    serverHandle.syncWatcher.onChange = () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sync-changed', {
          running: serverHandle.syncWatcher.runningIds(),
        });
      }
    };
  }
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
/**
 * Register or unregister start-on-login with the OS.
 *
 * Never fatal: on Linux this writes a file, and a read-only or unusual home
 * directory should cost you the setting, not the app.
 */
function applyAutostart(enabled) {
  try {
    return autostart.set(enabled, {
      app,
      execPath: process.execPath,
      appPath: app.getAppPath(),
      packaged: app.isPackaged,
    });
  } catch (err) {
    console.error('[autostart]', err.message);
    return null;
  }
}

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

/**
 * Create the tray icon, if this desktop has one.
 *
 * A Linux session without an AppIndicator implementation — GNOME without the
 * extension, or a minimal window manager — has no tray at all, and Electron
 * throws rather than degrading. That matters beyond a missing icon: with
 * close-to-tray on, closing the window would hide it somewhere unreachable,
 * so the setting is forced off when there is nowhere to hide to.
 */
function createTray() {
  try {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'ui', 'icon.png'));
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
    tray.setToolTip('LANShare');
    tray.on('click', showWindow);
    refreshTrayMenu();
  } catch (err) {
    tray = null;
    console.error('[tray] no system tray available:', err.message);
    if (config.closeToTray) {
      config.closeToTray = false;
      configLib.save(config);
      console.error('[tray] close-to-tray turned off, or the window would vanish with no way back');
    }
  }
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
      if (err instanceof accounts.AccountError
        || err instanceof library.LibraryError
        || err instanceof vaults.VaultStateError
        || err instanceof locations.LocationError
        || err instanceof syncTargets.SyncTargetError
        || err instanceof syncEngine.SyncError) {
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

// --- vaults ----------------------------------------------------------------
// Unlike accounts, these are not simply "the desktop app is trusted". A vault
// only opens for whoever knows its passphrase — running this app on this
// machine grants nothing on its own, which is the whole point of a vault
// that survives the drive being stolen.

function vaultAt(albumPath) {
  const found = vaults.findVault(libraryPath(), albumPath);
  if (!found) throw new vaults.VaultStateError('That album is not a vault', 404);
  return found;
}

ipcMain.handle('vaults:list', () => vaults.listVaults(libraryPath()));

ipcMain.handle('vaults:unlock', guarded(async (event, { path: albumPath, passphrase, recoveryCode }) => {
  const found = vaultAt(albumPath);
  if (recoveryCode) vaults.unlockWithRecoveryCode(found.metadata, recoveryCode);
  else await vaults.unlockVault(found.metadata, passphrase);
  return {};
}));

ipcMain.handle('vaults:lock', guarded((event, albumPath) => {
  vaults.lockVault(vaultAt(albumPath).metadata.id);
  return {};
}));

ipcMain.handle('vaults:keys', guarded((event, albumPath) =>
  ({ keys: vaults.listKeys(vaultAt(albumPath).metadata) })));

ipcMain.handle('vaults:addKey', guarded(async (event, { path: albumPath, passphrase, label }) => {
  const found = vaultAt(albumPath);
  return { keys: await vaults.addPassphrase(found.absDir, found.metadata, { passphrase, label }) };
}));

ipcMain.handle('vaults:removeKey', guarded(async (event, { path: albumPath, keyId }) => {
  const found = vaultAt(albumPath);
  return { keys: await vaults.removePassphrase(found.absDir, found.metadata, keyId) };
}));

ipcMain.handle('vaults:recoveryCode', guarded((event, albumPath) =>
  ({ code: vaults.exportRecoveryCode(vaultAt(albumPath).metadata) })));

// --- storage locations -----------------------------------------------------

ipcMain.handle('locations:list', () => locations.list(config).map((loc) => ({
  ...loc,
  albums: locations.albumsOn(libraryPath(), config, loc.id).map((a) => a.name),
})));

ipcMain.handle('locations:add', guarded((event, { label, path: target }) => {
  const added = locations.add(config, { label, targetPath: target });
  configLib.save(config);
  return { location: added };
}));

ipcMain.handle('locations:remove', guarded((event, id) => {
  locations.remove(config, libraryPath(), id);
  configLib.save(config);
  return {};
}));

/** Top-level albums, with whether each already lives on another drive. */
ipcMain.handle('locations:albums', () => {
  const lib = libraryPath();
  let entries;
  try {
    entries = fs.readdirSync(lib, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => !e.name.startsWith('.'))
    .map((e) => ({ entry: e, album: locations.describeAlbum(lib, config, e.name) }))
    // A relocated album is a junction, which the dirent reports as a symlink
    // and not a directory. Filtering on isDirectory() alone would hide exactly
    // the albums this screen exists to bring back.
    .filter(({ entry, album }) => album.linked || entry.isDirectory())
    .map(({ album }) => album);
});

ipcMain.handle('locations:relocate', guarded(async (event, { album, locationId }) =>
  ({ result: await locations.relocateAlbum(libraryPath(), config, album, locationId) })));

ipcMain.handle('locations:bringHome', guarded(async (event, album) =>
  ({ result: await locations.bringAlbumHome(libraryPath(), config, album) })));

// --- syncing to a drive ----------------------------------------------------

ipcMain.handle('sync:list', () => ({
  targets: syncTargets.list(config, libraryPath()),
  policies: syncTargets.POLICIES,
  running: [...runningSyncs.keys()],
}));

/** Top-level albums a sync could be set up for, plus the whole library. */
ipcMain.handle('sync:albums', () => {
  const lib = libraryPath();
  let entries = [];
  try {
    entries = fs.readdirSync(lib, { withFileTypes: true });
  } catch {
    return [{ path: '/', name: 'Everything in the library' }];
  }
  const albums = entries
    .filter((e) => !e.name.startsWith('.'))
    // A junction is a relocated album, and still a perfectly good thing to
    // sync — it just is not reported as a directory.
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => ({ path: `/${e.name}`, name: e.name }));
  return [{ path: '/', name: 'Everything in the library' }, ...albums];
});

ipcMain.handle('sync:add', guarded((event, input) => {
  const target = syncTargets.add(config, libraryPath(), input || {});
  configLib.save(config);
  return { target };
}));

ipcMain.handle('sync:update', guarded((event, { id, patch }) => {
  const target = syncTargets.update(config, id, patch || {});
  configLib.save(config);
  return { target };
}));

ipcMain.handle('sync:remove', guarded((event, id) => {
  syncTargets.remove(config, id);
  configLib.save(config);
  return {};
}));

/** Syncs in flight, by target id — see the same guard in lib/server-app.js. */
const runningSyncs = new Map();

ipcMain.handle('sync:run', guarded(async (event, { id, dryRun }) => {
  if (!dryRun && runningSyncs.has(id)) {
    throw new syncTargets.SyncTargetError('That sync is already running', 409);
  }

  const resolved = syncTargets.resolveForRun(config, libraryPath(), id, { create: !dryRun });
  const work = syncEngine.run({
    library: libraryPath(),
    sourceDir: resolved.sourceDir,
    targetDir: resolved.targetDir,
    driveRoot: resolved.driveRoot,
    targetId: resolved.targetId,
    policy: resolved.policy,
    conflictLabel: resolved.conflictLabel,
    dryRun: Boolean(dryRun),
    onProgress: dryRun ? null : throttledProgress(id),
  });

  if (!dryRun) runningSyncs.set(id, work);
  try {
    const report = await work;
    if (!dryRun) {
      syncTargets.recordRun(config, id, report);
      configLib.save(config);
    }
    return { report };
  } finally {
    if (!dryRun) runningSyncs.delete(id);
  }
}));

/**
 * The engine reports every action; the window does not need that many.
 * Throttling here rather than in the engine keeps the engine's hook precise
 * enough to test mid-run interruption with.
 */
function throttledProgress(id) {
  let last = 0;
  return (progress) => {
    const now = Date.now();
    if (now - last < 200 && progress.done !== progress.total) return;
    last = now;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sync-progress', { id, ...progress });
    }
  };
}

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
    // Electron's login-item API covers Windows and macOS but does nothing at
    // all on Linux — silently, so the checkbox would tick and nothing would
    // ever start. lib/autostart.js writes the XDG entry there instead.
    applyAutostart(config.startOnLogin);
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
