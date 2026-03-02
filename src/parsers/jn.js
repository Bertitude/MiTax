/**
 * JN Bank Jamaica Statement Parser
 *
 * Handles: "Savings Transactions Statement" (JNLive e-statements)
 *
 * Detected by: RSV-XXXXXXXXXXXX account number format unique to JN Bank savings.
 *
 * Table column layout (PDF user units, verified with pdfplumber):
 *   Transaction Date (x < 90)   | Transaction Type (90–182)
 *   Description (183–394)       | Debit (395–464) | Credit (465–514) | Balance (x ≥ 515)
 *
 * Date format  : "Jan 01, 2023" — three text tokens in the date column
 * Amount format: plain "1,106.26" (no currency symbol)
 *
 * Special rows to skip:
 *   - "Opening Balance" — starting balance entry, not a real transaction
 *   - "Closing Balance" — ending balance entry, not a real transaction
 */

'use strict';

const pdfParse = require('pdf-parse');
const fs       = require('fs');
const { derivePeriodFromTransactions } = require('./utils');

// Column boundaries (PDF user units, x from left edge)
const JN_DATE_MAX    = 90;   // date tokens  : x < 90
const JN_TYPE_MIN    = 90;   // tx type      : 90 ≤ x < 183
const JN_TYPE_MAX    = 183;
const JN_DESC_MIN    = 183;  // description  : 183 ≤ x < 395
const JN_DESC_MAX    = 395;
const JN_AMT_MIN     = 395;  // debit amount : 395 ≤ x < 465
const JN_CREDIT_MIN  = 465;  // credit amount: 465 ≤ x < 515
const JN_BAL_MIN     = 515;  // balance      : x ≥ 515  (ignored)

// Matches plain amounts: "1,106.26" or "150,000.00"
const AMT_PAT  = /^[\d,]+\.\d{2}$/;

// 3-letter month abbreviation — used to identify the start of a date row
const MONTH_PAT = /^[A-Za-z]{3}$/;

const MONTHS = {
  jan:1, feb:2, mar:3, apr:4, may:5, jun:6,
  jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
};

// Transaction type tokens that indicate a non-transaction balance row
const SKIP_TYPES = /^\s*(opening|closing)\s+balance\s*$/i;

// ── Main entry point ──────────────────────────────────────────────────────────

async function parse(text, filePath) {
  if (filePath) {
    try {
      const result = await extractWithCoords(filePath, text);
      if (result) return result;
    } catch (e) {
      console.warn('[JN Bank] Coordinate extraction failed:', e.message);
    }
  }
  // Minimal fallback — return empty result so the UI doesn't silently error
  return {
    institution:  'JN Bank',
    accountType:  'savings',
    accountName:  'JN Bank Account',
    accountNumber: '',
    currency:     'JMD',
    period:       { start: '', end: '' },
    transactions: [],
  };
}

// ── Coordinate-aware extraction ───────────────────────────────────────────────

async function extractWithCoords(filePath, fullText) {
  const buffer       = fs.readFileSync(filePath);
  const allPageItems = [];

  await pdfParse(buffer, {
    pagerender: async function (pageData) {
      const content = await pageData.getTextContent();
      const items = content.items
        .filter(item => item.str && item.str.trim())
        .map(item => ({
          str: item.str.trim(),
          x:   item.transform[4],
          y:   item.transform[5],
        }));
      allPageItems.push(items);
      return content.items.map(i => i.str).join(' ');
    },
  });

  // ── Metadata ─────────────────────────────────────────────────────────────
  // Account number: RSV-002094352472 → use last 4 digits for display
  const accM = fullText.match(/RSV-(\d{9,16})/i);
  const accountNumber = accM ? accM[1].slice(-4) : '';
  const fullAccNum    = accM ? `RSV-${accM[1]}` : '';

  const currency = /\bJMD\b|Jamaica\s+Dollar/i.test(fullText) ? 'JMD' : 'JMD';

  // Statement period: "Jan 01, 2023 - Jan 31, 2023"
  const periodM = fullText.match(
    /([A-Za-z]{3}\s+\d{1,2},\s+\d{4})\s*[-–]\s*([A-Za-z]{3}\s+\d{1,2},\s+\d{4})/
  );
  const headerPeriodStart = periodM ? parseMDY(periodM[1]) : null;
  const headerPeriodEnd   = periodM ? parseMDY(periodM[2]) : null;

  // ── Per-page transaction extraction ──────────────────────────────────────
  const transactions = [];

  for (const pageItems of allPageItems) {
    if (!pageItems.length) continue;

    // Group items into rows by y-position (3 pt bucket)
    const rowMap = new Map();
    for (const item of pageItems) {
      const yKey = Math.round(item.y / 3) * 3;
      if (!rowMap.has(yKey)) rowMap.set(yKey, []);
      rowMap.get(yKey).push(item);
    }

    // Sort rows top-to-bottom (in PDF coords y increases upward → sort descending)
    const sortedYKeys = Array.from(rowMap.keys()).sort((a, b) => b - a);

    for (const yKey of sortedYKeys) {
      const row = rowMap.get(yKey).sort((a, b) => a.x - b.x);

      // Date column: tokens at x < 90 that begin with a month abbreviation
      const dateTokens = row.filter(w => w.x < JN_DATE_MAX);
      if (!dateTokens.length || !MONTH_PAT.test(dateTokens[0].str)) continue;

      // Reconstruct and parse "Jan 01, 2023"
      const dateStr = dateTokens.map(w => w.str).join(' ');
      const date    = parseMDY(dateStr);
      if (!date) continue;

      // Transaction type tokens (90–182)
      const typeItems = row.filter(w => w.x >= JN_TYPE_MIN && w.x < JN_TYPE_MAX);
      const typeStr   = typeItems.map(w => w.str).join(' ').trim();

      // Skip opening/closing balance rows — not real transactions
      if (SKIP_TYPES.test(typeStr)) continue;

      // Description tokens (183–394)
      const descItems = row.filter(w => w.x >= JN_DESC_MIN && w.x < JN_DESC_MAX);
      const descStr   = descItems.map(w => w.str).join(' ').trim();

      // Amount tokens — split into debit / credit / balance zones
      const debitItems  = row.filter(w => w.x >= JN_AMT_MIN  && w.x < JN_CREDIT_MIN && AMT_PAT.test(w.str));
      const creditItems = row.filter(w => w.x >= JN_CREDIT_MIN && w.x < JN_BAL_MIN  && AMT_PAT.test(w.str));
      // Balance column amounts are intentionally ignored

      const debitVal  = debitItems.length  ? parseFloat(debitItems[0].str.replace(/,/g, ''))  : 0;
      const creditVal = creditItems.length ? parseFloat(creditItems[0].str.replace(/,/g, '')) : 0;

      if (debitVal === 0 && creditVal === 0) continue; // no amount found, skip

      // In LunchMoney convention: positive = expense/debit, negative = income/credit
      const amount = debitVal > 0 ? debitVal : -creditVal;

      const payee = buildPayee(typeStr, descStr);

      transactions.push({
        date,
        payee,
        amount,
        currency,
        notes:    descStr || '',
        category: categorize(payee, amount),
        type:     amount < 0 ? 'credit' : 'debit',
      });
    }
  }

  // ── Period ────────────────────────────────────────────────────────────────
  const txDates = transactions.map(t => t.date).filter(Boolean).sort();
  const period  = txDates.length
    ? { start: txDates[0], end: txDates[txDates.length - 1] }
    : headerPeriodStart
      ? { start: headerPeriodStart, end: headerPeriodEnd || headerPeriodStart }
      : { start: '', end: '' };

  return {
    institution:  'JN Bank',
    accountType:  'savings',
    accountName:  fullAccNum || 'JN Bank Account',
    accountNumber,
    currency,
    period,
    transactions,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Parse "Jan 01, 2023" or "Jan 1, 2023" → "2023-01-01" */
function parseMDY(str) {
  const m = str.trim().match(/([A-Za-z]{3})\s+(\d{1,2}),?\s+(\d{4})/);
  if (!m) return null;
  const mo = MONTHS[m[1].toLowerCase()];
  if (!mo) return null;
  return `${m[3]}-${String(mo).padStart(2, '0')}-${String(parseInt(m[2], 10)).padStart(2, '0')}`;
}

/** Combine transaction type and description into a payee string. */
function buildPayee(type, desc) {
  const parts = [type, desc].filter(Boolean);
  const raw   = parts.join(' — ').trim();
  return raw
    .replace(/\s+/g, ' ')
    .replace(/[^a-zA-Z0-9 &\-\/\(\)\.,'*]/g, '')
    .trim()
    .substring(0, 100) || 'JN Bank Transaction';
}

function categorize(payee, amount) {
  const p = payee.toLowerCase();
  if (/salary|payroll|direct\s+credit|standing\s+order/.test(p)) return 'Income';
  if (/atm|cash\s+withdrawal|withdrawal/.test(p))                 return 'Cash & ATM';
  if (/transfer/.test(p))                                         return 'Transfer';
  if (/deposit/.test(p))                                          return amount < 0 ? 'Income' : 'Uncategorized';
  if (/interest/.test(p))                                         return amount < 0 ? 'Income' : 'Bank Fees';
  if (/fee|charge|service/.test(p))                               return 'Bank Fees';
  if (/debit\s+card|pos\s+purchase|purchase/.test(p))             return 'Uncategorized';
  if (amount < 0)                                                  return 'Income';
  return 'Uncategorized';
}

module.exports = { parse };
