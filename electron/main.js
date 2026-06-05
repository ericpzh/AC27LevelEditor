const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { initLogger, closeLogger } = require('../src/utils/logger');

// ── MUST be first: redirect ALL console.* to file (dev only) ──
if (!app.isPackaged) initLogger();

const { loadFlights, generateFullAcl, collectUniqueValues, collectUniqueValuesFromCSV, mergeAudioCallsigns, getFileInfo, exportCSV, exportGameCSV, importCsvFromFile, generateAclFromCsv, loadAudioCallsigns, sortFlightsChronologically, _rebuildTimelineSections, scanGameRoot, buildApproachCache, serializeApproachCache, deserializeApproachCache, createZip, listZipFiles, extractZip, _parseWeatherFrames, _parseWindFrames, _parseRunwayTimeline } = require('../src/acl/parser');

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
    title: '选择 Airport Control 27 Playtest 游戏根目录',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };

  const root = result.filePaths[0];
  const scan = scanGameRoot(root);
  if (scan.error) {
    return { canceled: false, rootPath: root, error: scan.error };
  }
  cachedScan = scan;
  return { canceled: false, rootPath: root, airports: scan.airports, totalFiles: scan.totalFiles };
});

// ─── IPC: Scan ACLs in a given root ──────────────────────

ipcMain.handle('scan-acls', async (_event, rootPath) => {
  console.log('[IPC] scan-acls rootPath:', rootPath);
  const scan = scanGameRoot(rootPath);
  if (scan.error) {
    console.error('[IPC] scan-acls FAIL:', scan.error);
    return { error: scan.error };
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
  console.log('[IPC] get-airport-files-info:', airportIcao);
  const scan = scanGameRoot(rootPath);
  if (scan.error) { console.error('[IPC] get-airport-files-info scan error:', scan.error); return []; }
  const airport = scan.airports.find(a => a.icao === airportIcao);
  if (!airport) { console.error('[IPC] get-airport-files-info: airport not found:', airportIcao); return []; }
  console.log('[IPC] get-airport-files-info:', airportIcao, 'files count:', airport.aclFiles.length);
  const results = airport.aclFiles.map((f, i) => {
    const info = getFileInfo(f.path);
    // Read .aclcfg to get endTime
    const base = f.filename.replace(/\.acl$/i, '');
    const cfgPath = path.join(path.dirname(f.path), base + '.aclcfg');
    if (fs.existsSync(cfgPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        info.endTime = cfg.endTime || null;
        if (cfg.startTime) {
          // Config startTime has 10-min warmup — add 10 min to match in-game display
          const p = String(cfg.startTime).split(':');
          const m = parseInt(p[0]) * 60 + parseInt(p[1]) + 10;
          const h = Math.floor(m / 60) % 24;
          info.startTime = String(h).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0') + ':00';
        } else {
          info.startTime = info.earliestTime || null;
        }
      } catch (_) {
        info.startTime = info.earliestTime || null;
      }
    } else {
      info.startTime = info.earliestTime || null;
    }
    console.log('[IPC]   file', i, f.filename, '->', info.error ? ('ERROR: ' + info.error) : ('OK arrivals=' + info.arrivals + ' departures=' + info.departures + ' startTime=' + (info.startTime || 'none')));
    return info;
  });
  // Return all results — renderer will filter based on toggle
  return results;
});

// ─── IPC: Collect valid values for an airport ─────────────

ipcMain.handle('collect-values', async (_event, rootPath, airportIcao) => {
  const scan = scanGameRoot(rootPath);
  if (scan.error) return {};
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
    if (!fs.existsSync(airportsDir)) return { success: false, error: 'Airports directory not found' };

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

    // Read .aclcfg for config info bar
    let config = null;
    const dir = path.dirname(filePath);
    const base = path.basename(filePath, '.acl');
    const cfgPath = path.join(dir, base + '.aclcfg');
    if (fs.existsSync(cfgPath)) {
      try {
        config = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      } catch (_) {}
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

    return { success: true, path: filePath, config, earliestTime, ...data };
  } catch (err) {
    console.error('[IPC] load-acl FAIL:', filePath, '|', err.message, '|', err.stack);
    return { success: false, error: err.message };
  }
});

// ─── IPC: Save .acl with optional .bak overwrite backup ────

ipcMain.handle('save-acl', async (_event, { filePath, flights, before, after, arrayContent, originalBlocks, worldStateData, sceneryMaps, _fromWorldState, _fromFlightPlans, createBackup, weatherTimeline, windTimeline, runwayTimeline }) => {
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

    // Read startTime from .aclcfg for ProgressRatio calculation
    let aclcfgStartTime = null;
    let aclcfgEndTime = null;
    const _cfgPath = path.join(dir, base + '.aclcfg');
    if (fs.existsSync(_cfgPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(_cfgPath, 'utf-8'));
        aclcfgStartTime = cfg.startTime || null;
        aclcfgEndTime = cfg.endTime || null;
      } catch (_) {}
    }

    // Extract ICAO for approach cache lookup
    const icaoMatch = filePath.match(/[\\/]Airports[\\/]([^\\/]+)[\\/]Levels[\\/]/i);
    const icao = icaoMatch ? icaoMatch[1] : '';
    const approachCache = (icao && airportCache && airportCache[icao]) ? airportCache[icao].approachData : null;

    // Generate full ACL from scratch, preserving header structure
    generateFullAcl(filePath, saveFlights, before, after, originalBlocks, worldStateData, sceneryMaps, _fromWorldState, _fromFlightPlans, approachCache, aclcfgStartTime);

    // ── Patch timeline sections into ACL ──
    _rebuildTimelineSections(filePath, weatherTimeline, windTimeline, runwayTimeline);

    // ── Also sync the CSV that the game loads ──
    let csvSynced = false;
    let csvBackupDone = false;
    try {
      const cfgPath = path.join(dir, base + '.aclcfg');
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        const scheduleFile = cfg.flightScheduleFile;
        if (scheduleFile) {
          const csvPath = path.join(dir, scheduleFile + '.csv');
          // Create .bak CSV backup if requested
          if (createBackup && fs.existsSync(csvPath)) {
            fs.copyFileSync(csvPath, csvPath + '.bak');
            csvBackupDone = true;
          }
          exportGameCSV(saveFlights, csvPath);
          csvSynced = true;
        }
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

  // 2) .csv file (from .aclcfg → flightScheduleFile, fallback to .acl → .csv)
  const cfgPath = path.join(dir, baseName + '.aclcfg');
  let csvPath = null;
  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      if (cfg.flightScheduleFile) {
        csvPath = path.join(dir, cfg.flightScheduleFile + '.csv');
      }
    } catch (_) {}
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

  // 5) runway_timeline*.json (from .aclcfg)
  let runwayFile = null;
  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      runwayFile = cfg.runwayTimelineFile || null;
    } catch (_) {}
  }
  if (runwayFile) {
    const rwyPath = path.join(dir, runwayFile + '.json');
    if (fs.existsSync(rwyPath)) {
      entries.push({ name: path.basename(rwyPath), data: fs.readFileSync(rwyPath) });
    }
  }

  return entries;
}


ipcMain.handle('export-zip', async (_event, { aclPath }) => {
  const entries = getLevelFilePaths(aclPath);
  if (entries.length === 0) return { canceled: false, error: '没有可导出的文件' };

  const defaultName = path.basename(aclPath, '.acl') + '_export.zip';
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出关卡包 (.zip)',
    defaultPath: defaultName,
    filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
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
    title: '选择备份保存位置',
    defaultPath: path.basename(sourcePath),
    filters: [{ name: 'ACL 文件', extensions: ['acl'] }],
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
    title: '导入关卡包 (.zip)',
    filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
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
      return { canceled: false, error: `ZIP 缺少必要文件: ${missing.join(', ')}` };
    }

    // 3) Backup current files before overwriting
    const dir = path.dirname(aclPath);
    const entries = getLevelFilePaths(aclPath);
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (fs.existsSync(p)) {
        fs.copyFileSync(p, p + '.bak');
      }
    }

    // 4) Extract ZIP to the target directory (overwrites existing)
    extractZip(zipPath, dir);

    // 5) Reload the ACL to return parsed data
    const aclFile = path.basename(aclPath);
    const newAclPath = path.join(dir, aclFile);
    const data = loadFlights(newAclPath);

    return { canceled: false, path: newAclPath, ...data };
  } catch (err) {
    return { canceled: false, error: err.message };
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
      return { success: false, error: '未找到 .acl.bak 备份文件' };
    }
    fs.copyFileSync(aclBak, filePath);
    restored.push('ACL');

    // 2) Restore CSV .bak → .csv
    const cfgPath = path.join(dir, base + '.aclcfg');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      const scheduleFile = cfg.flightScheduleFile;
      if (scheduleFile) {
        const csvPath = path.join(dir, scheduleFile + '.csv');
        const csvBak = csvPath + '.bak';
        if (fs.existsSync(csvBak)) {
          fs.copyFileSync(csvBak, csvPath);
          restored.push('CSV');
        }
      }
    }

    // 3) Restore timeline .json.bak → .json
    const timelineFiles = [
      { bak: path.join(dir, 'weather_timeline.json.bak'), dest: path.join(dir, 'weather_timeline.json'), label: '天气时间线' },
      { bak: path.join(dir, 'wind_timeline.json.bak'), dest: path.join(dir, 'wind_timeline.json'), label: '风力时间线' },
    ];

    // Runway timeline: read cfg again for the file name
    let runwayTimelineFile = null;
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      runwayTimelineFile = cfg.runwayTimelineFile || null;
    }
    if (runwayTimelineFile) {
      const rwyPath = path.join(dir, runwayTimelineFile + '.json');
      timelineFiles.push({ bak: rwyPath + '.bak', dest: rwyPath, label: '跑道时间线' });
    }

    for (const tf of timelineFiles) {
      if (fs.existsSync(tf.bak)) {
        fs.copyFileSync(tf.bak, tf.dest);
        restored.push(tf.label);
      }
    }

    // 4) Parse restored ACL and return flights
    const data = loadFlights(filePath);
    return { success: true, path: filePath, restored, ...data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Export CSV ─────────────────────────────────────

ipcMain.handle('export-csv', async (_event, { flights, defaultPath }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出 CSV',
    defaultPath: defaultPath || 'flights.csv',
    filters: [{ name: 'CSV 文件', extensions: ['csv'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: false };

  try {
    exportCSV(flights, result.filePath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: CSV → ACL ──────────────────────────────────────

ipcMain.handle('csv-to-acl', async (_event, { suggestedAclName, templatePath }) => {
  const csvResult = await dialog.showOpenDialog(mainWindow, {
    title: '选择 CSV 文件',
    filters: [{ name: 'CSV 文件', extensions: ['csv'] }],
    properties: ['openFile'],
  });
  if (csvResult.canceled || !csvResult.filePaths.length) return { canceled: true };

  const aclResult = await dialog.showSaveDialog(mainWindow, {
    title: '保存生成的 .acl 文件',
    defaultPath: suggestedAclName || 'generated_level.acl',
    filters: [{ name: 'ACL 关卡文件', extensions: ['acl'] }],
  });
  if (aclResult.canceled || !aclResult.filePath) return { canceled: true };

  try {
    generateAclFromCsv(csvResult.filePaths[0], aclResult.filePath, templatePath);
    return { success: true, path: aclResult.filePath };
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
    const baseName = path.basename(aclPath, '.acl');

    // Read .aclcfg for runwayTimelineFile reference (path only, not data)
    const cfgPath = path.join(levelsDir, baseName + '.aclcfg');
    let runwayTimelineFile = null;
    if (fs.existsSync(cfgPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        runwayTimelineFile = cfg.runwayTimelineFile || null;
      } catch (_) {}
    }

    // Parse timelines directly from ACL (single source of truth)
    const aclText = fs.readFileSync(aclPath, 'utf-8');
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
      runwayTimelinePath: runwayTimelineFile
        ? path.join(levelsDir, runwayTimelineFile + '.json')
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

// ─── IPC: Scan runway pairs from all runway_timeline_*.json ─

ipcMain.handle('scan-runway-pairs', async (_event, rootPath, airportIcao) => {
  try {
    const levelsDir = path.join(rootPath, 'GroundATC_Data', 'StreamingAssets', 'Airports', airportIcao, 'Levels');
    if (!fs.existsSync(levelsDir)) return { success: true, pairs: [] };

    const files = fs.readdirSync(levelsDir).filter(f =>
      f.startsWith('runway_timeline_') && f.endsWith('.json')
    );

    const pairSet = new Set();
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(levelsDir, f), 'utf-8'));
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
