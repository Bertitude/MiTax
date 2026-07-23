/**
 * Transaction classification for tax purposes (pure, unit-testable).
 *
 * Replaces the old substring keyword guesser in s04.js, which produced real
 * false positives — 'Rent' matched "CURRENT ACCOUNT", 'Interest' matched
 * "PINTEREST" and "interest charge reversal", 'Service' matched "SERVICE
 * CHARGE REFUND" — and matched against raw payee/bank text even when the
 * user had deliberately categorized the transaction.
 *
 * LunchMoney's own settings are the SINGLE SOURCE OF TRUTH for what is
 * income and what is excluded — MiTax never guesses income from bank text.
 *
 * Priority order (first match wins):
 *   1. The user's explicit category mapping (ignore / income type / expense).
 *   2. LunchMoney's own category metadata: `exclude_from_totals`/`is_group`
 *      → excluded; `is_income` → income. Keywords are used ONLY to pick the
 *      S04 income line (business/rental/…) from the category NAME — never to
 *      decide whether something IS income.
 *   3. Deductible-expense keyword match against the category NAME only —
 *      LunchMoney has no "deductible" concept, so this fallback (flagged in
 *      the report) survives for unmapped expense categories.
 *   4. Everything else — including ALL uncategorized transactions — is
 *      unclassified: counted nowhere, surfaced in the report for review.
 *
 * 'Refund' and 'Cashback' are deliberately NOT income keywords — a refund of
 * an expense is not gross income. Credits landing in an expense-classified
 * category are netted against that category's expenses by the consumer.
 */

'use strict';

const INCOME_KEYWORDS = {
  business:   ['business income', 'freelance', 'invoice', 'client payment', 'service', 'consulting'],
  foreign:    ['foreign income', 'wise', 'paypal', 'stripe', 'international', 'usd', 'remittance'],
  investment: ['investment income', 'dividend', 'dividends', 'interest', 'capital gain', 'mutual fund'],
  rental:     ['rental income', 'rent', 'rental', 'property', 'tenant'],
  other:      ['other income'],
};

// Generic last-resort matcher: a bare "Income"-style name that no specific
// type claimed defaults to business (self-employed budgets). Checked AFTER
// every specific keyword so "Rental Income" subtypes as rental, not business.
const GENERIC_INCOME_RE = /\bincome\b/i;

const DEDUCTIBLE_KEYWORDS = [
  'office supplies', 'travel', 'auto & transport', 'internet', 'phone', 'software',
  'professional services', 'bank fees', 'fees', 'insurance', 'advertising', 'marketing',
  'equipment', 'subscriptions', 'utilities', 'rent paid',
];

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Pre-compiled word-boundary matchers ("rent" must be the whole word — it no
// longer matches "current", "parent", or "apartment").
const INCOME_MATCHERS = Object.entries(INCOME_KEYWORDS).map(([type, kws]) => ({
  type,
  res: kws.map(kw => new RegExp(`\\b${escapeRegex(kw)}\\b`, 'i')),
}));
const DEDUCTIBLE_MATCHERS = DEDUCTIBLE_KEYWORDS.map(kw => new RegExp(`\\b${escapeRegex(kw)}\\b`, 'i'));

/** Word-boundary income-type match against a text; null when nothing matches. */
function matchIncomeType(text) {
  if (!text) return null;
  for (const { type, res } of INCOME_MATCHERS) {
    if (res.some(re => re.test(text))) return type;
  }
  if (GENERIC_INCOME_RE.test(text)) return 'business';
  return null;
}

function matchDeductible(text) {
  return !!text && DEDUCTIBLE_MATCHERS.some(re => re.test(text));
}

/**
 * Build a per-transaction classifier.
 *
 * `categories`: LunchMoney category objects ({ id, name, is_income,
 * exclude_from_totals, is_group, group_id }). `userCategoryMappings`:
 * { [categoryId]: { incomeType?, isDeductible?, ignore? } }.
 *
 * Returns classify(tx) → { bucket, source }:
 *   bucket: 'income:business' | 'income:foreign' | 'income:investment' |
 *           'income:rental' | 'income:other' | 'expense' | 'excluded' |
 *           'ignored' | 'unclassified'
 *   source: 'mapping' | 'lm-flag' | 'keyword' | 'none'
 */
function buildClassifier({ categories = [], userCategoryMappings = {} } = {}) {
  const catById = new Map();
  for (const c of categories || []) {
    if (c && c.id != null) catById.set(String(c.id), c);
  }

  return function classify(tx) {
    const catId = tx && tx.category_id != null ? String(tx.category_id) : null;

    // 1. Explicit user mapping always wins.
    const mapping = catId ? userCategoryMappings[catId] : null;
    if (mapping) {
      if (mapping.ignore)       return { bucket: 'ignored', source: 'mapping' };
      if (mapping.incomeType)   return { bucket: `income:${mapping.incomeType}`, source: 'mapping' };
      if (mapping.isDeductible) return { bucket: 'expense', source: 'mapping' };
    }

    const cat     = catId ? catById.get(catId) : null;
    const catName = (cat && cat.name) || (tx && tx.category_name) || '';

    // 2. LunchMoney's own metadata — the user already told LunchMoney what
    // this category is; trust that before guessing.
    if (cat) {
      if (cat.exclude_from_totals || cat.is_group) return { bucket: 'excluded', source: 'lm-flag' };
      if (cat.is_income) {
        // Subtype from the category name; a plain "Income"-style name on a
        // self-employed budget defaults to business income.
        return { bucket: `income:${matchIncomeType(cat.name) || 'business'}`, source: 'lm-flag' };
      }
    }

    // 3. Deductible-expense keyword fallback against the CATEGORY NAME only.
    // Income is NEVER keyword-guessed: a credit whose category isn't flagged
    // as income in LunchMoney (and isn't user-mapped) is not counted — it
    // shows up as unclassified in the report so it can be flagged properly.
    if (catName && matchDeductible(catName)) {
      return { bucket: 'expense', source: 'keyword' };
    }

    return { bucket: 'unclassified', source: 'none' };
  };
}

/**
 * Starter category pack for new users — created in LunchMoney via
 * POST /categories so categorization happens at bookkeeping time, in
 * LunchMoney, where the user already works. Income categories carry
 * `is_income` (LunchMoney's own flag, which the classifier trusts);
 * Transfers carries `exclude_from_totals` so account-to-account moves
 * never look like income. `mapping` is the MiTax category-mapping value
 * auto-applied after creation, pinning each category's S04 treatment.
 */
const S04_CATEGORY_PACK = [
  { name: 'Business Income',         isIncome: true, mapping: 'income:business',   description: 'Sales, fees, invoices — S04 business/professional income' },
  { name: 'Foreign Income',          isIncome: true, mapping: 'income:foreign',    description: 'Foreign-sourced income (Wise, PayPal, remittances)' },
  { name: 'Rental Income',           isIncome: true, mapping: 'income:rental',     description: 'Rent received — S04 rental income' },
  { name: 'Investment Income',       isIncome: true, mapping: 'income:investment', description: 'Dividends, interest, capital gains' },
  { name: 'Other Income',            isIncome: true, mapping: 'income:other',      description: 'Taxable income not fitting the other buckets' },
  { name: 'Office Supplies',         mapping: 'expense', description: 'Deductible — S04 allowable expense' },
  { name: 'Advertising & Marketing', mapping: 'expense', description: 'Deductible — S04 allowable expense' },
  { name: 'Professional Services',   mapping: 'expense', description: 'Accountant, lawyer, contractors — deductible' },
  { name: 'Business Travel',         mapping: 'expense', description: 'Deductible — S04 allowable expense' },
  { name: 'Utilities (Business)',    mapping: 'expense', description: 'Deductible — S04 allowable expense' },
  { name: 'Rent Paid (Business)',    mapping: 'expense', description: 'Business premises rent — deductible' },
  { name: 'Bank Fees',               mapping: 'expense', description: 'Deductible — S04 allowable expense' },
  { name: 'Business Insurance',      mapping: 'expense', description: 'Deductible — S04 allowable expense' },
  { name: 'Equipment',               mapping: 'expense', description: 'Tools & equipment — deductible' },
  { name: 'Software & Subscriptions',mapping: 'expense', description: 'Deductible — S04 allowable expense' },
  { name: 'Internet & Phone',        mapping: 'expense', description: 'Deductible — S04 allowable expense' },
  { name: 'Transfers',               excludeFromTotals: true, mapping: 'ignore', description: 'Account-to-account moves — never income or expense' },
];

module.exports = { buildClassifier, matchIncomeType, matchDeductible, INCOME_KEYWORDS, DEDUCTIBLE_KEYWORDS, S04_CATEGORY_PACK };
