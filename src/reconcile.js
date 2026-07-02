/**
 * Statement ↔ LunchMoney reconciliation (pure, unit-testable).
 *
 * Improves on the previous inline logic in two ways:
 *  1. Deterministic, sign-first matching: when several transactions share a
 *     date and absolute amount (e.g. a same-day debit and credit), a same-sign
 *     partner is consumed before any mismatch is reported, so a correct
 *     transaction is no longer falsely flagged. Payee is used to disambiguate.
 *  2. Scoped phantom-balance deletion: an LM row whose payee looks like a
 *     balance sentinel is only auto-offered for deletion (`phantomBalances`)
 *     when the parsed statement actually contained a matching balance line
 *     (`balanceSentinels`). Payee-only matches go to `suspectedPhantoms`, shown
 *     unchecked for manual review — deletion in LM is irreversible.
 */

'use strict';

const BALANCE_RE = /\b(beginning\s+balance|opening\s+balance|ending\s+balance|closing\s+balance|balance\s+forward|balance\s+brought\s+forward|balance\s+carried\s+forward)\b/i;

function normPayee(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 24);
}

const amtKey = (date, amount) => `${date}|${Math.abs(amount).toFixed(2)}`;
const signOf = (n) => (n > 0 ? 1 : n < 0 ? -1 : 0);

function reconcile(parsedTxs, lmTxs, balanceSentinels = []) {
  const sentinelSet = new Set((balanceSentinels || []).map(s => amtKey(s.date, s.amount)));

  // Parsed transactions bucketed by date|abs → [{ tx, np }].
  const buckets = new Map();
  for (const tx of parsedTxs || []) {
    if (tx.amount == null || !tx.date) continue;
    const key = amtKey(tx.date, tx.amount);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({ tx, np: normPayee(tx.payee) });
  }

  const signMismatches   = [];
  const phantomBalances  = [];   // payee matches AND confirmed by a statement sentinel
  const suspectedPhantoms = [];  // payee matches but no sentinel confirmation

  // Stable output order and deterministic pairing.
  const sortedLm = [...(lmTxs || [])].sort((a, b) => {
    const aAmt = parseFloat(a.amount), bAmt = parseFloat(b.amount);
    return (a.date || '').localeCompare(b.date || '')
      || Math.abs(aAmt) - Math.abs(bAmt)
      || normPayee(a.payee || a.original_name).localeCompare(normPayee(b.payee || b.original_name))
      || signOf(aAmt) - signOf(bAmt);
  });

  for (const lmTx of sortedLm) {
    const lmAmt = parseFloat(lmTx.amount);
    const payee = lmTx.payee || lmTx.original_name || '';

    if (BALANCE_RE.test(payee)) {
      const rec = { lmId: lmTx.id, date: lmTx.date, payee, amount: lmAmt };
      if (sentinelSet.has(amtKey(lmTx.date, lmAmt))) phantomBalances.push(rec);
      else suspectedPhantoms.push(rec);
      continue;
    }

    const bucket = buckets.get(amtKey(lmTx.date, lmAmt));
    if (!bucket || !bucket.length) continue;

    const lmNp = normPayee(payee);
    const lmSign = signOf(lmAmt);

    // Same-sign partner (payee-matched first, then any) → matched, no mismatch.
    let idx = bucket.findIndex(c => signOf(c.tx.amount) === lmSign && c.np === lmNp);
    if (idx === -1) idx = bucket.findIndex(c => signOf(c.tx.amount) === lmSign);
    if (idx !== -1) { bucket.splice(idx, 1); continue; }

    // Every remaining candidate is opposite sign → genuine sign mismatch.
    let mIdx = bucket.findIndex(c => c.np === lmNp);
    if (mIdx === -1) mIdx = 0;
    const parsedTx = bucket[mIdx].tx;
    signMismatches.push({
      lmId: lmTx.id, date: lmTx.date, payee,
      lmAmount: lmAmt, parsedAmount: parsedTx.amount,
    });
    bucket.splice(mIdx, 1);
  }

  return { signMismatches, phantomBalances, suspectedPhantoms };
}

module.exports = { reconcile, normPayee, BALANCE_RE };
