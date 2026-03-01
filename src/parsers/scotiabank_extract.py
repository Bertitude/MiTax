#!/usr/bin/env python3
"""
Scotiabank Jamaica PDF extractor — coordinate-aware via pdfplumber.

Usage:  python3 scotiabank_extract.py <path/to/statement.pdf>
Output: JSON on stdout  { institution, accountNumber, accountName,
                          accountType, currency, period, transactions }

Each transaction:  { date, payee, amount, currency, notes, category, type }
"""

import sys
import json
import re
from collections import defaultdict

try:
    import pdfplumber
except ImportError:
    print(json.dumps({"error": "pdfplumber not installed — run: pip install pdfplumber"}))
    sys.exit(1)

MONTH_MAP = {
    'JAN': 1, 'FEB': 2, 'MAR': 3, 'APR': 4,
    'MAY': 5, 'JUN': 6, 'JUL': 7, 'AUG': 8,
    'SEP': 9, 'OCT': 10, 'NOV': 11, 'DEC': 12,
}

# ── Helpers ──────────────────────────────────────────────────────────────────

def categorize(payee, amount):
    p = payee.lower()
    if re.search(r'salary|payroll|direct deposit', p):           return 'Income'
    if re.search(r'atm|abm|cash withdrawal', p):                 return 'Cash & ATM'
    if re.search(r'grocery|supermarket|hi-lo|megamart|pricesmart|shoprite', p): return 'Groceries'
    if re.search(r'restaurant|kfc|burger|pizza|cafe|hellofood|hello food|doordash', p): return 'Food & Dining'
    if re.search(r'gas|fuel|petro|texaco|shell|total station', p): return 'Auto & Transport'
    if re.search(r'\bnis\b|nht|\btax\b|gct', p):                 return 'Taxes'
    if re.search(r'jps|nwc|flow|digicel|lime|c&w', p):           return 'Bills & Utilities'
    if re.search(r'insurance', p):                                return 'Insurance'
    if re.search(r'transfer', p):                                 return 'Transfer'
    if re.search(r'service charge|bank fee|gct/govt', p):         return 'Bank Fees'
    if amount > 0:                                                return 'Income'
    return 'Uncategorized'

def clean_payee(s):
    # Merge multi-space gaps, strip non-ASCII cruft
    s = re.sub(r'\s+', ' ', s).strip()
    # Remove continuation marker we added
    s = s.replace(' | ', ' — ')
    return s[:100]

def derive_period(transactions):
    dates = [t['date'] for t in transactions if t.get('date')]
    if not dates:
        return {'start': '', 'end': ''}
    return {'start': min(dates), 'end': max(dates)}


# ── Core parser ───────────────────────────────────────────────────────────────

def parse(pdf_path):
    # Skip header/footer patterns when building description continuation lines
    SKIP_RE = re.compile(
        r'^(Transaction|Description|Amount|Balance|CREDIT|DEBIT|'
        r'Page\s+\d+|of\s+\d+|1-888|www\.|'
        r'Transactions\s+\(|Your\s+ELECTRONIC|Account Summary|'
        r'\*Trademark)',
        re.I,
    )

    transactions = []
    account_number = ''
    currency = 'JMD'
    period_start = ''
    period_end = ''

    with pdfplumber.open(pdf_path) as pdf:

        # ── Pull metadata from full text ──────────────────────────────────────
        full_text = '\n'.join(p.extract_text() or '' for p in pdf.pages)

        acc_m = re.search(r'Account Number:\s*(\d+)', full_text)
        if acc_m:
            account_number = acc_m.group(1).strip()[-4:]

        if re.search(r'USD|US\$|United\s+States', full_text):
            currency = 'USD'

        # Statement period  e.g.  05DEC20  to  05JAN21
        period_m = re.search(r'(\d{2}[A-Z]{3}\d{2})\s+to\s+(\d{2}[A-Z]{3}\d{2})', full_text)
        if period_m:
            period_start = period_m.group(1)
            period_end   = period_m.group(2)

        def date_year(ddmmm):
            """Return the 4-digit year for a date token like '07DEC'."""
            mmm = ddmmm[2:5].upper()
            if period_start and period_end:
                start_yr  = int('20' + period_start[5:7])
                end_yr    = int('20' + period_end[5:7])
                start_mmm = period_start[2:5].upper()
                end_mmm   = period_end[2:5].upper()
                if start_yr != end_yr:
                    start_mo = MONTH_MAP.get(start_mmm, 1)
                    tx_mo    = MONTH_MAP.get(mmm, 1)
                    return start_yr if tx_mo >= start_mo else end_yr
                return start_yr
            return 2000  # fallback

        # ── Per-page word extraction ──────────────────────────────────────────
        for page in pdf.pages:
            words = page.extract_words(keep_blank_chars=False)
            if not words:
                continue

            # Group words into rows by y-position (tolerance bucket of 3pt)
            rows = defaultdict(list)
            for w in words:
                y_key = round(w['top'] / 3) * 3
                rows[y_key].append(w)

            current_tx = None

            for y_key in sorted(rows.keys()):
                row_words = sorted(rows[y_key], key=lambda w: w['x0'])

                # Date column  (x < 80,  pattern DDMMM)
                date_words   = [w for w in row_words
                                if w['x0'] < 80 and re.match(r'^\d{2}[A-Z]{3}$', w['text'])]
                # Description column  (x 80–390)
                desc_words   = [w for w in row_words if 80 <= w['x0'] < 390]
                # Amount column  (x ≥ 390)
                amount_words = [w for w in row_words if w['x0'] >= 390]

                if date_words:
                    # Commit previous transaction
                    if current_tx and current_tx.get('amount') is not None:
                        transactions.append(_finalise(current_tx, currency))

                    ddmmm = date_words[0]['text']
                    dd    = int(ddmmm[:2])
                    mmm   = ddmmm[2:5]
                    yr    = date_year(ddmmm)
                    mo    = MONTH_MAP.get(mmm, 1)
                    date_str = f'{yr}-{mo:02d}-{dd:02d}'

                    desc   = ' '.join(w['text'] for w in desc_words).strip()
                    amount = _parse_amount(amount_words)

                    current_tx = {
                        'date':         date_str,
                        'desc':         desc,
                        'amount':       amount,
                        'continuation': [],
                    }

                elif current_tx is not None:
                    # Continuation description line
                    if desc_words:
                        cont = ' '.join(w['text'] for w in desc_words).strip()
                        if cont and not SKIP_RE.match(cont):
                            current_tx['continuation'].append(cont)

                    # Amount on its own row (can happen on some page layouts)
                    if amount_words and current_tx.get('amount') is None:
                        amt = _parse_amount(amount_words)
                        if amt is not None:
                            current_tx['amount'] = amt

            # End of page — commit last transaction
            if current_tx and current_tx.get('amount') is not None:
                transactions.append(_finalise(current_tx, currency))
            current_tx = None

    period = derive_period(transactions)
    acc_name = f'Scotiabank ...{account_number}' if account_number else 'Scotiabank Account'

    # Detect account type from full text
    account_type = 'chequing'
    if re.search(r'savings', full_text, re.I):         account_type = 'savings'
    if re.search(r'visa|credit\s+card|mastercard', full_text, re.I): account_type = 'credit_card'
    if re.search(r'mortgage|loan', full_text, re.I):   account_type = 'loan'
    if re.search(r'electronic access', full_text, re.I): account_type = 'chequing'

    return {
        'institution':   'Scotiabank',
        'accountType':   account_type,
        'accountName':   acc_name,
        'accountNumber': account_number,
        'currency':      currency,
        'period':        period,
        'transactions':  transactions,
    }


def _parse_amount(amount_words):
    """Extract numeric amount from a list of words like ['J$', '4,025.00', '-']."""
    text = ' '.join(w['text'] for w in amount_words)
    m = re.search(r'([\d,]+\.\d{2})\s*([-+])', text)
    if m:
        val  = float(m.group(1).replace(',', ''))
        sign = m.group(2)
        return val if sign == '+' else -val
    return None


def _finalise(tx, currency):
    """Turn raw parsed row into a clean transaction dict."""
    parts = [tx['desc']] + tx['continuation']
    full_desc = ' '.join(p for p in parts if p).strip()
    payee = clean_payee(full_desc) or 'Scotiabank Transaction'
    amount = tx['amount']
    return {
        'date':     tx['date'],
        'payee':    payee,
        'amount':   amount,
        'currency': currency,
        'notes':    '',
        'category': categorize(payee, amount),
        'type':     'credit' if amount >= 0 else 'debit',
    }


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'Usage: scotiabank_extract.py <pdf_path>'}))
        sys.exit(1)

    try:
        result = parse(sys.argv[1])
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({'error': str(e)}))
        sys.exit(1)
