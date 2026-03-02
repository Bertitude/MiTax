'use strict';

/**
 * Payee detection and suggestion utilities.
 *
 * Identifies LunchMoney transactions whose payee field still contains
 * raw bank export text (unreviewed), and suggests a clean human-readable
 * payee name derived from the transaction's original_name.
 */

// ─── Detection ────────────────────────────────────────────────────────────────

/**
 * Returns true when the string looks like unprocessed bank export text:
 *   • all-caps or mostly-caps (>70% of letters are uppercase)
 *   • starts with known raw transaction-type prefixes
 *   • ends with country/state code pairs ("CA US", "JM JM")
 *   • contains bank phone numbers (NNN-NNN-NNNN)
 */
function isRawBankText(str) {
  if (!str || str.length < 4) return false;

  const letters = str.replace(/[^a-zA-Z]/g, '');
  if (letters.length > 4) {
    const upperPct = str.replace(/[^A-Z]/g, '').length / letters.length;
    if (upperPct > 0.7) return true;
  }

  if (/^(Point\s+Of\s+Sale|ATM\s+Withdrawal|IAT\s+(Deposit|Withdrawal)|External\s+(Deposit|Withdrawal)|ACH\s+|WIRE\s+|FX\s+International|Deposit\s+Digital|Withdrawal\s+Digital|Credit\s+Interest|Service\s+Charge|Excessive\s+Transaction)/i.test(str)) return true;

  if (/\b\d{3}-\d{3}-\d{4}\b/.test(str)) return true;

  if (/\b[A-Z]{2}\s+[A-Z]{2}\s*$/.test(str)) return true;

  return false;
}

/**
 * Returns true when a transaction should be offered for payee cleanup:
 *   1. payee is blank/missing, OR
 *   2. payee equals original_name AND that name looks like raw bank text
 */
function needsPayeeCleanup(tx) {
  const payee = (tx.payee || '').trim();
  const orig  = (tx.original_name || '').trim();

  if (!payee) return true;
  if (payee === orig && isRawBankText(payee)) return true;

  return false;
}

// ─── Suggestion ───────────────────────────────────────────────────────────────

/** Words that are dropped when they appear at the end of a name. */
const TRAILING_NOISE = [
  // Country / state pairs
  /\b[A-Z]{2}\s+[A-Z]{2}\s*$/,
  // Jamaican locations
  /\b(Kingston|St\.?\s*Andrew|St\.?\s*James|Montego\s*Bay|Portmore|Spanish\s*Town|Liguanea|Barbican|Manor\s*Park|Half\s*Way\s*Tree|Cross\s*Roads|New\s*Kingston|Mona)\s*\d*\s*(JM|Jamaica)?\s*$/i,
  // Phone numbers
  /\s*\b\d{3}-\d{3}-\d{4}\b\s*/g,
  // Trailing country codes
  /\s+(JM|Jamaica|CA|US|GB|UK)\s*$/i,
];

/** Known transaction-type prefixes to strip from the start. */
const LEADING_PREFIXES = [
  /^Point\s+Of\s+Sale\s+Withdrawal\s+/i,
  /^ATM\s+Withdrawal\s+/i,
  /^IAT\s+(Deposit|Withdrawal)\s+/i,
  /^External\s+(Deposit|Withdrawal)\s+/i,
  /^(Deposit|Withdrawal)\s+Digital\s+Transfer\s+(from|to)\s+\S+\s+(SAV|CK|CHK)\s*/i,
  /^(Deposit|Withdrawal)\s+/i,
  /^FX\s+International\s+Fee\s+Non\s+US\s+Funds\s*/i,
  /^Credit\s+Interest\s*/i,
  /^Service\s+Charge\s*/i,
  /^Excessive\s+Transaction\s+Fee\s*/i,
  /^ACH\s+/i,
  /^WIRE\s+/i,
  // MercuryACH patterns: "MercuryACH <label> From <Company> via mercury.com"
  /^MercuryACH\s+.*?\s+From\s+/i,
  /\s+via\s+mercury\.com\s*$/i,
];

/** JMD/USD amount patterns embedded in names, e.g. "60000.00 JMD * " */
const AMOUNT_RE = /\d[\d,]*\.?\d*\s*(JMD|USD|GBP|EUR)?\s*\*?\s*/gi;

/** ATM/bank institution markers like "* BNS LIGUANEA" */
const ATM_MARKER_RE = /\*\s*(BNS|NCB|JN|RBC|CIBC|JMMB|SCOTIABANK)\s*/gi;

/**
 * Title-case a string, preserving known acronyms.
 */
const ACRONYMS = new Set(['ATM','BNS','NCB','JN','ACH','FX','IAT','NHT','NIS','TAJ',
  'KFC','BMW','AT&T','HBO','PBS','LLC','INC','LTD','PLC','CO']);

function toTitleCase(str) {
  return str.replace(/\S+/g, word => {
    const up = word.toUpperCase();
    if (ACRONYMS.has(up)) return up;
    if (/^\d/.test(word)) return word;          // leave numbers alone
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });
}

/**
 * Derives a clean payee name from the transaction's original_name (or payee).
 * Returns an empty string if no useful name can be extracted.
 */
function suggestPayee(tx) {
  let name = (tx.original_name || tx.payee || '').trim();
  if (!name) return '';

  // Strip leading transaction-type prefixes
  for (const re of LEADING_PREFIXES) {
    name = name.replace(re, '').trim();
  }

  // Strip embedded currency amounts
  name = name.replace(AMOUNT_RE, ' ').trim();

  // Strip ATM bank markers
  name = name.replace(ATM_MARKER_RE, ' ').trim();

  // Strip trailing noise
  for (const re of TRAILING_NOISE) {
    name = name.replace(re, '').trim();
  }

  // Collapse internal whitespace
  name = name.replace(/\s{2,}/g, ' ').trim();

  if (!name || name.length < 2) return '';

  return toTitleCase(name);
}

module.exports = { needsPayeeCleanup, suggestPayee, isRawBankText };
