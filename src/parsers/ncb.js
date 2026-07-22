/**
 * NCB Jamaica Statement Parser
 * Handles NCB personal/business chequing and savings account PDFs.
 */
const { normalizeDate, derivePeriodFromTransactions, applySignConvention, resolveRowAmount } = require('./utils');

const BALANCE_ROW = /(?:opening|closing|previous|beginning|ending)\s+balance|balance\s+(?:forward|brought\s+forward|carried\s+forward|b\/f|c\/f)/i;

function parse(text, filePath) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const transactions = [];
  const warnings = [];
  const droppedRows = [];

  // Extract account info
  const accountMatch = text.match(/Account\s+(?:Number|No\.?):?\s*([0-9\-]+)/i);
  const rawAccNum   = accountMatch ? accountMatch[1].replace(/\D/g, '') : '';
  const accountNumber = rawAccNum.length >= 4 ? rawAccNum.slice(-4) : rawAccNum;
  const accountName = accountMatch ? `NCB ${accountMatch[1]}` : 'NCB Account';
  const currency = text.match(/USD|US\$/i) ? 'USD' : 'JMD';

  // Detect account type
  let accountType = 'chequing';
  if (/savings/i.test(text)) accountType = 'savings';
  if (/credit\s+card/i.test(text)) accountType = 'credit_card';
  if (/loan/i.test(text)) accountType = 'loan';

  // ── Single unified per-line pass ───────────────────────────────────────────
  // NCB rows are `Date [Ref] Description [Debit] [Credit] Balance`, but in
  // extracted text a blank column simply vanishes — a deposit row has only
  // two numbers (credit + balance) and is indistinguishable from a
  // withdrawal row by position alone. The old code used an all-or-nothing
  // regex for 3-number rows with a delta-based fallback ONLY when the regex
  // matched nothing, so mixed statements silently dropped every 2-number
  // row (i.e. the deposits). Now every dated line flows through
  // resolveRowAmount: balance-delta first, column interpretation for full
  // rows, keyword guess last — and anything unresolvable is warned about.
  const openingMatch = text.match(/(?:opening|previous|brought\s+forward|b\/f)\s+balance[:\s]*([\d,]+\.\d{2})/i);
  let prevBalance = openingMatch ? parseFloat(openingMatch[1].replace(/,/g, '')) : null;

  const dateRe   = /(\d{2}[\/\-]\d{2}[\/\-]\d{4})/;
  const amountRe = /([\d,]+\.\d{2})/g;

  for (const line of lines) {
    const dm = line.match(dateRe);
    if (!dm) continue;

    const numbers = [...line.matchAll(amountRe)].map(m => parseFloat(m[1].replace(/,/g, '')));
    if (!numbers.length) continue;   // description-only continuation line

    // Description with date and numbers stripped so the payee doesn't absorb
    // them when columns are single-spaced.
    const desc = line.replace(dateRe, '').replace(/[\d,]+\.\d{2}/g, ' ').replace(/\s{2,}/g, ' ').trim();

    if (BALANCE_ROW.test(desc)) {
      prevBalance = numbers[numbers.length - 1];
      continue;
    }

    // Leading reference token (e.g. "FT24051/123") — kept in notes, not payee
    let ref = '';
    let payee = desc;
    const refM = desc.match(/^([A-Z0-9\-\/]*\d[A-Z0-9\-\/]*)\s+(.+)$/);
    if (refM) { ref = refM[1]; payee = refM[2]; }
    payee = payee.trim() || 'NCB Transaction';

    const { amount, balance } = resolveRowAmount(numbers, prevBalance, looksLikeCredit(payee));
    if (balance != null) prevBalance = balance;

    if (amount == null) {
      droppedRows.push(`${normalizeDate(dm[1])} ${payee}`);
      continue;
    }

    transactions.push({
      date: normalizeDate(dm[1]),
      payee: cleanPayee(payee),
      amount,
      currency,
      notes: ref ? `Ref: ${ref}` : '',
      category: categorize(payee, amount),
      type: amount < 0 ? 'credit' : 'debit',
      balance,
    });
  }

  if (droppedRows.length) {
    warnings.push(
      `${droppedRows.length} transaction row(s) were SKIPPED because no amount could be resolved: ` +
      `${droppedRows.slice(0, 5).join('; ')}${droppedRows.length > 5 ? ` + ${droppedRows.length - 5} more` : ''}. ` +
      `Deposits/credits may be missing from the import — please report this statement layout.`
    );
  }

  applySignConvention(transactions);
  const period = derivePeriodFromTransactions(transactions);

  return {
    institution: 'NCB',
    accountType,
    accountName,
    accountNumber,
    currency,
    period,
    transactions,
    warnings,
  };
}

// Payee keywords indicating money IN (credit) — signs the first row only when
// there's no opening balance to delta against.
function looksLikeCredit(payee) {
  return /salary|payroll|wage|deposit|refund|credit|interest|dividend|received|transfer\s*in/i.test(payee || '');
}

function cleanPayee(str) {
  return str.replace(/\s+/g, ' ').replace(/[^a-zA-Z0-9 &\-\/\(\)\.,']/g, '').trim().substring(0, 100);
}

function categorize(payee, amount) {
  const p = payee.toLowerCase();
  if (/salary|payroll|wage/i.test(p)) return 'Income';
  if (/atm|cash\s+withdrawal/i.test(p)) return 'Cash & ATM';
  if (/grocery|supermarke|hi-lo|pricesmart|megamart/i.test(p)) return 'Groceries';
  if (/restaurant|kfc|burger|pizza|cafe|jerk|ocho/i.test(p)) return 'Food & Dining';
  if (/gas|petro|fuel|texaco|total\s+energy/i.test(p)) return 'Auto & Transport';
  if (/nis|nht|income\s+tax|tax\s+authority|taj/i.test(p)) return 'Taxes';
  if (/jps|nwc|flow|digicel|lime|cable|internet/i.test(p)) return 'Bills & Utilities';
  if (/insurance|sagicor|guardian|advantage/i.test(p)) return 'Insurance';
  if (/transfer|remittance|western\s+union|caricad/i.test(p)) return 'Transfer';
  if (amount < 0) return 'Income';
  return 'Uncategorized';
}

module.exports = { parse };
