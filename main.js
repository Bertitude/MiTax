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

// Authorize a file for reading/parsing. Stores the canonical (symlink-resolved)
// path so the allow-list can't be bypassed by a symlink to a sensitive file and
// so the later check matches regardless of how the renderer spells the path.
function authorizeFile(filePath) {
  const real = fs.realpathSync(filePath);
  if (!fs.lstatSync(real).isFile()) throw new Error('Not a regular file');
  allowedFiles.add(real);
  return real;
}
function isFileAuthorized(filePath) {
  try { return allowedFiles.has(fs.realpathSync(filePath)); }
  catch { return false; }
}

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

// The only legitimate IPC caller is the top frame of our local index.html.
// Reject anything else (injected sub-frames, a navigated origin) so a renderer
// compromise can't reach privileged handlers (irreversible deletes, file reads).
const { pathToFileURL } = require('url');
const RENDERER_URL = pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href;

function isTrustedSender(event) {
  const frame = event.senderFrame;
  if (!frame || frame.parent) return false;            // top frame only
  const url = frame.url || '';
  return url === RENDERER_URL || url.startsWith(RENDERER_URL + '#') || url.startsWith(RENDERER_URL + '?');
}

// Wrapper around ipcMain.handle that enforces isTrustedSender on every channel.
const _ipcHandle = ipcMain.handle.bind(ipcMain);
function handle(channel, fn) {
  _ipcHandle(channel, async (event, ...args) => {
    if (!isTrustedSender(event)) {
      logError('ipc-sender', new Error(`Rejected '${channel}' from untrusted sender ${event.senderFrame && event.senderFrame.url}`));
      return { success: false, error: 'Untrusted sender' };
    }
    return fn(event, ...args);
  });
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
handle('parse-pdf', async (event, filePath) => {
  try {
    if (!isFileAuthorized(filePath)) {
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
handle('open-external', async (event, url) => {
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
handle('register-statement-file', (event, filePath) => {
  try {
    const ext = path.extname(String(filePath)).toLowerCase();
    if (!['.pdf', '.csv', '.xlsx'].includes(ext)) {
      return { success: false, error: 'Unsupported file type' };
    }
    authorizeFile(filePath);   // realpath + must be a regular file
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: LunchMoney Assets ─────────────────────────────────────────────────
handle('get-lm-assets', async () => {
  try {
    const { getAssets } = require('./src/lunchmoney');
    const assets = await getAssets(activeApiKey());
    return { success: true, data: assets };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

handle('create-lm-asset', async (event, { assetData }) => {
  try {
    const { createAsset } = require('./src/lunchmoney');
    const asset = await createAsset(activeApiKey(), assetData);
    return { success: true, data: asset };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Payees ────────────────────────────────────────────────────────────
handle('get-lm-payees', async () => {
  try {
    const { getPayees } = require('./src/lunchmoney');
    const payees = await getPayees(activeApiKey());
    return { success: true, data: payees };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

handle('process-payees', async (event, { transactions, existingPayees }) => {
  try {
    const { processTransactions } = require('./src/payee-matcher');
    const result = processTransactions(transactions, existingPayees);
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Upload Transactions ───────────────────────────────────────────────
handle('upload-transactions', async (event, { transactions, assetId, skipDuplicates, applyRules }) => {
  try {
    const { uploadTransactions } = require('./src/lunchmoney');
    const result = await uploadTransactions(transactions, activeApiKey(), { assetId, skipDuplicates, applyRules });
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Payee Batch Update ─────────────────────────────────────────────────
handle('payee-update-batch', async (event, { updates }) => {
  try {
    const { batchUpdatePayees } = require('./src/lunchmoney');
    const result = await batchUpdatePayees(activeApiKey(), updates);
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Coverage (from LunchMoney) ────────────────────────────────────────
handle('get-asset-coverage', async (event, { assetId, year }) => {
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
handle('tracker-get-uploads',        async () => {
  try {
    const { getAllUploads } = require('./src/tracker');
    return getAllUploads();
  } catch (err) { logError('tracker-get-uploads', err); return []; }
});

handle('tracker-save-upload',        async (event, record) => {
  try {
    const { saveUpload } = require('./src/tracker');
    return saveUpload(record);
  } catch (err) { logError('tracker-save-upload', err); return { error: err.message }; }
});

handle('tracker-get-missing-months', async (event, accountId) => {
  try {
    const { getMissingMonths } = require('./src/tracker');
    return getMissingMonths(accountId);
  } catch (err) { logError('tracker-get-missing-months', err); return []; }
});

handle('tracker-get-all-accounts',  async () => {
  try {
    const { getAllAccounts } = require('./src/tracker');
    return getAllAccounts();
  } catch (err) { logError('tracker-get-all-accounts', err); return []; }
});

handle('tracker-get-db-coverage', async (event, { lmAssetId, year }) => {
  try {
    const { getDbCoverageForAsset } = require('./src/tracker');
    // Array of { month, expectedTxns } — see getDbCoverageForAsset.
    return getDbCoverageForAsset(lmAssetId, year);
  } catch (err) { logError('tracker-get-db-coverage', err); return []; }
});

handle('get-oldest-upload-year', async () => {
  const { getOldestUploadYear } = require('./src/tracker');
  const year = getOldestUploadYear();
  return { success: true, data: year };
});

// ─── IPC: Fix Flipped Signs (recover from pre-v1.2.18 sign bug) ─────────────
// Given a tracker upload id, flip the LunchMoney `amount` sign on every
// tx id stored in that upload's lm_ids. Sends progress events to the
// renderer so the UI can draw a progress bar. Marks the upload as fixed
// on success so it can't be run twice (protects against re-flipping).
handle('fix-flipped-signs', async (event, { uploadId }) => {
  try {
    const { getUpload, markSignsFixed, markSignsFixedForLmIds, getFixedLmIdSet } = require('./src/tracker');
    const { flipTransactionSigns } = require('./src/lunchmoney');

    const upload = getUpload(uploadId);
    if (!upload)               return { success: false, error: 'Upload not found' };
    if (upload.signs_fixed_at) return { success: false, error: 'Signs already fixed for this upload' };

    let lmIds = [];
    try { lmIds = JSON.parse(upload.lm_ids || '[]') || []; } catch { lmIds = []; }
    if (!Array.isArray(lmIds) || !lmIds.length) {
      return { success: false, error: 'No LunchMoney transaction IDs recorded for this upload' };
    }

    // Id-level guard: never re-flip a transaction already covered by a
    // signs-fixed record. Legacy batch records share one id list across every
    // file uploaded together, so without this, working up the history list
    // would flip the same set back and forth — and a partial failure leaves
    // sibling records unstamped (only annotated) yet still clickable.
    const fixedSet = getFixedLmIdSet();
    const toFlip = lmIds.map(Number).filter(id => !fixedSet.has(id));
    const alreadyCovered = lmIds.length - toFlip.length;

    if (!toFlip.length) {
      markSignsFixed(uploadId, new Date().toISOString());
      return { success: true, data: { ok: 0, failed: [], skipped: [], alreadyCovered } };
    }

    const result = await flipTransactionSigns(activeApiKey(), toFlip, progress => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('fix-flipped-signs:progress', { uploadId, ...progress });
      }
    });
    result.alreadyCovered = alreadyCovered;

    // Mark fixed even if some rows failed — prevents double-flips on retry.
    // The UI surfaces failures so the user can address them individually.
    markSignsFixed(uploadId, new Date().toISOString());

    // Records saved by pre-fix versions stored the WHOLE upload batch's ids on
    // every file's record (a batch of statements shared one id list). Stamp any
    // sibling record fully covered by what was just flipped, so clicking its
    // "Fix Signs" can't flip the same transactions straight back.
    try {
      const notOk = new Set([
        ...((result.failed  || []).map(f => Number(f.id))),
        ...((result.skipped || []).map(Number)),
      ]);
      markSignsFixedForLmIds(lmIds.map(Number).filter(id => !notOk.has(id)));
    } catch (e) { logError('fix-flipped-signs:mark-siblings', e); }

    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Flip Single Transaction (one-off correction from account view) ────
// Reuses flipTransactionSigns with a single-element array so we get the same
// retry/backoff and skip-if-deleted behaviour as the per-upload path.
handle('flip-single-transaction', async (event, { txId }) => {
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
handle('reconcile-statement', async (event, { assetId, filePath, year }) => {
  try {
    if (!isFileAuthorized(filePath)) {
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

    // Warn when the statement's own period doesn't fall in the selected year —
    // the comparison window then has no overlap and a clean "all match" result
    // would be misleading.
    const parsedYears = new Set(
      parsedTxs.map(t => (typeof t.date === 'string' ? t.date.slice(0, 4) : null)).filter(Boolean)
    );
    if (parsedTxs.length && !parsedYears.has(String(year))) {
      data.warning = `This statement's transactions are dated ${[...parsedYears].sort().join(', ')}, but you're reconciling against ${year}. Select the matching year.`;
    }

    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Apply Reconciliation — flip signs + delete phantoms ───────────────
handle('apply-reconciliation', async (event, { flipIds, deleteIds }) => {
  try {
    const { flipTransactionSigns, deleteTransaction } = require('./src/lunchmoney');
    const apiKey = activeApiKey();

    // Only accept integer LunchMoney transaction IDs. This prevents a crafted
    // renderer payload from injecting path fragments into the API URL (e.g.
    // "group/123" hitting DELETE /transactions/group/123). Cap the batch size.
    const cleanIds = (arr) => (Array.isArray(arr) ? arr : [])
      .map(Number).filter(Number.isInteger).slice(0, 1000);
    const flips   = cleanIds(flipIds);
    const deletes = cleanIds(deleteIds);

    // Structured result so the renderer can report exactly which rows failed
    // (irreversible deletes especially) rather than a bare count.
    const result = { flipped: 0, deleted: 0, failedFlips: [], skipped: [], failedDeletes: [] };

    if (flips.length) {
      const flipResult = await flipTransactionSigns(apiKey, flips, () => {});
      result.flipped = flipResult.ok || 0;
      if (flipResult.failed)  result.failedFlips = flipResult.failed;         // [{id, error}]
      if (flipResult.skipped) result.skipped     = flipResult.skipped;        // 404 in LM

      // Stamp tracker uploads covered by these corrections as signs-fixed so
      // the History "Fix Signs" action can't re-flip the now-correct entries.
      if (result.flipped > 0) {
        try {
          const { markSignsFixedForLmIds } = require('./src/tracker');
          const notOk = new Set([...result.failedFlips.map(f => f.id), ...result.skipped].map(Number));
          markSignsFixedForLmIds(flips.filter(id => !notOk.has(id)));
        } catch (e) { logError('apply-reconciliation:mark-signs-fixed', e); }
      }
    }

    for (const id of deletes) {
      try {
        await deleteTransaction(apiKey, id);
        result.deleted++;
      } catch (err) {
        result.failedDeletes.push({ id, error: err.message });
      }
    }

    result.errorCount = result.failedFlips.length + result.failedDeletes.length;
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: Account Transactions (for account summary view) ───────────────────
handle('get-account-transactions', async (event, { assetId, year }) => {
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

handle('lm-accounts:list', async () => {
  try {
    const { getAllAccounts } = require('./src/lm-accounts');
    return { success: true, data: getAllAccounts() };
  } catch (err) { logError('lm-accounts:list', err); return { success: false, error: err.message }; }
});

handle('lm-accounts:get-active', async () => {
  try {
    const { getActiveAccount } = require('./src/lm-accounts');
    return { success: true, data: publicAccount(getActiveAccount()) };
  } catch (err) { logError('lm-accounts:get-active', err); return { success: false, error: err.message }; }
});

/**
 * Validate an API key against LunchMoney /me, then save & activate the account.
 * Returns { success, data: { id, userName, budgetName } } or { success: false, error }.
 */
handle('lm-accounts:add', async (event, { label, apiKey }) => {
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

handle('lm-accounts:switch', async (event, id) => {
  try {
    const { setActiveAccount, getActiveAccount } = require('./src/lm-accounts');
    setActiveAccount(id);
    return { success: true, data: publicAccount(getActiveAccount()) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

handle('lm-accounts:remove', async (event, id) => {
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
handle('lm-accounts:migrate', async (event, { apiKey }) => {
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
handle('get-lm-categories', async () => {
  try {
    const { getCategories } = require('./src/lunchmoney');
    const cats = await getCategories(activeApiKey());
    return { success: true, data: cats };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: CSV Export ────────────────────────────────────────────────────────
handle('export-csv', async (event, { transactions, filename }) => {
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
handle('get-dashboard-data', async (event, { year, quarter }) => {
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
      const { getTaxParams, estimateAnnualTax } = require('./src/tax/s04');

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

      // Quarterly tax estimate — extrapolate YTD income to annual, apply S04 rates.
      // getTaxParams falls back to the nearest-earlier defined year (not a hard-
      // coded 2025), matching the S04/S04A path.
      const { params }    = getTaxParams(year);
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
handle('check-duplicates', async (event, { transactions }) => {
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

// ─── IPC: Classify Import — duplicate / sign-correction detection ────────────
// Supersedes check-duplicates in the validate modal: for each incoming row,
// reports whether a same-sign LM twin exists ('duplicate'), an opposite-sign
// twin exists ('signflip' — the row should correct that entry rather than be
// inserted, since LM's skip_duplicates matches signed amounts and a plain
// re-upload would add a second copy), or no match ('new').
handle('classify-import', async (event, { transactions }) => {
  const asNew = () => new Array((transactions || []).length).fill(null).map(() => ({ status: 'new' }));
  try {
    const { getTransactions }    = require('./src/lunchmoney');
    const { classifyImportRows } = require('./src/reconcile');
    const apiKey = activeApiKey();

    if (!apiKey || !transactions || !transactions.length) {
      return { success: true, data: asNew() };
    }

    // One API call per asset, matching within that asset's date window.
    const byAsset = {};
    transactions.forEach((tx, idx) => {
      const key = tx.assetId != null ? String(tx.assetId) : '__none__';
      if (!byAsset[key]) byAsset[key] = [];
      byAsset[key].push({ idx, date: tx.date, amount: tx.amount, payee: tx.payee });
    });

    const results = asNew();

    for (const [assetIdStr, items] of Object.entries(byAsset)) {
      // Rows mapped to "No account" can't be compared against an asset's
      // ledger — leave them 'new' (same policy as check-duplicates).
      if (assetIdStr === '__none__') continue;

      const dates = items.map(i => i.date).filter(Boolean).sort();
      if (!dates.length) continue;

      const existingTxs = await getTransactions(apiKey, {
        startDate: dates[0],
        endDate:   dates[dates.length - 1],
        assetId:   assetIdStr,
      });

      const classified = classifyImportRows(items, existingTxs);
      classified.forEach((c, i) => { results[items[i].idx] = c; });
    }

    return { success: true, data: results };
  } catch (err) {
    console.warn('[classify-import] error:', err.message);
    // Fail open as 'new' — never block an upload. If LM is unreachable here,
    // the upload itself would fail too, so the duplication hazard is moot.
    return { success: true, data: asNew() };
  }
});

// ─── IPC: S04 Tax ────────────────────────────────────────────────────────────
handle('generate-s04', async (event, { year, manualData, userCategoryMappings }) => {
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

handle('save-filing', async (event, payload) => {
  try {
    const { saveFiling } = require('./src/filings');
    const result = saveFiling(payload);
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

handle('get-filings', async () => {
  try {
    const { getAllFilings } = require('./src/filings');
    return { success: true, data: getAllFilings() };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

handle('update-filing', async (event, { id, ...fields }) => {
  try {
    const { updateFiling } = require('./src/filings');
    const updated = updateFiling(id, fields);
    return { success: true, data: updated };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

handle('delete-filing', async (event, id) => {
  try {
    const { deleteFiling } = require('./src/filings');
    deleteFiling(id);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

handle('generate-s04a', async (event, { currentYear, timezone }) => {
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
handle('tax-params:status', async (event, { timezone } = {}) => {
  try {
    const { taxParamsStatus } = require('./src/tax/s04');
    return { success: true, data: taxParamsStatus(resolveTodayStr(timezone)) };
  } catch (err) {
    logError('tax-params:status', err);
    return { success: false, error: err.message };
  }
});

// ─── IPC: P24 Employment Income Entries ──────────────────────────────────────

handle('p24:save', async (event, payload) => {
  try {
    const { saveEntry } = require('./src/p24');
    const result = saveEntry(payload);
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

handle('p24:get-for-year', async (event, year) => {
  try {
    const { getEntriesForYear } = require('./src/p24');
    return { success: true, data: getEntriesForYear(year) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

handle('p24:delete', async (event, id) => {
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
handle('export-s04-pdf', async (event, { htmlContent, filename }) => {
  const { BrowserWindow: BW } = require('electron');
  let printWin = null;
  let tmpDir = null;
  try {
    // Unique temp dir avoids the predictable-path clobber/symlink race and
    // lets us clean up deterministically.
    tmpDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'mitax-'));
    const tmpPath = path.join(tmpDir, 's04-print.html');
    // Inject a strict CSP so the report can't fetch remote sub-resources (a
    // crafted <img src="http://…"> would otherwise beacon out during printToPDF).
    // Allow only inline styles and data: images, which is all a report needs.
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">`;
    const html = /<head[\s>]/i.test(htmlContent)
      ? htmlContent.replace(/<head([\s>])/i, `<head$1${csp}`)
      : `<!doctype html><head>${csp}</head>${htmlContent}`;
    fs.writeFileSync(tmpPath, html, 'utf8');

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
handle('open-file-dialog', async () => {
  const { filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Statements', extensions: ['pdf', 'csv', 'xlsx'] }],
  });
  // Authorize the user-chosen paths for subsequent parse-pdf/reconcile calls.
  (filePaths || []).forEach(p => { try { authorizeFile(p); } catch (_) { /* skip unreadable */ } });
  return filePaths || [];
});
