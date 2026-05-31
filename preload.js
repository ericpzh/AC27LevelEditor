const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Setup screen
  selectGameRoot: () => ipcRenderer.invoke('select-game-root'),
  getLastRoot: () => ipcRenderer.invoke('get-last-root'),
  saveLastRoot: (rootPath) => ipcRenderer.invoke('save-last-root', rootPath),
  initAirportCache: (rootPath) => ipcRenderer.invoke('init-airport-cache', rootPath),

  // Browser screen
  scanAcls: (rootPath) => ipcRenderer.invoke('scan-acls', rootPath),
  getFileInfo: (filePath) => ipcRenderer.invoke('get-file-info', filePath),
  getAirportFilesInfo: (icao, rootPath) => ipcRenderer.invoke('get-airport-files-info', icao, rootPath),
  collectValues: (rootPath, icao) => ipcRenderer.invoke('collect-values', rootPath, icao),
  loadAudioCallsigns: (rootPath, icao) => ipcRenderer.invoke('load-audio-callsigns', rootPath, icao),
  captureDynamicsTemplates: (rootPath) => ipcRenderer.invoke('capture-dynamics-templates', rootPath),

  // Editor
  loadAcl: (filePath) => ipcRenderer.invoke('load-acl', filePath),
  saveAcl: (data) => ipcRenderer.invoke('save-acl', data),
  saveAsAcl: (data) => ipcRenderer.invoke('save-as-acl', data),
  reloadAcl: (filePath) => ipcRenderer.invoke('reload-acl', filePath),

  // Timeline editors
  loadTimelines: (aclPath) => ipcRenderer.invoke('load-timelines', aclPath),
  saveWeatherTimeline: (data) => ipcRenderer.invoke('save-weather-timeline', data),
  saveWindTimeline: (data) => ipcRenderer.invoke('save-wind-timeline', data),
  saveRunwayTimeline: (data) => ipcRenderer.invoke('save-runway-timeline', data),

  // Backup & Import
  manualBackup: (sourcePath) => ipcRenderer.invoke('manual-backup', sourcePath),
  importAcl: () => ipcRenderer.invoke('import-acl'),
  restoreBackup: (filePath) => ipcRenderer.invoke('restore-latest-backup', filePath),

  // Debug logging from renderer -> main process log file
  rendererLog: (...args) => ipcRenderer.invoke('renderer-log', ...args),

  // Navigation events from menu
  onNavBrowser: (cb) => ipcRenderer.on('nav-browser', () => cb()),
});
