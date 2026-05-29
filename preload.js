const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Setup screen
  selectGameRoot: () => ipcRenderer.invoke('select-game-root'),
  getLastRoot: () => ipcRenderer.invoke('get-last-root'),
  saveLastRoot: (rootPath) => ipcRenderer.invoke('save-last-root', rootPath),

  // Browser screen
  scanAcls: (rootPath) => ipcRenderer.invoke('scan-acls', rootPath),
  getFileInfo: (filePath) => ipcRenderer.invoke('get-file-info', filePath),
  getAirportFilesInfo: (icao, rootPath) => ipcRenderer.invoke('get-airport-files-info', icao, rootPath),
  collectValues: (rootPath, icao) => ipcRenderer.invoke('collect-values', rootPath, icao),

  // Editor
  loadAcl: (filePath) => ipcRenderer.invoke('load-acl', filePath),
  saveAcl: (data) => ipcRenderer.invoke('save-acl', data),
  saveAsAcl: (data) => ipcRenderer.invoke('save-as-acl', data),
  reloadAcl: (filePath) => ipcRenderer.invoke('reload-acl', filePath),

  // Backup & Import
  manualBackup: (sourcePath) => ipcRenderer.invoke('manual-backup', sourcePath),
  importAcl: () => ipcRenderer.invoke('import-acl'),

  // CSV
  exportCSV: (data) => ipcRenderer.invoke('export-csv', data),

  // Navigation events from menu
  onNavBrowser: (cb) => ipcRenderer.on('nav-browser', () => cb()),
});
