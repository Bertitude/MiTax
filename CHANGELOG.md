# MiTax Changelog

All notable changes to MiTax are documented here.

---

## [1.3.0] — 2026-07-02

Project-audit remediation: security hardening, correctness fixes, and the
first automated test suite. See `AUDIT.md` for the full findings list.

### Security
- **API keys encrypted at rest.** LunchMoney API keys are now encrypted with
  Electron `safeStorage` (OS keychain/DPAPI) instead of stored in plaintext.
  Legacy plaintext rows are migrated on next access; if no keychain backend is
  available the key stays plaintext and a one-time warning is shown.
- **Replaced `pdf-parse` with `pdfjs-dist`.** `pdf-parse` bundled an old pdfjs
  affected by CVE-2024-4367 (JS execution from a crafted PDF) — reachable since
  the app parses user-supplied statements. Text/coordinate extraction semantics
  are preserved.
- **Upgraded off end-of-life Electron 29 to Electron 41** (plus better-sqlite3
  12 / electron-builder 26). Dropped-file paths now resolve via
  `webUtils.getPathForFile` (Electron 32 removed `File.path`).
- **Renderer hardening:** `sandbox: true`, navigation/`window.open` denied,
  an IPC file-path allow-list (parse only files the user chose), removal of the
  unrestricted `read-file` handler, an allow-listed `open-external` handler, and
  a tightened CSP (`script-src 'self'`, no `'unsafe-inline'`).

### Fixed
- **Account view sign inversion:** the per-transaction list showed income as a
  red debit and vice-versa (it disagreed with the monthly totals and the tax
  engine).
- **CSV imports:** separate debit/credit columns are now signed correctly,
  accounting-parentheses negatives are honored, and a pre-signed amount column
  is no longer double-flipped.
- **Coverage tracker timezone bug:** statement months/years were misattributed
  by one in negative-offset timezones (Jamaica); dates are now parsed without a
  UTC round-trip.
- **Scotiabank dates:** unrecognized month tokens are skipped (with a warning)
  instead of coerced to January; a missing statement-period header warns instead
  of silently defaulting the year.
- **Parser output validation:** transactions with unparseable dates or invalid
  amounts are dropped with a warning, and empty results are surfaced instead of
  failing opaquely at upload.
- **Reconcile:** same-day equal-amount debit/credit pairs are no longer
  false-flagged as sign mismatches, and phantom-balance deletion is scoped to
  balance lines the parser actually saw (others require manual review).
- **Robustness:** integer-cents tax math (no float drift in filed figures),
  main-process uncaught-exception logging, and try/finally around renderer busy
  states (no more stuck spinners).

### Added
- **Automated test suite** (`node --test`, 27 tests) covering parsers, the sign
  convention, CSV handling, date utilities, S04 tax math, PDF reflow, and
  reconciliation — plus a CI workflow running tests on every push and PR.

---

## [1.2.17] — 2026-03-02

### Fixed
- **Debit/credit sign inverted on upload for NCB, UNFCU, Scotiabank, JMMB**
  These parsers were using the opposite sign convention from LunchMoney
  (positive = income, negative = expense), causing every transaction to land
  in LunchMoney as the wrong type — deposits appearing as expenses and
  withdrawals appearing as income.
  Fixed all four parsers to follow the LunchMoney convention:
  **positive = expense/debit, negative = income/credit**.
  - NCB: `credit > 0 ? credit : -debit` → `debit > 0 ? debit : -credit`
  - UNFCU: balance-delta sign flipped; keyword fallback sign flipped
  - Scotiabank (regular): `deposit > 0 ? deposit : -withdrawal` → `withdrawal > 0 ? withdrawal : -deposit`; Pattern B `+` sign inverted
  - JMMB: two-column heuristic sign corrected; fallback type labels corrected
  All four parsers' `categorize()` functions updated accordingly
  (`amount < 0` = income instead of `amount > 0`).

---

## [1.2.16] — 2026-03-02

### Fixed
- **Upload History: times after midnight showing as 24:xx**
  `Intl.DateTimeFormat` with `hour12: false` can return hour `24` for
  midnight instead of `00` (a known spec quirk). Switched to
  `hourCycle: 'h23'` which enforces the 0–23 range consistently.

---

## [1.2.15] — 2026-03-02

### Added
- **Coverage Tracker — exclude/include accounts**
  Each account card in the Coverage Tracker now has an **"− Exclude"** button.
  Excluded accounts are dimmed and their monthly grid is hidden. A bar at the
  bottom of the tracker shows how many accounts are hidden and lets you reveal
  or restore them with **"＋ Track"** without leaving the view.
- Exclusions are persisted in local storage and survive app restarts.
- Dashboard missing-statements widget respects the exclusion list.
  Excluded accounts are silently skipped; a footnote shows the hidden count
  so nothing is lost without explanation.

---

## [1.2.14] — 2026-03-02

### Added
- **Payee Cleanup** — new card in the account detail view
  Surfaces LunchMoney transactions whose payee field still contains raw bank
  export text (all-caps strings, bank prefixes like "Point Of Sale", phone
  numbers, etc.). Each candidate shows the original text alongside a
  suggested clean name in an editable input. Select individual rows or use
  **Select All**, then **Apply Selected** to push the updates to LunchMoney
  in bulk.
- `src/payee-detect.js` — standalone module providing `isRawBankText()`,
  `needsPayeeCleanup()`, and `suggestPayee()` heuristics.
- `updateTransaction()` and `batchUpdatePayees()` added to `src/lunchmoney.js`.

---

## [1.2.13] — 2026-02-28

### Fixed
- **UNFCU 2025 statements detected as NCB**
  `pdf-parse` reflows multi-line ATM descriptions into a single string that
  can contain "NATIONAL COMMERCIAL BANK", triggering a false NCB match.
  Fixed by (1) moving UNFCU and JN Bank before NCB in the detection order
  and (2) requiring "Jamaica" or "Limited" after "Bank" in the NCB regex.

---

## [1.2.12] — 2026-02-27

### Fixed
- **UNFCU multi-account statements — all accounts mapping to Checking**
  All three UNFCU accounts (Membership Share, Savings, Checking) previously
  scored identically on institution + currency + LM asset type, always
  resolving to the first Checking asset. Fixed with keyword scoring:
  parsed `accountName` keywords are matched against LM asset names, plus
  type synonyms (savings ↔ share/membership, chequing ↔ checking/current).

---

## [1.2.11] — 2026-02-26

### Fixed
- **Coverage tracker showing uploaded months as missing**
  The grid only checked LunchMoney's transaction API, so months where a
  statement was uploaded but contained zero transactions appeared red.
  Added a parallel DB coverage query; those months now show as blue
  ("statement uploaded, no transactions recorded") instead of red missing.

---

## [1.2.10] — 2026-02-25

### Fixed
- **Upload History timestamps displaying as UTC**
  SQLite `datetime('now')` stores UTC with no timezone suffix. The
  display layer was slicing the raw string, which rendered UTC times as
  if they were local. Fixed with `fmtUploadTime()` which appends `Z`
  before parsing so `Intl.DateTimeFormat` converts correctly to the
  user's selected timezone.

---

## [1.2.9] — 2026-02-24

### Added
- **Timezone support**
  Users can select a timezone in Upload Preferences (Settings).
  All date calculations — S04A generation, coverage grid, upload
  timestamps — now respect the selected timezone.
- **First-run welcome modal**
  On first launch, a setup modal prompts for timezone and base currency
  before showing the main UI.

---

## [1.2.8] — 2026-02-20

### Added
- **JN Bank parser**
  Parses JN Bank PDF statements into LunchMoney-compatible transactions.

---
