import '@testing-library/jest-dom';
import { vi } from 'vitest';

// ── Mock window.electronAPI ──────────────────────────────────────────
// All renderer code accesses Electron via window.electronAPI (exposed by
// contextBridge in electron/preload.js). In jsdom there is no Electron,
// so we stub the entire bridge. Tests can import { mockIpcInvoke }
// and control return values per channel.

const mockIpcInvoke = vi.fn();
const mockIpcListeners = {};

const mockIpcOn = vi.fn((channel, cb) => {
  if (!mockIpcListeners[channel]) mockIpcListeners[channel] = [];
  mockIpcListeners[channel].push(cb);
});

vi.stubGlobal('electronAPI', {
  // Setup screen
  selectGameRoot: () => mockIpcInvoke('select-game-root'),
  getCacheState: () => mockIpcInvoke('get-cache-state'),
  initAirportCache: (rootPath) => mockIpcInvoke('init-airport-cache', rootPath),

  // Browser screen
  scanAcls: (rootPath) => mockIpcInvoke('scan-acls', rootPath),
  getFileInfo: (filePath) => mockIpcInvoke('get-file-info', filePath),
  getAirportFilesInfo: (icao, rootPath) => mockIpcInvoke('get-airport-files-info', icao, rootPath),
  collectValues: (rootPath, icao) => mockIpcInvoke('collect-values', rootPath, icao),
  loadAudioCallsigns: (rootPath, icao) => mockIpcInvoke('load-audio-callsigns', rootPath, icao),
  refreshRootScan: (rootPath) => mockIpcInvoke('refresh-root-scan', rootPath),

  // Editor
  loadAcl: (filePath) => mockIpcInvoke('load-acl', filePath),
  saveAcl: (data) => mockIpcInvoke('save-acl', data),
  exportZip: (data) => mockIpcInvoke('export-zip', data),
  reloadAcl: (filePath) => mockIpcInvoke('reload-acl', filePath),

  // Timeline editors
  loadTimelines: (aclPath) => mockIpcInvoke('load-timelines', aclPath),
  saveWeatherTimeline: (data) => mockIpcInvoke('save-weather-timeline', data),
  saveWindTimeline: (data) => mockIpcInvoke('save-wind-timeline', data),
  saveRunwayTimeline: (data) => mockIpcInvoke('save-runway-timeline', data),
  scanRunwayPairs: (rootPath, airportIcao) => mockIpcInvoke('scan-runway-pairs', rootPath, airportIcao),

  // Backup & Import
  manualBackup: (sourcePath) => mockIpcInvoke('manual-backup', sourcePath),
  importZip: (data) => mockIpcInvoke('import-zip', data),
  checkBackupExists: (filePath) => mockIpcInvoke('check-backup-exists', filePath),
  restoreBackup: (filePath) => mockIpcInvoke('restore-latest-backup', filePath),

  // Debug
  rendererLog: (...args) => mockIpcInvoke('renderer-log', ...args),

  // External
  openExternal: (url) => mockIpcInvoke('open-external', url),

  // App version
  getAppVersion: () => mockIpcInvoke('get-app-version'),

  // Cache
  getCachedLang: () => mockIpcInvoke('get-cached-lang'),
  saveCachedLang: (lang) => mockIpcInvoke('save-cached-lang', lang),

  // Navigation
  onNavBrowser: (cb) => mockIpcOn('nav-browser', cb),

  // ─── Map windows ─────────────────────────────────────────
  openGroundMap: (airportIcao, gameRoot) => mockIpcInvoke('open-ground-map', airportIcao, gameRoot),
  openAirMap: (airportIcao, gameRoot) => mockIpcInvoke('open-air-map', airportIcao, gameRoot),
  closeGroundMap: (airportIcao) => mockIpcInvoke('close-ground-map', airportIcao),
  closeAirMap: (airportIcao) => mockIpcInvoke('close-air-map', airportIcao),
  onRadarWindowClosed: (cb) => mockIpcOn('radar-window-closed', cb),

  // Linked aircraft selection (synced across ground + air map)
  selectAircraftInMap: (airportIcao, callSign) => mockIpcInvoke('select-aircraft-in-map', airportIcao, callSign),
  getSelectedAircraft: (airportIcao) => mockIpcInvoke('get-selected-aircraft', airportIcao),
  onAircraftSelectedInMap: (cb) => mockIpcOn('aircraft-selected-in-map', cb),
  offAircraftSelectedInMap: (cb) => { /* unsubscribe */ },

  // ─── UDP telemetry ───────────────────────────────────────
  getUdpStatus: () => mockIpcInvoke('get-udp-status'),
  getUdpAircraftState: () => mockIpcInvoke('get-udp-aircraft-state'),
  resetUdpAircraft: () => mockIpcInvoke('reset-udp-aircraft'),
  sendUdpCommand: (commandId, callSign) => mockIpcInvoke('send-udp-command', commandId, callSign),
  debugLog: (...args) => mockIpcInvoke('debug-log', args),
  onUdpAircraftState: (cb) => mockIpcOn('udp-aircraft-state', cb),
  offUdpAircraftState: (cb) => { /* unsubscribe */ },
});

// ── Mock dialog / matchMedia etc. ───────────────────────────────────

// jsdom does not implement window.matchMedia; stub it so theme/language
// toggles don't crash components that check prefers-color-scheme.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock scrollIntoView (jsdom does not implement it)
Element.prototype.scrollIntoView = vi.fn();

// Export for use in test files
export { mockIpcInvoke, mockIpcOn, mockIpcListeners };
