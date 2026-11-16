const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('widgetApi', {
  onLevel: (cb) => { const h = (_e, data) => cb(data); ipcRenderer.on('widget-level', h); return () => ipcRenderer.removeListener('widget-level', h); },
  onState: (cb) => { const h = (_e, data) => cb(data); ipcRenderer.on('widget-state', h); return () => ipcRenderer.removeListener('widget-state', h); },
});
