'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { normalizeDate, applySignConvention, derivePeriodFromTransactions } =
  require('../src/parsers/utils');

test('normalizeDate: supported formats', () => {
  assert.equal(normalizeDate('2024-03-01'), '2024-03-01');
  assert.equal(normalizeDate('01/03/2024'), '2024-03-01');   // DD/MM/YYYY
  assert.equal(normalizeDate('01-03-2024'), '2024-03-01');
  assert.equal(normalizeDate('Jan 05, 2024'), '2024-01-05');
  assert.equal(normalizeDate('05 Jan 2024'), '2024-01-05');
});

test('normalizeDate: unparseable input is returned verbatim (documents validation gap)', () => {
  // This is why parsers/index.js must validate output before upload.
  assert.equal(normalizeDate('not a date'), 'not a date');
  assert.equal(normalizeDate(''), '');
});

test('applySignConvention: flips sign and re-derives type', () => {
  const txs = [
    { amount: 4025, type: 'debit' },    // internal debit (positive)
    { amount: -300, type: 'credit' },   // internal credit (negative)
    { amount: null },
  ];
  applySignConvention(txs);
  assert.equal(txs[0].amount, -4025);
  assert.equal(txs[0].type, 'debit');
  assert.equal(txs[1].amount, 300);
  assert.equal(txs[1].type, 'credit');
  assert.equal(txs[2].amount, null);    // null amounts untouched
});

test('derivePeriodFromTransactions: min/max dates', () => {
  const p = derivePeriodFromTransactions([
    { date: '2024-03-15' }, { date: '2024-01-02' }, { date: '2024-06-30' },
  ]);
  assert.equal(p.start, '2024-01-02');
  assert.equal(p.end, '2024-06-30');
  assert.equal(p.year, 2024);
  assert.equal(p.month, 1);
});

// ─── resolveRowAmount (shared row-sign resolver) ─────────────────────────────

const { resolveRowAmount } = require('../src/parsers/utils');

test('resolveRowAmount: balance delta wins and signs both directions (internal convention)', () => {
  // internal convention: positive = debit / money out
  assert.deepEqual(resolveRowAmount([500, 10500], 10000, false), { amount: -500, balance: 10500 });  // rising → credit
  assert.deepEqual(resolveRowAmount([200, 10300], 10500, true),  { amount: 200,  balance: 10300 });  // falling → debit (keyword ignored)
});

test('resolveRowAmount: delta must match a printed amount, else falls through to columns', () => {
  // Delta is 800 but no printed number is 800 → distrust delta, use columns
  const r = resolveRowAmount([300, 0, 10800], 10000, false);
  assert.deepEqual(r, { amount: 300, balance: 10800 });   // column: debit=300
});

test('resolveRowAmount: full debit/credit/balance rows without a prior balance', () => {
  assert.deepEqual(resolveRowAmount([300, 0, 9700], null, false), { amount: 300,  balance: 9700 });
  assert.deepEqual(resolveRowAmount([0, 700, 10700], null, false), { amount: -700, balance: 10700 });
  assert.deepEqual(resolveRowAmount([0, 0, 10000], null, false),   { amount: null, balance: 10000 });
});

test('resolveRowAmount: keyword guess when no delta and no full columns', () => {
  assert.deepEqual(resolveRowAmount([500, 10500], null, true),  { amount: -500, balance: 10500 });
  assert.deepEqual(resolveRowAmount([500, 10500], null, false), { amount: 500,  balance: 10500 });
  assert.deepEqual(resolveRowAmount([250], null, true), { amount: -250, balance: null });
});

test('resolveRowAmount: empty/zero rows resolve to null, never a guessed sign', () => {
  assert.deepEqual(resolveRowAmount([], null, false),   { amount: null, balance: null });
  assert.deepEqual(resolveRowAmount([0], null, false),  { amount: null, balance: null });
});
