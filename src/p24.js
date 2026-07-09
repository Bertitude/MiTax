/**
 * P24 — PAYE Deduction Records (Employment Income)
 *
 * Stores monthly employer payroll deduction data (P24 form entries) so that
 * employment income and taxes already withheld at source can be included when
 * generating the S04 annual return.
 *
 * Table: p24_entries
 *   One row per employer per month. Multiple employers in the same month are
 *   supported (e.g. two part-time jobs).
 */

'use strict';

const path = require('path');
const { app } = require('electron');
const { encStr, decStr, encNum, decNum, isEncrypted, secureAvailable } = require('./secure-field');

let db = null;

function getDB() {
  if (db) return db;
  const Database = require('better-sqlite3');
  const dbPath = path.join(app.getPath('userData'), 'lunchmoney-tracker.db');
  db = new Database(dbPath);
  initSchema(db);
  migrateEncryption(db);
  return db;
}

// Sensitive value columns (payroll figures + tax registration number + notes).
// year/month/employer_name stay plaintext — needed for filtering and the
// ORDER BY employer_name sort.
const ENC_NUM_COLS = ['gross_emoluments', 'nis_deducted', 'nht_deducted', 'ed_tax_deducted', 'paye_deducted', 'net_pay'];
const ENC_STR_COLS = ['employer_trn', 'notes'];

// One-time, idempotent, non-destructive migration (see filings.js for rationale).
function migrateEncryption(db) {
  if (!secureAvailable()) return;
  try {
    const rows = db.prepare('SELECT * FROM p24_entries').all();
    const upd = db.prepare(`UPDATE p24_entries SET ${[...ENC_NUM_COLS, ...ENC_STR_COLS].map(c => `${c} = ?`).join(', ')} WHERE id = ?`);
    for (const r of rows) {
      const alreadyEnc = ENC_STR_COLS.concat(ENC_NUM_COLS).every(c => r[c] == null || isEncrypted(r[c]));
      if (alreadyEnc) continue;
      try {
        upd.run(
          ...ENC_NUM_COLS.map(c => encNum(decNum(r[c]))),
          ...ENC_STR_COLS.map(c => encStr(decStr(r[c]))),
          r.id,
        );
      } catch (_) { /* leave this row plaintext-but-readable */ }
    }
  } catch (_) { /* never fail startup on migration */ }
}

function decodeRow(row) {
  if (!row) return row;
  for (const c of ENC_NUM_COLS) if (c in row) row[c] = decNum(row[c]);
  for (const c of ENC_STR_COLS) if (c in row) row[c] = decStr(row[c]);
  return row;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS p24_entries (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      year             INTEGER NOT NULL,
      month            INTEGER NOT NULL,  -- 1–12
      employer_name    TEXT NOT NULL,
      employer_trn     TEXT,              -- optional Tax Registration Number
      gross_emoluments REAL DEFAULT 0,   -- total gross pay before deductions
      nis_deducted     REAL DEFAULT 0,   -- National Insurance Scheme
      nht_deducted     REAL DEFAULT 0,   -- National Housing Trust
      ed_tax_deducted  REAL DEFAULT 0,   -- Education Tax
      paye_deducted    REAL DEFAULT 0,   -- Income Tax (PAYE)
      net_pay          REAL DEFAULT 0,   -- take-home (informational)
      notes            TEXT,
      created_at       TEXT DEFAULT (datetime('now')),
      updated_at       TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_p24_year ON p24_entries(year);
    CREATE INDEX IF NOT EXISTS idx_p24_year_month ON p24_entries(year, month);
  `);
}

// ─── Write ────────────────────────────────────────────────────────────────────

function saveEntry({
  id,
  year, month,
  employerName, employerTrn,
  grossEmoluments, nisDeducted, nhtDeducted, edTaxDeducted, payeDeducted, netPay,
  notes,
}) {
  const db = getDB();

  if (id) {
    // Update existing
    db.prepare(`
      UPDATE p24_entries SET
        year = ?, month = ?,
        employer_name = ?, employer_trn = ?,
        gross_emoluments = ?, nis_deducted = ?, nht_deducted = ?,
        ed_tax_deducted = ?, paye_deducted = ?, net_pay = ?,
        notes = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      year, month,
      employerName, encStr(employerTrn || null),
      encNum(grossEmoluments || 0), encNum(nisDeducted || 0), encNum(nhtDeducted || 0),
      encNum(edTaxDeducted || 0), encNum(payeDeducted || 0), encNum(netPay || 0),
      encStr(notes || null),
      id,
    );
    return { id };
  }

  // Insert new
  const result = db.prepare(`
    INSERT INTO p24_entries
      (year, month, employer_name, employer_trn,
       gross_emoluments, nis_deducted, nht_deducted,
       ed_tax_deducted, paye_deducted, net_pay, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    year, month,
    employerName, encStr(employerTrn || null),
    encNum(grossEmoluments || 0), encNum(nisDeducted || 0), encNum(nhtDeducted || 0),
    encNum(edTaxDeducted || 0), encNum(payeDeducted || 0), encNum(netPay || 0),
    encStr(notes || null),
  );
  return { id: result.lastInsertRowid };
}

// ─── Read ─────────────────────────────────────────────────────────────────────

function getEntriesForYear(year) {
  const db = getDB();
  return db.prepare(`
    SELECT * FROM p24_entries
    WHERE year = ?
    ORDER BY month ASC, employer_name ASC
  `).all(year).map(decodeRow);
}

/**
 * Returns aggregated P24 totals for a given year — used by the S04 generator.
 */
function getP24TotalsForYear(year) {
  const db    = getDB();
  const rows  = getEntriesForYear(year);

  const totals = {
    grossEmoluments: 0,
    nisDeducted:     0,
    nhtDeducted:     0,
    edTaxDeducted:   0,
    payeDeducted:    0,
    netPay:          0,
    entryCount:      rows.length,
  };

  for (const r of rows) {
    totals.grossEmoluments += r.gross_emoluments || 0;
    totals.nisDeducted     += r.nis_deducted     || 0;
    totals.nhtDeducted     += r.nht_deducted     || 0;
    totals.edTaxDeducted   += r.ed_tax_deducted  || 0;
    totals.payeDeducted    += r.paye_deducted    || 0;
    totals.netPay          += r.net_pay          || 0;
  }

  return totals;
}

// ─── Delete ───────────────────────────────────────────────────────────────────

function deleteEntry(id) {
  const db = getDB();
  db.prepare('DELETE FROM p24_entries WHERE id = ?').run(id);
}

module.exports = { saveEntry, getEntriesForYear, getP24TotalsForYear, deleteEntry };
