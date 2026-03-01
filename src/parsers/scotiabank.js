/**
 * Scotiabank Jamaica Statement Parser
 */
const { normalizeDate, derivePeriodFromTransactions } = require('./utils');

function parse(text, filePath) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const transactions = [];

  const accountMatch = text.match(/Account\s+(?:Number|No\.?|#):?\s*([0-9\-\s]+)/i);
  const rawAccNum    = accountMatch ? accountMatch[1].replace(/\D/g, '') : '';
  const accountNumber = rawAccNum.length >= 4 ? rawAccNum.slice(-4) : rawAccNum;
  const accountName = accountMatch ? `Scotiabank ${accountMatch[1].trim()}` : 'Scotiabank Account';
  const currency = text.match(/USD|US\$|United\s+States/i) ? 'USD' : 'JMD';

  let accountType = 'chequing';
  if (/savings/i.test(text)) accountType = 'savings';
  if (/visa|credit\s+card|mastercard/i.test(text)) accountType = 'credit_card';
  if (/mortgage|loan/i.test(text)) accountType = 'loan';

  // Scotiabank format: Date  Description  Withdrawals  Deposits  Balance
  const txPattern = /(\d{2}[\/\-]\d{2}[\/\-]\d{4})\s+(.*?)\s+([\d,]+\.\d{2})?\s*([\d,]+\.\d{2})?\s*([\d,]+\.\d{2})/g;
  let match;

  while ((match = txPattern.exec(text)) !== null) {
    const [, dateStr, description, withdrawalStr, depositStr] = match;
    const date = normalizeDate(dateStr);
    if (!date) continue;

    const withdrawal = withdrawalStr ? parseFloat(withdrawalStr.replace(/,/g, '')) : 0;
    const deposit = depositStr ? parseFloat(depositStr.replace(/,/g, '')) : 0;
    if (withdrawal === 0 && deposit === 0) continue;

    const amount = deposit > 0 ? deposit : -withdrawal;
    const payee = (description || 'Scotia Transaction').trim();

    transactions.push({
      date,
      payee: cleanPayee(payee),
      amount,
      currency,
      notes: '',
      category: categorize(payee, amount),
      type: amount < 0 ? 'debit' : 'credit',
    });
  }

  if (transactions.length === 0) fallbackParse(lines, transactions, currency);

  const period = derivePeriodFromTransactions(transactions);

  return { institution: 'Scotiabank', accountType, accountName, accountNumber, currency, period, transactions };
}

function fallbackParse(lines, transactions, currency) {
  const dateRe = /^(\d{2}[\/\-]\d{2}[\/\-]\d{4})/;
  const amountRe = /([\d,]+\.\d{2})/g;

  for (const line of lines) {
    if (!dateRe.test(line)) continue;
    const dateStr = line.match(dateRe)[1];
    const amounts = [...line.matchAll(amountRe)].map(m => parseFloat(m[1].replace(/,/g, '')));
    if (!amounts.length) continue;

    const rest = line.replace(dateRe, '').trim();
    const payee = rest.split(/\s{2,}/)[0] || 'Transaction';
    const amount = amounts.length >= 2 ? (amounts[0] !== amounts[1] ? -amounts[0] : amounts[1]) : amounts[0];

    transactions.push({
      date: normalizeDate(dateStr),
      payee: cleanPayee(payee),
      amount,
      currency,
      notes: '',
      category: categorize(payee, amount),
      type: amount < 0 ? 'debit' : 'credit',
    });
  }
}

function cleanPayee(str) {
  return str.replace(/\s+/g, ' ').replace(/[^a-zA-Z0-9 &\-\/\(\)\.,']/g, '').trim().substring(0, 100);
}

function categorize(payee, amount) {
  const p = payee.toLowerCase();
  if (/salary|payroll/i.test(p)) return 'Income';
  if (/atm|cash/i.test(p)) return 'Cash & ATM';
  if (/grocery|supermarket|hi-lo|megamart|pricesmart/i.test(p)) return 'Groceries';
  if (/restaurant|kfc|burger|pizza|cafe/i.test(p)) return 'Food & Dining';
  if (/gas|fuel|petro/i.test(p)) return 'Auto & Transport';
  if (/nis|nht|tax/i.test(p)) return 'Taxes';
  if (/jps|nwc|flow|digicel|lime/i.test(p)) return 'Bills & Utilities';
  if (/insurance/i.test(p)) return 'Insurance';
  if (/transfer/i.test(p)) return 'Transfer';
  if (amount > 0) return 'Income';
  return 'Uncategorized';
}

module.exports = { parse };
