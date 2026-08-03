'use strict';

/**
 * The renderer's entire view of the main process. Context isolation is on
 * and node integration is off, so this is the only door — nothing here
 * hands over a raw ipcRenderer or any other capability that isn't an
 * explicit, named function.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lanshare', {
  getStatus: () => ipcRenderer.invoke('status'),
  startServer: () => ipcRenderer.invoke('server:start'),
  stopServer: () => ipcRenderer.invoke('server:stop'),
  openLibraryFolder: () => ipcRenderer.invoke('library:open'),
  quit: () => ipcRenderer.invoke('app:quit'),

  /** Fires after anything that could have changed the status view. */
  onStatusChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('status-changed', listener);
    return () => ipcRenderer.removeListener('status-changed', listener);
  },
});
