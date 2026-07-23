/**
 * LunchMoney API Client
 * Docs: https://lunchmoney.dev
 */

const fetch = require('node-fetch');

const LM_BASE = 'https://dev.lunchmoney.app/v1';

// ─── API Helpers ────────────────────────────────────────────────────────────

// Retry budget for transient errors (network blips, 429, 5xx). Delays: 1s, 2s, 4s.
const MAX_RETRIES   = 3;
const RETRY_BASE_MS = 1000;
// Per-request timeout so a stalled connection can't hang the UI indefinitely.
const REQUEST_TIMEOUT_MS = 30000;

// Node-level network errors that are worth retrying — DNS blips (common on
// Windows / flaky Wi-Fi), TCP resets, connection timeouts, etc. We avoid
// blanket-retrying all errors so that 4xx responses (which throw via
// `res.ok` check below) still fail fast.
const RETRYABLE_NET_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN',    // DNS resolution failed / temporarily unavailable
  'ECONNRESET', 'ECONNREFUSED',
  'ETIMEDOUT', 'ESOCKETTIMEDOUT',
  'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
]);

/**
 * Classify a LunchMoney API failure into a short, actionable hint. Every
 * lmRequest() throw site appends this to the raw error message, so every
 * consumer — IPC handler responses, error banners, toasts — gets the same
 * useful context automatically instead of a bare "failed" that sends the
 * user (and us) hunting for the actual cause.
 */
function describeLmFailure(err) {
  if (!err) return null;
  const status = err.status;
  const code   = err.code;
  const msg    = String(err.message || '');

  if (status === 401 || status === 403) {
    return 'Your LunchMoney API key may be invalid, expired, or revoked — reconnect it in Settings.';
  }
  if (status === 429) {
    return 'LunchMoney is rate-limiting requests — wait a moment and try again.';
  }
  if (typeof status === 'number' && status >= 500) {
    return "LunchMoney's servers returned an error — this is usually temporary; try again shortly.";
  }
  if ((code && RETRYABLE_NET_CODES.has(code)) || /premature close|timed out/i.test(msg)) {
    return 'This looks like a network problem between this device and LunchMoney (unstable connection, VPN, or firewall) rather than a problem with your data — try again, or check your connection.';
  }
  if (/non-JSON response|no "transactions" array/i.test(msg)) {
    return 'LunchMoney returned an unexpected response — this may be a temporary server issue; try again, and if it persists this is worth reporting.';
  }
  return null;
}

/** Append describeLmFailure's hint to an error's message, in place, and return it. */
function appendFailureHint(err) {
  if (!err) return err;
  const hint = describeLmFailure(err);
  if (hint && !String(err.message || '').includes(hint)) {
    err.message = `${err.message} — ${hint}`;
  }
  return err;
}

function isRetryableNetworkError(err) {
  if (!err) return false;
  if (err.code && RETRYABLE_NET_CODES.has(err.code)) return true;
  // node-fetch wraps underlying network errors in FetchError; the original
  // code is preserved on `err.code`, but some variants only expose it in the
  // message. Check the message as a fallback.
  const msg = String(err.message || '');
  for (const code of RETRYABLE_NET_CODES) {
    if (msg.includes(code)) return true;
  }
  return false;
}

// A response body stream can fail AFTER headers arrive and connection-phase
// errors have already passed — the connection closes (proxy/VPN/keep-alive
// hiccup, server-side timeout on a larger response) mid-read. Node surfaces
// this as ERR_STREAM_PREMATURE_CLOSE / "Premature close", which is a
// completely different failure point from isRetryableNetworkError above (that
// only covers the initial fetch() call) and was previously going unhandled —
// worse, a naive `.json().catch(() => ({}))` swallowed it into a fake empty
// success, which is what made real transactions disappear as "no data".
function isRetryableBodyError(err) {
  if (!err) return false;
  if (err.code === 'ERR_STREAM_PREMATURE_CLOSE') return true;
  if (/premature close/i.test(String(err.message || ''))) return true;
  return isRetryableNetworkError(err);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Parse a Retry-After header into milliseconds. Accepts delta-seconds
// ("120") or an HTTP-date; returns null when absent/unparseable so the caller
// falls back to its own backoff. Never returns negative.
function parseRetryAfter(value) {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(value);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return null;
}

async function lmRequest(method, endpoint, apiKey, body = null, attempt = 0) {
  const isIdempotent = method === 'GET';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      // Mitigations for "Premature close" on larger responses (e.g. a full
      // year of transactions), never seen on small ones (e.g. /assets):
      //  - Accept-Encoding: identity + compress:false — a common cause of
      //    this exact failure signature is a gzip stream whose final
      //    trailer bytes get truncated by an intermediary (proxy/AV/CDN);
      //    Node's zlib decoder is strict and throws even though the actual
      //    JSON payload arrived intact. Requesting uncompressed responses
      //    removes that failure mode entirely.
      //  - Connection: close — rules out a stale pooled keep-alive socket
      //    (closed server-side, silently reused client-side) as a cause.
      'Accept-Encoding': 'identity',
      Connection: 'close',
    },
    compress: false,
    signal: controller.signal,
  };
  if (body) opts.body = JSON.stringify(body);

  let res;
  try {
    res = await fetch(`${LM_BASE}${endpoint}`, opts);
  } catch (err) {
    // A timeout abort surfaces as an AbortError — retry it like a transient
    // network failure (no response was received, so it's safe to re-send).
    const isTimeout = err && (err.name === 'AbortError' || err.type === 'aborted');
    if ((isTimeout || isRetryableNetworkError(err)) && attempt < MAX_RETRIES) {
      const delayMs = RETRY_BASE_MS * Math.pow(2, attempt); // 1s, 2s, 4s
      console.warn(`[LunchMoney] ${method} ${endpoint} → ${isTimeout ? 'timeout' : (err.code || err.message)}; retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(delayMs);
      return lmRequest(method, endpoint, apiKey, body, attempt + 1);
    }
    if (isTimeout) throw appendFailureHint(new Error(`LunchMoney request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    throw appendFailureHint(err);
  } finally {
    clearTimeout(timer);
  }

  // Retry rate limits on any method (the request was not processed). Retry 5xx
  // only for idempotent GETs — re-sending a POST that the server may have
  // already committed would duplicate transactions (e.g. an upload batch).
  const retryable = res.status === 429 || (res.status >= 500 && isIdempotent);
  if (retryable && attempt < MAX_RETRIES) {
    // Honour Retry-After (seconds, or an HTTP-date) on a 429; otherwise use the
    // exponential backoff. Cap it so a hostile/huge value can't hang the UI.
    const backoff = RETRY_BASE_MS * Math.pow(2, attempt); // 1s, 2s, 4s
    const delayMs = Math.min(parseRetryAfter(res.headers.get('retry-after')) ?? backoff, 60000);
    console.warn(`[LunchMoney] ${method} ${endpoint} → ${res.status}; retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
    await sleep(delayMs);
    return lmRequest(method, endpoint, apiKey, body, attempt + 1);
  }

  // Read as text first (not .json()) so a non-JSON body — an HTML error page
  // from a proxy/WAF, an empty body, a truncated response — can be shown
  // verbatim in the thrown error instead of being silently swallowed into
  // `{}` and misread downstream as "the request succeeded with no data".
  let rawText;
  try {
    rawText = await res.text();
  } catch (err) {
    // Body-stream failure (e.g. "Premature close") — a different failure
    // point from the connection-phase retry above, since it only surfaces
    // once headers have already arrived and reading the body begins. Retry
    // like any other transient network error, but only for idempotent GETs:
    // the request itself was already fully sent by this point, so retrying
    // a POST risks re-submitting (e.g. duplicating an upload batch).
    if (isIdempotent && isRetryableBodyError(err) && attempt < MAX_RETRIES) {
      const delayMs = RETRY_BASE_MS * Math.pow(2, attempt); // 1s, 2s, 4s
      console.warn(`[LunchMoney] ${method} ${endpoint} → body read failed (${err.message}); retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(delayMs);
      return lmRequest(method, endpoint, apiKey, body, attempt + 1);
    }
    const wrapped = new Error(
      `LunchMoney response body could not be read for ${method} ${endpoint.split('?')[0]} ` +
      `(HTTP ${res.status}) after ${attempt} retr${attempt === 1 ? 'y' : 'ies'}: ${err.message}`
    );
    wrapped.status = res.status;
    throw appendFailureHint(wrapped);
  }

  let data;
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch (_parseErr) {
    const err = new Error(
      `LunchMoney returned a non-JSON response for ${method} ${endpoint.split('?')[0]} ` +
      `(HTTP ${res.status}): ${rawText ? rawText.slice(0, 300) : '(empty body)'}`
    );
    err.status = res.status;
    throw appendFailureHint(err);
  }

  if (!res.ok) {
    const msg = data.error || data.message || `HTTP ${res.status}`;
    const err = new Error(`LunchMoney API error: ${msg}`);
    err.status = res.status;   // let callers distinguish auth (401/403) from other failures
    throw appendFailureHint(err);
  }

  // LunchMoney v1 returns HTTP 200 with an `error` field in the body when it
  // rejects a request (e.g. an invalid parameter). Treating that as success
  // let `data.transactions || []` silently turn rejections into "no
  // transactions" — every list-based view showed $0 while balances worked.
  // Surface it as a real error so the UI shows LunchMoney's actual message.
  if (data && data.error) {
    const msg = Array.isArray(data.error) ? data.error.join('; ') : String(data.error);
    const err = new Error(`LunchMoney API error (${method} ${endpoint.split('?')[0]}): ${msg}`);
    err.status = res.status;
    throw appendFailureHint(err);
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

/** Fetch Plaid-synced (bank-linked) accounts. GET /v1/plaid_accounts */
async function getPlaidAccounts(apiKey) {
  const data = await lmRequest('GET', '/plaid_accounts', apiKey);
  return data.plaid_accounts || [];
}

/**
 * Merged account list: manually-managed assets AND Plaid-synced accounts,
 * normalized to one shape and tagged with `source: 'asset' | 'plaid'`.
 *
 * The two live in different id namespaces and different transaction filters
 * (`asset_id` vs `plaid_account_id`), so every consumer must carry `source`
 * alongside `id`. Statement uploads can only target manual assets — the API
 * does not allow inserting transactions into Plaid accounts — but viewing,
 * coverage, and reconcile work for both.
 */
async function getAllLmAccounts(apiKey) {
  const [assets, plaid] = await Promise.all([
    getAssets(apiKey),
    // A budget with no Plaid connection may 404/vary — degrade to assets-only.
    getPlaidAccounts(apiKey).catch(() => []),
  ]);
  return [
    ...assets.map(a => ({ ...a, source: 'asset' })),
    ...plaid.map(p => ({
      id:               p.id,
      name:             p.name,
      display_name:     p.display_name || p.name,
      institution_name: p.institution_name,
      currency:         p.currency,
      balance:          p.balance,
      balance_as_of:    p.balance_last_update || p.balance_as_of,
      type_name:        p.type,
      subtype_name:     p.subtype,
      status:           p.status,
      source:           'plaid',
    })),
  ];
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
  // No fail-open here: a genuinely empty payee list (200 with 0 transactions)
  // never throws — anything that throws is a real failure (auth, network,
  // malformed response) and must propagate so the caller can tell the user
  // payee matching is degraded, rather than silently importing with an
  // empty list that looks identical to "you have no recent transactions".
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
}

// ─── Transactions ────────────────────────────────────────────────────────────

async function getTransactions(apiKey, { startDate, endDate, assetId, plaidAccountId } = {}) {
  // LunchMoney paginates with `limit`/`offset`; we fetch every page and
  // concatenate. PAGE_SIZE is deliberately well under LunchMoney's 500 max —
  // a smaller response is less likely to trip a "Premature close" on a
  // response-size-sensitive network intermediary or a slow server-side query
  // for a heavily active account/date range; the offset loop below already
  // makes this fully transparent to every caller regardless of page count.
  // Loop cap is defensive — 2500 pages × 100 = 250,000 rows (same ceiling as
  // before the page size was reduced).
  const PAGE_SIZE = 100;
  const MAX_PAGES = 2500;

  const all = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams();
    if (startDate) params.append('start_date', startDate);
    if (endDate)   params.append('end_date',   endDate);
    // Manual assets and Plaid-synced accounts are different id namespaces
    // with different filter params — pass exactly one.
    if (assetId)             params.append('asset_id',         assetId);
    else if (plaidAccountId) params.append('plaid_account_id', plaidAccountId);
    // Pin the sign convention explicitly so reconcile/flip logic never rides on
    // LunchMoney's account-level default (negative = expense, positive = income).
    params.append('debit_as_negative', 'true');
    params.append('limit',  String(PAGE_SIZE));
    params.append('offset', String(page * PAGE_SIZE));

    const data = await lmRequest('GET', `/transactions?${params}`, apiKey);
    // A missing array is a response-shape problem, not "no transactions" —
    // never let it masquerade as an empty ledger. Include the actual body
    // shape (keys + a snippet) so a genuinely unexpected shape is visible
    // rather than just its absence.
    if (!Array.isArray(data.transactions)) {
      const keys = Object.keys(data || {});
      const snippet = JSON.stringify(data).slice(0, 300);
      throw new Error(
        `Unexpected LunchMoney response for GET /transactions: no "transactions" array in body ` +
        `(keys present: [${keys.join(', ')}]). Body: ${snippet}`
      );
    }
    const batch = data.transactions;
    all.push(...batch);

    // Prefer explicit has_more flag if server returns one; otherwise fall
    // back to "batch shorter than page size means we're done".
    if (data.has_more === false) break;
    if (batch.length < PAGE_SIZE) break;
  }
  return all;
}

/**
 * Resolve a transaction's signed amount in the primary currency.
 *
 * `to_base` (LunchMoney's primary-currency-converted amount) does not
 * reliably honor the `debit_as_negative` request parameter the way `amount`
 * does — it appears to follow the account's own native/default sign
 * convention regardless of what was requested. Every fetch in this app pins
 * `debit_as_negative=true` (see getTransactions), so `amount`'s SIGN is
 * trustworthy; `to_base` is used only for its MAGNITUDE, to get correct
 * multi-currency conversion. Falls back entirely to `amount` when `to_base`
 * is absent (same-currency transactions) or unparseable.
 *
 * This is the single point every consumer (S04, dashboard, reconcile, the
 * account summary view) must go through — reading `to_base` directly for
 * both sign and magnitude silently inverted credits/debits for any account
 * whose native convention disagreed with ours.
 */
function resolveTxAmount(tx) {
  const amount = parseFloat(tx && tx.amount);
  if (!Number.isFinite(amount) || amount === 0) return 0;

  const base = tx.to_base != null ? parseFloat(tx.to_base) : NaN;
  const magnitude = Number.isFinite(base) ? Math.abs(base) : Math.abs(amount);

  return amount > 0 ? magnitude : -magnitude;
}

/**
 * Diagnostic: which years actually contain transactions (optionally scoped to
 * one account)? Used when a year-scoped query returns nothing so the UI can
 * say "this account has data in 2025/2026" instead of a bare empty state —
 * the signature of statements uploaded with wrong transaction years.
 * Returns { "2026": 37, "2025": 12, ... }.
 */
async function getTransactionYearSummary(apiKey, { assetId, plaidAccountId } = {}) {
  const txs = await getTransactions(apiKey, {
    startDate: '1990-01-01',
    endDate:   '2100-12-31',
    assetId,
    plaidAccountId,
  });
  const byYear = {};
  for (const t of txs) {
    const y = (t.date || '').slice(0, 4);
    if (/^\d{4}$/.test(y)) byYear[y] = (byYear[y] || 0) + 1;
  }
  return byYear;
}

/**
 * For the Coverage Tracker: returns a 12-month coverage map for a given asset + year.
 * Each month: { month, year, count, hasTxns, dates: [] }
 *
 * One API call per year (not 12) — fetch the full year, group by month.
 * This correctly handles overlap: a Dec-Jan statement uploads Dec txns in Dec and Jan txns in Jan.
 */
async function getAssetMonthCoverage(apiKey, accountRef, year) {
  const startDate = `${year}-01-01`;
  const endDate   = `${year}-12-31`;

  // accountRef: a bare asset id (legacy callers) or { assetId, plaidAccountId }.
  const ref = (accountRef && typeof accountRef === 'object')
    ? accountRef
    : { assetId: accountRef };

  // No fail-open here: getTransactions() only ever returns [] for a
  // GENUINELY empty result — anything it throws (auth, network, malformed
  // response) is a real failure and must propagate. Swallowing it here used
  // to render as an all-months-missing coverage grid identical in appearance
  // to an account that really has no statements uploaded.
  const txs = await getTransactions(apiKey, { startDate, endDate, ...ref });

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
 *   amount  → signed number (negative = expense/debit, positive = income/credit)
 *   date    → YYYY-MM-DD
 *   currency→ lowercase ISO code
 */
async function uploadTransactions(transactions, apiKey, options = {}) {
  const { assetId, skipDuplicates = true, applyRules = true } = options;

  const lmTransactions = transactions.map(tx => {
    const obj = {
      date:     tx.date,
      payee:    (tx.payee || 'Unknown').substring(0, 140),
      amount:   String(tx.amount),          // signed; negative = outflow
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
      debit_as_negative:   true,    // negative = expense/debit, positive = income/credit
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
  return lmRequest('GET', `/transactions/${encodeURIComponent(txId)}`, apiKey);
}

/**
 * Update a single transaction's editable fields (payee, notes, category_id,
 * amount, etc.)  PUT /v1/transactions/:id
 */
async function updateTransaction(apiKey, txId, fields) {
  return lmRequest('PUT', `/transactions/${encodeURIComponent(txId)}`, apiKey, { transaction: fields });
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
 * Returns { ok, failed: [{id, error}], skipped: [id, ...] }.
 */
async function flipTransactionSigns(apiKey, txIds, onProgress) {
  const result = { ok: 0, failed: [], skipped: [] };
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
        result.skipped.push(id);
      } else {
        await updateTransaction(apiKey, id, { amount: String(-amt) });
        result.ok++;
      }
    } catch (err) {
      if (/HTTP 404|not found/i.test(err.message || '')) {
        result.skipped.push(id);
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
 * Delete a single transaction by ID.
 * Calls the LM API endpoint: DELETE /v1/transactions/:id
 */
async function deleteTransaction(apiKey, txId) {
  return lmRequest('DELETE', `/transactions/${encodeURIComponent(txId)}`, apiKey);
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
  describeLmFailure,
  resolveTxAmount,
  getTransactions,
  getTransactionsByYear,
  getPlaidAccounts,
  getAllLmAccounts,
  getTransactionYearSummary,
  getAssetMonthCoverage,
  getAllAssetsCoverage,
  uploadTransactions,
  formatAsCSV,
  getTransaction,
  updateTransaction,
  flipTransactionSigns,
  deleteTransaction,
  batchUpdatePayees,
};
