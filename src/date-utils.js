/**
 * Timezone-safe helpers for ISO date-only strings ("YYYY-MM-DD").
 *
 * `new Date("YYYY-MM-DD")` parses as UTC midnight; reading it back with the
 * local getFullYear()/getMonth() shifts the date to the previous day in any
 * negative-offset timezone (Jamaica is UTC-5), so a period starting on the 1st
 * of a month gets attributed to the previous month/year. These helpers parse by
 * string slicing and do month arithmetic on integers, avoiding Date entirely.
 */

'use strict';

/** { year, month } (month 1-12) from an ISO date-only string, or null. */
function yearMonthOf(isoStr) {
  if (!isoStr || typeof isoStr !== 'string') return null;
  const m = isoStr.match(/^(\d{4})-(0[1-9]|1[0-2])/);   // reject month 00 / 13–99
  if (!m) return null;
  return { year: parseInt(m[1], 10), month: parseInt(m[2], 10) };
}

/** Year (integer) from an ISO date-only string, or null. */
function yearOf(isoStr) {
  const ym = yearMonthOf(isoStr);
  return ym ? ym.year : null;
}

/**
 * Every { year, month } from startIso through endIso inclusive (by calendar
 * month). Endpoints may be any day within their month. Returns [] if either
 * endpoint is unparseable or the range is inverted.
 */
function eachMonthInRange(startIso, endIso) {
  const s = yearMonthOf(startIso);
  const e = yearMonthOf(endIso);
  if (!s || !e) return [];

  let cursor = s.year * 12 + (s.month - 1);
  const last = e.year * 12 + (e.month - 1);
  const out = [];
  while (cursor <= last) {
    out.push({ year: Math.floor(cursor / 12), month: (cursor % 12) + 1 });
    cursor++;
  }
  return out;
}

module.exports = { yearMonthOf, yearOf, eachMonthInRange };
