const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { loadFlights, saveFlights, collectUniqueValues, getFileInfo, exportCSV } = require('./src/acl_parser');
const { scanGameRoot } = require('./src/acl_scanner');

let mainWindow;
let cachedScan = null; // cached scan result { airports, totalFiles }

function createWindow() {
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
  buildMenu();
}

function buildMenu() {
  const template = [
    { label: '文件', submenu: [
      { label: '返回关卡列表', accelerator: 'CmdOrCtrl+B', click: () => mainWindow.webContents.send('nav-browser') },
      { type: 'separator' },
      { role: 'quit', label: '退出' },
    ]},
    { label: '视图', submenu: [
      { role: 'reload', label: '刷新' },
      { role: 'toggleDevTools', label: '开发者工具' },
    ]},
  ];
  if (process.platform === 'darwin') {
    template.unshift({ label: app.getName(), submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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
    // 1) Generate timestamped backup in same directory
    const dir = path.dirname(filePath);
    const base = path.basename(filePath, '.acl');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const backupPath = path.join(dir, `${base}_backup_${ts}.acl`);
    fs.copyFileSync(filePath, backupPath);

    // 2) Save the new content
    saveFlights(filePath, flights, before, after, arrayContent, originalBlocks);

    return { success: true, backupPath };
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
    saveFlights(result.filePath, flights, before, after, arrayContent, originalBlocks);
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
