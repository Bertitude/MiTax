/**
 * LunchMoney multi-account store
 * Persists saved API keys + user info in the same SQLite DB as the tracker.
 */

const path = require('path');
const { app } = require('electron');

let _db = null;

function getDB() {
  if (!_db) {
    const Database = require('better-sqlite3');
    const dbPath   = path.join(app.getPath('userData'), 'lunchmoney-tracker.db');
    _db = new Database(dbPath);
    initSchema(_db);
  }
  return _db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lm_accounts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      label       TEXT    NOT NULL,
      api_key     TEXT    NOT NULL UNIQUE,
      user_name   TEXT,
      budget_name TEXT,
      is_active   INTEGER DEFAULT 0,
      created_at  TEXT    DEFAULT (datetime('now'))
    );
  `);
}

// ─── Queries ─────────────────────────────────────────────────────────────────

/** Returns all saved accounts (api_key is omitted for safety in list view). */
function getAllAccounts() {
  return getDB()
    .prepare('SELECT id, label, user_name, budget_name, is_active, created_at FROM lm_accounts ORDER BY id')
    .all();
}

/** Returns the full active account row including api_key, or null. */
function getActiveAccount() {
  return getDB()
    .prepare('SELECT * FROM lm_accounts WHERE is_active = 1 LIMIT 1')
    .get() || null;
}

/** Returns just the active api_key string, or null. */
function getActiveApiKey() {
  const acc = getActiveAccount();
  return acc ? acc.api_key : null;
}

// ─── Mutations ───────────────────────────────────────────────────────────────

/**
 * Add or update an account.  If the api_key already exists, update its
 * label/user info.  Returns the row id.
 */
function addAccount({ label, apiKey, userName, budgetName }) {
  const db     = getDB();
  const exists = db.prepare('SELECT id FROM lm_accounts WHERE api_key = ?').get(apiKey);

  if (exists) {
    db.prepare(
      'UPDATE lm_accounts SET label = ?, user_name = ?, budget_name = ? WHERE api_key = ?'
    ).run(label || userName || 'Account', userName || null, budgetName || null, apiKey);
    return exists.id;
  }

  const r = db.prepare(
    'INSERT INTO lm_accounts (label, api_key, user_name, budget_name, is_active) VALUES (?, ?, ?, ?, 0)'
  ).run(label || userName || 'Account', apiKey, userName || null, budgetName || null);
  return r.lastInsertRowid;
}

/** Make one account active; clears all others. */
function setActiveAccount(id) {
  const db = getDB();
  db.prepare('UPDATE lm_accounts SET is_active = 0').run();
  db.prepare('UPDATE lm_accounts SET is_active = 1 WHERE id = ?').run(id);
}

/**
 * Remove an account.  If it was the active one, activate the next account
 * (if any).
 */
function removeAccount(id) {
  const db      = getDB();
  const account = db.prepare('SELECT * FROM lm_accounts WHERE id = ?').get(id);
  db.prepare('DELETE FROM lm_accounts WHERE id = ?').run(id);

  if (account && account.is_active) {
    const next = db.prepare('SELECT id FROM lm_accounts ORDER BY id LIMIT 1').get();
    if (next) setActiveAccount(next.id);
  }
}

/**
 * Migration helper: if we have a legacy localStorage API key (passed in from
 * renderer on first boot) and no accounts are stored yet, save it as the
 * first account and activate it.
 */
function migrateFromLegacyKey({ apiKey, userName, budgetName }) {
  const db    = getDB();
  const count = db.prepare('SELECT COUNT(*) as n FROM lm_accounts').get().n;
  if (count > 0) return null; // already migrated
  const id = addAccount({ label: userName || budgetName || 'My Account', apiKey, userName, budgetName });
  setActiveAccount(id);
  return id;
}

module.exports = {
  getAllAccounts,
  getActiveAccount,
  getActiveApiKey,
  addAccount,
  setActiveAccount,
  removeAccount,
  migrateFromLegacyKey,
};
