/**
 * LunchMoney multi-account store
 * Persists saved API keys + user info in the same SQLite DB as the tracker.
 */

const path = require('path');
const { app, safeStorage } = require('electron');

let _db = null;

// ─── API-key encryption at rest (Electron safeStorage / OS keychain) ─────────
// Keys are stored as `enc:v1:<base64(ciphertext)>`. Legacy plaintext rows are
// read as-is and lazily re-encrypted on next access. If the OS has no keychain
// backend available (isEncryptionAvailable() === false), keys are kept in
// plaintext and callers are warned via the keyStorageInsecure flag.
const ENC_PREFIX = 'enc:v1:';

function encryptionAvailable() {
  try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); }
  catch (_) { return false; }
}

function isEncrypted(stored) {
  return typeof stored === 'string' && stored.startsWith(ENC_PREFIX);
}

function encryptKey(plain) {
  if (!encryptionAvailable()) return plain;
  try { return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64'); }
  catch (_) { return plain; }
}

function decryptKey(stored) {
  if (!isEncrypted(stored)) return stored; // legacy plaintext
  // On failure (keychain reset / corrupted blob / different machine) return
  // null rather than the raw ciphertext — a ciphertext blob used as an API key
  // silently fails auth; null lets callers surface "re-enter your key".
  try { return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64')); }
  catch (_) { return null; }
}

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

/** Returns the full active account row with api_key decrypted, or null. */
function getActiveAccount() {
  const row = getDB()
    .prepare('SELECT * FROM lm_accounts WHERE is_active = 1 LIMIT 1')
    .get() || null;
  if (!row) return null;

  const wasEncrypted = isEncrypted(row.api_key);
  row.api_key = decryptKey(row.api_key);

  // Lazy migration: re-store a legacy plaintext key encrypted (best-effort).
  if (!wasEncrypted && encryptionAvailable()) {
    try {
      const enc = encryptKey(row.api_key);
      if (isEncrypted(enc)) {
        getDB().prepare('UPDATE lm_accounts SET api_key = ? WHERE id = ?').run(enc, row.id);
      }
    } catch (_) { /* never fail a read */ }
  }

  row.keyStorageInsecure = !encryptionAvailable();
  return row;
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
  const db = getDB();

  // Encryption makes ciphertext differ per call, so a WHERE api_key = ? lookup
  // no longer finds an existing key; scan and compare decrypted values instead.
  const rows     = db.prepare('SELECT id, api_key FROM lm_accounts').all();
  const existing = rows.find(r => decryptKey(r.api_key) === apiKey);

  if (existing) {
    db.prepare(
      'UPDATE lm_accounts SET label = ?, user_name = ?, budget_name = ? WHERE id = ?'
    ).run(label || userName || 'Account', userName || null, budgetName || null, existing.id);
    return existing.id;
  }

  const r = db.prepare(
    'INSERT INTO lm_accounts (label, api_key, user_name, budget_name, is_active) VALUES (?, ?, ?, ?, 0)'
  ).run(label || userName || 'Account', encryptKey(apiKey), userName || null, budgetName || null);
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
