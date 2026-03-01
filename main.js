const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs   = require('fs');

let mainWindow;

// ─── Auto-updater (only in packaged builds) ──────────────────────────────────
// initUpdater is called after the window is created so it has a reference to it.
let initUpdater = null;
try {
  initUpdater = require('./src/updater').initUpdater;
} catch (e) {
  // electron-updater not yet installed (dev mode without npm install)
  console.log('electron-updater not available:', e.message);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1340,
    height: 860,
    minWidth: 980,
    minHeight: 660,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0d1117',
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

app.whenReady().then(() => {
  createWindow();

  // Start auto-updater after window is ready
  if (initUpdater) initUpdater(mainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─── IPC: Parse PDF / CSV ───────────────────────────────────────────────────
ipcMain.handle('parse-pdf', async (event, filePath) => {
  try {
    const { parseStatement } = require('./src/parsers/index');
    const result = await parseStatement(filePath);
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: LunchMoney Assets ─────────────────────────────────────────────────
ipcMain.handle('get-lm-assets', async (event, apiKey) => {
  try {
    const { getAssets } = require('./src/lunchmoney');
    const assets = await getAssets(apiKey);
    return { success: true, data: assets };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('create-lm-asset', async (event, { apiKey, assetData }) => {
  try {
    const { createAsset } = require('./src/lunchmoney');
    const asset = await createAsset(apiKey, assetData);
    return { success: true, data: asset };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Payees ────────────────────────────────────────────────────────────
ipcMain.handle('get-lm-payees', async (event, apiKey) => {
  try {
    const { getPayees } = require('./src/lunchmoney');
    const payees = await getPayees(apiKey);
    return { success: true, data: payees };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('process-payees', async (event, { transactions, existingPayees }) => {
  try {
    const { processTransactions } = require('./src/payee-matcher');
    const result = processTransactions(transactions, existingPayees);
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Upload Transactions ───────────────────────────────────────────────
ipcMain.handle('upload-transactions', async (event, { transactions, apiKey, assetId, skipDuplicates, applyRules }) => {
  try {
    const { uploadTransactions } = require('./src/lunchmoney');
    const result = await uploadTransactions(transactions, apiKey, { assetId, skipDuplicates, applyRules });
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Coverage (from LunchMoney) ────────────────────────────────────────
ipcMain.handle('get-asset-coverage', async (event, { apiKey, assetId, year }) => {
  try {
    const { getAssetMonthCoverage } = require('./src/lunchmoney');
    const coverage = await getAssetMonthCoverage(apiKey, assetId, year);
    return { success: true, data: coverage };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Local Tracker ─────────────────────────────────────────────────────
ipcMain.handle('tracker-get-uploads',        async () => {
  const { getAllUploads } = require('./src/tracker');
  return getAllUploads();
});

ipcMain.handle('tracker-save-upload',        async (event, record) => {
  const { saveUpload } = require('./src/tracker');
  return saveUpload(record);
});

ipcMain.handle('tracker-get-missing-months', async (event, accountId) => {
  const { getMissingMonths } = require('./src/tracker');
  return getMissingMonths(accountId);
});

ipcMain.handle('tracker-get-all-accounts',  async () => {
  const { getAllAccounts } = require('./src/tracker');
  return getAllAccounts();
});

// ─── IPC: Categories ────────────────────────────────────────────────────────
ipcMain.handle('get-lm-categories', async (event, apiKey) => {
  try {
    const { getCategories } = require('./src/lunchmoney');
    const cats = await getCategories(apiKey);
    return { success: true, data: cats };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: CSV Export ────────────────────────────────────────────────────────
ipcMain.handle('export-csv', async (event, { transactions, filename }) => {
  try {
    const { formatAsCSV } = require('./src/lunchmoney');
    const csv = formatAsCSV(transactions);
    const { filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: filename || 'transactions.csv',
      filters: [{ name: 'CSV Files', extensions: ['csv'] }],
    });
    if (filePath) {
      fs.writeFileSync(filePath, csv, 'utf8');
      return { success: true, filePath };
    }
    return { success: false, error: 'Cancelled' };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: S04 Tax ────────────────────────────────────────────────────────────
ipcMain.handle('generate-s04', async (event, { year, apiKey, manualData }) => {
  try {
    const { generateS04 } = require('./src/tax/s04');
    const report = await generateS04({ year, apiKey, manualData });
    return { success: true, data: report };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: File dialogs ───────────────────────────────────────────────────────
ipcMain.handle('open-file-dialog', async () => {
  const { filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Statements', extensions: ['pdf', 'csv', 'xlsx'] }],
  });
  return filePaths || [];
});

ipcMain.handle('read-file', async (event, filePath) => {
  const buffer = fs.readFileSync(filePath);
  return { buffer: buffer.toString('base64'), name: path.basename(filePath) };
});

ipcMain.handle('get-app-data-path', () => app.getPath('userData'));
