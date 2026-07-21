/**
 * Upload Tracker — SQLite-backed persistence for uploaded statements.
 * Tracks: which accounts have been uploaded, which months are covered, and upload history.
 */

const path = require('path');
const { app } = require('electron');
const { yearMonthOf, yearOf, eachMonthInRange } = require('./date-utils');

let db = null;

function getDB() {
  if (db) return db;

  const Database = require('better-sqlite3');
  const dbPath = path.join(app.getPath('userData'), 'lunchmoney-tracker.db');
  db = new Database(dbPath);
  initSchema(db);
  migrateSchema(db);
  return db;
}

// Add columns introduced after the initial schema. Safe to re-run — checks
// the current column list before ALTER TABLE. Keep this additive-only.
function migrateSchema(db) {
  const cols = db.prepare(`PRAGMA table_info(uploads)`).all().map(c => c.name);
  if (!cols.includes('signs_fixed_at')) {
    db.exec(`ALTER TABLE uploads ADD COLUMN signs_fixed_at TEXT`);
  }
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      institution TEXT NOT NULL,
      account_name TEXT NOT NULL,
      account_type TEXT NOT NULL,
      currency    TEXT NOT NULL DEFAULT 'JMD',
      lm_asset_id INTEGER,
      created_at  TEXT DEFAULT (datetime('now')),
      UNIQUE(institution, account_name)
    );

    CREATE TABLE IF NOT EXISTS uploads (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id   INTEGER NOT NULL REFERENCES accounts(id),
      filename     TEXT NOT NULL,
      period_start TEXT,
      period_end   TEXT,
      year         INTEGER,
      month        INTEGER,
      tx_count     INTEGER DEFAULT 0,
      lm_ids       TEXT,
      status       TEXT DEFAULT 'pending',
      uploaded_at  TEXT DEFAULT (datetime('now')),
      notes        TEXT
    );

    CREATE TABLE IF NOT EXISTS monthly_coverage (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      year       INTEGER NOT NULL,
      month      INTEGER NOT NULL,
      upload_id  INTEGER REFERENCES uploads(id),
      covered    INTEGER DEFAULT 1,
      UNIQUE(account_id, year, month)
    );

    CREATE INDEX IF NOT EXISTS idx_uploads_account ON uploads(account_id);
    CREATE INDEX IF NOT EXISTS idx_coverage_account ON monthly_coverage(account_id, year);
  `);
}

// ─── Account operations ─────────────────────────────────────────────────────

function upsertAccount({ institution, accountName, accountType, currency, lmAssetId }) {
  const db = getDB();
  const existing = db.prepare(
    'SELECT id FROM accounts WHERE institution = ? AND account_name = ?'
  ).get(institution, accountName);

  if (existing) {
    if (lmAssetId) {
      db.prepare('UPDATE accounts SET lm_asset_id = ? WHERE id = ?').run(lmAssetId, existing.id);
    }
    return existing.id;
  }

  const result = db.prepare(
    'INSERT INTO accounts (institution, account_name, account_type, currency, lm_asset_id) VALUES (?, ?, ?, ?, ?)'
  ).run(institution, accountName, accountType || 'unknown', currency || 'JMD', lmAssetId || null);

  return result.lastInsertRowid;
}

function getAllAccounts() {
  const db = getDB();
  return db.prepare('SELECT * FROM accounts ORDER BY institution, account_name').all();
}

function getAccount(id) {
  const db = getDB();
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
}

// ─── Upload operations ──────────────────────────────────────────────────────

function saveUpload({ institution, accountName, accountType, currency, lmAssetId, filename, period, txCount, lmIds, status, notes }) {
  const db = getDB();

  const accountId = upsertAccount({ institution, accountName, accountType, currency, lmAssetId });

  const { start, end, year, month } = period || {};

  const result = db.prepare(`
    INSERT INTO uploads (account_id, filename, period_start, period_end, year, month, tx_count, lm_ids, status, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    accountId,
    filename,
    start || null,
    end || null,
    year || null,
    month || null,
    txCount || 0,
    lmIds ? JSON.stringify(lmIds) : null,
    status || 'uploaded',
    notes || null,
  );

  const uploadId = result.lastInsertRowid;

  // Update monthly coverage — if year and month are known, mark it covered
  if (year && month) {
    markMonthCovered(accountId, year, month, uploadId);
  } else if (start && end) {
    // Cover all months in range (timezone-safe integer month arithmetic)
    for (const { year: y, month: m } of eachMonthInRange(start, end)) {
      markMonthCovered(accountId, y, m, uploadId);
    }
  }

  return { uploadId, accountId };
}

function markMonthCovered(accountId, year, month, uploadId) {
  const db = getDB();
  db.prepare(`
    INSERT INTO monthly_coverage (account_id, year, month, upload_id, covered)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(account_id, year, month) DO UPDATE SET covered=1, upload_id=?
  `).run(accountId, year, month, uploadId, uploadId);
}

function getAllUploads() {
  const db = getDB();
  return db.prepare(`
    SELECT u.*, a.institution, a.account_name, a.account_type, a.currency
    FROM uploads u
    JOIN accounts a ON u.account_id = a.id
    ORDER BY u.uploaded_at DESC
  `).all();
}

function getUploadsForAccount(accountId) {
  const db = getDB();
  return db.prepare(`
    SELECT * FROM uploads WHERE account_id = ? ORDER BY period_start DESC
  `).all(accountId);
}

function getUpload(id) {
  const db = getDB();
  return db.prepare(`
    SELECT u.*, a.institution, a.account_name, a.account_type, a.currency, a.lm_asset_id
    FROM uploads u
    JOIN accounts a ON u.account_id = a.id
    WHERE u.id = ?
  `).get(id);
}

function markSignsFixed(uploadId, timestamp) {
  const db = getDB();
  db.prepare(`UPDATE uploads SET signs_fixed_at = ? WHERE id = ?`)
    .run(timestamp || new Date().toISOString(), uploadId);
}

/**
 * Union of every LM transaction id belonging to a signs-fixed upload record.
 * Used as an id-level guard: a transaction covered by ANY fixed record must
 * never be flipped again by "Fix Signs", regardless of which record it's
 * reached through (legacy batch records share one id list across files).
 */
function getFixedLmIdSet() {
  const db = getDB();
  const rows = db.prepare(
    `SELECT lm_ids FROM uploads WHERE signs_fixed_at IS NOT NULL AND lm_ids IS NOT NULL`
  ).all();
  const fixed = new Set();
  for (const r of rows) {
    try {
      for (const id of JSON.parse(r.lm_ids) || []) {
        const n = Number(id);
        if (Number.isFinite(n)) fixed.add(n);
      }
    } catch { /* ignore malformed rows */ }
  }
  return fixed;
}

/**
 * After signs were corrected outside the per-upload "Fix Signs" action (via
 * reconcile or an import-time sign correction), stamp any upload whose entire
 * lm_ids set is covered by `flippedLmIds` as signs-fixed, so the History
 * action can't re-flip the now-correct entries. Partially covered uploads
 * keep their badge but get a note recording which entries were already fixed.
 */
function markSignsFixedForLmIds(flippedLmIds, timestamp) {
  const flipped = new Set((flippedLmIds || []).map(Number).filter(Number.isFinite));
  if (!flipped.size) return { fullyFixed: 0, partiallyFixed: 0 };

  const db  = getDB();
  const ts  = timestamp || new Date().toISOString();
  const rows = db.prepare(
    `SELECT id, lm_ids, notes FROM uploads WHERE signs_fixed_at IS NULL AND lm_ids IS NOT NULL`
  ).all();

  let fullyFixed = 0, partiallyFixed = 0;
  for (const r of rows) {
    let ids = [];
    try { ids = JSON.parse(r.lm_ids) || []; } catch { continue; }
    if (!Array.isArray(ids) || !ids.length) continue;

    const covered = ids.filter(id => flipped.has(Number(id)));
    if (!covered.length) continue;

    if (covered.length === ids.length) {
      db.prepare(`UPDATE uploads SET signs_fixed_at = ? WHERE id = ?`).run(ts, r.id);
      fullyFixed++;
    } else {
      const note = `${covered.length} of ${ids.length} entries had their signs corrected elsewhere (${ts.slice(0, 10)}) — "Fix Signs" here would re-flip them.`;
      db.prepare(`UPDATE uploads SET notes = ? WHERE id = ?`)
        .run(r.notes ? `${r.notes}\n${note}` : note, r.id);
      partiallyFixed++;
    }
  }
  return { fullyFixed, partiallyFixed };
}

// ─── Missing months ─────────────────────────────────────────────────────────

/**
 * Return missing months for a given account, from the first upload to today.
 * Returns array of { year, month, label } for each uncovered month.
 */
function getMissingMonths(accountId) {
  const db = getDB();

  const firstUpload = db.prepare(`
    SELECT MIN(period_start) as first_date FROM uploads WHERE account_id = ? AND period_start IS NOT NULL
  `).get(accountId);

  if (!firstUpload || !firstUpload.first_date) return [];

  const covered = db.prepare(`
    SELECT year, month FROM monthly_coverage WHERE account_id = ? AND covered = 1
  `).all(accountId);

  const coveredSet = new Set(covered.map(r => `${r.year}-${r.month}`));

  // First uploaded month (timezone-safe) through the current local month.
  const startYM = yearMonthOf(firstUpload.first_date);
  if (!startYM) return [];
  const now = new Date();
  const endIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

  const missing = [];
  for (const { year: y, month: m } of eachMonthInRange(firstUpload.first_date, endIso)) {
    if (!coveredSet.has(`${y}-${m}`)) {
      missing.push({
        year: y,
        month: m,
        label: `${new Date(y, m - 1, 1).toLocaleString('default', { month: 'long' })} ${y}`,
      });
    }
  }

  return missing;
}

/**
 * Get coverage grid for a given account and year.
 * Returns 12-item array with true/false for each month.
 */
function getYearCoverage(accountId, year) {
  const db = getDB();
  const covered = db.prepare(`
    SELECT month FROM monthly_coverage WHERE account_id = ? AND year = ? AND covered = 1
  `).all(accountId, year);

  const coveredMonths = new Set(covered.map(r => r.month));
  return Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    label: new Date(year, i, 1).toLocaleString('default', { month: 'short' }),
    covered: coveredMonths.has(i + 1),
  }));
}

/**
 * Returns the year of the oldest upload record, or null if no uploads exist.
 * Used to set the lower bound of the coverage tracker year selector.
 */
function getOldestUploadYear() {
  const db  = getDB();
  const row = db.prepare(
    `SELECT MIN(period_start) as oldest FROM uploads WHERE period_start IS NOT NULL`
  ).get();
  if (!row || !row.oldest) return null;
  return yearOf(row.oldest);
}

/**
 * Returns per-month local-DB coverage for the given LunchMoney asset ID and
 * year: an array of { month, expectedTxns } for each covered month (1-12).
 *
 * `expectedTxns` distinguishes the two things a local "statement uploaded"
 * record can mean when LunchMoney has no transactions for the month:
 *   - false → the upload recorded zero inserted transactions (a genuinely
 *     dormant statement month) — the month is covered, LM is empty by design.
 *   - true  → the upload DID insert transactions, so LunchMoney should have
 *     them; if it doesn't, they were deleted (or never landed) and the month
 *     must not be silently shown as covered.
 */
function getDbCoverageForAsset(lmAssetId, year) {
  const db = getDB();

  // Resolve the local account row via lm_asset_id
  const account = db.prepare(
    `SELECT id FROM accounts WHERE lm_asset_id = ?`
  ).get(lmAssetId);

  if (!account) return [];

  const rows = db.prepare(`
    SELECT mc.month, u.tx_count, u.lm_ids
    FROM monthly_coverage mc
    LEFT JOIN uploads u ON u.id = mc.upload_id
    WHERE mc.account_id = ? AND mc.year = ? AND mc.covered = 1
  `).all(account.id, year);

  return rows.map(r => {
    let idCount = 0;
    try { idCount = (JSON.parse(r.lm_ids || '[]') || []).length; } catch { idCount = 0; }
    // lm_ids is the ground truth when present; legacy records (pre-v1.2.7
    // false-positive era) may claim a tx_count with no ids recorded — those
    // also "expected" transactions and deserve scrutiny rather than trust.
    return { month: r.month, expectedTxns: idCount > 0 || (r.tx_count || 0) > 0 };
  });
}

module.exports = { upsertAccount, getAllAccounts, getAccount, saveUpload, getAllUploads, getUploadsForAccount, getUpload, markSignsFixed, markSignsFixedForLmIds, getFixedLmIdSet, getMissingMonths, getYearCoverage, markMonthCovered, getOldestUploadYear, getDbCoverageForAsset };
