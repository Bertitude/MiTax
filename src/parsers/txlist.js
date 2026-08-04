/**
 * Transaction-List Parser — a FORMAT, not an institution.
 *
 * Handles the "transaction list" layout produced when an online-banking
 * activity view is printed or exported to PDF. These files frequently carry no
 * institution name at all (the bank's branding is a logo image, and the page
 * may even capture the web filter bar — "All Transaction Types / Clear /
 * Apply"), so auto-detection cannot route them. The user selects this format at
 * import and supplies the institution and account.
 *
 * Layout — each transaction spans TWO printed rows:
 *
 *   Jun 30 │ Card Payment Internet-****1222 │ -$50,000.00
 *   2021   │ Payment Received               │
 *   └date  └description                     └amount (right-aligned)
 *
 * The column x-offsets differ between exports (date at x=7 in one file, x=36 in
 * another), so they are NEVER hardcoded: they are derived per page from the
 * "Date / Description / Amount" header row. See columnsFromHeader().
 *
 * Sign convention (INTERNAL: positive = debit / money out; applySignConvention
 * flips once at the end):
 *   "$1,234.00"  Purchase/Other Charge → money out → positive
 *   "-$1,234.00" Payment Received      → money in  → negative
 * On a credit card that yields the user-facing convention the rest of the app
 * expects: a purchase is an expense, a payment to the card is a credit.
 *
 * OCR damage is expected and repaired ONLY where the repair is unambiguous —
 * these files come from scanned or re-rendered PDFs:
 *   "$26 , 133.37" → 26133.37   (stray spaces around the thousands comma)
 *   "$7 5 ,095.00" → 75095.00   (space inserted INSIDE the number)
 *   "Oct1 8"       → Oct 18     (space inserted inside the day)
 * Letter-for-digit substitution ("Mayos" for "May 05") is NOT attempted: it
 * would silently book a transaction to a guessed date. Such rows are dropped
 * and reported.
 *
 * Silent loss is the real risk here, so the parser checks its own work: every
 * transaction prints a type line, so the count of "Purchase/Other Charge" /
 * "Payment Received" lines is an independent ground truth. Any shortfall is
 * reported with the offending rows rather than passing unnoticed.
 */

'use strict';

const fs = require('fs');
const { extractPageItems } = require('../pdf/extract');
const { derivePeriodFromTransactions, applySignConvention } = require('./utils');

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// The per-transaction type line — also this format's built-in row count.
//
// ANCHORED to the whole description cell on purpose. A loose match would eat
// primary rows whose merchant happens to contain a type word: "Cash Advance Fee
// At Atm" is a real purchase description, and matching it as a type line both
// loses the transaction and inflates the expected-row count.
const TYPE_RE   = /^(?:Purchase\/Other Charge|Payment Received|Cash Advance|Interest Charge|Credit Adjustment)$/i;
const CREDIT_RE = /^(?:Payment Received|Credit Adjustment)$/i;

// Unanchored counterpart for sniffing a whole document (TYPE_RE is anchored to
// a single cell and so never matches a multi-line blob). Deliberately limited
// to the two phrases unique to this format — "Cash Advance" also occurs in
// ordinary merchant names.
const TYPE_SNIFF_RE = /Purchase\/Other Charge|Payment Received/i;

/** Normalize a description cell before matching it against TYPE_RE. */
const asTypeLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// Rows are grouped into 4pt y-buckets: the printed line spacing here is ~12pt,
// while OCR jitter between items on one line is under 3pt.
const ROW_BUCKET = 4;

// ── Entry point ───────────────────────────────────────────────────────────────

async function parse(text, filePath, opts = {}) {
  if (!filePath) {
    return emptyResult(opts, ['This format needs the original PDF to read column positions.']);
  }
  const pages = await extractPageItems(fs.readFileSync(filePath));
  return parseFromPageItems(pages, text, opts);
}

/**
 * True when `text` looks like this format. Used to offer the format
 * automatically rather than to auto-route — the user still confirms.
 */
function looksLikeTxList(text) {
  if (!text) return false;
  const hasHeader = /Date\W{0,4}\s*Description\s*\n?\s*Amount\s*\(/i.test(text)
                 || (/\bDescription\b/i.test(text) && /\bAmount\s*\(/i.test(text));
  return hasHeader && TYPE_SNIFF_RE.test(text);
}

// ── Column detection ──────────────────────────────────────────────────────────

/**
 * Derive column boundaries from a page's "Date | Description | Amount" header.
 *
 * Splitting midway between one heading's right edge and the next heading's left
 * edge puts the boundary in the visual gutter, which is where no content sits.
 * Returns null when the header isn't on this page, letting the caller reuse the
 * boundaries from an earlier page (continuation pages repeat the header, but a
 * damaged scan may lose it).
 */
function columnsFromHeader(pageItems) {
  const byRow = groupRows(pageItems, 3);
  for (const items of byRow) {
    // "Date" is often OCR-mangled with trailing punctuation ("Date..,.", "Date•").
    const date = items.find(i => /^Date\b|^Date\W*$/i.test(i.str));
    const desc = items.find(i => /^Description\W*$/i.test(i.str));
    const amt  = items.find(i => /^Amount\b/i.test(i.str));
    if (!date || !desc || !amt) continue;
    if (!(date.x < desc.x && desc.x < amt.x)) continue;

    return {
      descMin: (date.x + (date.w || 0) + desc.x) / 2,
      amtMin:  (desc.x + (desc.w || 0) + amt.x) / 2,
    };
  }
  return null;
}

/** Group items into rows by y, coarsest-first, each row sorted left-to-right. */
function groupRows(items, bucket) {
  const map = new Map();
  for (const it of items) {
    const key = Math.round(it.y / bucket) * bucket;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(it);
  }
  return [...map.keys()]
    .sort((a, b) => b - a)                       // PDF y grows upward → top first
    .map(k => map.get(k).sort((a, b) => a.x - b.x));
}

// ── OCR repair ────────────────────────────────────────────────────────────────

/**
 * Parse a money token, tolerating spaces OCR inserted inside the number.
 * Returns null unless the digits form exactly one well-formed amount, so a row
 * whose columns collided (two amounts joined) is rejected rather than guessed.
 */
function repairMoney(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!/\d/.test(s)) return null;
  // A minus anywhere before the first digit is the sign ("-$ 15,000.00").
  const negative = /^[^\d]*-/.test(s);
  const digits   = s.replace(/[^0-9.]/g, '');
  if (!/^\d{1,12}\.\d{2}$/.test(digits)) return null;
  const value = parseFloat(digits);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

/**
 * Parse a "Mon DD" date-column token, tolerating a space inside the day
 * ("Oct1 8" → Oct 18) and a missing space after the month ("Mar22").
 * Returns null on anything else — notably on letter-for-digit OCR damage
 * ("Mayos"), which is reported rather than guessed at.
 */
function repairMonthDay(raw) {
  const m = String(raw || '').trim().match(/^([A-Za-z]{3})[a-z]*\.?\s*([\d\s]{1,5})$/);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (!month) return null;
  const day = parseInt(m[2].replace(/\s+/g, ''), 10);
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  return { month, day };
}

// ── Core ──────────────────────────────────────────────────────────────────────

function parseFromPageItems(allPageItems, fullText, opts = {}) {
  const transactions = [];
  const unreadable   = [];       // rows carrying a type line we could not parse
  const warnings     = [];

  const currency = opts.currency
    || (String(fullText || '').match(/Amount\s*\(([A-Z]{3})\)/i) || [])[1]
    || 'JMD';

  let expectedRows = 0;          // type lines seen = transactions the file claims
  let cols = null;               // carried across pages: continuations repeat it

  for (const pageItems of allPageItems || []) {
    if (!pageItems || !pageItems.length) continue;
    cols = columnsFromHeader(pageItems) || cols;
    if (!cols) continue;         // header not seen yet — nothing to anchor on

    const rows = groupRows(pageItems, ROW_BUCKET);

    const inDate = (w) => w.x <  cols.descMin;
    const inDesc = (w) => w.x >= cols.descMin && w.x < cols.amtMin;
    const inAmt  = (w) => w.x >= cols.amtMin;
    const textIn = (row, pred, sep) => row.filter(pred).map(w => w.str).join(sep).trim();

    // Walk top-to-bottom pairing each PRIMARY row (day + amount) with the type
    // line printed beneath it. Every transaction prints a type line, so an
    // unpaired type line is a row we failed to read — recorded, never dropped.
    let pending = null;          // last primary row parsed but not yet paired

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      // ── A PRIMARY row carries the day and the amount ──
      // Tried FIRST: a row that parses as a transaction is never a type line,
      // whatever its merchant name happens to say.
      const md     = repairMonthDay(textIn(row, inDate, ' '));
      const amount = md ? repairMoney(textIn(row, inAmt, '')) : null;

      if (!md || amount === null) {
        // ── Otherwise: is this the type line closing the row above? ──
        const typeText = asTypeLine(textIn(row, inDesc, ' '));
        if (!TYPE_RE.test(typeText)) continue;

        expectedRows++;          // the file's own count of its transactions
        if (pending) {
          transactions.push(buildTx(pending, typeText, currency));
          pending = null;
        } else {
          // A type line with no readable row above it. Report whatever survived
          // of the preceding rows so the user can find it on the statement.
          unreadable.push(describeLostRow(rows, i, { inDate, inDesc, inAmt, textIn }));
        }
        continue;
      }

      // The year sits in the date column of one of the next couple of rows —
      // OCR sometimes splits it onto its own bucket, apart from the type line.
      let year = null;
      for (let j = i + 1; j < Math.min(i + 3, rows.length); j++) {
        const y = textIn(rows[j], inDate, '').replace(/\s+/g, '');
        if (/^\d{4}$/.test(y)) { year = y; break; }
      }
      if (!year) continue;       // undatable — the audit below will report it

      // Description items are joined WITHOUT separators: OCR fragments a single
      // word into pieces that already carry their own spacing ("Msft", "* E0200
      // g2 x60 ,", "Msbill", ". info"), so inserting more would double them up.
      pending = {
        date:  `${year}-${String(md.month).padStart(2, '0')}-${String(md.day).padStart(2, '0')}`,
        payee: textIn(row, inDesc, '').replace(/\s+/g, ' ').trim(),
        amount,
      };
    }
  }

  // ── Self-check ────────────────────────────────────────────────────────────
  // Every transaction prints a type line, so a shortfall means rows were lost
  // to OCR damage. Report them: a tax return built on a silently short import
  // is worse than one the user knows to top up by hand.
  if (unreadable.length) {
    warnings.push(
      `${unreadable.length} of ${expectedRows} transaction row(s) could NOT be read and were not imported — ` +
      `the PDF's text layer is damaged there (characters merged or substituted, e.g. a day printed as ` +
      `"Mayos"). Add them by hand from the statement: ` +
      `${unreadable.slice(0, 5).map(r => `"${r}"`).join('; ')}` +
      `${unreadable.length > 5 ? ` + ${unreadable.length - 5} more` : ''}.`
    );
  }

  applySignConvention(transactions);

  const period = derivePeriodFromTransactions(transactions);
  return {
    institution:   opts.institution || 'Statement',
    accountType:   opts.accountType || 'credit',
    accountName:   opts.accountName || opts.institution || 'Imported Statement',
    accountNumber: '',
    currency,
    period,
    transactions,
    // Structural read succeeded but the file holds nothing — distinct from a
    // failure to parse. See validateResult() in index.js.
    emptyPeriod:   transactions.length === 0 && expectedRows === 0 && !!cols,
    warnings,
    unreadable,
  };
}

/**
 * Describe an unpaired type line's transaction for the warning. The damaged
 * content may sit one or two rows up (a year-only row can intervene), so scan
 * back and pick the row that actually carries something identifying.
 */
function describeLostRow(rows, typeIdx, { inDate, inDesc, inAmt, textIn }) {
  for (let j = typeIdx - 1; j >= Math.max(0, typeIdx - 2); j--) {
    const parts = [
      textIn(rows[j], inDate, ' '),
      textIn(rows[j], inDesc, ''),
      textIn(rows[j], inAmt,  ''),
    ].filter(Boolean);
    // A bare year row ("2021") identifies nothing — keep looking.
    if (parts.length > 1 || (parts[0] && !/^\d{4}$/.test(parts[0]))) {
      return parts.join(' | ');
    }
  }
  return '(row illegible)';
}

/** Assemble a transaction from its primary row and the type line beneath it. */
function buildTx(pending, typeText, currency) {
  const isCredit = CREDIT_RE.test(typeText);
  return {
    date:     pending.date,
    payee:    pending.payee || 'Transaction',
    // INTERNAL convention (positive = debit / money out); applySignConvention
    // flips once at the end. A purchase leaves the account, a payment enters it.
    amount:   isCredit ? -Math.abs(pending.amount) : Math.abs(pending.amount),
    currency,
    notes:    typeText.replace(/\s+/g, ' ').trim(),
    category: 'Uncategorized',
    type:     isCredit ? 'credit' : 'debit',
  };
}

function emptyResult(opts, warnings) {
  return {
    institution:   opts.institution || 'Statement',
    accountType:   opts.accountType || 'credit',
    accountName:   opts.accountName || 'Imported Statement',
    accountNumber: '',
    currency:      opts.currency || 'JMD',
    period:        { start: '', end: '' },
    transactions:  [],
    warnings:      warnings || [],
  };
}

module.exports = {
  parse,
  parseFromPageItems,
  looksLikeTxList,
  columnsFromHeader,
  repairMoney,
  repairMonthDay,
};
