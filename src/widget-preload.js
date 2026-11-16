const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('widgetApi', {
  onLevel: (cb) => { const h = (_e, data) => cb(data); ipcRenderer.on('widget-level', h); return () => ipcRenderer.removeListener('widget-level', h); },
  onState: (cb) => { const h = (_e, data) => cb(data); ipcRenderer.on('widget-state', h); return () => ipcRenderer.removeListener('widget-state', h); },
  widgetClicked: () => ipcRenderer.send('widget-clicked'),
  widgetClose: () => ipcRenderer.send('widget-close'),
  hideWidget: () => ipcRenderer.send('hide-widget'),
  dragStart: () => ipcRenderer.send('widget-drag-start'),
  dragMove: (dx, dy) => ipcRenderer.send('widget-drag-move', dx, dy),
  dragEnd: () => ipcRenderer.send('widget-drag-end'),
});
