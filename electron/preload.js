const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Setup screen
  selectGameRoot: () => ipcRenderer.invoke('select-game-root'),
  getCacheState: () => ipcRenderer.invoke('get-cache-state'),
  initAirportCache: (rootPath) => ipcRenderer.invoke('init-airport-cache', rootPath),

  // Browser screen
  scanAcls: (rootPath) => ipcRenderer.invoke('scan-acls', rootPath),
  getFileInfo: (filePath) => ipcRenderer.invoke('get-file-info', filePath),
  getAirportFilesInfo: (icao, rootPath) => ipcRenderer.invoke('get-airport-files-info', icao, rootPath),
  collectValues: (rootPath, icao) => ipcRenderer.invoke('collect-values', rootPath, icao),
  loadAudioCallsigns: (rootPath, icao) => ipcRenderer.invoke('load-audio-callsigns', rootPath, icao),
  refreshRootScan: (rootPath) => ipcRenderer.invoke('refresh-root-scan', rootPath),
  // Editor
  loadAcl: (filePath) => ipcRenderer.invoke('load-acl', filePath),
  saveAcl: (data) => ipcRenderer.invoke('save-acl', data),
  exportZip: (data) => ipcRenderer.invoke('export-zip', data),
  reloadAcl: (filePath) => ipcRenderer.invoke('reload-acl', filePath),

  // Timeline editors
  loadTimelines: (aclPath) => ipcRenderer.invoke('load-timelines', aclPath),
  saveWeatherTimeline: (data) => ipcRenderer.invoke('save-weather-timeline', data),
  saveWindTimeline: (data) => ipcRenderer.invoke('save-wind-timeline', data),
  saveRunwayTimeline: (data) => ipcRenderer.invoke('save-runway-timeline', data),
  scanRunwayPairs: (rootPath, airportIcao) => ipcRenderer.invoke('scan-runway-pairs', rootPath, airportIcao),

  // Backup & Import
  manualBackup: (sourcePath) => ipcRenderer.invoke('manual-backup', sourcePath),
  importZip: (data) => ipcRenderer.invoke('import-zip', data),
  checkBackupExists: (filePath) => ipcRenderer.invoke('check-backup-exists', filePath),
  restoreBackup: (filePath) => ipcRenderer.invoke('restore-latest-backup', filePath),

  // Debug logging from renderer -> main process log file
  rendererLog: (...args) => ipcRenderer.invoke('renderer-log', ...args),

  // Open external URL in default browser
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // App version
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // Cache
  getCachedLang: () => ipcRenderer.invoke('get-cached-lang'),
  saveCachedLang: (lang) => ipcRenderer.invoke('save-cached-lang', lang),

  // Navigation events from menu
  onNavBrowser: (cb) => ipcRenderer.on('nav-browser', () => cb()),

  // Aircraft positions on STAR map
  getAircraftPositions: (icao, arrivals, saveSec) => ipcRenderer.invoke('get-aircraft-positions', icao, arrivals, saveSec),

  // Cache invalidation — main process signals when cache.json is missing/corrupt
  onCacheInvalidated: (cb) => ipcRenderer.on('cache-invalidated', () => cb()),
});
