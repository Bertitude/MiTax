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

test('generateS04A: due dates are valid ISO and lexicographically past-checked', () => {
  const r = generateS04A({
    currentYear: 2025,
    priorYearFiling: { tax_payable: 800_000, gross_income: 5_000_000 },
    currentYtdIncome: 0,
    todayStr: '2025-07-08',
  });

  // N5: valid YYYY-MM-DD, not the old "2025-03 15-15" Invalid Date.
  assert.deepEqual(r.quarters.map(q => q.dueDate),
    ['2025-03-15', '2025-06-15', '2025-09-15', '2025-12-15']);
  assert.equal(r.quarters[0].dueDateFormatted, 'Mar 15 2025');
  assert.ok(!Number.isNaN(new Date(r.quarters[0].dueDate).getTime()));

  // On 2025-07-08, Q1 (Mar) and Q2 (Jun) are past; Q3/Q4 are not.
  assert.deepEqual(r.quarters.map(q => q.isPast), [true, true, false, false]);
});

test('generateS04A: monthsElapsed counts the partial current month correctly', () => {
  // N6: (month-1) + day/daysInMonth, NOT (getMonth()+1) + day/31.
  const mid = generateS04A({
    currentYear: 2025, priorYearFiling: null, currentYtdIncome: 0, todayStr: '2025-07-08',
  });
  assert.equal(mid.monthsElapsed, 6.26);   // 6 + 8/31

  const early = generateS04A({
    currentYear: 2025, priorYearFiling: null, currentYtdIncome: 0, todayStr: '2025-02-01',
  });
  assert.equal(early.monthsElapsed, 1.04);  // 1 + 1/28
});

test('generateS04A: past year uses a full 12 months elapsed', () => {
  // N6 coupled bug: a past-year estimate must not divide a (clamped) YTD window
  // by a fractional month count. currentYear < today's year → 12 months.
  const r = generateS04A({
    currentYear: 2024,
    priorYearFiling: { tax_payable: 800_000, gross_income: 5_000_000 },
    currentYtdIncome: 6_000_000,
    todayStr: '2026-07-08',
  });
  assert.equal(r.monthsElapsed, 12);
  assert.equal(r.annualTrendIncome, 6_000_000);   // 6M / 12 * 12, not inflated
});

test('generateS04A: falls back to prior-year base when income signal is thin', () => {
  // ≥3 months elapsed but YTD income far below the prior-year pace (likely
  // incomplete uploads) → keep the base, do NOT ratchet toward $0.
  const r = generateS04A({
    currentYear: 2025,
    priorYearFiling: { tax_payable: 800_000, gross_income: 6_000_000 },
    currentYtdIncome: 500_000,     // ~6 months, expected ≈ 3,000,000 → coverage ≈ 0.17
    todayStr: '2025-07-08',
  });

  assert.equal(r.insufficientSignal, true);
  assert.equal(r.useAdjusted, false);
  assert.equal(r.recommendedQuarterly, r.baseQuarterly);   // 800k / 4 = 200k
  assert.equal(r.recommendedQuarterly, 200_000);
  assert.ok(r.notes.some(n => /prior-year base/.test(n)));
});

test('generateS04A: trend still applies once income signal is sufficient', () => {
  // Coverage ≥ 50% and clearly up vs prior year → adjust upward.
  const r = generateS04A({
    currentYear: 2025,
    priorYearFiling: { tax_payable: 800_000, gross_income: 6_000_000 },
    currentYtdIncome: 6_000_000,   // ~6 months → annualTrend ≈ 12M, +100% vs prior
    todayStr: '2025-07-08',
  });

  assert.equal(r.insufficientSignal, false);
  assert.equal(r.useAdjusted, true);
  assert.ok(r.trendRatio > 1);
  assert.ok(r.recommendedQuarterly > r.baseQuarterly);
});

test('generateS04A: four instalments sum exactly to the annual figure', () => {
  // N24: cents-exact split (Q4 carries the remainder), no float drift.
  const r = generateS04A({
    currentYear: 2026,
    priorYearFiling: { tax_payable: 100_000.10, gross_income: 5_000_000 },
    currentYtdIncome: 0,
    todayStr: '2026-02-01',   // <3 months → ratio forced to 1 → recommend = prior
  });
  const recSum  = r.quarters.reduce((a, q) => a + q.recommendedAmount, 0);
  const baseSum = r.quarters.reduce((a, q) => a + q.baseAmount, 0);
  assert.equal(Math.round(recSum  * 100) / 100, 100_000.10);
  assert.equal(Math.round(baseSum * 100) / 100, 100_000.10);
  assert.equal(r.quarters[3].recommendedAmount, 25_000.04);   // remainder on Q4
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
