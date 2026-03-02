# MiTax Changelog

All notable changes to MiTax are documented here.

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
