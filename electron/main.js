const { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { initLogger, closeLogger } = require('../src/utils/logger');

// ── MUST be first: redirect ALL console.* to file (dev only) ──
// Skip file logging in E2E tests so we can see console output
if (!app.isPackaged && !process.env.AC27_E2E_TMP_DIR) initLogger();

const { loadFlights, generateFullAcl, collectUniqueValues, collectRunwayPairs, mergeAudioCallsigns, getFileInfo, exportCSV, exportGameCSV, loadAudioCallsigns, sortFlightsChronologically, _rebuildTimelineSections, scanGameRoot, buildApproachCache, serializeApproachCache, deserializeApproachCache, extractSaveTime, extractGameTime, extractCurrentDateTime, createZip, listZipFiles, extractZip, _parseWeatherFrames, _parseWindFrames, _parseRunwayTimeline, _extractConfig, _parseStandPositions, _parseAreas, computePosition, computeDirection, computeApproachCap, parseTaxiwayPaths, extractSidRunwayMappings, extractMissedApproachMappings, buildSidPaths, buildMissedApproachPaths } = require('../src/acl/parser');
const { APPROACH_MIN_TTL, WARMUP_SEC, DEMO_WINDOW_SEC, DEMO_VISIBLE_BASES, MIDNIGHT_CROSS_START_HOUR, MIDNIGHT_CROSS_THRESHOLD_MIN, MINUTES_PER_DAY, DEFAULT_TAT, CACHE_VERSION } = require('../src/acl/constants');
const { start: startUdpListener, stop: stopUdpListener, getUdpStatus, getUdpAircraftState, resetAircraftState, sendCommand: sendUdpCommand } = require('./udp_listener');

let mainWindow;
const groundMapWindows = new Map(); // key: airportIcao → BrowserWindow
const airMapWindows = new Map();    // key: airportIcao → BrowserWindow
const flightStripsWindows = new Map(); // key: airportIcao → BrowserWindow
const selectedCallSigns = new Map(); // key: airportIcao → callSign | null (synced across ground+air map)
const emergencyCallSigns = new Map(); // key: airportIcao → callSign | null (EM state synced across all map windows)
const witchSpriteMap = new Map();   // callSign → spriteIndex (0–14), centralized round-robin
let witchSpriteNext = 0;
const WITCH_SHEET_COUNT = 15;
let cachedScan = null; // cached scan result { airports, totalFiles }
let airportCache = null; // Phase 0 cache: { [ICAO]: { csvValues, audioCallsigns } }

/** Parse Area polygons from the first .acl file in a list. Returns {} on any error. */
function _parseAreaFromAcl(aclPaths, logPrefix) {
  try {
    if (aclPaths.length > 0) {
      const firstAclText = fs.readFileSync(aclPaths[0], 'utf-8');
      const areaData = _parseAreas(firstAclText);
      if (logPrefix) {
        console.log(logPrefix + ': area polygons parsed from ' + path.basename(aclPaths[0]) +
          ' (' + (areaData[0]?.length || 0) + ' Type0, ' + (areaData[1]?.length || 0) + ' Type1, ' +
          (areaData[2]?.length || 0) + ' Type2)');
      }
      return areaData;
    }
  } catch (e) {
    if (logPrefix) console.log(logPrefix + ': area parsing failed:', e.message);
  }
  return {};
}

async function createWindow() {
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 1024,
    minHeight: 640,
    title: 'AC27 Level Editor',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Capture renderer console to log file
  mainWindow.webContents.on('console-message', (event, level, message) => {
    console.log('[RENDERER] ' + message);
  });
  // In dev (npm run dev): Vite dev server at localhost:5173
  // In production: dist/index.html
  const isDev = !app.isPackaged;
  if (isDev) {
    const { createServer } = require('http');
    // Quick check if Vite dev server is running
    const devServerAlive = await new Promise((resolve) => {
      const req = require('http').get('http://localhost:5173', () => resolve(true));
      req.on('error', () => resolve(false));
      req.setTimeout(500, () => { req.destroy(); resolve(false); });
    });
    if (devServerAlive) {
      mainWindow.loadURL('http://localhost:5173');
    } else {
      const distPath = path.join(__dirname, '..', 'dist', 'index.html');
      if (fs.existsSync(distPath)) {
        mainWindow.loadFile(distPath);
      } else {
        mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));
      }
    }
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

// ─── Map window management ─────────────────────────────────────

// ─── Radar window helpers ──────────────────────────────────────

function notifyRadarClosed(icao, type) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('radar-window-closed', { icao, type });
  }
}

/** Broadcast selected aircraft change to ALL map windows for a given airport. */
function broadcastSelectedAircraft(icao, callSign) {
  const data = { icao, callSign: callSign || null };
  const gw = groundMapWindows.get(icao);
  if (gw && !gw.isDestroyed()) gw.webContents.send('aircraft-selected-in-map', data);
  const aw = airMapWindows.get(icao);
  if (aw && !aw.isDestroyed()) aw.webContents.send('aircraft-selected-in-map', data);
  const fw = flightStripsWindows.get(icao);
  if (fw && !fw.isDestroyed()) fw.webContents.send('aircraft-selected-in-map', data);
}

/** Broadcast emergency aircraft change to ALL map windows for a given airport. */
function broadcastEmergencyAircraft(icao, callSign) {
  const data = { icao, callSign: callSign || null };
  const gw = groundMapWindows.get(icao);
  if (gw && !gw.isDestroyed()) gw.webContents.send('emergency-aircraft-changed', data);
  const aw = airMapWindows.get(icao);
  if (aw && !aw.isDestroyed()) aw.webContents.send('emergency-aircraft-changed', data);
  const fw = flightStripsWindows.get(icao);
  if (fw && !fw.isDestroyed()) fw.webContents.send('emergency-aircraft-changed', data);
}

function openGroundMapWindow(airportIcao, gameRoot) {
  const key = airportIcao;
  const existing = groundMapWindows.get(key);
  if (existing && !existing.isDestroyed()) { existing.focus(); return; }
  const isDev = !app.isPackaged;
  const win = new BrowserWindow({
    width: 900, height: 800, minWidth: 500, minHeight: 500,
    title: airportIcao + ' Surface Radar',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  const rootParam = encodeURIComponent(gameRoot || '');
  if (isDev) {
    win.loadURL('http://localhost:5173/?window=groundMap&airport=' + airportIcao + '&root=' + rootParam);
  } else {
    win.loadURL('file://' + path.join(__dirname, '..', 'dist', 'index.html') + '?window=groundMap&airport=' + airportIcao + '&root=' + rootParam);
  }
  win.on('closed', () => { groundMapWindows.delete(key); notifyRadarClosed(airportIcao, 'ground'); });
  groundMapWindows.set(key, win);
}

function openAirMapWindow(airportIcao, gameRoot) {
  const key = airportIcao;
  const existing = airMapWindows.get(key);
  if (existing && !existing.isDestroyed()) { existing.focus(); return; }
  const isDev = !app.isPackaged;
  const win = new BrowserWindow({
    width: 900, height: 800, minWidth: 500, minHeight: 500,
    title: airportIcao + ' Approach Radar',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  const rootParam = encodeURIComponent(gameRoot || '');
  if (isDev) {
    win.loadURL('http://localhost:5173/?window=airMap&airport=' + airportIcao + '&root=' + rootParam);
  } else {
    win.loadURL('file://' + path.join(__dirname, '..', 'dist', 'index.html') + '?window=airMap&airport=' + airportIcao + '&root=' + rootParam);
  }
  win.on('closed', () => { airMapWindows.delete(key); notifyRadarClosed(airportIcao, 'air'); });
  airMapWindows.set(key, win);
}

function closeGroundMapWindow(airportIcao) {
  const key = airportIcao;
  const win = groundMapWindows.get(key);
  if (win && !win.isDestroyed()) { win.close(); }
  groundMapWindows.delete(key);
}

function closeAirMapWindow(airportIcao) {
  const key = airportIcao;
  const win = airMapWindows.get(key);
  if (win && !win.isDestroyed()) { win.close(); }
  airMapWindows.delete(key);
}

function openFlightStripsWindow(airportIcao, gameRoot) {
  const key = airportIcao;
  const existing = flightStripsWindows.get(key);
  if (existing && !existing.isDestroyed()) { existing.focus(); return; }
  const isDev = !app.isPackaged;
  const win = new BrowserWindow({
    width: 1400, height: 600, minWidth: 800, minHeight: 400,
    title: airportIcao + ' Flight Strips',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  const rootParam = encodeURIComponent(gameRoot || '');
  if (isDev) {
    win.loadURL('http://localhost:5173/?window=flightStrips&airport=' + airportIcao + '&root=' + rootParam);
  } else {
    win.loadURL('file://' + path.join(__dirname, '..', 'dist', 'index.html') + '?window=flightStrips&airport=' + airportIcao + '&root=' + rootParam);
  }
  win.on('closed', () => { flightStripsWindows.delete(key); notifyRadarClosed(airportIcao, 'flightStrips'); });
  flightStripsWindows.set(key, win);
}

function closeFlightStripsWindow(airportIcao) {
  const key = airportIcao;
  const win = flightStripsWindows.get(key);
  if (win && !win.isDestroyed()) { win.close(); }
  flightStripsWindows.delete(key);
}

// ─── IPC: Select game root ───────────────────────────────

ipcMain.handle('select-game-root', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Airport Control 27 Playtest Game Root',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };

  const root = result.filePaths[0];
  const scan = scanGameRoot(root);
  if (scan.errorCode) {
    return { canceled: false, rootPath: root, errorCode: scan.errorCode, errorPath: scan.errorPath };
  }
  cachedScan = scan;
  return { canceled: false, rootPath: root, airports: scan.airports, totalFiles: scan.totalFiles };
});

// ─── IPC: Scan ACLs in a given root ──────────────────────

ipcMain.handle('scan-acls', async (_event, rootPath) => {
  console.log('[IPC] scan-acls rootPath:', rootPath);
  const scan = scanGameRoot(rootPath);
  if (scan.errorCode) {
    console.error('[IPC] scan-acls FAIL:', scan.errorCode, scan.errorPath || '');
    return { errorCode: scan.errorCode, errorPath: scan.errorPath };
  }
  cachedScan = scan;
  console.log('[IPC] scan-acls OK: airports=' + scan.airports.length + ' totalFiles=' + scan.totalFiles);
  for (const a of scan.airports) {
    console.log('[IPC]   airport', a.icao, 'files:', a.aclFiles.length, a.aclFiles.map(f => f.filename));
  }
  return { airports: scan.airports, totalFiles: scan.totalFiles };
});

// ─── IPC: Get file info (lightweight) ────────────────────

ipcMain.handle('get-file-info', async (_event, filePath) => {
  return getFileInfo(filePath);
});

// ─── IPC: Get file infos for an airport ──────────────────

ipcMain.handle('get-airport-files-info', async (_event, airportIcao, rootPath) => {
  console.log('[IPC] get-airport-files-info v3 (demo-aware):', airportIcao);
  const scan = scanGameRoot(rootPath);
  if (scan.errorCode) { console.error('[IPC] get-airport-files-info scan error:', scan.errorCode, scan.errorPath || ''); return []; }
  const airport = scan.airports.find(a => a.icao === airportIcao);
  if (!airport) { console.error('[IPC] get-airport-files-info: airport not found:', airportIcao); return []; }
  console.log('[IPC] get-airport-files-info:', airportIcao, 'files count:', airport.aclFiles.length);
  const results = airport.aclFiles.map((f, i) => {
    const info = getFileInfo(f.path);
    const isDemo = _isDemoFile(f.filename);
    const isEmer = _isEmerFile(f.filename);
    info.isDemo = isDemo;
    // For .demo.acl files (including _emerg): extract CurrentDateTime for 30-min window display
    if (isDemo) {
      try {
        const text = fs.readFileSync(f.path, 'utf-8');
        const cdt = extractCurrentDateTime(text);
        console.log('[IPC] get-airport-files-info: demo file', f.filename, '— extractCurrentDateTime returned', cdt ? ('timeString=' + cdt.timeString) : 'NULL');
        if (cdt) {
          info.currentDateTime = cdt.timeString;
          // Compute 30-min window end: CurrentDateTime + 30 min
          const ssm = cdt.secSinceMidnight;
          const endSec = ssm + DEMO_WINDOW_SEC;
          const eh = Math.floor((endSec % 86400) / 3600) % 24;
          const em = Math.floor((endSec % 3600) / 60);
          const es = endSec % 60;
          info.demoEndTime = String(eh).padStart(2, '0') + ':' + String(em).padStart(2, '0') + ':' + String(es).padStart(2, '0');
          // Override startTime/endTime to show the 30-min demo window
          info.startTime = cdt.timeString;
          info.endTime = info.demoEndTime;
          console.log('[IPC] get-airport-files-info: demo file', f.filename, '— window [' + cdt.timeString + ' ~ ' + info.demoEndTime + ']');
        } else {
          console.log('[IPC] get-airport-files-info: demo file', f.filename, '— FALLBACK to config range [' + (info.startTime || 'none') + ' ~ ' + (info.endTime || 'none') + ']');
        }
      } catch (e) { console.log('[IPC] get-airport-files-info: demo file', f.filename, '— ERROR:', e.message); /* keep config startTime/endTime as fallback */ }
    } else {
      // getFileInfo now extracts startTime/endTime from ACL's Config block (single source of truth)
      if (info.startTime) {
        // Config startTime has 10-min warmup — add 10 min to match in-game display
        const p = String(info.startTime).split(':');
        const m = parseInt(p[0]) * 60 + parseInt(p[1]) + 10;
        const h = Math.floor(m / 60) % 24;
        info.startTime = String(h).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0') + ':00';
      } else {
        info.startTime = info.earliestTime || null;
      }
      info.endTime = info.endTime || null;
    }
    console.log('[IPC]   file', i, f.filename, '->', info.error ? ('ERROR: ' + info.error) : ('OK arrivals=' + info.arrivals + ' departures=' + info.departures + ' startTime=' + (info.startTime || 'none') + ' endTime=' + (info.endTime || 'none') + (isDemo ? ' [DEMO]' : '')));
    return info;
  });
  // Return all results — renderer will filter based on toggle
  return results;
});

// ─── IPC: Collect valid values for an airport ─────────────

ipcMain.handle('collect-values', async (_event, rootPath, airportIcao) => {
  // Read from airport cache (built during init-airport-cache / refresh-root-scan)
  const cached = airportCache && airportCache[airportIcao];
  const aclValues = cached?.dropdownValues ? { ...cached.dropdownValues } : {};

  // Language: derive from audio_clips_*.json existence
  const availableLanguages = [];
  const levelsPath = path.join(rootPath, 'GroundATC_Data', 'StreamingAssets', 'Airports', airportIcao, 'Levels');
  if (fs.existsSync(path.join(levelsPath, 'audio_clips_en.json'))) availableLanguages.push('en');
  if (fs.existsSync(path.join(levelsPath, 'audio_clips_zh.json'))) availableLanguages.push('zh');
  for (const l of (aclValues.Language || [])) {
    if (!availableLanguages.includes(l)) availableLanguages.push(l);
  }
  if (availableLanguages.length > 0) {
    aclValues.Language = availableLanguages.sort();
  }

  // Filter AircraftType to only show types with known Designator mappings
  // (ensures every selectable type can generate approach AircraftState entries)
  const designatorMap = cached?.approachData?.designatorMap;
  if (designatorMap && designatorMap.size > 0 && aclValues.AircraftType) {
    const knownTypes = new Set(designatorMap.keys());
    aclValues.AircraftType = aclValues.AircraftType.filter(t => knownTypes.has(t));
  }

  // Include stand positions from airport cache
  aclValues._standPositions = cached?.standPositions || {};

  // Include STAR paths for the Airway column graph popup
  aclValues._starPaths = cached?.approachData?.starPaths || {};

  // Use authoritative STAR↔runway mappings extracted from SceneryData.Runways[].Routes[].Type=0.
  // This captures ALL valid STAR-runway combinations, not just those present in appPointMap
  // (which is limited to State=30 aircraft entries at snapshot time).
  aclValues._starRunwayMap = cached?.approachData?.starRunwayMap || {};
  aclValues._runwayStarMap = cached?.approachData?.runwayStarMap || {};

  // Build runway threshold lines for StarMap visualization.
  // Data from SceneryData.Runways (parsed by _parseRunwayThresholds),
  // keyed by PhysicalName (e.g. "13L/31R"). Each entry already has both
  // threshold points — just convert to {a, b} format for StarMap.
  const runwayThresholds = {};
  if (cached?.approachData?.runwayThresholds) {
    const rwyData = cached.approachData.runwayThresholds;
    console.log('[COLLECT-VALUES] runway pairs from scenery:', Object.keys(rwyData).join(', '));
    for (const [name, entry] of Object.entries(rwyData)) {
      if (entry.thresholds && entry.thresholds.length === 2) {
        const a = entry.thresholds[0];
        const b = entry.thresholds[1];
        // Extend runway to 3x: push each endpoint outward by one full length
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        runwayThresholds[name] = {
          a: { x: a.x - dx, z: a.z - dz },
          b: { x: b.x + dx, z: b.z + dz },
        };
      }
    }
  }
  aclValues._runwayThresholds = runwayThresholds;

  // Include taxiway paths (for GroundMap)
  aclValues._taxiwayPaths = cached?.approachData?.taxiwayPaths || { paths: [] };

  // Build runway rectangles for GroundMap (original endpoints, not 3x extended)
  aclValues._runwayData = {};
  if (cached?.approachData?.runwayThresholds) {
    const rwyThresh = cached.approachData.runwayThresholds;
    for (const [name, entry] of Object.entries(rwyThresh)) {
      if (entry.thresholds && entry.thresholds.length === 2) {
        aclValues._runwayData[name] = {
          thresholds: entry.thresholds,
          width: 0.50,  // default runway width in game units (50m at 100m/unit scale)
        };
      }
    }
  }

  // Include area polygons (for GroundMap)
  aclValues._areaData = cached?.areaData || {};

  // Include SID + Missed Approach paths (for AirMap)
  aclValues._sidPaths = cached?.approachData?.sidPaths || {};
  aclValues._missedAppPaths = cached?.approachData?.missedAppPaths || {};
  aclValues._sidRunwayMap = cached?.approachData?.sidRunwayMap || {};
  aclValues._runwaySidMap = cached?.approachData?.runwaySidMap || {};
  aclValues._missedAppMap = cached?.approachData?.missedAppMap || {};
  aclValues._runwayMissedAppMap = cached?.approachData?.runwayMissedAppMap || {};

  // Include APPR (RNAV approach) paths for AirMap category toggle
  aclValues._apprPaths = cached?.approachData?.apprPaths || {};
  aclValues._apprRunwayMap = cached?.approachData?.apprRunwayMap || {};
  aclValues._runwayApprMap = cached?.approachData?.runwayApprMap || {};

  // Build runway designator list for the air radar runway filter sidebar.
  // Only include runways that have actual path data: for each procedure with
  // resolved path geometry, look up which runways it maps to via the forward
  // maps (procedure→[runways]). Runways with no resolved paths are hidden
  // since toggling them would have no visual effect.
  const runwaysWithData = new Set();
  const collectFromPaths = (pathsObj, forwardMap) => {
    if (!pathsObj || !forwardMap) return;
    for (const procName of Object.keys(pathsObj)) {
      const rwys = forwardMap[procName];
      if (rwys) rwys.forEach(r => { if (r) runwaysWithData.add(r); });
    }
  };
  collectFromPaths(aclValues._starPaths, aclValues._starRunwayMap);
  collectFromPaths(aclValues._sidPaths, aclValues._sidRunwayMap);
  collectFromPaths(aclValues._apprPaths, aclValues._apprRunwayMap);
  collectFromPaths(aclValues._missedAppPaths, aclValues._missedAppMap);
  aclValues._runwayList = Array.from(runwaysWithData).sort();

  return aclValues;
});

// ─── IPC: Renderer-side logging (so renderer console.log goes to file too) ──
ipcMain.handle('renderer-log', async (_event, ...args) => {
  console.log('[RENDERER]', ...args);
});

// ─── Durable approach cache file path ─────────────────────

function _approachCachePath() {
  return path.join(app.getPath('userData'), 'approachCache.json');
}

function _cachePath() {
  return path.join(app.getPath('userData'), 'cache.json');
}

// ─── Centralized cache.json read/write ────────────────────
// All reads/writes to cache.json MUST go through these functions.

/**
 * Read and validate cache.json.
 * @param {{ validateRoot?: string, signalReScan?: boolean }} options
 * @returns {{ data: object|null, valid: boolean, missing: boolean, error?: string, versionMismatch: boolean, rootMismatch: boolean }}
 *   - data: the parsed JSON (always populated if file exists, even when invalid)
 *   - valid: true when cacheVersion matches CACHE_VERSION and root matches (if validateRoot set)
 *   - missing: true when cache.json doesn't exist on disk
 */
function _readCache(options = {}) {
  const cachePath = _cachePath();

  if (!fs.existsSync(cachePath)) {
    if (options.signalReScan && mainWindow) {
      mainWindow.webContents.send('cache-invalidated');
    }
    return { data: null, valid: false, missing: true, versionMismatch: true, rootMismatch: true };
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  } catch (e) {
    console.error('[CACHE] _readCache parse error:', e.message);
    if (options.signalReScan && mainWindow) {
      mainWindow.webContents.send('cache-invalidated');
    }
    return { data: null, valid: false, missing: false, error: e.message, versionMismatch: true, rootMismatch: true };
  }

  const cachedVersion = raw.cacheVersion || 0;
  const versionMismatch = cachedVersion !== CACHE_VERSION;
  const rootMismatch = options.validateRoot ? raw.gameRoot !== options.validateRoot : false;
  const valid = !versionMismatch && !rootMismatch;

  if (!valid && options.signalReScan && mainWindow) {
    mainWindow.webContents.send('cache-invalidated');
  }

  // Log validity for debugging
  if (!valid) {
    console.log('[CACHE] _readCache invalid — versionMismatch=' + versionMismatch + ' (stored=' + cachedVersion + ' expected=' + CACHE_VERSION + ') rootMismatch=' + rootMismatch);
  }

  return { data: raw, valid, missing: false, versionMismatch, rootMismatch };
}

/**
 * Write the full cache object to cache.json.
 * Creates the userData directory if it doesn't exist.
 * @param {object} data - full cache payload to write
 */
function _writeCache(data) {
  const cfgDir = app.getPath('userData');
  if (!fs.existsSync(cfgDir)) fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(_cachePath(), JSON.stringify(data), 'utf-8');
}

// ─── IPC: Phase 0 — initialize airport cache (scan all CSV + audio) ──

ipcMain.handle('init-airport-cache', async (_event, rootPath) => {
  console.log('══════════════ [INIT-CACHE] START ══════════════');
  const airportsDir = path.join(rootPath, 'GroundATC_Data', 'StreamingAssets', 'Airports');
  if (!fs.existsSync(airportsDir)) return {};

  // ── Try loading approach data from disk cache ──
  let diskCache = null;
  const cr = _readCache({ validateRoot: rootPath });
  if (cr.valid) {
    diskCache = cr.data.airports || {};
    const age = Date.now() - (cr.data.builtAt || 0);
    console.log('[INIT-CACHE] loaded approach cache from disk (' + Object.keys(diskCache).length + ' airports, age=' + (age / 3600000).toFixed(1) + 'h)');
  } else if (!cr.missing && !cr.error) {
    const age = cr.data ? Date.now() - (cr.data.builtAt || 0) : 0;
    console.log('[INIT-CACHE] disk cache invalid (rootMatch=' + !cr.rootMismatch + ' versionMatch=' + !cr.versionMismatch + ' age=' + (age / 3600000).toFixed(1) + 'h), will rebuild');
  } else if (cr.error) {
    console.log('[INIT-CACHE] disk cache read error:', cr.error);
  }

  const cache = {};

  // Count airports and total .acl files for global progress
  const airportList = [];
  let totalAclFiles = 0;
  for (const icao of fs.readdirSync(airportsDir)) {
    const ap = path.join(airportsDir, icao);
    if (fs.statSync(ap).isDirectory()) {
      const ld = path.join(ap, 'Levels');
      if (fs.existsSync(ld)) {
        airportList.push(icao);
        try {
          totalAclFiles += fs.readdirSync(ld).filter(f => f.endsWith('.acl') && !/tutorial|bench|test|crossrunway|dev|endless|\.prod/i.test(f)).length;
        } catch (_) {}
      }
    }
  }
  let processedFiles = 0;

  for (const icao of airportList) {
    const airportPath = path.join(airportsDir, icao);
    const levelsDir = path.join(airportPath, 'Levels');
    if (!fs.existsSync(levelsDir)) continue;

    // Load audio clips (always from JSON files — fast)
    const enPath = path.join(levelsDir, 'audio_clips_en.json');
    const zhPath = path.join(levelsDir, 'audio_clips_zh.json');
    const enData = fs.existsSync(enPath) ? loadAudioCallsigns(enPath) : null;
    const zhData = fs.existsSync(zhPath) ? loadAudioCallsigns(zhPath) : null;
    const audioCallsigns = mergeAudioCallsigns(enData, zhData);

    // Collect dropdown values + runway pairs from ALL .acl files
    let dropdownValues = {};
    let runwayPairs = [];
    const cachedEntry = diskCache && diskCache[icao];
    const hasCachedDropdowns = cachedEntry && cachedEntry.dropdownValues;

    if (hasCachedDropdowns) {
      dropdownValues = cachedEntry.dropdownValues;
      runwayPairs = cachedEntry.runwayPairs || [];
      console.log('[INIT-CACHE]   ' + icao + ': dropdowns from disk cache (' + Object.keys(dropdownValues).filter(k => !k.startsWith('_')).join(',') + ')');
    } else {
      const aclPaths = [];
      try {
        for (const le of fs.readdirSync(levelsDir, { withFileTypes: true })) {
          if (le.isFile() && le.name.endsWith('.acl') && !/tutorial|bench|test|crossrunway|dev|endless|\.prod/i.test(le.name)) {
            aclPaths.push(path.join(levelsDir, le.name));
          }
        }
      } catch (_) {}
      dropdownValues = aclPaths.length > 0 ? collectUniqueValues(aclPaths) : {};
      runwayPairs = aclPaths.length > 0 ? collectRunwayPairs(aclPaths) : [];
      console.log('[INIT-CACHE]   ' + icao + ': dropdowns scanned from ' + aclPaths.length + ' .acl files');
    }

    // Parse stand positions from first .acl file (airport-level, shared across all levels)
    let standPositions = cachedEntry?.standPositions || null;
    if (!standPositions) {
      try {
        const aclFiles = [];
        for (const le of fs.readdirSync(levelsDir, { withFileTypes: true })) {
          if (le.isFile() && le.name.endsWith('.acl') && !/tutorial|bench|test|crossrunway|dev|endless|\.prod/i.test(le.name)) aclFiles.push(path.join(levelsDir, le.name));
        }
        if (aclFiles.length > 0) {
          const firstAclText = fs.readFileSync(aclFiles[0], 'utf-8');
          standPositions = _parseStandPositions(firstAclText);
          console.log('[INIT-CACHE]   ' + icao + ': stand positions parsed from ' + path.basename(aclFiles[0]) + ' (' + Object.keys(standPositions).length + ' stands)');
        }
      } catch (e) {
        console.log('[INIT-CACHE]   ' + icao + ': stand position parsing failed:', e.message);
        standPositions = {};
      }
    } else {
      console.log('[INIT-CACHE]   ' + icao + ': stand positions from disk cache (' + Object.keys(standPositions).length + ' stands)');
    }

    // Parse area polygons from SceneryData.Areas (airport-level, shared across all levels)
    let areaData = cachedEntry?.areaData || null;
    if (!areaData) {
      const aclAreaFiles = [];
      for (const le of fs.readdirSync(levelsDir, { withFileTypes: true })) {
        if (le.isFile() && le.name.endsWith('.acl') && !/tutorial|bench|test|crossrunway|dev|endless|\.prod/i.test(le.name)) aclAreaFiles.push(path.join(levelsDir, le.name));
      }
      areaData = _parseAreaFromAcl(aclAreaFiles, '[INIT-CACHE]   ' + icao);
    } else {
      console.log('[INIT-CACHE]   ' + icao + ': area data from disk cache (' +
        (areaData[0]?.length || 0) + ' Type0, ' + (areaData[1]?.length || 0) + ' Type1, ' +
        (areaData[2]?.length || 0) + ' Type2)');
    }

    // Use SceneryData stand identifiers as the authoritative stand list
    if (standPositions && Object.keys(standPositions).length > 0) {
      dropdownValues.Stand = Object.keys(standPositions).sort((a, b) => a.localeCompare(b));
    }

    // Merge audio flight numbers into dropdown _flightNums
    if (audioCallsigns?.byAirline) {
      if (!dropdownValues._flightNums) dropdownValues._flightNums = {};
      for (const [code, nums] of Object.entries(audioCallsigns.byAirline)) {
        if (!dropdownValues._flightNums[code]) dropdownValues._flightNums[code] = [];
        const existing = dropdownValues._flightNums[code];
        for (const n of nums) {
          if (!existing.includes(n)) existing.push(n);
        }
        // Re-sort after merging
        existing.sort((a, b) => {
          const na = parseInt(a, 10), nb = parseInt(b, 10);
          if (!isNaN(na) && !isNaN(nb)) return na - nb;
          return String(a).localeCompare(String(b));
        });
      }
    }

    // Pre-scan approach data — from disk cache if available, otherwise scan files
    let approachData = null;
    if (cachedEntry) {
      // Support old format (approachData stored directly) and new format (nested under .approachData)
      const rawApproach = cachedEntry.approachData || cachedEntry;
      approachData = deserializeApproachCache(rawApproach);
      console.log('[INIT-CACHE]   ' + icao + ': approach from disk cache');
      // Rebuild state5ParamsMap and appPointMap from SceneryData as a fallback
      // for old caches that were written before these fields were persisted.
      // totalApproachTimes, state5ParamsMap, and appPointMap are now stored in
      // cache.json — this block only runs when they are missing (old cache).
      if (!approachData.state5ParamsMap || !approachData.appPointMap || !approachData.totalApproachTimes) {
        const approach = require('../src/acl/approach');
        try {
          const aclFiles = fs.readdirSync(levelsDir).filter(f => f.endsWith('.acl') && !/tutorial|bench|test|crossrunway|dev|endless|\.prod/i.test(f));
          if (aclFiles.length > 0) {
            const firstText = fs.readFileSync(path.join(levelsDir, aclFiles[0]), 'utf-8');
            const mappings = approach.extractStarRunwayMappings(firstText);

            // Rebuild state5ParamsMap (approach procedure params per runway)
            if (!approachData.state5ParamsMap) {
              approachData.state5ParamsMap = new Map();
              for (const rwy of Object.keys(mappings.runwayStarMap || {})) {
                const data = approach.resolveApproachProcedureData(firstText, rwy);
                if (data) {
                  approachData.state5ParamsMap.set(rwy, data);
                  // Also register normalized runway variant (e.g. "1" for "01")
                  const normalized = approach._normalizeRunway(rwy);
                  if (normalized !== rwy && !approachData.state5ParamsMap.has(normalized)) {
                    approachData.state5ParamsMap.set(normalized, data);
                  }
                }
              }
            }

            // Rebuild appPointMap from SceneryData with per-STAR variant selection.
            // Each STAR gets the variant whose first AirwayNode is closest to the
            // STAR's last FlyApproach point. Also adds STAR-specific state5ParamsMap keys.
            if (!approachData.appPointMap) {
              approachData.appPointMap = new Map();
              for (const [runway, stars] of Object.entries(mappings.runwayStarMap || {})) {
                for (const star of stars) {
                  const flyPoints = approach.resolveFlyApproachPoints(firstText, star, runway);
                  const hintPos = (flyPoints && flyPoints.length > 0)
                    ? flyPoints[flyPoints.length - 1]
                    : null;
                  const s5 = approach.resolveApproachProcedureData(firstText, runway, hintPos);
                  if (!s5 || !s5.pathPointList || s5.pathPointList.length < 2) continue;
                  approachData.appPointMap.set(star + '|' + runway, s5.pathPointList);
                  // Also store STAR-specific state5Params for State=5 generation
                  const s5Key = star + '|' + runway;
                  if (!approachData.state5ParamsMap.has(s5Key)) {
                    approachData.state5ParamsMap.set(s5Key, s5);
                  }
                }
                // Also register normalized runway variant (e.g. "1" for "01")
                const normRunway = approach._normalizeRunway(runway);
                if (normRunway !== runway) {
                  for (const star of stars) {
                    const flyPoints = approach.resolveFlyApproachPoints(firstText, star, normRunway);
                    const hintPos = (flyPoints && flyPoints.length > 0)
                      ? flyPoints[flyPoints.length - 1]
                      : null;
                    const s5n = approach.resolveApproachProcedureData(firstText, normRunway, hintPos);
                    if (!s5n || !s5n.pathPointList) continue;
                    const key = star + '|' + normRunway;
                    if (!approachData.appPointMap.has(key)) approachData.appPointMap.set(key, s5n.pathPointList);
                    const s5Key = star + '|' + normRunway;
                    if (!approachData.state5ParamsMap.has(s5Key)) {
                      approachData.state5ParamsMap.set(s5Key, s5n);
                    }
                  }
                }
              }
            }

            // Compute per-airport coordinate scale from runway thresholds (needed for TAT)
            if (approachData.airportScale == null && firstText) {
              approachData.airportScale = approach.computeAirportScale(firstText);
            }

            // Rebuild totalApproachTimes from SceneryData path lengths (fallback for old caches)
            if (!approachData.totalApproachTimes) {
              approachData.totalApproachTimes = approach.computeApproachTimesFromScenery(
                firstText, mappings, approachData.appPointMap, null, DEFAULT_TAT,
                approachData.airportScale
              );
            }

            console.log('[INIT-CACHE]   ' + icao + ': rebuilt SceneryData maps (' +
              (approachData.state5ParamsMap?.size || 0) + ' runways, ' +
              (approachData.appPointMap?.size || 0) + ' route combos, ' +
              (approachData.totalApproachTimes?.size || 0) + ' TATs, ' +
              'airportScale=' + (approachData.airportScale ? approachData.airportScale.toFixed(1) : 'N/A') + ')');
          }
        } catch (e) {
          console.error('[INIT-CACHE]   ' + icao + ': failed to rebuild SceneryData maps:', e.message);
        }
      }
    } else {
      approachData = buildApproachCache(levelsDir, () => {
        processedFiles++;
        if (_event.sender && !_event.sender.isDestroyed()) {
          _event.sender.send('cache-build-progress', {
            current: processedFiles,
            total: totalAclFiles,
          });
        }
      });
      console.log('[INIT-CACHE]   ' + icao + ': approach scanned from files');
    }

    // Use starRunwayMap keys as the authoritative STAR list.
    // Follows the same pattern as Stand filtering above — the scenery
    // data is the single source of truth. starRunwayMap is built from
    // SceneryData Type=0 Routes and already excludes stubs ($rlength:0).
    if (approachData && approachData.starRunwayMap) {
      const stars = Object.keys(approachData.starRunwayMap);
      if (stars.length > 0) {
        dropdownValues.Airway = stars.sort((a, b) => a.localeCompare(b));
      }
    }

    cache[icao] = { audioCallsigns, approachData, dropdownValues, runwayPairs, standPositions, areaData };
  }

  airportCache = cache;

  // ── Persist to disk for next launch ──
  if (!diskCache) {
    try {
      const serialized = {};
      for (const [icao, entry] of Object.entries(cache)) {
        serialized[icao] = {
          approachData: entry.approachData ? serializeApproachCache(entry.approachData) : null,
          dropdownValues: entry.dropdownValues || {},
          runwayPairs: entry.runwayPairs || [],
          standPositions: entry.standPositions || {},
          areaData: entry.areaData || {},
        };
      }
      const payload = {
        cacheVersion: CACHE_VERSION,
        gameRoot: rootPath,
        builtAt: Date.now(),
        airports: serialized,
      };
      _writeCache(payload);
      console.log('[INIT-CACHE] persisted cache to disk (' + Object.keys(serialized).length + ' airports)');
    } catch (e) {
      console.log('[INIT-CACHE] disk cache write error:', e.message);
    }
  }

  return cache;
});

// ─── IPC: Refresh root scan (delete disk cache & re-scan) ──

ipcMain.handle('refresh-root-scan', async (_event, rootPath) => {
  console.log('[IPC] refresh-root-scan START');
  try {
    // Preserve lang from old cache before deleting
    let preservedLang = null;
    const cr = _readCache();
    if (cr.data) preservedLang = cr.data.lang || null;

    // Delete disk cache to force re-scan
    const cachePath = _cachePath();
    if (fs.existsSync(cachePath)) {
      fs.unlinkSync(cachePath);
      console.log('[IPC] refresh-root-scan: deleted disk cache');
    }
    // Re-run init-airport-cache logic (same as the handler above but inline)
    const airportsDir = path.join(rootPath, 'GroundATC_Data', 'StreamingAssets', 'Airports');
    if (!fs.existsSync(airportsDir)) return { success: false, errorCode: 'error_airports_dir_not_found', errorPath: airportsDir };

    const cache = {};
    // Count airports and total .acl files for global progress
    const airportListR = [];
    let totalAclFilesR = 0;
    for (const icao of fs.readdirSync(airportsDir)) {
      const ap = path.join(airportsDir, icao);
      if (fs.statSync(ap).isDirectory()) {
        const ld = path.join(ap, 'Levels');
        if (fs.existsSync(ld)) {
          airportListR.push(icao);
          try { totalAclFilesR += fs.readdirSync(ld).filter(f => f.endsWith('.acl') && !/tutorial|bench|test|crossrunway|dev|endless|\.prod/i.test(f)).length; } catch (_) {}
        }
      }
    }
    let processedFilesR = 0;
    for (const icao of airportListR) {
      const airportPath = path.join(airportsDir, icao);
      const levelsDir = path.join(airportPath, 'Levels');
      if (!fs.existsSync(levelsDir)) continue;

      // Load audio clips
      const enPath = path.join(levelsDir, 'audio_clips_en.json');
      const zhPath = path.join(levelsDir, 'audio_clips_zh.json');
      const enData = fs.existsSync(enPath) ? loadAudioCallsigns(enPath) : null;
      const zhData = fs.existsSync(zhPath) ? loadAudioCallsigns(zhPath) : null;
      const audioCallsigns = mergeAudioCallsigns(enData, zhData);

      // Scan all .acl files for dropdown values + runway pairs
      const aclPaths = [];
      try {
        for (const le of fs.readdirSync(levelsDir, { withFileTypes: true })) {
          if (le.isFile() && le.name.endsWith('.acl') && !/tutorial|bench|test|crossrunway|dev|endless|\.prod/i.test(le.name)) {
            aclPaths.push(path.join(levelsDir, le.name));
          }
        }
      } catch (_) {}
      const dropdownValues = aclPaths.length > 0 ? collectUniqueValues(aclPaths) : {};
      const runwayPairs = aclPaths.length > 0 ? collectRunwayPairs(aclPaths) : [];

      // Merge audio flight numbers into dropdown _flightNums
      if (audioCallsigns?.byAirline) {
        if (!dropdownValues._flightNums) dropdownValues._flightNums = {};
        for (const [code, nums] of Object.entries(audioCallsigns.byAirline)) {
          if (!dropdownValues._flightNums[code]) dropdownValues._flightNums[code] = [];
          const existing = dropdownValues._flightNums[code];
          for (const n of nums) {
            if (!existing.includes(n)) existing.push(n);
          }
          existing.sort((a, b) => {
            const na = parseInt(a, 10), nb = parseInt(b, 10);
            if (!isNaN(na) && !isNaN(nb)) return na - nb;
            return String(a).localeCompare(String(b));
          });
        }
      }

      const approachData = buildApproachCache(levelsDir, () => {
        processedFilesR++;
        if (_event.sender && !_event.sender.isDestroyed()) {
          _event.sender.send('cache-build-progress', {
            current: processedFilesR,
            total: totalAclFilesR,
          });
        }
      });
      // Parse stand positions from first .acl file
      let standPositions = {};
      try {
        if (aclPaths.length > 0) {
          const firstAclText = fs.readFileSync(aclPaths[0], 'utf-8');
          standPositions = _parseStandPositions(firstAclText);
        }
      } catch (e) { standPositions = {}; }

      // Parse area polygons from SceneryData.Areas
      const areaData = _parseAreaFromAcl(aclPaths, null);

      // Use SceneryData stand identifiers as the authoritative stand list
      if (standPositions && Object.keys(standPositions).length > 0) {
        dropdownValues.Stand = Object.keys(standPositions).sort((a, b) => a.localeCompare(b));
      }

      // Use starRunwayMap keys as the authoritative STAR list
      // (same pattern as Stand — scenery is the single source of truth).
      if (approachData && approachData.starRunwayMap) {
        const stars = Object.keys(approachData.starRunwayMap);
        if (stars.length > 0) {
          dropdownValues.Airway = stars.sort((a, b) => a.localeCompare(b));
        }
      }

      cache[icao] = { audioCallsigns, approachData, dropdownValues, runwayPairs, standPositions, areaData };
    }

    airportCache = cache;

    // Persist new cache
    const serialized = {};
    for (const [icao, entry] of Object.entries(cache)) {
      serialized[icao] = {
        approachData: entry.approachData ? serializeApproachCache(entry.approachData) : null,
        dropdownValues: entry.dropdownValues || {},
        runwayPairs: entry.runwayPairs || [],
        standPositions: entry.standPositions || {},
        areaData: entry.areaData || {},
      };
    }
    const payload = { cacheVersion: CACHE_VERSION, gameRoot: rootPath, lang: preservedLang, builtAt: Date.now(), airports: serialized };
    _writeCache(payload);

    console.log('[IPC] refresh-root-scan OK — ' + Object.keys(cache).length + ' airports');

    // Re-scan .acl files so the front-end gets an up-to-date airport/file listing
    const scan = scanGameRoot(rootPath);
    cachedScan = scan;
    console.log('[IPC] refresh-root-scan: re-scanned filesystem — airports=' + scan.airports.length + ' totalFiles=' + (scan.totalFiles || 0));
    return { success: true, airports: scan.airports, totalFiles: scan.totalFiles || 0 };
  } catch (err) {
    console.error('[IPC] refresh-root-scan FAIL:', err.message);
    return { success: false, error: err.message };
  }
});

// ─── Shared helpers: demo file detection + 30-min window filter ───

/**
 * Returns true if the file is an emergency scenario (contains _emerg).
 * Emergency files ending with .demo.acl also get the 30-minute demo window,
 * same as regular .demo.acl files.
 * @param {string} filePathOrName
 * @returns {boolean}
 */
function _isEmerFile(filePathOrName) {
  return filePathOrName.includes('_emerg');
}

/**
 * Returns true if the file gets the 30-minute demo window treatment.
 * Determined by DEMO_VISIBLE_BASES dict — exact match on full filename
 * (including extension), not by file extension or path prefix.
 * @param {string} filePathOrName — full path or just filename
 * @returns {boolean}
 */
function _isDemoFile(filePathOrName) {
  const name = path.basename(filePathOrName);
  return DEMO_VISIBLE_BASES.has(name);
}

/**
 * For demo files (as determined by _isDemoFile): filter flights to a 30-minute window starting at
 * CurrentDateTime, and override config startTime/endTime to match.
 * Uses integer minutes (Math.floor) so flights at the boundary minute are
 * kept, and strict upper bound (<) so flights exactly at +30min are excluded.
 * @param {string} filePath
 * @param {Array} flights
 * @param {object|null} config
 * @returns {{ flights: Array, config: object|null, _currentDateTime: string|null, removedCount: number }}
 */
function _filterDemoFlights(filePath, flights, config) {
  try {
    const rawText = fs.readFileSync(filePath, 'utf-8');
    const cdt = extractCurrentDateTime(rawText);
    if (cdt && cdt.timeString) {
      const _currentDateTime = cdt.timeString;
      // Use integer minutes — secSinceMidnight can include seconds, but flight
      // times are HH:MM only.  Without floor, a flight at 05:45 (345 min) would
      // fail 345 >= 345.5 and be incorrectly removed.
      const cdtMin = Math.floor(cdt.secSinceMidnight / 60);
      const cdtMaxMin = cdtMin + 30; // 30-min demo window

      const toMin = t => {
        const p = String(t).split(':');
        return parseInt(p[0]) * 60 + parseInt(p[1]);
      };

      const before = flights.length;
      flights = flights.filter(fl => {
        const lt = (fl.LandingTime || '').trim();
        const ob = (fl.OffBlockTime || '').trim();
        const flightMin = lt ? toMin(lt) : (ob ? toMin(ob) : Infinity);
        return flightMin >= cdtMin && flightMin < cdtMaxMin;
      });
      const removedCount = before - flights.length;
      if (removedCount > 0) {
        console.log('[DEMO] removed ' + removedCount + ' flights outside [' + _currentDateTime + ', +30min] window');
      }

      // Override config to match demo window
      const endSec = cdt.secSinceMidnight + DEMO_WINDOW_SEC;
      const eh = Math.floor((endSec % 86400) / 3600) % 24;
      const em = Math.floor((endSec % 3600) / 60);
      const es = endSec % 60;
      const demoEndTime = String(eh).padStart(2, '0') + ':' + String(em).padStart(2, '0') + ':' + String(es).padStart(2, '0');

      if (config) {
        config.startTime = _currentDateTime;
        config.endTime = demoEndTime;
      } else {
        config = { startTime: _currentDateTime, endTime: demoEndTime };
      }

      console.log('[DEMO] window [' + _currentDateTime + ' ~ ' + demoEndTime + '] (30min cap)');
      return { flights, config, _currentDateTime, removedCount };
    }
  } catch (e) {
    console.log('[DEMO] flight filtering failed:', e.message);
  }
  return { flights, config, _currentDateTime: null, removedCount: 0 };
}

// ─── IPC: Load an .acl file ──────────────────────────────

ipcMain.handle('load-acl', async (_event, filePath) => {
  console.log('[IPC] load-acl START:', filePath);
  try {
    const data = loadFlights(filePath);
    console.log('[IPC] load-acl OK: flights=' + data.flights.length + ' fromFlightPlans=' + (data._fromFlightPlans || false) + ' fromWorldState=' + (data._fromWorldState || false));

    // Extract config from ACL's Config block (single source of truth)
    let config = null;
    if (data._rawText) {
      config = _extractConfig(data._rawText);
      console.log('[IPC] load-acl: config from ACL ->', config ? ('startTime=' + config.startTime + ' endTime=' + config.endTime) : 'NULL');
    } else {
      console.log('[IPC] load-acl: WARNING data._rawText is falsy!');
    }

    const isDemo = _isDemoFile(filePath);
    const isEmer = _isEmerFile(filePath);
    console.log('[IPC] load-acl: isDemo=' + isDemo + ' isEmer=' + isEmer + ' flights=' + (data.flights ? data.flights.length : 0) + ' config=' + (config ? ('startTime=' + config.startTime + ' endTime=' + config.endTime) : 'NULL'));

    // For .demo.acl (including _emerg): filter flights to 30-min window at CurrentDateTime
    let _currentDateTime = null;
    let removedCount = 0;
    if (isDemo && data.flights && data.flights.length > 0) {
      const result = _filterDemoFlights(filePath, data.flights, config);
      data.flights = result.flights;
      config = result.config;
      _currentDateTime = result._currentDateTime;
      removedCount = result.removedCount;
    }

    // Compute earliest flight time from loaded data (handles midnight-crossing)
    let earliestTime = null, earliestMin = Infinity;
    if (data.flights) {
      const toMin = t => { const p = String(t).split(':'); return parseInt(p[0]) * 60 + parseInt(p[1]); };
      // If level starts in the evening, treat post-midnight times as next-day
      const startH = config && config.startTime ? parseInt(String(config.startTime).substring(0, 2)) : 0;
      const crossesMidnight = startH >= MIDNIGHT_CROSS_START_HOUR;
      for (const fl of data.flights) {
        for (const field of ['LandingTime', 'OffBlockTime']) {
          const t = fl[field];
          if (!t) continue;
          let tm = toMin(t);
          if (crossesMidnight && tm < MIDNIGHT_CROSS_THRESHOLD_MIN) tm += MINUTES_PER_DAY; // times before 06:00 are next day
          if (tm < earliestMin) {
            earliestTime = t;
            earliestMin = tm;
          }
        }
      }
    }

    // Extract saveTime: prefer GameTime.CurrentDateTime, fall back to approach entries,
    // then to config.startTime + warmup so _saveSec is never null when config exists
    let _saveSec = null;
    try {
      const rawText = fs.readFileSync(filePath, 'utf-8');
      _saveSec = extractGameTime(rawText);
      if (_saveSec !== null) {
        console.log('[IPC] load-acl: saveTime=' + _saveSec + 's from GameTime.CurrentDateTime');
      } else {
        const icaoMatch = filePath.match(/[\\/]Airports[\\/]([^\\/]+)[\\/]Levels[\\/]/i);
        const icao = icaoMatch ? icaoMatch[1] : '';
        const cacheEntry = airportCache && airportCache[icao];
        const totalApproachTimes = cacheEntry?.approachData?.totalApproachTimes;
        _saveSec = extractSaveTime(rawText, totalApproachTimes);
        if (_saveSec !== null) {
          console.log('[IPC] load-acl: saveTime=' + _saveSec + 's from approach entries (fallback)');
        }
      }
    } catch (_) {}
    // Final fallback: compute from config.startTime + 13min warmup
    if (_saveSec == null && config && config.startTime) {
      const p = String(config.startTime).split(':');
      _saveSec = parseInt(p[0]) * 3600 + parseInt(p[1]) * 60 + (parseInt(p[2]) || 0) + WARMUP_SEC;
      console.log('[IPC] load-acl: saveTime=' + _saveSec + 's from config.startTime + warmup (final fallback)');
    }

    return { success: true, path: filePath, config, earliestTime, _saveSec, _currentDateTime, isDemo, ...data };
  } catch (err) {
    console.error('[IPC] load-acl FAIL:', filePath, '|', err.message, '|', err.stack);
    return { success: false, error: err.message };
  }
});

// ─── IPC: Save .acl with optional .bak overwrite backup ────

ipcMain.handle('save-acl', async (_event, { filePath, flights, before, after, arrayContent, originalBlocks, worldStateData, sceneryMaps, _fromWorldState, _fromFlightPlans, createBackup, weatherTimeline, windTimeline, runwayTimeline, _saveSec }) => {
  try {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath, '.acl');

    // Re-sort flights to chronological (file) order before saving,
    // so ACL block pairing and CSV output match the original order.
    const saveFlights = sortFlightsChronologically(flights);

    // Create .bak overwrite backup if requested
    console.log('[IPC] save-acl: createBackup=' + createBackup + ' filePath=' + filePath + ' exists=' + fs.existsSync(filePath));
    if (createBackup && fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, filePath + '.bak');
      console.log('[IPC] save-acl: .bak created at ' + filePath + '.bak');
    } else {
      console.log('[IPC] save-acl: .bak NOT created (createBackup=' + createBackup + ')');
    }

    // Read the ACL's Config block for startTime and file references
    let aclcfgStartTime = null;
    let aclcfgEndTime = null;
    let config = null;
    const isDemoSave = _isDemoFile(filePath);
    const isEmerSave = _isEmerFile(filePath);
    try {
      const text = fs.readFileSync(filePath, 'utf-8');
      config = _extractConfig(text);
      if (config) {
        aclcfgStartTime = config.startTime || null;
        aclcfgEndTime = config.endTime || null;
      }
      // For .demo.acl files (including _emerg), override startTime/endTime from CDT.
      // NOTE: We do NOT override _saveSec from CDT — the wall-clock timestamp
      // is not the scenario save point. saveSec comes from the approach cache's
      // saveTimeOffsets (derived from landingTime - (1-PR)*TAT during init scan).
      const cdt = extractCurrentDateTime(text);
      if (isDemoSave && cdt && cdt.timeString) {
        aclcfgStartTime = cdt.timeString;
        const endSec = cdt.secSinceMidnight + DEMO_WINDOW_SEC;
        const eh = Math.floor((endSec % 86400) / 3600) % 24;
        const em = Math.floor((endSec % 3600) / 60);
        const es = endSec % 60;
        aclcfgEndTime = String(eh).padStart(2, '0') + ':' + String(em).padStart(2, '0') + ':' + String(es).padStart(2, '0');
        console.log('[IPC] save-acl: demo — aclcfgStartTime=' + aclcfgStartTime + ' aclcfgEndTime=' + aclcfgEndTime);
      }
    } catch (_) {}

    // Extract ICAO for approach cache lookup
    const icaoMatch = filePath.match(/[\\/]Airports[\\/]([^\\/]+)[\\/]Levels[\\/]/i);
    const icao = icaoMatch ? icaoMatch[1] : '';
    const approachCache = (icao && airportCache && airportCache[icao]) ? airportCache[icao].approachData : null;

    // Generate full ACL from scratch, preserving header structure
    generateFullAcl(filePath, saveFlights, before, after, originalBlocks, worldStateData, sceneryMaps, _fromWorldState, _fromFlightPlans, approachCache, aclcfgStartTime, _saveSec);

    // ── Patch timeline sections into ACL ──
    _rebuildTimelineSections(filePath, weatherTimeline, windTimeline, runwayTimeline);

    // ── Also sync the CSV that the game loads ──
    let csvSynced = false;
    let csvBackupDone = false;
    try {
      if (config && config.flightScheduleFile) {
        const csvPath = path.join(dir, config.flightScheduleFile + '.csv');
        // Create .bak CSV backup if requested
        if (createBackup && fs.existsSync(csvPath)) {
          fs.copyFileSync(csvPath, csvPath + '.bak');
          csvBackupDone = true;
        }
        exportGameCSV(saveFlights, csvPath);
        csvSynced = true;
      }
    } catch (csvErr) {
      // CSV sync is best-effort; don't fail the whole save
      console.error('CSV sync warning:', csvErr.message);
    }

    return { success: true, csvSynced, csvBackupDone };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Export ZIP (Save As) ──────────────────────────
// Collects all 5 level files from the current acl's directory and packages into a ZIP.

function getLevelFilePaths(aclPath) {
  const dir = path.dirname(aclPath);
  const baseName = path.basename(aclPath, '.acl');
  const entries = [];

  // 1) .acl file
  if (fs.existsSync(aclPath)) {
    entries.push({ name: path.basename(aclPath), data: fs.readFileSync(aclPath) });
  }

  // Read Config block from ACL for file references (single source of truth)
  let config = null;
  try {
    const text = fs.readFileSync(aclPath, 'utf-8');
    config = _extractConfig(text);
  } catch (_) {}

  // 2) .csv file (from ACL Config → flightScheduleFile, fallback to .acl → .csv)
  let csvPath = null;
  if (config && config.flightScheduleFile) {
    csvPath = path.join(dir, config.flightScheduleFile + '.csv');
  }
  if (!csvPath) csvPath = aclPath.replace(/\.acl$/i, '.csv');
  if (fs.existsSync(csvPath)) {
    entries.push({ name: path.basename(csvPath), data: fs.readFileSync(csvPath) });
  }

  // 3) weather_timeline.json
  const weatherPath = path.join(dir, 'weather_timeline.json');
  if (fs.existsSync(weatherPath)) {
    entries.push({ name: 'weather_timeline.json', data: fs.readFileSync(weatherPath) });
  }

  // 4) wind_timeline.json
  const windPath = path.join(dir, 'wind_timeline.json');
  if (fs.existsSync(windPath)) {
    entries.push({ name: 'wind_timeline.json', data: fs.readFileSync(windPath) });
  }

  // 5) runway_timeline*.json (from ACL Config → runwayTimelineFile)
  if (config && config.runwayTimelineFile) {
    const rwyPath = path.join(dir, config.runwayTimelineFile + '.json');
    if (fs.existsSync(rwyPath)) {
      entries.push({ name: path.basename(rwyPath), data: fs.readFileSync(rwyPath) });
    }
  }

  return entries;
}


ipcMain.handle('export-zip', async (_event, { aclPath }) => {
  const entries = getLevelFilePaths(aclPath);
  if (entries.length === 0) return { canceled: false, error: 'No files to export' };

  const defaultName = path.basename(aclPath, '.acl') + '_export.zip';
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Level Package (.zip)',
    defaultPath: defaultName,
    filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };

  try {
    createZip(entries, result.filePath);
    return { canceled: false, path: result.filePath, fileCount: entries.length };
  } catch (err) {
    return { canceled: false, error: err.message };
  }
});

// ─── IPC: Manual backup ──────────────────────────────────

ipcMain.handle('manual-backup', async (_event, sourcePath) => {
  try {
    const destPath = sourcePath + '.bak';
    fs.copyFileSync(sourcePath, destPath);
    return { canceled: false, path: destPath };
  } catch (err) {
    return { canceled: false, error: err.message };
  }
});

// ─── IPC: Import ZIP ────────────────────────────────────

ipcMain.handle('import-zip', async (_event, { aclPath, createBackup }) => {
  // 1) Show open dialog for .zip
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Level Package (.zip)',
    filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };

  try {
    const zipPath = result.filePaths[0];

    // 2) Validate ZIP contents — must contain all necessary file types
    const fileList = listZipFiles(zipPath);
    const lowerNames = fileList.map(f => f.toLowerCase());

    const hasAcl = lowerNames.some(f => f.endsWith('.acl'));
    const hasCsv = lowerNames.some(f => f.endsWith('.csv'));
    const hasWeather = lowerNames.some(f => f === 'weather_timeline.json');
    const hasWind = lowerNames.some(f => f === 'wind_timeline.json');
    const hasRunway = lowerNames.some(f => f.startsWith('runway_timeline') && f.endsWith('.json'));

    const missing = [];
    if (!hasAcl) missing.push('flight schedule');
    if (!hasCsv) missing.push('flight data');
    if (!hasWeather) missing.push('weather timeline');
    if (!hasWind) missing.push('wind timeline');
    if (!hasRunway) missing.push('runway timeline');

    if (missing.length > 0) {
      return { canceled: false, error: `ZIP missing required files: ${missing.join(', ')}` };
    }

    // 3) Validate ZIP .acl filename matches current level (reject airport/level mismatch)
    const currentAclName = path.basename(aclPath);
    const zipAclNames = fileList.filter(f => f.toLowerCase().endsWith('.acl'));
    if (!zipAclNames.includes(currentAclName)) {
      return { canceled: false, error: 'Level mismatch' };
    }

    // 4) Backup current files before overwriting (if requested)
    const dir = path.dirname(aclPath);
    if (createBackup) {
      const entries = getLevelFilePaths(aclPath);
      for (const entry of entries) {
        const p = path.join(dir, entry.name);
        if (fs.existsSync(p)) {
          fs.copyFileSync(p, p + '.bak');
        }
      }
      console.log('[IPC] import-zip: .bak created for level files');
    } else {
      console.log('[IPC] import-zip: .bak skipped (createBackup=' + createBackup + ')');
    }

    // 5) Extract ZIP to the target directory (overwrites existing)
    extractZip(zipPath, dir);

    // 6) Reload the ACL to return parsed data
    const aclFile = path.basename(aclPath);
    const newAclPath = path.join(dir, aclFile);
    const data = loadFlights(newAclPath);
    const isDemo = _isDemoFile(aclFile);
    const isEmer = _isEmerFile(aclFile);

    // 6b) Extract config first (needed by demo filter to override startTime/endTime)
    let config = null;
    if (data._rawText) {
      config = _extractConfig(data._rawText);
    }

    // 6c) For .demo.acl (including _emerg): filter flights to 30-min window at CurrentDateTime
    let _currentDateTime = null;
    if (isDemo && data.flights && data.flights.length > 0) {
      const result = _filterDemoFlights(newAclPath, data.flights, config);
      data.flights = result.flights;
      config = result.config;
      _currentDateTime = result._currentDateTime;
      if (result.removedCount > 0) {
        console.log('[IPC] import-zip: removed ' + result.removedCount + ' flights outside demo window');
      }
    }

    // 8) Compute earliest flight time (same as load-acl handler)
    let earliestTime = null, earliestMin = Infinity;
    if (data.flights) {
      const toMin = t => { const p = String(t).split(':'); return parseInt(p[0]) * 60 + parseInt(p[1]); };
      const startH = config && config.startTime ? parseInt(String(config.startTime).substring(0, 2)) : 0;
      const crossesMidnight = startH >= MIDNIGHT_CROSS_START_HOUR;
      for (const fl of data.flights) {
        for (const field of ['LandingTime', 'OffBlockTime']) {
          const t = fl[field];
          if (!t) continue;
          let tm = toMin(t);
          if (crossesMidnight && tm < MIDNIGHT_CROSS_THRESHOLD_MIN) tm += MINUTES_PER_DAY;
          if (tm < earliestMin) {
            earliestTime = t;
            earliestMin = tm;
          }
        }
      }
    }

    // 9) Extract saveTime (same as load-acl handler)
    let _saveSec = null;
    try {
      const rawText = fs.readFileSync(newAclPath, 'utf-8');
      _saveSec = extractGameTime(rawText);
      if (_saveSec !== null) {
        console.log('[IPC] import-zip: saveTime=' + _saveSec + 's from GameTime.CurrentDateTime');
      } else {
        const icaoMatch2 = newAclPath.match(/[\\/]Airports[\\/]([^\\/]+)[\\/]Levels[\\/]/i);
        const icao2 = icaoMatch2 ? icaoMatch2[1] : '';
        const cacheEntry2 = airportCache && airportCache[icao2];
        const totalApproachTimes2 = cacheEntry2?.approachData?.totalApproachTimes;
        _saveSec = extractSaveTime(rawText, totalApproachTimes2);
        if (_saveSec !== null) {
          console.log('[IPC] import-zip: saveTime=' + _saveSec + 's from approach entries (fallback)');
        }
      }
    } catch (_) {}
    if (_saveSec == null && config && config.startTime) {
      const p2 = String(config.startTime).split(':');
      _saveSec = parseInt(p2[0]) * 3600 + parseInt(p2[1]) * 60 + (parseInt(p2[2]) || 0) + WARMUP_SEC;
      console.log('[IPC] import-zip: saveTime=' + _saveSec + 's from config.startTime + warmup (final fallback)');
    }

    return { canceled: false, path: newAclPath, config, earliestTime, _saveSec, _currentDateTime, isDemo, ...data };
  } catch (err) {
    return { canceled: false, error: err.message };
  }
});

// ─── IPC: Check backup existence ─────────────────────────

ipcMain.handle('check-backup-exists', async (_event, filePath) => {
  try {
    const aclBak = filePath + '.bak';
    const exists = fs.existsSync(aclBak);
    return { success: true, exists };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Restore from latest .bak backups ────────────────

ipcMain.handle('restore-latest-backup', async (_event, filePath) => {
  try {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath, '.acl');
    const restored = [];

    // 1) Restore .acl.bak → .acl
    const aclBak = filePath + '.bak';
    if (!fs.existsSync(aclBak)) {
      return { success: false, error: 'No backup file found' };
    }
    fs.copyFileSync(aclBak, filePath);
    restored.push('flight schedule');

    // 2) Read config from restored ACL's Config block for file references
    let config = null;
    try {
      const text = fs.readFileSync(filePath, 'utf-8');
      config = _extractConfig(text);
    } catch (_) {}

    // 3) Restore CSV .bak → .csv
    if (config && config.flightScheduleFile) {
      const csvPath = path.join(dir, config.flightScheduleFile + '.csv');
      const csvBak = csvPath + '.bak';
      if (fs.existsSync(csvBak)) {
        fs.copyFileSync(csvBak, csvPath);
        restored.push('flight data');
      }
    }

    // 4) Restore timeline .json.bak → .json
    const timelineFiles = [
      { bak: path.join(dir, 'weather_timeline.json.bak'), dest: path.join(dir, 'weather_timeline.json'), label: 'Weather Timeline' },
      { bak: path.join(dir, 'wind_timeline.json.bak'), dest: path.join(dir, 'wind_timeline.json'), label: 'Wind Timeline' },
    ];

    if (config && config.runwayTimelineFile) {
      const rwyPath = path.join(dir, config.runwayTimelineFile + '.json');
      timelineFiles.push({ bak: rwyPath + '.bak', dest: rwyPath, label: 'Runway Timeline' });
    }

    for (const tf of timelineFiles) {
      if (fs.existsSync(tf.bak)) {
        fs.copyFileSync(tf.bak, tf.dest);
        restored.push(tf.label);
      }
    }

    // 5) Parse restored ACL and return flights
    const data = loadFlights(filePath);

    // 5b) Demo filtering (same as load-acl handler) — filter flights to 30-min window
    let _currentDateTime = null;
    const isDemo = _isDemoFile(filePath);
    if (isDemo && data.flights && data.flights.length > 0) {
      const result = _filterDemoFlights(filePath, data.flights, config);
      data.flights = result.flights;
      config = result.config;
      _currentDateTime = result._currentDateTime;
    }

    // 6) Compute earliest flight time + saveTime (same as load-acl handler)
    let earliestTime = null, earliestMin = Infinity;
    if (data.flights) {
      const toMin = t => { const p = String(t).split(':'); return parseInt(p[0]) * 60 + parseInt(p[1]); };
      const startH = config && config.startTime ? parseInt(String(config.startTime).substring(0, 2)) : 0;
      const crossesMidnight = startH >= MIDNIGHT_CROSS_START_HOUR;
      for (const fl of data.flights) {
        for (const field of ['LandingTime', 'OffBlockTime']) {
          const t = fl[field];
          if (!t) continue;
          let tm = toMin(t);
          if (crossesMidnight && tm < MIDNIGHT_CROSS_THRESHOLD_MIN) tm += MINUTES_PER_DAY;
          if (tm < earliestMin) { earliestTime = t; earliestMin = tm; }
        }
      }
    }

    let _saveSec = null;
    try {
      const rawText = fs.readFileSync(filePath, 'utf-8');
      _saveSec = extractGameTime(rawText);
      if (_saveSec == null) {
        const icaoMatch = filePath.match(/[\\/]Airports[\\/]([^\\/]+)[\\/]Levels[\\/]/i);
        const icao = icaoMatch ? icaoMatch[1] : '';
        const cacheEntry = airportCache && airportCache[icao];
        _saveSec = extractSaveTime(rawText, cacheEntry?.approachData?.totalApproachTimes);
      }
    } catch (_) {}
    if (_saveSec == null && config && config.startTime) {
      const p = String(config.startTime).split(':');
      _saveSec = parseInt(p[0]) * 3600 + parseInt(p[1]) * 60 + (parseInt(p[2]) || 0) + WARMUP_SEC;
    }

    return { success: true, path: filePath, restored, config, earliestTime, _saveSec, _currentDateTime, isDemo, ...data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Export CSV ─────────────────────────────────────

ipcMain.handle('export-csv', async (_event, { flights, defaultPath }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Flight Data',
    defaultPath: defaultPath || 'flights.csv',
    filters: [{ name: 'Spreadsheet Files', extensions: ['csv'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: false };

  try {
    exportCSV(flights, result.filePath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});


// ─── IPC: Cache state (replaces get-last-root + check-version-mismatch) ──

ipcMain.handle('get-cache-state', () => {
  try {
    // Cache exists — check version
    const cr = _readCache();
    if (cr.data) {
      const airportList = cr.data.airports ? Object.keys(cr.data.airports) : [];
      return {
        state: cr.valid ? 'ready' : 'mismatch',
        gameRoot: cr.data.gameRoot || null,
        lang: cr.data.lang || null,
        airports: airportList,
        cachedVersion: cr.data.cacheVersion || 0,
        expectedVersion: CACHE_VERSION,
      };
    }

    // No cache.json — try migration from old approachCache.json (has full data)
    const oldApproachPath = _approachCachePath();
    if (fs.existsSync(oldApproachPath)) {
      try {
        const old = JSON.parse(fs.readFileSync(oldApproachPath, 'utf-8'));
        const payload = {
          cacheVersion: CACHE_VERSION,
          gameRoot: old.gameRoot || '',
          lang: null,
          builtAt: old.builtAt || Date.now(),
          airports: old.airports || {},
        };
        _writeCache(payload);
        console.log('[get-cache-state] migrated from approachCache.json');
        return {
          state: 'ready',
          gameRoot: payload.gameRoot,
          lang: null,
          airports: Object.keys(payload.airports),
          cachedVersion: CACHE_VERSION,
          expectedVersion: CACHE_VERSION,
        };
      } catch (e) {
        console.error('[get-cache-state] migration from approachCache.json failed:', e.message);
      }
    }

    // Try old lastRoot.json (just the root path, no airport data)
    const oldLastRootPath = path.join(app.getPath('userData'), 'lastRoot.json');
    if (fs.existsSync(oldLastRootPath)) {
      try {
        const old = JSON.parse(fs.readFileSync(oldLastRootPath, 'utf-8'));
        // Don't create cache.json yet — no airport data. Let init-airport-cache handle it.
        return {
          state: 'mismatch',
          gameRoot: old.rootPath || '',
          lang: null,
          airports: [],
          cachedVersion: 0,
          expectedVersion: CACHE_VERSION,
        };
      } catch (e) {
        console.error('[get-cache-state] read of lastRoot.json failed:', e.message);
      }
    }

    // Nothing to migrate
    return { state: 'no-cache' };
  } catch (err) {
    console.error('[get-cache-state] error:', err.message);
    return { state: 'no-cache' };
  }
});

// ─── IPC: Cache lang read/write ──────────────────────────

ipcMain.handle('get-cached-lang', () => {
  const cr = _readCache();
  if (cr.data) return { lang: cr.data.lang || null };
  return { lang: null };
});

ipcMain.handle('save-cached-lang', (_event, lang) => {
  try {
    const cr = _readCache();
    if (cr.data) {
      cr.data.lang = lang;
      _writeCache(cr.data);
    } else {
      // No cache yet — write minimal record
      _writeCache({ cacheVersion: CACHE_VERSION, lang });
    }
    return { success: true };
  } catch (err) {
    console.error('[save-cached-lang] error:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('open-external', async (_event, url) => {
  await shell.openExternal(url);
});

// ─── IPC: Load timeline files for a level ────────────────

ipcMain.handle('load-timelines', async (_event, aclPath) => {
  try {
    const levelsDir = path.dirname(aclPath);

    // Parse timelines directly from ACL (single source of truth)
    const aclText = fs.readFileSync(aclPath, 'utf-8');
    const config = _extractConfig(aclText);
    console.log('[IPC] load-timelines: config from ACL ->', config ? ('startTime=' + config.startTime + ' endTime=' + config.endTime + ' runwayTimelineFile=' + config.runwayTimelineFile) : 'NULL');
    const weatherTimeline = _parseWeatherFrames(aclText);
    const windTimeline = _parseWindFrames(aclText);
    const runwayTimeline = _parseRunwayTimeline(aclText);

    // Read windSpeedUnit from airport_config.json (default to 'knots')
    let windSpeedUnit = 'knots';
    try {
      const airportConfigPath = path.join(path.dirname(levelsDir), 'airport_config.json');
      if (fs.existsSync(airportConfigPath)) {
        const acJson = JSON.parse(fs.readFileSync(airportConfigPath, 'utf-8'));
        if (acJson.windSpeedUnit) windSpeedUnit = acJson.windSpeedUnit;
        console.log('[IPC] load-timelines: windSpeedUnit=' + windSpeedUnit + ' from airport_config.json');
      }
    } catch (e) { /* keep default */ }

    return {
      success: true,
      weatherTimeline,
      weatherPath: path.join(levelsDir, 'weather_timeline.json'),
      windTimeline,
      windPath: path.join(levelsDir, 'wind_timeline.json'),
      runwayTimeline,
      runwayTimelinePath: (config && config.runwayTimelineFile)
        ? path.join(levelsDir, config.runwayTimelineFile + '.json')
        : null,
      windSpeedUnit,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Save weather_timeline.json ──────────────────────

ipcMain.handle('save-weather-timeline', async (_event, { filePath, data }) => {
  try {
    const dir = path.dirname(filePath);
    const bakPath = filePath + '.bak';
    const backupPath = path.join(dir, 'weather_timeline_backup_' + Date.now() + '.json');
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, bakPath);
      fs.copyFileSync(filePath, backupPath);
    }
    fs.writeFileSync(filePath, JSON.stringify(data, (k, v) => k === '_isNew' ? undefined : v, 4), 'utf-8');
    return { success: true, backupPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Save wind_timeline.json ─────────────────────────

ipcMain.handle('save-wind-timeline', async (_event, { filePath, data }) => {
  try {
    const dir = path.dirname(filePath);
    const bakPath = filePath + '.bak';
    const backupPath = path.join(dir, 'wind_timeline_backup_' + Date.now() + '.json');
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, bakPath);
      fs.copyFileSync(filePath, backupPath);
    }
    fs.writeFileSync(filePath, JSON.stringify(data, (k, v) => k === '_isNew' ? undefined : v, 4), 'utf-8');
    return { success: true, backupPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Load audio callsigns for an airport (en + zh merged) ─────

ipcMain.handle('load-audio-callsigns', async (_event, rootPath, airportIcao) => {
  // Read from airport cache (built during init-airport-cache / refresh-root-scan)
  const cached = airportCache && airportCache[airportIcao];
  return cached?.audioCallsigns || { byAirline: {}, allCallsigns: [], allAirlines: [] };
});

// ─── IPC: Save runway_timeline*.json ─────────────────────

ipcMain.handle('save-runway-timeline', async (_event, { filePath, data }) => {
  try {
    const dir = path.dirname(filePath);
    const bakPath = filePath + '.bak';
    const backupPath = path.join(dir, 'runway_timeline_backup_' + Date.now() + '.json');
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, bakPath);
      fs.copyFileSync(filePath, backupPath);
    }
    fs.writeFileSync(filePath, JSON.stringify(data, (k, v) => k === '_isNew' ? undefined : v, 4), 'utf-8');
    return { success: true, backupPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Scan runway pairs from ACL RunwayTimeline sections ─

ipcMain.handle('scan-runway-pairs', async (_event, rootPath, airportIcao) => {
  // Read from airport cache (built during init-airport-cache / refresh-root-scan)
  const cached = airportCache && airportCache[airportIcao];
  return { success: true, pairs: cached?.runwayPairs || [] };
});

// ─── IPC: Compute aircraft positions on approach for StarMap visualization ───

ipcMain.handle('get-aircraft-positions', async (_event, icao, arrivals, saveSec) => {
  try {
    const approachData = airportCache && airportCache[icao]?.approachData;
    if (!approachData) return { success: true, positions: [] };

    const { starPaths, totalApproachTimes, state5ParamsMap, airportScale } = approachData;

    // Compute fallback TAT (median) for STARs that have path data but no State=30 entries
    let fallbackTat = null;
    if (totalApproachTimes && totalApproachTimes.size > 0) {
      const vals = [...totalApproachTimes.values()].sort((a, b) => a - b);
      const mid = Math.floor(vals.length / 2);
      fallbackTat = vals.length % 2 === 0
        ? (vals[mid - 1] + vals[mid]) / 2
        : vals[mid];
    }

    const positions = [];

    for (const ac of arrivals) {
      const { callsign, star, runway, landingSec } = ac;
      if (!star || !runway || landingSec == null) continue;

      // Get the unified path (FlyApproach + AppPointList) from cached starPaths
      const variants = starPaths && starPaths[star];
      if (!variants) continue;
      const variant = variants.find(
        (v) => v.runway && v.runway.toUpperCase() === runway.toUpperCase(),
      );
      if (!variant || !variant.points || variant.points.length < 2) continue;

      // Total approach time for this STAR — use fallback (median) if not in map
      let totalTime =
        (totalApproachTimes && totalApproachTimes.get) // Map
          ? totalApproachTimes.get(star)
          : totalApproachTimes && totalApproachTimes[star];
      if (!totalTime) totalTime = fallbackTat;
      if (!totalTime) continue;

      // Clamp time-to-landing to a minimum of 30s so the user has time
      // to issue landing clearance. Also fixes the bug where aircraft with
      // landingSec === saveSec get PR=1 and are filtered out of the STAR map.
      const ttl = landingSec - saveSec;
      const clampedTTL = Math.max(APPROACH_MIN_TTL, ttl);
      const pr = 1 - clampedTTL / totalTime;
      if (pr <= 0 || pr >= 1) continue; // not mid-approach

      // State5 data for this runway (touchdown position, approach cap)
      const state5 =
        (state5ParamsMap && state5ParamsMap.get)
          ? state5ParamsMap.get(runway)
          : state5ParamsMap && state5ParamsMap[runway];
      let touchDown = state5?.touchDownPosition || null;
      let approachCap = computeApproachCap(airportScale);
      // Fallback: derive touchdown from last segment when state5ParamsMap lacks
      // this runway. Extends the last path point by 50m along the approach heading.
      if (!touchDown && variant.points && variant.points.length >= 2) {
        const last = variant.points[variant.points.length - 1];
        const prev = variant.points[variant.points.length - 2];
        const dx = last.x - prev.x;
        const dz = last.z - prev.z;
        const len = Math.sqrt(dx * dx + dz * dz) || 1;
        touchDown = { x: last.x + (dx / len) * 50, y: 0, z: last.z + (dz / len) * 50 };
      }

      // starPaths points are the unified FlyApproach+AppPointList path.
      // computePosition / computeDirection work with separate flyPoints+appPoints,
      // so we pass the unified path as flyPoints and empty as appPoints.
      // The touchdown point is included in the interpolation path for accurate
      // XZ positioning all the way to the runway threshold.
      const unifiedPath = variant.points;
      const pos = computePosition(
        unifiedPath,
        [],
        pr,
        touchDown,
        approachCap,
      );
      const dir = computeDirection(unifiedPath, [], pr, touchDown);

      // Direction heading for SVG rendering (degrees from +X axis).
      // Game Z-up maps to SVG Y-down, so we negate the Z component.
      const headingDeg = Math.atan2(-dir.z, dir.x) * (180 / Math.PI);

      positions.push({
        callsign,
        x: pos.x,
        y: pos.y,
        z: pos.z,
        dirX: dir.x,
        dirZ: dir.z,
        headingDeg,
        progressRatio: pr,
      });
    }

    // Convert totalApproachTimes Map to plain object for frontend hover computation
    const approachTimesObj = {};
    if (totalApproachTimes) {
      if (totalApproachTimes.forEach) {
        totalApproachTimes.forEach((v, k) => { approachTimesObj[k] = v; });
      } else {
        Object.assign(approachTimesObj, totalApproachTimes);
      }
    }

    return { success: true, positions, totalApproachTimes: approachTimesObj };
  } catch (err) {
    console.error('[IPC] get-aircraft-positions error:', err);
    return { success: false, error: err.message };
  }
});

// ─── IPC: Add flight (gets new flight data back) ─────────

ipcMain.handle('reload-acl', async (_event, filePath) => {
  try {
    const data = loadFlights(filePath);
    return { success: true, path: filePath, ...data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-app-version', () => app.getVersion());

// ─── IPC: Map window launchers ──────────────────────────────

ipcMain.handle('open-ground-map', async (_e, airportIcao, gameRoot) => { openGroundMapWindow(airportIcao, gameRoot); });
ipcMain.handle('open-air-map', async (_e, airportIcao, gameRoot) => { openAirMapWindow(airportIcao, gameRoot); });
ipcMain.handle('close-ground-map', async (_e, airportIcao) => { closeGroundMapWindow(airportIcao); });
ipcMain.handle('close-air-map', async (_e, airportIcao) => { closeAirMapWindow(airportIcao); });
ipcMain.handle('open-flight-strips', async (_e, airportIcao, gameRoot) => { openFlightStripsWindow(airportIcao, gameRoot); });
ipcMain.handle('close-flight-strips', async (_e, airportIcao) => { closeFlightStripsWindow(airportIcao); });

// ─── IPC: Flight strip data (scan ACL for callsign→registration/airport mappings) ──

ipcMain.handle('get-flight-strip-data', async (_e, airportIcao, gameRoot) => {
  const { loadFlights } = require('../src/acl/parser.js');
  const levelsDir = path.join(gameRoot, 'GroundATC_Data', 'StreamingAssets', 'Airports', airportIcao, 'Levels');
  if (!fs.existsSync(levelsDir)) return { success: true, data: {} };

  const files = fs.readdirSync(levelsDir).filter(f => f.endsWith('.acl'));
  const map = {}; // callSign → { registration, airport, isDeparture, airway }

  for (const f of files) {
    try {
      const result = loadFlights(path.join(levelsDir, f));
      if (!result.flights) continue;
      for (const flight of result.flights) {
        if (!flight.CallSign) continue;
        const airport = flight.isDeparture ? (flight.ArrivalAirport || '') : (flight.DepartureAirport || '');
        map[flight.CallSign] = {
          registration: flight._Registration || '',
          airport: airport,
          isDeparture: !!flight.isDeparture,
          airway: flight.Airway || '',
          runway: flight.Runway || '',
        };
      }
    } catch (_) { /* skip unparseable files */ }
  }

  // Assign unique squawk codes (2000–6000) — deterministic via hash + linear probe
  function hashCS(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
    return Math.abs(h);
  }
  const sorted = Object.keys(map).sort();
  const used = new Set();
  for (const cs of sorted) {
    let sq = 2000 + (hashCS(cs) % 4001);
    while (used.has(sq)) sq = 2000 + ((sq - 2000 + 1) % 4001);
    used.add(sq);
    map[cs].squawk = String(sq);
  }

  return { success: true, data: map, runwaySidMap: airportCache?.[airportIcao]?.approachData?.runwaySidMap || {} };
});

// ─── IPC: Aircraft selection sync (linked across ground + air map) ──

ipcMain.handle('select-aircraft-in-map', async (_e, airportIcao, callSign) => {
  if (callSign) {
    selectedCallSigns.set(airportIcao, callSign);
    // Send SelectAircraft UDP command to game
    const buf = Buffer.alloc(12);
    buf.write(callSign, 0, 12, 'ascii');
    sendUdpCommand(1, buf);
  } else {
    selectedCallSigns.delete(airportIcao);
  }
  broadcastSelectedAircraft(airportIcao, callSign || null);
  return { success: true };
});

ipcMain.handle('get-selected-aircraft', async (_e, airportIcao) => {
  return { callSign: selectedCallSigns.get(airportIcao) || null };
});

// ─── IPC: Emergency aircraft sync (EM label → squawk 7700) ──

ipcMain.handle('set-emergency-aircraft', async (_e, airportIcao, callSign) => {
  if (callSign) {
    emergencyCallSigns.set(airportIcao, callSign);
  } else {
    emergencyCallSigns.delete(airportIcao);
  }
  broadcastEmergencyAircraft(airportIcao, callSign || null);
  return { success: true };
});

ipcMain.handle('get-emergency-aircraft', async (_e, airportIcao) => {
  return { callSign: emergencyCallSigns.get(airportIcao) || null };
});

// ─── IPC: UDP telemetry status & state queries ──────────────

ipcMain.handle('get-udp-status', async () => getUdpStatus());
ipcMain.handle('get-udp-aircraft-state', async () => getUdpAircraftState());
ipcMain.handle('reset-udp-aircraft', async () => { resetAircraftState(); return { success: true }; });

// ─── IPC: Send UDP command to game (SelectAircraft, etc.) ───

ipcMain.handle('send-udp-command', async (_e, commandId, payloadB64) => {
  try {
    const buf = Buffer.from(payloadB64, 'base64');
    return await sendUdpCommand(commandId, buf);
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Debug log from renderer → main terminal ───

ipcMain.handle('debug-log', async (_e, args) => {
  console.log('[RENDERER]', ...args);
  return { success: true };
});

app.whenReady().then(() => {
  console.log('[APP] Ready, creating window...');
  console.log('[APP] __dirname:', __dirname);
  console.log('[APP] userData:', app.getPath('userData'));
  createWindow();

  // ── Microphone permission: auto-grant for Flight Strips windows ──────
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    try {
      const url = webContents.getURL();
      if (permission === 'media' && url.includes('window=flightStrips')) {
        callback(true);
      } else {
        callback(false);
      }
    } catch (_) {
      callback(false);
    }
  });

  // Start UDP telemetry listener
  startUdpListener();

  // Push live aircraft state to open map windows at 200ms
  setInterval(() => {
    const state = getUdpAircraftState();

    // Augment each aircraft with a centralized sprite index so all windows
    // show the same witch-mode character for the same callsign.
    if (state && state.aircraft) {
      for (let i = 0; i < state.aircraft.length; i++) {
        const ac = state.aircraft[i];
        if (!witchSpriteMap.has(ac.callSign)) {
          witchSpriteMap.set(ac.callSign, witchSpriteNext % WITCH_SHEET_COUNT);
          witchSpriteNext++;
        }
        state.aircraft[i] = Object.assign({}, ac, { spriteIdx: witchSpriteMap.get(ac.callSign) });
      }
    }

    for (const win of groundMapWindows.values()) {
      if (win && !win.isDestroyed()) win.webContents.send('udp-aircraft-state', state);
    }
    for (const win of airMapWindows.values()) {
      if (win && !win.isDestroyed()) win.webContents.send('udp-aircraft-state', state);
    }
    for (const win of flightStripsWindows.values()) {
      if (win && !win.isDestroyed()) win.webContents.send('udp-aircraft-state', state);
    }
  }, 200);
});

app.on('will-quit', () => {
  stopUdpListener();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    closeLogger();
    app.quit();
  }
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
