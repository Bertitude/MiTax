/**
 * Jamaica S04 Annual Return — Self Employed Income Tax
 * Based on Tax Administration Jamaica (TAJ) S04 form structure.
 *
 * Income Tax Act (Jamaica) thresholds for 2024/2025:
 *   - Annual Income Tax Threshold: $1,500,096 JMD
 *   - NIS: 3% of gross income (capped at $1,500,000 JMD)
 *   - NHT: 2% of gross income
 *   - Education Tax (Ed Tax): 2.25% of statutory income
 *   - Income Tax: 25% on income above threshold (up to ~$6M), 30% above $6M
 */

const { getTransactions } = require('../lunchmoney');

// ─── Tax Rates & Thresholds (update yearly) ────────────────────────────────

const TAX_PARAMS = {
  2024: {
    personalThreshold: 1500096,
    nisRate: 0.03,
    nisMaxIncome: 1500000,
    nhtRate: 0.02,
    edTaxRate: 0.0225,
    incomeTaxRate1: 0.25,
    incomeTaxRate2: 0.30,
    incomeTaxBand1Max: 6000000,
    standardDeductionRate: 0.20, // 20% of gross for business expenses (simplified method)
  },
  2025: {
    personalThreshold: 1500096, // Update when TAJ publishes 2025 threshold
    nisRate: 0.03,
    nisMaxIncome: 1500000,
    nhtRate: 0.02,
    edTaxRate: 0.0225,
    incomeTaxRate1: 0.25,
    incomeTaxRate2: 0.30,
    incomeTaxBand1Max: 6000000,
    standardDeductionRate: 0.20,
  },
};

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
  const params = TAX_PARAMS[year] || TAX_PARAMS[2024];

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

    // Classify income (negative amounts in LunchMoney = credits/income)
    if (amount < 0) {
      const absAmount = Math.abs(amount);
      let incomeType = null;
      if (userMapping && userMapping.incomeType) {
        incomeType = userMapping.incomeType;           // user-mapped income type
      } else {
        incomeType = classifyIncome(category, notes);  // keyword fallback
      }
      if (incomeType && income[incomeType] !== undefined) income[incomeType] += absAmount;
    }

    // Classify deductible expenses (positive amounts = debits/expenses)
    if (amount > 0) {
      let isDeductible = false;
      if (userMapping) {
        isDeductible = !!userMapping.isDeductible;     // user-mapped
      } else {
        isDeductible = DEDUCTIBLE_CATEGORIES.some(
          dc => category.toLowerCase().includes(dc.toLowerCase())
        );
      }
      if (isDeductible) {
        expenses.total += amount;
        expenses.breakdown[category] = (expenses.breakdown[category] || 0) + amount;
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

  // Allowable deductions
  const actualExpenses = expenses.total;
  const standardDeduction = grossIncome * params.standardDeductionRate;
  const allowableExpenses = Math.max(actualExpenses, manualData.useActualExpenses ? actualExpenses : standardDeduction);

  const statutoryIncome = Math.max(0, grossIncome - allowableExpenses);

  // NIS (National Insurance Scheme) — calculated on combined income, capped at nisMaxIncome
  // P24 already withheld NIS on the employment portion; we credit that and only charge
  // additional NIS on any self-employment income that remains under the cap.
  const nisableIncome        = Math.min(grossIncome, params.nisMaxIncome);
  const totalNisLiability    = nisableIncome * params.nisRate;
  const additionalNis        = Math.max(0, totalNisLiability - p24.nisDeducted);
  const nisContribution      = additionalNis;  // what's still owed for S04

  // NHT (National Housing Trust)
  const totalNhtLiability    = grossIncome * params.nhtRate;
  const additionalNht        = Math.max(0, totalNhtLiability - p24.nhtDeducted);
  const nhtContribution      = additionalNht;

  // Education Tax
  const totalEdTaxLiability  = statutoryIncome * params.edTaxRate;
  const additionalEdTax      = Math.max(0, totalEdTaxLiability - p24.edTaxDeducted);
  const edTaxContribution    = additionalEdTax;

  // Chargeable Income (uses total NIS liability for the threshold deduction — per Jamaica IT Act)
  const chargeableIncome = Math.max(0, statutoryIncome - params.personalThreshold - totalNisLiability);

  // Income Tax
  let totalIncomeTaxLiability = 0;
  if (chargeableIncome > 0) {
    if (chargeableIncome <= params.incomeTaxBand1Max) {
      totalIncomeTaxLiability = chargeableIncome * params.incomeTaxRate1;
    } else {
      totalIncomeTaxLiability = (params.incomeTaxBand1Max * params.incomeTaxRate1) +
                                ((chargeableIncome - params.incomeTaxBand1Max) * params.incomeTaxRate2);
    }
  }
  const additionalIncomeTax = Math.max(0, totalIncomeTaxLiability - p24.payeDeducted);
  const incomeTax           = additionalIncomeTax;

  // Total additional tax payable on S04 (after crediting all P24 withholdings)
  const totalTaxPayable = incomeTax + nisContribution + nhtContribution + edTaxContribution;

  // ─── S04 Form Structure ──────────────────────────────────────────────────

  const report = {
    year,
    generatedAt: new Date().toISOString(),
    taxParams: params,

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
      ...(p24.entryCount > 0 ? [
        `P24 employment income: $${p24.grossEmoluments.toLocaleString()} JMD from ${p24.entryCount} payroll record(s). PAYE withheld: NIS $${p24.nisDeducted.toLocaleString()}, NHT $${p24.nhtDeducted.toLocaleString()}, Ed Tax $${p24.edTaxDeducted.toLocaleString()}, Income Tax $${p24.payeDeducted.toLocaleString()}.`,
      ] : []),
      `All amounts in your LunchMoney primary currency (JMD). Foreign-currency transactions converted using LunchMoney's historic exchange rates (to_base field) — consistent with how LunchMoney displays amounts in your dashboard.`,
      `${convertedCount} transaction(s) used LunchMoney's converted primary-currency amount; ${unconvertedCount} used original amount (no conversion needed).`,
      `Personal threshold applied: $${params.personalThreshold.toLocaleString()} JMD`,
      `NIS rate: ${params.nisRate * 100}% (max income: $${params.nisMaxIncome.toLocaleString()})`,
      `NHT rate: ${params.nhtRate * 100}%`,
      `Education Tax rate: ${params.edTaxRate * 100}%`,
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
    if (amount < 0) months[txMonth].income += Math.abs(amount);
    else months[txMonth].expenses += amount;
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
  { q: 1, label: 'Q1 (Jan–Mar)', due: 'Mar 15' },
  { q: 2, label: 'Q2 (Apr–Jun)', due: 'Jun 15' },
  { q: 3, label: 'Q3 (Jul–Sep)', due: 'Sep 15' },
  { q: 4, label: 'Q4 (Oct–Dec)', due: 'Dec 15' },
];

function generateS04A({ currentYear, priorYearFiling, currentYtdIncome }) {
  const r2 = v => Math.round((v || 0) * 100) / 100;

  const priorTaxPayable  = priorYearFiling ? (priorYearFiling.tax_payable  || 0) : 0;
  const priorGrossIncome = priorYearFiling ? (priorYearFiling.gross_income || 0) : 0;

  // Base quarterly instalment: 25% of prior year's total tax
  const baseQuarterly = r2(priorTaxPayable / 4);

  // Current-year trend: extrapolate YTD income to full-year estimate
  const now            = new Date();
  const monthsElapsed  = Math.max(0.5, (now.getMonth() + 1) + (now.getDate() / 31));
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
    const params     = TAX_PARAMS[currentYear - 1] || TAX_PARAMS[2025];
    const stdDed     = annualTrend * params.standardDeductionRate;
    const statutory  = Math.max(0, annualTrend - stdDed);
    const nis        = Math.min(annualTrend, params.nisMaxIncome) * params.nisRate;
    const nht        = annualTrend * params.nhtRate;
    const edTax      = statutory * params.edTaxRate;
    const chargeable = Math.max(0, statutory - params.personalThreshold - nis);
    let   itax       = 0;
    if (chargeable > 0) {
      itax = chargeable <= params.incomeTaxBand1Max
        ? chargeable * params.incomeTaxRate1
        : params.incomeTaxBand1Max * params.incomeTaxRate1
          + (chargeable - params.incomeTaxBand1Max) * params.incomeTaxRate2;
    }
    recommendedAnnualTax = nis + nht + edTax + itax;
  } else if (useAdjusted) {
    recommendedAnnualTax = priorTaxPayable * trendRatio;
  }

  const recommendedQuarterly = r2(recommendedAnnualTax / 4);

  const quarters = S04A_DUE_DATES.map(({ q, label, due }) => {
    const dueFullDate = `${currentYear}-${due.replace('Mar','03').replace('Jun','06').replace('Sep','09').replace('Dec','12')}-15`;
    const isPast      = new Date() > new Date(dueFullDate);
    return {
      quarter:           q,
      label,
      dueDate:           dueFullDate,
      dueDateFormatted:  `${due} ${currentYear}`,
      baseAmount:        baseQuarterly,
      recommendedAmount: recommendedQuarterly,
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

module.exports = { generateS04, generateS04A, TAX_PARAMS };
