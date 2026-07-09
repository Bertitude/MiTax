'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { reconcile } = require('../src/reconcile');

// LM tx shape (subset used by reconcile)
const lm = (id, date, amount, payee) => ({ id, date, amount, payee });

test('reconcile: flags a genuine sign mismatch', () => {
  const parsed = [{ date: '2024-03-01', amount: -5000, payee: 'GROCERY' }]; // expense
  const lmTxs  = [lm(1, '2024-03-01', 5000, 'GROCERY')];                     // LM has it as income
  const r = reconcile(parsed, lmTxs, []);
  assert.equal(r.signMismatches.length, 1);
  assert.equal(r.signMismatches[0].lmId, 1);
});

test('reconcile: same-day debit+credit of equal magnitude are NOT false-flagged', () => {
  // Both sides have a -500 and a +500 on the same day; each should pair with its
  // same-sign partner rather than cross-pairing into a mismatch.
  const parsed = [
    { date: '2024-03-02', amount: -500, payee: 'ATM WITHDRAWAL' },
    { date: '2024-03-02', amount:  500, payee: 'ATM REVERSAL' },
  ];
  const lmTxs = [
    lm(1, '2024-03-02', -500, 'ATM WITHDRAWAL'),
    lm(2, '2024-03-02',  500, 'ATM REVERSAL'),
  ];
  const r = reconcile(parsed, lmTxs, []);
  assert.equal(r.signMismatches.length, 0);
});

test('reconcile: a flipped row is flagged, not masked by a same-sign neighbour (N10)', () => {
  // SALARY (+50000) and RENT (-50000) on the same day; LM has BOTH sign-flipped.
  // Payee-exact matching must flag each flip rather than cross-pairing them.
  const parsed = [
    { date: '2024-05-01', amount:  50000, payee: 'SALARY' },
    { date: '2024-05-01', amount: -50000, payee: 'RENT' },
  ];
  const lmTxs = [
    lm(1, '2024-05-01', -50000, 'SALARY'),  // flipped
    lm(2, '2024-05-01',  50000, 'RENT'),    // flipped
  ];
  const r = reconcile(parsed, lmTxs, []);
  assert.equal(r.signMismatches.length, 2);
  assert.deepEqual(r.signMismatches.map(m => m.lmId).sort(), [1, 2]);
});

test('reconcile: statement transactions absent from LM are reported as missing (N23)', () => {
  const parsed = [
    { date: '2024-03-01', amount: -5000, payee: 'GROCERY' },   // in LM
    { date: '2024-03-02', amount: -1200, payee: 'PHARMACY' },  // NOT in LM
  ];
  const lmTxs = [lm(1, '2024-03-01', -5000, 'GROCERY')];
  const r = reconcile(parsed, lmTxs, []);
  assert.equal(r.signMismatches.length, 0);
  assert.equal(r.missingInLM.length, 1);
  assert.equal(r.missingInLM[0].payee, 'PHARMACY');
  assert.equal(r.missingInLM[0].amount, -1200);
});

test('reconcile: phantom only when a statement sentinel confirms it', () => {
  const lmTxs = [
    lm(1, '2024-01-01', 100000, 'Opening Balance'),
    lm(2, '2024-01-31', 120000, 'Closing Balance'),
  ];
  // Only the opening-balance line was seen in the parsed statement.
  const sentinels = [{ date: '2024-01-01', amount: 100000 }];
  const r = reconcile([], lmTxs, sentinels);

  assert.equal(r.phantomBalances.length, 1);
  assert.equal(r.phantomBalances[0].lmId, 1);
  assert.equal(r.suspectedPhantoms.length, 1);
  assert.equal(r.suspectedPhantoms[0].lmId, 2);
});

test('reconcile: no sentinels → balance-like payees are only suspected, never auto-deleted', () => {
  const lmTxs = [lm(1, '2024-01-01', 100000, 'Balance Forward')];
  const r = reconcile([], lmTxs, []);
  assert.equal(r.phantomBalances.length, 0);
  assert.equal(r.suspectedPhantoms.length, 1);
});
