# MiTax Changelog

All notable changes to MiTax are documented here.

---

## [1.3.4] — 2026-07-22

### Fixed
- **Cross-parser audit: the remaining silent-drop / credit-mis-sign paths are
  closed.** A shared row resolver (`resolveRowAmount`) now signs statement rows
  by, in order: the running-balance delta (validated against the row's printed
  amounts), debit/credit column interpretation for full rows, then a payee
  keyword guess — and rows that still can't be resolved produce a loud parse
  warning instead of vanishing. Specifically:
  - **NCB**: the all-or-nothing 3-number regex plus fallback-only-when-empty
    meant mixed statements silently dropped every 2-number row — i.e. deposits
    with a blank debit cell. All dated rows now flow through one unified pass.
  - **Scotiabank regex fallback**: `\s*` separators let a 2-number deposit row
    match with the deposit captured in the *withdrawal* slot — every credit
    mis-signed as a debit. Now line-based with the shared resolver.
  - **JMMB fallback**: pushed raw positive amounts, which the boundary sign
    flip turned into across-the-board debits. Now delta/keyword signed.
  - **JN Bank**: a dated row whose amounts sat outside the hardcoded
    debit/credit x-zones was skipped with no trace; such rows are now counted
    and reported in a parse warning.
  - Verified clean: generic (DR/CR → columns → delta → keyword), UNFCU
    (delta-based), Wise/Stripe/PayPal (natively signed), CSV import (non-zero
    column preference + skip warning).
- **Scotiabank parsers no longer silently drop transactions whose amount
  lacks a +/- marker — which disproportionately lost credits/deposits.** The
  savings/chequing parser required a trailing `+`/`-` after the amount; any
  row without one (unmarked deposits, or the sign glyph extracted as a
  separate/displaced PDF item) was skipped with no trace. Amounts without a
  marker are now signed by the running-balance delta (falling balance =
  debit, rising = credit), with the balance seeded from Beginning/Opening
  Balance lines; the credit-card parser gains a loose fallback for `$`/sign
  glyphs split across PDF items. Any row that still can't be parsed is
  surfaced as a loud parse warning naming the rows — never dropped silently.
- **Validate-modal credit/debit controls were inverted.** "Credits only"
  showed debits (and vice versa), and the "N credits · M debits" counts were
  swapped — an artifact of the pre-v1.2.22 sign convention. Anyone curating
  an upload by transaction type was shown the opposite of what the label
  said. Labels, filters, and counts now follow the final convention
  (positive = credit/income).

---

## [1.3.3] — 2026-07-21

### Added
- **Plaid-synced (bank-linked) LunchMoney accounts are now visible.** The app
  previously listed only manually-managed assets and filtered transactions by
  `asset_id`, so accounts synced via Plaid — and any transactions assigned to
  them — were invisible: real balances on the dashboard but $0 monthly
  summaries. The dashboard, account summary view, coverage tracker, and
  Reconcile now include Plaid accounts (tagged "🔄 synced") and query their
  transactions with `plaid_account_id`. Statement imports still target manual
  assets only — the LunchMoney API does not allow inserting transactions into
  synced accounts — so the mapping dropdown and auto-suggestions exclude them.

### Fixed
- **Coverage tracker no longer vouches for transactions that were deleted from
  LunchMoney.** The local "statement uploaded" overlay used to mark a month
  covered even when the upload's transactions no longer exist in LunchMoney.
  The overlay now distinguishes the two cases: a dormant statement month
  (upload recorded zero transactions — still shown covered, blue) versus a
  month whose upload DID insert transactions that LunchMoney no longer has —
  now shown as a dashed amber "uploaded, now empty in LunchMoney" cell,
  counted as missing, and called out in the card's missing list with a
  re-import hint.

---

## [1.3.2] — 2026-07-21

### Added
- **Import-time sign correction.** Re-importing a statement now detects rows
  that match an existing LunchMoney entry with the *opposite* sign (the
  pre-v1.2.22 flipped-sign uploads) and converts them from inserts into
  in-place corrections. The validate modal badges these rows ("⇄ FIXES SIGN"),
  the upload button shows the split ("Upload N new · Fix M signs"), and a
  confirmation summarises what will be corrected. This closes a duplication
  hazard: LunchMoney's `skip_duplicates` matches *signed* amounts, so a plain
  re-upload over flipped data inserted a second copy beside the bad entry.
  Same-sign matches are flagged as duplicates and pre-unchecked, as before.
- **Double-flip protection across features.** When signs are corrected via
  re-import or the Reconcile modal, upload-history records whose transactions
  are fully covered are stamped `signs_fixed_at` (partially covered records get
  an explanatory note), so the History "Fix Signs" action can no longer re-flip
  already-corrected entries.
- **S04 empty-data warning.** The S04 report now carries an explicit banner
  (screen + notes/PDF) when it was generated with no transaction data — not
  connected, fetch failed, or LunchMoney returned zero transactions for the
  year — instead of silently rendering an all-zero return.

### Fixed
- **Upload history no longer stores the whole batch's LunchMoney ids on every
  file's record.** Uploads are now POSTed per source file (previously per
  asset), so each history record holds exactly its own statement's transaction
  ids. Records saved by older versions (e.g. "31 transactions" but 549 ids)
  are surfaced honestly: the detail modal flags the mismatch, "Fix Signs"
  states it will act on the entire batch, and after a batch fix every sibling
  record covered by the flip is automatically marked signs-fixed — previously
  clicking a sibling's "Fix Signs" would flip the same transactions straight
  back. As a backstop, "Fix Signs" now also checks each individual transaction
  id against every signs-fixed record and never re-flips one that is already
  covered, so working up the history list can no longer toggle a batch back
  and forth even after a partial failure.

---

## [1.3.1] — 2026-07-09

Follow-up fix release completing the v1.3.0 audit remediation (see `AUDIT.md`).

### Documentation
- **Authoritative sign convention (correcting the 1.2.17 entry, which is
  ambiguous).** Two conventions exist and must not be confused:
  - *Parser-internal* (before `applySignConvention`): **positive = debit /
    money out**, negative = credit / money in. This is what the 1.2.17 entry's
    "positive = expense/debit" describes.
  - *LunchMoney upload payload and everything downstream* (tax, UI): uploads use
    `debit_as_negative: true`, so **negative = expense/debit, positive =
    income/credit**. `applySignConvention` flips the internal sign exactly once
    at the parser boundary to get here.
- Versions **1.2.18–1.2.25** were released without individual changelog entries;
  see the git history for those commits. This gap is acknowledged rather than
  reconstructed from memory to avoid inaccurate notes.

### Fixed
- **Statement parsers no longer invert or fabricate transaction signs.** The
  Wise, Stripe and PayPal parsers were treating money-in as expenses (and vice
  versa); NCB and the generic fallback mis-signed deposits when a statement row
  had a single amount column. They now negate fintech user-convention amounts
  correctly and infer bank debit/credit from the running-balance delta. The
  generic parser also stops letting an empty debit cell or a DR/CR marker on the
  running balance flip a row's sign.
- **JMMB statements no longer fail to import.** The JMMB parser threw on every
  file (undefined `accountNumber`) and, behind that, used the running balance as
  the transaction amount — both fixed.
- **PayPal dates parse month-first.** PayPal's MM/DD/YYYY dates were read as
  DD/MM, landing transactions in the wrong month (or dropping them); e.g.
  `7/4/2024` is now July 4, not April 7.
- Added golden-file parser tests for JMMB, NCB, Wise, Stripe, PayPal and the
  generic debit/credit-column and balance-marker cases.

### Security
- **LunchMoney API key no longer leaves the main process.** The key was
  encrypted at rest but then decrypted, sent to the renderer, and mirrored in
  plaintext to `localStorage` in the same profile directory — nullifying the
  encryption. Now the main process resolves the active account's key internally
  for every LunchMoney call, the renderer holds only a `connected` flag, and
  any pre-1.3 plaintext key in `localStorage` is migrated into the encrypted
  store and deleted. A stored key that can't be decrypted (e.g. after an OS
  keychain reset) now cleanly reports "not connected" instead of being used as
  a broken key.
- **IPC surface hardened.** Every IPC handler now rejects calls whose sender
  isn't the app's own top-level window; reconcile transaction IDs are validated
  to integers and URL-encoded before hitting the API; the statement-file
  allow-list resolves symlinks (canonical paths) and rejects non-regular files;
  the S04 print window is given a strict CSP so a crafted report can't fetch
  remote resources during PDF export.
- **Fewer ways to leak/duplicate data over the API.** 5xx responses are retried
  only for idempotent GETs (a POST the server may have committed is no longer
  blindly re-sent); `GET /transactions` pins `debit_as_negative=true` so
  reconcile never rides on the account default; requests time out after 30s;
  all remaining plaintext keys are migrated to encrypted at startup with
  `secure_delete` + `VACUUM` scrubbing old pages.
- **Statement-derived text is HTML-escaped** in the two remaining innerHTML
  sinks (import queue + account-mapping) and the S04 report notes.
- **Tax filings and P24 employment income are encrypted at rest.** The money
  figures, the full serialized S04 report, employer tax-registration numbers,
  and notes are now encrypted with the OS keychain (`safeStorage`) — the same
  protection the API key already has. Existing records are migrated in place on
  first launch; if the OS has no keychain the data stays readable (unencrypted)
  rather than failing. (Columns needed for filtering/sorting — dates, year,
  type, institution — remain plaintext; full-database encryption is a possible
  future step.)

### Added
- **S04A falls back to the prior-year base when current-year income data is
  thin.** Previously, sparse year-to-date income (usually because most
  statements weren't uploaded yet) drove the trend adjustment toward $0,
  under-recommending provisional tax. The estimator now trusts the trend only
  when YTD income is at least half of what the prior year predicts for the
  elapsed period; below that it keeps the prior-year base and explains why.
  Higher-than-expected income still adjusts upward as before.

### Fixed
- **S04A provisional-tax estimator corrected.** Quarterly due dates were built
  as malformed strings (`"2026-03 15-15"`), so the "past due" badge never
  appeared and saving a quarter stored an invalid date that filing history
  rendered as "Invalid Date" — now valid ISO dates with timezone-correct
  past-due detection. The months-elapsed figure counted the current partial
  month as a full month (Jan 31 read as 2.0 months, not 1.0), inflating the
  annualized income trend and mis-recommending instalments; it now counts
  `(month-1) + day/daysInMonth`, and past-year estimates use a full 12 months
  with the income window clamped to the selected year. The four instalments are
  now split in integer cents (Q4 carries the remainder) so they sum exactly to
  the annual figure.
- **2024 and 2025 income tax thresholds corrected to TAJ's effective annual
  values.** TAJ pro-rates April-1 threshold increases into a published
  effective annual threshold per year of assessment; MiTax was using the raw
  post-April figures for 2024/2025 (2026 was already correct). 2024:
  $1,700,088 → **$1,650,090**; 2025: $1,799,376 → **$1,774,470**. Above-threshold
  filers' computed tax for those years increases by ~$12,499.50 (2024) and
  ~$6,226.50 (2025). Verified against TAJ/JIS guidance 2026-07-08.
- **Reconcile no longer masks a flipped transaction** when a same-day,
  equal-amount, same-sign transaction exists — an exact payee match now
  outranks sign, and the apply step lists exactly which flips/deletes failed.
- **CSV import edge cases.** A `0.00` in the debit column no longer shadows a
  populated credit column, and a newline inside a quoted field no longer splits
  (and drops) the record.
- **Dashboard quarterly estimate** uses the nearest-earlier defined tax year
  instead of hard-coding 2025 params for unknown years.
- **PDF documents are released after parsing** (no more per-import memory growth
  in the long-running process); password-protected PDFs show a clear message.
- Buttons no longer get stuck on "Uploading…/Saving…/Updating…/Applying…" when
  an operation fails (try/finally around the busy states).
- Refreshed README (installer names, Node version, data-storage paths),
  `build.bat` branding, and the copyright year.
- **Reconcile now flags statement transactions that never made it to
  LunchMoney** (a likely missed upload) and warns when the statement's dates
  don't fall in the selected year — instead of misreporting "all match."
- **API resilience:** a `Retry-After` header is honoured on rate-limit
  responses, and a bad/expired API key surfaces as a connection error instead
  of silently appearing as "no payees / no coverage."
- **Release workflow is signing-ready.** Code-signing variables are now
  sourced from optional, per-OS repo secrets, so signing becomes a drop-in
  change once certificates are available (no unsigned-build behaviour change in
  the meantime). README documents the first-launch SmartScreen/Gatekeeper
  bypass and that macOS auto-update needs a signed build.

### Added
- **Tax-parameter staleness warning.** Thresholds change every April 1; the app
  now shows a persistent banner when its bundled tax parameters haven't been
  re-verified since the most recent April 1 (or the current year has no
  parameters), prompting an app update before generating or filing a return.

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
