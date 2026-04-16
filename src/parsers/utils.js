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

module.exports = { normalizeDate, derivePeriodFromTransactions, applySignConvention };
