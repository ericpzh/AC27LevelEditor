const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { initLogger, closeLogger } = require('../src/utils/logger');

// ── MUST be first: redirect ALL console.* to file (dev only) ──
if (!app.isPackaged) initLogger();

const { loadFlights, generateFullAcl, collectUniqueValues, mergeAudioCallsigns, getFileInfo, exportCSV, exportGameCSV, loadAudioCallsigns, sortFlightsChronologically, _rebuildTimelineSections, scanGameRoot, buildApproachCache, serializeApproachCache, deserializeApproachCache, extractSaveTime, extractGameTime, extractCurrentDateTime, createZip, listZipFiles, extractZip, _parseWeatherFrames, _parseWindFrames, _parseRunwayTimeline, _extractConfig } = require('../src/acl/parser');

let mainWindow;
let cachedScan = null; // cached scan result { airports, totalFiles }
let airportCache = null; // Phase 0 cache: { [ICAO]: { csvValues, audioCallsigns } }

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
    const isDemo = f.filename.endsWith('.demo.acl');
    info.isDemo = isDemo;
    // For .demo.acl files, extract CurrentDateTime for 30-min window display
    if (isDemo) {
      try {
        const text = fs.readFileSync(f.path, 'utf-8');
        const cdt = extractCurrentDateTime(text);
        if (cdt) {
          info.currentDateTime = cdt.timeString;
          // Compute 30-min window end: CurrentDateTime + 30 min
          const ssm = cdt.secSinceMidnight;
          const endSec = ssm + 1800;
          const eh = Math.floor((endSec % 86400) / 3600) % 24;
          const em = Math.floor((endSec % 3600) / 60);
          const es = endSec % 60;
          info.demoEndTime = String(eh).padStart(2, '0') + ':' + String(em).padStart(2, '0') + ':' + String(es).padStart(2, '0');
          // Override startTime/endTime to show the 30-min demo window
          info.startTime = cdt.timeString;
          info.endTime = info.demoEndTime;
        }
      } catch (_) { /* keep config startTime/endTime as fallback */ }
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
  const scan = scanGameRoot(rootPath);
  if (scan.errorCode) return {};
  const airport = scan.airports.find(a => a.icao === airportIcao);
  if (!airport) return {};
  const paths = airport.aclFiles.map(f => f.path);

  // Collect all values from ACL files only (single source of truth)
  const aclValues = collectUniqueValues(paths);

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
  const cacheEntry = airportCache && airportCache[airportIcao];
  const designatorMap = cacheEntry?.approachData?.designatorMap;
  if (designatorMap && designatorMap.size > 0 && aclValues.AircraftType) {
    const knownTypes = new Set(designatorMap.keys());
    aclValues.AircraftType = aclValues.AircraftType.filter(t => knownTypes.has(t));
  }

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

const CACHE_MAX_AGE_MS = 7 * 24 * 3600 * 1000; // 7 days

// ─── IPC: Phase 0 — initialize airport cache (scan all CSV + audio) ──

ipcMain.handle('init-airport-cache', async (_event, rootPath) => {
  console.log('══════════════ [INIT-CACHE] START ══════════════');
  const airportsDir = path.join(rootPath, 'GroundATC_Data', 'StreamingAssets', 'Airports');
  if (!fs.existsSync(airportsDir)) return {};

  // ── Try loading approach data from disk cache ──
  let diskCache = null;
  const cachePath = _approachCachePath();
  try {
    if (fs.existsSync(cachePath)) {
      const raw = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      const age = Date.now() - (raw.builtAt || 0);
      if (raw.gameRoot === rootPath && age < CACHE_MAX_AGE_MS) {
        diskCache = raw.airports || {};
        console.log('[INIT-CACHE] loaded approach cache from disk (' + Object.keys(diskCache).length + ' airports, age=' + (age / 3600000).toFixed(1) + 'h)');
      } else {
        console.log('[INIT-CACHE] disk cache invalid (rootMatch=' + (raw.gameRoot === rootPath) + ' age=' + (age / 3600000).toFixed(1) + 'h), will rebuild');
      }
    }
  } catch (e) {
    console.log('[INIT-CACHE] disk cache read error:', e.message);
  }

  const cache = {};

  for (const icao of fs.readdirSync(airportsDir)) {
    const airportPath = path.join(airportsDir, icao);
    if (!fs.statSync(airportPath).isDirectory()) continue;
    const levelsDir = path.join(airportPath, 'Levels');
    if (!fs.existsSync(levelsDir)) continue;

    // Load audio clips
    const enPath = path.join(levelsDir, 'audio_clips_en.json');
    const zhPath = path.join(levelsDir, 'audio_clips_zh.json');
    const enData = fs.existsSync(enPath) ? loadAudioCallsigns(enPath) : null;
    const zhData = fs.existsSync(zhPath) ? loadAudioCallsigns(zhPath) : null;
    const audioCallsigns = mergeAudioCallsigns(enData, zhData);

    // Pre-scan approach data — from disk cache if available, otherwise scan files
    let approachData = null;
    if (diskCache && diskCache[icao]) {
      approachData = deserializeApproachCache(diskCache[icao]);
      console.log('[INIT-CACHE]   ' + icao + ': from disk cache');
    } else {
      approachData = buildApproachCache(levelsDir);
      console.log('[INIT-CACHE]   ' + icao + ': scanned from files');
    }

    cache[icao] = { audioCallsigns, approachData };
  }

  airportCache = cache;

  // ── Persist to disk for next launch ──
  if (!diskCache) {
    try {
      const serialized = {};
      for (const [icao, entry] of Object.entries(cache)) {
        if (entry.approachData) {
          serialized[icao] = serializeApproachCache(entry.approachData);
        }
      }
      const payload = {
        gameRoot: rootPath,
        builtAt: Date.now(),
        airports: serialized,
      };
      const cfgDir = app.getPath('userData');
      if (!fs.existsSync(cfgDir)) fs.mkdirSync(cfgDir, { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify(payload), 'utf-8');
      console.log('[INIT-CACHE] persisted approach cache to disk (' + Object.keys(serialized).length + ' airports)');
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
    // Delete disk cache to force re-scan
    const cachePath = _approachCachePath();
    if (fs.existsSync(cachePath)) {
      fs.unlinkSync(cachePath);
      console.log('[IPC] refresh-root-scan: deleted disk cache');
    }
    // Re-run init-airport-cache logic (same as the handler above but inline)
    const airportsDir = path.join(rootPath, 'GroundATC_Data', 'StreamingAssets', 'Airports');
    if (!fs.existsSync(airportsDir)) return { success: false, errorCode: 'error_airports_dir_not_found', errorPath: airportsDir };

    const cache = {};
    for (const icao of fs.readdirSync(airportsDir)) {
      const airportPath = path.join(airportsDir, icao);
      if (!fs.statSync(airportPath).isDirectory()) continue;
      const levelsDir = path.join(airportPath, 'Levels');
      if (!fs.existsSync(levelsDir)) continue;

      const enPath = path.join(levelsDir, 'audio_clips_en.json');
      const zhPath = path.join(levelsDir, 'audio_clips_zh.json');
      const enData = fs.existsSync(enPath) ? loadAudioCallsigns(enPath) : null;
      const zhData = fs.existsSync(zhPath) ? loadAudioCallsigns(zhPath) : null;
      const audioCallsigns = mergeAudioCallsigns(enData, zhData);
      const approachData = buildApproachCache(levelsDir);
      cache[icao] = { audioCallsigns, approachData };
    }

    airportCache = cache;

    // Persist new cache
    const serialized = {};
    for (const [icao, entry] of Object.entries(cache)) {
      if (entry.approachData) serialized[icao] = serializeApproachCache(entry.approachData);
    }
    const payload = { gameRoot: rootPath, builtAt: Date.now(), airports: serialized };
    const cfgDir = app.getPath('userData');
    if (!fs.existsSync(cfgDir)) fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(_approachCachePath(), JSON.stringify(payload), 'utf-8');

    console.log('[IPC] refresh-root-scan OK — ' + Object.keys(cache).length + ' airports');
    return { success: true };
  } catch (err) {
    console.error('[IPC] refresh-root-scan FAIL:', err.message);
    return { success: false, error: err.message };
  }
});

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

    const isDemo = filePath.endsWith('.demo.acl');

    // For .demo.acl: extract CurrentDateTime, cap flights to [CDT, CDT+30min] window
    let _currentDateTime = null;
    let removedCount = 0;
    if (isDemo && data.flights && data.flights.length > 0) {
      try {
        const rawText = fs.readFileSync(filePath, 'utf-8');
        const cdt = extractCurrentDateTime(rawText);
        if (cdt && cdt.timeString) {
          _currentDateTime = cdt.timeString;
          const cdtMin = cdt.secSinceMidnight / 60;        // lower bound in minutes
          const cdtMaxMin = cdtMin + 30;                    // upper bound = +30 min
          const toMin = t => { const p = String(t).split(':'); return parseInt(p[0]) * 60 + parseInt(p[1]); };
          const before = data.flights.length;
          // Keep only flights within [CurrentDateTime, CurrentDateTime+30min]
          data.flights = data.flights.filter(fl => {
            const lt = (fl.LandingTime || '').trim();
            const ob = (fl.OffBlockTime || '').trim();
            const flightMin = lt ? toMin(lt) : (ob ? toMin(ob) : Infinity);
            return flightMin >= cdtMin && flightMin <= cdtMaxMin;
          });
          removedCount = before - data.flights.length;
          if (removedCount > 0) {
            console.log('[IPC] load-acl: demo — removed ' + removedCount + ' flights outside [' + cdt.timeString + ', +30min] window');
          }
          // Cap config endTime to the +30min demo upper bound
          const endSec = cdt.secSinceMidnight + 1800;
          const eh = Math.floor((endSec % 86400) / 3600) % 24;
          const em = Math.floor((endSec % 3600) / 60);
          const es = endSec % 60;
          const demoEndTime = String(eh).padStart(2, '0') + ':' + String(em).padStart(2, '0') + ':' + String(es).padStart(2, '0');
          if (config) {
            config.startTime = cdt.timeString;
            config.endTime = demoEndTime;
          } else {
            config = { startTime: cdt.timeString, endTime: demoEndTime };
          }
          console.log('[IPC] load-acl: demo window [' + cdt.timeString + ' ~ ' + demoEndTime + '] (30min cap)');
        }
      } catch (e) {
        console.log('[IPC] load-acl: demo flight filtering failed:', e.message);
      }
    }

    // Compute earliest flight time from loaded data (handles midnight-crossing)
    let earliestTime = null, earliestMin = Infinity;
    if (data.flights) {
      const toMin = t => { const p = String(t).split(':'); return parseInt(p[0]) * 60 + parseInt(p[1]); };
      // If level starts in the evening, treat post-midnight times as next-day
      const startH = config && config.startTime ? parseInt(String(config.startTime).substring(0, 2)) : 0;
      const crossesMidnight = startH >= 18;
      for (const fl of data.flights) {
        for (const field of ['LandingTime', 'OffBlockTime']) {
          const t = fl[field];
          if (!t) continue;
          let tm = toMin(t);
          if (crossesMidnight && tm < 360) tm += 1440; // times before 06:00 are next day
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
      _saveSec = parseInt(p[0]) * 3600 + parseInt(p[1]) * 60 + (parseInt(p[2]) || 0) + 780;
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
    if (createBackup && fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, filePath + '.bak');
    }

    // Read the ACL's Config block for startTime and file references
    let aclcfgStartTime = null;
    let aclcfgEndTime = null;
    let config = null;
    const isDemoSave = filePath.endsWith('.demo.acl');
    try {
      const text = fs.readFileSync(filePath, 'utf-8');
      config = _extractConfig(text);
      if (config) {
        aclcfgStartTime = config.startTime || null;
        aclcfgEndTime = config.endTime || null;
      }
      // Extract CurrentDateTime as snapshot time for correct PR calculation.
      // Applicable to ALL files — the game records the exact save time in CDT.
      // For .demo.acl files, also override startTime/endTime from CDT.
      const cdt = extractCurrentDateTime(text);
      if (cdt && cdt.secSinceMidnight != null) {
        _saveSec = cdt.secSinceMidnight;
        console.log('[IPC] save-acl: CDT=' + cdt.timeString + ' → _saveSec=' + _saveSec + 's');
      }
      if (isDemoSave && cdt && cdt.timeString) {
        aclcfgStartTime = cdt.timeString;
        const endSec = cdt.secSinceMidnight + 1800;
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
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Choose Backup Location',
    defaultPath: path.basename(sourcePath),
    filters: [{ name: 'ACL Files', extensions: ['acl'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };

  try {
    fs.copyFileSync(sourcePath, result.filePath);
    return { canceled: false, path: result.filePath };
  } catch (err) {
    return { canceled: false, error: err.message };
  }
});

// ─── IPC: Import ZIP ────────────────────────────────────

ipcMain.handle('import-zip', async (_event, { aclPath }) => {
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
    if (!hasAcl) missing.push('.acl');
    if (!hasCsv) missing.push('.csv');
    if (!hasWeather) missing.push('weather_timeline.json');
    if (!hasWind) missing.push('wind_timeline.json');
    if (!hasRunway) missing.push('runway_timeline*.json');

    if (missing.length > 0) {
      return { canceled: false, error: `ZIP missing required files: ${missing.join(', ')}` };
    }

    // 3) Validate ZIP .acl filename matches current level (reject airport/level mismatch)
    const currentAclName = path.basename(aclPath);
    const zipAclNames = fileList.filter(f => f.toLowerCase().endsWith('.acl'));
    if (!zipAclNames.includes(currentAclName)) {
      return { canceled: false, error: 'Level mismatch' };
    }

    // 4) Backup current files before overwriting
    const dir = path.dirname(aclPath);
    const entries = getLevelFilePaths(aclPath);
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (fs.existsSync(p)) {
        fs.copyFileSync(p, p + '.bak');
      }
    }

    // 5) Extract ZIP to the target directory (overwrites existing)
    extractZip(zipPath, dir);

    // 6) Reload the ACL to return parsed data
    const aclFile = path.basename(aclPath);
    const newAclPath = path.join(dir, aclFile);
    const data = loadFlights(newAclPath);
    const isDemo = aclFile.endsWith('.demo.acl');

    // 6b) For .demo.acl: extract CurrentDateTime and filter flights before it
    let _currentDateTime = null;
    if (isDemo && data.flights && data.flights.length > 0) {
      try {
        const rawText2 = fs.readFileSync(newAclPath, 'utf-8');
        const cdt = extractCurrentDateTime(rawText2);
        if (cdt && cdt.timeString) {
          _currentDateTime = cdt.timeString;
          const cdtMin = cdt.secSinceMidnight / 60;
          const toMinFilter = t => { const p = String(t).split(':'); return parseInt(p[0]) * 60 + parseInt(p[1]); };
          const before = data.flights.length;
          data.flights = data.flights.filter(fl => {
            const lt = (fl.LandingTime || '').trim();
            const ob = (fl.OffBlockTime || '').trim();
            const flightMin = lt ? toMinFilter(lt) : (ob ? toMinFilter(ob) : Infinity);
            return flightMin >= cdtMin;
          });
          const removed = before - data.flights.length;
          if (removed > 0) console.log('[IPC] import-zip: removed ' + removed + ' flights before CurrentDateTime');
        }
      } catch (_) {}
    }

    // 7) Extract config from ACL's Config block (single source of truth)
    let config = null;
    if (data._rawText) {
      config = _extractConfig(data._rawText);
    }

    // 8) Compute earliest flight time (same as load-acl handler)
    let earliestTime = null, earliestMin = Infinity;
    if (data.flights) {
      const toMin = t => { const p = String(t).split(':'); return parseInt(p[0]) * 60 + parseInt(p[1]); };
      const startH = config && config.startTime ? parseInt(String(config.startTime).substring(0, 2)) : 0;
      const crossesMidnight = startH >= 18;
      for (const fl of data.flights) {
        for (const field of ['LandingTime', 'OffBlockTime']) {
          const t = fl[field];
          if (!t) continue;
          let tm = toMin(t);
          if (crossesMidnight && tm < 360) tm += 1440;
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
      _saveSec = parseInt(p2[0]) * 3600 + parseInt(p2[1]) * 60 + (parseInt(p2[2]) || 0) + 780;
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
      return { success: false, error: 'No .acl.bak backup file found' };
    }
    fs.copyFileSync(aclBak, filePath);
    restored.push('ACL');

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
        restored.push('CSV');
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

    // 6) Compute earliest flight time + saveTime (same as load-acl handler)
    let earliestTime = null, earliestMin = Infinity;
    if (data.flights) {
      const toMin = t => { const p = String(t).split(':'); return parseInt(p[0]) * 60 + parseInt(p[1]); };
      const startH = config && config.startTime ? parseInt(String(config.startTime).substring(0, 2)) : 0;
      const crossesMidnight = startH >= 18;
      for (const fl of data.flights) {
        for (const field of ['LandingTime', 'OffBlockTime']) {
          const t = fl[field];
          if (!t) continue;
          let tm = toMin(t);
          if (crossesMidnight && tm < 360) tm += 1440;
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
      _saveSec = parseInt(p[0]) * 3600 + parseInt(p[1]) * 60 + (parseInt(p[2]) || 0) + 780;
    }

    return { success: true, path: filePath, restored, config, earliestTime, _saveSec, ...data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Export CSV ─────────────────────────────────────

ipcMain.handle('export-csv', async (_event, { flights, defaultPath }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export CSV',
    defaultPath: defaultPath || 'flights.csv',
    filters: [{ name: 'CSV Files', extensions: ['csv'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: false };

  try {
    exportCSV(flights, result.filePath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});


// ─── IPC: Get last game root path ────────────────────────

ipcMain.handle('get-last-root', () => {
  try {
    const cfgPath = path.join(app.getPath('userData'), 'lastRoot.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      return cfg.rootPath || null;
    }
  } catch (_) {}
  return null;
});

ipcMain.handle('save-last-root', (_event, rootPath) => {
  try {
    const cfgDir = app.getPath('userData');
    if (!fs.existsSync(cfgDir)) fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'lastRoot.json'), JSON.stringify({ rootPath }), 'utf-8');
  } catch (_) {}
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
    fs.writeFileSync(filePath, JSON.stringify(data, null, 4), 'utf-8');
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
    fs.writeFileSync(filePath, JSON.stringify(data, null, 4), 'utf-8');
    return { success: true, backupPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Load audio callsigns for an airport (en + zh merged) ─────

ipcMain.handle('load-audio-callsigns', async (_event, rootPath, airportIcao) => {
  const levelsDir = path.join(rootPath, 'GroundATC_Data', 'StreamingAssets', 'Airports', airportIcao, 'Levels');
  const enPath = path.join(levelsDir, 'audio_clips_en.json');
  const zhPath = path.join(levelsDir, 'audio_clips_zh.json');

  const enData = fs.existsSync(enPath) ? loadAudioCallsigns(enPath) : null;
  const zhData = fs.existsSync(zhPath) ? loadAudioCallsigns(zhPath) : null;
  return mergeAudioCallsigns(enData, zhData);
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
    fs.writeFileSync(filePath, JSON.stringify(data, null, 4), 'utf-8');
    return { success: true, backupPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Scan runway pairs from ACL RunwayTimeline sections ─

ipcMain.handle('scan-runway-pairs', async (_event, rootPath, airportIcao) => {
  try {
    const levelsDir = path.join(rootPath, 'GroundATC_Data', 'StreamingAssets', 'Airports', airportIcao, 'Levels');
    if (!fs.existsSync(levelsDir)) return { success: true, pairs: [] };

    // Scan all ACL files (include demo/test/tutorial variants)
    const aclFiles = fs.readdirSync(levelsDir).filter(f =>
      f.endsWith('.acl')
    );

    const pairSet = new Set();
    for (const f of aclFiles) {
      try {
        const text = fs.readFileSync(path.join(levelsDir, f), 'utf-8');
        const data = _parseRunwayTimeline(text);
        if (!data.timeline || !Array.isArray(data.timeline)) continue;
        for (const entry of data.timeline) {
          if (!entry.changes || !Array.isArray(entry.changes)) continue;
          for (const ch of entry.changes) {
            if (ch.source && ch.dest) {
              pairSet.add(ch.source + '|' + ch.dest);
              pairSet.add(ch.dest + '|' + ch.source); // reciprocal
            }
          }
        }
      } catch (_) { /* skip malformed files */ }
    }

    const pairs = Array.from(pairSet).sort().map(s => {
      const [source, dest] = s.split('|');
      return { source, dest };
    });

    return { success: true, pairs };
  } catch (err) {
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

app.whenReady().then(() => {
  console.log('[APP] Ready, creating window...');
  console.log('[APP] __dirname:', __dirname);
  console.log('[APP] userData:', app.getPath('userData'));
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    closeLogger();
    app.quit();
  }
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
