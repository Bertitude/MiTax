'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { generateS04, generateS04A, getTaxParams, taxParamsStatus, TAX_PARAMS } = require('../src/tax/s04');

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
  assert.equal(r.chargeableIncome, 3_799_910);            // 5.6M - 1,650,090 - 150,000
  assert.equal(r.tax.incomeTax, 749_977.5);               // 949,977.50 liability - 200,000 PAYE
  assert.equal(r.contributions.nis, 60_000);              // 150,000 liability - 90,000 withheld
  assert.equal(r.contributions.nht, 80_000);              // 140,000 - 60,000
  assert.equal(r.contributions.educationTax, 58_500);     // 126,000 - 67,500
  assert.equal(r.totalTaxPayable, 948_477.5);
  assert.equal(r.p24.totalGrossLiability, 1_365_977.5);
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

test('TAX_PARAMS: thresholds are TAJ effective-annual values', () => {
  // April-1 increases are pro-rated by TAJ into a published effective annual
  // threshold per year of assessment — these pins guard against regressing to
  // the raw post-April figures (audit finding N15).
  assert.equal(TAX_PARAMS[2023].personalThreshold, 1_500_096); // no mid-year change
  assert.equal(TAX_PARAMS[2024].personalThreshold, 1_650_090); // 1,500,096 Jan–Mar + 1,700,088 Apr–Dec
  assert.equal(TAX_PARAMS[2025].personalThreshold, 1_774_470); // 1,700,088 Jan–Mar + 1,799,376 Apr–Dec
  assert.equal(TAX_PARAMS[2026].personalThreshold, 1_876_614); // 1,799,376 Jan–Mar + 1,902,360 Apr–Dec
});

test('taxParamsStatus: fresh when verified after the latest April 1', () => {
  // 2026 entries are verified 2026-07-08 ≥ 2026-04-01.
  assert.deepEqual(taxParamsStatus('2026-07-08'), { stale: false, reason: null });
  // Exactly on April 1: that day's window applies and the entries satisfy it.
  assert.equal(taxParamsStatus('2026-04-01').stale, false);
});

test('taxParamsStatus: stale when the current year has no entry', () => {
  const r = taxParamsStatus('2099-06-15');
  assert.equal(r.stale, true);
  assert.match(r.reason, /2099/);
});

test('taxParamsStatus: stale when nothing was verified since the latest April 1', () => {
  // Temporarily age every verifiedAt stamp to isolate the freshness branch
  // from the missing-year branch.
  const saved = Object.values(TAX_PARAMS).map(p => p.verifiedAt);
  try {
    Object.values(TAX_PARAMS).forEach(p => { p.verifiedAt = '2026-03-01'; });

    const r = taxParamsStatus('2026-06-15');   // window = 2026-04-01 → stale
    assert.equal(r.stale, true);
    assert.match(r.reason, /verified/);

    // Jan–Mar measures against the PRIOR year's April 1 (2025-04-01), so the
    // same stamps count as fresh.
    assert.equal(taxParamsStatus('2026-03-15').stale, false);
  } finally {
    Object.values(TAX_PARAMS).forEach((p, i) => { p.verifiedAt = saved[i]; });
  }
});
