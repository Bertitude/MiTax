/**
 * JMMB Bank/Securities Statement Parser
 */
const { normalizeDate, derivePeriodFromTransactions, applySignConvention, signedByBalanceDelta, resolveRowAmount } = require('./utils');

function parse(text, filePath) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const transactions = [];

  const accountMatch = text.match(/Account\s*(?:Number|No\.?|#)?\s*:?\s*([0-9\-\s]+)/i);
  const accountName = accountMatch ? `JMMB ${accountMatch[1].trim()}` : 'JMMB Account';
  const rawAccNum   = accountMatch ? accountMatch[1].replace(/\D/g, '') : '';
  const accountNumber = rawAccNum.length >= 4 ? rawAccNum.slice(-4) : rawAccNum;

  // Seed the running balance from an opening/brought-forward balance line so the
  // first transaction's sign can be inferred from the balance delta too.
  const openingMatch = text.match(/(?:opening|previous|brought\s+forward|b\/f)\s+balance[:\s]*([\d,]+\.\d{2})/i);
  let prevBalance = openingMatch ? parseFloat(openingMatch[1].replace(/,/g, '')) : null;

  const currency = text.match(/USD|US\$|United\s+States/i) ? 'USD' : 'JMD';

  let accountType = 'savings';
  if (/chequing|checking/i.test(text)) accountType = 'chequing';
  if (/investment|securities|fund/i.test(text)) accountType = 'investment';
  if (/loan|mortgage/i.test(text)) accountType = 'loan';

  // JMMB format varies — try to detect date + amounts
  const txPattern = /(\d{2}[\/\-]\d{2}[\/\-]\d{4})\s+(.*?)\s+([\d,]+\.\d{2})\s*([\d,]+\.\d{2})?/g;
  let match;

  while ((match = txPattern.exec(text)) !== null) {
    const [, dateStr, description, col1, col2] = match;
    const date = normalizeDate(dateStr);
    if (!date) continue;

    const val1 = col1 ? parseFloat(col1.replace(/,/g, '')) : 0;
    const val2 = col2 ? parseFloat(col2.replace(/,/g, '')) : 0;
    const payee = (description || 'JMMB Transaction').trim();

    // The transaction amount is always the FIRST number; a second number is the
    // running balance (never the transaction amount). Internal convention:
    // positive = debit/money-out. Prefer the balance-delta sign; fall back to a
    // keyword guess (income-like → credit) only when no balance is available.
    const txAmount = val1;
    const balance  = val2 > 0 ? val2 : null;
    let amount = signedByBalanceDelta(txAmount, prevBalance, balance);
    if (amount == null) amount = looksLikeCredit(payee) ? -Math.abs(txAmount) : Math.abs(txAmount);
    if (balance != null) prevBalance = balance;

    transactions.push({
      date,
      payee: cleanPayee(payee),
      amount,
      currency,
      notes: '',
      category: categorize(payee, amount),
      type: amount < 0 ? 'credit' : 'debit',
      balance,
    });
  }

  if (transactions.length === 0) fallbackParse(lines, transactions, currency, prevBalance);

  const period = derivePeriodFromTransactions(transactions);

  applySignConvention(transactions);
  return { institution: 'JMMB', accountType, accountName, accountNumber, currency, period, transactions };
}

// Payee keywords that indicate money IN (credit) — used only to sign the first
// row when there is no opening balance to delta against.
function looksLikeCredit(payee) {
  return /salary|payroll|interest|dividend|deposit|refund|credit|received|transfer\s*in/i.test(payee || '');
}

function fallbackParse(lines, transactions, currency, openingBalance = null) {
  const dateRe = /(\d{2}[\/\-]\d{2}[\/\-]\d{4})/;
  const amountRe = /([\d,]+\.\d{2})/g;
  let prevBalance = openingBalance;

  for (const line of lines) {
    if (!dateRe.test(line)) continue;
    const dateStr = line.match(dateRe)[1];
    const amounts = [...line.matchAll(amountRe)].map(m => parseFloat(m[1].replace(/,/g, '')));
    if (!amounts.length) continue;

    const rest = line.replace(dateRe, '').trim();
    const payee = rest.split(/\s{2,}/)[0] || 'JMMB Transaction';

    // The old fallback pushed the raw (positive) first number, which the
    // boundary sign-flip turned into an across-the-board debit — every credit
    // mis-signed. Resolve properly: balance delta → keyword guess.
    const { amount, balance } = resolveRowAmount(amounts, prevBalance, looksLikeCredit(payee));
    if (balance != null) prevBalance = balance;
    if (amount == null) continue;

    transactions.push({
      date: normalizeDate(dateStr),
      payee: cleanPayee(payee),
      amount,
      currency,
      notes: '',
      category: categorize(payee, amount),
      type: amount < 0 ? 'credit' : 'debit',
    });
  }
}

function cleanPayee(str) {
  return str.replace(/\s+/g, ' ').replace(/[^a-zA-Z0-9 &\-\/\(\)\.,']/g, '').trim().substring(0, 100);
}

function categorize(payee, amount) {
  const p = payee.toLowerCase();
  if (/interest|dividend/i.test(p)) return 'Investment Income';
  if (/salary|payroll/i.test(p)) return 'Income';
  if (/transfer/i.test(p)) return 'Transfer';
  if (/tax|nis|nht/i.test(p)) return 'Taxes';
  if (amount < 0) return 'Income';
  return 'Uncategorized';
}

module.exports = { parse };
