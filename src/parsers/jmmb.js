/**
 * JMMB Bank/Securities Statement Parser
 */
const { normalizeDate, derivePeriodFromTransactions } = require('./utils');

function parse(text, filePath) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const transactions = [];

  const accountMatch = text.match(/Account\s*(?:Number|No\.?|#)?\s*:?\s*([0-9\-\s]+)/i);
  const accountName = accountMatch ? `JMMB ${accountMatch[1].trim()}` : 'JMMB Account';

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

    // Heuristic: if two amounts, first col = debit, second col = credit.
    // LunchMoney convention: positive = expense/debit, negative = income/credit.
    let amount = 0;
    if (val1 > 0 && val2 === 0) amount = val1;                     // single amount → assume debit
    else if (val1 > 0 && val2 > 0) amount = val2 > val1 ? -val2 : val1; // larger in col2 → credit (negative)
    else amount = val1;

    const payee = (description || 'JMMB Transaction').trim();

    transactions.push({
      date,
      payee: cleanPayee(payee),
      amount,
      currency,
      notes: '',
      category: categorize(payee, amount),
      type: amount < 0 ? 'credit' : 'debit',
    });
  }

  if (transactions.length === 0) fallbackParse(lines, transactions, currency);

  const period = derivePeriodFromTransactions(transactions);

  return { institution: 'JMMB', accountType, accountName, accountNumber, currency, period, transactions };
}

function fallbackParse(lines, transactions, currency) {
  const dateRe = /(\d{2}[\/\-]\d{2}[\/\-]\d{4})/;
  const amountRe = /([\d,]+\.\d{2})/g;

  for (const line of lines) {
    if (!dateRe.test(line)) continue;
    const dateStr = line.match(dateRe)[1];
    const amounts = [...line.matchAll(amountRe)].map(m => parseFloat(m[1].replace(/,/g, '')));
    if (!amounts.length) continue;

    const rest = line.replace(dateRe, '').trim();
    const payee = rest.split(/\s{2,}/)[0] || 'JMMB Transaction';
    const amount = amounts[0];

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
