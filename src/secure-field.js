/**
 * Field-level encryption for sensitive columns stored in the local SQLite DB
 * (tax filings, P24 employment income). Uses Electron `safeStorage` (OS
 * keychain / DPAPI) — the same primitive that protects the API key.
 *
 * Design goals (this runs against users' real tax data, so it must never break
 * the app or lose data):
 *   - Dependency-free: no native-module swap, so it can't stop the app starting.
 *   - Non-destructive & backward-compatible: reads transparently accept BOTH
 *     legacy plaintext values and encrypted ones, and writes re-encrypt. Values
 *     are stored as `sf1:<base64(ciphertext)>`.
 *   - Graceful fallback: if the OS has no keychain backend, values are stored
 *     as plaintext (same policy as the API key) rather than failing.
 *
 * NOTE: this protects only the columns it's applied to. Columns needed for
 * SQL filtering/sorting/uniqueness (dates, year/month, type, status,
 * institution) stay plaintext by necessity. Whole-database encryption
 * (SQLCipher) would cover everything but needs a native driver + tested
 * migration — deliberately not shipped without local verification.
 */

'use strict';

// Load safeStorage defensively so this module is usable (and unit-testable via
// its plaintext fallback) outside the Electron runtime.
let safeStorage = null;
try { ({ safeStorage } = require('electron')); } catch (_) { /* not in Electron */ }

const PREFIX = 'sf1:';

function secureAvailable() {
  try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); }
  catch (_) { return false; }
}

function isEncrypted(v) {
  return typeof v === 'string' && v.startsWith(PREFIX);
}

/** Encrypt a string value → 'sf1:<base64>'. null/undefined pass through; on
 *  unavailable/failed encryption the plaintext string is stored. */
function encStr(value) {
  if (value == null) return null;
  const s = String(value);
  if (!secureAvailable()) return s;
  try { return PREFIX + safeStorage.encryptString(s).toString('base64'); }
  catch (_) { return s; }
}

/** Decrypt → original string. Legacy plaintext is returned as-is; an
 *  undecryptable blob (e.g. keychain reset) returns null rather than garbage. */
function decStr(stored) {
  if (stored == null) return null;
  if (!isEncrypted(stored)) return stored;   // legacy plaintext
  try { return safeStorage.decryptString(Buffer.from(stored.slice(PREFIX.length), 'base64')); }
  catch (_) { return null; }
}

/** Encrypt a number (stored as an encrypted string). */
function encNum(n) {
  return encStr(n == null ? null : String(n));
}

/** Decrypt back to a number. Legacy REAL values (already numbers) and plaintext
 *  numeric strings are handled; anything unreadable falls back to 0. */
function decNum(stored) {
  if (stored == null) return 0;
  if (typeof stored === 'number') return stored;   // legacy REAL column value
  const s = decStr(stored);
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

module.exports = { encStr, decStr, encNum, decNum, isEncrypted, secureAvailable, PREFIX };
