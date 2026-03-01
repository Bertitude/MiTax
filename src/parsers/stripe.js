/**
 * Stripe Payout / Balance Statement Parser
 */
const { normalizeDate, derivePeriodFromTransactions } = require('./utils');

function parse(text, filePath) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const transactions = [];
  const currency = detectCurrency(text);

  // Stripe payout statements typically list: Date | Description | Amount | Fee | Net
  const txPattern = /(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4})\s+(.*?)\s+([+-]?[\d,]+\.\d{2})\s+([+-]?[\d,]+\.\d{2})?\s+([+-]?[\d,]+\.\d{2})?/g;
  let match;

  while ((match = txPattern.exec(text)) !== null) {
    const [, dateStr, description, col1, col2, col3] = match;
    const date = normalizeDate(dateStr);
    if (!date) continue;

    // col3 is usually net, col1 is gross
    const amount = col3 ? parseFloat(col3.replace(/,/g, '')) : parseFloat(col1.replace(/,/g, ''));
    const payee = (description || 'Stripe').trim();

    transactions.push({
      date,
      payee: cleanPayee(payee),
      amount,
      currency,
      notes: col2 ? `Fee: ${col2}` : '',
      category: categorize(payee, amount),
      type: amount < 0 ? 'debit' : 'credit',
    });
  }

  if (transactions.length === 0) fallbackParse(lines, transactions, currency);

  const period = derivePeriodFromTransactions(transactions);

  return { institution: 'Stripe', accountType: 'international', accountName: 'Stripe', currency, period, transactions };
}

function fallbackParse(lines, transactions, currency) {
  const dateRe = /(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4})/;
  const amountRe = /([+-]?[\d,]+\.\d{2})/g;

  for (const line of lines) {
    if (!dateRe.test(line)) continue;
    const dateStr = line.match(dateRe)[1];
    const amounts = [...line.matchAll(amountRe)].map(m => parseFloat(m[1].replace(/,/g, '')));
    if (!amounts.length) continue;

    const rest = line.replace(dateRe, '').trim();
    const payee = rest.split(/\s{2,}/)[0] || 'Stripe Transaction';

    transactions.push({
      date: normalizeDate(dateStr),
      payee: cleanPayee(payee),
      amount: amounts[amounts.length - 1],
      currency,
      notes: '',
      category: categorize(payee, amounts[amounts.length - 1]),
      type: amounts[amounts.length - 1] < 0 ? 'debit' : 'credit',
    });
  }
}

function detectCurrency(text) {
  if (/\bUSD\b/.test(text)) return 'USD';
  if (/\bGBP\b/.test(text)) return 'GBP';
  if (/\bEUR\b/.test(text)) return 'EUR';
  return 'USD';
}

function cleanPayee(str) {
  return str.replace(/\s+/g, ' ').replace(/[^a-zA-Z0-9 &\-\/\(\)\.,']/g, '').trim().substring(0, 100);
}

function categorize(payee, amount) {
  const p = payee.toLowerCase();
  if (/payout|transfer/i.test(p)) return 'Transfer';
  if (/refund|dispute/i.test(p)) return 'Refund';
  if (/fee/i.test(p)) return 'Fees';
  if (amount > 0) return 'Business Income';
  return 'Uncategorized';
}

module.exports = { parse };
