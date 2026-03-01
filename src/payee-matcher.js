/**
 * Payee Matcher
 *
 * Given a raw bank transaction description, this module:
 * 1. Cleans bank-specific noise from the description → this goes into `notes`
 * 2. Extracts the most likely merchant/payee name  → this goes into `payee`
 * 3. Optionally fuzzy-matches against a list of existing LunchMoney payees
 */

// ─── Noise patterns to strip from bank descriptions ──────────────────────────

const STRIP_PREFIXES = [
  /^POS\s+PURCHASE\s*/i,
  /^POINT\s+OF\s+SALE\s*/i,
  /^ONLINE\s+PURCHASE\s*/i,
  /^INTERNET\s+(BANKING\s+)?PURCHASE\s*/i,
  /^BILL\s+PAY(MENT)?\s*/i,
  /^BILL\s+PMT\s*/i,
  /^ACH\s+(DEBIT|CREDIT)\s*/i,
  /^WIRE\s+(TRANSFER\s+)?(IN|OUT)?\s*/i,
  /^ATM\s+(WITHDRAWAL|DEPOSIT|CASH)?\s*/i,
  /^CASH\s+ADVANCE\s*/i,
  /^DEBIT\s+(CARD\s+)?(PURCHASE|TRANSACTION)?\s*/i,
  /^CREDIT\s+(CARD\s+)?(PAYMENT|TRANSACTION)?\s*/i,
  /^DIRECT\s+(DEBIT|CREDIT)\s*/i,
  /^RECURRING\s+PAYMENT\s*/i,
  /^STANDING\s+ORDER\s*/i,
  /^CHEQUE\s*(DEPOSIT|PAYMENT)?\s*/i,
  /^CHECK\s+#?\d*\s*/i,
  /^TXN\s+/i,
  /^TRF\s+/i,
  /^TRSF\s+/i,
  /^XFER\s+/i,
  /^TRANSFER\s+(TO|FROM)?\s*/i,
  /^INTERAC\s*/i,
  /^E-?TRANSFER\s*/i,
  /^PYMT\s+/i,
  /^PMT\s+/i,
  /^REF\s*#?\s*\d+\s*/i,
  /^REFERENCE\s*:?\s*\d+\s*/i,
];

// Patterns to remove anywhere in the string
const STRIP_ANYWHERE = [
  /\b\d{6,}\b/g,                           // long reference numbers
  /\b\d{2}[\/\-]\d{2}([\/\-]\d{2,4})?\b/g, // date fragments
  /\b[A-Z]{2,3}\d{4,}\b/g,                 // codes like NCB12345
  /\s+(JA|KIN|MON|SPA|OCA|POS)\s*/g,       // common Jamaican location codes
  /\bREF\s*:?\s*[\w\-]+\b/gi,              // REF: anything
  /\bTRACE\s*:?\s*[\w\-]+\b/gi,
  /\bAUTH\s*:?\s*[\w\-]+\b/gi,
  /\*{2,}/g,                                // asterisks used as masking
  /\s{2,}/g,                                // collapse whitespace
];

// ─── Common Jamaican / Caribbean merchant name cleanups ───────────────────────

const KNOWN_MERCHANTS = [
  // Supermarkets / Retail
  [/hi[\s\-]?lo\s*(supermarket)?/i,    'Hi-Lo Supermarket'],
  [/pricesmart/i,                        'PriceSmart'],
  [/megamart/i,                          'MegaMart'],
  [/general\s+food/i,                    'General Food'],
  [/fontana\s*pharm/i,                   'Fontana Pharmacy'],
  [/shoppers?\s*(fair|drug)?/i,          'Shopper\'s Fair'],
  // Fuel / Auto
  [/texaco/i,                            'Texaco'],
  [/total\s*(energ)?/i,                  'Total Energies'],
  [/petcom/i,                            'Petcom'],
  [/rubis/i,                             'Rubis'],
  [/epp/i,                               'Esso/EPP'],
  // Utilities / Telco
  [/jps\b/i,                             'JPS'],
  [/nwc\b/i,                             'NWC'],
  [/flow\b/i,                            'Flow'],
  [/digicel/i,                           'Digicel'],
  [/c\&?w\b/i,                           'C&W / Flow'],
  // Government
  [/nht\b/i,                             'NHT'],
  [/nis\b/i,                             'NIS'],
  [/taj\b/i,                             'Tax Administration Jamaica'],
  [/income\s+tax/i,                      'Tax Administration Jamaica'],
  // Food / Restaurant
  [/kfc\b/i,                             'KFC'],
  [/pizza\s*(hut|boys)?/i,               'Pizza Hut'],
  [/burger\s*king/i,                     'Burger King'],
  [/island\s+grill/i,                    'Island Grill'],
  [/juici\s*patties/i,                   'Juici Patties'],
  [/mothers\b/i,                         'Mother\'s'],
  [/virgin\s*(island)?/i,                'Virgin Island Café'],
  [/starbucks/i,                         'Starbucks'],
  [/subway\b/i,                          'Subway'],
  // Finance
  [/paypal/i,                            'PayPal'],
  [/wise\b|transferwise/i,               'Wise'],
  [/stripe\b/i,                          'Stripe'],
  [/western\s*union/i,                   'Western Union'],
  [/caricad/i,                           'Caribbean Card Services'],
  [/sagicor/i,                           'Sagicor'],
  [/guardian\s*(life|gen)?/i,            'Guardian Life'],
  [/advantage\s*(gen|ins)?/i,            'Advantage General Insurance'],
  [/jmmb/i,                              'JMMB'],
  [/ncb\b/i,                             'NCB'],
  [/scotiabank/i,                        'Scotiabank'],
  // Travel / Rideshare
  [/uber\b/i,                            'Uber'],
  [/inDriver/i,                          'inDrive'],
  [/lynk\b/i,                            'LYNK'],
  [/amazon\b/i,                          'Amazon'],
  [/netflix\b/i,                         'Netflix'],
  [/spotify\b/i,                         'Spotify'],
  [/apple\b/i,                           'Apple'],
  [/google\b/i,                          'Google'],
  [/microsoft\b/i,                       'Microsoft'],
];

// ─── Core Functions ───────────────────────────────────────────────────────────

/**
 * Clean a raw bank description to extract a usable payee name.
 * Returns { payee, notes }
 *   - payee: guessed merchant name (title-cased)
 *   - notes: the original raw description (preserved for LunchMoney notes field)
 */
function extractPayee(rawDescription) {
  const notes = (rawDescription || '').trim();  // always preserve original for notes
  let cleaned = notes;

  // 1. Check for known merchant patterns first (fast-path)
  for (const [pattern, name] of KNOWN_MERCHANTS) {
    if (pattern.test(cleaned)) return { payee: name, notes };
  }

  // 2. Strip common bank prefixes
  for (const prefix of STRIP_PREFIXES) {
    cleaned = cleaned.replace(prefix, '');
  }

  // 3. Strip noise patterns
  for (const pattern of STRIP_ANYWHERE) {
    cleaned = cleaned.replace(pattern, ' ');
  }

  // 4. Clean up and title-case
  cleaned = cleaned.trim().replace(/\s+/g, ' ');
  if (!cleaned) return { payee: notes.substring(0, 60), notes };

  // 5. Title-case (preserve all-caps acronyms ≤4 chars)
  const payee = titleCase(cleaned).substring(0, 100);
  return { payee, notes };
}

/**
 * Match a cleaned payee name against a list of existing LunchMoney payees.
 * Returns the best matching existing payee, or the cleaned name if no good match.
 */
function matchPayee(candidatePayee, existingPayees) {
  if (!existingPayees || existingPayees.length === 0) return candidatePayee;

  const candidate = candidatePayee.toLowerCase();

  // Exact match
  const exact = existingPayees.find(p => p.toLowerCase() === candidate);
  if (exact) return exact;

  // Substring match (candidate contained in existing, or vice versa)
  const sub = existingPayees.find(p => {
    const e = p.toLowerCase();
    return e.includes(candidate) || candidate.includes(e);
  });
  if (sub) return sub;

  // Token Jaccard similarity
  const candidateTokens = new Set(candidate.split(/\s+/).filter(t => t.length > 2));
  let bestScore = 0;
  let bestMatch = null;

  for (const existing of existingPayees) {
    const existingTokens = new Set(existing.toLowerCase().split(/\s+/).filter(t => t.length > 2));
    const intersection = [...candidateTokens].filter(t => existingTokens.has(t)).length;
    const union = new Set([...candidateTokens, ...existingTokens]).size;
    const jaccard = union > 0 ? intersection / union : 0;
    if (jaccard > bestScore) { bestScore = jaccard; bestMatch = existing; }
  }

  // Only use fuzzy match if similarity is strong enough
  if (bestScore >= 0.5 && bestMatch) return bestMatch;

  return candidatePayee;
}

/**
 * Process an array of parsed transactions:
 * - Moves raw description to `notes`
 * - Sets `payee` to matched/guessed merchant name
 * Returns a new array of transactions with updated fields.
 */
function processTransactions(transactions, existingPayees = []) {
  return transactions.map(tx => {
    const rawDesc = tx.payee || tx.notes || '';
    const { payee: guessedPayee, notes: originalDesc } = extractPayee(rawDesc);
    const payee = matchPayee(guessedPayee, existingPayees);

    return {
      ...tx,
      payee,
      notes: originalDesc,   // original bank description
      _rawDescription: rawDesc,
      _guessedPayee: guessedPayee,
      _matched: payee !== guessedPayee,
    };
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function titleCase(str) {
  return str.replace(/\w+/g, word => {
    // Keep short all-caps words as-is (acronyms like KFC, JPS)
    if (word.length <= 4 && word === word.toUpperCase()) return word;
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  });
}

module.exports = { extractPayee, matchPayee, processTransactions };
