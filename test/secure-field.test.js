'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

// In plain Node (no Electron) safeStorage is unavailable, so the helper follows
// its plaintext-fallback path. These tests pin that fallback + the legacy/
// backward-compatibility behaviour that protects existing user data.
const { encStr, decStr, encNum, decNum, isEncrypted } = require('../src/secure-field');

test('secure-field: null/undefined pass through', () => {
  assert.equal(encStr(null), null);
  assert.equal(encStr(undefined), null);
  assert.equal(decStr(null), null);
  assert.equal(decNum(null), 0);
});

test('secure-field: string round-trips through the plaintext fallback', () => {
  assert.equal(encStr('hello'), 'hello');       // no keychain → plaintext
  assert.equal(decStr('hello'), 'hello');       // legacy plaintext returned as-is
});

test('secure-field: numbers round-trip and legacy REAL values are handled', () => {
  assert.equal(encNum(1234.56), '1234.56');
  assert.equal(decNum('1234.56'), 1234.56);     // plaintext numeric string
  assert.equal(decNum(1234.56), 1234.56);       // legacy REAL column value (number)
  assert.equal(decNum(0), 0);
});

test('secure-field: an undecryptable encrypted blob degrades safely', () => {
  assert.equal(isEncrypted('sf1:garbage'), true);
  assert.equal(decStr('sf1:garbage'), null);    // decrypt fails → null, not garbage
  assert.equal(decNum('sf1:garbage'), 0);       // → 0, never throws
});
