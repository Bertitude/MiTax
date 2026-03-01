/**
 * Generic Statement Parser — fallback for unrecognized institutions.
 * Uses heuristic patterns to extract dates and amounts.
 */
const { normalizeDate, derivePeriodFromTransactions } = require('./utils');

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

  const amountRe = /([+-]?[\d,]+\.\d{2})/g;

  for (const line of lines) {
    let dateStr = null;
    for (const pattern of datePatterns) {
      const m = line.match(pattern);
      if (m) { dateStr = m[1]; break; }
    }
    if (!dateStr) continue;

    const amounts = [...line.matchAll(amountRe)].map(m => parseFloat(m[1].replace(/,/g, '')));
    if (!amounts.length) continue;

    const rest = line.replace(dateStr, '').trim();
    const payee = rest.split(/\s{2,}/)[0] || 'Transaction';

    // Use the last amount as balance context — take the second-to-last as transaction amount if multiple
    let amount;
    if (amounts.length >= 3) {
      // Likely: debit | credit | balance → pick whichever is non-zero among [0] and [1]
      amount = amounts[0] !== 0 ? -amounts[0] : amounts[1];
    } else if (amounts.length === 2) {
      amount = amounts[0];
    } else {
      amount = amounts[0];
    }

    transactions.push({
      date: normalizeDate(dateStr),
      payee: cleanPayee(payee),
      amount,
      currency,
      notes: '',
      category: amount > 0 ? 'Income' : 'Uncategorized',
      type: amount < 0 ? 'debit' : 'credit',
    });
  }

  const period = derivePeriodFromTransactions(transactions);
  const accMatch    = text.match(/Account\s*(?:No\.?|Number|#):?\s*([*Xx\d][*Xx\d\-\s]{3,20})/i);
  const rawAccNum   = accMatch ? accMatch[1].replace(/[^0-9]/g, '') : '';
  const accountNumber = rawAccNum.length >= 4 ? rawAccNum.slice(-4) : rawAccNum;

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

module.exports = { parse };
