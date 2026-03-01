/**
 * PayPal Statement Parser
 */
const { normalizeDate, derivePeriodFromTransactions } = require('./utils');

function parse(text, filePath) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const transactions = [];
  const currency = detectCurrency(text);

  // PayPal format: Date  Time  TimeZone  Name  Type  Status  Currency  Gross  Fee  Net
  const txPattern = /(\d{1,2}\/\d{1,2}\/\d{4})\s+\d{2}:\d{2}:\d{2}\s+\w+\s+(.*?)\s+(Payment|Transfer|Withdrawal|Refund|Subscription|Invoice)[^\d]+([\d,]+\.\d{2})\s+([-\d,]+\.\d{2})\s+([-\d,]+\.\d{2})/g;
  let match;

  while ((match = txPattern.exec(text)) !== null) {
    const [, dateStr, name, type, grossStr, feeStr, netStr] = match;
    const date = normalizeDate(dateStr);
    if (!date) continue;

    const gross = parseFloat(grossStr.replace(/,/g, ''));
    const net = parseFloat(netStr.replace(/,/g, ''));
    const payee = (name || 'PayPal').trim();

    transactions.push({
      date,
      payee: cleanPayee(payee),
      amount: net,
      currency,
      notes: `Type: ${type} | Gross: ${gross} | Fee: ${feeStr}`,
      category: categorize(type, net),
      type: net < 0 ? 'debit' : 'credit',
    });
  }

  if (transactions.length === 0) fallbackParse(lines, transactions, currency);

  const period = derivePeriodFromTransactions(transactions);

  return { institution: 'PayPal', accountType: 'international', accountName: 'PayPal', currency, period, transactions };
}

function fallbackParse(lines, transactions, currency) {
  const dateRe = /(\d{1,2}\/\d{1,2}\/\d{4})/;
  const amountRe = /([+-]?[\d,]+\.\d{2})/g;

  for (const line of lines) {
    if (!dateRe.test(line)) continue;
    const dateStr = line.match(dateRe)[1];
    const amounts = [...line.matchAll(amountRe)].map(m => parseFloat(m[1].replace(/,/g, '')));
    if (!amounts.length) continue;

    const rest = line.replace(dateRe, '').trim();
    const payee = rest.split(/\s{2,}/)[0] || 'PayPal';

    transactions.push({
      date: normalizeDate(dateStr),
      payee: cleanPayee(payee),
      amount: amounts[amounts.length - 1],
      currency,
      notes: '',
      category: amounts[amounts.length - 1] < 0 ? 'Payment Sent' : 'Payment Received',
      type: amounts[amounts.length - 1] < 0 ? 'debit' : 'credit',
    });
  }
}

function detectCurrency(text) {
  if (/\bUSD\b|\$/.test(text)) return 'USD';
  if (/\bGBP\b/.test(text)) return 'GBP';
  if (/\bEUR\b/.test(text)) return 'EUR';
  return 'USD';
}

function cleanPayee(str) {
  return str.replace(/\s+/g, ' ').replace(/[^a-zA-Z0-9 &\-\/\(\)\.,'@]/g, '').trim().substring(0, 100);
}

function categorize(type, amount) {
  if (!type) return amount > 0 ? 'Income' : 'Expense';
  const t = type.toLowerCase();
  if (t.includes('refund')) return 'Refund';
  if (t.includes('fee')) return 'Fees';
  if (t.includes('transfer') || t.includes('withdrawal')) return 'Transfer';
  if (t.includes('subscription')) return 'Subscriptions';
  if (amount > 0) return 'Income';
  return 'Payment Sent';
}

module.exports = { parse };
