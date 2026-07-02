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
async function parseStatement(filePath) {
  const fileType = detectFileType(filePath);

  if (fileType === 'csv') {
    return validateResult(parseCSV(filePath));
  }

  // PDF path
  const buffer = fs.readFileSync(filePath);
  const text = await extractText(buffer);

  // Detect institution
  let matched = null;
  for (const inst of INSTITUTION_PATTERNS) {
    if (inst.regex.test(text)) {
      matched = inst;
      break;
    }
  }

  if (matched) {
    console.log(`Detected institution: ${matched.name}`);
    // parse() may be async (e.g. Scotiabank uses coordinate-aware extraction)
    const result = await Promise.resolve(matched.parser.parse(text, filePath));
    result.institution = result.institution || matched.name;
    result.rawText = text;
    return validateResult(result);
  }

  // Fallback: generic parser
  console.log('No institution detected — using generic parser');
  const result = await Promise.resolve(genericParser.parse(text, filePath));
  result.institution = result.institution || 'Unknown';
  result.rawText = text;
  return validateResult(result);
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
  if (result.transactions.length === 0) {
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
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length < 2) return { institution: 'CSV Import', transactions: [] };

  const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim().toLowerCase());
  const transactions = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = splitCSVLine(lines[i]);
    if (cols.length < 2) continue;
    const row = {};
    headers.forEach((h, idx) => { row[h] = (cols[idx] || '').replace(/"/g, '').trim(); });

    const tx = normalizeCSVRow(row);
    if (tx) transactions.push(tx);
  }

  const institution = guessInstitutionFromCSV(headers);
  const period = derivePeriodFromTransactions(transactions);

  // NB: no applySignConvention here — normalizeCSVRow already returns amounts in
  // the user-facing convention (positive = income/credit). Negating again would
  // double-flip a LunchMoney-style signed CSV.
  return { institution, accountType: 'csv-import', accountName: institution, currency: 'JMD', period, transactions };
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
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { result.push(current); current = ''; }
    else { current += ch; }
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
  let amount;
  if (debitStr) {
    const v = parseMoney(debitStr);
    if (Number.isNaN(v)) return null;
    amount = -Math.abs(v);            // debit → expense (negative)
  } else if (creditStr) {
    const v = parseMoney(creditStr);
    if (Number.isNaN(v)) return null;
    amount = Math.abs(v);             // credit → income (positive)
  } else if (amountStr) {
    const v = parseMoney(amountStr);
    if (Number.isNaN(v)) return null;
    amount = v;
  } else {
    return null;
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

module.exports = { parseStatement, normalizeDate, derivePeriodFromTransactions };
