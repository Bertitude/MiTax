/**
 * Jamaica S04 Annual Return — Self Employed Income Tax
 * Based on Tax Administration Jamaica (TAJ) S04 form structure.
 *
 * Per-year tax parameters are defined in TAX_PARAMS below. Each entry carries
 * a `source` URL and `verifiedAt` ISO date so reviewers can spot stale
 * figures. TAJ's Technical Advisory is the authoritative source — verify
 * against the portal before filing season.
 */

const { getTransactions } = require('../lunchmoney');

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

// ─── Category to income-type mapping ───────────────────────────────────────

const INCOME_CATEGORIES = {
  business: ['Business Income', 'Income', 'Freelance', 'Invoice', 'Client Payment', 'Service'],
  foreign: ['Foreign Income', 'Wise', 'PayPal', 'Stripe', 'International', 'USD', 'Remittance'],
  investment: ['Investment Income', 'Dividend', 'Interest', 'Capital Gain', 'Mutual Fund'],
  rental: ['Rental Income', 'Rent', 'Property', 'Tenant'],
  other: ['Other Income', 'Refund', 'Cashback'],
};

const DEDUCTIBLE_CATEGORIES = [
  'Office Supplies', 'Travel', 'Auto & Transport', 'Internet', 'Phone', 'Software',
  'Professional Services', 'Bank Fees', 'Fees', 'Insurance', 'Advertising', 'Marketing',
  'Equipment', 'Subscriptions', 'Utilities', 'Rent Paid',
];

// ─── Main generator ─────────────────────────────────────────────────────────

async function generateS04({ year, apiKey, manualData = {}, userCategoryMappings = {}, p24Totals = null }) {
  const { params, fallback } = getTaxParams(year);

  let allTransactions = [];

  // Fetch from LunchMoney if API key provided
  if (apiKey) {
    try {
      const startDate = `${year}-01-01`;
      const endDate = `${year}-12-31`;
      allTransactions = await getTransactions(apiKey, { startDate, endDate });
    } catch (err) {
      console.warn('Could not fetch from LunchMoney:', err.message);
    }
  }

  // ─── Categorize transactions ─────────────────────────────────────────────

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

  for (const tx of allTransactions) {
    // Use to_base (LunchMoney's primary-currency equivalent using historic exchange rate)
    // Fall back to amount only if to_base is absent (e.g. same-currency transactions where they are equal)
    const hasConversion = tx.to_base !== undefined && tx.to_base !== null;
    const amount = parseFloat(hasConversion ? tx.to_base : tx.amount) || 0;
    if (hasConversion) convertedCount++; else unconvertedCount++;

    const category   = tx.category_name || tx.category || '';
    const categoryId = tx.category_id   != null ? String(tx.category_id) : null;
    const notes      = (tx.notes || '') + ' ' + (tx.payee || '');

    // ── Check user-defined category mapping first ──────────────────────────
    // userCategoryMappings: { [categoryId]: { incomeType?, isDeductible?, ignore? } }
    const userMapping = categoryId ? (userCategoryMappings[categoryId] || null) : null;

    if (userMapping && userMapping.ignore) continue;   // explicitly excluded

    // Classify income (positive amounts = credits/income)
    if (amount > 0) {
      let incomeType = null;
      if (userMapping && userMapping.incomeType) {
        incomeType = userMapping.incomeType;           // user-mapped income type
      } else {
        incomeType = classifyIncome(category, notes);  // keyword fallback
      }
      if (incomeType && income[incomeType] !== undefined) income[incomeType] += amount;
    }

    // Classify deductible expenses (negative amounts = debits/expenses)
    if (amount < 0) {
      let isDeductible = false;
      if (userMapping) {
        isDeductible = !!userMapping.isDeductible;     // user-mapped
      } else {
        isDeductible = DEDUCTIBLE_CATEGORIES.some(
          dc => category.toLowerCase().includes(dc.toLowerCase())
        );
      }
      if (isDeductible) {
        const absAmt = Math.abs(amount);
        expenses.total += absAmt;
        expenses.breakdown[category] = (expenses.breakdown[category] || 0) + absAmt;
      }
    }
  }

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
  const statutoryCents = Math.max(0, grossCents - allowableCents);

  // NIS (National Insurance Scheme) — calculated on combined income, capped at nisMaxIncome.
  // P24 already withheld NIS on the employment portion; credit that and only charge
  // additional NIS on any self-employment income that remains under the cap.
  const nisableCents      = Math.min(grossCents, toCents(params.nisMaxIncome));
  const totalNisCents     = Math.round(nisableCents * params.nisRate);
  const additionalNisCents = Math.max(0, totalNisCents - toCents(p24.nisDeducted));

  // NHT (National Housing Trust)
  const totalNhtCents      = Math.round(grossCents * params.nhtRate);
  const additionalNhtCents = Math.max(0, totalNhtCents - toCents(p24.nhtDeducted));

  // Education Tax
  const totalEdTaxCents      = Math.round(statutoryCents * params.edTaxRate);
  const additionalEdTaxCents = Math.max(0, totalEdTaxCents - toCents(p24.edTaxDeducted));

  // Chargeable Income (uses total NIS liability for the threshold deduction — per Jamaica IT Act)
  const chargeableCents = Math.max(0, statutoryCents - toCents(params.personalThreshold) - totalNisCents);

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
      methodUsed: actualExpenses >= standardDeduction ? 'Actual' : 'Standard (20%)',
    },

    // Part C: Statutory Income
    statutoryIncome: roundJMD(statutoryIncome),

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

    // Monthly breakdown
    monthlyBreakdown: buildMonthlyBreakdown(allTransactions, year),

    // Notes / Disclaimers
    notes: [
      `Tax year: January 1 – December 31, ${year}`,
      ...(fallback ? [
        `⚠ WARNING: No tax parameters are defined for ${fallback.requestedYear}. Using ${fallback.usedYear} values as a fallback. File src/tax/s04.js::TAX_PARAMS needs an entry for ${fallback.requestedYear} before this return is filed.`,
      ] : []),
      ...(p24.entryCount > 0 ? [
        `P24 employment income: $${p24.grossEmoluments.toLocaleString()} JMD from ${p24.entryCount} payroll record(s). PAYE withheld: NIS $${p24.nisDeducted.toLocaleString()}, NHT $${p24.nhtDeducted.toLocaleString()}, Ed Tax $${p24.edTaxDeducted.toLocaleString()}, Income Tax $${p24.payeDeducted.toLocaleString()}.`,
      ] : []),
      `All amounts in your LunchMoney primary currency (JMD). Foreign-currency transactions converted using LunchMoney's historic exchange rates (to_base field) — consistent with how LunchMoney displays amounts in your dashboard.`,
      `${convertedCount} transaction(s) used LunchMoney's converted primary-currency amount; ${unconvertedCount} used original amount (no conversion needed).`,
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

function classifyIncome(category, context) {
  const combined = `${category} ${context}`.toLowerCase();
  for (const [type, keywords] of Object.entries(INCOME_CATEGORIES)) {
    if (keywords.some(kw => combined.includes(kw.toLowerCase()))) return type;
  }
  return null;
}

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

    // Use to_base for consistency with the main calculation
    const amount = parseFloat(tx.to_base ?? tx.amount) || 0;
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

  // Adjustment ratio (only meaningful after ≥3 months of data)
  const hasHistory     = priorGrossIncome > 0;
  const trendRatio     = hasHistory && monthsElapsed >= 3
    ? annualTrend / priorGrossIncome
    : 1;
  const useAdjusted    = Math.abs(trendRatio - 1) >= 0.10 && monthsElapsed >= 3;

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
  if (monthsElapsed >= 3) {
    const pct = Math.round((trendRatio - 1) * 100);
    notes.push(`Current year income (${monthsElapsed.toFixed(1)} months): $${annualTrend.toLocaleString('en-JM', { minimumFractionDigits: 2 })} JMD annualised — ${pct >= 0 ? '+' : ''}${pct}% vs prior year.`);
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
    useAdjusted,
    baseQuarterly,
    recommendedQuarterly,
    quarters,
    notes,
  };
}

module.exports = { generateS04, generateS04A, TAX_PARAMS, getTaxParams, taxParamsStatus, estimateAnnualTax };
