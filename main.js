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

ipcMain.handle('get-oldest-upload-year', async () => {
  const { getOldestUploadYear } = require('./src/tracker');
  const year = getOldestUploadYear();
  return { success: true, data: year };
});

// ─── IPC: Account Transactions (for account summary view) ───────────────────
ipcMain.handle('get-account-transactions', async (event, { apiKey, assetId, year }) => {
  try {
    const { getTransactions } = require('./src/lunchmoney');
    const txs = await getTransactions(apiKey, {
      startDate: `${year}-01-01`,
      endDate:   `${year}-12-31`,
      assetId,
    });
    return { success: true, data: txs };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: LunchMoney Multi-Account Management ────────────────────────────────

ipcMain.handle('lm-accounts:list', async () => {
  const { getAllAccounts } = require('./src/lm-accounts');
  return { success: true, data: getAllAccounts() };
});

ipcMain.handle('lm-accounts:get-active', async () => {
  const { getActiveAccount } = require('./src/lm-accounts');
  const acc = getActiveAccount();
  return { success: true, data: acc };
});

/**
 * Validate an API key against LunchMoney /me, then save & activate the account.
 * Returns { success, data: { id, userName, budgetName } } or { success: false, error }.
 */
ipcMain.handle('lm-accounts:add', async (event, { label, apiKey }) => {
  try {
    const { getMe }       = require('./src/lunchmoney');
    const { addAccount, setActiveAccount } = require('./src/lm-accounts');

    const me = await getMe(apiKey);
    const id = addAccount({
      label:      label || me.user_name || me.budget_name || 'Account',
      apiKey,
      userName:   me.user_name   || null,
      budgetName: me.budget_name || null,
    });
    setActiveAccount(id);
    return { success: true, data: { id, userName: me.user_name, budgetName: me.budget_name } };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('lm-accounts:switch', async (event, id) => {
  try {
    const { setActiveAccount, getActiveAccount } = require('./src/lm-accounts');
    setActiveAccount(id);
    const acc = getActiveAccount();
    return { success: true, data: acc };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('lm-accounts:remove', async (event, id) => {
  try {
    const { removeAccount, getActiveAccount } = require('./src/lm-accounts');
    removeAccount(id);
    const acc = getActiveAccount();
    return { success: true, data: acc }; // returns new active (if any) so renderer can reconnect
  } catch (err) {
    return { success: false, error: err.message };
  }
});

/**
 * One-time migration: if renderer has a legacy localStorage key and no DB
 * accounts exist yet, persist it as the first account.
 */
ipcMain.handle('lm-accounts:migrate', async (event, { apiKey }) => {
  try {
    const { getMe } = require('./src/lunchmoney');
    const { migrateFromLegacyKey } = require('./src/lm-accounts');
    let userName = null, budgetName = null;
    try {
      const me = await getMe(apiKey);
      userName   = me.user_name   || null;
      budgetName = me.budget_name || null;
    } catch { /* tolerate offline/invalid key during migration */ }
    const id = migrateFromLegacyKey({ apiKey, userName, budgetName });
    return { success: true, data: { id, userName, budgetName } };
  } catch (err) {
    return { success: false, error: err.message };
  }
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

// ─── IPC: Dashboard Data ─────────────────────────────────────────────────────
ipcMain.handle('get-dashboard-data', async (event, { apiKey, year, quarter }) => {
  const qMonthsByQ = [[1,2,3],[4,5,6],[7,8,9],[10,11,12]];
  const qMonths    = qMonthsByQ[(quarter || 1) - 1];

  const result = {
    assets:               [],
    ytdIncome:            0,
    trackerAccounts:      [],
    quarterlyTaxEstimate: null,
  };

  // ── LunchMoney: assets + YTD income + quarterly tax estimate ────────────
  if (apiKey) {
    try {
      const { getAssets, getTransactions } = require('./src/lunchmoney');
      const { TAX_PARAMS }                 = require('./src/tax/s04');

      result.assets = await getAssets(apiKey);

      const now    = new Date();
      const ytdEnd = now.toISOString().slice(0, 10);
      const ytdTxs = await getTransactions(apiKey, {
        startDate: `${year}-01-01`,
        endDate:   ytdEnd,
      });

      // YTD income = sum of credits (negative amounts in LunchMoney) in primary currency
      result.ytdIncome = ytdTxs.reduce((sum, tx) => {
        const amount = parseFloat(tx.to_base != null ? tx.to_base : tx.amount) || 0;
        return amount < 0 ? sum + Math.abs(amount) : sum;
      }, 0);

      // Quarterly tax estimate — extrapolate YTD income to annual, apply S04 rates
      const params        = TAX_PARAMS[year] || TAX_PARAMS[2025];
      const monthsElapsed = now.getMonth() + now.getDate() / 30.5; // approximate
      const annualEst     = monthsElapsed > 0
        ? (result.ytdIncome / monthsElapsed) * 12
        : result.ytdIncome * 4;

      const standardDed   = annualEst * params.standardDeductionRate;
      const statutory     = Math.max(0, annualEst - standardDed);
      const nisAnnual     = Math.min(annualEst, params.nisMaxIncome) * params.nisRate;
      const nhtAnnual     = annualEst * params.nhtRate;
      const edTaxAnnual   = statutory * params.edTaxRate;
      const chargeable    = Math.max(0, statutory - params.personalThreshold - nisAnnual);
      let   incomeTaxAnnual = 0;
      if (chargeable > 0) {
        incomeTaxAnnual = chargeable <= params.incomeTaxBand1Max
          ? chargeable * params.incomeTaxRate1
          : params.incomeTaxBand1Max * params.incomeTaxRate1 +
            (chargeable - params.incomeTaxBand1Max) * params.incomeTaxRate2;
      }
      const totalAnnual = nisAnnual + nhtAnnual + edTaxAnnual + incomeTaxAnnual;
      const r2 = v => Math.round(v * 100) / 100;

      result.quarterlyTaxEstimate = {
        annualEstimate: r2(annualEst),
        monthsElapsed:  Math.round(monthsElapsed * 10) / 10,
        nis:            r2(nisAnnual     / 4),
        nht:            r2(nhtAnnual     / 4),
        edTax:          r2(edTaxAnnual   / 4),
        incomeTax:      r2(incomeTaxAnnual / 4),
        total:          r2(totalAnnual   / 4),
      };

      // ── Missing statements: derive from YTD transactions already fetched ──
      // Build a set of "assetId-month" keys that have at least one transaction,
      // then flag any quarter month that has no transactions for each asset.
      // This uses the same data source as the Coverage Tracker view.
      const coveredAssetMonths = new Set();
      for (const tx of ytdTxs) {
        if (tx.asset_id && tx.date) {
          const m = parseInt(tx.date.slice(5, 7), 10);
          coveredAssetMonths.add(`${tx.asset_id}-${m}`);
        }
      }

      result.trackerAccounts = result.assets.map(asset => {
        const quarterMissing = qMonths
          .filter(month => {
            // Skip months that haven't arrived yet
            if (new Date(year, month - 1, 1) > now) return false;
            return !coveredAssetMonths.has(`${asset.id}-${month}`);
          })
          .map(month => ({
            month,
            year,
            label: new Date(year, month - 1, 1)
              .toLocaleString('default', { month: 'long' }) + ' ' + year,
          }));
        return {
          id:          asset.id,
          institution: asset.institution_name || asset.type_name || '',
          account_name: asset.display_name || asset.name,
          currency:    (asset.currency || '').toUpperCase(),
          quarterMissing,
        };
      });
    } catch (e) {
      console.warn('[Dashboard] LunchMoney error:', e.message);
    }
  }

  return { success: true, data: result };
});

// ─── IPC: Check Duplicates ───────────────────────────────────────────────────
// Given an array of { assetId, date, amount } objects, returns a parallel
// boolean array where true = a matching LunchMoney transaction already exists
// (same asset, same date, same absolute amount).  Fails open (all false) on error.
ipcMain.handle('check-duplicates', async (event, { apiKey, transactions }) => {
  try {
    const { getTransactions } = require('./src/lunchmoney');

    if (!apiKey || !transactions || !transactions.length) {
      return { success: true, data: new Array(transactions.length).fill(false) };
    }

    // Group incoming transactions by assetId so we make one API call per asset.
    const byAsset = {};
    transactions.forEach((tx, idx) => {
      const key = tx.assetId != null ? String(tx.assetId) : '__none__';
      if (!byAsset[key]) byAsset[key] = [];
      byAsset[key].push({ idx, date: tx.date, amount: tx.amount });
    });

    const isDuplicate = new Array(transactions.length).fill(false);

    for (const [assetIdStr, items] of Object.entries(byAsset)) {
      if (assetIdStr === '__none__') continue;

      // Find date range for this asset's incoming transactions
      const dates    = items.map(i => i.date).filter(Boolean).sort();
      const startDate = dates[0];
      const endDate   = dates[dates.length - 1];
      if (!startDate) continue;

      const existingTxs = await getTransactions(apiKey, {
        startDate,
        endDate,
        assetId: assetIdStr,
      });

      // Build a lookup set of "date|absAmount" strings from existing LM transactions
      const existingKeys = new Set();
      for (const tx of existingTxs) {
        const absAmt = Math.abs(parseFloat(tx.to_base != null ? tx.to_base : tx.amount) || 0);
        existingKeys.add(`${tx.date}|${absAmt.toFixed(2)}`);
      }

      // Mark any incoming transaction whose key is found in LM
      for (const item of items) {
        const absAmt = Math.abs(parseFloat(item.amount) || 0);
        const key    = `${item.date}|${absAmt.toFixed(2)}`;
        if (existingKeys.has(key)) isDuplicate[item.idx] = true;
      }
    }

    return { success: true, data: isDuplicate };
  } catch (err) {
    console.warn('[check-duplicates] error:', err.message);
    // Fail open — never block the user from uploading
    return { success: true, data: new Array(transactions.length).fill(false) };
  }
});

// ─── IPC: S04 Tax ────────────────────────────────────────────────────────────
ipcMain.handle('generate-s04', async (event, { year, apiKey, manualData, userCategoryMappings }) => {
  try {
    const { generateS04 } = require('./src/tax/s04');
    const report = await generateS04({ year, apiKey, manualData, userCategoryMappings: userCategoryMappings || {} });
    return { success: true, data: report };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Tax Filings (history + S04A) ──────────────────────────────────────

ipcMain.handle('save-filing', async (event, payload) => {
  try {
    const { saveFiling } = require('./src/filings');
    const result = saveFiling(payload);
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-filings', async () => {
  try {
    const { getAllFilings } = require('./src/filings');
    return { success: true, data: getAllFilings() };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('update-filing', async (event, { id, ...fields }) => {
  try {
    const { updateFiling } = require('./src/filings');
    const updated = updateFiling(id, fields);
    return { success: true, data: updated };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('delete-filing', async (event, id) => {
  try {
    const { deleteFiling } = require('./src/filings');
    deleteFiling(id);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('generate-s04a', async (event, { currentYear, apiKey }) => {
  try {
    const { getMostRecentS04 }         = require('./src/filings');
    const { generateS04A }             = require('./src/tax/s04');
    const { getTransactions }          = require('./src/lunchmoney');

    const priorYearFiling = getMostRecentS04(currentYear - 1);

    let currentYtdIncome = 0;
    if (apiKey) {
      const now    = new Date();
      const ytdTxs = await getTransactions(apiKey, {
        startDate: `${currentYear}-01-01`,
        endDate:   now.toISOString().slice(0, 10),
      });
      currentYtdIncome = ytdTxs.reduce((sum, tx) => {
        const amt = parseFloat(tx.to_base != null ? tx.to_base : tx.amount) || 0;
        return amt < 0 ? sum + Math.abs(amt) : sum;
      }, 0);
    }

    const estimate = generateS04A({ currentYear, priorYearFiling, currentYtdIncome });
    return { success: true, data: estimate };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: S04 PDF Export ─────────────────────────────────────────────────────
// Receives a self-contained HTML string from the renderer, renders it in a
// hidden BrowserWindow, exports to PDF via Chromium's engine, and offers a
// save dialog.
ipcMain.handle('export-s04-pdf', async (event, { htmlContent, filename }) => {
  try {
    const { BrowserWindow: BW } = require('electron');

    // Write the HTML to a temp file so the hidden window can load it as file://
    const tmpPath = path.join(app.getPath('temp'), 'mitax-s04-print.html');
    fs.writeFileSync(tmpPath, htmlContent, 'utf8');

    const printWin = new BW({
      show: false,
      width: 900,
      height: 1200,
      webPreferences: { javascript: true, nodeIntegration: false, contextIsolation: true },
    });

    await printWin.loadURL(`file://${tmpPath.replace(/\\/g, '/')}`);
    // Give Chromium a moment to finish layout/fonts
    await new Promise(r => setTimeout(r, 900));

    const pdfBuffer = await printWin.webContents.printToPDF({
      marginsType:     2,       // minimal margins
      pageSize:        'Letter',
      printBackground: true,
      landscape:       false,
    });

    printWin.destroy();
    fs.unlinkSync(tmpPath);

    const { filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: filename || 's04-tax-return.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });

    if (!filePath) return { success: false, error: 'Cancelled' };
    fs.writeFileSync(filePath, pdfBuffer);
    return { success: true, filePath };
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
