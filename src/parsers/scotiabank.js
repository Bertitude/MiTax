/**
 * Scotiabank Jamaica Statement Parser
 *
 * Strategy (in order):
 *  1. Coordinate-aware extraction via Python / pdfplumber (scotiabank_extract.py).
 *     Scotiabank PDFs use a 3-column layout (date | description | amount) that
 *     pdf-parse cannot reliably handle because it loses column alignment.
 *  2. Regex fallback on the raw pdf-parse text if Python is unavailable.
 */

'use strict';

const { spawnSync } = require('child_process');
const path          = require('path');
const { normalizeDate, derivePeriodFromTransactions } = require('./utils');

// ── Python helper path ────────────────────────────────────────────────────────
// In development:  <project>/src/parsers/scotiabank_extract.py
// Packaged app:    <resources>/app.asar.unpacked/src/parsers/scotiabank_extract.py
function getScriptPath() {
  try {
    const { app } = require('electron');
    if (app && app.isPackaged) {
      return path.join(
        process.resourcesPath,
        'app.asar.unpacked',
        'src', 'parsers', 'scotiabank_extract.py',
      );
    }
  } catch (_) { /* not in Electron context */ }
  return path.join(__dirname, 'scotiabank_extract.py');
}

// ── Attempt pdfplumber extraction ─────────────────────────────────────────────
function extractViaPython(filePath) {
  const scriptPath = getScriptPath();
  const pythonCmds = ['python3', 'python'];

  for (const cmd of pythonCmds) {
    const result = spawnSync(cmd, [scriptPath, filePath], {
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    });

    if (result.status === 0 && result.stdout) {
      try {
        const parsed = JSON.parse(result.stdout.trim());
        if (parsed.error) {
          console.warn('[Scotiabank] Python helper error:', parsed.error);
          return null;
        }
        return parsed;
      } catch (_) {
        console.warn('[Scotiabank] Could not parse Python output as JSON');
      }
    }
  }

  console.warn('[Scotiabank] Python / pdfplumber not available — using regex fallback');
  return null;
}

// ── Main entry point ──────────────────────────────────────────────────────────
function parse(text, filePath) {
  // 1. Try the coordinate-aware Python extractor
  if (filePath) {
    const pyResult = extractViaPython(filePath);
    if (pyResult && pyResult.transactions && pyResult.transactions.length > 0) {
      return pyResult;
    }
  }

  // 2. Regex fallback ─────────────────────────────────────────────────────────
  console.warn('[Scotiabank] Falling back to regex parser');
  return regexParse(text);
}

// ── Regex-based fallback (handles older / simpler layouts) ────────────────────
function regexParse(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  const accountMatch  = text.match(/Account\s+(?:Number|No\.?|#):?\s*([0-9\-\s]+)/i);
  const rawAccNum     = accountMatch ? accountMatch[1].replace(/\D/g, '') : '';
  const accountNumber = rawAccNum.length >= 4 ? rawAccNum.slice(-4) : rawAccNum;
  const accountName   = accountNumber ? `Scotiabank ...${accountNumber}` : 'Scotiabank Account';
  const currency      = /USD|US\$|United\s+States/i.test(text) ? 'USD' : 'JMD';

  let accountType = 'chequing';
  if (/savings/i.test(text))                             accountType = 'savings';
  if (/visa|credit\s+card|mastercard/i.test(text))       accountType = 'credit_card';
  if (/mortgage|loan/i.test(text))                       accountType = 'loan';

  const transactions = [];

  // Pattern A: DD/MM/YYYY style dates with debit/credit columns
  const txPattern = /(\d{2}[\/\-]\d{2}[\/\-]\d{4})\s+(.*?)\s+([\d,]+\.\d{2})?\s*([\d,]+\.\d{2})?\s*([\d,]+\.\d{2})/g;
  let match;
  while ((match = txPattern.exec(text)) !== null) {
    const [, dateStr, description, withdrawalStr, depositStr] = match;
    const date = normalizeDate(dateStr);
    if (!date) continue;

    const withdrawal = withdrawalStr ? parseFloat(withdrawalStr.replace(/,/g, '')) : 0;
    const deposit    = depositStr    ? parseFloat(depositStr.replace(/,/g, ''))    : 0;
    if (withdrawal === 0 && deposit === 0) continue;

    const amount = deposit > 0 ? deposit : -withdrawal;
    const payee  = cleanPayee(description || 'Scotia Transaction');
    transactions.push({ date, payee, amount, currency, notes: '',
      category: categorize(payee, amount),
      type: amount < 0 ? 'debit' : 'credit' });
  }

  // Pattern B: J$ NNN.NN +/- style (amount after sign)
  if (transactions.length === 0) {
    fallbackAmountSign(lines, transactions, currency);
  }

  const period = derivePeriodFromTransactions(transactions);
  return { institution: 'Scotiabank', accountType, accountName, accountNumber, currency, period, transactions };
}

function fallbackAmountSign(lines, transactions, currency) {
  // Look for lines containing J$ amount +/- near a DDMMM date
  const dateRe   = /^(\d{2}[A-Z]{3})/;
  const amountRe = /J\$\s*([\d,]+\.\d{2})\s*([-+])/;

  for (const line of lines) {
    const dm = line.match(dateRe);
    const am = line.match(amountRe);
    if (!dm || !am) continue;

    const ddmmm = dm[1];
    const year  = new Date().getFullYear();
    const mo    = { JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12 }[ddmmm.slice(2)] || 1;
    const dd    = parseInt(ddmmm.slice(0, 2), 10);
    const date  = `${year}-${String(mo).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;

    const val    = parseFloat(am[1].replace(/,/g, ''));
    const amount = am[2] === '+' ? val : -val;
    const payee  = cleanPayee(line.replace(dateRe, '').replace(amountRe, '').trim()) || 'Scotiabank Transaction';

    transactions.push({ date, payee, amount, currency, notes: '',
      category: categorize(payee, amount),
      type: amount < 0 ? 'debit' : 'credit' });
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function cleanPayee(str) {
  return str.replace(/\s+/g, ' ')
            .replace(/[^a-zA-Z0-9 &\-\/\(\)\.,'*]/g, '')
            .trim()
            .substring(0, 100);
}

function categorize(payee, amount) {
  const p = payee.toLowerCase();
  if (/salary|payroll/.test(p))                         return 'Income';
  if (/atm|abm|cash/.test(p))                           return 'Cash & ATM';
  if (/grocery|supermarket|hi-lo|megamart|pricesmart/.test(p)) return 'Groceries';
  if (/restaurant|kfc|burger|pizza|cafe|hellofood/.test(p))    return 'Food & Dining';
  if (/gas|fuel|petro|texaco|total station/.test(p))    return 'Auto & Transport';
  if (/\bnis\b|nht|\btax\b|gct/.test(p))                return 'Taxes';
  if (/jps|nwc|flow|digicel|lime/.test(p))              return 'Bills & Utilities';
  if (/insurance/.test(p))                              return 'Insurance';
  if (/transfer/.test(p))                               return 'Transfer';
  if (/service charge|bank fee/.test(p))                return 'Bank Fees';
  if (amount > 0)                                       return 'Income';
  return 'Uncategorized';
}

module.exports = { parse };
