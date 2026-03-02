/**
 * LunchMoney API Client
 * Docs: https://lunchmoney.dev
 */

const fetch = require('node-fetch');

const LM_BASE = 'https://dev.lunchmoney.app/v1';

// ─── API Helpers ────────────────────────────────────────────────────────────

async function lmRequest(method, endpoint, apiKey, body = null) {
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${LM_BASE}${endpoint}`, opts);
  const data = await res.json();

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
  const params = new URLSearchParams();
  if (startDate) params.append('start_date', startDate);
  if (endDate)   params.append('end_date',   endDate);
  if (assetId)   params.append('asset_id',   assetId);

  const data = await lmRequest('GET', `/transactions?${params}`, apiKey);
  return data.transactions || [];
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

  const BATCH_SIZE = 500;
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
};
