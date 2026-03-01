/**
 * Scotiabank Jamaica Statement Parser
 *
 * Uses pdf-parse's `pagerender` callback to obtain raw pdfjs page objects,
 * then extracts text items with their x/y coordinates. This gives accurate
 * column-aware parsing of Scotiabank's 3-column layout:
 *
 *   Date (x < 80)  |  Description (80 ≤ x < 390)  |  Amount (x ≥ 390)
 *
 * No external dependencies — pdfjs is already bundled inside pdf-parse.
 * Falls back to a regex parser for older / simpler statement layouts.
 */

'use strict';

const pdfParse = require('pdf-parse');
const fs       = require('fs');
const { normalizeDate, derivePeriodFromTransactions } = require('./utils');

// Month abbreviation → number
const MONTH_MAP = {
  JAN:1, FEB:2, MAR:3, APR:4, MAY:5,  JUN:6,
  JUL:7, AUG:8, SEP:9, OCT:10, NOV:11, DEC:12,
};

// Column x-boundaries in PDF user units (verified against pdfplumber)
const COL_DATE_MAX = 80;   // date token  :  x < 80
const COL_AMT_MIN  = 390;  // amount block : x ≥ 390
//                           description   : 80 ≤ x < 390

// Header / footer lines to skip when building multi-line descriptions
const SKIP_LINE = /^(Transaction|Description|Amount|Balance|CREDIT|DEBIT|Page\s+\d|of\s+\d|1-888|www\.|Transactions\s*\(|Your\s+ELEC|Account\s+Summary|\*Trademark)/i;

// ── Main entry point (async) ──────────────────────────────────────────────────

async function parse(text, filePath) {
  if (filePath) {
    try {
      const result = await extractWithCoords(filePath, text);
      if (result && result.transactions.length > 0) return result;
    } catch (e) {
      console.warn('[Scotiabank] Coordinate extraction failed:', e.message);
    }
  }
  console.warn('[Scotiabank] Falling back to regex parser');
  return regexParse(text);
}

// ── Coordinate-aware extraction using pdf-parse pagerender ────────────────────

async function extractWithCoords(filePath, fullText) {
  const buffer       = fs.readFileSync(filePath);
  const allPageItems = []; // one entry per page: array of { str, x, y }

  await pdfParse(buffer, {
    pagerender: async function (pageData) {
      const content = await pageData.getTextContent();
      const items = content.items
        .filter(item => item.str && item.str.trim())
        .map(item => ({
          str: item.str.trim(),
          x:   item.transform[4],  // horizontal offset from left
          y:   item.transform[5],  // vertical offset from BOTTOM of page
        }));
      allPageItems.push(items);
      // Return plain text so pdf-parse can still populate data.text
      return content.items.map(i => i.str).join(' ');
    },
  });

  // ── Metadata ─────────────────────────────────────────────────────────────
  const accM     = fullText.match(/Account\s+Number:\s*(\d+)/i);
  const rawAcc   = accM ? accM[1].replace(/\D/g, '') : '';
  const accountNumber = rawAcc.length >= 4 ? rawAcc.slice(-4) : rawAcc;
  const currency = /USD|US\$|United\s+States/i.test(fullText) ? 'USD' : 'JMD';

  // Statement period — e.g. "05DEC20  to  05JAN21"
  // Used to assign the correct year to each DDMMM date token
  const periodM    = fullText.match(/(\d{2}[A-Z]{3}\d{2})\s+to\s+(\d{2}[A-Z]{3}\d{2})/);
  const periodStart = periodM ? periodM[1] : '';
  const periodEnd   = periodM ? periodM[2] : '';

  let accountType = 'chequing';
  if (/savings/i.test(fullText))                              accountType = 'savings';
  if (/visa|credit\s+card|mastercard/i.test(fullText))        accountType = 'credit_card';
  if (/mortgage|loan/i.test(fullText))                        accountType = 'loan';

  // ── Per-page transaction extraction ──────────────────────────────────────
  const transactions = [];
  const datePat = /^\d{2}[A-Z]{3}$/;

  for (const pageItems of allPageItems) {
    if (!pageItems.length) continue;

    // Group items into rows by y-position (3 pt bucket)
    const rowMap = new Map();
    for (const item of pageItems) {
      const yKey = Math.round(item.y / 3) * 3;
      if (!rowMap.has(yKey)) rowMap.set(yKey, []);
      rowMap.get(yKey).push(item);
    }

    // Sort rows top-to-bottom: in PDF coords y increases upward,
    // so HIGHER y = nearer to top of page → sort DESCENDING.
    const sortedYKeys = Array.from(rowMap.keys()).sort((a, b) => b - a);

    let currentTx = null;

    for (const yKey of sortedYKeys) {
      const row    = rowMap.get(yKey).sort((a, b) => a.x - b.x);

      const dateItems   = row.filter(w => w.x < COL_DATE_MAX && datePat.test(w.str));
      const descItems   = row.filter(w => w.x >= COL_DATE_MAX && w.x < COL_AMT_MIN);
      const amountItems = row.filter(w => w.x >= COL_AMT_MIN);

      if (dateItems.length) {
        // Commit previous transaction
        if (currentTx && currentTx.amount !== null) {
          transactions.push(finaliseTx(currentTx, currency));
        }

        const ddmmm  = dateItems[0].str;
        const date   = parseDdmmm(ddmmm, periodStart, periodEnd);
        const desc   = descItems.map(w => w.str).join(' ').trim();
        const amount = parseAmount(amountItems);

        currentTx = { date, desc, amount, continuation: [] };

      } else if (currentTx) {
        // Continuation description line (no date)
        if (descItems.length) {
          const cont = descItems.map(w => w.str).join(' ').trim();
          if (cont && !SKIP_LINE.test(cont)) {
            currentTx.continuation.push(cont);
          }
        }
        // Amount might appear on a separate row
        if (amountItems.length && currentTx.amount === null) {
          currentTx.amount = parseAmount(amountItems);
        }
      }
    }

    // End of page — commit last transaction
    if (currentTx && currentTx.amount !== null) {
      transactions.push(finaliseTx(currentTx, currency));
    }
  }

  // Derive period from the actual transaction dates
  const txDates = transactions.map(t => t.date).filter(Boolean).sort();
  const period  = txDates.length
    ? { start: txDates[0], end: txDates[txDates.length - 1] }
    : { start: '', end: '' };

  return {
    institution:  'Scotiabank',
    accountType,
    accountName:  accountNumber ? `Scotiabank ...${accountNumber}` : 'Scotiabank Account',
    accountNumber,
    currency,
    period,
    transactions,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse a Scotiabank DDMMM token (e.g. "07DEC") into an ISO date string.
 * The year is derived from the statement period header so that statements
 * spanning December → January (or any other year boundary) are handled
 * correctly. e.g. period "05DEC20 to 05JAN21":
 *   "07DEC" → 2020-12-07
 *   "03JAN" → 2021-01-03
 */
function parseDdmmm(ddmmm, periodStart, periodEnd) {
  const dd  = parseInt(ddmmm.slice(0, 2), 10);
  const mmm = ddmmm.slice(2, 5).toUpperCase();
  const mo  = MONTH_MAP[mmm] || 1;

  let year = new Date().getFullYear(); // default to current year

  if (periodStart && periodEnd) {
    const startYr  = parseInt('20' + periodStart.slice(5, 7), 10);
    const endYr    = parseInt('20' + periodEnd.slice(5, 7), 10);

    if (startYr !== endYr) {
      // Statement spans a year boundary
      const startMo = MONTH_MAP[periodStart.slice(2, 5).toUpperCase()] || 1;
      year = (mo >= startMo) ? startYr : endYr;
    } else {
      year = startYr;
    }
  }

  return `${year}-${String(mo).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

/** Parse "J$ 4,025.00 -" or "J$ 300.00 +" from an array of word objects. */
function parseAmount(amountItems) {
  const text = amountItems.map(w => w.str).join(' ');
  const m    = text.match(/([\d,]+\.\d{2})\s*([-+])/);
  if (!m) return null;
  const val = parseFloat(m[1].replace(/,/g, ''));
  return m[2] === '+' ? val : -val;
}

function finaliseTx(tx, currency) {
  const parts = [tx.desc, ...tx.continuation].filter(Boolean);
  const payee = cleanPayee(parts.join(' ')) || 'Scotiabank Transaction';
  return {
    date:     tx.date,
    payee,
    amount:   tx.amount,
    currency,
    notes:    '',
    category: categorize(payee, tx.amount),
    type:     tx.amount < 0 ? 'debit' : 'credit',
  };
}

// ── Regex fallback (for older / simpler layouts) ──────────────────────────────

function regexParse(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  const accM      = text.match(/Account\s+(?:Number|No\.?|#):?\s*([0-9\-\s]+)/i);
  const rawAcc    = accM ? accM[1].replace(/\D/g, '') : '';
  const accountNumber = rawAcc.length >= 4 ? rawAcc.slice(-4) : rawAcc;
  const currency  = /USD|US\$|United\s+States/i.test(text) ? 'USD' : 'JMD';

  let accountType = 'chequing';
  if (/savings/i.test(text))                              accountType = 'savings';
  if (/visa|credit\s+card|mastercard/i.test(text))        accountType = 'credit_card';
  if (/mortgage|loan/i.test(text))                        accountType = 'loan';

  // Extract year from statement period header
  const periodM    = text.match(/(\d{2}[A-Z]{3}\d{2})\s+to\s+(\d{2}[A-Z]{3}\d{2})/);
  const periodStart = periodM ? periodM[1] : '';
  const periodEnd   = periodM ? periodM[2] : '';

  const transactions = [];

  // Pattern A: DD/MM/YYYY  date  + debit/credit columns
  const txPat = /(\d{2}[\/\-]\d{2}[\/\-]\d{4})\s+(.*?)\s+([\d,]+\.\d{2})?\s*([\d,]+\.\d{2})?\s*([\d,]+\.\d{2})/g;
  let m;
  while ((m = txPat.exec(text)) !== null) {
    const [, dateStr, desc, wStr, dStr] = m;
    const date = normalizeDate(dateStr);
    if (!date) continue;
    const withdrawal = wStr ? parseFloat(wStr.replace(/,/g, '')) : 0;
    const deposit    = dStr ? parseFloat(dStr.replace(/,/g, '')) : 0;
    if (!withdrawal && !deposit) continue;
    const amount = deposit > 0 ? deposit : -withdrawal;
    const payee  = cleanPayee(desc || 'Scotia Transaction');
    transactions.push({ date, payee, amount, currency, notes: '',
      category: categorize(payee, amount), type: amount < 0 ? 'debit' : 'credit' });
  }

  // Pattern B: DDMMM  J$ NNN.NN +/-  (Scotiabank specific, uses derived year)
  if (transactions.length === 0) {
    const datePat = /^(\d{2}[A-Z]{3})/;
    const amtPat  = /J\$\s*([\d,]+\.\d{2})\s*([-+])/;
    for (const line of lines) {
      const dm = line.match(datePat);
      const am = line.match(amtPat);
      if (!dm || !am) continue;
      const date   = parseDdmmm(dm[1], periodStart, periodEnd);
      const val    = parseFloat(am[1].replace(/,/g, ''));
      const amount = am[2] === '+' ? val : -val;
      const payee  = cleanPayee(line.replace(datePat, '').replace(amtPat, '').trim())
                     || 'Scotiabank Transaction';
      transactions.push({ date, payee, amount, currency, notes: '',
        category: categorize(payee, amount), type: amount < 0 ? 'debit' : 'credit' });
    }
  }

  const period = derivePeriodFromTransactions(transactions);
  return {
    institution:  'Scotiabank',
    accountType,
    accountName:  accountNumber ? `Scotiabank ...${accountNumber}` : 'Scotiabank Account',
    accountNumber,
    currency,
    period,
    transactions,
  };
}

// ── Shared utilities ──────────────────────────────────────────────────────────

function cleanPayee(str) {
  return str.replace(/\s+/g, ' ')
            .replace(/[^a-zA-Z0-9 &\-\/\(\)\.,'*]/g, '')
            .trim()
            .substring(0, 100);
}

function categorize(payee, amount) {
  const p = payee.toLowerCase();
  if (/salary|payroll|direct deposit/.test(p))                    return 'Income';
  if (/atm|abm withdrawal/.test(p))                               return 'Cash & ATM';
  if (/grocery|supermarket|hi-lo|megamart|pricesmart|shoprite/.test(p)) return 'Groceries';
  if (/restaurant|kfc|burger|pizza|cafe|hellofood|doordash/.test(p))    return 'Food & Dining';
  if (/\bgas\b|fuel|petro|texaco|shell|total station/.test(p))    return 'Auto & Transport';
  if (/\bnis\b|nht|\btax\b/.test(p))                              return 'Taxes';
  if (/gct|govt tax/.test(p))                                     return 'Taxes';
  if (/jps|nwc|flow|digicel|lime|c&w/.test(p))                    return 'Bills & Utilities';
  if (/insurance/.test(p))                                        return 'Insurance';
  if (/transfer|itb|third party/.test(p))                         return 'Transfer';
  if (/service charge|bank fee|record keeping/.test(p))           return 'Bank Fees';
  if (amount > 0)                                                  return 'Income';
  return 'Uncategorized';
}

module.exports = { parse };
