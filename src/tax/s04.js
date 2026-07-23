/**
 * Jamaica S04 Annual Return — Self Employed Income Tax
 * Based on Tax Administration Jamaica (TAJ) S04 form structure.
 *
 * Per-year tax parameters are defined in TAX_PARAMS below. Each entry carries
 * a `source` URL and `verifiedAt` ISO date so reviewers can spot stale
 * figures. TAJ's Technical Advisory is the authoritative source — verify
 * against the portal before filing season.
 */

const { getTransactions, getTransactionYearSummary, getCategories, resolveTxAmount } = require('../lunchmoney');
const { buildClassifier } = require('./classify');

// ─── Tax Rates & Thresholds ─────────────────────────────────────────────────
//
// Sources cross-referenced: TAJ Technical Advisory 042025/01, KPMG 2025/2026
// budget summary, JIS threshold announcements, PwC Jamaica tax summaries,
// MLSS NIS rate sheets. NIS ceiling history: $1.5M through 2020, $3M in 2021,
// $5M from April 2022 onward (MLSS, PwC).

const TAX_PARAMS = {
  2023: {
    personalThreshold: 1500096,
    nisRate: 0.03,
    nisMaxIncome: 5000000,         // $5M since April 2022
    nhtRate: 0.02,
    edTaxRate: 0.0225,
    incomeTaxRate1: 0.25,
    incomeTaxRate2: 0.30,
    incomeTaxBand1Max: 6000000,
    standardDeductionRate: 0.20,
    source: 'https://taxsummaries.pwc.com/jamaica/individual/taxes-on-personal-income',
    verifiedAt: '2026-04-14',
  },
  2024: {
    // Threshold bumped from $1,500,096 to $1,700,088 effective Apr 1, 2024.
    // TAJ publishes the weighted full-year-effective value of $1,650,090 for
    // tax-year 2024 returns — that's what individuals actually use when filing.
    personalThreshold: 1650090,
    nisRate: 0.03,
    nisMaxIncome: 5000000,
    nhtRate: 0.02,
    edTaxRate: 0.0225,
    incomeTaxRate1: 0.25,
    incomeTaxRate2: 0.30,
    incomeTaxBand1Max: 6000000,
    standardDeductionRate: 0.20,
    source: 'https://www.dawgen.global/understanding-the-new-changes-to-payroll-taxes-in-jamaica-a-closer-look-at-the-increased-income-tax-threshold-and-exemptions/',
    verifiedAt: '2026-07-08',
  },
  2025: {
    // First tranche of the 2025/2026 budget's 3-step rise to $2M: $1,700,088
    // to $1,799,376 effective Apr 1, 2025. TAJ's weighted full-year-effective
    // value for tax-year 2025 returns is $1,774,470 (published figure — not
    // the naive 3/12 + 9/12 weighting, which gives 1,774,554).
    personalThreshold: 1774470,
    nisRate: 0.03,
    nisMaxIncome: 5000000,
    nhtRate: 0.02,
    edTaxRate: 0.0225,
    incomeTaxRate1: 0.25,
    incomeTaxRate2: 0.30,
    incomeTaxBand1Max: 6000000,
    standardDeductionRate: 0.20,
    source: 'https://jis.gov.jm/taj-develops-technical-advisory-for-revised-income-tax-threshold-and-pension-exemptions/',
    verifiedAt: '2026-07-08',
  },
  2026: {
    // Threshold bumped from $1,799,376 to $1,902,360 effective Apr 1, 2026.
    // TAJ publishes the weighted full-year-effective value of $1,876,614 for
    // tax-year 2026 returns — that's what individuals actually use when filing.
    personalThreshold: 1876614,
    nisRate: 0.03,
    nisMaxIncome: 5000000,
    nhtRate: 0.02,
    edTaxRate: 0.0225,
    incomeTaxRate1: 0.25,
    incomeTaxRate2: 0.30,
    incomeTaxBand1Max: 6000000,
    standardDeductionRate: 0.20,
    source: 'https://jamaica-gleaner.com/article/news/20260413/new-income-tax-threshold-effect-employers-reminded-make-adjustment',
    verifiedAt: '2026-04-14',
  },
};

// ─── Loss relief (individuals) ──────────────────────────────────────────────
// Per the S04 form instructions (Lines 41/54) under the Fiscal Incentives
// (Miscellaneous Provisions) Act 2013 rules: losses brought forward from prior
// years are claimable IN FULL when gross sales/receipts (S04 Line 11) are
// below $3,000,000; otherwise the claim is capped at 50% of the year's net
// profit before loss relief. The unused balance carries forward indefinitely.
// The user enters their OFFICIAL brought-forward figure (from prior S04
// filings / TAJ records) — MiTax does not derive it.
const LOSS_CLAIM_GROSS_SALES_LIMIT = 3000000;

/**
 * Return the tax parameters for a given year, plus a flag indicating whether
 * those are an exact match or a fallback to the most recent defined year.
 *
 * Returns { params, fallback: { usedYear, requestedYear } | null }.
 */
function getTaxParams(year) {
  if (TAX_PARAMS[year]) return { params: TAX_PARAMS[year], fallback: null };

  // Fall back to the latest defined year <= requested year; if none, use the
  // newest defined year overall.
  const definedYears = Object.keys(TAX_PARAMS).map(Number).sort((a, b) => a - b);
  const earlier = definedYears.filter(y => y <= year);
  const usedYear = earlier.length ? earlier[earlier.length - 1] : definedYears[definedYears.length - 1];
  return {
    params:   TAX_PARAMS[usedYear],
    fallback: { usedYear, requestedYear: year },
  };
}

/**
 * Report whether TAX_PARAMS may be stale. Jamaica's threshold changes take
 * effect every April 1 (announced in the March budget), so the params are
 * considered stale when no entry has been re-verified on or after the most
 * recent April 1, or when the current year has no entry at all.
 *
 * Pure: `todayStr` is an ISO date (YYYY-MM-DD) resolved to the user's
 * timezone by the caller.
 *
 * Returns { stale, reason }.
 */
function taxParamsStatus(todayStr) {
  const year  = parseInt(todayStr.slice(0, 4), 10);
  const monthDay = todayStr.slice(5); // 'MM-DD'
  const latestAprilFirst = monthDay >= '04-01' ? `${year}-04-01` : `${year - 1}-04-01`;

  if (!TAX_PARAMS[year]) {
    return { stale: true, reason: `No tax parameters defined for ${year}.` };
  }

  const newestVerifiedAt = Object.values(TAX_PARAMS)
    .map(p => p.verifiedAt || '')
    .sort()
    .pop();
  if (!newestVerifiedAt || newestVerifiedAt < latestAprilFirst) {
    return {
      stale:  true,
      reason: `Tax parameters were last verified ${newestVerifiedAt || 'never'}, before the ${latestAprilFirst} threshold change window.`,
    };
  }

  return { stale: false, reason: null };
}

// ─── Main generator ─────────────────────────────────────────────────────────

async function generateS04({ year, apiKey, manualData = {}, userCategoryMappings = {}, p24Totals = null, transactions = null, categories = null }) {
  const { params, fallback } = getTaxParams(year);

  let allTransactions = Array.isArray(transactions) ? transactions : [];
  let lmCategories    = Array.isArray(categories)   ? categories   : [];
  let categoriesWarning = null;

  // A tax report silently rendered from zero transactions looks identical to a
  // correct one — record WHY the data is empty so the report can say so.
  let dataWarning = null;

  // Fetch from LunchMoney if API key provided (`transactions`/`categories`
  // params inject data directly — used by tests and offline callers).
  if (apiKey && !Array.isArray(transactions)) {
    try {
      const startDate = `${year}-01-01`;
      const endDate = `${year}-12-31`;
      allTransactions = await getTransactions(apiKey, { startDate, endDate });
      if (!allTransactions.length) {
        dataWarning = `LunchMoney returned no transactions for ${year} — every income and expense figure below is $0. If you expect data, check that the connected budget is the right one and that this year's statements were uploaded.`;
        // Which years DO have data? An empty target year next to populated
        // other years is the signature of statements uploaded with wrong
        // transaction dates (old parsers defaulted the year when a statement's
        // period header didn't parse).
        try {
          const byYear = await getTransactionYearSummary(apiKey, {});
          const entries = Object.entries(byYear).sort((a, b) => b[0].localeCompare(a[0]));
          if (entries.length) {
            dataWarning += ` NOTE: this budget is not empty — it has transactions in ${entries.map(([y, n]) => `${y} (${n})`).join(', ')}. If those should belong to ${year}, the statements were uploaded with wrong transaction dates; re-import them to correct it.`;
          }
        } catch (_) { /* diagnostic only */ }
      }
    } catch (err) {
      console.warn('Could not fetch from LunchMoney:', err.message);
      dataWarning = `Could not fetch transactions from LunchMoney (${err.message}) — this report was generated WITHOUT transaction data and every figure derived from it is $0.`;
    }
  } else if (!apiKey && !Array.isArray(transactions)) {
    dataWarning = 'Not connected to LunchMoney — this report was generated WITHOUT transaction data.';
  }

  // Category metadata (is_income / exclude_from_totals flags) drives the
  // primary classification. A fetch failure here degrades to keyword
  // fallback — noted in the report rather than silently.
  if (apiKey && !Array.isArray(categories)) {
    try {
      lmCategories = await getCategories(apiKey);
    } catch (err) {
      categoriesWarning = `Could not load LunchMoney categories (${err.message}) — classification fell back to keyword matching for this report; income/expense typing may be less accurate.`;
    }
  }

  // ─── Categorize transactions ─────────────────────────────────────────────
  // Priority: user mapping → LunchMoney category flags (is_income /
  // exclude_from_totals / is_group) → word-boundary keywords. See classify.js.

  const classify = buildClassifier({ categories: lmCategories, userCategoryMappings });

  const income = {
    business: 0,
    foreign: 0,
    investment: 0,
    rental: 0,
    other: 0,
  };

  const expenses = { total: 0, breakdown: {} };

  // Track how many transactions used converted vs original amounts
  let convertedCount = 0;
  let unconvertedCount = 0;

  // Classification transparency: per-category aggregation so the report can
  // show WHAT was counted as what, and WHY. Uncategorized transactions can
  // classify differently per transaction (payee-based), so their rows are
  // split by resulting bucket.
  const catRows = new Map();
  let excludedTotal = 0, ignoredTotal = 0;
  let unclassifiedCredits = 0, unclassifiedDebits = 0;

  for (const tx of allTransactions) {
    // resolveTxAmount: sign from `amount` (honors debit_as_negative), magnitude
    // from `to_base` when present (correct multi-currency conversion) — see
    // its definition in lunchmoney.js for why to_base alone isn't sign-safe.
    const hasConversion = tx.to_base !== undefined && tx.to_base !== null;
    const amount = resolveTxAmount(tx);
    if (hasConversion) convertedCount++; else unconvertedCount++;
    if (!amount) continue;

    const { bucket, source } = classify(tx);
    const categoryLabel = tx.category_name || tx.category || 'Uncategorized';

    const rowKey = tx.category_id != null ? String(tx.category_id) : `(uncategorized)|${bucket}`;
    let row = catRows.get(rowKey);
    if (!row) {
      row = { category: categoryLabel, bucket, source, credits: 0, debits: 0, count: 0 };
      catRows.set(rowKey, row);
    }
    row.count++;
    if (amount > 0) row.credits += amount; else row.debits += Math.abs(amount);

    if (bucket === 'ignored')  { ignoredTotal  += Math.abs(amount); continue; }
    if (bucket === 'excluded') { excludedTotal += Math.abs(amount); continue; }
    if (bucket === 'unclassified') {
      if (amount > 0) unclassifiedCredits += amount; else unclassifiedDebits += Math.abs(amount);
      continue;
    }

    if (bucket.startsWith('income:')) {
      // Credits add; debits in an income category are income reversals
      // (e.g. a refunded client payment) and net against that income type.
      const type = bucket.slice('income:'.length);
      if (income[type] !== undefined) income[type] += amount;
      continue;
    }

    // 'expense': debits accumulate as deductible expenses; credits are
    // REFUNDS of expenses and net against the category — they are NOT income.
    if (amount < 0) {
      expenses.breakdown[categoryLabel] = (expenses.breakdown[categoryLabel] || 0) + Math.abs(amount);
    } else {
      expenses.breakdown[categoryLabel] = (expenses.breakdown[categoryLabel] || 0) - amount;
    }
  }

  // Floors: refunds can't drive a category (or an income type) below zero on
  // the return — the remainder is simply not deductible/taxable.
  for (const k of Object.keys(expenses.breakdown)) {
    if (expenses.breakdown[k] < 0) expenses.breakdown[k] = 0;
  }
  expenses.total = Object.values(expenses.breakdown).reduce((s, v) => s + v, 0);
  for (const k of Object.keys(income)) {
    if (income[k] < 0) income[k] = 0;
  }

  // Classification summary for the report (sorted by money involved).
  const classificationRows = [...catRows.values()]
    .map(r => ({ ...r, credits: roundJMD(r.credits), debits: roundJMD(r.debits) }))
    .sort((a, b) => (b.credits + b.debits) - (a.credits + a.debits));
  const guessedIncome = roundJMD(classificationRows
    .filter(r => r.bucket.startsWith('income:') && r.source === 'keyword')
    .reduce((s, r) => s + r.credits, 0));

  // Apply manual data overrides/additions
  if (manualData.businessIncome) income.business += manualData.businessIncome;
  if (manualData.foreignIncome) income.foreign += manualData.foreignIncome;
  if (manualData.investmentIncome) income.investment += manualData.investmentIncome;
  if (manualData.rentalIncome) income.rental += manualData.rentalIncome;
  if (manualData.additionalExpenses) expenses.total += manualData.additionalExpenses;

  // ─── P24 Employment Income ───────────────────────────────────────────────

  const p24 = {
    grossEmoluments: roundJMD(p24Totals?.grossEmoluments || 0),
    nisDeducted:     roundJMD(p24Totals?.nisDeducted     || 0),
    nhtDeducted:     roundJMD(p24Totals?.nhtDeducted     || 0),
    edTaxDeducted:   roundJMD(p24Totals?.edTaxDeducted   || 0),
    payeDeducted:    roundJMD(p24Totals?.payeDeducted    || 0),
    entryCount:      p24Totals?.entryCount || 0,
  };
  p24.totalWithheld = roundJMD(p24.nisDeducted + p24.nhtDeducted + p24.edTaxDeducted + p24.payeDeducted);

  // Employment income is included in gross; it flows through the same S04 calculation
  income.employment = p24.grossEmoluments;

  // ─── S04 Calculations ────────────────────────────────────────────────────

  const grossIncome = income.business + income.foreign + income.investment + income.rental + income.other + income.employment;

  // ── All tax math below is in integer cents (converted back to JMD at the end) ──
  const grossCents  = toCents(grossIncome);
  const actualExpenses = expenses.total;
  const actualExpCents = toCents(actualExpenses);

  // Allowable deductions
  const stdDedCents    = Math.round(grossCents * params.standardDeductionRate);
  const allowableCents = Math.max(actualExpCents, manualData.useActualExpenses ? actualExpCents : stdDedCents);
  // Which deduction method was actually applied (for the report label): the
  // user forcing actual, or actual simply exceeding the 20% standard.
  const usedActualMethod = !!manualData.useActualExpenses || actualExpCents >= stdDedCents;
  const statutoryCents = Math.max(0, grossCents - allowableCents);

  // ── Loss relief ──────────────────────────────────────────────────────────
  // Current-year net loss: the pre-floor shortfall the Math.max above discards
  // (only possible under the actual-expenses method — the 20% standard
  // deduction can never exceed gross). Never applied this year; surfaced so
  // the user knows they have a new loss to add to their carry-forward.
  const currentYearLossCents = Math.max(0, allowableCents - grossCents);

  const lossBfCents = Math.max(0, toCents(manualData.lossesBroughtForward || 0));
  // The $3M full-claim test is on gross sales/receipts of the trade (S04
  // Line 11) — business/professional income is the closest figure MiTax has,
  // not total income.
  const lossCapApplies = toCents(income.business) >= toCents(LOSS_CLAIM_GROSS_SALES_LIMIT);
  // Cap basis: 50% of net profit before loss relief (S04 Line 41 analog).
  const lossAppliedCents = lossCapApplies
    ? Math.min(lossBfCents, Math.round(statutoryCents * 0.5))
    : Math.min(lossBfCents, statutoryCents);
  const statutoryAfterLossCents = statutoryCents - lossAppliedCents;
  const lossCarriedForwardCents = lossBfCents - lossAppliedCents + currentYearLossCents;

  // NIS (National Insurance Scheme) — calculated on combined income, capped at nisMaxIncome.
  // P24 already withheld NIS on the employment portion; credit that and only charge
  // additional NIS on any self-employment income that remains under the cap.
  const nisableCents      = Math.min(grossCents, toCents(params.nisMaxIncome));
  const totalNisCents     = Math.round(nisableCents * params.nisRate);
  const additionalNisCents = Math.max(0, totalNisCents - toCents(p24.nisDeducted));

  // NHT (National Housing Trust)
  const totalNhtCents      = Math.round(grossCents * params.nhtRate);
  const additionalNhtCents = Math.max(0, totalNhtCents - toCents(p24.nhtDeducted));

  // Education Tax — deliberately computed on statutory income BEFORE loss
  // relief: prior-year loss deductibility against the Education Tax base is
  // not clearly documented for individuals, so the conservative (higher)
  // base is used and the assumption is stated in the report notes.
  const totalEdTaxCents      = Math.round(statutoryCents * params.edTaxRate);
  const additionalEdTaxCents = Math.max(0, totalEdTaxCents - toCents(p24.edTaxDeducted));

  // Chargeable Income (uses total NIS liability for the threshold deduction — per Jamaica IT Act).
  // Losses brought forward reduce the income-tax base only — NIS and NHT are
  // charged on gross income regardless.
  const chargeableCents = Math.max(0, statutoryAfterLossCents - toCents(params.personalThreshold) - totalNisCents);

  // Income Tax
  const totalIncomeTaxCents      = incomeTaxCents(chargeableCents, params);
  const additionalIncomeTaxCents = Math.max(0, totalIncomeTaxCents - toCents(p24.payeDeducted));

  const totalTaxPayableCents = additionalIncomeTaxCents + additionalNisCents + additionalNhtCents + additionalEdTaxCents;

  // Convert back to JMD for the report/consumers.
  const standardDeduction       = fromCents(stdDedCents);
  const allowableExpenses       = fromCents(allowableCents);
  const statutoryIncome         = fromCents(statutoryCents);
  const totalNisLiability       = fromCents(totalNisCents);
  const nisContribution         = fromCents(additionalNisCents);
  const totalNhtLiability       = fromCents(totalNhtCents);
  const nhtContribution         = fromCents(additionalNhtCents);
  const totalEdTaxLiability      = fromCents(totalEdTaxCents);
  const edTaxContribution       = fromCents(additionalEdTaxCents);
  const chargeableIncome        = fromCents(chargeableCents);
  const totalIncomeTaxLiability = fromCents(totalIncomeTaxCents);
  const incomeTax               = fromCents(additionalIncomeTaxCents);
  const totalTaxPayable         = fromCents(totalTaxPayableCents);

  // ─── S04 Form Structure ──────────────────────────────────────────────────

  const report = {
    year,
    generatedAt: new Date().toISOString(),
    taxParams: params,
    taxParamsFallback: fallback,   // non-null when requested year has no exact match
    dataWarning,                   // non-null when the report was built without/with empty transaction data

    // Part A: Income
    income: {
      businessProfessionalIncome: roundJMD(income.business),
      foreignSourcedIncome:       roundJMD(income.foreign),
      investmentIncome:           roundJMD(income.investment),
      rentalIncome:               roundJMD(income.rental),
      otherIncome:                roundJMD(income.other),
      employmentIncome:           roundJMD(income.employment),  // from P24
      grossIncome:                roundJMD(grossIncome),
    },

    // P24 Employment Withholdings (PAYE already deducted by employer)
    p24: p24.entryCount > 0 ? {
      entryCount:            p24.entryCount,
      grossEmoluments:       p24.grossEmoluments,
      nisDeducted:           p24.nisDeducted,
      nhtDeducted:           p24.nhtDeducted,
      edTaxDeducted:         p24.edTaxDeducted,
      payeDeducted:          p24.payeDeducted,
      totalWithheld:         p24.totalWithheld,
      // Gross liabilities before crediting P24
      totalNisLiability:     roundJMD(totalNisLiability),
      totalNhtLiability:     roundJMD(totalNhtLiability),
      totalEdTaxLiability:   roundJMD(totalEdTaxLiability),
      totalIncomeTaxLiability: roundJMD(totalIncomeTaxLiability),
      totalGrossLiability:   roundJMD(totalNisLiability + totalNhtLiability + totalEdTaxLiability + totalIncomeTaxLiability),
    } : null,

    // Part B: Deductions
    deductions: {
      allowableBusinessExpenses: roundJMD(allowableExpenses),
      expenseBreakdown: Object.fromEntries(
        Object.entries(expenses.breakdown).map(([k, v]) => [k, roundJMD(v)])
      ),
      standardDeduction: roundJMD(standardDeduction),
      actualExpenses: roundJMD(actualExpenses),
      methodUsed: usedActualMethod ? 'Actual' : 'Standard (20%)',
    },

    // Part C: Statutory Income
    statutoryIncome: roundJMD(statutoryIncome),
    statutoryIncomeAfterLoss: roundJMD(fromCents(statutoryAfterLossCents)),

    // Loss relief (individuals) — null when no losses are in play. The
    // brought-forward figure is user-entered (official, from prior S04
    // filings); MiTax computes only the allowable claim and the balance.
    lossRelief: (lossBfCents > 0 || currentYearLossCents > 0) ? {
      lossesBroughtForward: fromCents(lossBfCents),
      lossApplied:          fromCents(lossAppliedCents),
      capApplied:           lossCapApplies,
      currentYearLoss:      fromCents(currentYearLossCents),
      lossCarriedForward:   fromCents(lossCarriedForwardCents),
    } : null,

    // Part D: Contributions (additional amounts still owed on S04, after P24 credits)
    contributions: {
      nis:                roundJMD(nisContribution),
      nht:                roundJMD(nhtContribution),
      educationTax:       roundJMD(edTaxContribution),
      totalContributions: roundJMD(nisContribution + nhtContribution + edTaxContribution),
    },

    // Part E: Chargeable Income & Tax
    chargeableIncome: roundJMD(chargeableIncome),
    personalThresholdApplied: roundJMD(params.personalThreshold),

    tax: {
      incomeTax:    roundJMD(incomeTax),
      effectiveRate: grossIncome > 0
        ? `${(((incomeTax + p24.payeDeducted) / grossIncome) * 100).toFixed(2)}%`
        : '0%',
    },

    totalTaxPayable: roundJMD(totalTaxPayable),

    // Summary for display
    summary: {
      grossIncome:          roundJMD(grossIncome),
      employmentIncome:     roundJMD(income.employment),
      totalDeductions:      roundJMD(allowableExpenses),
      statutoryIncome:      roundJMD(statutoryIncome),
      nisNhtEdTax:          roundJMD(nisContribution + nhtContribution + edTaxContribution),
      chargeableIncome:     roundJMD(chargeableIncome),
      incomeTax:            roundJMD(incomeTax),
      p24TotalWithheld:     roundJMD(p24.totalWithheld),
      totalTaxPayable:      roundJMD(totalTaxPayable),
      netIncomeAfterTax:    roundJMD(grossIncome - totalTaxPayable - p24.totalWithheld),
    },

    // Classification transparency — how every category's money was treated
    // and why (mapping / LunchMoney flag / keyword guess / unclassified).
    classification: {
      rows: classificationRows,
      unclassifiedCredits: roundJMD(unclassifiedCredits),
      unclassifiedDebits:  roundJMD(unclassifiedDebits),
      excludedTotal:       roundJMD(excludedTotal),
      ignoredTotal:        roundJMD(ignoredTotal),
      guessedIncome,
      categoriesLoaded:    lmCategories.length > 0,
    },

    // Monthly breakdown
    monthlyBreakdown: buildMonthlyBreakdown(allTransactions, year),

    // Notes / Disclaimers
    notes: [
      ...(dataWarning ? [`⚠ ${dataWarning}`] : []),
      ...(categoriesWarning ? [`⚠ ${categoriesWarning}`] : []),
      ...(guessedIncome > 0 ? [
        `⚠ $${guessedIncome.toLocaleString('en-JM', { minimumFractionDigits: 2 })} of income was classified by KEYWORD GUESSING (no user mapping and no LunchMoney income flag on the category). Review the classification table and map those categories to lock the treatment in.`,
      ] : []),
      ...(unclassifiedCredits > 0 ? [
        `⚠ $${roundJMD(unclassifiedCredits).toLocaleString('en-JM', { minimumFractionDigits: 2 })} in credits could NOT be classified and was NOT counted as income. If any of it is taxable income, map its categories (or flag them as income in LunchMoney) and regenerate.`,
      ] : []),
      `Tax year: January 1 – December 31, ${year}`,
      ...(fallback ? [
        `⚠ WARNING: No tax parameters are defined for ${fallback.requestedYear}. Using ${fallback.usedYear} values as a fallback. File src/tax/s04.js::TAX_PARAMS needs an entry for ${fallback.requestedYear} before this return is filed.`,
      ] : []),
      ...(p24.entryCount > 0 ? [
        `P24 employment income: $${p24.grossEmoluments.toLocaleString()} JMD from ${p24.entryCount} payroll record(s). PAYE withheld: NIS $${p24.nisDeducted.toLocaleString()}, NHT $${p24.nhtDeducted.toLocaleString()}, Ed Tax $${p24.edTaxDeducted.toLocaleString()}, Income Tax $${p24.payeDeducted.toLocaleString()}.`,
      ] : []),
      `All amounts in your LunchMoney primary currency (JMD). Foreign-currency transactions converted using LunchMoney's historic exchange rates (to_base field) — consistent with how LunchMoney displays amounts in your dashboard.`,
      `${convertedCount} transaction(s) used LunchMoney's converted primary-currency amount; ${unconvertedCount} used original amount (no conversion needed).`,
      ...(lossBfCents > 0 ? [
        lossCapApplies
          ? `Loss relief: $${fromCents(lossAppliedCents).toLocaleString('en-JM', { minimumFractionDigits: 2 })} of your $${fromCents(lossBfCents).toLocaleString('en-JM', { minimumFractionDigits: 2 })} losses brought forward was claimed — capped at 50% of net profit before loss relief because gross business receipts are $${LOSS_CLAIM_GROSS_SALES_LIMIT.toLocaleString()} or more (S04 loss-claim rule).`
          : `Loss relief: $${fromCents(lossAppliedCents).toLocaleString('en-JM', { minimumFractionDigits: 2 })} of your $${fromCents(lossBfCents).toLocaleString('en-JM', { minimumFractionDigits: 2 })} losses brought forward was claimed in full (gross business receipts below $${LOSS_CLAIM_GROSS_SALES_LIMIT.toLocaleString()}, so the 50% cap does not apply).`,
        `Loss relief reduces income tax only — NIS and NHT are charged on gross income, and Education Tax is computed on statutory income BEFORE loss relief (conservative: prior-year loss deductibility against the Education Tax base is not clearly documented for individuals — confirm with TAJ or your accountant).`,
      ] : []),
      ...(currentYearLossCents > 0 ? [
        `⚠ This year shows a NET LOSS of $${fromCents(currentYearLossCents).toLocaleString('en-JM', { minimumFractionDigits: 2 })} (allowable expenses exceed gross income). It cannot reduce this year's figures below zero, but it adds to your losses available to carry forward.`,
      ] : []),
      ...(lossBfCents > 0 || currentYearLossCents > 0 ? [
        `Losses to carry forward to ${year + 1}: $${fromCents(lossCarriedForwardCents).toLocaleString('en-JM', { minimumFractionDigits: 2 })} — enter this as "Losses Brought Forward" next year, but confirm the official balance against your TAJ records before filing.`,
      ] : []),
      `Personal threshold applied: $${params.personalThreshold.toLocaleString()} JMD`,
      `NIS rate: ${params.nisRate * 100}% (max insurable income: $${params.nisMaxIncome.toLocaleString()})`,
      `NHT rate: ${params.nhtRate * 100}%`,
      `Education Tax rate: ${params.edTaxRate * 100}%`,
      ...(params.source ? [`Tax parameters source: ${params.source} (verified ${params.verifiedAt || 'n/a'})`] : []),
      'DISCLAIMER: This report is for informational purposes only. Consult a qualified tax professional or TAJ for official filing.',
    ],
  };

  return report;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function roundJMD(amount) {
  return Math.round((amount || 0) * 100) / 100;
}

// ─── Integer-cents money helpers ─────────────────────────────────────────────
// Tax math is done in integer cents so accumulation carries no binary-float
// drift and band-edge comparisons are exact; values are converted back to JMD
// (2dp) only at the boundary.
const toCents   = (v) => Math.round((v || 0) * 100);
const fromCents = (c) => c / 100;

/** Progressive income tax (in cents) on a chargeable amount (in cents). */
function incomeTaxCents(chargeableCents, params) {
  if (chargeableCents <= 0) return 0;
  const band1MaxCents = toCents(params.incomeTaxBand1Max);
  if (chargeableCents <= band1MaxCents) {
    return Math.round(chargeableCents * params.incomeTaxRate1);
  }
  return Math.round(band1MaxCents * params.incomeTaxRate1) +
         Math.round((chargeableCents - band1MaxCents) * params.incomeTaxRate2);
}

/**
 * Estimate the full-year tax liability for a given annual income under `params`.
 * Shared by the S04A provisional estimate and the dashboard quarterly estimate
 * (previously duplicated in main.js). Returns JMD (2dp) component amounts.
 */
function estimateAnnualTax(annualIncome, params) {
  const incCents       = toCents(annualIncome);
  const stdDedCents    = Math.round(incCents * params.standardDeductionRate);
  const statutoryCents = Math.max(0, incCents - stdDedCents);
  const nisCents       = Math.round(Math.min(incCents, toCents(params.nisMaxIncome)) * params.nisRate);
  const nhtCents       = Math.round(incCents * params.nhtRate);
  const edTaxCents     = Math.round(statutoryCents * params.edTaxRate);
  const chargeableCents = Math.max(0, statutoryCents - toCents(params.personalThreshold) - nisCents);
  const itaxCents      = incomeTaxCents(chargeableCents, params);
  const totalCents     = nisCents + nhtCents + edTaxCents + itaxCents;
  return {
    nis:       fromCents(nisCents),
    nht:       fromCents(nhtCents),
    edTax:     fromCents(edTaxCents),
    incomeTax: fromCents(itaxCents),
    total:     fromCents(totalCents),
  };
}

function buildMonthlyBreakdown(transactions, year) {
  const months = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    label: new Date(year, i, 1).toLocaleString('default', { month: 'long' }),
    income: 0,
    expenses: 0,
    net: 0,
  }));

  for (const tx of transactions) {
    if (!tx.date) continue;
    const txYear = parseInt(tx.date.split('-')[0]);
    if (txYear !== year) continue;
    const txMonth = parseInt(tx.date.split('-')[1]) - 1;
    if (txMonth < 0 || txMonth > 11) continue;

    // resolveTxAmount for consistency with the main calculation above
    const amount = resolveTxAmount(tx);
    if (amount > 0) months[txMonth].income += amount;
    else months[txMonth].expenses += Math.abs(amount);
  }

  months.forEach(m => { m.net = roundJMD(m.income - m.expenses); m.income = roundJMD(m.income); m.expenses = roundJMD(m.expenses); });
  return months;
}

// ─── S04A Provisional Tax Estimate ──────────────────────────────────────────
//
// Under the Income Tax Act (Jamaica), self-employed individuals must pay
// provisional tax in four equal instalments (S04A) based on the PRIOR year's
// total tax liability.  TAJ due dates: Q1=Mar 15, Q2=Jun 15, Q3=Sep 15, Q4=Dec 15.
//
// If current-year income is tracking ≥10% higher or lower than the prior year,
// the recommended amounts are adjusted upward/downward proportionally.

const S04A_DUE_DATES = [
  { q: 1, label: 'Q1 (Jan–Mar)', month: '03', day: '15', dueLabel: 'Mar 15' },
  { q: 2, label: 'Q2 (Apr–Jun)', month: '06', day: '15', dueLabel: 'Jun 15' },
  { q: 3, label: 'Q3 (Jul–Sep)', month: '09', day: '15', dueLabel: 'Sep 15' },
  { q: 4, label: 'Q4 (Oct–Dec)', month: '12', day: '15', dueLabel: 'Dec 15' },
];

// Split a total (in integer cents) into four instalments that sum EXACTLY to
// the total: three equal quarters plus the remainder on Q4. Avoids the float
// drift where 4 × round(total/4) ≠ total.
function splitInstalments(totalCents) {
  const q = Math.floor(totalCents / 4);
  return [q, q, q, totalCents - 3 * q];
}

// Minimum share of the prior-year-predicted YTD income required before the
// current-year trend is trusted; below it, S04A keeps the prior-year base.
const INCOME_SIGNAL_FLOOR = 0.5;

function generateS04A({ currentYear, priorYearFiling, currentYtdIncome, todayStr }) {
  const r2 = v => Math.round((v || 0) * 100) / 100;

  const priorTaxPayable  = priorYearFiling ? (priorYearFiling.tax_payable  || 0) : 0;
  const priorGrossIncome = priorYearFiling ? (priorYearFiling.gross_income || 0) : 0;

  // Base quarterly instalment: 25% of prior year's total tax
  const baseQuarterly = r2(priorTaxPayable / 4);

  // Current-year trend: extrapolate YTD income to full-year estimate.
  // todayStr is YYYY-MM-DD already resolved to the user's timezone; parse it by
  // string-slicing (no Date round-trip, no UTC shift). monthsElapsed counts
  // fully-elapsed months plus the fraction of the current month:
  //   getMonth() is 0-based, so completed months = (m - 1); add day/daysInMonth.
  const today     = todayStr || `${new Date().getFullYear()}-01-01`;
  const todayYear = parseInt(today.slice(0, 4), 10);
  const tMonth    = parseInt(today.slice(5, 7), 10);   // 1-based
  const tDay      = parseInt(today.slice(8, 10), 10);
  const daysInMonth = new Date(todayYear, tMonth, 0).getDate();

  let monthsElapsed;
  if (currentYear < todayYear)       monthsElapsed = 12;    // year fully elapsed
  else if (currentYear > todayYear)  monthsElapsed = 0.5;   // not started (safety)
  else monthsElapsed = Math.max(0.5, (tMonth - 1) + (tDay / daysInMonth));

  const annualTrend    = r2((currentYtdIncome / monthsElapsed) * 12);

  // Adjustment ratio (only meaningful after ≥3 months AND enough income signal).
  // Sparse YTD income — usually because most statements aren't uploaded yet —
  // would otherwise drive trendRatio toward 0 and ratchet the provisional
  // recommendation down to nothing. Under-recommending provisional tax risks
  // TAJ penalties (surplus is credited at year-end), so require actual YTD to
  // be at least INCOME_SIGNAL_FLOOR of what the prior year predicts for the
  // elapsed fraction before trusting the trend; otherwise keep the prior-year
  // base. The floor only gates the downward side — higher-than-expected income
  // (coverage ≥ 1) always passes and still adjusts upward.
  const hasHistory     = priorGrossIncome > 0;
  const expectedYtd    = priorGrossIncome * (monthsElapsed / 12);
  const coverageRatio  = expectedYtd > 0 ? currentYtdIncome / expectedYtd : 0;
  const enoughSignal   = monthsElapsed >= 3 && coverageRatio >= INCOME_SIGNAL_FLOOR;
  const trendRatio     = hasHistory && enoughSignal
    ? annualTrend / priorGrossIncome
    : 1;
  const useAdjusted    = Math.abs(trendRatio - 1) >= 0.10 && enoughSignal;
  const insufficientSignal = hasHistory && monthsElapsed >= 3 && !enoughSignal;

  // If no prior filing exists, estimate from current YTD using s04 params
  let recommendedAnnualTax = priorTaxPayable;
  if (!hasHistory && annualTrend > 0) {
    const { params } = getTaxParams(currentYear - 1);
    recommendedAnnualTax = estimateAnnualTax(annualTrend, params).total;
  } else if (useAdjusted) {
    recommendedAnnualTax = priorTaxPayable * trendRatio;
  }

  const recommendedQuarterly = r2(recommendedAnnualTax / 4);

  // Cents-exact per-quarter instalments (Q1–Q3 equal, Q4 carries the remainder)
  // so the four amounts sum precisely to the annual figure.
  const baseInstalments = splitInstalments(Math.round(priorTaxPayable * 100));
  const recInstalments  = splitInstalments(Math.round(recommendedAnnualTax * 100));

  const quarters = S04A_DUE_DATES.map(({ q, label, month, day, dueLabel }, i) => {
    const dueDate = `${currentYear}-${month}-${day}`;
    const isPast  = today > dueDate;   // lexicographic ISO compare, timezone-safe
    return {
      quarter:           q,
      label,
      dueDate,
      dueDateFormatted:  `${dueLabel} ${currentYear}`,
      baseAmount:        baseInstalments[i] / 100,
      recommendedAmount: recInstalments[i] / 100,
      isPast,
    };
  });

  const notes = [];
  if (hasHistory) {
    notes.push(`Based on ${currentYear - 1} S04 filing: total tax $${priorTaxPayable.toLocaleString('en-JM', { minimumFractionDigits: 2 })} JMD.`);
  } else {
    notes.push(`No prior-year S04 filing found. Estimates derived from current-year LunchMoney trends.`);
  }
  if (enoughSignal) {
    const pct = Math.round((trendRatio - 1) * 100);
    notes.push(`Current year income (${monthsElapsed.toFixed(1)} months): $${annualTrend.toLocaleString('en-JM', { minimumFractionDigits: 2 })} JMD annualised — ${pct >= 0 ? '+' : ''}${pct}% vs prior year.`);
  } else if (insufficientSignal) {
    notes.push(`Current-year income so far ($${r2(currentYtdIncome).toLocaleString('en-JM', { minimumFractionDigits: 2 })} over ${monthsElapsed.toFixed(1)} months) is well below the prior-year pace — likely incomplete statement uploads — so the prior-year base is used. Upload more statements for a trend-adjusted estimate.`);
  }
  if (useAdjusted) {
    notes.push(`Recommended amounts adjusted ${trendRatio > 1 ? 'upward' : 'downward'} to reflect current-year income trend.`);
  }
  notes.push('S04A payments are provisional tax instalments. Surplus is credited at year-end filing.');
  notes.push('Consult TAJ or a qualified tax practitioner for your actual liability.');

  return {
    currentYear,
    priorYear:             currentYear - 1,
    hasPriorFiling:        hasHistory,
    priorYearTaxPayable:   r2(priorTaxPayable),
    priorYearGrossIncome:  r2(priorGrossIncome),
    currentYtdIncome:      r2(currentYtdIncome),
    annualTrendIncome:     annualTrend,
    monthsElapsed:         r2(monthsElapsed),
    trendRatio:            r2(trendRatio),
    coverageRatio:         r2(coverageRatio),
    useAdjusted,
    insufficientSignal,
    baseQuarterly,
    recommendedQuarterly,
    quarters,
    notes,
  };
}

module.exports = { generateS04, generateS04A, TAX_PARAMS, getTaxParams, taxParamsStatus, estimateAnnualTax, LOSS_CLAIM_GROSS_SALES_LIMIT };
