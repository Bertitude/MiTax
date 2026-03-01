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

async function generateS04({ year, apiKey, manualData = {} }) {
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

    const category = tx.category_name || tx.category || '';
    const notes = (tx.notes || '') + ' ' + (tx.payee || '');

    // Classify income (negative amounts in LunchMoney = credits/income)
    if (amount < 0) {
      const absAmount = Math.abs(amount);
      const incomeType = classifyIncome(category, notes);
      if (incomeType) income[incomeType] += absAmount;
    }

    // Classify deductible expenses (positive amounts = debits/expenses)
    if (amount > 0) {
      const isDeductible = DEDUCTIBLE_CATEGORIES.some(
        dc => category.toLowerCase().includes(dc.toLowerCase())
      );
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

  // ─── S04 Calculations ────────────────────────────────────────────────────

  const grossIncome = income.business + income.foreign + income.investment + income.rental + income.other;

  // Allowable deductions
  const actualExpenses = expenses.total;
  const standardDeduction = grossIncome * params.standardDeductionRate;
  const allowableExpenses = Math.max(actualExpenses, manualData.useActualExpenses ? actualExpenses : standardDeduction);

  const statutoryIncome = Math.max(0, grossIncome - allowableExpenses);

  // NIS (National Insurance Scheme)
  const nisableIncome = Math.min(grossIncome, params.nisMaxIncome);
  const nisContribution = nisableIncome * params.nisRate;

  // NHT (National Housing Trust)
  const nhtContribution = grossIncome * params.nhtRate;

  // Education Tax
  const edTaxContribution = statutoryIncome * params.edTaxRate;

  // Chargeable Income
  const chargeableIncome = Math.max(0, statutoryIncome - params.personalThreshold - nisContribution);

  // Income Tax
  let incomeTax = 0;
  if (chargeableIncome > 0) {
    if (chargeableIncome <= params.incomeTaxBand1Max) {
      incomeTax = chargeableIncome * params.incomeTaxRate1;
    } else {
      incomeTax = (params.incomeTaxBand1Max * params.incomeTaxRate1) +
                  ((chargeableIncome - params.incomeTaxBand1Max) * params.incomeTaxRate2);
    }
  }

  const totalTaxPayable = incomeTax + nisContribution + nhtContribution + edTaxContribution;

  // ─── S04 Form Structure ──────────────────────────────────────────────────

  const report = {
    year,
    generatedAt: new Date().toISOString(),
    taxParams: params,

    // Part A: Income
    income: {
      businessProfessionalIncome: roundJMD(income.business),
      foreignSourcedIncome: roundJMD(income.foreign),
      investmentIncome: roundJMD(income.investment),
      rentalIncome: roundJMD(income.rental),
      otherIncome: roundJMD(income.other),
      grossIncome: roundJMD(grossIncome),
    },

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

    // Part D: Contributions
    contributions: {
      nis: roundJMD(nisContribution),
      nht: roundJMD(nhtContribution),
      educationTax: roundJMD(edTaxContribution),
      totalContributions: roundJMD(nisContribution + nhtContribution + edTaxContribution),
    },

    // Part E: Chargeable Income & Tax
    chargeableIncome: roundJMD(chargeableIncome),
    personalThresholdApplied: roundJMD(params.personalThreshold),

    tax: {
      incomeTax: roundJMD(incomeTax),
      effectiveRate: grossIncome > 0 ? `${((incomeTax / grossIncome) * 100).toFixed(2)}%` : '0%',
    },

    totalTaxPayable: roundJMD(totalTaxPayable),

    // Summary for display
    summary: {
      grossIncome: roundJMD(grossIncome),
      totalDeductions: roundJMD(allowableExpenses),
      statutoryIncome: roundJMD(statutoryIncome),
      nisNhtEdTax: roundJMD(nisContribution + nhtContribution + edTaxContribution),
      chargeableIncome: roundJMD(chargeableIncome),
      incomeTax: roundJMD(incomeTax),
      totalTaxPayable: roundJMD(totalTaxPayable),
      netIncomeAfterTax: roundJMD(grossIncome - totalTaxPayable),
    },

    // Monthly breakdown
    monthlyBreakdown: buildMonthlyBreakdown(allTransactions, year),

    // Notes / Disclaimers
    notes: [
      `Tax year: January 1 – December 31, ${year}`,
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

module.exports = { generateS04, TAX_PARAMS };
