/**
 * NCB Jamaica Statement Parser
 * Handles NCB personal/business chequing and savings account PDFs.
 */
const { normalizeDate, derivePeriodFromTransactions } = require('./utils');

function parse(text, filePath) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const transactions = [];

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

  // Transaction pattern:
  // DD/MM/YYYY | Description | Debit | Credit | Balance
  // NCB typically uses: Date  Reference  Description  Debit  Credit  Balance
  const txPattern = /(\d{2}[\/\-]\d{2}[\/\-]\d{4})\s+([A-Z0-9\-\/]+)?\s+(.*?)\s+([\d,]+\.\d{2})?\s+([\d,]+\.\d{2})?\s+([\d,]+\.\d{2})/g;
  let match;

  while ((match = txPattern.exec(text)) !== null) {
    const [, dateStr, ref, description, debitStr, creditStr, balanceStr] = match;
    const date = normalizeDate(dateStr);
    if (!date) continue;

    const debit = debitStr ? parseFloat(debitStr.replace(/,/g, '')) : 0;
    const credit = creditStr ? parseFloat(creditStr.replace(/,/g, '')) : 0;

    // Skip if both are zero or neither is present
    if (debit === 0 && credit === 0) continue;

    const amount = credit > 0 ? credit : -debit;
    const payee = (description || ref || 'NCB Transaction').trim();

    transactions.push({
      date,
      payee: cleanPayee(payee),
      amount,
      currency,
      notes: ref ? `Ref: ${ref}` : '',
      category: categorize(payee, amount),
      type: amount < 0 ? 'debit' : 'credit',
      balance: balanceStr ? parseFloat(balanceStr.replace(/,/g, '')) : null,
    });
  }

  // Fallback: simpler date + amount pattern for short statements
  if (transactions.length === 0) {
    fallbackParse(lines, transactions, currency);
  }

  const period = derivePeriodFromTransactions(transactions);

  return {
    institution: 'NCB',
    accountType,
    accountName,
    accountNumber,
    currency,
    period,
    transactions,
  };
}

function fallbackParse(lines, transactions, currency) {
  const dateRe = /^(\d{2}[\/\-]\d{2}[\/\-]\d{4})/;
  const amountRe = /([\d,]+\.\d{2})/g;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!dateRe.test(line)) continue;

    const dateStr = line.match(dateRe)[1];
    const amounts = [...line.matchAll(amountRe)].map(m => parseFloat(m[1].replace(/,/g, '')));
    if (amounts.length === 0) continue;

    const descriptionParts = line.replace(dateRe, '').trim().split(/\s{2,}/);
    const payee = descriptionParts[0] || 'Transaction';
    const amount = amounts.length >= 2 ? (amounts[0] > 0 ? -amounts[0] : amounts[1]) : amounts[0];

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
  if (/salary|payroll|wage/i.test(p)) return 'Income';
  if (/atm|cash\s+withdrawal/i.test(p)) return 'Cash & ATM';
  if (/grocery|supermarke|hi-lo|pricesmart|megamart/i.test(p)) return 'Groceries';
  if (/restaurant|kfc|burger|pizza|cafe|jerk|ocho/i.test(p)) return 'Food & Dining';
  if (/gas|petro|fuel|texaco|total\s+energy/i.test(p)) return 'Auto & Transport';
  if (/nis|nht|income\s+tax|tax\s+authority|taj/i.test(p)) return 'Taxes';
  if (/jps|nwc|flow|digicel|lime|cable|internet/i.test(p)) return 'Bills & Utilities';
  if (/insurance|sagicor|guardian|advantage/i.test(p)) return 'Insurance';
  if (/transfer|remittance|western\s+union|caricad/i.test(p)) return 'Transfer';
  if (amount > 0) return 'Income';
  return 'Uncategorized';
}

module.exports = { parse };
