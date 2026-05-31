const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { initLogger, closeLogger } = require('./src/logger');

// ── MUST be first: redirect ALL console.* to file (dev only) ──
if (!app.isPackaged) initLogger();

const { loadFlights, saveFlights, generateFullAcl, collectUniqueValues, collectUniqueValuesFromCSV, mergeAudioCallsigns, getFileInfo, exportCSV, exportGameCSV, importCsvFromFile, generateAclFromCsv, loadAudioCallsigns, sortFlightsChronologically } = require('./src/acl_parser');
const { scanGameRoot } = require('./src/acl_scanner');

let mainWindow;
let cachedScan = null; // cached scan result { airports, totalFiles }
let airportCache = null; // Phase 0 cache: { [ICAO]: { csvValues, audioCallsigns } }

function createWindow() {
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
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
}

// ─── IPC: Select game root ───────────────────────────────

ipcMain.handle('select-game-root', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 Airport Control 25 Playtest 游戏根目录',
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
    // Read .aclcfg to get startTime for sorting
    const base = f.filename.replace(/\.acl$/i, '');
    const cfgPath = path.join(path.dirname(f.path), base + '.aclcfg');
    if (fs.existsSync(cfgPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        info.startTime = cfg.startTime || null;
        info.endTime = cfg.endTime || null;
      } catch (_) { /* ignore malformed cfg */ }
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

  // Phase 1: collect from ACL files only
  const aclValues = collectUniqueValues(paths);

  // Merge with Phase 0 CSV cache if available
  const cacheEntry = airportCache && airportCache[airportIcao];
  console.log('[COLLECT-VALUES] airportIcao:', airportIcao);
  console.log('[COLLECT-VALUES] cacheEntry exists:', !!cacheEntry);
  if (cacheEntry && cacheEntry.csvValues) {
    console.log('[COLLECT-VALUES] cache csvValues keys:', Object.keys(cacheEntry.csvValues).filter(k => !k.startsWith('_')));
    console.log('[COLLECT-VALUES] cache _registrationMap keys:', cacheEntry.csvValues._registrationMap ? Object.keys(cacheEntry.csvValues._registrationMap) : 'MISSING');
    if (cacheEntry.csvValues._registrationMap) {
      for (const [k, regs] of Object.entries(cacheEntry.csvValues._registrationMap)) {
        console.log('[COLLECT-VALUES] cache regMap[' + k + '] = ' + JSON.stringify(regs));
      }
    }
    const csvVals = cacheEntry.csvValues;
    for (const key of Object.keys(csvVals)) {
      if (!key.startsWith('_')) {
        const merged = new Set([
          ...(aclValues[key] || []),
          ...(csvVals[key] || []),
        ]);
        aclValues[key] = [...merged].sort((a, b) => a.localeCompare(b));
      }
    }
    // Merge registration map
    if (csvVals._registrationMap) {
      if (!aclValues._registrationMap) aclValues._registrationMap = {};
      for (const [k, regs] of Object.entries(csvVals._registrationMap)) {
        const merged = new Set([
          ...(aclValues._registrationMap[k] || []),
          ...(regs || []),
        ]);
        aclValues._registrationMap[k] = [...merged].sort();
      }
    }
    // Merge compat (airline ↔ aircraftType) from CSV
    if (csvVals._compat) {
      if (!aclValues._compat) aclValues._compat = { airlineToAircraft: {}, aircraftToAirline: {} };
      for (const [k, types] of Object.entries(csvVals._compat.airlineToAircraft || {})) {
        const merged = new Set([...(aclValues._compat.airlineToAircraft[k] || []), ...types]);
        aclValues._compat.airlineToAircraft[k] = [...merged].sort();
      }
      for (const [k, codes] of Object.entries(csvVals._compat.aircraftToAirline || {})) {
        const merged = new Set([...(aclValues._compat.aircraftToAirline[k] || []), ...codes]);
        aclValues._compat.aircraftToAirline[k] = [...merged].sort();
      }
    }
    console.log('[COLLECT-VALUES] AFTER cache merge, aclValues._registrationMap keys:', Object.keys(aclValues._registrationMap));
  } else {
    console.log('[COLLECT-VALUES] cache MISSING or empty for', airportIcao);
  }

  // ── Language: derive from audio_clips_*.json existence, not from CSV ──
  const availableLanguages = [];
  const levelsPath = path.join(rootPath, 'GroundATC_Data', 'StreamingAssets', 'Airports', airportIcao, 'Levels');
  if (fs.existsSync(path.join(levelsPath, 'audio_clips_en.json'))) availableLanguages.push('en');
  if (fs.existsSync(path.join(levelsPath, 'audio_clips_zh.json'))) availableLanguages.push('zh');
  // Also merge in any language values already found in ACL (e.g. from WorldState)
  for (const l of (aclValues.Language || [])) {
    if (!availableLanguages.includes(l)) availableLanguages.push(l);
  }
  if (availableLanguages.length > 0) {
    aclValues.Language = availableLanguages.sort();
  }

  // ── ALWAYS build _registrationMap from CSV files (CSV is the source of truth) ──
  // The ACL parser cannot read Registration, so regMap must come from CSV.
  // Do a direct CSV scan here in addition to the cache merge above.
  console.log('[COLLECT-VALUES] === STARTING direct CSV scan ===');
  if (!aclValues._registrationMap) aclValues._registrationMap = {};
  const csvDir = path.join(rootPath, 'GroundATC_Data', 'StreamingAssets', 'Airports', airportIcao, 'Levels');
  console.log('[COLLECT-VALUES] csvDir:', csvDir, 'exists:', fs.existsSync(csvDir));
  if (fs.existsSync(csvDir)) {
    const allFiles = fs.readdirSync(csvDir);
    console.log('[COLLECT-VALUES] csvDir contents:', JSON.stringify(allFiles));
    for (const f of allFiles) {
      if (!f.endsWith('.csv')) continue;
      console.log('[COLLECT-VALUES] scanning CSV:', f);
      const csvData = collectUniqueValuesFromCSV(path.join(csvDir, f));
      console.log('[COLLECT-VALUES] csvData._registrationMap keys:', csvData._registrationMap ? Object.keys(csvData._registrationMap) : 'NONE');
      if (csvData._registrationMap) {
        for (const [k, regs] of Object.entries(csvData._registrationMap)) {
          console.log('[COLLECT-VALUES]   ' + k + ' -> ' + JSON.stringify(regs));
        }
      }
      if (csvData._registrationMap) {
        for (const [k, regs] of Object.entries(csvData._registrationMap)) {
          if (!aclValues._registrationMap[k]) aclValues._registrationMap[k] = [];
          const merged = new Set([...aclValues._registrationMap[k], ...regs]);
          aclValues._registrationMap[k] = [...merged].sort();
        }
      }
      // Also merge Registration dropdown list
      if (csvData.Registration) {
        const merged = new Set([...(aclValues.Registration || []), ...csvData.Registration]);
        aclValues.Registration = [...merged].sort();
      }
      // Merge compat (airline ↔ aircraftType) from CSV
      if (csvData._compat) {
        if (!aclValues._compat) aclValues._compat = { airlineToAircraft: {}, aircraftToAirline: {} };
        for (const [k, types] of Object.entries(csvData._compat.airlineToAircraft || {})) {
          const merged = new Set([...(aclValues._compat.airlineToAircraft[k] || []), ...types]);
          aclValues._compat.airlineToAircraft[k] = [...merged].sort();
        }
        for (const [k, codes] of Object.entries(csvData._compat.aircraftToAirline || {})) {
          const merged = new Set([...(aclValues._compat.aircraftToAirline[k] || []), ...codes]);
          aclValues._compat.aircraftToAirline[k] = [...merged].sort();
        }
      }
    }
  } else {
    console.log('[COLLECT-VALUES] csvDir DOES NOT EXIST!');
  }

  console.log('[COLLECT-VALUES] === FINAL _registrationMap ===');
  console.log('[COLLECT-VALUES] keys:', Object.keys(aclValues._registrationMap));
  for (const [k, regs] of Object.entries(aclValues._registrationMap)) {
    console.log('[COLLECT-VALUES] FINAL ' + k + ' -> ' + JSON.stringify(regs));
  }
  console.log('[COLLECT-VALUES] _compat airlineToAircraft keys:', aclValues._compat ? Object.keys(aclValues._compat.airlineToAircraft) : 'MISSING');
  console.log('[COLLECT-VALUES] Registration list length:', (aclValues.Registration || []).length);
  console.log('[COLLECT-VALUES] === RETURNING ===');

  return aclValues;
});

// ─── IPC: Renderer-side logging (so renderer console.log goes to file too) ──
ipcMain.handle('renderer-log', async (_event, ...args) => {
  console.log('[RENDERER]', ...args);
});

// ─── IPC: Phase 0 — initialize airport cache (scan all CSV + audio) ──

ipcMain.handle('init-airport-cache', async (_event, rootPath) => {
  console.log('══════════════ [INIT-CACHE] START ══════════════');
  console.log('[INIT-CACHE] rootPath:', rootPath);
  const airportsDir = path.join(rootPath, 'GroundATC_Data', 'StreamingAssets', 'Airports');
  console.log('[INIT-CACHE] airportsDir:', airportsDir);
  console.log('[INIT-CACHE] exists:', fs.existsSync(airportsDir));
  if (!fs.existsSync(airportsDir)) return {};

  const cache = {};

  for (const icao of fs.readdirSync(airportsDir)) {
    const airportPath = path.join(airportsDir, icao);
    if (!fs.statSync(airportPath).isDirectory()) continue;
    const levelsDir = path.join(airportPath, 'Levels');
    if (!fs.existsSync(levelsDir)) { console.log('[INIT-CACHE]', icao, '-> no Levels dir, skip'); continue; }
    const csvFiles = fs.readdirSync(levelsDir).filter(f => f.endsWith('.csv'));
    console.log('[INIT-CACHE]', icao, '-> Levels dir found, CSV files:', JSON.stringify(csvFiles));

    // Scan ALL Session CSV files for this airport
    const csvValues = {
      Stand: new Set(), Runway: new Set(),
      DepartureAirport: new Set(), ArrivalAirport: new Set(),
      AircraftType: new Set(), Voice: new Set(), Language: new Set(),
      Registration: new Set(), Airway: new Set(),
      _voiceOptions: new Set(),
    };
    const csvRegMap = {}; // "AirlineName|AircraftType" → Set<Registration>
    const csvCompat = { airlineToAircraft: {}, aircraftToAirline: {} }; // CSV-compat

    for (const f of fs.readdirSync(levelsDir)) {
      if (!f.endsWith('.csv')) continue;
      const csvData = collectUniqueValuesFromCSV(path.join(levelsDir, f));
      for (const key of Object.keys(csvValues)) {
        for (const val of (csvData[key] || [])) {
          csvValues[key].add(val);
        }
      }
      // Merge registration maps
      if (csvData._registrationMap) {
        for (const [k, regs] of Object.entries(csvData._registrationMap)) {
          if (!csvRegMap[k]) csvRegMap[k] = new Set();
          for (const r of regs) csvRegMap[k].add(r);
        }
      }
      // Merge compat (airline ↔ aircraftType) from CSV
      if (csvData._compat) {
        for (const [k, types] of Object.entries(csvData._compat.airlineToAircraft || {})) {
          if (!csvCompat.airlineToAircraft[k]) csvCompat.airlineToAircraft[k] = new Set();
          for (const t of types) csvCompat.airlineToAircraft[k].add(t);
        }
        for (const [k, codes] of Object.entries(csvData._compat.aircraftToAirline || {})) {
          if (!csvCompat.aircraftToAirline[k]) csvCompat.aircraftToAirline[k] = new Set();
          for (const c of codes) csvCompat.aircraftToAirline[k].add(c);
        }
      }
    }

    // Convert sets to sorted arrays
    const csvValuesOutput = {};
    for (const key of Object.keys(csvValues)) {
      const arr = [...csvValues[key]];
      arr.sort((a, b) => a.localeCompare(b));
      csvValuesOutput[key] = arr;
    }
    // Convert registration map
    const regMapOutput = {};
    for (const [k, v] of Object.entries(csvRegMap)) {
      regMapOutput[k] = [...v].sort();
    }
    csvValuesOutput._registrationMap = regMapOutput;
    // Convert compat map
    const compatOutput = { airlineToAircraft: {}, aircraftToAirline: {} };
    for (const [k, v] of Object.entries(csvCompat.airlineToAircraft)) {
      compatOutput.airlineToAircraft[k] = [...v].sort();
    }
    for (const [k, v] of Object.entries(csvCompat.aircraftToAirline)) {
      compatOutput.aircraftToAirline[k] = [...v].sort();
    }
    csvValuesOutput._compat = compatOutput;

    // Load and merge audio clips (EN + ZH)
    const enPath = path.join(levelsDir, 'audio_clips_en.json');
    const zhPath = path.join(levelsDir, 'audio_clips_zh.json');
    const enData = fs.existsSync(enPath) ? loadAudioCallsigns(enPath) : null;
    const zhData = fs.existsSync(zhPath) ? loadAudioCallsigns(zhPath) : null;

    cache[icao] = {
      csvValues: csvValuesOutput,
      audioCallsigns: mergeAudioCallsigns(enData, zhData),
    };
  }

  airportCache = cache;
  return cache;
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

    return { success: true, path: filePath, config, ...data };
  } catch (err) {
    console.error('[IPC] load-acl FAIL:', filePath, '|', err.message, '|', err.stack);
    return { success: false, error: err.message };
  }
});

// ─── IPC: Save .acl with optional .bak overwrite backup ────

ipcMain.handle('save-acl', async (_event, { filePath, flights, before, after, arrayContent, originalBlocks, worldStateData, sceneryMaps, _fromWorldState, _fromFlightPlans, createBackup }) => {
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

    // Generate full ACL from scratch, preserving header structure
    generateFullAcl(filePath, saveFlights, before, after, originalBlocks, worldStateData, sceneryMaps, _fromWorldState, _fromFlightPlans);

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

// ─── IPC: Save As ────────────────────────────────────────

ipcMain.handle('save-as-acl', async (_event, { flights, before, after, arrayContent, originalBlocks, worldStateData, sceneryMaps, _fromWorldState, _fromFlightPlans, suggestedName, _rawText }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '另存为 .acl 文件',
    defaultPath: suggestedName || 'edited_level.acl',
    filters: [{ name: 'ACL 关卡文件', extensions: ['acl'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };

  try {
    // Re-sort flights to chronological order before saving
    const saveFlights = sortFlightsChronologically(flights);

    // For WorldState/FlightPlans paths, write template text to new file first
    // so _rebuildWorldStateSections can read it as a template
    if ((_fromWorldState || _fromFlightPlans) && _rawText) {
      fs.writeFileSync(result.filePath, _rawText, 'utf-8');
    }

    generateFullAcl(result.filePath, saveFlights, before, after, originalBlocks, worldStateData, sceneryMaps, _fromWorldState, _fromFlightPlans);

    // Also write CSV alongside
    let csvSynced = false;
    try {
      const csvPath = result.filePath.replace(/\.acl$/i, '.csv');
      exportGameCSV(saveFlights, csvPath);
      csvSynced = true;
    } catch (csvErr) {
      console.error('Save-as CSV warning:', csvErr.message);
    }

    return { canceled: false, path: result.filePath, csvSynced };
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

// ─── IPC: Import external .acl ───────────────────────────

ipcMain.handle('import-acl', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '导入外部 .acl 文件',
    filters: [{ name: 'ACL 关卡文件', extensions: ['acl'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };

  try {
    const data = loadFlights(result.filePaths[0]);
    return { canceled: false, path: result.filePaths[0], ...data };
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

// ─── IPC: Load timeline files for a level ────────────────

ipcMain.handle('load-timelines', async (_event, aclPath) => {
  try {
    const levelsDir = path.dirname(aclPath);
    const baseName = path.basename(aclPath, '.acl');

    // 1) Read .aclcfg to get runwayTimelineFile reference
    const cfgPath = path.join(levelsDir, baseName + '.aclcfg');
    let cfgData = null;
    let runwayTimelineFile = null;
    if (fs.existsSync(cfgPath)) {
      cfgData = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      runwayTimelineFile = cfgData.runwayTimelineFile || null;
    }

    // 2) Read weather_timeline.json (shared per airport)
    let weatherTimeline = [];
    const weatherPath = path.join(levelsDir, 'weather_timeline.json');
    if (fs.existsSync(weatherPath)) {
      weatherTimeline = JSON.parse(fs.readFileSync(weatherPath, 'utf-8'));
    }

    // 3) Read wind_timeline.json (shared per airport)
    let windTimeline = [];
    const windPath = path.join(levelsDir, 'wind_timeline.json');
    if (fs.existsSync(windPath)) {
      windTimeline = JSON.parse(fs.readFileSync(windPath, 'utf-8'));
    }

    // 4) Read runway_timeline_*.json (level-specific)
    let runwayTimeline = { initialRunways: [], timeline: [] };
    let runwayTimelinePath = null;
    if (runwayTimelineFile) {
      runwayTimelinePath = path.join(levelsDir, runwayTimelineFile + '.json');
      if (fs.existsSync(runwayTimelinePath)) {
        runwayTimeline = JSON.parse(fs.readFileSync(runwayTimelinePath, 'utf-8'));
      }
    }

    return {
      success: true,
      weatherTimeline, weatherPath,
      windTimeline, windPath,
      runwayTimeline, runwayTimelinePath,
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
