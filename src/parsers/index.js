/**
 * Statement parser dispatcher.
 * Detects the institution from the PDF text and routes to the correct parser.
 */

const pdfParse = require('pdf-parse');
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
    return parseCSV(filePath);
  }

  // PDF path
  const buffer = fs.readFileSync(filePath);
  const pdfData = await pdfParse(buffer);
  const text = pdfData.text;

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
    return result;
  }

  // Fallback: generic parser
  console.log('No institution detected — using generic parser');
  const result = await Promise.resolve(genericParser.parse(text, filePath));
  result.institution = result.institution || 'Unknown';
  result.rawText = text;
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

  return { institution, accountType: 'csv-import', accountName: institution, currency: 'JMD', period, transactions };
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
  const dateStr = row['date'] || row['transaction date'] || row['value date'] || '';
  const payee = row['payee'] || row['description'] || row['merchant'] || row['narration'] || '';
  const amountStr = row['amount'] || row['debit'] || row['credit'] || row['value'] || '0';
  const currency = row['currency'] || 'JMD';
  const notes = row['notes'] || row['memo'] || row['reference'] || '';

  if (!dateStr || !amountStr) return null;

  const amount = parseFloat(amountStr.replace(/[^0-9.\-]/g, ''));
  if (isNaN(amount)) return null;

  return {
    date: normalizeDate(dateStr),
    payee: payee || 'Unknown',
    amount,
    currency,
    notes,
    category: row['category'] || '',
    type: amount < 0 ? 'debit' : 'credit',
  };
}

function guessInstitutionFromCSV(headers) {
  if (headers.some(h => h.includes('wise'))) return 'Wise';
  if (headers.some(h => h.includes('paypal'))) return 'PayPal';
  if (headers.some(h => h.includes('stripe'))) return 'Stripe';
  return 'CSV Import';
}

module.exports = { parseStatement, normalizeDate, derivePeriodFromTransactions };
