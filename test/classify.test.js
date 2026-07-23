'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { buildClassifier, matchIncomeType, S04_CATEGORY_PACK } = require('../src/tax/classify');
const { generateS04 } = require('../src/tax/s04');

// ─── Word-boundary matching: the false positives that motivated the rewrite ──

test('matchIncomeType: "rent" no longer matches inside other words', () => {
  assert.equal(matchIncomeType('CURRENT ACCOUNT TRANSFER'), null);   // cur-RENT
  assert.equal(matchIncomeType('PARENT PAYMENT'), null);
  assert.equal(matchIncomeType('APARTMENT VIEWING'), null);
  assert.equal(matchIncomeType('RENT RECEIVED'), 'rental');          // the real thing still works
});

test('matchIncomeType: "interest" no longer matches PINTEREST', () => {
  assert.equal(matchIncomeType('PINTEREST INC'), null);
  assert.equal(matchIncomeType('INTEREST PAYMENT'), 'investment');
});

test('classifier: a categorized transaction is NEVER classified from its payee text', () => {
  // The user categorized this credit as Groceries; the payee containing an
  // income keyword must not override that into rental income.
  const classify = buildClassifier({
    categories: [{ id: 1, name: 'Groceries' }],
    userCategoryMappings: {},
  });
  const r = classify({ category_id: 1, category_name: 'Groceries', payee: 'RENT REFUND FROM LANDLORD', amount: 5000 });
  assert.equal(r.bucket, 'unclassified');   // Groceries matches no tax bucket — surfaced, not guessed
});

// ─── Priority order ──────────────────────────────────────────────────────────

test('classifier: user mapping outranks the LunchMoney is_income flag', () => {
  const classify = buildClassifier({
    categories: [{ id: 7, name: 'Client Deposits', is_income: true }],
    userCategoryMappings: { 7: { ignore: true } },
  });
  assert.deepEqual(classify({ category_id: 7 }), { bucket: 'ignored', source: 'mapping' });
});

test('classifier: LunchMoney exclude_from_totals / is_group beat everything but mappings', () => {
  const classify = buildClassifier({
    categories: [
      { id: 1, name: 'Transfers', exclude_from_totals: true },
      { id: 2, name: 'Payment Group', is_group: true },
    ],
  });
  assert.deepEqual(classify({ category_id: 1 }), { bucket: 'excluded', source: 'lm-flag' });
  assert.deepEqual(classify({ category_id: 2 }), { bucket: 'excluded', source: 'lm-flag' });
});

test('classifier: is_income categories become income, subtyped from the category name', () => {
  const classify = buildClassifier({
    categories: [
      { id: 1, name: 'Rental Income', is_income: true },
      { id: 2, name: 'Consulting',    is_income: true },   // no subtype keyword → business default
    ],
  });
  assert.deepEqual(classify({ category_id: 1 }), { bucket: 'income:rental',   source: 'lm-flag' });
  assert.deepEqual(classify({ category_id: 2 }), { bucket: 'income:business', source: 'lm-flag' });
});

test('classifier: uncategorized transactions fall back to payee/notes as a flagged guess', () => {
  const classify = buildClassifier({});
  assert.deepEqual(classify({ payee: 'CLIENT PAYMENT — ACME LTD' }), { bucket: 'income:business', source: 'keyword' });
  assert.deepEqual(classify({ payee: 'RANDOM DEPOSIT' }), { bucket: 'unclassified', source: 'none' });
});

// ─── End-to-end through generateS04 (injected data, no API) ─────────────────

const CATS = [
  { id: 1, name: 'Business Income', is_income: true },
  { id: 2, name: 'Office Supplies' },                          // deductible via keyword
  { id: 3, name: 'Transfers', exclude_from_totals: true },
  { id: 4, name: 'Weird Stuff' },                              // matches nothing
];

test('generateS04: refunds in expense categories net against expenses, never income', async () => {
  const r = await generateS04({
    year: 2023,
    apiKey: null,
    transactions: [
      { date: '2023-02-01', amount: 100000, category_id: 1, category_name: 'Business Income', payee: 'CLIENT' },
      { date: '2023-03-01', amount: -10000, category_id: 2, category_name: 'Office Supplies', payee: 'STAPLES' },
      { date: '2023-03-15', amount:   2000, category_id: 2, category_name: 'Office Supplies', payee: 'STAPLES RETURN' },
    ],
    categories: CATS,
    manualData: { useActualExpenses: true },
  });

  assert.equal(r.income.grossIncome, 100000);          // refund is NOT income
  assert.equal(r.deductions.actualExpenses, 8000);     // 10,000 − 2,000 refund
});

test('generateS04: transfers and unclassified credits never count as income — and are reported', async () => {
  const r = await generateS04({
    year: 2023,
    apiKey: null,
    transactions: [
      { date: '2023-02-01', amount: 100000, category_id: 1, category_name: 'Business Income', payee: 'CLIENT' },
      { date: '2023-04-01', amount:  50000, category_id: 3, category_name: 'Transfers', payee: 'FROM SAVINGS CURRENT ACCOUNT' },
      { date: '2023-05-01', amount:   7000, category_id: 4, category_name: 'Weird Stuff', payee: 'MYSTERY CREDIT' },
    ],
    categories: CATS,
  });

  assert.equal(r.income.grossIncome, 100000);
  assert.equal(r.classification.excludedTotal, 50000);
  assert.equal(r.classification.unclassifiedCredits, 7000);
  assert.ok(r.notes.some(n => n.includes('NOT counted as income')));
});

test('generateS04: income reversals (debits in an income category) reduce that income', async () => {
  const r = await generateS04({
    year: 2023,
    apiKey: null,
    transactions: [
      { date: '2023-02-01', amount: 100000, category_id: 1, category_name: 'Business Income', payee: 'CLIENT' },
      { date: '2023-02-20', amount: -20000, category_id: 1, category_name: 'Business Income', payee: 'CLIENT CHARGEBACK' },
    ],
    categories: CATS,
  });
  assert.equal(r.income.businessProfessionalIncome, 80000);
});

test('generateS04: keyword-guessed income is totalled and flagged in the notes', async () => {
  const r = await generateS04({
    year: 2023,
    apiKey: null,
    transactions: [
      { date: '2023-02-01', amount: 30000, payee: 'CLIENT PAYMENT — ACME' },   // uncategorized guess
    ],
    categories: CATS,
  });
  assert.equal(r.classification.guessedIncome, 30000);
  assert.ok(r.notes.some(n => n.includes('KEYWORD GUESSING')));
  const row = r.classification.rows.find(x => x.source === 'keyword');
  assert.equal(row.bucket, 'income:business');
});

test('S04_CATEGORY_PACK: income categories carry is_income, Transfers is excluded, mappings are valid', () => {
  const income = S04_CATEGORY_PACK.filter(c => c.isIncome);
  assert.equal(income.length, 5);
  assert.ok(income.every(c => c.mapping.startsWith('income:')));
  const transfers = S04_CATEGORY_PACK.find(c => c.name === 'Transfers');
  assert.equal(transfers.excludeFromTotals, true);
  assert.equal(transfers.mapping, 'ignore');
  const valid = ['income:business', 'income:foreign', 'income:investment', 'income:rental', 'income:other', 'expense', 'ignore'];
  assert.ok(S04_CATEGORY_PACK.every(c => valid.includes(c.mapping)));
});
