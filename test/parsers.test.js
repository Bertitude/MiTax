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

test('JN Bank: money columns are re-derived from the page header', () => {
  // The Debit/Credit/Balance headings are right-aligned with the columns they
  // label, so the boundaries can be read off the page instead of hardcoded.
  const header = [
    { str: 'Transaction Date',        x: 20.0,  y: 507, w: 74.2 },
    { str: 'Transaction Type',        x: 99.7,  y: 507, w: 75.9 },
    { str: 'Transaction Description', x: 184.8, y: 507, w: 103.6 },
    { str: 'Debit',                   x: 397.2, y: 507, w: 23.3 },   // right 420.5
    { str: 'Credit',                  x: 468.9, y: 507, w: 27.8 },   // right 496.7
    { str: 'Balance',                 x: 536.1, y: 507, w: 33.9 },   // right 570.0
  ];
  const cols = jn.moneyColumnsFromHeader(header);
  assert.ok(cols, 'header row should be recognized');
  // Midpoints between the header right edges, which sit within 0.2pt of the
  // amount right edges beneath them.
  assert.ok(Math.abs(cols.debitMax  - 458.6) < 0.5, `debitMax ${cols.debitMax}`);
  assert.ok(Math.abs(cols.creditMax - 533.3) < 0.5, `creditMax ${cols.creditMax}`);
  assert.ok(cols.minRight < 420.5 && cols.minRight > 288.4,
    'lower bound sits between the description column and the debit column');
});

test('JN Bank: the summary page headings are NOT mistaken for the table header', () => {
  // The summary page prints "Debit"/"Credit" one column further right and with
  // no "Balance". Adopting those offsets would shift every column by one, so
  // the full triplet is required.
  const summaryHeadings = [
    { str: 'Transaction Summary', x: 20.0,  y: 636, w: 115.7 },
    { str: 'Debit',               x: 473.3, y: 639, w: 23.3 },   // right 496.6
    { str: 'Credit',              x: 542.4, y: 639, w: 27.7 },   // right 570.1
  ];
  assert.equal(jn.moneyColumnsFromHeader(summaryHeadings), null);
});

test('JN Bank: a dormant statement period reports no activity, not a broken file', () => {
  // Real Jan-2023 monthly statement: the account was dormant, so JN printed
  // the opening and closing balance and nothing between them. Reporting this
  // as "unsupported or a scanned-image PDF" blames a file that parsed fine.
  const text = 'RSV-002094352472\nJMD\n' +
    'Savings Transactions Statement for the Period Jan 01, 2023 - Jan 31, 2023';
  const pages = [[
    { str: 'Debit',           x: 397.2, y: 507,   w: 23.3 },
    { str: 'Credit',          x: 468.9, y: 507,   w: 27.8 },
    { str: 'Balance',         x: 536.1, y: 507,   w: 33.9 },
    { str: 'Jan 01, 2023',    x: 20.0,  y: 489,   w: 50.8 },
    { str: 'Opening Balance', x: 99.7,  y: 489,   w: 69.2 },
    { str: '1,106.26',        x: 461.5, y: 489,   w: 35.0 },
    { str: '1,106.26',        x: 535.0, y: 489,   w: 35.0 },
    { str: 'Jan 31, 2023',    x: 20.0,  y: 471,   w: 50.8 },
    { str: 'Closing Balance', x: 99.7,  y: 471,   w: 65.8 },
    { str: '1,106.26',        x: 461.5, y: 471,   w: 35.0 },
    { str: '1,106.26',        x: 535.0, y: 471,   w: 35.0 },
  ]];
  const res = jn.parseFromPageItems(pages, text);

  assert.equal(res.transactions.length, 0);
  assert.equal(res.emptyPeriod, true);
  assert.equal(res.period.start, '2023-01-01');
  assert.equal(res.period.end, '2023-01-31');
  assert.ok(res.warnings.some(w => /no activity/i.test(w)));
  assert.ok(!res.warnings.some(w => /scanned-image/i.test(w)));

  // ...and the dispatcher must not pile the generic file-blaming warning on top
  const validated = require('../src/parsers/index').validateResult(res);
  assert.ok(!validated.warnings.some(w => /unsupported or a scanned-image/i.test(w)));
});

test('JN Bank: an unrecognized empty result still blames the file', () => {
  // Guard against the emptyPeriod escape hatch swallowing genuine failures:
  // with no balance rows there is no evidence the table was ever found.
  const { validateResult } = require('../src/parsers/index');
  const res = validateResult({ institution: 'JN Bank', transactions: [] });
  assert.ok(res.warnings.some(w => /unsupported or a scanned-image/i.test(w)));

  const jnEmpty = jn.parseFromPageItems([[]], 'RSV-002094352472');
  assert.ok(!jnEmpty.emptyPeriod);
});

test('JN Bank: a wrapped description is folded into the row, not dropped', () => {
  // The description column is empty on every JN savings statement seen so far,
  // so this covers the same wrap the transaction-type column demonstrably does.
  const pages = [[
    { str: 'Feb 21, 2023',      x: 20.0,  y: 471,   w: 50.8 },
    { str: 'Deposit',           x: 99.7,  y: 471,   w: 31.1 },
    { str: 'STANDING ORDER',    x: 184.8, y: 471,   w: 90.0 },
    { str: '70,000.00',         x: 456.5, y: 471,   w: 40.0 },
    { str: '71,106.26',         x: 529.9, y: 471,   w: 40.0 },
    { str: 'REF 8842',          x: 184.8, y: 459.9, w: 50.0 },   // wrapped description
  ]];
  const res = jn.parseFromPageItems(pages, JN_TEXT);

  assert.equal(res.transactions.length, 1);
  assert.equal(res.transactions[0].amount, 70000);
  assert.equal(res.transactions[0].notes, 'STANDING ORDER REF 8842');
});

// ── Transaction-list format (online-banking export) ──────────────────────────
//
// Coordinates below mirror real exports: each transaction is a PRIMARY row
// (day | description | right-aligned amount) followed by a CONTINUATION row
// (year | type). Column x-offsets differ between exports, so the parser derives
// them from the header — these fixtures use the offsets from one real file.

const txlist = require('../src/parsers/txlist');

const TXL_HEADER = [
  { str: 'Date',         x: 7,   y: 633, w: 28 },
  { str: 'Description',  x: 56,  y: 633, w: 43 },
  { str: 'Amount (JMD)', x: 349, y: 633, w: 55 },
];
const TXL_TEXT = 'Date Description Amount (JMD)\nPurchase/Other Charge\nPayment Received';

test('txlist: purchases and payments get opposite signs from the type line', () => {
  const pages = [[
    ...TXL_HEADER,
    { str: 'Jul 02', x: 7,   y: 615, w: 23 },
    { str: 'The Palace Amusement-, Kingston', x: 57, y: 615, w: 133 },
    { str: '$2,400.00', x: 364, y: 615, w: 41 },
    { str: '2021', x: 7, y: 603, w: 19 },
    { str: 'Purchase/Other Charge', x: 57, y: 603, w: 89 },

    { str: 'Jun 30', x: 7,   y: 534, w: 26 },
    { str: 'Card Payment Internet-****1222', x: 57, y: 534, w: 123 },
    { str: '-$50,000.00', x: 354, y: 534, w: 51 },
    { str: '2021', x: 7, y: 522, w: 19 },
    { str: 'Payment Received', x: 57, y: 522, w: 71 },
  ]];
  const res = txlist.parseFromPageItems(pages, TXL_TEXT, { institution: 'Scotiabank' });

  assert.equal(res.transactions.length, 2);
  assert.equal(res.institution, 'Scotiabank');
  assert.equal(res.currency, 'JMD');

  const [purchase, payment] = res.transactions;
  assert.equal(purchase.date, '2021-07-02');
  assert.equal(purchase.amount, -2400);          // purchase → expense
  assert.equal(purchase.type, 'debit');
  assert.equal(payment.date, '2021-06-30');
  assert.equal(payment.amount, 50000);           // payment to the card → credit
  assert.equal(payment.type, 'credit');
  assert.deepEqual(res.warnings, []);
});

test('txlist: columns are derived from the header, not hardcoded', () => {
  // Same statement shifted right ~29pt, as a different export of the same
  // format really is. Hardcoded boundaries would misread every column.
  const shift = 29;
  const move  = (it) => ({ ...it, x: it.x + shift });
  const pages = [[
    ...TXL_HEADER.map(move),
    { str: 'Mar22', x: 7 + shift, y: 615, w: 24 },
    { str: 'Active Home Centre, Kingston10', x: 57 + shift, y: 615, w: 124 },
    { str: '$601.43', x: 369 + shift, y: 615, w: 33 },
    { str: '2022', x: 7 + shift, y: 603, w: 19 },
    { str: 'Purchase/Other Charge', x: 57 + shift, y: 603, w: 89 },
  ]];
  const res = txlist.parseFromPageItems(pages, TXL_TEXT);

  assert.equal(res.transactions.length, 1);
  assert.equal(res.transactions[0].date, '2022-03-22');   // "Mar22", no space
  assert.equal(res.transactions[0].amount, -601.43);
});

test('txlist: OCR damage inside numbers and days is repaired', () => {
  const pages = [[
    ...TXL_HEADER,
    // Space inserted inside the day ("Oct1 8" = Oct 18) and inside the amount.
    { str: 'Oct1 8', x: 7, y: 615, w: 26 },
    { str: 'Frame. io, New York', x: 57, y: 615, w: 80 },
    { str: '$2 ,31 2.69', x: 360, y: 615, w: 45 },
    { str: '2021', x: 7, y: 603, w: 19 },
    { str: 'Purchase/Other Charge', x: 57, y: 603, w: 89 },
    // Spaces around the thousands comma, and after the minus sign.
    { str: 'Dec31', x: 7, y: 570, w: 24 },
    { str: 'Card Payment Internet -****1222', x: 57, y: 570, w: 123 },
    { str: '-$ 20 , 000.00', x: 350, y: 570, w: 55 },
    { str: '2021', x: 7, y: 558, w: 19 },
    { str: 'Payment Received', x: 57, y: 558, w: 71 },
  ]];
  const res = txlist.parseFromPageItems(pages, TXL_TEXT);

  assert.equal(res.transactions.length, 2);
  assert.equal(res.transactions[0].date, '2021-10-18');
  assert.equal(res.transactions[0].amount, -2312.69);
  assert.equal(res.transactions[1].amount, 20000);
  assert.deepEqual(res.warnings, []);
});

test('txlist: a merchant containing a type word is not eaten as a type line', () => {
  // "Cash Advance Fee At Atm" is a real purchase description. A loose type
  // match consumed the row, losing the transaction AND inflating the expected
  // count — so the type line is anchored to the whole cell.
  const pages = [[
    ...TXL_HEADER,
    { str: 'Apr 29', x: 7, y: 615, w: 26 },
    { str: 'Cash Advance Fee At Atm', x: 57, y: 615, w: 100 },
    { str: '$429.18', x: 369, y: 615, w: 36 },
    { str: '2021', x: 7, y: 603, w: 19 },
    { str: 'Purchase/Other Charge', x: 57, y: 603, w: 89 },
  ]];
  const res = txlist.parseFromPageItems(pages, TXL_TEXT);

  assert.equal(res.transactions.length, 1);
  assert.equal(res.transactions[0].payee, 'Cash Advance Fee At Atm');
  assert.equal(res.transactions[0].amount, -429.18);
  assert.deepEqual(res.warnings, []);
});

test('txlist: an unreadable row is REPORTED with its details, never silently dropped', () => {
  // Real damage: OCR rendered "May 05" as "Mayos" (o→0, s→5). Guessing the
  // characters would book the transaction to an invented date, so the row is
  // dropped — but every transaction prints a type line, so the parser knows
  // one went missing and says which.
  const pages = [[
    ...TXL_HEADER,
    { str: 'Mayos', x: 7, y: 615, w: 25 },
    { str: "Wendy's- Waterloo Squa, Kingston 10", x: 57, y: 615, w: 140 },
    { str: '$1,630.00', x: 364, y: 615, w: 41 },
    { str: '2021', x: 7, y: 603, w: 19 },
    { str: 'Purchase/Other Charge', x: 57, y: 603, w: 89 },
  ]];
  const res = txlist.parseFromPageItems(pages, TXL_TEXT);

  assert.equal(res.transactions.length, 0);
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0], /1 of 1 transaction row\(s\) could NOT be read/);
  assert.match(res.warnings[0], /Mayos/);
  assert.match(res.warnings[0], /Wendy's- Waterloo Squa/);   // identifies the row
  assert.match(res.warnings[0], /1,630\.00/);
});

test('txlist: repairMoney rejects what it cannot read unambiguously', () => {
  assert.equal(txlist.repairMoney('$26 , 133.37'), 26133.37);
  assert.equal(txlist.repairMoney('$7 5 ,095.00'), 75095.00);
  assert.equal(txlist.repairMoney('-$ 15,000.00'), -15000);
  assert.equal(txlist.repairMoney('$601.43'), 601.43);
  assert.equal(txlist.repairMoney('1,200.00 3,400.00'), null);  // two amounts collided
  assert.equal(txlist.repairMoney('Kingston 10'), null);        // not money
  assert.equal(txlist.repairMoney(''), null);
});

test('txlist: repairMonthDay repairs spacing but refuses to guess characters', () => {
  assert.deepEqual(txlist.repairMonthDay('Jul 02'), { month: 7,  day: 2  });
  assert.deepEqual(txlist.repairMonthDay('Mar22'),  { month: 3,  day: 22 });
  assert.deepEqual(txlist.repairMonthDay('Oct1 8'), { month: 10, day: 18 });
  assert.equal(txlist.repairMonthDay('Mayos'), null);      // o→0/s→5 NOT guessed
  assert.equal(txlist.repairMonthDay('Jun 45'), null);     // impossible day
  assert.equal(txlist.repairMonthDay('Description'), null);
});

test('txlist: looksLikeTxList recognizes the format for the import picker', () => {
  assert.equal(txlist.looksLikeTxList(TXL_TEXT), true);
  assert.equal(txlist.looksLikeTxList('JN Bank\nRSV-002094352472\nOpening Balance'), false);
  assert.equal(txlist.looksLikeTxList(''), false);
});
