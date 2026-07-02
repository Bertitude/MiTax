'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('path');

const { parseStatement } = require('../src/parsers/index');

const fx = (name) => path.join(__dirname, 'fixtures', name);

test('CSV: separate debit/credit columns map to signed amounts', async () => {
  const res = await parseStatement(fx('csv-debit-credit.csv'));
  assert.equal(res.transactions.length, 2);

  const [debit, credit] = res.transactions;
  assert.equal(debit.payee, 'GROCERY STORE');
  assert.equal(debit.amount, -5000);   // debit column → expense
  assert.equal(debit.type, 'debit');

  assert.equal(credit.payee, 'CLIENT DEPOSIT');
  assert.equal(credit.amount, 20000);  // credit column → income
  assert.equal(credit.type, 'credit');
});

test('CSV: pre-signed amount column is not double-flipped; parens = negative', async () => {
  const res = await parseStatement(fx('csv-signed.csv'));
  assert.equal(res.transactions.length, 2);

  const [salary, rent] = res.transactions;
  assert.equal(salary.amount, 150000);  // positive stays positive (income)
  assert.equal(salary.type, 'credit');

  assert.equal(rent.amount, -50000);    // (50000.00) accounting-negative → expense
  assert.equal(rent.type, 'debit');
});
