/**
 * UNFCU (United Nations Federal Credit Union) Statement Parser
 *
 * UNFCU statements contain multiple account sections in one PDF:
 *   • Membership Share  → savings
 *   • Savings Account   → savings
 *   • Checking Account  → chequing
 *
 * Returns an ARRAY of parsed account objects so the renderer can create
 * a separate import queue item per account.
 *
 * Transaction layout has two variants:
 *   A) Inline  — date + description + amounts on one line
 *        12/03/2025 Deposit Digital Transfer from T Eytle $200.00 $202.73
 *   B) Prefix  — description on line BEFORE the date + amounts line
 *        ATM Withdrawal 15000.00 JMD * BNS LIGUANEA BRANCH
 *        12/04/2025 $98.81 $103.92
 *
 * Sign is determined from the running balance change (no separate debit/credit
 * column parsing needed).
 */

'use strict';

const { normalizeDate } = require('./utils');

// ── Account section headers ───────────────────────────────────────────────────
const SECTION_RE = /(Membership Share|Savings Account|Checking Account)\s*-\s*(\d{8,})/g;

// Lines that anchor a transaction (start with MM/DD/YYYY)
const DATE_LINE_RE = /^(\d{2}\/\d{2}\/\d{4})\s*(.*)/;

// Convert UNFCU's MM/DD/YYYY to ISO YYYY-MM-DD (normalizeDate would treat it as DD/MM/YYYY)
function parseMDY(str) {
  const m = str.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : '';
}

// Dollar amounts embedded in text
const AMOUNT_RE = /\$([\d,]+\.\d{2})/g;

// Lines to skip entirely
const SKIP_RE = /^(Post\s*Date|Account\s+Activity|Account\s+Summary|Dividend\s+Summary|Statement\s+Ending|KAIEL|Member\s+Number|CBC[0-9A-F]{30,}|Page\s+\d|Managing\s+Your|RETURN\s+SERVICE|Court\s+Square|Long\s+Island|Corporate|Headquarters|Phone\s+Number|Email\s+Address|Online\s+Access|Summary\s+of\s+Accounts|Account\s+Type|Membership\s+Share|Savings\s+Account|Checking\s+Account|Total\s+Current|SIGN\s+OWN|Annual\s+Percentage|Dividend\s+Days|Dividend\s+Earned|Dividend\s+Paid|No\s+activity|Date\s+Description)/i;

// ── Main entry point ──────────────────────────────────────────────────────────

function parse(text) {
  // 1. Find every account-section header and its position in the text
  const headers = [];
  let m;
  SECTION_RE.lastIndex = 0;
  while ((m = SECTION_RE.exec(text)) !== null) {
    headers.push({ type: m[1], number: m[2], index: m.index });
  }

  if (!headers.length) return [];

  // 2. Slice text into per-account chunks, merging continuations of the same account
  const accountChunks = {}; // keyed by account number
  for (let i = 0; i < headers.length; i++) {
    const { type, number, index } = headers[i];
    const end = i + 1 < headers.length ? headers[i + 1].index : text.length;
    const chunk = text.slice(index, end);

    if (accountChunks[number]) {
      accountChunks[number].chunks.push(chunk);      // type & number already set
    } else {
      accountChunks[number] = { type, number, chunks: [chunk] };
    }
  }

  // 3. Parse each account
  const results = [];
  for (const acct of Object.values(accountChunks)) {
    const merged = acct.chunks.join('\n');
    results.push(parseAccountSection(acct.type, acct.number, merged));
  }

  return results;
}

// ── Per-account section parser ────────────────────────────────────────────────

function parseAccountSection(typeLabel, accountNumber, text) {
  const accountNumberLast4 = accountNumber.slice(-4);

  let accountType = 'savings';
  if (typeLabel === 'Checking Account') accountType = 'chequing';

  // Extract statement period from header
  const stmtPeriod = text.match(/Statement\s+Ending\s+(\d{2}\/\d{2}\/\d{4})/i);
  const endDate    = stmtPeriod ? parseMDY(stmtPeriod[1]) : '';

  // ── Find the first "Account Activity" and parse all lines from there ─────
  // Multi-page continuations are handled naturally: "Account Activity (continued)"
  // headers are skipped by SKIP_RE; all transaction lines flow through in order.
  const actStart = text.search(/Account Activity/i);
  if (actStart === -1) {
    return buildResult(typeLabel, accountNumberLast4, accountType, [], endDate);
  }

  const transactions = [];
  const lines = text.slice(actStart).split('\n').map(l => l.trim()).filter(Boolean);
  parseActivityLines(lines, transactions);

  return buildResult(typeLabel, accountNumberLast4, accountType, transactions, endDate);
}

// ── Transaction line state machine ────────────────────────────────────────────

function parseActivityLines(lines, transactions) {
  let pendingDesc = '';   // description prefix from the line BEFORE the date
  let prevBalance = null; // running balance for sign determination

  for (const line of lines) {
    // Always skip header / footer / metadata lines
    if (SKIP_RE.test(line)) { pendingDesc = ''; continue; }

    const dateMatch = line.match(DATE_LINE_RE);

    if (dateMatch) {
      const dateStr  = dateMatch[1];            // MM/DD/YYYY
      const rest     = dateMatch[2].trim();     // everything after the date

      // Skip sentinel lines
      if (/^(Beginning\s+Balance|Ending\s+Balance)/i.test(rest)) {
        // Capture the balance for sign tracking
        const balAmts = extractAmounts(rest);
        if (balAmts.length) prevBalance = balAmts[balAmts.length - 1];
        pendingDesc = '';
        continue;
      }

      const amounts = extractAmounts(rest);
      if (amounts.length < 2) { pendingDesc = ''; continue; } // need tx + balance

      const txAmountRaw = amounts[0];
      const balance     = amounts[amounts.length - 1];

      // Sign: LunchMoney convention — positive = expense/debit, negative = income/credit.
      // Balance going UP means money was deposited (credit → negative amount).
      // Balance going DOWN means money was withdrawn (debit → positive amount).
      let sign = 1;
      if (prevBalance !== null) {
        sign = balance > prevBalance - 0.001 ? -1 : 1;
      } else {
        // First real transaction — derive from keywords or assume debit
        sign = /withdrawal|debit|fee|fx international/i.test(pendingDesc + rest) ? 1 : -1;
      }
      prevBalance = balance;

      // Description: prefer inline text (everything before first $), fallback to pending prefix
      const inlineDesc = rest.replace(/\s*\$[\d,]+\.\d{2}.*/g, '').trim();
      const fullDesc   = (inlineDesc || pendingDesc).trim() || 'UNFCU Transaction';

      const amount = sign * txAmountRaw;
      const date   = parseMDY(dateStr);
      if (!date) { pendingDesc = ''; continue; }

      transactions.push({
        date,
        payee:    cleanPayee(fullDesc),
        amount,
        currency: 'USD',
        notes:    '',
        category: categorize(fullDesc, amount),
        type:     amount < 0 ? 'credit' : 'debit',
      });

      pendingDesc = ''; // reset after consuming

    } else {
      // No date — could be a description prefix for the next date line
      // or a continuation of the last transaction.
      // Keep only if it looks like a transaction description (not a $ amounts line)
      if (!extractAmounts(line).length && line.length > 3) {
        pendingDesc = line;
      } else {
        pendingDesc = '';
      }
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractAmounts(str) {
  const amounts = [];
  let m;
  AMOUNT_RE.lastIndex = 0;
  while ((m = AMOUNT_RE.exec(str)) !== null) {
    amounts.push(parseFloat(m[1].replace(/,/g, '')));
  }
  return amounts;
}

function cleanPayee(str) {
  return str.replace(/\s+/g, ' ')
            .replace(/[^a-zA-Z0-9 &\-\/\(\)\.,*']/g, '')
            .trim()
            .substring(0, 100);
}

function categorize(desc, amount) {
  const d = desc.toLowerCase();
  if (/salary|payroll|direct deposit|wire deposit/.test(d))      return 'Income';
  if (/atm withdrawal|cash withdrawal/.test(d))                  return 'Cash & ATM';
  if (/hi-lo|megamart|pricesmart|supermarket|grocery|shoprite|super valu/.test(d)) return 'Groceries';
  if (/restaurant|kfc|burger|pizza|cafe|starbucks|domino|shawarma|food|bk-nmi/.test(d)) return 'Food & Dining';
  if (/gas|fuel|petro|total gas|total- mona|total station|steve.s service/.test(d))  return 'Auto & Transport';
  if (/apple\.com|microsoft|amazon|paypal|steam|nvidia|caribtix|ebooking|eb \*/.test(d)) return 'Software & Subscriptions';
  if (/airbnb|hotel|flight|airline|travel/.test(d))              return 'Travel';
  if (/insurance/.test(d))                                       return 'Insurance';
  if (/digital transfer|wire transfer|itb|third party/.test(d))  return 'Transfer';
  if (/fx international fee/.test(d))                            return 'Bank Fees';
  if (/interest|dividend/.test(d))                               return amount < 0 ? 'Income' : 'Bank Fees';
  if (amount < 0)                                                return 'Income';
  return 'Uncategorized';
}

function buildResult(typeLabel, accountNumberLast4, accountType, transactions, endDate) {
  const txDates = transactions.map(t => t.date).filter(Boolean).sort();
  const period  = txDates.length
    ? { start: txDates[0], end: txDates[txDates.length - 1] }
    : { start: endDate ? endDate.slice(0, 7) + '-01' : '', end: endDate || '' };

  return {
    institution:   'UNFCU',
    accountType,
    accountName:   `UNFCU ${typeLabel} ···${accountNumberLast4}`,
    accountNumber: accountNumberLast4,
    currency:      'USD',
    period,
    transactions,
  };
}

module.exports = { parse };
