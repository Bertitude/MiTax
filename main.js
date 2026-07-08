const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs   = require('fs');

let mainWindow;

// External URLs the renderer is permitted to open in the system browser.
// openExternal is otherwise a navigation/redirect vector, so keep this tight.
const ALLOWED_EXTERNAL_PREFIXES = ['https://mytaxes.ads.taj.gov.jm/'];

// Files the renderer is allowed to read/parse. Populated only by paths the user
// explicitly chose via the open dialog or drag-and-drop (see registerStatementFile).
// Prevents a compromised renderer from reading arbitrary paths through parse-pdf.
const allowedFiles = new Set();

// Resolve the active account's decrypted API key inside the main process.
// The key is NEVER sent to or accepted from the renderer for operations — the
// renderer only holds a "connected" flag — so every LunchMoney call resolves
// the key here from the encrypted store.
function activeApiKey() {
  return require('./src/lm-accounts').getActiveApiKey();
}

// Strip the api_key before an account row crosses the IPC boundary. The
// renderer must never receive the raw key (it would end up in plaintext in
// Chromium local storage). `connected` tells the renderer a usable key exists.
function publicAccount(acc) {
  if (!acc) return null;
  return {
    id:                 acc.id,
    label:              acc.label,
    user_name:          acc.user_name,
    budget_name:        acc.budget_name,
    is_active:          acc.is_active,
    created_at:         acc.created_at,
    connected:          !!acc.api_key,
    keyStorageInsecure: !!acc.keyStorageInsecure,
  };
}

// Resolve "today" as YYYY-MM-DD in the user's configured timezone (falls back
// to the system timezone, then UTC). Used wherever date-only comparisons feed
// tax logic, where a UTC/local mismatch shifts the day.
function resolveTodayStr(timezone) {
  const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const y = parts.find(p => p.type === 'year').value;
    const m = parts.find(p => p.type === 'month').value;
    const d = parts.find(p => p.type === 'day').value;
    return `${y}-${m}-${d}`;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// Harden a window against navigation and popups: the app is a single local page,
// so any navigation away or window.open is unwanted.
function hardenWindow(win) {
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

// Append an error to userData/error.log (best-effort; never throws).
function logError(context, err) {
  const msg = err && err.stack ? err.stack : String(err);
  console.error(`[${context}]`, msg);
  try {
    const line = `[${new Date().toISOString()}] [${context}] ${msg}\n`;
    fs.appendFileSync(path.join(app.getPath('userData'), 'error.log'), line);
  } catch (_) { /* logging must not throw */ }
}

// Last-resort handlers so a stray throw/rejection doesn't take down the main
// process silently. Do NOT quit — better-sqlite3 writes are synchronous, so
// there are no torn writes to recover from.
process.on('uncaughtException', (err) => {
  logError('uncaughtException', err);
  try { dialog.showErrorBox('Unexpected error', err && err.message ? err.message : String(err)); } catch (_) {}
});
process.on('unhandledRejection', (reason) => {
  logError('unhandledRejection', reason);
});

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
      sandbox: true,
    },
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0d1117',
    show: false,
  });

  hardenWindow(mainWindow);
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
    if (!allowedFiles.has(filePath)) {
      return { success: false, error: 'File not authorized. Select it via the file picker or drag-and-drop.' };
    }
    const { parseStatement } = require('./src/parsers/index');
    const result = await parseStatement(filePath);
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Open an allow-listed external URL in the system browser ────────────
ipcMain.handle('open-external', async (event, url) => {
  try {
    const u = new URL(String(url));
    const ok = u.protocol === 'https:' &&
               ALLOWED_EXTERNAL_PREFIXES.some(p => u.href.startsWith(p));
    if (!ok) return { success: false, error: 'URL not permitted' };
    await shell.openExternal(u.href);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Register a drag-and-dropped statement file as read-authorized ──────
ipcMain.handle('register-statement-file', (event, filePath) => {
  try {
    const ext = path.extname(String(filePath)).toLowerCase();
    if (!['.pdf', '.csv', '.xlsx'].includes(ext)) {
      return { success: false, error: 'Unsupported file type' };
    }
    if (!fs.statSync(filePath).isFile()) {
      return { success: false, error: 'Not a file' };
    }
    allowedFiles.add(filePath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: LunchMoney Assets ─────────────────────────────────────────────────
ipcMain.handle('get-lm-assets', async () => {
  try {
    const { getAssets } = require('./src/lunchmoney');
    const assets = await getAssets(activeApiKey());
    return { success: true, data: assets };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('create-lm-asset', async (event, { assetData }) => {
  try {
    const { createAsset } = require('./src/lunchmoney');
    const asset = await createAsset(activeApiKey(), assetData);
    return { success: true, data: asset };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Payees ────────────────────────────────────────────────────────────
ipcMain.handle('get-lm-payees', async () => {
  try {
    const { getPayees } = require('./src/lunchmoney');
    const payees = await getPayees(activeApiKey());
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
ipcMain.handle('upload-transactions', async (event, { transactions, assetId, skipDuplicates, applyRules }) => {
  try {
    const { uploadTransactions } = require('./src/lunchmoney');
    const result = await uploadTransactions(transactions, activeApiKey(), { assetId, skipDuplicates, applyRules });
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Payee Batch Update ─────────────────────────────────────────────────
ipcMain.handle('payee-update-batch', async (event, { updates }) => {
  try {
    const { batchUpdatePayees } = require('./src/lunchmoney');
    const result = await batchUpdatePayees(activeApiKey(), updates);
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Coverage (from LunchMoney) ────────────────────────────────────────
ipcMain.handle('get-asset-coverage', async (event, { assetId, year }) => {
  try {
    const { getAssetMonthCoverage } = require('./src/lunchmoney');
    const coverage = await getAssetMonthCoverage(activeApiKey(), assetId, year);
    return { success: true, data: coverage };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Local Tracker ─────────────────────────────────────────────────────
// These handlers return bare data (not a {success} envelope) that the renderer
// consumes directly. A better-sqlite3 throw (locked/corrupt DB) would otherwise
// become an unhandled IPC rejection; catch, log, and degrade to a safe default.
ipcMain.handle('tracker-get-uploads',        async () => {
  try {
    const { getAllUploads } = require('./src/tracker');
    return getAllUploads();
  } catch (err) { logError('tracker-get-uploads', err); return []; }
});

ipcMain.handle('tracker-save-upload',        async (event, record) => {
  try {
    const { saveUpload } = require('./src/tracker');
    return saveUpload(record);
  } catch (err) { logError('tracker-save-upload', err); return { error: err.message }; }
});

ipcMain.handle('tracker-get-missing-months', async (event, accountId) => {
  try {
    const { getMissingMonths } = require('./src/tracker');
    return getMissingMonths(accountId);
  } catch (err) { logError('tracker-get-missing-months', err); return []; }
});

ipcMain.handle('tracker-get-all-accounts',  async () => {
  try {
    const { getAllAccounts } = require('./src/tracker');
    return getAllAccounts();
  } catch (err) { logError('tracker-get-all-accounts', err); return []; }
});

ipcMain.handle('tracker-get-db-coverage', async (event, { lmAssetId, year }) => {
  try {
    const { getDbCoverageForAsset } = require('./src/tracker');
    // Convert Set → Array so it serialises cleanly over IPC
    return Array.from(getDbCoverageForAsset(lmAssetId, year));
  } catch (err) { logError('tracker-get-db-coverage', err); return []; }
});

ipcMain.handle('get-oldest-upload-year', async () => {
  const { getOldestUploadYear } = require('./src/tracker');
  const year = getOldestUploadYear();
  return { success: true, data: year };
});

// ─── IPC: Fix Flipped Signs (recover from pre-v1.2.18 sign bug) ─────────────
// Given a tracker upload id, flip the LunchMoney `amount` sign on every
// tx id stored in that upload's lm_ids. Sends progress events to the
// renderer so the UI can draw a progress bar. Marks the upload as fixed
// on success so it can't be run twice (protects against re-flipping).
ipcMain.handle('fix-flipped-signs', async (event, { uploadId }) => {
  try {
    const { getUpload, markSignsFixed } = require('./src/tracker');
    const { flipTransactionSigns }      = require('./src/lunchmoney');

    const upload = getUpload(uploadId);
    if (!upload)               return { success: false, error: 'Upload not found' };
    if (upload.signs_fixed_at) return { success: false, error: 'Signs already fixed for this upload' };

    let lmIds = [];
    try { lmIds = JSON.parse(upload.lm_ids || '[]') || []; } catch { lmIds = []; }
    if (!Array.isArray(lmIds) || !lmIds.length) {
      return { success: false, error: 'No LunchMoney transaction IDs recorded for this upload' };
    }

    const result = await flipTransactionSigns(activeApiKey(), lmIds, progress => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('fix-flipped-signs:progress', { uploadId, ...progress });
      }
    });

    // Mark fixed even if some rows failed — prevents double-flips on retry.
    // The UI surfaces failures so the user can address them individually.
    markSignsFixed(uploadId, new Date().toISOString());

    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Flip Single Transaction (one-off correction from account view) ────
// Reuses flipTransactionSigns with a single-element array so we get the same
// retry/backoff and skip-if-deleted behaviour as the per-upload path.
ipcMain.handle('flip-single-transaction', async (event, { txId }) => {
  try {
    const { flipTransactionSigns } = require('./src/lunchmoney');
    const result = await flipTransactionSigns(activeApiKey(), [txId]);
    if (result.failed && result.failed.length) {
      return { success: false, error: result.failed[0].error || 'Flip failed' };
    }
    if (result.skipped && result.skipped.length) {
      return { success: false, error: 'Transaction not found in LunchMoney' };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Reconcile — compare parsed statement against LM transactions ──────
// Returns { signMismatches, phantomBalances, suspectedPhantoms } — see
// src/reconcile.js. Phantom deletion is scoped to balance lines the parser
// actually saw (balanceSentinels); payee-only matches are merely "suspected".
ipcMain.handle('reconcile-statement', async (event, { assetId, filePath, year }) => {
  try {
    if (!allowedFiles.has(filePath)) {
      return { success: false, error: 'File not authorized. Select it via the file picker or drag-and-drop.' };
    }
    const { parseStatement } = require('./src/parsers/index');
    const { getTransactions } = require('./src/lunchmoney');

    const { reconcile } = require('./src/reconcile');

    const parsed = await parseStatement(filePath);
    const results = Array.isArray(parsed) ? parsed : [parsed];
    const parsedTxs = results.flatMap(r => r.transactions || []);
    // Balance-sentinel lines the parsers skipped — used to scope phantom deletion.
    const balanceSentinels = results.flatMap(r => r.balanceSentinels || []);

    const lmTxs = await getTransactions(activeApiKey(), {
      startDate: `${year}-01-01`,
      endDate:   `${year}-12-31`,
      assetId,
    });

    const data = reconcile(parsedTxs, lmTxs, balanceSentinels);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Apply Reconciliation — flip signs + delete phantoms ───────────────
ipcMain.handle('apply-reconciliation', async (event, { flipIds, deleteIds }) => {
  try {
    const { flipTransactionSigns, deleteTransaction } = require('./src/lunchmoney');
    const apiKey = activeApiKey();

    const result = { flipped: 0, deleted: 0, errors: [] };

    if (flipIds && flipIds.length) {
      const flipResult = await flipTransactionSigns(apiKey, flipIds, () => {});
      result.flipped = flipResult.ok || 0;
      if (flipResult.failed) result.errors.push(...flipResult.failed.map(f => f.error));
    }

    for (const id of (deleteIds || [])) {
      try {
        await deleteTransaction(apiKey, id);
        result.deleted++;
      } catch (err) {
        result.errors.push(`Delete ${id}: ${err.message}`);
      }
    }

    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Account Transactions (for account summary view) ───────────────────
ipcMain.handle('get-account-transactions', async (event, { assetId, year }) => {
  try {
    const { getTransactions } = require('./src/lunchmoney');
    const txs = await getTransactions(activeApiKey(), {
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
  try {
    const { getAllAccounts } = require('./src/lm-accounts');
    return { success: true, data: getAllAccounts() };
  } catch (err) { logError('lm-accounts:list', err); return { success: false, error: err.message }; }
});

ipcMain.handle('lm-accounts:get-active', async () => {
  try {
    const { getActiveAccount } = require('./src/lm-accounts');
    return { success: true, data: publicAccount(getActiveAccount()) };
  } catch (err) { logError('lm-accounts:get-active', err); return { success: false, error: err.message }; }
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
    return { success: true, data: publicAccount(getActiveAccount()) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('lm-accounts:remove', async (event, id) => {
  try {
    const { removeAccount, getActiveAccount } = require('./src/lm-accounts');
    removeAccount(id);
    return { success: true, data: publicAccount(getActiveAccount()) }; // new active (if any) so renderer can reconnect
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
ipcMain.handle('get-lm-categories', async () => {
  try {
    const { getCategories } = require('./src/lunchmoney');
    const cats = await getCategories(activeApiKey());
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
ipcMain.handle('get-dashboard-data', async (event, { year, quarter }) => {
  const qMonthsByQ = [[1,2,3],[4,5,6],[7,8,9],[10,11,12]];
  const qMonths    = qMonthsByQ[(quarter || 1) - 1];
  const apiKey     = activeApiKey();

  const result = {
    assets:               [],
    ytdIncome:            0,
    trackerAccounts:      [],
    quarterlyTaxEstimate: null,
  };

  // ── LunchMoney: assets + YTD income + quarterly tax estimate ────────────
  if (apiKey) {
    try {
      const { getAssets, getTransactions }   = require('./src/lunchmoney');
      const { TAX_PARAMS, estimateAnnualTax } = require('./src/tax/s04');

      result.assets = await getAssets(apiKey);

      const now    = new Date();
      const ytdEnd = now.toISOString().slice(0, 10);
      const ytdTxs = await getTransactions(apiKey, {
        startDate: `${year}-01-01`,
        endDate:   ytdEnd,
      });

      // YTD income = sum of credits (positive amounts) in primary currency
      result.ytdIncome = ytdTxs.reduce((sum, tx) => {
        const amount = parseFloat(tx.to_base != null ? tx.to_base : tx.amount) || 0;
        return amount > 0 ? sum + amount : sum;
      }, 0);

      // Quarterly tax estimate — extrapolate YTD income to annual, apply S04 rates
      const params        = TAX_PARAMS[year] || TAX_PARAMS[2025];
      const monthsElapsed = now.getMonth() + now.getDate() / 30.5; // approximate
      const annualEst     = monthsElapsed > 0
        ? (result.ytdIncome / monthsElapsed) * 12
        : result.ytdIncome * 4;

      // Shared with the S04A estimate (integer-cents math in src/tax/s04.js).
      const est = estimateAnnualTax(annualEst, params);
      const r2 = v => Math.round(v * 100) / 100;

      result.quarterlyTaxEstimate = {
        annualEstimate: r2(annualEst),
        monthsElapsed:  Math.round(monthsElapsed * 10) / 10,
        nis:            r2(est.nis       / 4),
        nht:            r2(est.nht       / 4),
        edTax:          r2(est.edTax     / 4),
        incomeTax:      r2(est.incomeTax / 4),
        total:          r2(est.total     / 4),
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
ipcMain.handle('check-duplicates', async (event, { transactions }) => {
  try {
    const { getTransactions } = require('./src/lunchmoney');
    const apiKey = activeApiKey();

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
ipcMain.handle('generate-s04', async (event, { year, manualData, userCategoryMappings }) => {
  try {
    const { generateS04 }          = require('./src/tax/s04');
    const { getP24TotalsForYear }  = require('./src/p24');
    const p24Totals = getP24TotalsForYear(year);
    const report = await generateS04({
      year, apiKey: activeApiKey(), manualData,
      userCategoryMappings: userCategoryMappings || {},
      p24Totals,
    });
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

ipcMain.handle('generate-s04a', async (event, { currentYear, timezone }) => {
  try {
    const { getMostRecentS04 }         = require('./src/filings');
    const { generateS04A }             = require('./src/tax/s04');
    const { getTransactions }          = require('./src/lunchmoney');

    const apiKey          = activeApiKey();
    const priorYearFiling = getMostRecentS04(currentYear - 1);

    // Resolve "today" in the user's configured timezone
    const todayStr = resolveTodayStr(timezone);

    // Clamp the fetch window to the selected year: for a past year, todayStr is
    // in a later year and would pull a multi-year window while generateS04A
    // still divides by ≤12 months, inflating the trend.
    const yearEnd = `${currentYear}-12-31`;
    const endDate = todayStr < yearEnd ? todayStr : yearEnd;

    let currentYtdIncome = 0;
    if (apiKey) {
      const ytdTxs = await getTransactions(apiKey, {
        startDate: `${currentYear}-01-01`,
        endDate,
      });
      currentYtdIncome = ytdTxs.reduce((sum, tx) => {
        const amt = parseFloat(tx.to_base != null ? tx.to_base : tx.amount) || 0;
        return amt > 0 ? sum + amt : sum;
      }, 0);
    }

    const estimate = generateS04A({ currentYear, priorYearFiling, currentYtdIncome, todayStr });
    return { success: true, data: estimate };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Jamaica's tax threshold changes every April 1; report whether the bundled
// TAX_PARAMS have been re-verified since the most recent change window so the
// renderer can warn the user to update the app before filing.
ipcMain.handle('tax-params:status', async (event, { timezone } = {}) => {
  try {
    const { taxParamsStatus } = require('./src/tax/s04');
    return { success: true, data: taxParamsStatus(resolveTodayStr(timezone)) };
  } catch (err) {
    logError('tax-params:status', err);
    return { success: false, error: err.message };
  }
});

// ─── IPC: P24 Employment Income Entries ──────────────────────────────────────

ipcMain.handle('p24:save', async (event, payload) => {
  try {
    const { saveEntry } = require('./src/p24');
    const result = saveEntry(payload);
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('p24:get-for-year', async (event, year) => {
  try {
    const { getEntriesForYear } = require('./src/p24');
    return { success: true, data: getEntriesForYear(year) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('p24:delete', async (event, id) => {
  try {
    const { deleteEntry } = require('./src/p24');
    deleteEntry(id);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: S04 PDF Export ─────────────────────────────────────────────────────
// Receives a self-contained HTML string from the renderer, renders it in a
// hidden BrowserWindow, exports to PDF via Chromium's engine, and offers a
// save dialog.
ipcMain.handle('export-s04-pdf', async (event, { htmlContent, filename }) => {
  const { BrowserWindow: BW } = require('electron');
  let printWin = null;
  let tmpDir = null;
  try {
    // Unique temp dir avoids the predictable-path clobber/symlink race and
    // lets us clean up deterministically.
    tmpDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'mitax-'));
    const tmpPath = path.join(tmpDir, 's04-print.html');
    fs.writeFileSync(tmpPath, htmlContent, 'utf8');

    printWin = new BW({
      show: false,
      width: 900,
      height: 1200,
      // Static report HTML — no script execution needed, so disable JS.
      webPreferences: { javascript: false, nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    hardenWindow(printWin);

    // loadFile resolves on did-finish-load; with JS disabled there are no async
    // scripts to wait on, so the fixed sleep is unnecessary.
    await printWin.loadFile(tmpPath);

    const pdfBuffer = await printWin.webContents.printToPDF({
      margins:         { marginType: 'none' },
      pageSize:        'Letter',
      printBackground: true,
      landscape:       false,
    });

    const { filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: filename || 's04-tax-return.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });

    if (!filePath) return { success: false, error: 'Cancelled' };
    fs.writeFileSync(filePath, pdfBuffer);
    return { success: true, filePath };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    if (printWin && !printWin.isDestroyed()) printWin.destroy();
    if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} }
  }
});

// ─── IPC: File dialogs ───────────────────────────────────────────────────────
ipcMain.handle('open-file-dialog', async () => {
  const { filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Statements', extensions: ['pdf', 'csv', 'xlsx'] }],
  });
  // Authorize the user-chosen paths for subsequent parse-pdf/reconcile calls.
  (filePaths || []).forEach(p => allowedFiles.add(p));
  return filePaths || [];
});
