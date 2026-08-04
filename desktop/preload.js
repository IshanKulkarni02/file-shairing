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

  /** Fires after anything that could have changed the status view. */
  onStatusChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('status-changed', listener);
    return () => ipcRenderer.removeListener('status-changed', listener);
  },
});
