/**
 * Generic Statement Parser — fallback for unrecognized institutions.
 * Uses heuristic patterns to extract dates and amounts.
 *
 * Sign convention (LunchMoney):
 *   amount > 0 → debit  (money out / expense)
 *   amount < 0 → credit (money in / income)
 */
const { normalizeDate, derivePeriodFromTransactions, applySignConvention, signedByBalanceDelta } = require('./utils');

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
  const hasBalanceCol = !!(columnMap && columnMap.balance !== undefined);

  const openingMatch = text.match(/(?:opening|previous|brought\s+forward|b\/f)\s+balance[:\s]*([\d,]+\.\d{2})/i);
  let prevBalance = openingMatch ? parseFloat(openingMatch[1].replace(/,/g, '')) : null;

  for (const line of lines) {
    let dateStr = null;
    for (const pattern of datePatterns) {
      const m = line.match(pattern);
      if (m) { dateStr = m[1]; break; }
    }
    if (!dateStr) continue;

    const amountsWithSuffix = extractAmounts(line);
    if (!amountsWithSuffix.length) continue;

    // Strip the amount/balance numbers (and any DR/CR marker) so the payee
    // doesn't absorb them when columns are single-spaced.
    const rest = line.replace(dateStr, '')
      .replace(/[\d,]+\.\d{2}\s*(?:DR|CR|Dr|Cr|dr|cr)?/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    const payee = rest || 'Transaction';

    // A running balance is conventionally the last number on the row.
    const balance = (hasBalanceCol || amountsWithSuffix.length >= 2)
      ? amountsWithSuffix[amountsWithSuffix.length - 1].value
      : null;

    const resolved = resolveAmount(amountsWithSuffix, columnMap);
    let amount;
    if (resolved.reliable) {
      amount = resolved.amount;
    } else {
      // Ambiguous columns and no DR/CR suffix: infer the sign from the balance
      // delta; fall back to a payee keyword guess for the first row (no prior
      // balance). Positive = debit/money-out (internal convention).
      const txAmount = amountsWithSuffix[0].value;
      amount = signedByBalanceDelta(txAmount, prevBalance, balance);
      if (amount == null) amount = looksLikeCredit(payee) ? -Math.abs(txAmount) : Math.abs(txAmount);
    }
    if (balance != null) prevBalance = balance;

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
  // 1. DR/CR suffix wins — but only on a transaction amount, never the running
  //    balance (conventionally the last number). A "…105,000.00 CR" balance
  //    marker must not flip the whole row to a credit.
  const suffixCandidates = amountsWithSuffix.length >= 2
    ? amountsWithSuffix.slice(0, -1)
    : amountsWithSuffix;
  for (const a of suffixCandidates) {
    if (a.suffix === 'DR') return { amount: Math.abs(a.value), reliable: true };
    if (a.suffix === 'CR') return { amount: -Math.abs(a.value), reliable: true };
  }

  // 2. Header-detected columns — only trustworthy when every mapped column is
  //    populated in this row (amount count === column count). Otherwise an
  //    empty cell shifts the positions and a credit lands in the debit slot, so
  //    fall through to the caller's balance-delta / keyword inference.
  if (columnMap && amountsWithSuffix.length === Object.keys(columnMap).length) {
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
  }

  // 3. Ambiguous — caller resolves via balance delta / payee keyword.
  return { amount: 0, reliable: false };
}

// Payee keywords indicating money IN (credit) — used only when neither a DR/CR
// suffix, a full column row, nor a balance delta can determine the sign.
function looksLikeCredit(payee) {
  return /salary|payroll|wage|deposit|refund|credit|interest|dividend|received|reversal|transfer\s*in/i.test(payee || '');
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
