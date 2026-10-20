'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const listeners = new Map();
// only Atlas' own pages (main window, tool windows and the app tabs inside them) get the bridge
if (location.protocol === 'atlas:' && location.host === 'app') contextBridge.exposeInMainWorld('atlas', {
  invoke: (name, ...args) => ipcRenderer.invoke('invoke', name, ...args),
  on: (channel, fn) => {
    const wrapped = (_e, data) => fn(data);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  startDrag: (paths) => ipcRenderer.send('drag:start', paths),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return null; } },
});
