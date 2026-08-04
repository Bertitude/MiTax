/**
 * JN Bank Jamaica Statement Parser
 *
 * Handles: "Savings Transactions Statement" (JNLive e-statements)
 *
 * Detected by: RSV-XXXXXXXXXXXX account number format unique to JN Bank savings.
 *
 * Table column layout (PDF user units):
 *   Transaction Date (x < 90)   | Transaction Type (90–182)
 *   Description (183–359)       | Debit | Credit | Balance
 *
 * The three money columns are RIGHT-aligned, so they are identified by each
 * token's right edge (x + w), not its left edge — see amountColumn().
 *
 * Date format  : "Jan 01, 2023", emitted as ONE text item by pdfjs (earlier
 *                column measurements were taken with pdfplumber, whose
 *                word-level segmentation splits it into three tokens — both
 *                shapes are accepted here).
 * Amount format: plain "1,106.26" (no currency symbol)
 *
 * A long transaction type wraps onto a second line ("Automatic Payment" /
 * "Withdrawal"); the continuation line is folded back into the row above it.
 *
 * Special rows to skip:
 *   - "Opening Balance" — starting balance entry, not a real transaction
 *   - "Closing Balance" — ending balance entry, not a real transaction
 */

'use strict';

const fs       = require('fs');
const { extractPageItems } = require('../pdf/extract');
const { derivePeriodFromTransactions, applySignConvention } = require('./utils');

// Text column boundaries (PDF user units, x = LEFT edge). These columns are
// left-aligned, so a left-edge test is the right one for them.
const JN_DATE_MAX    = 90;   // date tokens  : x < 90
const JN_TYPE_MIN    = 90;   // tx type      : 90 ≤ x < 183
const JN_TYPE_MAX    = 183;
const JN_DESC_MIN    = 183;  // description  : 183 ≤ x < 360
const JN_DESC_MAX    = 360;

// Money column boundaries (PDF user units, RIGHT edge = x + w).
//
// The debit/credit/balance columns are right-aligned, so only the right edge is
// stable: measured on real statements it sits at ~420.5 / ~496.5 / ~570.0
// regardless of magnitude, while the left edge slides left as the number grows
// ("17.77" starts at x=398, "417,600.00" at x=375, both in the debit column).
// Splitting at the midpoints leaves ~35pt of slack on either side of every
// column. A left-edge split cannot: the smallest gap between a credit's left
// edge and the debit column is ~4pt, so a 7-figure credit (left edge x≈444)
// sits a hair from being read as a debit — i.e. a deposit booked as a
// withdrawal.
//
// These are only the fallback: the column headers are themselves right-aligned
// with their columns, so moneyColumnsFromHeader() re-derives the boundaries
// from each page and a layout shift carries the parser with it.
const JN_MONEY_COLS = {
  minRight:  380,   // right edge < 380  → not a money column
  debitMax:  458,   // 380 ≤ right < 458 → debit
  creditMax: 533,   // 458 ≤ right < 533 → credit
};                  //       right ≥ 533 → balance (ignored)

// Left-edge fallback, used only for coordinate items that carry no width (e.g.
// synthetic fixtures built before `w` was captured).
const JN_AMT_MIN     = 360;  // debit amount : 360 ≤ x < 440
const JN_CREDIT_MIN  = 440;  // credit amount: 440 ≤ x < 510
const JN_BAL_MIN     = 510;  // balance      : x ≥ 510  (ignored)

// Matches plain amounts: "1,106.26" or "150,000.00"
const AMT_PAT  = /^[\d,]+\.\d{2}$/;

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

async function readPageItems(filePath) {
  const buffer = fs.readFileSync(filePath);
  return extractPageItems(buffer);
}

async function extractWithCoords(filePath, fullText) {
  const allPageItems = await readPageItems(filePath);
  return parseFromPageItems(allPageItems, fullText);
}

/**
 * Pure JN Bank savings-statement parser. No I/O — unit-testable with synthetic
 * coordinate fixtures.
 */
function parseFromPageItems(allPageItems, fullText) {
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
  const warnings = [];
  const droppedRows = [];   // dated rows with amounts outside the expected columns
  let   balanceRows = 0;    // opening/closing balance rows seen

  for (const pageItems of allPageItems) {
    if (!pageItems.length) continue;

    const cols = moneyColumnsFromHeader(pageItems) || JN_MONEY_COLS;

    // Group items into rows by y-position (3 pt bucket)
    const rowMap = new Map();
    for (const item of pageItems) {
      const yKey = Math.round(item.y / 3) * 3;
      if (!rowMap.has(yKey)) rowMap.set(yKey, []);
      rowMap.get(yKey).push(item);
    }

    // Sort rows top-to-bottom (in PDF coords y increases upward → sort descending)
    const sortedYKeys = Array.from(rowMap.keys()).sort((a, b) => b - a);

    // Text too long for its column wraps onto its own line — "Automatic
    // Payment" then "Withdrawal" ~11pt below it — which lands in a y bucket of
    // its own holding nothing but type/description text. Fold each such line
    // back into the row above, so the payee reads "Automatic Payment
    // Withdrawal" instead of a truncated "Automatic Payment".
    //
    // A continuation carries no date and no amount, and every token sits in the
    // type or description column; page furniture ("E&OE" at x=20, "Page 1 of 2"
    // at x=555) and the table header (which spans from x=20) all fail that.
    const rows = [];
    for (const yKey of sortedYKeys) {
      const items = rowMap.get(yKey);
      const isContinuation = rows.length && items.every(w =>
        w.x >= JN_TYPE_MIN && w.x < JN_DESC_MAX && !AMT_PAT.test(w.str));
      if (isContinuation) rows[rows.length - 1].push(...items);
      else rows.push(items);
    }

    for (const rowItems of rows) {
      // Reading order: top line first, then left-to-right within each line.
      const row = rowItems.slice().sort((a, b) => (b.y - a.y) || (a.x - b.x));

      // Date column: tokens at x < 90 forming a "Jan 01, 2023" date. pdfjs
      // emits the whole date as one item; pdfplumber-style word segmentation
      // splits it into three. Joining first handles both.
      const dateTokens = row.filter(w => w.x < JN_DATE_MAX);
      if (!dateTokens.length) continue;

      const dateStr = dateTokens.map(w => w.str).join(' ');
      const date    = parseMDY(dateStr);
      if (!date) continue;   // column header ("Transaction Date") and page furniture

      // Transaction type tokens (90–182)
      const typeItems = row.filter(w => w.x >= JN_TYPE_MIN && w.x < JN_TYPE_MAX);
      const typeStr   = typeItems.map(w => w.str).join(' ').trim();

      // Skip opening/closing balance rows — not real transactions. Their
      // presence is still recorded: it proves the transaction table was found
      // and read, which is what distinguishes a dormant statement period from
      // a statement we simply failed to parse.
      if (SKIP_TYPES.test(typeStr)) { balanceRows++; continue; }

      // Description tokens (183–394)
      const descItems = row.filter(w => w.x >= JN_DESC_MIN && w.x < JN_DESC_MAX);
      const descStr   = descItems.map(w => w.str).join(' ').trim();

      // Amount tokens — split into debit / credit / balance zones
      const amountItems = row.filter(w => AMT_PAT.test(w.str));
      const debitItems  = amountItems.filter(w => amountColumn(w, cols) === 'debit');
      const creditItems = amountItems.filter(w => amountColumn(w, cols) === 'credit');
      // Balance column amounts are intentionally ignored

      const debitVal  = debitItems.length  ? parseFloat(debitItems[0].str.replace(/,/g, ''))  : 0;
      const creditVal = creditItems.length ? parseFloat(creditItems[0].str.replace(/,/g, '')) : 0;

      if (debitVal === 0 && creditVal === 0) {
        // The column boundaries are hardcoded coordinates; if a layout variant
        // shifts a money column, its amounts land outside the expected zones
        // and the row would vanish. Surface it instead: does this dated row
        // carry an amount-looking token that fell into no column at all?
        if (amountItems.some(w => amountColumn(w, cols) === null)) {
          droppedRows.push(`${date} ${typeStr || descStr || '(no description)'}`.trim());
        }
        continue; // no usable amount — skip (with warning above if suspicious)
      }

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

  if (droppedRows.length) {
    warnings.push(
      `${droppedRows.length} transaction row(s) were SKIPPED because their amounts sat outside the ` +
      `expected debit/credit columns: ${droppedRows.slice(0, 5).join('; ')}` +
      `${droppedRows.length > 5 ? ` + ${droppedRows.length - 5} more` : ''}. ` +
      `Deposits/credits may be missing from the import — please report this statement layout.`
    );
  }

  // A dormant month is a valid statement with nothing in it: JN still prints
  // the opening and closing balance rows, just no transactions between them.
  // Saying so beats the generic "unsupported or a scanned-image PDF" warning,
  // which blames a file that parsed perfectly.
  const emptyPeriod = transactions.length === 0 && balanceRows > 0 && droppedRows.length === 0;
  if (emptyPeriod) {
    const span = period.start && period.end ? ` (${period.start} to ${period.end})` : '';
    warnings.push(`No transactions in this statement period${span} — the account had no activity. The statement was read successfully.`);
  }

  applySignConvention(transactions);
  return {
    institution:  'JN Bank',
    accountType:  'savings',
    accountName:  fullAccNum || 'JN Bank Account',
    accountNumber,
    currency,
    period,
    transactions,
    emptyPeriod,
    warnings,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Re-derive the money-column boundaries from a page's own table header.
 *
 * The "Debit"/"Credit"/"Balance" headings are right-aligned with the columns
 * they label — their right edges (420.5 / 496.5 / 570.0) sit within 0.2pt of
 * the amount right edges beneath them on every statement measured. Reading the
 * boundaries off the page therefore beats trusting the constants above, and
 * keeps the parser working if JN reflows the table.
 *
 * Returns null when the header isn't found, leaving the caller on JN_MONEY_COLS.
 */
function moneyColumnsFromHeader(pageItems) {
  // All three headings must share one row. The summary page also prints
  // "Debit" and "Credit" headings, but shifted a column right (496.6 / 570.1)
  // and with no "Balance" — requiring the full triplet rejects it, which
  // matters because adopting those offsets would shift every column by one.
  const byRow = new Map();
  for (const item of pageItems) {
    const yKey = Math.round(item.y / 3) * 3;
    if (!byRow.has(yKey)) byRow.set(yKey, []);
    byRow.get(yKey).push(item);
  }

  for (const items of byRow.values()) {
    const rightOf = (re) => {
      const hit = items.find(i => i.w > 0 && re.test(i.str));
      return hit ? hit.x + hit.w : null;
    };
    const debit   = rightOf(/^Debit$/i);
    const credit  = rightOf(/^Credit$/i);
    const balance = rightOf(/^Balance$/i);
    if (debit == null || credit == null || balance == null) continue;
    if (!(debit < credit && credit < balance)) continue;   // not the table header

    return {
      // Extend the debit column leftward by half its own width, so a debit
      // wider than any seen here still lands inside it.
      minRight:  debit - (credit - debit) / 2,
      debitMax:  (debit + credit) / 2,
      creditMax: (credit + balance) / 2,
    };
  }
  return null;
}

/**
 * Which money column an amount token sits in, or null if it sits in none.
 *
 * Prefers the right edge (stable for a right-aligned column); falls back to the
 * left-edge zones for items carrying no width.
 */
function amountColumn(item, cols) {
  if (item.w > 0) {
    const right = item.x + item.w;
    if (right < cols.minRight)  return null;
    if (right < cols.debitMax)  return 'debit';
    if (right < cols.creditMax) return 'credit';
    return 'balance';
  }
  if (item.x >= JN_BAL_MIN)                                 return 'balance';
  if (item.x >= JN_CREDIT_MIN)                              return 'credit';
  if (item.x >= JN_AMT_MIN)                                 return 'debit';
  return null;
}

/**
 * Parse "Jan 01, 2023", "Jan 1, 2023" or "January 1, 2023" → "2023-01-01".
 * Anchored at the start so non-date column text ("Transaction Date") is
 * rejected rather than having a date scavenged out of the middle of it.
 */
function parseMDY(str) {
  const m = String(str || '').trim().match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/);
  if (!m) return null;
  const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (!mo) return null;
  const day = parseInt(m[2], 10);
  if (day < 1 || day > 31) return null;
  return `${m[3]}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
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

module.exports = { parse, parseFromPageItems, moneyColumnsFromHeader };
