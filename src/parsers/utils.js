/**
 * Shared parser utilities — kept in a separate file to avoid
 * circular dependencies between index.js and the individual parsers.
 */

/**
 * Normalize a date string to YYYY-MM-DD
 */
function normalizeDate(str) {
  if (!str) return '';
  str = str.trim();

  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.substring(0, 10);

  // DD/MM/YYYY or DD-MM-YYYY
  const dmy = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;

  // MM/DD/YYYY
  const mdy = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;

  // "Jan 01, 2024" or "01 Jan 2024"
  const months = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
  const mdy2 = str.match(/^([A-Za-z]{3})\s+(\d{1,2}),?\s+(\d{4})/);
  if (mdy2) {
    const m = months[mdy2[1].toLowerCase()];
    return m ? `${mdy2[3]}-${String(m).padStart(2,'0')}-${mdy2[2].padStart(2,'0')}` : str;
  }
  const dmy2 = str.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
  if (dmy2) {
    const m = months[dmy2[2].toLowerCase()];
    return m ? `${dmy2[3]}-${String(m).padStart(2,'0')}-${dmy2[1].padStart(2,'0')}` : str;
  }

  return str;
}

/**
 * Derive a period object from an array of transactions
 */
function derivePeriodFromTransactions(transactions) {
  if (!transactions.length) return { start: null, end: null, year: null, month: null };
  const dates = transactions.map(t => t.date).filter(Boolean).sort();
  const start = dates[0];
  const end = dates[dates.length - 1];
  const year  = start ? parseInt(start.split('-')[0]) : null;
  const month = start ? parseInt(start.split('-')[1]) : null;
  return { start, end, year, month };
}

/**
 * Negate the sign on every transaction's amount so that the final output
 * uses the user-facing convention:
 *
 *   amount < 0  →  debit  (money out / expense / withdrawal)
 *   amount > 0  →  credit (money in / income / deposit)
 *
 * Parsers internally compute amounts with the inverse convention (positive =
 * debit) because that's how balance-delta math and column parsing naturally
 * work. This post-processing step flips the sign once, at the boundary,
 * so every downstream consumer (LunchMoney upload, tax calcs, UI) sees the
 * user-facing convention.
 */
function applySignConvention(transactions) {
  for (const tx of transactions) {
    if (tx.amount != null) {
      tx.amount = -tx.amount;
      tx.type = tx.amount > 0 ? 'credit' : 'debit';
    }
  }
  return transactions;
}

/**
 * Parse a US-style MM/DD/YYYY date to YYYY-MM-DD. Returns '' if it doesn't
 * match. Use this (not normalizeDate) for sources known to be month-first —
 * normalizeDate matches the DD/MM branch first and would swap month and day.
 */
function parseMDY(str) {
  if (!str) return '';
  const m = String(str).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return '';
  const month = parseInt(m[1], 10), day = parseInt(m[2], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  return `${m[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Internal sign (positive = debit / money out) for a transaction of magnitude
 * `amount`, inferred from the running-balance delta. A falling balance means
 * money left the account (debit → positive); a rising balance means money came
 * in (credit → negative). Used by parsers whose rows carry a running balance
 * but don't label debit vs credit. `prevBalance == null` (first row, unknown
 * opening balance) returns null so the caller can fall back to a keyword guess.
 */
function signedByBalanceDelta(amount, prevBalance, thisBalance) {
  if (prevBalance == null || thisBalance == null) return null;
  const mag = Math.abs(amount);
  return thisBalance < prevBalance ? mag : -mag;
}

/**
 * Resolve a statement row's transaction amount (INTERNAL convention:
 * positive = debit / money out) from the bare numbers on the row.
 *
 * `numbers` are the row's monetary values in print order; the running balance
 * is conventionally the last. Resolution order:
 *
 *   1. Balance delta, when a previous balance is known AND the delta's
 *      magnitude matches one of the row's printed non-balance numbers —
 *      the most reliable signal, immune to blank-column ambiguity.
 *   2. Column interpretation for full rows (≥3 numbers = debit, credit,
 *      balance): whichever of the first two is non-zero wins.
 *   3. First number signed by the caller's keyword guess (`looksCredit`).
 *
 * Returns { amount, balance } — amount null when the row carries no usable
 * transaction value (e.g. a 0.00/0.00 column row); callers should surface
 * such rows in a warning rather than dropping them silently.
 */
function resolveRowAmount(numbers, prevBalance, looksCredit) {
  if (!numbers || !numbers.length) return { amount: null, balance: null };

  const balance = numbers.length >= 2 ? numbers[numbers.length - 1] : null;
  const cents   = (v) => Math.round(v * 100);

  // 1. Balance delta, validated against the printed amounts
  if (balance != null && prevBalance != null) {
    const deltaCents = cents(balance) - cents(prevBalance);   // user conv: credit positive
    if (deltaCents !== 0 &&
        numbers.slice(0, -1).some(n => cents(n) === Math.abs(deltaCents))) {
      return { amount: -deltaCents / 100, balance };          // internal: debit positive
    }
  }

  // 2. Full debit/credit/balance rows
  if (numbers.length >= 3) {
    const debit = numbers[0], credit = numbers[1];
    if (debit  !== 0) return { amount: debit,   balance };
    if (credit !== 0) return { amount: -credit, balance };
    return { amount: null, balance };
  }

  // 3. Amount(+balance) with no usable delta — keyword guess
  const first = numbers[0];
  if (first === 0) return { amount: null, balance };
  return { amount: looksCredit ? -Math.abs(first) : Math.abs(first), balance };
}

module.exports = { normalizeDate, parseMDY, derivePeriodFromTransactions, applySignConvention, signedByBalanceDelta, resolveRowAmount };
