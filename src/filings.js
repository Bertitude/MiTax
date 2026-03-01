/**
 * Tax Filings — SQLite storage for S04 annual returns and S04A quarterly estimates.
 * Reuses the same database file as the upload tracker (lunchmoney-tracker.db).
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
    CREATE TABLE IF NOT EXISTS tax_filings (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      type         TEXT NOT NULL,          -- 's04' or 's04a'
      year         INTEGER NOT NULL,
      quarter      INTEGER,                -- NULL for s04; 1-4 for s04a
      filed_date   TEXT,                   -- ISO date the return was lodged
      due_date     TEXT,                   -- TAJ statutory due date
      gross_income REAL DEFAULT 0,
      tax_payable  REAL DEFAULT 0,         -- computed total tax
      nis          REAL DEFAULT 0,
      nht          REAL DEFAULT 0,
      ed_tax       REAL DEFAULT 0,
      income_tax   REAL DEFAULT 0,
      amount_paid  REAL DEFAULT 0,         -- actual payment made
      status       TEXT DEFAULT 'draft',   -- 'draft' | 'filed' | 'paid'
      report_json  TEXT,                   -- full serialised report object
      notes        TEXT,
      created_at   TEXT DEFAULT (datetime('now')),
      updated_at   TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_filings_year_type ON tax_filings(year, type);
  `);
}

// ─── Write ───────────────────────────────────────────────────────────────────

function saveFiling({
  type, year, quarter, filedDate, dueDate,
  grossIncome, taxPayable, nis, nht, edTax, incomeTax,
  amountPaid, status, reportJson, notes,
}) {
  const db = getDB();
  const result = db.prepare(`
    INSERT INTO tax_filings
      (type, year, quarter, filed_date, due_date,
       gross_income, tax_payable, nis, nht, ed_tax, income_tax,
       amount_paid, status, report_json, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    type, year, quarter || null, filedDate || null, dueDate || null,
    grossIncome || 0, taxPayable || 0, nis || 0, nht || 0, edTax || 0, incomeTax || 0,
    amountPaid || 0, status || 'draft',
    reportJson ? JSON.stringify(reportJson) : null,
    notes || null,
  );
  return { id: result.lastInsertRowid };
}

function updateFiling(id, { filedDate, amountPaid, status, notes }) {
  const db = getDB();
  // Only update supplied fields; leave others untouched
  const updates = [];
  const params  = [];

  if (filedDate  !== undefined) { updates.push('filed_date = ?');  params.push(filedDate); }
  if (amountPaid !== undefined) { updates.push('amount_paid = ?'); params.push(amountPaid); }
  if (status     !== undefined) { updates.push('status = ?');      params.push(status); }
  if (notes      !== undefined) { updates.push('notes = ?');       params.push(notes); }

  if (!updates.length) return getFilingById(id);

  updates.push("updated_at = datetime('now')");
  params.push(id);

  db.prepare(`UPDATE tax_filings SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  return getFilingById(id);
}

// ─── Read ────────────────────────────────────────────────────────────────────

function getFilingById(id) {
  const db  = getDB();
  const row = db.prepare('SELECT * FROM tax_filings WHERE id = ?').get(id);
  if (row && row.report_json) {
    try { row.report = JSON.parse(row.report_json); } catch { /* ignore */ }
    delete row.report_json;
  }
  return row || null;
}

function getAllFilings() {
  const db = getDB();
  return db.prepare(`
    SELECT id, type, year, quarter, filed_date, due_date,
           gross_income, tax_payable, nis, nht, ed_tax, income_tax,
           amount_paid, status, notes, created_at, updated_at
    FROM tax_filings
    ORDER BY year DESC, type ASC, COALESCE(quarter, 0) ASC
  `).all();
}

/**
 * Returns the most recent S04 filing for the given year (used to derive S04A).
 */
function getMostRecentS04(year) {
  const db = getDB();
  return db.prepare(`
    SELECT * FROM tax_filings
    WHERE type = 's04' AND year = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(year) || null;
}

// ─── Delete ──────────────────────────────────────────────────────────────────

function deleteFiling(id) {
  const db = getDB();
  db.prepare('DELETE FROM tax_filings WHERE id = ?').run(id);
}

module.exports = { saveFiling, updateFiling, getFilingById, getAllFilings, getMostRecentS04, deleteFiling };
