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
