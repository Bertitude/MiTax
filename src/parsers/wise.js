/**
 * Wise (TransferWise) Statement Parser
 * Wise exports CSV statements; we handle PDF too via text extraction.
 */
const { normalizeDate, derivePeriodFromTransactions } = require('./index');

function parse(text, filePath) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const transactions = [];

  // Wise CSV exports have columns:
  // TransferWise ID, Date, Amount, Currency, Description, Payment Reference, Running Balance, Exchange From, ...
  const currency = detectCurrency(text);

  // Try CSV-like rows in the PDF text
  const txPattern = /(\d{2}[-\/]\d{2}[-\/]\d{4}|\d{4}[-\/]\d{2}[-\/]\d{2})\s+(.*?)\s+([+-]?[\d,]+\.\d{2})\s+([A-Z]{3})/g;
  let match;

  while ((match = txPattern.exec(text)) !== null) {
    const [, dateStr, description, amountStr, cur] = match;
    const date = normalizeDate(dateStr);
    if (!date) continue;

    const amount = parseFloat(amountStr.replace(/,/g, ''));
    const payee = (description || 'Wise Transfer').trim();

    transactions.push({
      date,
      payee: cleanPayee(payee),
      amount,
      currency: cur || currency,
      notes: '',
      category: categorize(payee, amount),
      type: amount < 0 ? 'debit' : 'credit',
    });
  }

  if (transactions.length === 0) fallbackParse(lines, transactions, currency);

  const period = derivePeriodFromTransactions(transactions);

  return { institution: 'Wise', accountType: 'international', accountName: `Wise (${currency})`, currency, period, transactions };
}

function fallbackParse(lines, transactions, currency) {
  const dateRe = /(\d{4}-\d{2}-\d{2}|\d{2}[\/\-]\d{2}[\/\-]\d{4})/;
  const amountRe = /([+-]?[\d,]+\.\d{2})/g;

  for (const line of lines) {
    if (!dateRe.test(line)) continue;
    const dateStr = line.match(dateRe)[1];
    const amounts = [...line.matchAll(amountRe)].map(m => parseFloat(m[1].replace(/,/g, '')));
    if (!amounts.length) continue;

    const rest = line.replace(dateRe, '').trim();
    const payee = rest.split(/\s{2,}/)[0] || 'Wise Transaction';

    transactions.push({
      date: normalizeDate(dateStr),
      payee: cleanPayee(payee),
      amount: amounts[0],
      currency,
      notes: '',
      category: categorize(payee, amounts[0]),
      type: amounts[0] < 0 ? 'debit' : 'credit',
    });
  }
}

function detectCurrency(text) {
  if (/\bUSD\b/.test(text)) return 'USD';
  if (/\bGBP\b/.test(text)) return 'GBP';
  if (/\bEUR\b/.test(text)) return 'EUR';
  if (/\bCAD\b/.test(text)) return 'CAD';
  return 'USD';
}

function cleanPayee(str) {
  return str.replace(/\s+/g, ' ').replace(/[^a-zA-Z0-9 &\-\/\(\)\.,']/g, '').trim().substring(0, 100);
}

function categorize(payee, amount) {
  const p = payee.toLowerCase();
  if (/fee|charge/i.test(p)) return 'Fees';
  if (/transfer/i.test(p)) return 'Transfer';
  if (/refund/i.test(p)) return 'Refund';
  if (amount > 0) return 'Income';
  return 'Uncategorized';
}

module.exports = { parse };
