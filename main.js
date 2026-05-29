const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { loadFlights, saveFlights, exportCSV, importCSV } = require('./src/acl_parser');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 860,
    minWidth: 1024,
    minHeight: 640,
    title: 'AC27 Level Editor',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  buildMenu();
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '打开 .acl', accelerator: 'CmdOrCtrl+O', click: () => handleOpen() },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => mainWindow.webContents.send('menu-save') },
        { label: '另存为...', accelerator: 'CmdOrCtrl+Shift+S', click: () => handleSaveAs() },
        { type: 'separator' },
        { label: '导入 CSV (追加)', click: () => handleImportCSV('append') },
        { label: '导入 CSV (替换)', click: () => handleImportCSV('replace') },
        { label: '导出 CSV', click: () => handleExportCSV() },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', accelerator: 'CmdOrCtrl+Z', role: 'undo' },
        { label: '重做', accelerator: 'CmdOrCtrl+Shift+Z', role: 'redo' },
        { type: 'separator' },
        { label: '全选', accelerator: 'CmdOrCtrl+A', role: 'selectAll' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' }
      ]
    }
  ];

  if (process.platform === 'darwin') {
    template.unshift({
      label: app.getName(),
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─── File dialogs ───────────────────────────────────────────

async function handleOpen() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '打开 .acl 文件',
    filters: [{ name: 'ACL 关卡文件', extensions: ['acl'] }, { name: '所有文件', extensions: ['*'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return;

  try {
    const data = loadFlights(result.filePaths[0]);
    mainWindow.webContents.send('file-loaded', {
      path: result.filePaths[0],
      ...data
    });
  } catch (err) {
    dialog.showErrorBox('加载失败', err.message);
  }
}

async function handleSaveAs() {
  mainWindow.webContents.send('request-save-data');
}

async function handleImportCSV(mode) {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '导入 CSV',
    filters: [{ name: 'CSV 文件', extensions: ['csv'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return;

  try {
    const flights = importCSV(result.filePaths[0]);
    mainWindow.webContents.send('csv-imported', { flights, mode });
  } catch (err) {
    dialog.showErrorBox('导入失败', err.message);
  }
}

async function handleExportCSV() {
  mainWindow.webContents.send('request-csv-data');
}

// ─── IPC Handlers ───────────────────────────────────────────

ipcMain.on('menu-open', handleOpen);

ipcMain.handle('save-file', async (event, { flights, before, after, arrayContent, originalBlocks }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '保存 .acl 文件',
    defaultPath: mainWindow.currentPath,
    filters: [{ name: 'ACL 关卡文件', extensions: ['acl'] }]
  });
  if (result.canceled || !result.filePath) return { success: false };

  try {
    saveFlights(result.filePath, flights, before, after, arrayContent, originalBlocks);
    // Reload for fresh state
    const data = loadFlights(result.filePath);
    return { success: true, path: result.filePath, ...data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('save-file-direct', async (event, { path: filePath, flights, before, after, arrayContent, originalBlocks }) => {
  try {
    saveFlights(filePath, flights, before, after, arrayContent, originalBlocks);
    const data = loadFlights(filePath);
    return { success: true, ...data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('export-csv', async (event, { flights }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出 CSV',
    defaultPath: 'flights.csv',
    filters: [{ name: 'CSV 文件', extensions: ['csv'] }]
  });
  if (result.canceled || !result.filePath) return { success: false };

  try {
    exportCSV(flights, result.filePath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-app-version', () => app.getVersion());

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
