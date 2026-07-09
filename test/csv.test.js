'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('path');

const fs   = require('fs');
const os   = require('os');

const { parseStatement } = require('../src/parsers/index');

const fx = (name) => path.join(__dirname, 'fixtures', name);

// Write a throwaway CSV and parse it (avoids committing tiny edge-case fixtures).
async function parseCSVContent(content) {
  const p = path.join(os.tmpdir(), `mitax-test-${content.length}-${content.charCodeAt(0)}.csv`);
  fs.writeFileSync(p, content);
  try { return await parseStatement(p); } finally { fs.unlinkSync(p); }
}

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

test('CSV: a 0.00 debit cell does not shadow a populated credit (N12)', async () => {
  const res = await parseCSVContent('date,description,debit,credit\n05/01/2024,SALARY,0.00,500.00\n');
  assert.equal(res.transactions.length, 1);
  assert.equal(res.transactions[0].amount, 500);   // credit, not 0
  assert.equal(res.transactions[0].type, 'credit');
});

test('CSV: a newline inside a quoted field does not split the record (N12)', async () => {
  const res = await parseCSVContent('date,description,amount\n05/01/2024,"ACME\nLTD",100.00\n');
  assert.equal(res.transactions.length, 1);       // row preserved, not dropped
  assert.equal(res.transactions[0].amount, 100);
});
