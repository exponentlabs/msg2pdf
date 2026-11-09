const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('b1Harness', {
  runtime: () => ipcRenderer.invoke('b1-runtime'),
  assemble: (pages) => ipcRenderer.invoke('b1-assemble', pages),
});
