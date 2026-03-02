/**
 * Upload Tracker — SQLite-backed persistence for uploaded statements.
 * Tracks: which accounts have been uploaded, which months are covered, and upload history.
 */

const path = require('path');
const { app } = require('electron');

let db = null;

function getDB() {
  if (db) return db;

  const Database = require('better-sqlite3');
  const dbPath = path.join(app.getPath('userData'), 'lunchmoney-tracker.db');
  db = new Database(dbPath);
  initSchema(db);
  return db;
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
    // Cover all months in range
    const startDate = new Date(start);
    const endDate = new Date(end);
    let cur = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
    const last = new Date(endDate.getFullYear(), endDate.getMonth(), 1);

    while (cur <= last) {
      markMonthCovered(accountId, cur.getFullYear(), cur.getMonth() + 1, uploadId);
      cur.setMonth(cur.getMonth() + 1);
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

  const start = new Date(firstUpload.first_date);
  const now = new Date();
  const missing = [];

  let cur = new Date(start.getFullYear(), start.getMonth(), 1);

  while (cur <= now) {
    const y = cur.getFullYear();
    const m = cur.getMonth() + 1;
    const key = `${y}-${m}`;

    if (!coveredSet.has(key)) {
      missing.push({
        year: y,
        month: m,
        label: `${new Date(y, m - 1, 1).toLocaleString('default', { month: 'long' })} ${y}`,
      });
    }

    cur.setMonth(cur.getMonth() + 1);
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
  return new Date(row.oldest).getFullYear();
}

/**
 * Returns a Set of month numbers (1-12) for which a statement has been
 * uploaded to the local DB for the given LunchMoney asset ID and year.
 * Used to overlay "statement uploaded but no transactions" coverage on
 * the tracker grid so those months are not flagged as missing.
 */
function getDbCoverageForAsset(lmAssetId, year) {
  const db = getDB();

  // Resolve the local account row via lm_asset_id
  const account = db.prepare(
    `SELECT id FROM accounts WHERE lm_asset_id = ?`
  ).get(lmAssetId);

  if (!account) return new Set();

  const rows = db.prepare(`
    SELECT month FROM monthly_coverage
    WHERE account_id = ? AND year = ? AND covered = 1
  `).all(account.id, year);

  return new Set(rows.map(r => r.month));
}

module.exports = { upsertAccount, getAllAccounts, getAccount, saveUpload, getAllUploads, getUploadsForAccount, getMissingMonths, getYearCoverage, markMonthCovered, getOldestUploadYear, getDbCoverageForAsset };
