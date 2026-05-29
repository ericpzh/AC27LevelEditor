const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // File operations
  openFile: () => ipcRenderer.send('menu-open'),
  saveFile: (data) => ipcRenderer.invoke('save-file', data),
  saveFileDirect: (data) => ipcRenderer.invoke('save-file-direct', data),
  exportCSV: (data) => ipcRenderer.invoke('export-csv', data),

  // Events from main
  onFileLoaded: (cb) => ipcRenderer.on('file-loaded', (e, data) => cb(data)),
  onMenuSave: (cb) => ipcRenderer.on('menu-save', () => cb()),
  onRequestSaveData: (cb) => ipcRenderer.on('request-save-data', () => cb()),
  onRequestCSVData: (cb) => ipcRenderer.on('request-csv-data', () => cb()),
  onCSVImported: (cb) => ipcRenderer.on('csv-imported', (e, data) => cb(data)),

  getVersion: () => ipcRenderer.invoke('get-app-version')
});
