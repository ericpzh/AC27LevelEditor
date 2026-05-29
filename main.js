const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { loadFlights, saveFlights, generateFullAcl, collectUniqueValues, getFileInfo, exportCSV, importCsvFromFile, generateAclFromCsv } = require('./src/acl_parser');
const { scanGameRoot } = require('./src/acl_scanner');

let mainWindow;
let cachedScan = null; // cached scan result { airports, totalFiles }

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
  const scan = scanGameRoot(rootPath);
  if (scan.error) return { error: scan.error };
  cachedScan = scan;
  return { airports: scan.airports, totalFiles: scan.totalFiles };
});

// ─── IPC: Get file info (lightweight) ────────────────────

ipcMain.handle('get-file-info', async (_event, filePath) => {
  return getFileInfo(filePath);
});

// ─── IPC: Get file infos for an airport ──────────────────

ipcMain.handle('get-airport-files-info', async (_event, airportIcao, rootPath) => {
  const scan = scanGameRoot(rootPath);
  if (scan.error) return [];
  const airport = scan.airports.find(a => a.icao === airportIcao);
  if (!airport) return [];
  return airport.aclFiles.map(f => getFileInfo(f.path));
});

// ─── IPC: Collect valid values for an airport ─────────────

ipcMain.handle('collect-values', async (_event, rootPath, airportIcao) => {
  const scan = scanGameRoot(rootPath);
  if (scan.error) return {};
  const airport = scan.airports.find(a => a.icao === airportIcao);
  if (!airport) return {};
  const paths = airport.aclFiles.map(f => f.path);
  return collectUniqueValues(paths);
});

// ─── IPC: Load an .acl file ──────────────────────────────

ipcMain.handle('load-acl', async (_event, filePath) => {
  try {
    const data = loadFlights(filePath);
    return { success: true, path: filePath, ...data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Save .acl with auto-timestamped backup ──────────

ipcMain.handle('save-acl', async (_event, { filePath, flights, before, after, arrayContent, originalBlocks }) => {
  try {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath, '.acl');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const backupPath = path.join(dir, `${base}_backup_${ts}.acl`);

    // Generate backup from existing file if it exists
    if (fs.existsSync(filePath)) {
      fs.copyFileSync(filePath, backupPath);
    }

    // Generate full ACL from scratch, preserving header structure
    generateFullAcl(filePath, flights, before, after, originalBlocks);

    return { success: true, backupPath: fs.existsSync(filePath) ? backupPath : null };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Save As ────────────────────────────────────────

ipcMain.handle('save-as-acl', async (_event, { flights, before, after, arrayContent, originalBlocks, suggestedName }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '另存为 .acl 文件',
    defaultPath: suggestedName || 'edited_level.acl',
    filters: [{ name: 'ACL 关卡文件', extensions: ['acl'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };

  try {
    generateFullAcl(result.filePath, flights, before, after, originalBlocks);
    return { canceled: false, path: result.filePath };
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
    const backupPath = path.join(dir, 'weather_timeline_backup_' + Date.now() + '.json');
    if (fs.existsSync(filePath)) fs.copyFileSync(filePath, backupPath);
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
    const backupPath = path.join(dir, 'wind_timeline_backup_' + Date.now() + '.json');
    if (fs.existsSync(filePath)) fs.copyFileSync(filePath, backupPath);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 4), 'utf-8');
    return { success: true, backupPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Save runway_timeline*.json ─────────────────────

ipcMain.handle('save-runway-timeline', async (_event, { filePath, data }) => {
  try {
    const dir = path.dirname(filePath);
    const backupPath = path.join(dir, 'runway_timeline_backup_' + Date.now() + '.json');
    if (fs.existsSync(filePath)) fs.copyFileSync(filePath, backupPath);
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

app.whenReady().then(createWindow);

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
