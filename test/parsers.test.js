'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const scotiabank = require('../src/parsers/scotiabank');
const generic    = require('../src/parsers/generic');
const jmmb       = require('../src/parsers/jmmb');
const ncb        = require('../src/parsers/ncb');
const wise       = require('../src/parsers/wise');
const stripe     = require('../src/parsers/stripe');
const paypal     = require('../src/parsers/paypal');

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

test('Generic parser: empty debit cell + balance-CR marker do not invert signs (N2)', () => {
  const res = generic.parse(textFixture('generic-debitcredit.txt'));
  assert.equal(res.transactions.length, 2);
  const [dep, atm] = res.transactions;

  // H7: deposit row with an empty debit cell must NOT be read as a debit.
  assert.equal(dep.payee, 'SALARY DEPOSIT');
  assert.equal(dep.amount, 500);          // credit (money in)
  assert.equal(dep.type, 'credit');

  // H8 (via balance delta): withdrawal stays a debit.
  assert.equal(atm.amount, -200);
  assert.equal(atm.type, 'debit');
});

test('Generic parser: a DR/CR marker on the running balance is ignored (N2)', () => {
  // "…5,000.00 105,000.00 CR" — the CR is on the balance, not the amount.
  const res = generic.parse('Some Bank Ltd\n01/03/2024 ATM WITHDRAWAL 5,000.00 105,000.00 CR');
  assert.equal(res.transactions.length, 1);
  assert.equal(res.transactions[0].amount, -5000);   // debit, not +105,000 income
  assert.equal(res.transactions[0].type, 'debit');
});

test('JMMB parser: does not crash; balance delta signs the amount (N3)', () => {
  const res = jmmb.parse(textFixture('jmmb-savings.txt'));
  assert.equal(res.accountNumber, '7890');
  assert.equal(res.transactions.length, 2);
  const [atm, salary] = res.transactions;
  assert.equal(atm.amount, -5000);        // withdrawal → debit (balance fell)
  assert.equal(atm.type, 'debit');
  assert.equal(salary.amount, 80000);     // deposit → credit (balance rose)
  assert.equal(salary.type, 'credit');
});

test('NCB parser: balance delta signs deposits vs withdrawals (N2)', () => {
  const res = ncb.parse(textFixture('ncb-savings.txt'));
  assert.equal(res.transactions.length, 2);
  const [salary, atm] = res.transactions;
  assert.equal(salary.amount, 500);       // salary payment → credit, not expense
  assert.equal(salary.type, 'credit');
  assert.equal(atm.amount, -200);         // withdrawal → debit
  assert.equal(atm.type, 'debit');
});

test('Wise parser: money in is a credit, money out a debit (N2)', () => {
  const res = wise.parse(textFixture('wise-usd.txt'));
  assert.equal(res.transactions.length, 2);
  assert.equal(res.transactions[0].amount, 1500);    // received → credit
  assert.equal(res.transactions[0].type, 'credit');
  assert.equal(res.transactions[1].amount, -300);    // sent → debit
  assert.equal(res.transactions[1].type, 'debit');
});

test('Stripe parser: charges are income, payouts are debits (N2)', () => {
  const res = stripe.parse(textFixture('stripe-payout.txt'));
  assert.equal(res.transactions.length, 2);
  assert.equal(res.transactions[0].amount, 96.8);    // charge net → credit
  assert.equal(res.transactions[0].type, 'credit');
  assert.equal(res.transactions[1].amount, -500);    // payout → debit
  assert.equal(res.transactions[1].type, 'debit');
});

test('PayPal parser: MM/DD dates and received-as-credit (N2, N4)', () => {
  const res = paypal.parse(textFixture('paypal-activity.txt'));
  assert.equal(res.transactions.length, 2);
  const [recv, sent] = res.transactions;
  assert.equal(recv.date, '2024-07-04');  // 7/4 → July 4, not April 7
  assert.equal(recv.amount, 96.8);        // received → credit
  assert.equal(recv.type, 'credit');
  assert.equal(sent.date, '2024-08-15');
  assert.equal(sent.amount, -50);         // withdrawal → debit
  assert.equal(sent.type, 'debit');
});

test('parseMDY / normalizeDate: month-first vs day-first (N4)', () => {
  const { parseMDY, normalizeDate } = require('../src/parsers/utils');
  assert.equal(parseMDY('7/4/2024'), '2024-07-04');   // month-first
  assert.equal(normalizeDate('7/4/2024'), '2024-04-07'); // day-first (documents the trap)
  assert.equal(parseMDY('13/4/2024'), '');            // invalid month rejected
});
