'use strict';

/**
 * Electron main process: owns the server's lifecycle instead of it being a
 * bare CLI process. The window is a control panel — Status, Accounts,
 * Devices, Library, Settings — not the phone-facing gallery, which stays
 * exactly what it always was and is what the server keeps serving to every
 * other device on the network.
 */

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain } = require('electron');
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

const { config, generated } = configLib.loadOrCreate();

let mainWindow = null;
let tray = null;
let serverHandle = null;
// Distinguishes "the user chose Quit" from "the window's close button was
// clicked" — the latter should respect the close-to-tray setting instead of
// always exiting.
let quitting = false;

async function startServer() {
  if (serverHandle) return serverHandle;
  serverHandle = await serverApp.start(config);
  return serverHandle;
}

async function stopServer() {
  if (!serverHandle) return;
  await serverHandle.stop();
  serverHandle = null;
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
    library: serverHandle?.LIBRARY ?? path.resolve(config.library),
    ffmpegReady: ffmpeg.tools().available,
    closeToTray: config.closeToTray,
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

ipcMain.handle('library:open', () => shell.openPath(currentStatus().library));

ipcMain.handle('app:quit', () => { quitting = true; app.quit(); });

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  createWindow();
  createTray();
  await startServer();
  refreshTrayMenu();
  mainWindow.webContents.once('did-finish-load', notifyRenderer);
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
