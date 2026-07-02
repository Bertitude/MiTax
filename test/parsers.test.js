'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const scotiabank = require('../src/parsers/scotiabank');
const generic    = require('../src/parsers/generic');

const fixture = (name) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const textFixture = (name) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('Scotiabank savings: coordinate parse, sign convention, year boundary', () => {
  const fx  = fixture('scotiabank-savings.json');
  const res = scotiabank.parseFromPageItems(fx.pages, fx.fullText);

  assert.equal(res.institution, 'Scotiabank');
  assert.equal(res.accountType, 'savings');
  assert.equal(res.currency, 'JMD');
  assert.equal(res.transactions.length, 2);

  const [debit, credit] = res.transactions;

  // "J$ 4,025.00 -" is a debit → user-facing amount is negative
  assert.equal(debit.date, '2020-12-07');            // DEC → prior year 2020
  assert.equal(debit.payee, 'POS PURCHASE HI-LO');
  assert.equal(debit.amount, -4025);
  assert.equal(debit.type, 'debit');
  assert.equal(debit.category, 'Groceries');

  // "J$ 300.00 +" is a credit → user-facing amount is positive
  assert.equal(credit.date, '2021-01-03');           // JAN → later year 2021
  assert.equal(credit.payee, 'SALARY DIRECT DEPOSIT');
  assert.equal(credit.amount, 300);
  assert.equal(credit.type, 'credit');
  assert.equal(credit.category, 'Income');
});

test('Scotiabank: missing period header emits a warning and does not throw', () => {
  const fx  = fixture('scotiabank-savings.json');
  const res = scotiabank.parseFromPageItems(fx.pages, 'Scotiabank\nSavings Account'); // no period line
  assert.ok(Array.isArray(res.warnings));
  assert.ok(res.warnings.some(w => /period header/i.test(w)));
});

test('parseDdmmm: unrecognized month returns null and records a warning', () => {
  const warnings = [];
  assert.equal(scotiabank.parseDdmmm('07ZZZ', '05DEC20', '05JAN21', warnings), null);
  assert.equal(warnings.length, 1);
  // valid token still parses
  assert.equal(scotiabank.parseDdmmm('07DEC', '05DEC20', '05JAN21', []), '2020-12-07');
});

test('Generic parser: DR/CR suffix + header column detection', () => {
  const res = generic.parse(textFixture('generic-fgb.txt'));

  assert.equal(res.transactions.length, 2);
  const [g, dep] = res.transactions;

  assert.equal(g.date, '2024-03-01');
  assert.equal(g.payee, 'GROCERY STORE');
  assert.equal(g.amount, -5000);          // debit column → negative
  assert.equal(g.type, 'debit');

  assert.equal(dep.date, '2024-03-02');
  assert.equal(dep.payee, 'CLIENT DEPOSIT');
  assert.equal(dep.amount, 20000);        // CR suffix → positive
  assert.equal(dep.type, 'credit');
});
