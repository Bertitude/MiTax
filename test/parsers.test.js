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
const jn         = require('../src/parsers/jn');

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

test('Scotiabank savings: unmarked amounts are signed by the running-balance delta (credits not dropped)', () => {
  // Statement variant with NO +/- markers — amounts must be signed by the
  // balance delta. The old parser silently dropped every such row.
  const fullText = 'Scotiabank The Bank of Nova Scotia Jamaica\nAccount Number: 00012345\n05DEC20  to  05JAN21\nSavings Account';
  const pages = [[
    { str: '05DEC', x: 40, y: 621 }, { str: 'Beginning Balance', x: 120, y: 621 }, { str: '10,000.00', x: 470, y: 621 },
    { str: '07DEC', x: 40, y: 600 }, { str: 'POS PURCHASE HI-LO', x: 120, y: 600 }, { str: '4,025.00', x: 400, y: 600 }, { str: '5,975.00', x: 470, y: 600 },
    { str: '03JAN', x: 40, y: 579 }, { str: 'SALARY DIRECT DEPOSIT', x: 120, y: 579 }, { str: '300.00', x: 400, y: 579 }, { str: '6,275.00', x: 470, y: 579 },
  ]];
  const res = scotiabank.parseFromPageItems(pages, fullText);

  assert.equal(res.transactions.length, 2);
  const [debit, credit] = res.transactions;
  assert.equal(debit.amount, -4025);   // falling balance → debit → negative user-facing
  assert.equal(debit.type, 'debit');
  assert.equal(credit.amount, 300);    // rising balance → credit → positive user-facing
  assert.equal(credit.type, 'credit');
  // Beginning-balance row became a sentinel, not a transaction
  assert.deepEqual(res.balanceSentinels, [{ date: '2020-12-05', amount: 10000 }]);
  assert.ok(!res.warnings.some(w => /SKIPPED/.test(w)));
});

test('Scotiabank savings: deposit amounts printed LEFT of the amount column are rescued (user-reported layout)', () => {
  // Real-world layout where the DEPOSITS column sits left of x=390: the
  // amount token ("J$ 8,300.00", no +/- marker) was classified as description
  // text and the row reported as unparseable. Money-shaped tokens now join
  // the amount stream from any x-position and are signed by the balance delta.
  const fullText = 'Scotiabank The Bank of Nova Scotia Jamaica\nAccount Number: 00012345\n01OCT21  to  31OCT21\nSavings Account';
  const pages = [[
    // Date-less beginning-balance line (also a layout variant) seeds the delta
    { str: 'Beginning Balance', x: 120, y: 642 }, { str: '10,000.00', x: 470, y: 642 },
    // Deposit: amount at x=340 (desc zone), balance at x=470
    { str: '06OCT', x: 40, y: 621 }, { str: 'THIRD PARTY TRANSFER', x: 120, y: 621 }, { str: 'J$ 8,300.00', x: 340, y: 621 }, { str: '18,300.00', x: 470, y: 621 },
    // Marked debit in the normal amount zone still works
    { str: '08OCT', x: 40, y: 600 }, { str: 'POS PURCHASE HI-LO', x: 120, y: 600 }, { str: 'J$ 4,025.00 -', x: 430, y: 600 }, { str: '14,275.00', x: 470, y: 600 },
    // Unmarked deposit with a bare number, also left of the cut
    { str: '12OCT', x: 40, y: 579 }, { str: 'ABM DEPOSIT', x: 120, y: 579 }, { str: '65,000.00', x: 350, y: 579 }, { str: '79,275.00', x: 470, y: 579 },
  ]];
  const res = scotiabank.parseFromPageItems(pages, fullText);

  assert.equal(res.transactions.length, 3);
  const [transfer, pos, abm] = res.transactions;
  assert.equal(transfer.amount, 8300);     // rising balance → credit
  assert.equal(transfer.type, 'credit');
  assert.equal(transfer.payee, 'THIRD PARTY TRANSFER');   // amount no longer pollutes payee
  assert.equal(pos.amount, -4025);         // trailing '-' → debit
  assert.equal(abm.amount, 65000);         // rising balance → credit
  assert.equal(abm.type, 'credit');
  assert.ok(!res.warnings.some(w => /SKIPPED/.test(w)));
});

test('Scotiabank savings: an unparseable amount row is WARNED about, not silently dropped', () => {
  const fullText = 'Scotiabank\nAccount Number: 00012345\n05DEC20  to  05JAN21\nSavings Account';
  const pages = [[
    // Single unsigned number with no prior balance — sign cannot be determined
    { str: '07DEC', x: 40, y: 600 }, { str: 'MYSTERY ROW', x: 120, y: 600 }, { str: '4,025.00', x: 430, y: 600 },
  ]];
  const res = scotiabank.parseFromPageItems(pages, fullText);
  assert.equal(res.transactions.length, 0);
  assert.ok(res.warnings.some(w => /SKIPPED/.test(w) && /MYSTERY ROW/.test(w)));
});

test('Scotiabank CC: split $/sign items fall back to the loose amount parse (payments not dropped)', () => {
  // Extractor split "$-16,000.00" into separate items — the strict per-item
  // pattern misses it and the old parser dropped the payment row silently.
  const fullText = 'Scotiabank Credit Card Statement\nPOSTING DATE  REFERENCE NO\nCard ****1234';
  const pages = [[
    { str: '23-Jul-2024', x: 30,  y: 600 },
    { str: '0895886321',  x: 250, y: 600 },
    { str: 'PAYMENT THANK YOU', x: 300, y: 600 },
    { str: '$',           x: 516, y: 600 },
    { str: '-16,000.00',  x: 524, y: 600 },
  ]];
  const res = scotiabank.parseCCFromPageItems(pages, fullText);
  assert.equal(res.transactions.length, 1);
  assert.equal(res.transactions[0].amount, 16000);  // payment = credit → positive user-facing
  assert.equal(res.transactions[0].type, 'credit');
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

test('NCB parser: mixed 2- and 3-number rows all parse (deposits no longer dropped)', () => {
  // The old all-or-nothing regex captured only the 3-number rows and then
  // skipped the fallback — every 2-number row (deposits with a blank debit
  // cell) was silently dropped.
  const text = [
    'National Commercial Bank Jamaica Limited',
    'Account Number: 001234567',
    'Opening Balance: 10,000.00',
    '05/01/2024 SALARY PAYMENT 500.00 10,500.00',            // 2 numbers: credit + balance
    '06/01/2024 UTILITY BILL 300.00 0.00 10,200.00',         // 3 numbers: debit, credit, balance
    '07/01/2024 REMITTANCE RECEIVED 0.00 700.00 10,900.00',  // 3 numbers: credit
  ].join('\n');
  const res = ncb.parse(text);
  assert.equal(res.transactions.length, 3);
  assert.deepEqual(res.transactions.map(t => t.amount), [500, -300, 700]);
  assert.deepEqual(res.transactions.map(t => t.type), ['credit', 'debit', 'credit']);
  assert.ok(!(res.warnings || []).some(w => /SKIPPED/.test(w)));
});

test('Scotiabank regex fallback: 2-number deposit rows are credits, not withdrawals', () => {
  // The old Pattern A regex used \s* separators, so a deposit row's amount
  // landed in the WITHDRAWAL capture group — every credit was mis-signed.
  const text = [
    'Scotiabank Jamaica',
    'Account Number: 12345678',
    'Opening Balance: 10,000.00',
    '01/02/2024 POS PURCHASE PHARMACY 1,500.00 8,500.00',
    '02/02/2024 SALARY DEPOSIT 5,000.00 13,500.00',
  ].join('\n');
  const res = scotiabank.regexParse(text);
  assert.equal(res.transactions.length, 2);
  assert.equal(res.transactions[0].amount, -1500);   // falling balance → debit
  assert.equal(res.transactions[0].type, 'debit');
  assert.equal(res.transactions[1].amount, 5000);    // rising balance → credit
  assert.equal(res.transactions[1].type, 'credit');
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

// ── JN Bank ───────────────────────────────────────────────────────────────────
//
// Coordinates below are the real values measured from a JN "Savings
// Transactions Statement" (x/y/w in PDF user units, as pdfjs reports them).

const JN_TEXT =
  'Kaiel Eytle\nAccount number\nRSV-002094352472\nJMD\n' +
  'Savings Transactions Statement for the Period Jan 01, 2021 - Dec 31, 2021';

test('JN Bank: a whole-date text item is parsed (pdfjs emits "Jan 01, 2021" as ONE token)', () => {
  // Regression: the date gate required the first date-column token to be a bare
  // 3-letter month, which only holds for pdfplumber-style word segmentation.
  // pdfjs emits the entire date as a single item, so EVERY row was skipped and
  // the import failed with "No transactions extracted".
  const pages = [[
    { str: 'Transaction Date', x: 20,    y: 507,   w: 66.7 },
    { str: 'Debit',            x: 397,   y: 507,   w: 21.4 },
    { str: 'Jan 02, 2021',     x: 20.0,  y: 469.7, w: 50.8 },
    { str: 'Withdrawal',       x: 99.7,  y: 469.7, w: 47.2 },
    { str: '17.77',            x: 397.9, y: 469.7, w: 22.5 },
    { str: '1,088,286.35',     x: 517.5, y: 469.7, w: 52.5 },
    { str: 'Jan 25, 2021',     x: 20.0,  y: 325.7, w: 50.8 },
    { str: 'Deposit',          x: 99.7,  y: 325.7, w: 31.1 },
    { str: '42,200.00',        x: 456.5, y: 325.7, w: 40.0 },
    { str: '352,382.04',       x: 525.0, y: 325.7, w: 45.0 },
  ]];
  const res = jn.parseFromPageItems(pages, JN_TEXT);

  assert.equal(res.institution, 'JN Bank');
  assert.equal(res.accountName, 'RSV-002094352472');
  assert.equal(res.currency, 'JMD');
  assert.equal(res.transactions.length, 2);   // the header row is not one of them

  const [withdrawal, deposit] = res.transactions;
  assert.equal(withdrawal.date, '2021-01-02');
  assert.equal(withdrawal.amount, -17.77);    // debit column → negative user-facing
  assert.equal(withdrawal.type, 'debit');
  assert.equal(deposit.date, '2021-01-25');
  assert.equal(deposit.amount, 42200);        // credit column → positive user-facing
  assert.equal(deposit.type, 'credit');

  assert.equal(res.period.start, '2021-01-02');
  assert.equal(res.period.end, '2021-01-25');
  assert.deepEqual(res.warnings, []);
});

test('JN Bank: a transaction type wrapped onto a second line is folded into the payee', () => {
  // "Transfer Withdrawal" prints as "Transfer" with "Withdrawal" ~11pt below,
  // landing in its own y bucket. Left unmerged the payee reads "Transfer",
  // which also mis-categorizes the row.
  const pages = [[
    { str: 'Jan 29, 2021', x: 20.0,  y: 307.7, w: 50.8 },
    { str: 'Transfer',     x: 99.7,  y: 307.7, w: 33.9 },
    { str: '1,955.00',     x: 385.5, y: 307.7, w: 35.0 },
    { str: '350,427.04',   x: 525.0, y: 307.7, w: 45.0 },
    { str: 'Withdrawal',   x: 99.7,  y: 296.6, w: 47.2 },   // continuation line
  ]];
  const res = jn.parseFromPageItems(pages, JN_TEXT);

  assert.equal(res.transactions.length, 1);
  assert.equal(res.transactions[0].payee, 'Transfer Withdrawal');
  assert.equal(res.transactions[0].amount, -1955);
});

test('JN Bank: opening and closing balance rows are not transactions', () => {
  const pages = [[
    { str: 'Jan 01, 2021',    x: 20.0, y: 487.7, w: 50.8 },
    { str: 'Opening Balance', x: 99.7, y: 487.7, w: 69.1 },
    { str: '1,088,304.12',    x: 444.0, y: 487.7, w: 52.5 },
    { str: '1,088,304.12',    x: 517.5, y: 487.7, w: 52.5 },
    { str: 'Dec 31, 2021',    x: 20.0, y: 100.0, w: 50.8 },
    { str: 'Closing Balance', x: 99.7, y: 100.0, w: 66.0 },
    { str: '381,742.12',      x: 451.5, y: 100.0, w: 45.0 },
    { str: '381,742.12',      x: 525.0, y: 100.0, w: 45.0 },
  ]];
  const res = jn.parseFromPageItems(pages, JN_TEXT);
  assert.equal(res.transactions.length, 0);
});

test('JN Bank: a 7-figure credit stays a credit (money columns split on the RIGHT edge)', () => {
  // The money columns are right-aligned, so a large credit's LEFT edge slides
  // into the debit column's left-edge zone — booking a deposit as a withdrawal.
  // Here the credit's left edge (439.1) sits below the old 440 credit cutoff
  // while its right edge (496.5) is squarely in the credit column.
  const pages = [[
    { str: 'Jan 25, 2021',  x: 20.0,  y: 325.7, w: 50.8 },
    { str: 'Deposit',       x: 99.7,  y: 325.7, w: 31.1 },
    { str: '12,345,678.90', x: 439.1, y: 325.7, w: 57.4 },
    { str: '12,698,060.94', x: 512.6, y: 325.7, w: 57.4 },
  ]];
  const res = jn.parseFromPageItems(pages, JN_TEXT);

  assert.equal(res.transactions.length, 1);
  assert.equal(res.transactions[0].amount, 12345678.90);
  assert.equal(res.transactions[0].type, 'credit');
});

test('JN Bank: coordinate items with no width fall back to the left-edge zones', () => {
  const pages = [[
    { str: 'Jan 02, 2021', x: 20,    y: 469.7 },
    { str: 'Withdrawal',   x: 99.7,  y: 469.7 },
    { str: '17.77',        x: 397.9, y: 469.7 },
    { str: '1,088,286.35', x: 517.5, y: 469.7 },
    { str: 'Jan 25, 2021', x: 20,    y: 325.7 },
    { str: 'Deposit',      x: 99.7,  y: 325.7 },
    { str: '42,200.00',    x: 456.5, y: 325.7 },
    { str: '352,382.04',   x: 525.0, y: 325.7 },
  ]];
  const res = jn.parseFromPageItems(pages, JN_TEXT);
  assert.equal(res.transactions.length, 2);
  assert.equal(res.transactions[0].amount, -17.77);
  assert.equal(res.transactions[1].amount, 42200);
});

test('JN Bank: a dated row whose amount misses every column is WARNED about, not silently dropped', () => {
  const pages = [[
    { str: 'Jan 02, 2021', x: 20.0,  y: 469.7, w: 50.8 },
    { str: 'MYSTERY ROW',  x: 99.7,  y: 469.7, w: 55.0 },
    { str: '4,025.00',     x: 300.0, y: 469.7, w: 35.0 },   // right edge 335 → no column
  ]];
  const res = jn.parseFromPageItems(pages, JN_TEXT);
  assert.equal(res.transactions.length, 0);
  assert.ok(res.warnings.some(w => /SKIPPED/.test(w) && /MYSTERY ROW/.test(w)));
});

test('JN Bank: falls back to the header period when no transactions are found', () => {
  const res = jn.parseFromPageItems([[]], JN_TEXT);
  assert.equal(res.transactions.length, 0);
  assert.equal(res.period.start, '2021-01-01');
  assert.equal(res.period.end, '2021-12-31');
});
