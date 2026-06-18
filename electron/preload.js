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

  // Cache build progress — main process sends file-level progress during scan
  _cacheProgressHandlers: new Map(),
  onCacheBuildProgress: function (cb) {
    const handler = (_e, data) => cb(data);
    this._cacheProgressHandlers.set(cb, handler);
    ipcRenderer.on('cache-build-progress', handler);
  },
  offCacheBuildProgress: function (cb) {
    const handler = this._cacheProgressHandlers.get(cb);
    if (handler) {
      ipcRenderer.removeListener('cache-build-progress', handler);
      this._cacheProgressHandlers.delete(cb);
    }
  },

  // Cache invalidation — main process signals when cache.json is missing/corrupt
  onCacheInvalidated: (cb) => ipcRenderer.on('cache-invalidated', () => cb()),

  // ─── Map windows ─────────────────────────────────────────
  openGroundMap: (airportIcao, gameRoot) => ipcRenderer.invoke('open-ground-map', airportIcao, gameRoot),
  openAirMap: (airportIcao, gameRoot) => ipcRenderer.invoke('open-air-map', airportIcao, gameRoot),
  closeGroundMap: (airportIcao) => ipcRenderer.invoke('close-ground-map', airportIcao),
  closeAirMap: (airportIcao) => ipcRenderer.invoke('close-air-map', airportIcao),
  openFlightStrips: (airportIcao, gameRoot) => ipcRenderer.invoke('open-flight-strips', airportIcao, gameRoot),
  closeFlightStrips: (airportIcao) => ipcRenderer.invoke('close-flight-strips', airportIcao),
  getFlightStripData: (airportIcao, gameRoot) => ipcRenderer.invoke('get-flight-strip-data', airportIcao, gameRoot),
  onRadarWindowClosed: (cb) => ipcRenderer.on('radar-window-closed', (_e, data) => cb(data)),

  // Linked aircraft selection (synced across ground + air map for same airport)
  selectAircraftInMap: (airportIcao, callSign) => ipcRenderer.invoke('select-aircraft-in-map', airportIcao, callSign || null),
  getSelectedAircraft: (airportIcao) => ipcRenderer.invoke('get-selected-aircraft', airportIcao),
  _selectedAircraftHandlers: new Map(),
  onAircraftSelectedInMap: function (cb) {
    const handler = (_e, data) => cb(data);
    this._selectedAircraftHandlers.set(cb, handler);
    ipcRenderer.on('aircraft-selected-in-map', handler);
  },
  offAircraftSelectedInMap: function (cb) {
    const handler = this._selectedAircraftHandlers.get(cb);
    if (handler) {
      ipcRenderer.removeListener('aircraft-selected-in-map', handler);
      this._selectedAircraftHandlers.delete(cb);
    }
  },

  // ─── UDP telemetry ───────────────────────────────────────
  getUdpStatus: () => ipcRenderer.invoke('get-udp-status'),
  getUdpAircraftState: () => ipcRenderer.invoke('get-udp-aircraft-state'),
  resetUdpAircraft: () => ipcRenderer.invoke('reset-udp-aircraft'),

  // Send UDP command to game (e.g. SelectAircraft)
  sendUdpCommand: (commandId, callSign) => {
    const buf = Buffer.alloc(12);
    buf.write(callSign, 0, 12, 'ascii');
    return ipcRenderer.invoke('send-udp-command', commandId, buf.toString('base64'));
  },

  // Debug: log to main process terminal
  debugLog: (...args) => ipcRenderer.invoke('debug-log', args),

  // Subscribe to live UDP aircraft state pushes from main process
  _udpStateHandlers: new Map(),
  onUdpAircraftState: function (cb) {
    const handler = (_e, state) => cb(state);
    this._udpStateHandlers.set(cb, handler);
    ipcRenderer.on('udp-aircraft-state', handler);
  },
  offUdpAircraftState: function (cb) {
    const handler = this._udpStateHandlers.get(cb);
    if (handler) {
      ipcRenderer.removeListener('udp-aircraft-state', handler);
      this._udpStateHandlers.delete(cb);
    }
  },
});
