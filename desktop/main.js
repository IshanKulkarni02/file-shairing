'use strict';

/**
 * Electron main process: owns the server's lifecycle instead of it being a
 * bare CLI process. The window is a control panel — Status, Accounts,
 * Devices, Library, Settings — not the phone-facing gallery, which stays
 * exactly what it always was and is what the server keeps serving to every
 * other device on the network.
 */

const {
  app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, dialog, clipboard, safeStorage,
} = require('electron');
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
//
// An explicitly set LANSHARE_HOME wins, so the app can be pointed at a
// throwaway directory. Overriding it unconditionally meant a test that
// believed it was running against a scratch install was quietly running
// against the real one — and rewrote its account.
if (!process.env.LANSHARE_HOME) {
  process.env.LANSHARE_HOME = app.getPath('userData');
}

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
const connections = require('../lib/connections');
const tunnel = require('../lib/tunnel');
const paths = require('../lib/paths');
const firewall = require('../lib/firewall');
const volumesLib = require('../lib/volumes');
const captureDeviceLib = require('../lib/capture-device');
const captureWatcherLib = require('../lib/capture-watcher');
const importLib = require('../lib/import');
const indexerLib = require('../lib/indexer');
const sortRulesLib = require('../lib/sort-rules');
const sortEngineLib = require('../lib/sort-engine');
const nlRulesLib = require('../lib/nl-rules');
const indexDbLib = require('../lib/index-db');

const { config, generated } = configLib.loadOrCreate();

let mainWindow = null;
let tray = null;
let serverHandle = null;
let captureWatcher = null;
// The one detected-but-undecided capture device, if any. A second card
// arriving while this one is still waiting simply replaces it — showing two
// overlapping prompts is more confusing than asking about the newer one
// first and letting the person replug the first card if it still matters.
let pendingCapture = null;
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
  serverHandle = await serverApp.start(config, { secrets: secretStore() });

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

  captureWatcher = new captureWatcherLib.CaptureWatcher({
    getConfig: () => config,
    getIndexDb: () => serverHandle?.indexDb || null,
    getLibraryVolumeId: () => volumesLib.identify(libraryPath())?.id || null,
    onDetected: ({ volume, plan }) => {
      // A second card arriving before the first was decided replaces it —
      // see the note on the pendingCapture declaration above.
      pendingCapture = { volume, plan };
      showWindow();
      mainWindow?.webContents.send('capture-detected', {
        volumeId: volume.id,
        label: volume.label,
        fileCount: plan.candidates.length,
        totalBytes: plan.totalBytes,
        alreadyImported: plan.alreadyImported,
      });
    },
    log: (message) => console.log(`[capture] ${message}`),
  });
  captureWatcher.start();

  return serverHandle;
}

async function stopServerImpl() {
  if (!serverHandle) return;
  captureWatcher?.stop();
  captureWatcher = null;
  pendingCapture = null;
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
    // Shown in the window. Every build being 1.0.0 is how an old install got
    // mistaken for a broken new one; a version you can read makes "did it
    // actually update" a question anyone can answer for themselves.
    //
    // Read from package.json rather than app.getVersion(), which returns the
    // app's version only when packaged and Electron's own — 43.2.0 — when run
    // from source. A version field that is right in one build and wrong in
    // the other is worse than none, since it is trusted either way.
    version: require('../package.json').version,
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

  // A target="_blank" link (the Ollama info link on the sorting-rules screen)
  // would otherwise silently no-op — Electron denies window.open by default
  // unless a handler explicitly allows it. Only http(s) ever gets routed out
  // to the OS browser; nothing else is opened this way.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

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
        || err instanceof syncEngine.SyncError
        || err instanceof importLib.ImportError
        || err instanceof sortRulesLib.SortRulesError
        || err instanceof sortEngineLib.SortEngineError
        || err instanceof nlRulesLib.NlRulesError) {
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
  const added = locations.add(config, { label, targetPath: target, library: libraryPath() });
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

// --- sorting rules (Phase L) -------------------------------------------------
// Mirrors the /api/sort-rules* HTTP routes in lib/server-app.js — those exist
// for the web gallery and anything else talking HTTP; this talks to the same
// lib/ modules directly, the same way sync:* above calls syncTargets/syncEngine
// rather than looping back through its own server over HTTP.

function currentIndexEntries() {
  if (!serverHandle?.indexDb) return [];
  return serverHandle.indexDb.search({ limit: 1_000_000 }).map(indexDbLib.dbRowToResult);
}

ipcMain.handle('rules:get', () => {
  const text = sortRulesLib.readRulesText(libraryPath());
  let ruleCount = 0;
  let error = null;
  try {
    ruleCount = sortRulesLib.parse(text).length;
  } catch (err) {
    error = err.message;
  }
  return {
    text, ruleCount, error, gitAvailable: sortRulesLib.isGitAvailable(), history: sortRulesLib.ruleHistory(libraryPath()),
  };
});

ipcMain.handle('rules:save', guarded((event, text) => {
  const parsed = sortRulesLib.saveRulesText(libraryPath(), text, { message: 'Update sorting rules' });
  return { ruleCount: parsed.length };
}));

ipcMain.handle('rules:plan', guarded(async () => {
  const result = await sortEngineLib.plan({ library: libraryPath(), entries: currentIndexEntries() });
  return { result };
}));

ipcMain.handle('rules:apply', guarded(async () => {
  const planned = await sortEngineLib.plan({ library: libraryPath(), entries: currentIndexEntries() });
  const batch = await sortEngineLib.apply({ library: libraryPath(), moves: planned.moves });
  if (serverHandle?.indexDb) await indexerLib.scanLibrary(libraryPath(), serverHandle.indexDb);
  return { batch };
}));

ipcMain.handle('rules:batches', () => ({ batches: sortEngineLib.loadBatches(libraryPath()) }));

ipcMain.handle('rules:undo', guarded(async () => {
  const result = await sortEngineLib.undoLastBatch({ library: libraryPath() });
  if (serverHandle?.indexDb) await indexerLib.scanLibrary(libraryPath(), serverHandle.indexDb);
  return result;
}));

// Draft/run-once (Phase M) — mirrors POST /api/sort-rules/draft and
// /run-once exactly, including computing a live preview alongside a
// draft that parsed, since the renderer shows both from one call.
ipcMain.handle('rules:draft', guarded(async (event, instruction) => {
  const draft = await nlRulesLib.draftRule({
    instruction,
    host: config.nlRules?.host || nlRulesLib.DEFAULT_HOST,
    model: config.nlRules?.model || nlRulesLib.DEFAULT_MODEL,
  });
  let preview = null;
  if (draft.parsed) {
    preview = await sortEngineLib.plan({ library: libraryPath(), entries: currentIndexEntries(), rulesText: draft.text });
  }
  return { ...draft, preview };
}));

ipcMain.handle('rules:runOnce', guarded(async (event, text) => {
  const planned = await sortEngineLib.plan({ library: libraryPath(), entries: currentIndexEntries(), rulesText: text });
  const batch = await sortEngineLib.apply({ library: libraryPath(), moves: planned.moves });
  if (serverHandle?.indexDb) await indexerLib.scanLibrary(libraryPath(), serverHandle.indexDb);
  return { batch };
}));

// --- importing from a camera, drone or card (Phase K) -----------------------

/**
 * Where an import lands. Phase L's sorting rules do not exist yet, so this
 * is a predictable, honest default rather than an attempt to guess a
 * destination cleverly — a device label under a top-level "Imports" album,
 * created if it does not already exist. The seam for L to override this
 * later is here, not spread across the IPC handler below.
 */
function importDestination(label) {
  const safe = paths.safeName(label || 'Device');
  return path.join(libraryPath(), 'Imports', safe);
}

ipcMain.handle('capture:pending', () => (pendingCapture ? {
  volumeId: pendingCapture.volume.id,
  label: pendingCapture.volume.label,
  fileCount: pendingCapture.plan.candidates.length,
  totalBytes: pendingCapture.plan.totalBytes,
  alreadyImported: pendingCapture.plan.alreadyImported,
} : null));

/** An absolute path under the library, as the "/Foo/bar.jpg" form every route and rule uses. */
function toLibraryRelPath(absPath) {
  return `/${path.relative(libraryPath(), absPath).split(path.sep).join('/')}`;
}

ipcMain.handle('capture:importNow', guarded(async () => {
  if (!pendingCapture) throw new importLib.ImportError('There is nothing waiting to be imported');
  const { volume, plan } = pendingCapture;
  pendingCapture = null;

  const destDir = importDestination(volume.label);
  const result = await importLib.runImport({
    plan,
    destDir,
    onProgress: (progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('capture-progress', { volumeId: volume.id, ...progress });
      }
    },
  });

  let sorted = 0;
  // The library's index has no idea any of this happened until its next
  // scan. Awaited here, not fired-and-forgotten like the sync watcher's own
  // background scans are — sorting rules need EXIF/GPS metadata that only
  // exists once this scan has actually read these specific new files, so
  // there is nothing useful to do until it finishes.
  if (serverHandle?.indexDb) {
    try {
      await indexerLib.scanLibrary(libraryPath(), serverHandle.indexDb);

      // If sorting rules exist, give them first say over where each newly
      // imported file actually belongs — /Imports/<device> (importDestination
      // above) is the fallback for whatever no rule claims, not the last
      // word. Scoped to exactly the files just imported, never the rest of
      // the library — that is what the rules screen's own "apply" is for.
      const rulesText = sortRulesLib.readRulesText(libraryPath());
      if (rulesText.trim()) {
        const entries = result.copied
          .map((c) => serverHandle.indexDb.getByPath(toLibraryRelPath(c.dest)))
          .filter(Boolean)
          .map(indexDbLib.dbRowToResult);
        const planned = await sortEngineLib.plan({ library: libraryPath(), entries, rulesText });
        if (planned.moves.length) {
          const batch = await sortEngineLib.apply({ library: libraryPath(), moves: planned.moves });
          sorted = batch.moved.length;
          await indexerLib.scanLibrary(libraryPath(), serverHandle.indexDb);
        }
      }
    } catch (err) {
      console.warn(`[capture] post-import scan/sort failed: ${err.message}`);
    }
  }

  return {
    destDir, copied: result.copied.length, failed: result.failed, sorted,
  };
}));

ipcMain.handle('capture:dismiss', () => { pendingCapture = null; return {}; });

ipcMain.handle('capture:never', () => {
  if (pendingCapture) captureDeviceLib.dismiss(config, configLib, pendingCapture.volume.id);
  pendingCapture = null;
  return {};
});

// --- other machines --------------------------------------------------------

/** Signed-in remote hosts, by connection id. Sessions live in memory only. */
const openConnections = new Map();

ipcMain.handle('connections:list', () => ({
  connections: connections.list(config),
  // Discovered hosts that are not already paired — the useful half of the
  // discovery list, since re-adding a machine you have is not a thing anyone
  // wants offered.
  discovered: (serverHandle?.discovery?.list() || []).filter((host) => {
    const bases = [`https://${host.address}:${host.httpsPort}`, `http://${host.address}:${host.httpPort}`];
    return !connections.list(config).some((c) => bases.includes(c.base));
  }),
  keychain: secretStore().available,
}));

ipcMain.handle('connections:add', guarded(async (event, input) => {
  // A pairing code means the machine is somewhere else entirely and is
  // reached through a relay; an address means it is on this network.
  const record = input?.code
    ? await connections.addByCode(config, input, { secrets: secretStore() })
    : await connections.add(config, input || {}, { secrets: secretStore() });
  configLib.save(config);
  return { connection: { id: record.id, label: record.label, via: record.via || 'lan' } };
}));

ipcMain.handle('connections:remove', guarded((event, id) => {
  openConnections.delete(id);
  connections.remove(config, id);
  configLib.save(config);
  return {};
}));

ipcMain.handle('connections:browse', guarded(async (event, { id, path: remotePath, password }) => {
  const host = await openConnection(id, password);
  return { listing: await host.list(remotePath || '/') };
}));

ipcMain.handle('connections:copy', guarded(async (event, {
  id, direction, remoteDir, localPath, files, password,
}) => {
  const host = await openConnection(id, password);
  const target = permissionlessLocalPath(localPath);

  const result = await connections.copyFiles(host, {
    direction,
    remoteDir: remoteDir || '/',
    localDir: target,
    files: Array.isArray(files) ? files : [],
    fsp: require('fs/promises'),
    path,
    onProgress: (progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('transfer-progress', { id, ...progress });
      }
    },
  });
  return { result };
}));

/**
 * A local folder inside this library, and nowhere else.
 *
 * The renderer supplies this, so it is checked here rather than trusted —
 * the same rule every server route follows.
 */
function permissionlessLocalPath(input) {
  const resolved = paths.resolveSafe(libraryPath(), input || '/');
  if (!resolved) throw new connections.ConnectionError('That folder is not inside your library');
  fs.mkdirSync(resolved.abs, { recursive: true });
  return resolved.abs;
}

/** Reuse a signed-in session where there is one; sign in when there is not. */
async function openConnection(id, password) {
  const existing = openConnections.get(id);
  if (existing?.cookie) return existing;

  const host = await connections.connect(config, id, { password, secrets: secretStore() });
  openConnections.set(id, host);
  configLib.save(config);
  return host;
}

// --- being reachable over the internet -------------------------------------

/** The tunnel advertising this machine through a relay, when one is on. */
let tunnelHost = null;

ipcMain.handle('tunnel:status', () => ({
  enabled: Boolean(config.relay?.enabled),
  relayHost: config.relay?.host || '',
  relayPort: config.relay?.port || 8460,
  // The code is the key to this library. It is shown on request, never
  // volunteered, and never written to config.json.
  connected: Boolean(tunnelHost?.channel),
}));

ipcMain.handle('tunnel:enable', guarded(async (event, { relayHost: host, relayPort }) => {
  if (!host || !String(host).trim()) {
    throw new connections.ConnectionError('Enter the address of your relay');
  }

  const pairing = tunnel.createPairing();
  config.relay = {
    enabled: true,
    host: String(host).trim(),
    port: Number(relayPort) || 8460,
    // Kept in the keychain, not in config.json — anyone holding this code can
    // reach the library, so it is exactly as sensitive as a password.
    secret: secretStore().available ? secretStore().encrypt(pairing.code) : null,
  };
  configLib.save(config);

  await restartTunnel(pairing);
  return { code: pairing.code };
}));

ipcMain.handle('tunnel:disable', guarded(() => {
  tunnelHost?.stop();
  tunnelHost = null;
  if (config.relay) config.relay.enabled = false;
  configLib.save(config);
  return {};
}));

/** Show the existing code again, for pairing a second device. */
ipcMain.handle('tunnel:code', guarded(() => {
  const code = secretStore().decrypt(config.relay?.secret);
  if (!code) {
    throw new connections.ConnectionError(
      'The pairing code is not readable on this computer. Turn internet access off and '
      + 'on again to issue a new one — the old one will stop working.',
    );
  }
  return { code };
}));

async function restartTunnel(pairing) {
  tunnelHost?.stop();
  tunnelHost = null;
  if (!config.relay?.enabled) return;

  const code = pairing || (() => {
    const saved = secretStore().decrypt(config.relay.secret);
    return saved ? tunnel.parsePairing(saved) : null;
  })();
  if (!code) return;

  tunnelHost = new tunnel.TunnelHost({
    relayHost: config.relay.host,
    relayPort: config.relay.port,
    pairing: code,
    localPort: config.port,
    log: (message) => console.log(`[tunnel] ${message}`),
  });
  tunnelHost.start();
}

let cachedSecretStore = null;
function secretStore() {
  if (!cachedSecretStore) cachedSecretStore = connections.makeSecretStore(safeStorage);
  return cachedSecretStore;
}

/**
 * Pick files to send to another machine, from inside the library.
 *
 * The dialog opens at the library and anything chosen outside it is rejected
 * rather than silently dropped, so "send these" cannot be turned into "read
 * any file on this computer" by navigating up out of the folder.
 */
ipcMain.handle('dialog:pickLibraryFiles', async () => {
  const library = libraryPath();
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose files to send',
    defaultPath: library,
    properties: ['openFile', 'multiSelections'],
  });
  if (result.canceled || !result.filePaths.length) return null;

  const outside = result.filePaths.filter((file) => !paths.isInside(library, file));
  if (outside.length) {
    return { error: 'Those files are outside your library. Copy them into it first.' };
  }

  // All from one folder keeps the transfer a single remote directory, which
  // is what the receiving side expects.
  const dirs = new Set(result.filePaths.map((file) => path.dirname(file)));
  if (dirs.size > 1) {
    return { error: 'Choose files from one album at a time.' };
  }

  const dir = [...dirs][0];
  return {
    dir: `/${path.relative(library, dir).split(path.sep).join('/')}`.replace(/\/+$/, '') || '/',
    names: result.filePaths.map((file) => path.basename(file)),
  };
});

// --- first run ---------------------------------------------------------------

/**
 * Whether the wizard should be shown.
 *
 * Keyed on an explicit flag rather than "does an account exist", because an
 * account always exists — one is generated on first load so the server is
 * never briefly open with no password at all. The flag is what distinguishes
 * "a password was generated and nobody has seen it" from "a person chose one".
 */
ipcMain.handle('setup:status', () => ({
  needed: config.setupComplete !== true,
  defaultUsername: config.users?.[0]?.username || 'admin',
  libraryPath: libraryPath(),
  firewall: firewall.status({ execPath: process.execPath }),
  ports: { http: config.port, https: config.httpsPort },
  addresses: net.lanAddresses().map((a) => a.address),
}));

/** Add the Windows firewall rule. Raises a UAC prompt — the user pressed a button. */
ipcMain.handle('setup:allowFirewall', guarded(() => {
  const result = firewall.allow({
    execPath: process.execPath,
    ports: [config.port, config.httpsPort].filter(Boolean),
  });
  if (!result.ok) throw new accounts.AccountError(result.reason);
  return { firewall: firewall.status({ execPath: process.execPath }) };
}));

ipcMain.handle('setup:complete', guarded(async (event, input) => {
  const { username, password, libraryPath: newLibrary, startOnLogin } = input || {};

  if (!username || !String(username).trim()) {
    throw new accounts.AccountError('Choose a username');
  }
  if (!password || String(password).length < 8) {
    // Longer than the 4 the account form allows, because this one is reachable
    // from every device on the network and is the only thing in front of the
    // whole library.
    throw new accounts.AccountError('Choose a password of at least 8 characters');
  }

  // Moving the library has to happen before the account is written, or a
  // failure would leave the password changed and the wizard still showing.
  if (newLibrary && path.resolve(newLibrary) !== path.resolve(libraryPath())) {
    await serialize(async () => {
      const wasRunning = Boolean(serverHandle);
      await stopServerImpl();
      await library.moveLibrary(libraryPath(), newLibrary, 'move');
      config.library = path.resolve(newLibrary);
      configLib.save(config);
      if (wasRunning) await startServerImpl();
    });
  }

  // Replaces the generated account rather than adding beside it, so there is
  // never a second admin with a password nobody knows.
  //
  // Written into the in-memory config rather than through configLib.setUser,
  // which loads its own copy from disk, changes that, and saves it. Doing
  // both means the later save() here writes back a stale object and wipes the
  // account that was just created — which is exactly what happened.
  const generatedName = config.users?.[0]?.username;
  const chosen = String(username).trim();

  config.users = [configLib.normalizeUser({
    username: chosen,
    role: 'admin',
    roots: ['/'],
    disabled: false,
    ...configLib.hashPassword(String(password)),
  })];

  config.setupComplete = true;
  config.startOnLogin = Boolean(startOnLogin);
  configLib.save(config);
  applyAutostart(config.startOnLogin);

  // Every session from before setup belonged to the generated account.
  sessions.revokeAllForUser(generatedName || 'admin');

  notifyRenderer();
  return { username: String(username).trim() };
}));

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

  // If internet access was left on, start advertising again — otherwise a
  // machine you rely on reaching from elsewhere goes quiet after a reboot,
  // and there is nobody there to notice.
  restartTunnel().catch((err) => console.error('[tunnel]', err.message));

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
