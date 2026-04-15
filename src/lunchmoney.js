/**
 * LunchMoney API Client
 * Docs: https://lunchmoney.dev
 */

const fetch = require('node-fetch');

const LM_BASE = 'https://dev.lunchmoney.app/v1';

// ─── API Helpers ────────────────────────────────────────────────────────────

// Retry budget for transient errors (429, 5xx). Delays: 1s, 2s, 4s.
const MAX_RETRIES   = 3;
const RETRY_BASE_MS = 1000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function lmRequest(method, endpoint, apiKey, body = null, attempt = 0) {
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${LM_BASE}${endpoint}`, opts);

  // Retry transient failures (rate limit, server errors) before parsing body.
  if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
    const delayMs = RETRY_BASE_MS * Math.pow(2, attempt); // 1s, 2s, 4s
    console.warn(`[LunchMoney] ${method} ${endpoint} → ${res.status}; retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
    await sleep(delayMs);
    return lmRequest(method, endpoint, apiKey, body, attempt + 1);
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = data.error || data.message || `HTTP ${res.status}`;
    throw new Error(`LunchMoney API error: ${msg}`);
  }
  return data;
}

// ─── User / Me ───────────────────────────────────────────────────────────────

/**
 * Fetch the authenticated user's profile.
 * Returns { user_name, budget_name, primary_currency, api_key_label, ... }
 */
async function getMe(apiKey) {
  return lmRequest('GET', '/me', apiKey);
}

// ─── Assets ─────────────────────────────────────────────────────────────────

async function getAssets(apiKey) {
  const data = await lmRequest('GET', '/assets', apiKey);
  return data.assets || [];
}

/**
 * Create a new manual asset (account) in LunchMoney.
 * Supports all native LunchMoney asset fields.
 *
 * type_name (required): "cash" | "credit" | "investment" | "other" |
 *   "real estate" | "loan" | "vehicle" | "cryptocurrency" | "employee compensation"
 * subtype_name (optional, max 25 chars): "checking" | "savings" | "retirement" |
 *   "prepaid credit card" | any custom string
 */
async function createAsset(apiKey, {
  name,
  displayName,
  typeName,
  subtypeName,
  currency,
  institutionName,
  balance = 0,
  balanceAsOf,
  closedOn,
  excludeTransactions = false,
}) {
  const body = {
    name,
    type_name:            typeName || 'cash',
    currency:             (currency || 'JMD').toLowerCase(),
    balance:              String(balance),
    exclude_transactions: excludeTransactions,
  };
  if (displayName)    body.display_name      = displayName;
  if (subtypeName)    body.subtype_name      = subtypeName.substring(0, 25);
  if (institutionName) body.institution_name = institutionName.substring(0, 50);
  if (balanceAsOf)    body.balance_as_of     = balanceAsOf;
  if (closedOn)       body.closed_on         = closedOn;

  const data = await lmRequest('POST', '/assets', apiKey, body);
  return data;
}

// ─── Categories ──────────────────────────────────────────────────────────────

async function getCategories(apiKey) {
  const data = await lmRequest('GET', '/categories', apiKey);
  return data.categories || [];
}

// ─── Payees ──────────────────────────────────────────────────────────────────

/**
 * Fetch distinct payees from recent LunchMoney transactions (last 180 days).
 * Returns an array of unique payee strings.
 */
async function getPayees(apiKey) {
  const end = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  try {
    const txs = await getTransactions(apiKey, { startDate, endDate: end });
    const seen = new Set();
    const payees = [];
    for (const tx of txs) {
      const p = (tx.payee || '').trim();
      if (p && !seen.has(p.toLowerCase())) {
        seen.add(p.toLowerCase());
        payees.push(p);
      }
    }
    return payees.sort();
  } catch {
    return [];
  }
}

// ─── Transactions ────────────────────────────────────────────────────────────

async function getTransactions(apiKey, { startDate, endDate, assetId } = {}) {
  // LunchMoney paginates with `limit`/`offset`; we fetch every page and
  // concatenate. Loop cap is defensive — 500 pages × 500 = 250,000 rows.
  const PAGE_SIZE = 500;
  const MAX_PAGES = 500;

  const all = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams();
    if (startDate) params.append('start_date', startDate);
    if (endDate)   params.append('end_date',   endDate);
    if (assetId)   params.append('asset_id',   assetId);
    params.append('limit',  String(PAGE_SIZE));
    params.append('offset', String(page * PAGE_SIZE));

    const data = await lmRequest('GET', `/transactions?${params}`, apiKey);
    const batch = data.transactions || [];
    all.push(...batch);

    // Prefer explicit has_more flag if server returns one; otherwise fall
    // back to "batch shorter than page size means we're done".
    if (data.has_more === false) break;
    if (batch.length < PAGE_SIZE) break;
  }
  return all;
}

/**
 * For the Coverage Tracker: returns a 12-month coverage map for a given asset + year.
 * Each month: { month, year, count, hasTxns, dates: [] }
 *
 * One API call per year (not 12) — fetch the full year, group by month.
 * This correctly handles overlap: a Dec-Jan statement uploads Dec txns in Dec and Jan txns in Jan.
 */
async function getAssetMonthCoverage(apiKey, assetId, year) {
  const startDate = `${year}-01-01`;
  const endDate   = `${year}-12-31`;

  let txs = [];
  try {
    txs = await getTransactions(apiKey, { startDate, endDate, assetId });
  } catch {
    // Asset may have no transactions or API error — return empty
  }

  // Group by month
  const months = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    year,
    count: 0,
    hasTxns: false,
    earliestDate: null,
    latestDate: null,
  }));

  for (const tx of txs) {
    if (!tx.date) continue;
    const m = parseInt(tx.date.split('-')[1], 10) - 1;
    if (m < 0 || m > 11) continue;
    months[m].count++;
    months[m].hasTxns = true;
    if (!months[m].earliestDate || tx.date < months[m].earliestDate) months[m].earliestDate = tx.date;
    if (!months[m].latestDate   || tx.date > months[m].latestDate)   months[m].latestDate   = tx.date;
  }

  return months;
}

/**
 * Get coverage for all assets in a given year (one call per asset).
 * Returns { assetId: monthArray[] }
 */
async function getAllAssetsCoverage(apiKey, assets, year) {
  const result = {};
  for (const asset of assets) {
    result[asset.id] = await getAssetMonthCoverage(apiKey, asset.id, year);
  }
  return result;
}

// ─── Upload Transactions ─────────────────────────────────────────────────────

/**
 * Upload normalised transactions to LunchMoney.
 *
 * LunchMoney field mapping:
 *   payee   → displayed name (matched/guessed merchant)
 *   notes   → the original bank description
 *   amount  → signed number (positive = expense/debit, negative = income/credit)
 *   date    → YYYY-MM-DD
 *   currency→ lowercase ISO code
 */
async function uploadTransactions(transactions, apiKey, options = {}) {
  const { assetId, skipDuplicates = true, applyRules = true } = options;

  const lmTransactions = transactions.map(tx => {
    const obj = {
      date:     tx.date,
      payee:    (tx.payee || 'Unknown').substring(0, 140),
      amount:   String(tx.amount),          // signed; positive = outflow
      currency: (tx.currency || 'JMD').toLowerCase(),
      notes:    (tx.notes || '').substring(0, 350),
      status:   'cleared',
    };
    if (assetId)        obj.asset_id    = assetId;
    if (tx.categoryId)  obj.category_id = tx.categoryId;
    return obj;
  });

  // LunchMoney caps transaction inserts at 500 per request; use 499 to leave
  // headroom for any server-side counting idiosyncrasies.
  const BATCH_SIZE = 499;
  const results = [];

  for (let i = 0; i < lmTransactions.length; i += BATCH_SIZE) {
    const batch = lmTransactions.slice(i, i + BATCH_SIZE);
    const payload = {
      transactions: batch,
      check_for_recurring: false,
      debit_as_negative:   false,   // we handle sign ourselves
      skip_duplicates:     skipDuplicates,
      apply_rules:         applyRules,
    };
    try {
      const r = await lmRequest('POST', '/transactions', apiKey, payload);
      results.push(r);
    } catch (err) {
      results.push({ error: err.message, batch_index: i });
    }
  }

  const ids        = results.flatMap(r => r.ids        || []);
  const errors     = results.filter( r => r.error).map(r => r.error);
  const duplicates = results.flatMap(r => r.duplicates || []);

  return {
    uploaded:   ids.length,
    ids,
    duplicates: duplicates.length,
    errors,
    success:    errors.length === 0,
  };
}

// ─── CSV Export ──────────────────────────────────────────────────────────────

function formatAsCSV(transactions) {
  const header = ['Date', 'Payee', 'Amount', 'Currency', 'Notes', 'Category'];
  const rows = transactions.map(tx => [
    tx.date || '',
    escapeCsv(tx.payee || ''),
    tx.amount != null ? String(tx.amount) : '0',
    (tx.currency || 'JMD').toUpperCase(),
    escapeCsv(tx.notes || ''),
    escapeCsv(tx.category || ''),
  ]);
  return [header, ...rows].map(r => r.join(',')).join('\n');
}

function escapeCsv(str) {
  str = String(str || '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// ─── Tax helper ──────────────────────────────────────────────────────────────

async function getTransactionsByYear(apiKey, year) {
  return getTransactions(apiKey, {
    startDate: `${year}-01-01`,
    endDate:   `${year}-12-31`,
  });
}

// ─── Single-transaction read / update ────────────────────────────────────────

/**
 * Fetch a single transaction by ID.
 * GET /v1/transactions/:id
 */
async function getTransaction(apiKey, txId) {
  return lmRequest('GET', `/transactions/${txId}`, apiKey);
}

/**
 * Update a single transaction's editable fields (payee, notes, category_id,
 * amount, etc.)  PUT /v1/transactions/:id
 */
async function updateTransaction(apiKey, txId, fields) {
  return lmRequest('PUT', `/transactions/${txId}`, apiKey, { transaction: fields });
}

/**
 * Flip the sign of the `amount` on every transaction in `txIds`.
 *
 * Used to recover from the pre-v1.2.18 debit/credit sign-flip bug without
 * re-uploading statements: for each id, GET current amount → PUT `-amount`.
 * Sequential to respect LM rate limits (lmRequest retries 429/5xx).
 *
 * `onProgress({ done, total })` is called after each row so the renderer can
 * draw a progress bar. Transactions deleted in LM (404) count as `skipped`
 * rather than failing the batch.
 *
 * Returns { ok, failed: [{id, error}], skipped }.
 */
async function flipTransactionSigns(apiKey, txIds, onProgress) {
  const result = { ok: 0, failed: [], skipped: 0 };
  const total  = txIds.length;

  for (let i = 0; i < total; i++) {
    const id = txIds[i];
    try {
      const tx = await getTransaction(apiKey, id);
      // LM returns the tx fields at the top level for this endpoint; tolerate
      // a wrapped { transaction: {...} } shape defensively.
      const current = tx && (tx.amount != null ? tx : tx.transaction);
      const amt     = current && parseFloat(current.amount);
      if (!Number.isFinite(amt) || amt === 0) {
        result.skipped++;
      } else {
        await updateTransaction(apiKey, id, { amount: String(-amt) });
        result.ok++;
      }
    } catch (err) {
      if (/HTTP 404|not found/i.test(err.message || '')) {
        result.skipped++;
      } else {
        result.failed.push({ id, error: err.message || String(err) });
      }
    }
    if (typeof onProgress === 'function') {
      try { onProgress({ done: i + 1, total }); } catch { /* ignore */ }
    }
  }

  return result;
}

/**
 * Batch-update payees for an array of { id, payee } objects.
 * Processes sequentially to stay within API rate limits.
 * Returns { updated: number, errors: [] }
 */
async function batchUpdatePayees(apiKey, updates) {
  const errors = [];
  let updated = 0;
  for (const { id, payee } of updates) {
    try {
      await updateTransaction(apiKey, id, { payee });
      updated++;
    } catch (err) {
      errors.push({ id, error: err.message });
    }
  }
  return { updated, errors };
}

module.exports = {
  getMe,
  getAssets,
  createAsset,
  getCategories,
  getPayees,
  getTransactions,
  getTransactionsByYear,
  getAssetMonthCoverage,
  getAllAssetsCoverage,
  uploadTransactions,
  formatAsCSV,
  getTransaction,
  updateTransaction,
  flipTransactionSigns,
  batchUpdatePayees,
};
