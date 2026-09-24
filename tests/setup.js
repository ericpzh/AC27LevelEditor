import '@testing-library/jest-dom';
import { configure } from '@testing-library/dom';
import { vi } from 'vitest';

// ── Cross-platform parity switch ─────────────────────────────────────
// CI/dev on macOS or Linux can run the whole suite as if it were another OS
// (`AC27_TEST_PLATFORM=linux npm test`) to catch Windows-only assumptions.
// Unset by default, so a normal run uses the host platform. Tests that mock
// process.platform themselves (updater, bepinex) still override this.
//
// NOTE: this only changes `process.platform`; Node's `path` implementation is
// fixed at startup by the real OS, so path-separator assertions should
// normalize (e.g. via gamePaths.norm) rather than hardcode '/' or '\'.
if (process.env.AC27_TEST_PLATFORM) {
  Object.defineProperty(process, 'platform', {
    value: process.env.AC27_TEST_PLATFORM,
    writable: true,
    configurable: true,
  });
}

// The suite runs many heavy jsdom files in parallel; Testing Library's default
// 1000 ms async timeout is too tight under that load and produced intermittent
// `waitFor`/`findBy*` flakes (the jsdom rAF/effect work can exceed 1 s). Raise
// the default globally rather than chasing individual tests.
configure({ asyncUtilTimeout: 5000 });

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
  detectGameRoot: () => mockIpcInvoke('detect-game-root'),
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

  // Live weather import (aviationweather.gov METAR history + TAF fallback)
  fetchLiveMetar: (icao) => mockIpcInvoke('fetch-live-metar', icao),

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
  isWorkshopBuild: () => mockIpcInvoke('is-workshop-build'),

  // System info (radar/strip buttons are Windows-only in the UI)
  getSystemInfo: () => mockIpcInvoke('get-system-info'),

  // Cache
  getCachedLang: () => mockIpcInvoke('get-cached-lang'),
  saveCachedLang: (lang) => mockIpcInvoke('save-cached-lang', lang),
  getCacheFlag: (key) => mockIpcInvoke('get-cache-flag', key),
  setCacheFlag: (key, value) => mockIpcInvoke('set-cache-flag', key, value),

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

	  // ─── Video Background Replacer ────────────────────────────
	  selectVideoFile: () => mockIpcInvoke('select-video-file'),
	  discoverMenuVideos: () => mockIpcInvoke('discover-menu-videos'),
	  convertVideo: (opts) => mockIpcInvoke('convert-video', opts),
	  replaceMenuVideos: (opts) => mockIpcInvoke('replace-menu-videos', opts),
	  checkVideoBackupExists: () => mockIpcInvoke('check-video-backup-exists'),
	  restoreVideoBackup: () => mockIpcInvoke('restore-video-backup'),
	  onVideoConvertProgress: (cb) => mockIpcOn('video-convert-progress', cb),
	  offVideoConvertProgress: (cb) => { /* unsubscribe */ },
	  onVideoReplaceProgress: (cb) => mockIpcOn('video-replace-progress', cb),
	  offVideoReplaceProgress: (cb) => { /* unsubscribe */ },

  // ─── BepInEx Debug Mode ──────────────────────────────────
  checkBepInEx: () => mockIpcInvoke('check-bepinex'),
  installBepInEx: () => mockIpcInvoke('install-bepinex'),
  uninstallBepInEx: () => mockIpcInvoke('uninstall-bepinex'),
  onBepInExInstallProgress: (cb) => mockIpcOn('bepinex-install-progress', cb),
  offBepInExInstallProgress: (cb) => { /* unsubscribe */ },

  // Command window / PTT gate + Load DLL (AC27Approach plugin under plugins/)
  checkCommandCapability: () => mockIpcInvoke('check-command-capability'),
  loadApproachDll: () => mockIpcInvoke('load-approach-dll'),
  downloadApproachDll: () => mockIpcInvoke('download-approach-dll'),
  installApproachDll: (dllPath) => mockIpcInvoke('install-approach-dll', dllPath),
  // Global PTT hotkey (OS-level toggle, works unfocused)
  getPttShortcut: () => mockIpcInvoke('get-ptt-shortcut'),
  setPttShortcut: (accelerator) => mockIpcInvoke('set-ptt-shortcut', accelerator),
  onGlobalPttToggle: (cb) => mockIpcOn('global-ptt-toggle', cb),
  onApproachDllDownloadProgress: (cb) => mockIpcOn('approach-dll-download-progress', cb),
  offApproachDllDownloadProgress: (cb) => { /* unsubscribe */ },

  // ─── Livery Install ───────────────────────────────────
  selectLiveryZip: () => mockIpcInvoke('select-livery-zip'),
  installLivery: (zipPath) => mockIpcInvoke('install-livery', zipPath),
  downloadLivery: () => mockIpcInvoke('download-livery'),
  onLiveryDownloadProgress: (cb) => mockIpcOn('livery-download-progress', cb),
  offLiveryDownloadProgress: (cb) => { /* unsubscribe */ },

  // ─── Custom Liveries (own pack) ─────────────────────────
  listLiveries: () => mockIpcInvoke('list-liveries'),
  readLiveryImage: (folder, pack) => mockIpcInvoke('read-livery-image', folder, pack),
  readLiveryImages: (folder, pack) => mockIpcInvoke('read-livery-images', folder, pack),
  readLiveryThumbnail: (folder, pack) => mockIpcInvoke('read-livery-thumbnail', folder, pack),
  getAircraftTemplate: (planeId) => mockIpcInvoke('get-aircraft-template', planeId),
  listAircraftTypes: () => mockIpcInvoke('list-aircraft-types'),
  createLivery: (payload) => mockIpcInvoke('create-livery', payload),
  deleteLivery: (folder) => mockIpcInvoke('delete-livery', folder),
  selectLiveryImage: () => mockIpcInvoke('select-livery-image'),
  readDiskImage: (filePath) => mockIpcInvoke('read-disk-image', filePath),
  revealLiveryFolder: (folder, pack) => mockIpcInvoke('reveal-livery-folder', folder, pack),
  exportLivery: (folder) => mockIpcInvoke('export-livery', folder),
  exportLiveryToDir: (folder) => mockIpcInvoke('export-livery-to-dir', folder),
  saveLiveryDialog: (opts) => mockIpcInvoke('save-livery-dialog', opts),
  loadLiveryZip: () => mockIpcInvoke('load-livery-zip'),

  // ─── Workshop publish (standalone uploader) ──────────
  getWorkshopPublishInfo: (folder) => mockIpcInvoke('get-workshop-publish-info', folder),
  selectLiveryPreview: () => mockIpcInvoke('select-livery-preview'),
  publishLivery: (payload) => mockIpcInvoke('publish-livery', payload),
  openWorkshopLog: () => mockIpcInvoke('open-workshop-log'),
  getWorkshopDebugInfo: () => mockIpcInvoke('workshop-debug-info'),
  onWorkshopUploadProgress: (cb) => mockIpcOn('workshop-upload-progress', cb),
  offWorkshopUploadProgress: (cb) => { /* unsubscribe */ },

  // ─── UDP telemetry ───────────────────────────────────────
  getUdpStatus: () => mockIpcInvoke('get-udp-status'),
  getUdpAircraftState: () => mockIpcInvoke('get-udp-aircraft-state'),
  resetUdpAircraft: () => mockIpcInvoke('reset-udp-aircraft'),
  sendUdpCommand: (commandId, callSign) => mockIpcInvoke('send-udp-command', commandId, callSign),
  sendPatchCommand: (patch) => mockIpcInvoke('send-patch-command', patch),
  debugLog: (...args) => mockIpcInvoke('debug-log', args),
  onUdpAircraftState: (cb) => mockIpcOn('udp-aircraft-state', cb),
  offUdpAircraftState: (cb) => { /* unsubscribe */ },
});
if (typeof window !== 'undefined') window.electronAPI = globalThis.electronAPI;
// Ensure electronAPI is available on window for createContext default value


// ── Mock dialog / matchMedia etc. ───────────────────────────────────
// (jsdom only — skip in node environment)

if (typeof window !== 'undefined') {
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
}

if (typeof Element !== 'undefined') {
  // Mock scrollIntoView (jsdom does not implement it)
  Element.prototype.scrollIntoView = vi.fn();
}

// Mock ResizeObserver (jsdom does not implement it)
if (typeof global !== 'undefined') {
  global.ResizeObserver = vi.fn(function ResizeObserver(cb) {
    this.observe = vi.fn();
    this.unobserve = vi.fn();
    this.disconnect = vi.fn();
  });
}

// Export for use in test files
export { mockIpcInvoke, mockIpcOn, mockIpcListeners };
