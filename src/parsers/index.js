/**
 * Statement parser dispatcher.
 * Detects the institution from the PDF text and routes to the correct parser.
 */

const { extractText } = require('../pdf/extract');
const fs = require('fs');
const path = require('path');

const { normalizeDate, derivePeriodFromTransactions } = require('./utils');

const ncbParser = require('./ncb');
const scotiabankParser = require('./scotiabank');
const jmmbParser = require('./jmmb');
const wiseParser = require('./wise');
const paypalParser = require('./paypal');
const stripeParser = require('./stripe');
const unfcuParser = require('./unfcu');
const jnParser = require('./jn');
const genericParser = require('./generic');
const txlistParser  = require('./txlist');

const INSTITUTION_PATTERNS = [
  // UNFCU must come before NCB: UNFCU statements contain ATM descriptions
  // like "NATIONAL COMMERCIAL BANKINGSTON 10 JM" which pdf-parse can reflow
  // into a single line that falsely triggers a loose NCB regex.
  { name: 'UNFCU',      regex: /unfcu\.org|united\s+nations\s+federal\s+credit\s+union|unfcu\.com/i, parser: unfcuParser },
  { name: 'JN Bank',    regex: /RSV-\d{9,16}/i,                                parser: jnParser },
  // Require "Jamaica" or "Limited" after "Bank" so ATM merchant strings
  // like "NATIONAL COMMERCIAL BANKINGSTON" don't match.
  { name: 'NCB',        regex: /national\s+commercial\s+bank\s+(jamaica|limited)|ncb\s+jamaica/i, parser: ncbParser },
  { name: 'Scotiabank', regex: /scotiabank|the\s+bank\s+of\s+nova\s+scotia/i,  parser: scotiabankParser },
  { name: 'JMMB',       regex: /jmmb\s+(bank|group|securities)|j\.m\.m\.b/i,   parser: jmmbParser },
  { name: 'Wise',       regex: /wise\s+(formerly\s+transferwise|payments)|transferwise/i, parser: wiseParser },
  { name: 'PayPal',     regex: /paypal\s+(transaction|activity|statement)/i,    parser: paypalParser },
  { name: 'Stripe',     regex: /stripe\s+(payout|balance|payments)/i,          parser: stripeParser },
];

/**
 * Detect file type (PDF, CSV)
 */
function detectFileType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.csv' ? 'csv' : 'pdf';
}

/**
 * Parse any supported statement file.
 * Returns { institution, accountType, accountName, currency, period, transactions }
 */
async function parseStatement(filePath, options = {}) {
  const fileType = detectFileType(filePath);

  if (fileType === 'csv') {
    return validateResult(parseCSV(filePath));
  }

  // PDF path
  const buffer = fs.readFileSync(filePath);
  const text = await extractText(buffer);

  // A caller-supplied format overrides auto-detection entirely. Statements
  // exported from an online-banking activity view often carry no institution
  // name at all (the branding is a logo image), so no regex can route them —
  // the user names the format, the institution and the account at import.
  if (options.format) {
    const fmt = FORMAT_PARSERS[options.format];
    if (!fmt) throw new Error(`Unknown statement format "${options.format}".`);
    console.log(`Forced format: ${options.format}`);
    const result = await Promise.resolve(fmt.parse(text, filePath, options));
    result.institution = options.institution || result.institution || 'Statement';
    result.rawText = text;
    return validateResult(result);
  }

  // Detect institution
  let matched = null;
  // A caller-supplied institution pins the parser, skipping detection — for a
  // statement whose layout is standard but whose markers didn't survive the
  // export.
  if (options.institution) {
    matched = INSTITUTION_PATTERNS.find(i => i.name === options.institution) || null;
  }
  if (!matched) {
    for (const inst of INSTITUTION_PATTERNS) {
      if (inst.regex.test(text)) {
        matched = inst;
        break;
      }
    }
  }

  if (matched) {
    console.log(`Detected institution: ${matched.name}`);
    // parse() may be async (e.g. Scotiabank uses coordinate-aware extraction)
    const result = await Promise.resolve(matched.parser.parse(text, filePath, options));
    result.institution = result.institution || matched.name;
    result.rawText = text;
    return validateResult(result);
  }

  // Fallback: generic parser
  console.log('No institution detected — using generic parser');
  const result = await Promise.resolve(genericParser.parse(text, filePath, options));
  result.institution = result.institution || options.institution || 'Unknown';
  result.rawText = text;
  return validateResult(result);
}

/**
 * Formats the user can pick at import when auto-detection can't route a file.
 * Keyed by the value the renderer sends; `label` is what it shows.
 */
const FORMAT_PARSERS = {
  txlist:  { label: 'Transaction list (online-banking export)', parse: (t, f, o) => txlistParser.parse(t, f, o) },
  generic: { label: 'Generic table (date, description, amount)', parse: (t, f, o) => genericParser.parse(t, f, o) },
};

/** Format choices for the import UI, plus which one suits this file's text. */
function listFormats() {
  return Object.entries(FORMAT_PARSERS).map(([value, f]) => ({ value, label: f.label }));
}

/** Institutions with a dedicated parser, for the import-time override list. */
function listInstitutions() {
  return INSTITUTION_PATTERNS.map(i => i.name);
}

/**
 * Best-guess format for a file whose institution couldn't be detected, so the
 * import UI can preselect rather than make the user guess. Null when unsure.
 */
function suggestFormat(text) {
  return txlistParser.looksLikeTxList(text) ? 'txlist' : null;
}

/** True for a real "YYYY-MM-DD" calendar date. */
function isValidISODate(str) {
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const [y, m, d] = str.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Drop transactions with an unparseable date or non-finite amount before they
 * reach the upload queue (normalizeDate returns unparsed strings verbatim, which
 * would otherwise fail opaquely at the LunchMoney API). Records what was dropped
 * and warns on empty results. Handles single results and arrays (e.g. UNFCU).
 */
function validateResult(resultOrArray) {
  if (Array.isArray(resultOrArray)) return resultOrArray.map(validateResult);

  const result = resultOrArray;
  if (!result || !Array.isArray(result.transactions)) return result;

  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  const badDates = [];
  let badAmounts = 0;

  result.transactions = result.transactions.filter(tx => {
    if (!isValidISODate(tx.date)) { badDates.push(tx.date); return false; }
    if (!Number.isFinite(tx.amount)) { badAmounts++; return false; }
    return true;
  });

  if (badDates.length) {
    warnings.push(`Dropped ${badDates.length} transaction(s) with unparseable dates (e.g. "${badDates[0]}").`);
  }
  if (badAmounts) {
    warnings.push(`Dropped ${badAmounts} transaction(s) with invalid amounts.`);
  }
  // `emptyPeriod` means the parser positively recognized the statement layout
  // and it genuinely contains no transactions (e.g. a dormant month, which JN
  // still issues with opening/closing balance rows). It has already said so in
  // its own warning; blaming the file would be wrong and alarming.
  if (result.transactions.length === 0 && !result.emptyPeriod) {
    warnings.push('No transactions extracted — the file may be unsupported or a scanned-image PDF.');
  }

  result.warnings = warnings;
  return result;
}

/**
 * Parse a CSV file (LunchMoney-like or bank export)
 */
function parseCSV(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const records = splitCSVRecords(content);   // quote-aware: a quoted field may span newlines
  if (records.length < 2) return { institution: 'CSV Import', transactions: [], warnings: ['CSV has no data rows.'] };

  const headers = splitCSVLine(records[0]).map(h => h.trim().toLowerCase());
  const transactions = [];
  let dropped = 0;

  for (let i = 1; i < records.length; i++) {
    const cols = splitCSVLine(records[i]);
    if (cols.length < 2) { dropped++; continue; }
    const row = {};
    headers.forEach((h, idx) => { row[h] = (cols[idx] || '').trim(); });

    const tx = normalizeCSVRow(row);
    if (tx) transactions.push(tx); else dropped++;
  }

  const institution = guessInstitutionFromCSV(headers);
  const period = derivePeriodFromTransactions(transactions);
  const warnings = dropped ? [`Skipped ${dropped} CSV row(s) with no usable date/amount.`] : [];

  // NB: no applySignConvention here — normalizeCSVRow already returns amounts in
  // the user-facing convention (positive = income/credit). Negating again would
  // double-flip a LunchMoney-style signed CSV.
  return { institution, accountType: 'csv-import', accountName: institution, currency: 'JMD', period, transactions, warnings };
}

/**
 * Split raw CSV content into record strings, treating newlines inside a quoted
 * field as part of the field (RFC 4180) rather than a record boundary.
 */
function splitCSVRecords(content) {
  const records = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === '"') {
      if (inQuotes && content[i + 1] === '"') { cur += '""'; i++; }  // keep escaped quote for splitCSVLine
      else { inQuotes = !inQuotes; cur += ch; }
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && content[i + 1] === '\n') i++;
      if (cur.trim()) records.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) records.push(cur);
  return records;
}

/**
 * Parse a monetary string to a signed number. Handles accounting parentheses
 * "(1,234.00)" = negative, leading/trailing minus, and currency symbols/commas.
 * Returns NaN on non-numeric input.
 */
function parseMoney(str) {
  if (str == null) return NaN;
  let s = String(str).trim();
  if (!s) return NaN;

  let negative = false;
  const paren = s.match(/^\((.*)\)$/);
  if (paren) { negative = true; s = paren[1]; }
  if (/-\s*$/.test(s)) { negative = true; s = s.replace(/-\s*$/, ''); }
  if (/^\s*-/.test(s))  { negative = true; s = s.replace(/^\s*-/, ''); }

  s = s.replace(/[^0-9.]/g, '');
  if (s === '' || Number.isNaN(Number(s))) return NaN;
  const val = Number(s);
  return negative ? -val : val;
}

function splitCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }  // RFC 4180 escaped quote
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current); current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function normalizeCSVRow(row) {
  const dateStr  = row['date'] || row['transaction date'] || row['value date'] || '';
  const payee    = row['payee'] || row['description'] || row['merchant'] || row['narration'] || '';
  const currency = row['currency'] || 'JMD';
  const notes    = row['notes'] || row['memo'] || row['reference'] || '';
  if (!dateStr) return null;

  const debitStr  = (row['debit']  || '').trim();
  const creditStr = (row['credit'] || '').trim();
  const amountStr = (row['amount'] || row['value'] || '').trim();

  // Separate debit/credit columns are sign-bearing; a single amount/value column
  // is assumed already signed with positive = money in (LunchMoney convention).
  // Prefer whichever column carries a NON-ZERO value: a "0.00" in the debit
  // column of a deposit row must not shadow the populated credit column.
  const debit  = parseMoney(debitStr);   // NaN when empty
  const credit = parseMoney(creditStr);
  let amount;
  if (Number.isFinite(debit) && debit !== 0) {
    amount = -Math.abs(debit);            // debit → expense (negative)
  } else if (Number.isFinite(credit) && credit !== 0) {
    amount = Math.abs(credit);            // credit → income (positive)
  } else if (amountStr) {
    const v = parseMoney(amountStr);
    if (Number.isNaN(v)) return null;
    amount = v;
  } else {
    return null;                          // no non-zero debit/credit and no amount column
  }

  return {
    date: normalizeDate(dateStr),
    payee: payee || 'Unknown',
    amount,
    currency,
    notes,
    category: row['category'] || '',
    type: amount > 0 ? 'credit' : 'debit',
  };
}

function guessInstitutionFromCSV(headers) {
  if (headers.some(h => h.includes('wise'))) return 'Wise';
  if (headers.some(h => h.includes('paypal'))) return 'PayPal';
  if (headers.some(h => h.includes('stripe'))) return 'Stripe';
  return 'CSV Import';
}

module.exports = {
  parseStatement, validateResult, normalizeDate, derivePeriodFromTransactions,
  listFormats, listInstitutions, suggestFormat,
};
