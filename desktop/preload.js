'use strict';

/**
 * The renderer's entire view of the main process. Context isolation is on
 * and node integration is off, so this is the only door — nothing here
 * hands over a raw ipcRenderer or any other capability that isn't an
 * explicit, named function.
 */

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('lanshare', {
  getStatus: () => invoke('status'),
  startServer: () => invoke('server:start'),
  stopServer: () => invoke('server:stop'),
  openLibraryFolder: () => invoke('library:open'),
  quit: () => invoke('app:quit'),
  pickFolder: () => invoke('dialog:pickFolder'),
  pickLibraryFiles: () => invoke('dialog:pickLibraryFiles'),
  copyToClipboard: (text) => invoke('clipboard:copy', text),

  accounts: {
    list: () => invoke('accounts:list'),
    create: (input) => invoke('accounts:create', input),
    update: (username, patch) => invoke('accounts:update', username, patch),
    remove: (username) => invoke('accounts:remove', username),
  },

  sessions: {
    list: () => invoke('sessions:list'),
    revoke: (id) => invoke('sessions:revoke', id),
  },

  library: {
    stats: () => invoke('library:stats'),
    clearCache: () => invoke('library:clearCache'),
    emptyTrash: () => invoke('library:emptyTrash'),
    move: (newPath, mode) => invoke('library:move', { newPath, mode }),
  },

  locations: {
    list: () => invoke('locations:list'),
    add: (label, path) => invoke('locations:add', { label, path }),
    remove: (id) => invoke('locations:remove', id),
    albums: () => invoke('locations:albums'),
    relocate: (album, locationId) => invoke('locations:relocate', { album, locationId }),
    bringHome: (album) => invoke('locations:bringHome', album),
  },

  sync: {
    list: () => invoke('sync:list'),
    albums: () => invoke('sync:albums'),
    add: (input) => invoke('sync:add', input),
    update: (id, patch) => invoke('sync:update', { id, patch }),
    remove: (id) => invoke('sync:remove', id),
    preview: (id) => invoke('sync:run', { id, dryRun: true }),
    run: (id) => invoke('sync:run', { id, dryRun: false }),
    /** Fires while a sync runs, so the screen can show it moving. */
    onProgress: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('sync-progress', listener);
      return () => ipcRenderer.removeListener('sync-progress', listener);
    },
    /** Fires when a sync starts or ends on its own, because a drive appeared. */
    onChanged: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('sync-changed', listener);
      return () => ipcRenderer.removeListener('sync-changed', listener);
    },
  },

  connections: {
    list: () => invoke('connections:list'),
    add: (input) => invoke('connections:add', input),
    remove: (id) => invoke('connections:remove', id),
    browse: (id, path, password) => invoke('connections:browse', { id, path, password }),
    copy: (input) => invoke('connections:copy', input),
    /** Fires as files move between this machine and another. */
    onProgress: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('transfer-progress', listener);
      return () => ipcRenderer.removeListener('transfer-progress', listener);
    },
  },

  setup: {
    status: () => invoke('setup:status'),
    allowFirewall: () => invoke('setup:allowFirewall'),
    complete: (input) => invoke('setup:complete', input),
  },

  tunnel: {
    status: () => invoke('tunnel:status'),
    enable: (relayHost, relayPort) => invoke('tunnel:enable', { relayHost, relayPort }),
    disable: () => invoke('tunnel:disable'),
    code: () => invoke('tunnel:code'),
  },

  vaults: {
    list: () => invoke('vaults:list'),
    unlock: (path, secret) => invoke('vaults:unlock', { path, ...secret }),
    lock: (path) => invoke('vaults:lock', path),
    keys: (path) => invoke('vaults:keys', path),
    addKey: (path, passphrase, label) => invoke('vaults:addKey', { path, passphrase, label }),
    removeKey: (path, keyId) => invoke('vaults:removeKey', { path, keyId }),
    recoveryCode: (path) => invoke('vaults:recoveryCode', path),
  },

  settings: {
    get: () => invoke('settings:get'),
    update: (patch) => invoke('settings:update', patch),
  },

  rules: {
    get: () => invoke('rules:get'),
    save: (text) => invoke('rules:save', text),
    plan: () => invoke('rules:plan'),
    apply: () => invoke('rules:apply'),
    batches: () => invoke('rules:batches'),
    undo: () => invoke('rules:undo'),
    draft: (instruction) => invoke('rules:draft', instruction),
    runOnce: (text) => invoke('rules:runOnce', text),
  },

  capture: {
    pending: () => invoke('capture:pending'),
    importNow: () => invoke('capture:importNow'),
    dismiss: () => invoke('capture:dismiss'),
    never: () => invoke('capture:never'),
    /** Fires the moment a capture device is recognised. */
    onDetected: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('capture-detected', listener);
      return () => ipcRenderer.removeListener('capture-detected', listener);
    },
    /** Fires while an accepted import is copying. */
    onProgress: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('capture-progress', listener);
      return () => ipcRenderer.removeListener('capture-progress', listener);
    },
  },

  /** Fires after anything that could have changed the status view. */
  onStatusChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('status-changed', listener);
    return () => ipcRenderer.removeListener('status-changed', listener);
  },
});
