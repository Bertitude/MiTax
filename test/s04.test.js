'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { generateS04, generateS04A, getTaxParams } = require('../src/tax/s04');

test('getTaxParams: exact match and fallback selection', () => {
  assert.equal(getTaxParams(2023).fallback, null);
  assert.equal(getTaxParams(2023).params.personalThreshold, 1500096);

  // Year past the last defined → falls back to the latest defined (2026)
  const future = getTaxParams(2099);
  assert.equal(future.fallback.usedYear, 2026);
  assert.equal(future.fallback.requestedYear, 2099);

  // Year before any defined → also uses newest defined overall
  assert.equal(getTaxParams(2000).fallback.usedYear, 2026);
});

test('generateS04: upper-band chargeable income (2023 params)', async () => {
  const r = await generateS04({
    year: 2023,
    apiKey: null,
    manualData: { businessIncome: 10_000_000 },
  });

  assert.equal(r.income.grossIncome, 10_000_000);
  assert.equal(r.deductions.allowableBusinessExpenses, 2_000_000);   // 20% standard
  assert.equal(r.statutoryIncome, 8_000_000);
  assert.equal(r.chargeableIncome, 6_349_904);                       // 8M - 1,500,096 - 150,000
  assert.equal(r.tax.incomeTax, 1_604_971.2);                        // band1*.25 + excess*.30
  assert.equal(r.contributions.nis, 150_000);                        // min(10M,5M)*.03
  assert.equal(r.contributions.nht, 200_000);                        // 10M*.02
  assert.equal(r.contributions.educationTax, 180_000);               // 8M*.0225
  assert.equal(r.totalTaxPayable, 2_134_971.2);
});

test('generateS04: income below threshold yields zero income tax', async () => {
  const r = await generateS04({
    year: 2023,
    apiKey: null,
    manualData: { businessIncome: 1_000_000 },
  });

  assert.equal(r.chargeableIncome, 0);
  assert.equal(r.tax.incomeTax, 0);
  assert.equal(r.contributions.nis, 30_000);            // 1M*.03
  assert.equal(r.contributions.nht, 20_000);            // 1M*.02
  assert.equal(r.contributions.educationTax, 18_000);   // 800k*.0225
  assert.equal(r.totalTaxPayable, 68_000);
});

test('generateS04: P24 employment income with withholding credits (2024)', async () => {
  const r = await generateS04({
    year: 2024,
    apiKey: null,
    manualData: { businessIncome: 4_000_000 },
    p24Totals: {
      grossEmoluments: 3_000_000, nisDeducted: 90_000, nhtDeducted: 60_000,
      edTaxDeducted: 67_500, payeDeducted: 200_000, entryCount: 12,
    },
  });

  assert.equal(r.income.grossIncome, 7_000_000);          // 4M business + 3M employment
  assert.equal(r.statutoryIncome, 5_600_000);             // 7M - 20% standard
  assert.equal(r.chargeableIncome, 3_749_912);            // 5.6M - 1,700,088 - 150,000
  assert.equal(r.tax.incomeTax, 737_478);                 // 937,478 liability - 200,000 PAYE
  assert.equal(r.contributions.nis, 60_000);              // 150,000 liability - 90,000 withheld
  assert.equal(r.contributions.nht, 80_000);              // 140,000 - 60,000
  assert.equal(r.contributions.educationTax, 58_500);     // 126,000 - 67,500
  assert.equal(r.totalTaxPayable, 935_978);
  assert.equal(r.p24.totalGrossLiability, 1_353_478);
});

test('estimateAnnualTax: matches the S04 core on a whole-income case', () => {
  const { estimateAnnualTax, getTaxParams } = require('../src/tax/s04');
  const { params } = getTaxParams(2023);
  const est = estimateAnnualTax(10_000_000, params);
  // Same params/formula as the generateS04 upper-band test above.
  assert.equal(est.nis, 150_000);
  assert.equal(est.nht, 200_000);
  assert.equal(est.edTax, 180_000);
  assert.equal(est.incomeTax, 1_604_971.2);
  assert.equal(est.total, 2_134_971.2);
});

test('generateS04A: quarterly instalments from a prior filing', () => {
  const r = generateS04A({
    currentYear: 2025,
    priorYearFiling: { tax_payable: 800_000, gross_income: 5_000_000 },
    currentYtdIncome: 0,
    todayStr: '2025-02-01',
  });

  assert.equal(r.priorYear, 2024);
  assert.equal(r.hasPriorFiling, true);
  assert.equal(r.baseQuarterly, 200_000);               // 800k / 4
  assert.equal(r.quarters.length, 4);
});
