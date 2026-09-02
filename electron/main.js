const { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { initLogger, closeLogger } = require('../src/utils/logger');
const bepinex = require('./bepinex');
const updater = require('./updater');

// ── MUST be first: redirect ALL console.* to file (dev only) ──
// Skip file logging in E2E tests so we can see console output
if (!app.isPackaged && !process.env.AC27_E2E_TMP_DIR) initLogger();

const { loadFlights, generateFullAcl, collectUniqueValues, collectRunwayPairs, extractV4RunwayPairs, mergeAudioCallsigns, getFileInfo, exportCSV, exportGameCSV, loadAudioCallsigns, sortFlightsChronologically, _rebuildTimelineSections, scanGameRoot, buildApproachCache, serializeApproachCache, deserializeApproachCache, extractGameTime, extractCurrentDateTime, createZip, listZipFiles, extractZip, _parseWeatherFrames, _parseWindFrames, _parseRunwayTimeline, _extractConfig, _parseStandPositions, _parseAreas, computePosition, computeDirection, computeApproachCap, parseTaxiwayPaths, extractSidRunwayMappings, extractMissedApproachMappings, buildSidPaths, buildMissedApproachPaths } = require('../src/acl/parser');
const { resolveConfigTime } = require('../src/acl/config');
const { APPROACH_MIN_TTL, WARMUP_SEC, DEMO_WINDOW_SEC, DEMO_WINDOW_MIN, DEMO_VISIBLE_BASES, PROD_VISIBLE_BASES, MIDNIGHT_CROSS_START_HOUR, MIDNIGHT_CROSS_THRESHOLD_MIN, MINUTES_PER_DAY, DEFAULT_TAT, CACHE_VERSION } = require('../src/acl/constants');
const { readAclText } = require('../src/acl/gatcarc');
const { start: startUdpListener, stop: stopUdpListener, getUdpStatus, getUdpAircraftState, resetAircraftState, sendCommand: sendUdpCommand } = require('./udp_listener');
const { startServer: startApiServer, stopServer: stopApiServer, handleMcpMessage, MCP_TOOLS } = require('./api-server');
const cloudLLM = require('./cloud-llm');
const { buildPatchPayload } = require('./patchFrame');
const voiceStt = require('./voiceSttWorker');

// Which .acl files feed the airport cache (dropdowns, stand/runway/area geometry,
// approach data) that map windows read via collectValues. Browser-whitelisted
// levels are ALWAYS scanned regardless of the "hidden level" blacklist regex —
// e.g. an endless/scenery level like ZGSZ_Endless.acl (matches `endless`) still
// contributes its geometry so its radar windows aren't blank.
const HIDDEN_LEVEL_RE = /tutorial|bench|test|crossrunway|dev|endless|\.prod/i;
function isCacheAclFile(filename) {
  if (!filename || !filename.endsWith('.acl')) return false;
  if (DEMO_VISIBLE_BASES.has(filename)) return true;
  if (PROD_VISIBLE_BASES.includes(filename)) return true;
  return !HIDDEN_LEVEL_RE.test(filename);
}

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
      const firstAclText = readAclText(aclPaths[0]);
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

/**
 * Compute the airport's ground-painter anchor (the center of the airport's
 * scenery-graph node bounds) from its .acl files. The painter currently derives
 * anchorX/anchorZ from the live (possibly-edited) graph bounds, which shifts
 * whenever the geometry changes — that made a re-imported background image jump
 * around. Instead we compute the DETERMINISTIC airport-level anchor once during
 * the scan (airport geometry is shared across all .acl levels) and persist it to
 * cache.json, so `anchorX`/`anchorZ` are always sourced from the same stable value.
 *
 * @param {string[]} aclPaths — the airport's cache .acl file paths
 * @param {string} logPrefix
 * @returns {{ anchorX: number, anchorZ: number, minX: number, minZ: number, maxX: number, maxZ: number }|null}
 */
function _computeAirportGroundAnchor(aclPaths, logPrefix) {
  try {
    const { buildSceneryGraph } = require('../src/acl/scenery_graph');
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    let nodeCount = 0;
    // Airport ground geometry is shared across all levels, but union the node
    // bounds across cache .acl files so any single malformed file can't skew it.
    for (const p of aclPaths) {
      try {
        const text = readAclText(p);
        const { graph } = buildSceneryGraph(text);
        for (const n of (graph && graph.nodes) || []) {
          if (!isFinite(n.x) || !isFinite(n.z)) continue;
          nodeCount++;
          if (n.x < minX) minX = n.x;
          if (n.x > maxX) maxX = n.x;
          if (n.z < minZ) minZ = n.z;
          if (n.z > maxZ) maxZ = n.z;
        }
      } catch (_) {}
    }
    if (nodeCount === 0 || !isFinite(minX) || !isFinite(maxX) || !isFinite(minZ) || !isFinite(maxZ)) return null;
    const anchorX = (minX + maxX) / 2;
    const anchorZ = (minZ + maxZ) / 2;
    if (logPrefix) console.log(logPrefix + ': ground anchor = (' + anchorX.toFixed(1) + ', ' + anchorZ.toFixed(1) + ') from ' + nodeCount + ' nodes');
    return { anchorX, anchorZ, minX, minZ, maxX, maxZ };
  } catch (e) {
    if (logPrefix) console.log(logPrefix + ': ground anchor computation failed: ' + (e && e.message));
    return null;
  }
}

function _computeAirportAirAnchor(aclPaths, logPrefix) {
  try {
    const { buildSceneryGraph } = require('../src/acl/scenery_graph');
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    let nodeCount = 0;
    for (const p of aclPaths) {
      try {
        const text = readAclText(p);
        const { graph } = buildSceneryGraph(text);
        for (const n of (graph && graph.airwayNodes) || []) {
          if (!isFinite(n.x) || !isFinite(n.z)) continue;
          nodeCount++;
          if (n.x < minX) minX = n.x;
          if (n.x > maxX) maxX = n.x;
          if (n.z < minZ) minZ = n.z;
          if (n.z > maxZ) maxZ = n.z;
        }
      } catch (_) {}
    }
    if (nodeCount === 0 || !isFinite(minX) || !isFinite(maxX) || !isFinite(minZ) || !isFinite(maxZ)) return null;
    const anchorX = (minX + maxX) / 2;
    const anchorZ = (minZ + maxZ) / 2;
    if (logPrefix) console.log(logPrefix + ': air anchor = (' + anchorX.toFixed(1) + ', ' + anchorZ.toFixed(1) + ') from ' + nodeCount + ' airway nodes');
    return { anchorX, anchorZ, minX, minZ, maxX, maxZ };
  } catch (e) {
    if (logPrefix) console.log(logPrefix + ': air anchor computation failed: ' + (e && e.message));
    return null;
  }
}

async function createWindow() {
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 1280,
    minHeight: 640,
    title: 'AC27 Editor',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Capture renderer console to log file (also lands in <userData>/updater.log
  // so modal/update logs are visible for packaged builds with no console)
  mainWindow.webContents.on('console-message', (event, level, message) => {
    updater.log('[RENDERER] ' + message);
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
  const info = getFileInfo(filePath);
  if (info && !info.error) {
    try {
      const isDemo = _isDemoFile(filePath);
      info.isDemo = isDemo;
      info.isEmer = _isEmerFile(filePath);

      if (isDemo) {
        // For demo files: compute the 30-min window (matching get-airport-files-info)
        const text = readAclText(filePath);
        const cdt = extractCurrentDateTime(text);
        if (cdt && cdt.timeString) {
          info.currentDateTime = cdt.timeString;
          const cdtMin = Math.floor(cdt.secSinceMidnight / 60);
          const roundedEndMin = _roundNearest5(cdtMin + DEMO_WINDOW_MIN);
          const eh = Math.floor(roundedEndMin / 60) % 24;
          const em = roundedEndMin % 60;
          info.demoEndTime = String(eh).padStart(2, '0') + ':' + String(em).padStart(2, '0') + ':00';
          info.endTime = info.demoEndTime;
          console.log('[IPC] get-file-info: demo file', path.basename(filePath),
            '— window [' + (info.startTime || 'none') + ' ~ ' + (info.endTime || 'none') + ']');
        } else {
          console.log('[IPC] get-file-info: demo file', path.basename(filePath),
            '— no CDT, using config range [' + (info.startTime || 'none') + ' ~ ' + (info.endTime || 'none') + ']');
        }
      } else {
        // Non-demo: getFileInfo() already returns CDT-corrected startTime via resolveConfigTime
        console.log('[IPC] get-file-info:', path.basename(filePath),
          '— startTime=' + (info.startTime || 'none') + ' endTime=' + (info.endTime || 'none'));
      }
    } catch (e) {
      console.log('[IPC] get-file-info: ERROR for', path.basename(filePath), ':', e.message);
    }
  }
  return info;
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
    info.isEmer = isEmer;
    // getFileInfo() now returns CDT-corrected startTime via resolveConfigTime.
    // For .demo.acl files: override endTime with the 30-min demo window.
    if (isDemo) {
      try {
        const text = readAclText(f.path);
        const cdt = extractCurrentDateTime(text);
        console.log('[IPC] get-airport-files-info: demo file', f.filename,
          '— startTime=' + (info.startTime || 'none'),
          '— extractCurrentDateTime returned', cdt ? ('timeString=' + cdt.timeString) : 'NULL');
        if (cdt && cdt.timeString) {
          info.currentDateTime = cdt.timeString;
          const cdtMin = Math.floor(cdt.secSinceMidnight / 60);
          const roundedEndMin = _roundNearest5(cdtMin + DEMO_WINDOW_MIN);
          const eh = Math.floor(roundedEndMin / 60) % 24;
          const em = roundedEndMin % 60;
          info.demoEndTime = String(eh).padStart(2, '0') + ':' + String(em).padStart(2, '0') + ':00';
          info.endTime = info.demoEndTime;
          console.log('[IPC] get-airport-files-info: demo file', f.filename,
            '— window [' + info.startTime + ' ~ ' + info.demoEndTime + ']');
        } else {
          console.log('[IPC] get-airport-files-info: demo file', f.filename,
            '— no CDT, using config range [' + (info.startTime || 'none') + ' ~ ' + (info.endTime || 'none') + ']');
        }
      } catch (e) { console.log('[IPC] get-airport-files-info: demo file', f.filename, '— ERROR:', e.message); }
    }
    // Non-demo: getFileInfo() already returns CDT-corrected startTime/endTime — no override needed.
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

  // Ordered STAR waypoint names (the patch composer's "Fly Waypoint" picker):
  // { "STAR|runway": [{name, x, z}, ...] } in route order, entry → IAF.
  aclValues._starWaypoints = cached?.approachData?.starWaypoints || {};

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

  // Deterministic ground-painter anchor (center of the airport's ground bounds),
  // computed once during the ACL scan and persisted to cache.json. Used by the
  // Ground Painter's background image so anchorX/anchorZ never drift.
  aclValues._groundAnchor = cached?.groundAnchor || null;
  aclValues._airAnchor = cached?.airAnchor || null;

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

  // Fixes/waypoints for the AirMap Waypoints layer — intentionally NOT runway-filtered
  aclValues._airwayNodes = cached?.approachData?.airwayNodes || [];

  // Taxiway OSM pool (finite reuse set) — for ground painter limit display
  aclValues._taxiwayOsmPool = cached?.taxiwayOsmPool || { nodeIds: [], segIds: [] };

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
 * @param {{ validateRoot?: string }} options
 * @returns {{ data: object|null, valid: boolean, missing: boolean, error?: string, versionMismatch: boolean, rootMismatch: boolean }}
 *   - data: the parsed JSON (always populated if file exists, even when invalid)
 *   - valid: true when cacheVersion matches CACHE_VERSION and root matches (if validateRoot set)
 *   - missing: true when cache.json doesn't exist on disk
 */
function _readCache(options = {}) {
  const cachePath = _cachePath();

  if (!fs.existsSync(cachePath)) {
    return { data: null, valid: false, missing: true, versionMismatch: true, rootMismatch: true };
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
  } catch (e) {
    console.error('[CACHE] _readCache parse error:', e.message);
    return { data: null, valid: false, missing: false, error: e.message, versionMismatch: true, rootMismatch: true };
  }

  const cachedVersion = raw.cacheVersion || 0;
  const versionMismatch = cachedVersion !== CACHE_VERSION;
  const rootMismatch = options.validateRoot ? raw.gameRoot !== options.validateRoot : false;
  const valid = !versionMismatch && !rootMismatch;

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

/**
 * Collect runway pairs for an airport.
 *
 * Derive pairs from the static SceneryData runway objects (each physical
 * runway "4L/22R" yields 4L|22R and 22R|4L). Timeline-change scanning is NOT
 * used — airports that never had runway changes defined (KJFK, KDCA)
 * have empty RunwayTimeline sections, which previously left _runwayPairs empty
 * and hid the runway change editor entirely.
 *
 * @param {string[]} aclPaths — filtered .acl paths (non-hidden levels)
 * @returns {Array<{source: string, dest: string}>} sorted runway pairs
 */
function _collectAirportRunwayPairs(aclPaths) {
  if (!aclPaths || aclPaths.length === 0) return [];
  try {
    const firstText = readAclText(aclPaths[0]);
    return extractV4RunwayPairs(firstText);
  } catch (e) {
    console.log('[CACHE] runway pair scan warning (' + (aclPaths[0] || '') + '):', e.message);
  }
  return collectRunwayPairs(aclPaths);
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
          totalAclFiles += fs.readdirSync(ld).filter(f => isCacheAclFile(f)).length;
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
          if (le.isFile() && le.name.endsWith('.acl') && isCacheAclFile(le.name)) {
            aclPaths.push(path.join(levelsDir, le.name));
          }
        }
      } catch (_) {}
      dropdownValues = aclPaths.length > 0 ? collectUniqueValues(aclPaths) : {};
      runwayPairs = _collectAirportRunwayPairs(aclPaths);
      console.log('[INIT-CACHE]   ' + icao + ': dropdowns scanned from ' + aclPaths.length + ' .acl files, runway pairs: ' + runwayPairs.length);
    }

    // Parse stand positions from first .acl file (airport-level, shared across all levels)
    let standPositions = cachedEntry?.standPositions || null;
    if (!standPositions) {
      try {
        const aclFiles = [];
        for (const le of fs.readdirSync(levelsDir, { withFileTypes: true })) {
          if (le.isFile() && le.name.endsWith('.acl') && isCacheAclFile(le.name)) aclFiles.push(path.join(levelsDir, le.name));
        }
        if (aclFiles.length > 0) {
          const firstAclText = readAclText(aclFiles[0]);
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
        if (le.isFile() && le.name.endsWith('.acl') && isCacheAclFile(le.name)) aclAreaFiles.push(path.join(levelsDir, le.name));
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
          const aclFiles = fs.readdirSync(levelsDir).filter(f => isCacheAclFile(f));
          if (aclFiles.length > 0) {
            const firstText = readAclText(path.join(levelsDir, aclFiles[0]));
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
      }, isCacheAclFile);
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

    // ── Taxiway OSM pool (finite reuse set) ──────────────────────────
    // Union across all level ACLs for this airport — the game's fixed set
    // of taxiway-node/-segment OsmIds. No new taxiway may be created beyond
    // this pool; new entries reuse a freed OsmId at save time.
    let taxiwayOsmPool = cachedEntry?.taxiwayOsmPool || null;
    if (!taxiwayOsmPool) {
      const poolNodeSet = new Set();
      const poolSegSet = new Set();
      try {
        const aclPoolFiles = [];
        for (const le of fs.readdirSync(levelsDir, { withFileTypes: true })) {
          if (le.isFile() && le.name.endsWith('.acl') && isCacheAclFile(le.name)) aclPoolFiles.push(path.join(levelsDir, le.name));
        }
        const { extractTaxiwayOsmPool } = require('../src/acl/scenery_write');
        for (const p of aclPoolFiles) {
          try {
            const t = readAclText(p);
            const pool = extractTaxiwayOsmPool(t);
            for (const id of pool.nodeIds) poolNodeSet.add(id);
            for (const id of pool.segIds) poolSegSet.add(id);
          } catch (_) {}
        }
      } catch (_) {}
      taxiwayOsmPool = { nodeIds: [...poolNodeSet].sort((a, b) => a - b), segIds: [...poolSegSet].sort((a, b) => a - b) };
      console.log('[INIT-CACHE]   ' + icao + ': taxiway pool nodes=' + taxiwayOsmPool.nodeIds.length + ' segs=' + taxiwayOsmPool.segIds.length);
    } else {
      console.log('[INIT-CACHE]   ' + icao + ': taxiway pool from disk cache nodes=' + taxiwayOsmPool.nodeIds.length + ' segs=' + taxiwayOsmPool.segIds.length);
    }

    // ── Ground-painter anchor (deterministic, per airport) ────────────
    // Background-image anchorX/anchorZ are NOT dynamic — we persist the airport's
    // ground-bounds center here and always use it, so re-importing an image never
    // drifts to a recomputed center. Reuse from disk cache if present.
    let groundAnchor = cachedEntry?.groundAnchor || null;
    if (!groundAnchor) {
      const anchorAclFiles = [];
      for (const le of fs.readdirSync(levelsDir, { withFileTypes: true })) {
        if (le.isFile() && le.name.endsWith('.acl') && isCacheAclFile(le.name)) anchorAclFiles.push(path.join(levelsDir, le.name));
      }
      groundAnchor = _computeAirportGroundAnchor(anchorAclFiles, '[INIT-CACHE]   ' + icao);
    } else if (groundAnchor && groundAnchor.anchorX != null) {
      console.log('[INIT-CACHE]   ' + icao + ': ground anchor from disk cache (' + groundAnchor.anchorX.toFixed(1) + ', ' + groundAnchor.anchorZ.toFixed(1) + ')');
    }

    // ── Air-painter anchor (deterministic, per airport) — for Fit in air mode ──
    // Cached to cache.json so air Fit (⌖ in air mode) can show all airways (far outside
    // ground bounds) without rescanning ACLs. Computed as the union of airwayNode bounds
    // across the airport's level ACLs, mirroring the ground anchor logic.
    let airAnchor = cachedEntry?.airAnchor || null;
    if (!airAnchor) {
      const anchorAclFilesAir = [];
      for (const le of fs.readdirSync(levelsDir, { withFileTypes: true })) {
        if (le.isFile() && le.name.endsWith('.acl') && isCacheAclFile(le.name)) anchorAclFilesAir.push(path.join(levelsDir, le.name));
      }
      airAnchor = _computeAirportAirAnchor(anchorAclFilesAir, '[INIT-CACHE]   ' + icao);
    } else if (airAnchor && airAnchor.anchorX != null) {
      console.log('[INIT-CACHE]   ' + icao + ': air anchor from disk cache (' + airAnchor.anchorX.toFixed(1) + ', ' + airAnchor.anchorZ.toFixed(1) + ')');
    }

    cache[icao] = { audioCallsigns, approachData, dropdownValues, runwayPairs, standPositions, areaData, taxiwayOsmPool, groundAnchor, airAnchor };
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
          taxiwayOsmPool: entry.taxiwayOsmPool || { nodeIds: [], segIds: [] },
          groundAnchor: entry.groundAnchor || null,
          airAnchor: entry.airAnchor || null,
        };
      }
      const payload = {
        cacheVersion: CACHE_VERSION,
        gameRoot: rootPath,
        lang: cr.data?.lang ?? null,
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
          try { totalAclFilesR += fs.readdirSync(ld).filter(f => isCacheAclFile(f)).length; } catch (_) {}
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
          if (le.isFile() && le.name.endsWith('.acl') && isCacheAclFile(le.name)) {
            aclPaths.push(path.join(levelsDir, le.name));
          }
        }
      } catch (_) {}
      const dropdownValues = aclPaths.length > 0 ? collectUniqueValues(aclPaths) : {};
      const runwayPairs = _collectAirportRunwayPairs(aclPaths);

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
      }, isCacheAclFile);
      // Parse stand positions from first .acl file
      let standPositions = {};
      try {
        if (aclPaths.length > 0) {
          const firstAclText = readAclText(aclPaths[0]);
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

      // ── Taxiway OSM pool (union across all level files) ─────────────
      const poolNodeSetR = new Set();
      const poolSegSetR = new Set();
      try {
        const { extractTaxiwayOsmPool } = require('../src/acl/scenery_write');
        for (const p of aclPaths) {
          try {
            const t = readAclText(p);
            const pool = extractTaxiwayOsmPool(t);
            for (const id of pool.nodeIds) poolNodeSetR.add(id);
            for (const id of pool.segIds) poolSegSetR.add(id);
          } catch (_) {}
        }
      } catch (_) {}
      const taxiwayOsmPool = { nodeIds: [...poolNodeSetR].sort((a, b) => a - b), segIds: [...poolSegSetR].sort((a, b) => a - b) };

      // ── Ground-painter anchor (deterministic, per airport) ──────────
      const anchorAclFiles = [];
      for (const le of fs.readdirSync(levelsDir, { withFileTypes: true })) {
        if (le.isFile() && le.name.endsWith('.acl') && isCacheAclFile(le.name)) anchorAclFiles.push(path.join(levelsDir, le.name));
      }
      const groundAnchor = _computeAirportGroundAnchor(anchorAclFiles, '[IPC] refresh-root-scan ' + icao);
      const airAnchor = _computeAirportAirAnchor(anchorAclFiles, '[IPC] refresh-root-scan ' + icao);

      cache[icao] = { audioCallsigns, approachData, dropdownValues, runwayPairs, standPositions, areaData, taxiwayOsmPool, groundAnchor, airAnchor };
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
        taxiwayOsmPool: entry.taxiwayOsmPool || { nodeIds: [], segIds: [] },
        groundAnchor: entry.groundAnchor || null,
        airAnchor: entry.airAnchor || null,
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
 * Rounds minutes to the nearest 5-minute boundary (:X0 or :X5).
 * Used by the demo 30-min window to produce tidy end times.
 * @param {number} minutes
 * @returns {number}
 */
function _roundNearest5(minutes) {
  return Math.round(minutes / 5) * 5;
}

/**
 * For demo files (as determined by _isDemoFile): filter flights to the
 * MetaData.Config startTime/endTime window — v4 demo levels already have
 * their intended window set in Config.
 * Uses integer minutes (Math.floor) so flights at the boundary minute are
 * kept, and strict upper bound (<) so flights exactly at endTime are excluded.
 * @param {string} filePath
 * @param {Array} flights
 * @param {object|null} config
 * @returns {{ flights: Array, config: object|null, _currentDateTime: string|null, removedCount: number }}
 */
function _filterDemoFlights(filePath, flights, config) {
  try {
    const rawText = readAclText(filePath);

    const toMin = t => {
      const p = String(t).split(':');
      return parseInt(p[0]) * 60 + parseInt(p[1]);
    };

    if (config && config.startTime && config.endTime) {
      const startMin = toMin(config.startTime);
      const endMin = toMin(config.endTime);
      const before = flights.length;
      flights = flights.filter(fl => {
        const lt = (fl.LandingTime || '').trim();
        const ob = (fl.OffBlockTime || '').trim();
        const flightMin = lt ? toMin(lt) : (ob ? toMin(ob) : Infinity);
        return flightMin >= startMin && flightMin < endMin;
      });
      const removedCount = before - flights.length;
      if (removedCount > 0) {
        console.log('[DEMO] removed ' + removedCount + ' flights outside [' + config.startTime + ' ~ ' + config.endTime + ']');
      }
      console.log('[DEMO] window [' + config.startTime + ' ~ ' + config.endTime + '] (from MetaData.Config)');
      return { flights, config, _currentDateTime: config.startTime, removedCount };
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
    console.log('[IPC] load-acl OK: flights=' + data.flights.length);

    // Extract config from ACL (single source: resolveConfigTime applies CDT override)
    let config = data._rawText ? resolveConfigTime(data._rawText) : null;
    console.log('[IPC] load-acl: config from ACL ->', config ? ('startTime=' + config.startTime + ' endTime=' + config.endTime) : 'NULL');

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

    // Extract saveTime: prefer GameTime.CurrentDateTime, fall back to
    // config.startTime + warmup so _saveSec is never null when config exists
    let _saveSec = null;
    try {
      const rawText = readAclText(filePath);
      _saveSec = extractGameTime(rawText);
      if (_saveSec !== null) {
        console.log('[IPC] load-acl: saveTime=' + _saveSec + 's from GameTime.CurrentDateTime');
      }
    } catch (_) {}
    // Final fallback: compute from config.startTime + 13min warmup
    if (_saveSec == null && config && config.startTime) {
      const p = String(config.startTime).split(':');
      _saveSec = parseInt(p[0]) * 3600 + parseInt(p[1]) * 60 + (parseInt(p[2]) || 0) + WARMUP_SEC;
      console.log('[IPC] load-acl: saveTime=' + _saveSec + 's from config.startTime + warmup (final fallback)');
    }

    return { success: true, path: filePath, config, _saveSec, _currentDateTime, isDemo, ...data };
  } catch (err) {
    console.error('[IPC] load-acl FAIL:', filePath, '|', err.message, '|', err.stack);
    return { success: false, error: err.message };
  }
});

// ─── IPC: Save .acl with optional .bak overwrite backup ────

ipcMain.handle('save-acl', async (_event, { filePath, flights, before, after, arrayContent, originalBlocks, sceneryMaps, createBackup, weatherTimeline, windTimeline, runwayTimeline, _saveSec }) => {
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
      const text = readAclText(filePath);
      config = resolveConfigTime(text);
      if (config) {
        aclcfgStartTime = config.startTime || null;
        aclcfgEndTime = config.endTime || null;
      }
      // For .demo.acl files (including _emerg): override endTime with 30-min demo window.
      // startTime is already CDT-overridden by resolveConfigTime above.
      const cdt = extractCurrentDateTime(text);
      if (isDemoSave && cdt && cdt.timeString) {
        const cdtMin = Math.floor(cdt.secSinceMidnight / 60);
        const roundedEndMin = _roundNearest5(cdtMin + DEMO_WINDOW_MIN);
        const eh = Math.floor(roundedEndMin / 60) % 24;
        const em = roundedEndMin % 60;
        aclcfgEndTime = String(eh).padStart(2, '0') + ':' + String(em).padStart(2, '0') + ':00';
        console.log('[IPC] save-acl: demo — aclcfgStartTime=' + aclcfgStartTime + ' aclcfgEndTime=' + aclcfgEndTime);
      }
    } catch (_) {}

    // Extract ICAO for approach cache lookup
    const icaoMatch = filePath.match(/[\\/]Airports[\\/]([^\\/]+)[\\/]Levels[\\/]/i);
    const icao = icaoMatch ? icaoMatch[1] : '';
    const approachCache = (icao && airportCache && airportCache[icao]) ? airportCache[icao].approachData : null;

    // Generate full ACL from scratch, preserving header structure
    generateFullAcl(filePath, saveFlights, before, after, originalBlocks, sceneryMaps, approachCache, aclcfgStartTime, _saveSec);

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
    // Log the full error (a [TYPE-ASSERT] message carries the offending canonical
    // type name + the whole scope declaration dump on later lines) to the
    // main-process log so the missing type/scope is diagnosable from the save log.
    console.error('[IPC] save-acl FAILED: ' + (err && err.stack ? err.stack : err));
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
    const text = readAclText(aclPath);
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

    // 6b) Extract config (single source: resolveConfigTime applies CDT override)
    let config = data._rawText ? resolveConfigTime(data._rawText) : null;

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

    // 8) Extract saveTime (same as load-acl handler)
    let _saveSec = null;
    try {
      const rawText = readAclText(newAclPath);
      _saveSec = extractGameTime(rawText);
      if (_saveSec !== null) {
        console.log('[IPC] import-zip: saveTime=' + _saveSec + 's from GameTime.CurrentDateTime');
      }
    } catch (_) {}
    if (_saveSec == null && config && config.startTime) {
      const p2 = String(config.startTime).split(':');
      _saveSec = parseInt(p2[0]) * 3600 + parseInt(p2[1]) * 60 + (parseInt(p2[2]) || 0) + WARMUP_SEC;
      console.log('[IPC] import-zip: saveTime=' + _saveSec + 's from config.startTime + warmup (final fallback)');
    }

    return { canceled: false, path: newAclPath, config, _saveSec, _currentDateTime, isDemo, ...data };
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

    // 2) Read config from restored ACL (single source: resolveConfigTime applies CDT override)
    let config = null;
    try {
      config = resolveConfigTime(readAclText(filePath));
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

    let _saveSec = null;
    try {
      const rawText = readAclText(filePath);
      _saveSec = extractGameTime(rawText);
    } catch (_) {}
    if (_saveSec == null && config && config.startTime) {
      const p = String(config.startTime).split(':');
      _saveSec = parseInt(p[0]) * 3600 + parseInt(p[1]) * 60 + (parseInt(p[2]) || 0) + WARMUP_SEC;
    }

    return { success: true, path: filePath, restored, config, _saveSec, _currentDateTime, isDemo, ...data };
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

// ─── Ground Painter IPC ───────────────────────────────────────────
ipcMain.handle('load-ground-painter-data', async (_event, filePath) => {
  // Re-read latest disk state (post-save if the entry warning chose Save).
  const text = readAclText(filePath);
  // Build the id-free Graph + meta here (main is CJS and can require the acl
  // module); the renderer cannot reliably dynamic-import the CJS acl module.
  const { buildSceneryGraph } = require('../src/acl/scenery_graph');
  const { graph, meta } = buildSceneryGraph(text);
  // Derive taxiway OSM pool from the original snapshot (finite reuse set).
  const { extractTaxiwayOsmPool, getTaxiwayOsmPoolInfo, extractAirwayOsmPool, getAirwayOsmPoolInfo } = require('../src/acl/scenery_write');
  const pool = extractTaxiwayOsmPool(text);
  const airwayPool = extractAirwayOsmPool(text);
  // Also compute current free counts from snapshot (no edits yet → all free = pool \ survivors)
  // At load time survivors == pool, so free == 0; after deletions free >0.
  const poolInfo = getTaxiwayOsmPoolInfo(
    (() => {
      const { _splitArrayEntries, _staticEntitiesRanges } = require('../src/acl/scenery_write');
      const ranges = _staticEntitiesRanges(text);
      const pkArrayValue = text.substring(ranges.pkRc.start, ranges.pkRc.end);
      return _splitArrayEntries(pkArrayValue);
    })(),
    graph, meta
  );
  const airwayPoolInfo = getAirwayOsmPoolInfo(
    (() => {
      const { _splitArrayEntries, _staticEntitiesRanges } = require('../src/acl/scenery_write');
      const ranges = _staticEntitiesRanges(text);
      const pkArrayValue = text.substring(ranges.pkRc.start, ranges.pkRc.end);
      return _splitArrayEntries(pkArrayValue);
    })(),
    graph, meta
  );
  return { text, graph, meta, pool, poolInfo: { nodePoolSize: poolInfo.nodePoolSize, segPoolSize: poolInfo.segPoolSize, freeNodeCount: poolInfo.freeNodeCount, freeSegCount: poolInfo.freeSegCount }, airwayPool, airwayPoolInfo: { nodePoolSize: airwayPoolInfo.nodePoolSize, segPoolSize: airwayPoolInfo.segPoolSize, freeNodeCount: airwayPoolInfo.freeNodeCount, freeSegCount: airwayPoolInfo.freeSegCount }, bg: readBgSidecar(filePath) };
});

// Background-image sidecar (<file>.bg.json) — persists the imported reference
// image + its placement so the same level reopens with identical position/scale.
function bgSidecarPath(filePath) { return filePath + '.bg.json'; }
function readBgSidecar(filePath) {
  try {
    if (!filePath || !fs.existsSync(bgSidecarPath(filePath))) return null;
    const raw = fs.readFileSync(bgSidecarPath(filePath), 'utf8');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return (parsed && parsed.src) ? parsed : null;
  } catch (e) {
    console.error('[GroundPainter] read bg sidecar failed: ' + (e && e.message));
    return null;
  }
}

ipcMain.handle('save-ground-painter-data', async (_event, { filePath, snapshotText, graph, meta, createBackup, bg }) => {
  console.log('[GroundPainter] save-ground-painter-data filePath=' + filePath);
  // Cross-level contamination guard: snapshot ArchiveGuid must match target file.
  try {
    const guidMatch = snapshotText.match(/"ArchiveGuid"\s*:\s*"([^"]+)"/);
    const snapGuid = guidMatch ? guidMatch[1] : null;
    const baseName = filePath ? path.basename(filePath, '.acl') : null;
    if (snapGuid && baseName && snapGuid !== baseName) {
      throw new Error('GroundPainter refusal: snapshot ArchiveGuid "' + snapGuid + '" does not match target file "' + baseName + '.acl" — likely cross-level graph contamination. Please close and reopen the Ground Painter.');
    }
  } catch (e) {
    // Only abort on the specific contamination error; other parse errors fall through
    if (e.message && e.message.includes('GroundPainter refusal')) throw e;
  }
  const { patchSceneryBlob, _validateNoDegenerateEdges } = require('../src/acl/scenery_write');
  const { writeAcl } = require('../src/acl/gatcarc');
  // Non-fatal problems found while patching (e.g. an entity whose node refs no
  // longer resolve and was dropped) — reported back so the UI can surface them
  // instead of silently losing geometry.
  const warnings = [];
  let newText = patchSceneryBlob(snapshotText, graph, null, meta, { warnings });
  // Integrity guard (see _validateNoDegenerateEdges): refuse to write an .acl the
  // game's taxiway graph will reject (duplicate taxiway keys / self-loop edges,
  // e.g. "edge id=-10 has the same vertex index for both endpoints"). Refusing
  // keeps the editor's saved file loadable instead of silently corrupting it.
  const integrityIssues = _validateNoDegenerateEdges(newText);
  if (integrityIssues.length > 0) {
    throw new Error('保存被拒绝：编辑后的滑行道会生成损坏的图结构（' + integrityIssues.join('；') + '）。请撤销最近的曲线/拖拽操作后重试。');
  }
  // Corrupt-type auto-repair: patchSceneryBlob already repairs bare "$type": 0
  // inside PK/NonPK entries (see _repairPkEntryTypes / _repairNpkEntryTypes).
  // If any somehow remain (e.g. in an outer envelope), repair in-place so the
  // save succeeds instead of throwing.
  if (/"\$type":\s*0(?=[,\}\]])/.test(newText)) {
    console.warn('[GroundPainter] remaining "$type": 0 detected post-patch — repairing in place');
    newText = newText.replace(/"\$type":\s*0(?=[,\}\]])/g, '"$type": "99|Repaired.Fallback, GroundATC.Core"');
  }
  if (createBackup && fs.existsSync(filePath)) fs.copyFileSync(filePath, filePath + '.bak');
  writeAcl(filePath, newText, { format: 'auto', originalText: snapshotText });
  console.log('[GroundPainter] save-ground-painter-data: wrote ' + filePath);
  // ── Flight-reference reconciliation (stands/runways deleted or renamed) ──
  // Removing a stand or runway in the Ground Painter strands every flight parked
  // on that stand or assigned to that runway; renaming one leaves flights under
  // the old name. Saved as-is, the .acl carries flight-plan entries referencing
  // scenery the game can no longer resolve. Remap renamed references, purge the
  // flights whose references no longer resolve, and rebuild the flight sections
  // through the regular save pipeline (generateFullAcl) so frames, jetway
  // docking state and EventLog entries that pointed at the purged flights go
  // with them.
  // The truth for "which scenery exists" is the SAVED FILE, not the in-memory
  // graph: the writer's dangling-ref gate may legitimately drop entities the
  // graph still shows, and a purge that trusted the graph would keep flights
  // pointing at scenery that is no longer in the file. A reference is only
  // dangling if it existed in the pre-save snapshot and no longer exists in the
  // saved file (so garbage that predates the edit is left alone, and a
  // re-created stand with the same name keeps its flights).
  let purgedFlights = [];
  let refsRemapped = 0;
  let flightSectionsRebuilt = false;
  try {
    const { buildSceneryGraph } = require('../src/acl/scenery_graph');
    const norm = (v) => String(v || '').trim().replace(/^0+/, '');
    const savedGraph = buildSceneryGraph(readAclText(filePath));
    const curStandNames = new Set();
    for (const st of (savedGraph.graph.stands || [])) {
      for (const nm of [st.identifier, st.name]) { const v = norm(nm); if (v) curStandNames.add(v); }
    }
    const curRunwayEnds = new Set();
    for (const rw of (savedGraph.graph.runways || [])) {
      if (Array.isArray(rw.names)) for (const n of rw.names) { const v = norm(n); if (v) curRunwayEnds.add(v); }
      if (rw.physicalName) for (const n of String(rw.physicalName).split('/')) { const v = norm(n); if (v) curRunwayEnds.add(v); }
    }
    const snap = buildSceneryGraph(snapshotText);
    const snapStandNames = new Set();
    for (const st of (snap.graph.stands || [])) {
      for (const nm of [st.identifier, st.name]) { const v = norm(nm); if (v) snapStandNames.add(v); }
    }
    const snapRunwayEnds = new Set();
    for (const rw of (snap.graph.runways || [])) {
      if (Array.isArray(rw.names)) for (const n of rw.names) { const v = norm(n); if (v) snapRunwayEnds.add(v); }
      if (rw.physicalName) for (const n of String(rw.physicalName).split('/')) { const v = norm(n); if (v) snapRunwayEnds.add(v); }
    }
    // Renamed runway ends: surviving runways pair with their original entries by
    // index (meta arrays are index-parallel — the same pairing the writer uses
    // for physPatchMap). Walk chains safely (a rename cycle resolves to itself).
    const runwayRename = new Map(); // normalized old end → new end (exact)
    if (Array.isArray(meta && meta.runwayOrigInfo) && Array.isArray(meta.runwayOrigPk)) {
      for (let i = 0; i < graph.runways.length && i < meta.runwayOrigInfo.length && i < meta.runwayOrigPk.length; i++) {
        if (meta.runwayOrigPk[i] == null) continue;
        const orig = meta.runwayOrigInfo[i];
        const cur = graph.runways[i];
        if (!orig || !cur || !Array.isArray(orig.names) || !Array.isArray(cur.names)) continue;
        for (let j = 0; j < 2 && j < orig.names.length && j < cur.names.length; j++) {
          const o = norm(orig.names[j]), n = String(cur.names[j] || '').trim();
          if (o && n && o !== norm(n)) runwayRename.set(o, n);
        }
      }
    }
    // A rename target must actually exist in the saved scenery — if the writer
    // dropped that runway, remapping onto it would trade one dangling reference
    // for another; the leg is purged instead.
    for (const [o, n] of [...runwayRename]) {
      if (!curRunwayEnds.has(norm(n))) runwayRename.delete(o);
    }
    // Renamed stands: match by nose position (renames don't move the stand).
    // Only an Identifier change re-keys the stand — flight plans and aircraft
    // reference stands by Identifier (the Name is the display name, see
    // _synthesizeStand), so a display-only rename never touches flights.
    const standRename = new Map(); // normalized old identifier → new identifier (exact)
    const snapStandByNose = new Map();
    for (const st of (snap.graph.stands || [])) {
      const nose = snap.graph.nodes[st.noseIdx];
      if (!nose) continue;
      const key = nose.x.toFixed(4) + ',' + nose.z.toFixed(4);
      if (!snapStandByNose.has(key)) snapStandByNose.set(key, st);
    }
    for (const st of (graph.stands || [])) {
      const nose = (graph.nodes || [])[st.noseIdx];
      if (!nose) continue;
      const key = nose.x.toFixed(4) + ',' + nose.z.toFixed(4);
      const origSt = snapStandByNose.get(key);
      if (!origSt) continue;
      const newIdent = String(st.identifier || '').trim();
      if (origSt.identifier && newIdent && norm(origSt.identifier) !== norm(newIdent)) {
        standRename.set(norm(origSt.identifier), newIdent);
      }
    }
    // Same target-existence guard as runway renames (see above).
    for (const [o, n] of [...standRename]) {
      if (!curStandNames.has(norm(n))) standRename.delete(o);
    }
    const remap = (value, map) => {
      if (!value || !map.size) return value;
      let key = norm(value);
      if (!map.has(key)) return value;
      const seen = new Set([key]);
      let cur = map.get(key);
      while (cur && map.has(norm(cur)) && !seen.has(norm(cur))) { seen.add(norm(cur)); cur = map.get(norm(cur)); }
      return cur != null ? String(cur) : value;
    };
    // The saved file's own flight set is the purge baseline — the scenery patch
    // does not touch flight sections, so the flight entries on disk right now
    // are exactly the pre-save ones.
    const data = loadFlights(filePath);
    const flights = Array.isArray(data.flights) ? data.flights : [];
    for (const f of flights) {
      if (f.Runway) {
        const mapped = remap(f.Runway, runwayRename);
        if (mapped !== f.Runway) { f.Runway = mapped; refsRemapped++; }
      }
      if (f.Stand) {
        const mapped = remap(f.Stand, standRename);
        if (mapped !== f.Stand) { f.Stand = mapped; refsRemapped++; }
      }
    }
    const regKey = (f) => String(f._Registration || f._fpGuid || f.CallSign || '');
    const danglingLegs = new Set();
    for (const f of flights) {
      const standGone = !!f.Stand && !curStandNames.has(norm(f.Stand)) && snapStandNames.has(norm(f.Stand));
      const runwayGone = !!f.Runway && !curRunwayEnds.has(norm(f.Runway)) && snapRunwayEnds.has(norm(f.Runway));
      if (standGone || runwayGone) danglingLegs.add(regKey(f));
    }
    if (danglingLegs.size || refsRemapped > 0) {
      purgedFlights = flights
        .filter((f) => danglingLegs.has(regKey(f)))
        .map((f) => ({
          CallSign: f.CallSign || '', Registration: f._Registration || '',
          Stand: f.Stand || '', Runway: f.Runway || '',
          reason: (f.Stand && !curStandNames.has(norm(f.Stand)) && snapStandNames.has(norm(f.Stand))) ? 'stand removed or renamed away'
            : (f.Runway && !curRunwayEnds.has(norm(f.Runway)) && snapRunwayEnds.has(norm(f.Runway))) ? 'runway removed or renamed away' : 'same aircraft leg removed',
        }));
      const keptFlights = sortFlightsChronologically(flights.filter((f) => !danglingLegs.has(regKey(f))));
      flightSectionsRebuilt = true;
      // Full flight rebuild for the purged/remapped set — same pipeline as the
      // regular Ctrl+S save (rebuilds flight-plan StaticItems, frame runtime
      // entities, jetway docking and EventLog; preserves the scenery blob and
      // weather/wind/runway timeline sections).
      const icaoMatch = filePath.match(/[\\/]Airports[\\/]([^\\/]+)[\\/]Levels[\\/]/i);
      const icao = icaoMatch ? icaoMatch[1] : '';
      const approachCache = (icao && airportCache && airportCache[icao]) ? airportCache[icao].approachData : null;
      generateFullAcl(filePath, keptFlights, null, null, null, null, approachCache, null, null);
      console.log('[GroundPainter] flight purge: ' + purgedFlights.length + ' flight(s) removed, ' + refsRemapped + ' reference(s) remapped');
      // Sync the game-side CSV with the kept flight set (best-effort, mirrors save-acl).
      try {
        const cfg = resolveConfigTime(readAclText(filePath));
        if (cfg && cfg.flightScheduleFile) {
          const csvPath = path.join(path.dirname(filePath), cfg.flightScheduleFile + '.csv');
          if (createBackup && fs.existsSync(csvPath)) fs.copyFileSync(csvPath, csvPath + '.bak');
          exportGameCSV(keptFlights, csvPath);
        }
      } catch (csvErr) {
        console.error('[GroundPainter] CSV sync warning: ' + csvErr.message);
      }
    }
  } catch (purgeErr) {
    // A refused save is safer than a file with dangling flight references.
    throw new Error('Flight reference reconciliation failed: ' + (purgeErr && purgeErr.message ? purgeErr.message : purgeErr));
  }
  // Persist the background-image sidecar so the level reopens with the exact image
  // placement (or remove it when the user cleared the image).
  try {
    if (bg && bg.src) fs.writeFileSync(bgSidecarPath(filePath), JSON.stringify(bg), 'utf8');
    else if (fs.existsSync(bgSidecarPath(filePath))) fs.unlinkSync(bgSidecarPath(filePath));
  } catch (e) {
    console.error('[GroundPainter] write bg sidecar failed: ' + (e && e.message));
  }
  // The game renders the airport ground from geo_data.osm (Config.geoDataFile),
  // not from the ACL's PKStaticEntities. Push the painted taxiway geometry there
  // too so editor-created taxiways show up in-game. Failure here must NOT undo a
  // successful ACL save, so it is logged and returned as a non-fatal field.
  let geoResult = { skipped: true };
  try {
    const { syncGeoDataForLevel } = require('../src/acl/geo_osm');
    geoResult = syncGeoDataForLevel(newText, filePath, { createBackup: false });
    if (!geoResult.ok && geoResult.error) console.error('[GroundPainter] geo_data sync failed: ' + geoResult.error);
    else if (geoResult.ok) console.log('[GroundPainter] geo_data sync: +' + geoResult.addedNodes + ' nodes, +' + geoResult.addedWays + ' ways');
  } catch (e) {
    console.error('[GroundPainter] geo_data sync error: ' + (e && e.message));
  }
  if (warnings.length) console.warn('[GroundPainter] save warnings: ' + warnings.map((w) => (w && w.text) || String(w)).join(' | '));
  // When the flight purge rebuilt the flight sections on disk after the scenery
  // write, newText is stale — return the final on-disk text so the renderer's
  // snapshot reflects it (a stale snapshot would revert the purge next save).
  const finalText = flightSectionsRebuilt ? readAclText(filePath) : newText;
  return { newText: finalText, geoResult, warnings, purgedFlights, refsRemapped };
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

    // Parse timelines directly from ACL (single source of truth: resolveConfigTime applies CDT override)
    const aclText = readAclText(aclPath);
    const config = resolveConfigTime(aclText);
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

// ─── IPC: Send patch command to game (plugin UDP Mechanism B, extended frame 0x00E7) ───
// patch: { type: 'update_heading'|'update_position'|'clear_for_appr'|'altitude'|'update_speed', callSign, dx?, dy?, rate?, kts?, appr?, targetFt? }
// update_heading is HEADING-ONLY (2026-08-03, decoupled): it carries no
// speed — the plugin never touches speed on this frame; the game keeps
// position & speed and only the nose heading is overridden (update_speed is
// the ONE frame that commands speed — see below). Optional rate = smooth-
// turn speed in °/s of GAME time (5th frame field; omitted = instant snap —
// the pre-smoothing behavior; the plugin scales it with the game's speed
// multiplier and freezes it while paused). 'update_position' is a legacy
// alias (its kts field is ignored by the plugin — it deliberately does NOT
// carry rate). kts on a clear_for_appr frame is the approach speed in raw
// knots (omitted = the aircraft's speed is left untouched); appr = named
// approach procedure. rate on a clear_for_appr frame (sent as the keyed
// field rate=N, 2026-08-03) = smooth-turn °/s of game time for the handoff
// turn — the nose rotates onto the approach course instead of snapping;
// omitted = the plugin's standard-rate default (3°/s). 'altitude'
// (2026-08-04) = climb/descend-and-maintain: targetFt in FEET — the
// plugin's conversion is ft = position.y × 100/0.3048 (1 GU = 100 m,
// user-confirmed; 15.24 GU = 5000 ft). Optional rate = ft/min of GAME time
// (UNKEYED field — the altitude parser reads it as ft/min, unlike cfa's
// keyed rate=; omitted = the plugin's 1000 ft/min default). Only Y is
// overridden — X/Z, heading and speed stay the game's. 'update_speed'
// (2026-08-04) = fly-speed override: kts in raw knots (int — the editor
// slider range 180-240; telemetry airSpeedKnot is raw knots too). The plugin
// re-asserts the commanded speed every tick; the aircraft ramps via the
// game's own acceleration fields. No end command — the override persists
// and drops on the tower-frequency handoff or when clear_for_appr
// supersedes it.
// Frame contract: 8 B header + payload NUL-padded to exactly 64 bytes (72 B total).
// The plugin's FixedTick() postfix reads the datagram back from the service's
// receive buffer, so the payload field must be fixed-length + NUL-terminated.
// The parts-building + padding logic lives in electron/patchFrame.js (shared
// with scripts/voice_sim.mjs) — this handler only pads-free serializes.

ipcMain.handle('send-patch-command', async (_e, patch) => {
  try {
    const field = buildPatchPayload(patch);   // pipe-delimited ASCII, NUL-padded to 64 B
    return await sendUdpCommand(0x00E7, field);
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Voice STT (offline vosk worker) ────────────────────────────

// Forward worker events to the window that started the session (request-scoped:
// each strips window has its own voice hook instance, so only the initiating
// webContents receives result/error pushes).
voiceStt.onEvent((evt) => {
  switch (evt.type) {
    case 'started':
      console.log('[VOICE-PTT] active');
      break;
    case 'stopped':
      console.log('[VOICE-PTT] done');
      break;
    case 'result':
      console.log(`[VOICE-PTT] heard: "${evt.text}" (conf ${evt.confidence}) → forwarded`);
      break;
    case 'detected':
      // Mic audio crossed the level threshold — distinguishes "mic heard
      // nothing" (no lines at all) from "heard but couldn't parse".
      console.log('[VOICE-PTT] sound detected');
      break;
    case 'rejected':
      console.log(`[VOICE-PTT] rejected: ${evt.reason || 'low-confidence'} (audio heard, no phrase)`);
      break;
  }
  const sender = voiceStt.getActiveSender();
  if (sender && !sender.isDestroyed()) {
    sender.send('voice-stt-event', evt);
  }
});

ipcMain.handle('voice-stt-status', async () => {
  try {
    return await voiceStt.getStatus();
  } catch (err) {
    return { available: false, error: 'SPAWN_FAILED' };
  }
});

ipcMain.handle('voice-stt-start', async (e, extraWords) => {
  // extraWords = the current airport's waypoint names — the vosk session
  // grammar is extended with them per PTT press (see voice-stt-vosk.js).
  return voiceStt.start(e.sender, Array.isArray(extraWords) ? extraWords : []);
});

ipcMain.handle('voice-stt-stop', async () => {
  voiceStt.stop();
  return { success: true };
});

// ─── IPC: Debug log from renderer → main terminal ───

ipcMain.handle('debug-log', async (_e, args) => {
  console.log('[RENDERER]', ...args);
  return { success: true };
});

// ─── IPC: Cloud LLM ──────────────────────────────────────────

const CONFIG_PATH = path.join(app.getPath('userData'), 'ac27-config.json');

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); }
  catch (_) { return {}; }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  console.log('[Config] Saved to', CONFIG_PATH);
}

ipcMain.handle('get-config', async () => {
  try {
    const config = loadConfig();
    return {
      success: true,
      config: {
        deepseekKey: config.deepseekKey || '',
        geminiKey: config.geminiKey || '',
        claudeKey: config.claudeKey || '',
        codexKey: config.codexKey || '',
        selectedModel: config.selectedModel || '',
      },
      configPath: CONFIG_PATH,
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('save-config', async (_event, updates) => {
  try {
    const config = loadConfig();
    Object.assign(config, updates);
    saveConfig(config);
    return { success: true, configPath: CONFIG_PATH };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// One-shot system info (RAM)
ipcMain.handle('get-system-info', async () => {
  const os = require('os');
  const totalRamGB = Math.round(os.totalmem() / (1024 * 1024 * 1024));
  return { success: true, totalRamGB };
});

ipcMain.handle('cloud-chat', async (_event, { messages }) => {
  try {
    const config = loadConfig();
    if (!config.selectedModel) return { success: false, error: 'No model selected.' };

    let streamedThinking = '';

    const onToolCall = async (toolCall) => {
      if (_event.sender && !_event.sender.isDestroyed()) {
        _event.sender.send('cloud-chat-event', {
          toolCall: { name: toolCall.function.name, args: toolCall.function.arguments },
          thinking: streamedThinking,
        });
      }
      // Reset for next iteration's thinking
      streamedThinking = '';

      const mcpMsg = {
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: {
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        },
      };

      try {
        const mcpResponse = await handleMcpMessage(mcpMsg);
        if (_event.sender && !_event.sender.isDestroyed()) {
          _event.sender.send('cloud-chat-event', {
            toolResult: { name: toolCall.function.name, result: mcpResponse.result || mcpResponse.error },
          });
        }
        return mcpResponse;
      } catch (err) {
        if (_event.sender && !_event.sender.isDestroyed()) {
          _event.sender.send('cloud-chat-event', {
            toolResult: { name: toolCall.function.name, error: err.message },
          });
        }
        return { error: err.message };
      }
    };

    const tools = cloudLLM.mcpToolsToOpenAITools(MCP_TOOLS);
    const onThinking = (text) => {
      if (_event.sender && !_event.sender.isDestroyed()) {
        _event.sender.send('cloud-chat-event', { thinking: text });
      }
    };
    const result = await cloudLLM.chat(messages, tools, onToolCall, config, onThinking);

    if (_event.sender && !_event.sender.isDestroyed()) {
      _event.sender.send('cloud-chat-event', { done: true, full: result.content, thinking: result.thinking || '' });
    }

    return { success: true, content: result.content };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ── Video Background Replacer ────────────────────────────────────────────

/** Resolve the ffmpeg binary path (works in dev and packaged builds). */
function _getFfmpegPath() {
  if (app.isPackaged) {
    // In packaged build, the binary is unpacked into extraResources.
    // ffmpeg-static resolves to a path inside app.asar, and you cannot
    // spawn a native executable from inside an asar archive, so we must
    // use the extraResources copy placed alongside the asar.
    const fname = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    return path.join(process.resourcesPath, fname);
  }
  // In dev, ffmpeg-static resolves directly from node_modules
  return require('ffmpeg-static');
}

// ─── IPC: BepInEx Debug Mode ──────────────────────────────

ipcMain.handle('check-bepinex', async () => {
  const cr = _readCache();
  const gameRoot = cr?.data?.gameRoot;
  if (!gameRoot) return { installed: false, error: 'NO_GAME_ROOT' };
  return bepinex.checkStatus(gameRoot);
});

ipcMain.handle('install-bepinex', async (_event) => {
  const cr = _readCache();
  const gameRoot = cr?.data?.gameRoot;
  if (!gameRoot) return { success: false, error: 'NO_GAME_ROOT' };

  const notify = (data) => {
    if (_event.sender && !_event.sender.isDestroyed()) {
      _event.sender.send('bepinex-install-progress', data);
    }
  };

  try {
    const result = await bepinex.installLatest(gameRoot, notify);
    return result;
  } catch (err) {
    console.error('[BepInEx] install failed:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('uninstall-bepinex', async () => {
  const cr = _readCache();
  const gameRoot = cr?.data?.gameRoot;
  if (!gameRoot) return { success: false, error: 'NO_GAME_ROOT' };

  try {
    const result = bepinex.removeFiles(gameRoot);
    return { success: true, removed: result.removed, errors: result.errors };
  } catch (err) {
    console.error('[BepInEx] uninstall failed:', err.message);
    return { success: false, error: err.message };
  }
});

// Workshop: resolve the DLL that ships with the Workshop item itself.
// The Workshop distribution contains AC27Approach.dll either (a) as a sibling
// alongside AC27EditorWorkshop.exe in the Steam Workshop content folder
// (.../workshop/content/4004140/3793213548/AC27Approach.dll — copied by the
// release workflow), or (b) as an extraResource bundled inside resources/
// (resources/AC27Approach.dll) when built via `node build.js --workshop`
// with the plugin artifact present. Both locations are checked.
//
// <exe-dir> resolution — why this is fragile when the exe is moved:
// - Portable builds (Workshop is portable) set PORTABLE_EXECUTABLE_FILE to the
//   *real* exe location the user double-clicked (e.g. .../3793213548/AC27EditorWorkshop.exe).
//   process.execPath and app.getPath('exe') can point to a temp unpack dir
//   (electron-builder portable unpacks to %TEMP%). We therefore check ALL of
//   them, in preference order: PORTABLE_EXECUTABLE_FILE → app.getPath('exe') →
//   process.execPath. Any of those dirnames + AC27Approach.dll is tried.
// - resources/ is checked first: if the DLL was bundled inside the exe at
//   build time (build.js --workshop embeds it), moving the exe alone still
//   works because the DLL is inside the exe. Without that bundle, moving the
//   exe without its sibling DLL loses the source — we fall back to a manual
//   file picker (download handler returns WORKSHOP_BUNDLED_MISSING → renderer
//   opens load-approach-dll dialog).
function resolveWorkshopBundledDllPath() {
  if (!updater.isWorkshopBuild()) return null;
  const candidates = [];
  try {
    if (typeof process.resourcesPath === 'string') {
      candidates.push(path.join(process.resourcesPath, 'AC27Approach.dll'));
    }
  } catch (_) {}
  // <exe-dir> candidates: the user may have moved/copied the exe. Portable
  // remembers the launch location in PORTABLE_EXECUTABLE_FILE; otherwise
  // process.execPath or app.getPath('exe') is the best guess.
  const exeSet = new Set();
  try { if (process.env.PORTABLE_EXECUTABLE_FILE) exeSet.add(process.env.PORTABLE_EXECUTABLE_FILE); } catch (_) {}
  try {
    if (typeof app !== 'undefined' && app && typeof app.getPath === 'function') {
      const ap = app.getPath('exe');
      if (ap) exeSet.add(ap);
    }
  } catch (_) {}
  try { if (process.execPath) exeSet.add(process.execPath); } catch (_) {}
  for (const exe of exeSet) {
    try { if (exe) candidates.push(path.join(path.dirname(exe), 'AC27Approach.dll')); } catch (_) {}
  }
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch (_) {}
  }
  return null;
}

// Command window / PTT gate: Debug Mode AND the AC27Approach plugin DLL
// deployed under BepInEx/plugins AND (2026-08-15) the deployed DLL matching
// the latest release. The remote DLL object's ETag is the build's MD5
// (single-part upload — verified to equal Get-FileHash), so an outdated
// installed plugin is detected by comparing local MD5 vs the remote ETag.
// A failed remote fetch (offline etc.) degrades to pluginUpToDate:null
// ("unknown") — the renderer treats that as OK, so a working plugin is never
// blocked just because the network is down. Checked once per fly-strip window
// open.
// Workshop variant: the "remote" is NOT R2 — it is the DLL that ships with
// the Workshop item itself (resolveWorkshopBundledDllPath). Comparison is
// local MD5 vs bundled MD5, never a network HEAD. A missing/outdated plugin
// is NOT auto-copied — the UI shows the Install prompt and the Install button
// (download-approach-dll → install-approach-dll) copies from the bundled file
// on user click (manual fallback to file picker if bundled not found / moved
// exe without sibling).
ipcMain.handle('check-command-capability', async () => {
  const cr = _readCache();
  const gameRoot = cr?.data?.gameRoot;
  if (!gameRoot) return { bepInExInstalled: false, pluginInstalled: false, pluginUpToDate: null, error: 'NO_GAME_ROOT' };

  const bepInExInstalled = bepinex.checkStatus(gameRoot).installed;
  let pluginPath = bepinex.approachPluginPath(gameRoot);
  let pluginInstalled = !!pluginPath;

  let pluginUpToDate = null; // null = can't verify → renderer treats as OK
  let pluginVersion = null;   // local MD5 hex
  let pluginRemoteVersion = null; // remote MD5 hex (ETag) or bundled MD5 for Workshop
  if (pluginInstalled) {
    try { pluginVersion = await updater.computeFileMd5(pluginPath); } catch (_) {}
  }

  // Workshop variant: compare against the DLL that ships WITH the Workshop item
  // itself, never the network. The Workshop content folder (Steam) or the
  // bundled extraResource (resources/AC27Approach.dll) is the source of truth,
  // so Steam Workshop handles updates and no R2 HEAD is ever issued.
  if (updater.isWorkshopBuild()) {
    const bundledPath = resolveWorkshopBundledDllPath();
    if (bundledPath) {
      try { pluginRemoteVersion = await updater.computeFileMd5(bundledPath); } catch (_) {}
      console.log('[Capability][Workshop] bundled DLL:', bundledPath, 'md5:', pluginRemoteVersion, 'installed:', pluginVersion || '(missing)');
      if (pluginVersion && pluginRemoteVersion) {
        pluginUpToDate = pluginVersion === pluginRemoteVersion;
      } else if (!pluginInstalled) {
        pluginUpToDate = false; // missing -> Install button will copy from bundled on click
      } else {
        pluginUpToDate = null; // can't compare
      }
    } else {
      console.log('[Capability][Workshop] no bundled DLL found (expected sibling AC27Approach.dll or resources/AC27Approach.dll) — skipping update check');
      // Without a bundled source we cannot verify; keep null so the UI does
      // not nag. If the plugin is missing the Install prompt will still fire
      // and the Install button will fall back to the manual file picker.
      if (!pluginInstalled) pluginUpToDate = false;
    }
  } else {
    try {
      // Short timeout (4s) — this gates UI, a slow/absent network must not
      // stall the window decision for long.
      const remote = await updater.headRemoteExeWithUrl(APPROACH_DLL_DOWNLOAD_URL, 4000);
      pluginRemoteVersion = remote.etag || null;
    } catch (err) {
      console.error('[Capability] remote plugin MD5 check failed:', err.message);
    }
    if (pluginVersion && pluginRemoteVersion) pluginUpToDate = pluginVersion === pluginRemoteVersion;
  }

  return { bepInExInstalled, pluginInstalled, pluginUpToDate, pluginVersion, pluginRemoteVersion };
});

// Pick a DLL and copy it into <gameRoot>/BepInEx/plugins as AC27Approach.dll.
// The canonical destination name keeps the capability check deterministic
// regardless of the source filename. Copying can fail with EPERM while the
// game is running — the plugin DLL is locked by the loaded process.
ipcMain.handle('load-approach-dll', async (_event) => {
  const cr = _readCache();
  const gameRoot = cr?.data?.gameRoot;
  if (!gameRoot) return { success: false, error: 'NO_GAME_ROOT' };

  const parent = _event.sender && !_event.sender.isDestroyed()
    ? BrowserWindow.fromWebContents(_event.sender)
    : mainWindow;
  const result = await dialog.showOpenDialog(parent, {
    title: 'Select AC27Approach.dll',
    filters: [{ name: 'DLL', extensions: ['dll'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };

  return _installApproachDll(result.filePaths[0], gameRoot);
});

// ─── IPC: Livery Install ─────────────────────────────────

ipcMain.handle('select-livery-zip', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Realistic Aircraft Livery ZIP',
    filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  return { canceled: false, filePath: result.filePaths[0] };
});

ipcMain.handle('install-livery', async (_event, zipPath) => {
  const cr = _readCache();
  const gameRoot = cr?.data?.gameRoot;
  if (!gameRoot) return { success: false, error: 'NO_GAME_ROOT' };

  const targetDir = path.join(gameRoot, 'Mods');
  try {
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    extractZip(zipPath, targetDir);
    return { success: true };
  } catch (err) {
    console.error('[Livery] install failed:', err.message);
    return { success: false, error: err.message };
  }
});

// ─── Shared HTTPS download helper ─────────────────────────

// Follows redirects (up to 5), streams to destPath, reports percent progress.
// Rejects with `<errId>_DOWNLOAD_HTTP_<status>` on non-2xx, `<errId>_DOWNLOAD_
// TIMEOUT` on timeout, or the underlying net error. Removes a partial destPath
// on any failure so the caller never sees a corrupt file.
function _downloadToFile(url, destPath, notify, errId = 'DOWNLOAD') {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    let received = 0;
    let total = 0;

    const fail = (err) => {
      file.close();
      try { fs.unlinkSync(destPath); } catch (_) {}
      reject(err);
    };

    const doGet = (target, redirectsLeft) => {
      const req = https.get(target, { timeout: 30000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
          const redirectUrl = new URL(res.headers.location, target).toString();
          res.resume();
          doGet(redirectUrl, redirectsLeft - 1);
          return;
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          fail(new Error(`${errId}_DOWNLOAD_HTTP_${res.statusCode}`));
          return;
        }

        const contentLength = res.headers['content-length'];
        if (contentLength) total = parseInt(contentLength, 10);

        res.on('data', (chunk) => {
          received += chunk.length;
          file.write(chunk);
          if (total > 0) notify(Math.round((received / total) * 100));
        });

        res.on('end', () => {
          file.end();
          resolve();
        });
      });

      req.on('error', fail);
      req.on('timeout', () => {
        req.destroy();
        fail(new Error(`${errId}_DOWNLOAD_TIMEOUT`));
      });
    };

    doGet(url, 5);
  });
}

// Shared copy of a source .dll into <gameRoot>/BepInEx/plugins under the
// canonical AC27Approach.dll name — used by both the manual file dialog and
// the R2 download-install path. EPERM/EBUSY while the game is running (the
// plugin DLL is locked by the loaded process) → GAME_RUNNING.
function _installApproachDll(sourcePath, gameRoot) {
  if (!bepinex.checkStatus(gameRoot).installed) return { success: false, error: 'DEBUG_MODE_OFF' };
  try {
    const pluginsDir = path.join(gameRoot, 'BepInEx', 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.copyFileSync(sourcePath, path.join(pluginsDir, bepinex.PLUGIN_DLL_NAME));
    return { success: true };
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EBUSY') return { success: false, error: 'GAME_RUNNING' };
    console.error('[LoadDll] copy failed:', err.message);
    return { success: false, error: err.message };
  }
}

// ─── IPC: AC27Approach DLL — R2 download + install ────────

const APPROACH_DLL_DOWNLOAD_URL = 'https://ericpzh.rest/ac27approach';
const APPROACH_DLL_DOWNLOAD_NAME = 'AC27Approach.dll';

// Download the plugin DLL from the ericpzh.rest/ac27approach Worker route
// (proxies the public R2 object with a Content-Disposition attachment header)
// into a temp dir — mirror of the livery download. The renderer then calls
// install-approach-dll, falling back to the file dialog on any failure.
// Workshop variant: never hits the network — the DLL ships with the Workshop
// item itself (sibling alongside the exe or resources/AC27Approach.dll). The
// handler returns that bundled path directly so the overlay can install it
// without a download; the install handler's cleanup guards prevent deleting the
// Workshop folder (only ac27-approach- temp dirs are removed).
ipcMain.handle('download-approach-dll', async (_event) => {
  if (updater.isWorkshopBuild()) {
    const bundled = resolveWorkshopBundledDllPath();
    if (bundled && fs.existsSync(bundled)) {
      try {
        if (_event.sender && !_event.sender.isDestroyed()) {
          _event.sender.send('approach-dll-download-progress', { percent: 100 });
        }
      } catch (_) {}
      console.log('[ApproachDll][Workshop] using bundled DLL:', bundled);
      return { success: true, filePath: bundled, bundled: true };
    }
    // Bundled DLL not found — most common when the user moved the exe alone
    // without its sibling AC27Approach.dll and the exe was built before the
    // plugin artifact existed (so no resources/ copy). Workshop never tries
    // R2 — return failure so the renderer falls back to the manual file picker
    // (load-approach-dll dialog), which is the same path normal builds use
    // after a network failure.
    console.log('[ApproachDll][Workshop] no bundled DLL found (moved exe without sibling? expected <exe-dir>/AC27Approach.dll or resources/AC27Approach.dll) — falling back to manual picker');
    return { success: false, error: 'WORKSHOP_BUNDLED_MISSING' };
  }

  const tmpDir = path.join(app.getPath('temp'), 'ac27-approach-' + Date.now());
  const dllPath = path.join(tmpDir, APPROACH_DLL_DOWNLOAD_NAME);

  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const notify = (percent) => {
      if (_event.sender && !_event.sender.isDestroyed()) {
        _event.sender.send('approach-dll-download-progress', { percent });
      }
    };
    await _downloadToFile(APPROACH_DLL_DOWNLOAD_URL, dllPath, notify, 'DL');
    notify(100);
    return { success: true, filePath: dllPath };
  } catch (err) {
    console.error('[ApproachDll] download failed:', err.message);
    try { if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    return { success: false, error: err.message };
  }
});

// Install a downloaded-or-picked plugin DLL into <gameRoot>/BepInEx/plugins
// as AC27Approach.dll. The renderer uses this after a successful R2 download
// (the file dialog path goes through load-approach-dll instead).
ipcMain.handle('install-approach-dll', async (_event, sourcePath) => {
  const cr = _readCache();
  const gameRoot = cr?.data?.gameRoot;
  if (!gameRoot) return { success: false, error: 'NO_GAME_ROOT' };
  if (!sourcePath || !fs.existsSync(sourcePath)) return { success: false, error: 'SOURCE_MISSING' };
  const r = _installApproachDll(sourcePath, gameRoot);
  // Clean up the transient download dir after install.
  try {
    const parent = path.dirname(sourcePath);
    if (parent.includes('ac27-approach-')) fs.rmSync(parent, { recursive: true, force: true });
  } catch (_) {}
  return r;
});

// ─── IPC: Livery Download ───────────────────────────────

const LIVERY_DOWNLOAD_URL = 'https://ericpzh.rest/livery';

ipcMain.handle('download-livery', async (_event) => {
  const tmpDir = path.join(app.getPath('temp'), 'ac27-livery-' + Date.now());
  const zipPath = path.join(tmpDir, 'livery.zip');

  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const notify = (percent) => {
      if (_event.sender && !_event.sender.isDestroyed()) {
        _event.sender.send('livery-download-progress', { percent });
      }
    };
    await _downloadToFile(LIVERY_DOWNLOAD_URL, zipPath, notify, 'LIVERY');
    notify(100);
    return { success: true, filePath: zipPath };
  } catch (err) {
    console.error('[Livery] download failed:', err.message);
    try { if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    return { success: false, error: err.message };
  }
});

// ─── IPC: Auto-Update ─────────────────────────────────

ipcMain.handle('check-for-update', async () => {
  return await updater.checkForUpdate();
});

ipcMain.handle('download-update', async (_event) => {
  const updateDir = path.join(app.getPath('temp'), 'ac27-update-' + Date.now());
  try {
    fs.mkdirSync(updateDir, { recursive: true });
    const newExePath = await updater.downloadUpdate(_event, updateDir);

    // Verify the downloaded file's MD5 matches the remote ETag before installing
    // (the remote ETag was captured during the check-for-update call)
    // We re-HEAD to get the current remote ETag for verification
    let remoteMd5 = null;
    try {
      const remote = await updater.headRemoteExe();
      remoteMd5 = remote.etag;
      const downloadedMd5 = await updater.computeFileMd5(newExePath);
      if (downloadedMd5 !== remoteMd5) {
        throw new Error('UPDATE_MD5_MISMATCH');
      }
    } catch (verifyErr) {
      console.error('[Updater] MD5 verification failed:', verifyErr.message);
      try { if (fs.existsSync(updateDir)) fs.rmSync(updateDir, { recursive: true, force: true }); } catch (_) {}
      return { success: false, error: verifyErr.message };
    }

    return {
      success: true, updateDir, newExePath,
      currentExePath: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,
      remoteMd5,
    };
  } catch (err) {
    console.error('[Updater] download failed:', err.message);
    try { if (fs.existsSync(updateDir)) fs.rmSync(updateDir, { recursive: true, force: true }); } catch (_) {}
    return { success: false, error: err.message };
  }
});

ipcMain.handle('install-update', async (_event, { updateDir, currentExePath, newExePath }) => {
  try {
    updater.installUpdate(updateDir, currentExePath, newExePath);
    return { success: true };
  } catch (err) {
    console.error('[Updater] install failed:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('check-post-update-pending', async () => {
  try { return updater.checkPostUpdatePending(); }
  catch (err) { return { pending: false, error: err.message }; }
});

ipcMain.handle('clear-post-update-pending', async () => {
  try { updater.clearPostUpdatePending(); return { success: true }; }
  catch (err) { return { success: false, error: err.message }; }
});


// ─── IPC: Video Background Replacer ────────────────────────

/** Discover all XXXX.webm/ folders under MainMenuVideos. */
ipcMain.handle('discover-menu-videos', async () => {
  try {
    const cr = _readCache();
    const gameRoot = cr?.data?.gameRoot;
    console.log('[video-replacer] _readCache result — valid:', cr?.valid, 'gameRoot:', gameRoot);
    if (!gameRoot) {
      console.log('[video-replacer] NO_GAME_ROOT — cache missing, invalid, or no gameRoot set');
      return { error: 'NO_GAME_ROOT' };
    }

    const videosDir = path.join(gameRoot, 'GroundATC_Data', 'StreamingAssets', 'MainMenuVideos');
    console.log('[video-replacer] scanning videosDir:', videosDir);
    if (!fs.existsSync(videosDir)) {
      console.log('[video-replacer] videosDir not found');
      return { folders: [] };
    }

    const entries = fs.readdirSync(videosDir, { withFileTypes: true });
    const folders = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (!e.name.endsWith('.webm')) continue;
      if (e.name.endsWith('.webm.bak')) continue;

      const icao = e.name.replace(/\.webm$/, '').toUpperCase();
      const dirPath = path.join(videosDir, e.name);
      const webmFiles = fs.readdirSync(dirPath).filter(f => f.endsWith('.webm'));
      const files = webmFiles.map(f => {
        const st = fs.statSync(path.join(dirPath, f));
        return { name: f, size: st.size };
      });
      const bakPath = dirPath + '.bak';
      folders.push({
        icao,
        dirPath,
        files,
        totalSize: files.reduce((s, f) => s + f.size, 0),
        backupExists: fs.existsSync(bakPath),
      });
    }
    return { folders };
  } catch (err) {
    return { error: err.message };
  }
});

/** Open native file dialog for selecting a video file. */
ipcMain.handle('select-video-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Source Video',
    filters: [{ name: 'Video Files', extensions: ['mp4', 'mov', 'avi', 'mkv', 'flv', 'webm', 'm4v', 'wmv'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  const filePath = result.filePaths[0];
  const st = fs.statSync(filePath);
  return { canceled: false, filePath, fileName: path.basename(filePath), fileSize: st.size };
});

/** Convert source video to VP8 WebM. Streams progress events to renderer. */
ipcMain.handle('convert-video', async (_event, { inputPath, outputPath }) => {
  return new Promise((resolve) => {
    const ffmpeg = _getFfmpegPath();
    const args = [
      '-y', '-i', inputPath,
      '-c:v', 'libvpx', '-b:v', '8M', '-crf', '10',
      '-deadline', 'good', '-cpu-used', '0', '-row-mt', '1',
      '-f', 'webm', outputPath,
    ];
    const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const durationRe = /Duration:\s*(\d{2}):(\d{2}):(\d{2})\.(\d{2})/;
    const progressRe = /time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/;
    let totalSec = null;

    proc.stderr.on('data', (data) => {
      const str = data.toString();
      if (totalSec === null) {
        const dm = str.match(durationRe);
        if (dm) totalSec = parseInt(dm[1], 10) * 3600 + parseInt(dm[2], 10) * 60 + parseInt(dm[3], 10) + parseInt(dm[4], 10) / 100;
      }
      const pm = str.match(progressRe);
      if (pm && totalSec) {
        const cur = parseInt(pm[1], 10) * 3600 + parseInt(pm[2], 10) * 60 + parseInt(pm[3], 10) + parseInt(pm[4], 10) / 100;
        const pct = Math.min(100, Math.round((cur / totalSec) * 100));
        if (_event.sender && !_event.sender.isDestroyed()) {
          _event.sender.send('video-convert-progress', { percent: pct, current: cur, total: totalSec });
        }
      }
    });

    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve({ success: true, outputPath, size: fs.statSync(outputPath).size });
      } else {
        resolve({ success: false, error: `ffmpeg exited with code ${code}` });
      }
    });
    proc.on('error', (err) => resolve({ success: false, error: err.message }));
  });
});

/** Backup each airport's .webm/ folder and replace all files with the converted video. */
ipcMain.handle('replace-menu-videos', async (_event, { convertedVideoPath, airports }) => {
  const results = [];
  for (let i = 0; i < airports.length; i++) {
    const { icao, dirPath, files } = airports[i];
    if (_event.sender && !_event.sender.isDestroyed()) {
      _event.sender.send('video-replace-progress', { icao, step: 'backup', current: i + 1, total: airports.length });
    }

    try {
      const bakPath = dirPath + '.bak';
      // Only back up once — never overwrite an existing .bak so the
      // original videos are always preserved on subsequent replaces.
      if (!fs.existsSync(bakPath)) {
      fs.cpSync(dirPath, bakPath, { recursive: true });
      }

      if (_event.sender && !_event.sender.isDestroyed()) {
        _event.sender.send('video-replace-progress', { icao, step: 'replace', current: i + 1, total: airports.length });
      }

      for (const f of files) {
        const destPath = path.join(dirPath, f.name);
        if (fs.existsSync(destPath)) fs.rmSync(destPath);
        fs.copyFileSync(convertedVideoPath, destPath);
      }
      results.push({ icao, fileCount: files.length });
    } catch (err) {
      return { success: false, error: `Failed at ${icao}: ${err.message}`, completed: results };
    }
  }
  return { success: true, replaced: results };
});

/** Check whether any .webm.bak backup folders exist under MainMenuVideos. */
ipcMain.handle('check-video-backup-exists', async () => {
  try {
    const cr = _readCache();
    const gameRoot = cr?.data?.gameRoot;
    if (!gameRoot) return { success: false, error: 'NO_GAME_ROOT' };

    const videosDir = path.join(gameRoot, 'GroundATC_Data', 'StreamingAssets', 'MainMenuVideos');
    if (!fs.existsSync(videosDir)) return { success: true, exists: false };

    const entries = fs.readdirSync(videosDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (!e.name.endsWith('.webm')) continue;
      if (e.name.endsWith('.webm.bak')) continue;
      if (fs.existsSync(path.join(videosDir, e.name + '.bak'))) {
        return { success: true, exists: true };
      }
    }
    return { success: true, exists: false };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/** Delete all level files and backups under Airports/XXXX/Levels -- for Steam Verify Integrity restore. */
ipcMain.handle('reset-all-levels', async () => {
  try {
    const cr = _readCache();
    const gameRoot = cr?.data?.gameRoot;
    if (!gameRoot) return { success: false, error: 'NO_GAME_ROOT' };

    const airportsDir = path.join(gameRoot, 'GroundATC_Data', 'StreamingAssets', 'Airports');
    if (!fs.existsSync(airportsDir)) return { success: false, error: 'AIRPORTS_DIR_NOT_FOUND' };

    let totalDeleted = 0;
    let airportsProcessed = 0;
    const entries = fs.readdirSync(airportsDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const levelsDir = path.join(airportsDir, e.name, 'Levels');
      if (!fs.existsSync(levelsDir)) continue;
      airportsProcessed++;
      const levelEntries = fs.readdirSync(levelsDir, { withFileTypes: true });
      for (const le of levelEntries) {
        const fullPath = path.join(levelsDir, le.name);
        try {
          if (le.isFile() || le.isSymbolicLink()) {
            fs.rmSync(fullPath, { force: true });
            totalDeleted++;
          } else if (le.isDirectory()) {
            fs.rmSync(fullPath, { recursive: true, force: true });
            totalDeleted++;
          }
        } catch (err) {
          console.error('[reset-all-levels] failed to delete', fullPath, err.message);
        }
      }
    }
    console.log(`[reset-all-levels] deleted ${totalDeleted} entries across ${airportsProcessed} airports`);
    // Also clean up cache.json — it holds stale per-level data (STAR/SID/approach caches,
    // ground anchors, file lists) that is now invalid after all .acl files were removed.
    try {
      const cachePath = _cachePath();
      if (fs.existsSync(cachePath)) {
        fs.rmSync(cachePath, { force: true });
        console.log('[reset-all-levels] removed cache.json');
      }
    } catch (err) {
      console.error('[reset-all-levels] failed to remove cache.json', err.message);
    }
    return { success: true, deletedCount: totalDeleted, airports: airportsProcessed };
  } catch (err) {
    console.error('[reset-all-levels] error', err.message);
    return { success: false, error: err.message };
  }
});

// ─── IPC: Quit the editor (used after the restore-all success prompt) ────────
ipcMain.on('app-quit', () => {
  app.quit();
});

/** Restore all XXXX.webm.bak/ backup folders back to XXXX.webm/. */
ipcMain.handle('restore-video-backup', async () => {
  try {
    const cr = _readCache();
    const gameRoot = cr?.data?.gameRoot;
    if (!gameRoot) return { success: false, error: 'NO_GAME_ROOT' };

    const videosDir = path.join(gameRoot, 'GroundATC_Data', 'StreamingAssets', 'MainMenuVideos');
    if (!fs.existsSync(videosDir)) return { success: true, restored: [] };

    const entries = fs.readdirSync(videosDir, { withFileTypes: true });
    const restored = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (!e.name.endsWith('.webm.bak')) continue;

      const bakDirPath = path.join(videosDir, e.name);
      const origName = e.name.replace(/\.bak$/, '');
      const origDirPath = path.join(videosDir, origName);
      const icao = origName.replace(/\.webm$/, '').toUpperCase();

      // Count files in backup for reporting
      const bakFiles = fs.readdirSync(bakDirPath).filter(f => f.endsWith('.webm'));

      // Remove current folder (if exists) and restore backup
      if (fs.existsSync(origDirPath)) {
        fs.rmSync(origDirPath, { recursive: true, force: true });
      }
      fs.renameSync(bakDirPath, origDirPath);

      restored.push({ icao, fileCount: bakFiles.length });
    }
    return { success: true, restored };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

app.whenReady().then(() => {
  console.log('[APP] Ready, creating window...');
  console.log('[APP] __dirname:', __dirname);
  console.log('[APP] userData:', app.getPath('userData'));
  createWindow();

  // ── Permission handler: deny everything ──────────────────────────────
  // Voice input no longer captures audio in the renderer (the vosk STT
  // worker's sox child owns the mic), so the former 'media' auto-grant for
  // flightStrips windows is gone. Deny-all protects against any future request.
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    try {
      callback(false);
    } catch (_) {
      callback(false);
    }
  });

  // ── Auto-update check: fires on startup, result pushed to renderer ──
  (async () => {
    try {
      updater.log('[Updater] startup check beginning');
      const result = await updater.checkForUpdate();
      updater.log('[Updater] startup check result:', JSON.stringify(result));
      if (mainWindow && !mainWindow.isDestroyed()) {
        updater.log('[Updater] pushing update-check-result to renderer');
        mainWindow.webContents.send('update-check-result', result);
      } else {
        updater.log('[Updater] mainWindow unavailable — result not pushed (renderer fallback will invoke)');
      }
    } catch (err) {
      updater.log('[Updater] startup check error:', err.message);
    }
  })();

  // Start UDP telemetry listener
  startUdpListener();

  // Start HTTP API server — always on port 31415 for MCP / external tool access
  startApiServer(mainWindow, 31415, () => airportCache);

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
  stopApiServer();
  voiceStt.dispose();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    closeLogger();
    app.quit();
  }
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
