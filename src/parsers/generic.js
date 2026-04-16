/**
 * Generic Statement Parser — fallback for unrecognized institutions.
 * Uses heuristic patterns to extract dates and amounts.
 *
 * Sign convention (LunchMoney):
 *   amount > 0 → debit  (money out / expense)
 *   amount < 0 → credit (money in / income)
 */
const { normalizeDate, derivePeriodFromTransactions, applySignConvention } = require('./utils');

// Amount regex with optional trailing DR/CR indicator (common on Caribbean/UK
// statements). Captures: group 1 = signed number, group 2 = DR|CR (if present).
const AMOUNT_RE = /([+-]?[\d,]+\.\d{2})(?:\s*(DR|CR|Dr|Cr|dr|cr))?/g;

function parse(text, filePath) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const transactions = [];

  const currency = detectCurrency(text);

  // Detect institution name from first few lines
  const headerLines = lines.slice(0, 10).join(' ');
  const institutionMatch = headerLines.match(/^([A-Z][A-Za-z\s&\.]{3,40}(?:Bank|Financial|Credit|Trust|Fund|Capital|Group))/);
  const institution = institutionMatch ? institutionMatch[1].trim() : 'Unknown';

  const datePatterns = [
    /(\d{2}[\/\-]\d{2}[\/\-]\d{4})/,
    /(\d{4}[\/\-]\d{2}[\/\-]\d{2})/,
    /(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4})/i,
    /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}/i,
  ];

  // Detect column layout from the statement header row, if present.
  const columnMap = detectColumns(lines);

  for (const line of lines) {
    let dateStr = null;
    for (const pattern of datePatterns) {
      const m = line.match(pattern);
      if (m) { dateStr = m[1]; break; }
    }
    if (!dateStr) continue;

    const amountsWithSuffix = extractAmounts(line);
    if (!amountsWithSuffix.length) continue;

    const resolved = resolveAmount(amountsWithSuffix, columnMap);
    if (!resolved.reliable) continue; // Skip rather than emit a guessed sign

    const amount = resolved.amount;

    const rest = line.replace(dateStr, '').trim();
    const payee = rest.split(/\s{2,}/)[0] || 'Transaction';

    transactions.push({
      date: normalizeDate(dateStr),
      payee: cleanPayee(payee),
      amount,
      currency,
      notes: '',
      category: amount < 0 ? 'Income' : 'Uncategorized',
      type: amount < 0 ? 'credit' : 'debit',
    });
  }

  const period = derivePeriodFromTransactions(transactions);
  const accMatch    = text.match(/Account\s*(?:No\.?|Number|#):?\s*([*Xx\d][*Xx\d\-\s]{3,20})/i);
  const rawAccNum   = accMatch ? accMatch[1].replace(/[^0-9]/g, '') : '';
  const accountNumber = rawAccNum.length >= 4 ? rawAccNum.slice(-4) : rawAccNum;

  applySignConvention(transactions);
  return {
    institution,
    accountType: 'unknown',
    accountName: institution,
    accountNumber,
    currency,
    period,
    transactions,
  };
}

/**
 * Extract all monetary values from a line along with any DR/CR suffix.
 * Returns array of { value: number, suffix: 'DR' | 'CR' | null }.
 */
function extractAmounts(line) {
  const out = [];
  for (const m of line.matchAll(AMOUNT_RE)) {
    out.push({
      value: parseFloat(m[1].replace(/,/g, '')),
      suffix: m[2] ? m[2].toUpperCase() : null,
    });
  }
  return out;
}

/**
 * Scan the first 40 lines for a statement header row. Returns a map of role
 * → ordinal position among matched monetary-column keywords (e.g. for
 * "Date Description Debit Credit Balance" the map is
 * { debit: 0, credit: 1, balance: 2 }). Returns null if no header is found.
 *
 * Ordinals match the positional order of amounts in a transaction row, on the
 * assumption that the header lists monetary columns in the same order they
 * appear in each data row.
 */
function detectColumns(lines) {
  const keywords = [
    { role: 'debit',   re: /\b(?:debit|withdrawals?|money\s*out|paid\s*out|charges?)\b/i },
    { role: 'credit',  re: /\b(?:credit|deposits?|money\s*in|paid\s*in)\b/i },
    { role: 'amount',  re: /\b(?:amount|value)\b/i },
    { role: 'balance', re: /\bbalance\b/i },
  ];
  const dateRe = /\b\d{1,4}[\/\-]\d{1,2}[\/\-]\d{1,4}\b/;

  for (const line of lines.slice(0, 40)) {
    // Skip lines that look like transaction rows (contain a date).
    if (dateRe.test(line)) continue;

    const hits = [];
    for (const kw of keywords) {
      const m = line.match(kw.re);
      if (m) hits.push({ role: kw.role, at: m.index });
    }
    if (hits.length >= 2) {
      hits.sort((a, b) => a.at - b.at);
      const byRole = {};
      hits.forEach((h, i) => { byRole[h.role] = i; });
      return byRole;
    }
  }
  return null;
}

/**
 * Resolve the signed transaction amount from a line's extracted amounts.
 * Precedence:
 *   1. DR/CR suffix on any amount (non-balance) — most explicit.
 *   2. Header-detected column map — use role to pick debit vs credit.
 *   3. Heuristic fallback based on amount count.
 *
 * Returns { amount, reliable }. When reliable === false the caller should
 * skip the line rather than emit a guessed sign.
 */
function resolveAmount(amountsWithSuffix, columnMap) {
  // 1. DR/CR suffix wins.
  for (const a of amountsWithSuffix) {
    if (a.suffix === 'DR') return { amount: Math.abs(a.value), reliable: true };
    if (a.suffix === 'CR') return { amount: -Math.abs(a.value), reliable: true };
  }

  // 2. Header-detected columns.
  if (columnMap) {
    const debitIdx   = columnMap.debit;
    const creditIdx  = columnMap.credit;
    const amountIdx  = columnMap.amount;

    const debitVal  = debitIdx  !== undefined ? amountsWithSuffix[debitIdx]  : undefined;
    const creditVal = creditIdx !== undefined ? amountsWithSuffix[creditIdx] : undefined;
    const amountVal = amountIdx !== undefined ? amountsWithSuffix[amountIdx] : undefined;

    if (debitVal && debitVal.value !== 0) {
      return { amount: Math.abs(debitVal.value), reliable: true };
    }
    if (creditVal && creditVal.value !== 0) {
      return { amount: -Math.abs(creditVal.value), reliable: true };
    }
    if (amountVal && amountVal.value !== 0) {
      // Single amount column — bank statements conventionally show positive
      // for deposits and negative for withdrawals, which is the inverse of
      // the LunchMoney convention, so negate.
      return { amount: -amountVal.value, reliable: true };
    }
    // Column map matched but all expected columns are zero/missing — fall
    // through to the heuristic fallback.
  }

  // 3. Heuristic fallback (no reliable column info).
  const amounts = amountsWithSuffix.map(a => a.value);
  if (amounts.length >= 3) {
    // Likely [debit, credit, balance] or [credit, debit, balance] — we can't
    // tell without a header or DR/CR suffix, so refuse to guess.
    return { amount: 0, reliable: false };
  }
  if (amounts.length === 2) {
    // Assume [amount, balance]; pass the amount through as-written.
    return { amount: amounts[0], reliable: true };
  }
  return { amount: amounts[0], reliable: true };
}

function detectCurrency(text) {
  if (/\bJMD\b|J\$|Jamaica\s+Dollar/i.test(text)) return 'JMD';
  if (/\bUSD\b|US\$|United\s+States\s+Dollar/i.test(text)) return 'USD';
  if (/\bGBP\b|£|British\s+Pound/i.test(text)) return 'GBP';
  if (/\bEUR\b|€/i.test(text)) return 'EUR';
  if (/\bCAD\b/i.test(text)) return 'CAD';
  return 'JMD';
}

function cleanPayee(str) {
  return str.replace(/\s+/g, ' ').replace(/[^a-zA-Z0-9 &\-\/\(\)\.,']/g, '').trim().substring(0, 100);
}

module.exports = { parse, detectColumns, resolveAmount, extractAmounts };
