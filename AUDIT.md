# MiTax Project Audit

**Date:** 2026-07-02 · **Version audited:** 1.2.25 · **Scope:** full repository — Electron main process & IPC surface, renderer, statement parsers, tax engine, persistence, dependencies, build/release pipeline, and repo hygiene.

MiTax is an Electron desktop app that parses Caribbean bank-statement PDFs/CSVs, uploads transactions to LunchMoney, and computes Jamaica S04/S04A tax. Because it handles untrusted input files, financial-API credentials, and tax arithmetic, the findings below are weighted accordingly: input-parsing security and money-math correctness carry the highest severity.

Every finding was verified against source; file:line references point at the code as of commit `d458f5c`.

---

## Severity summary

| Severity | Count | Themes |
|---|---|---|
| Critical | 1 | Credential storage |
| High | 9 | EOL runtime, vulnerable PDF parser, IPC file access, update integrity, sign-convention bug, float money math, reconcile fragility, no tests |
| Medium | 9 | Timezone bugs, input validation, CSP, encryption at rest, CI gaps, doc drift |
| Low | 5 | Broken external links, error-handling gaps, duplication, stale tooling |

---

## Critical

### 1. LunchMoney API keys stored in plaintext
`src/lm-accounts.js:26,74-76`

The `lm_accounts` table defines `api_key TEXT NOT NULL` and inserts the raw key into `lunchmoney-tracker.db` under `app.getPath('userData')`. A LunchMoney API key grants full read/write access to the user's financial account. Anything with read access to the user's profile directory — other local processes, cloud backup sync, malware, or the app's own unrestricted `read-file` IPC handler (finding #4) — obtains the key.

Mitigating factors already present: the accounts-list projection deliberately omits `api_key` (`lm-accounts.js:38-41`), and keys are never sent to the renderer through `lm-accounts:*` responses.

**Fix:** encrypt with Electron's `safeStorage.encryptString()` before insert and decrypt on read in the main process only. Migrate existing rows on first launch (read plaintext → re-store encrypted). `safeStorage` uses the OS keychain/DPAPI and requires no new dependencies.

---

## High — security

### 2. Electron 29 is end-of-life
`package.json:22` (`"electron": "^29.0.0"`, resolves to 29.4.6)

Electron 29 (Feb 2024) left the supported window around August 2024 and receives no Chromium/V8/Node security backports. The app therefore inherits every unpatched Chromium CVE since — a serious exposure for an app that renders content derived from untrusted PDFs.

**Fix:** upgrade to a currently supported Electron major. This forces a `better-sqlite3` bump (currently 9.6.0; v11+ supports modern Electron ABIs) — the existing `postinstall: electron-builder install-app-deps` handles the rebuild. Budget for renderer/API deprecation sweeps.

### 3. `pdf-parse` is unmaintained and bundles an old, vulnerable pdf.js
`package.json:19` (`pdf-parse@^1.1.1`, resolves 1.1.4)

`pdf-parse` has had no meaningful maintenance in years and vendors an ancient `pdfjs-dist`. Old pdf.js versions are affected by CVE-2024-4367 (arbitrary JavaScript execution when parsing a malicious PDF). Parsing user-supplied bank-statement PDFs is MiTax's core function, so this is a live, reachable attack surface — a booby-trapped "statement" PDF is a realistic delivery vector.

**Fix:** migrate to maintained `pdfjs-dist` (≥ 4.2.67) or `unpdf`. The parsers already consume text + coordinates (`src/parsers/scotiabank.js` uses per-item coordinates), which pdfjs-dist provides directly via `getTextContent()`.

### 4. `read-file` IPC handler allows unrestricted arbitrary file read
`main.js:803-806`

```js
ipcMain.handle('read-file', async (event, filePath) => {
  const buffer = fs.readFileSync(filePath);
  return { buffer: buffer.toString('base64'), name: path.basename(filePath) };
});
```

Any renderer-reachable code can read **any file the user account can read** (SSH keys, browser cookie DBs, the app's own credential database from finding #1) and receive it base64-encoded. `parse-pdf` (`main.js:53`) and `reconcile-statement` (`main.js:229`) likewise pass renderer-supplied paths straight to the parser. Combined with the hand-escaped-`innerHTML` XSS surface (finding #15), one missed escape turns a crafted statement into full local file disclosure.

**Fix:** maintain a `Set` of paths returned by `open-file-dialog` (and drag-and-drop, if supported) and reject any `read-file`/`parse-pdf`/`reconcile-statement` call whose path is not in it. Additionally check the extension against the dialog filter (`pdf`, `csv`, `xlsx`).

### 5. No renderer sandbox and no navigation guards
`main.js:23-27` (window creation; `sandbox` omitted); no `will-navigate` or `setWindowOpenHandler` anywhere in `main.js`

The renderer parses and displays untrusted statement content without the OS-level sandbox, and nothing prevents the window from being navigated to an arbitrary origin. If navigation occurs, every privileged IPC handler (file read, exports, LunchMoney calls with stored keys) remains callable — no handler checks `event.senderFrame`.

**Fix:**
- Add `sandbox: true` to the `webPreferences` of both windows (`main.js:23-27`, `main.js:764`).
- Add `mainWindow.webContents.on('will-navigate', e => e.preventDefault())` and `setWindowOpenHandler(() => ({ action: 'deny' }))`.
- In high-value handlers, verify `event.senderFrame.url` matches the local index file.

### 6. Auto-update code-signature verification is disabled
`src/updater.js:23` — `autoUpdater.verifyUpdateCodeSignature = () => null;` (returns "verification passed" unconditionally)
Paired with `.github/workflows/release.yml:41` — `CSC_IDENTITY_AUTO_DISCOVERY: "false"` (builds are unsigned)

electron-updater still validates the SHA512 from `latest.yml` over HTTPS, so a pure network MITM is mitigated — but the disabled signature check removes the defense against a compromised release pipeline or rogue artifact. Side effects of shipping unsigned: macOS Gatekeeper blocks the app by default, **macOS auto-update does not work at all** (Squirrel.Mac requires a valid signature — the update flow advertised in the README is silently broken on Mac), and Windows shows SmartScreen "Unknown Publisher".

**Fix:** obtain a Windows code-signing cert and an Apple Developer ID, wire `WIN_CSC_LINK` / notarization into `release.yml`, and delete the `verifyUpdateCodeSignature` override. Until then, document clearly that macOS auto-update is non-functional.

---

## High — correctness

### 7. Sign-convention contradiction inside the Account Summary view
`renderer/app.js:3114` vs `renderer/app.js:3202`

Two interpretations of the same LunchMoney `amount` field, in the same view, are opposite:

```js
// Monthly buckets (app.js:3114): positive = income
if (amount > 0)  months[m].income   += amount;
else             months[m].expenses += Math.abs(amount);

// Per-transaction list (app.js:3202): negative = credit
const isCredit = amount < 0;   // rendered '+' and green
```

A positive-amount transaction is counted as income in the monthly table but displayed with a `−` and debit styling in the list directly beneath it. Given that uploads use `debit_as_negative: true` (`src/lunchmoney.js:295`) and the tax engine treats positive as income (`src/tax/s04.js:166`), **the per-transaction display at `app.js:3202` is the inverted one.** This most likely explains ongoing user-visible sign confusion despite repeated parser-side sign fixes (v1.2.17, v1.2.23, v1.2.24).

**Fix:** flip `isCredit` to `amount > 0` at `app.js:3202` (and swap the `+`/`−` rendering accordingly), then codify the convention once — see finding #23.

### 8. Floating-point arithmetic for currency throughout
`src/tax/s04.js:173,188,246,251,386,432`; `renderer/app.js:3114-3121`; parsers (`parseFloat` at `src/parsers/scotiabank.js:413,434`, `src/parsers/index.js:138`)

All money is IEEE-754 `number`. Sums accumulate float error (`expenses.total += absAmt`), rounding happens only at the very end (`roundJMD`/`r2`), and tax-band thresholds are compared against un-rounded floats (`s04.js:246,251`). For a tool that computes tax owed and files S04 figures, penny-level drift is a correctness and credibility issue.

**Fix:** represent money as integer cents from the parse boundary inward (`Math.round(parseFloat(s) * 100)`), do all accumulation and band comparison in integers, and format to decimal only at display/export boundaries. Alternatively adopt a small decimal library, but integer cents needs no dependency.

### 9. Reconcile matching is order-dependent; phantom-balance deletion is greedy
`main.js:246-289` (matching); `main.js:262-270` (deletion)

- Parsed transactions are keyed only by `` `${date}|${abs(amount).toFixed(2)}` ``. Two same-day transactions with the same absolute amount (e.g. two identical ATM withdrawals) pair against LunchMoney rows in arbitrary order via `matches[0]`/`matches.shift()` — a correct transaction can be flagged as a sign mismatch while the real mismatch is missed.
- Any LunchMoney transaction whose payee matches `BALANCE_RE` ("beginning/closing/opening balance", "balance forward", …) is offered for **deletion** regardless of amount or whether it corresponds to anything in the parsed statement. Deletion via `deleteTransaction` (`src/lunchmoney.js:420`) is irreversible.

**Fix:** include a normalized-payee component in the match key with fallback to date+amount; when duplicates remain, match pairwise by sign first so only genuinely mismatched rows are flagged. Scope phantom deletion to rows whose date+amount also appears as a balance-sentinel line in the parsed statement, and show amount+date in the confirmation UI.

### 10. Zero automated tests
No `test` script in `package.json`, no test files or directories anywhere in the repo.

The codebase is dominated by exactly the logic unit tests are best at protecting: 11 statement parsers, a sign-convention pipeline, and a tax calculator. The git history is a chain of shipped-blind regressions in that logic — v1.2.11 (coverage miscounts), v1.2.17 (inverted debit/credit across four parsers), v1.2.23/24/25 (Scotiabank sign and phantom-balance fixes). Every one of those fixes could regress again silently today.

**Fix (highest-leverage single change in this audit):**
- Add a test runner (`node:test` needs no dependency; vitest if preferred).
- **Golden-file parser tests:** commit sanitized text fixtures per institution; assert exact transaction lists (date, amount, sign, payee).
- **Sign-convention unit tests** around `applySignConvention` (`src/parsers/utils.js`) and the upload payload (`debit_as_negative`).
- **S04 unit tests:** known income/expense sets → expected tax per `TAX_PARAMS` year, including band boundaries.
- Wire into PR CI (finding #18).

---

## Medium

### 11. UTC/local timezone bug corrupts coverage tracking
`src/tracker.js:138-141,215,219,268`

`new Date("YYYY-MM-DD")` parses as **UTC midnight**, but `.getFullYear()`/`.getMonth()` read **local** time. In Jamaica (UTC−5), `2024-01-01` becomes `2023-12-31` locally, so `saveUpload`, `getMissingMonths`, and `getOldestUploadYear` attribute January statements to the prior December/year — corrupting the coverage grid and "missing months" report. The renderer already does this correctly with `Intl.DateTimeFormat('en-CA', { timeZone })` (`renderer/app.js:37-52`).

**Fix:** parse date-only strings with string slicing (`+d.slice(0,4)`, `+d.slice(5,7)`) instead of `Date` round-trips.

### 12. Scotiabank year inference silently defaults to the current year
`src/parsers/scotiabank.js:371-392` (fallback at `:376`); period-header regex at `:107`

If the `DDMMMYY to DDMMMYY` period header fails to match (layout variance), every transaction in the statement is silently assigned `new Date().getFullYear()`. A year-boundary or backlog statement gets misfiled with no warning. Also: `'20' + slice` hard-codes the century (`:379`) and `MONTH_MAP[mmm] || 1` coerces unrecognized months to January instead of rejecting the row (`:374`).

**Fix:** when the period header is unparseable, surface a parser warning and require user confirmation of the statement year rather than guessing; reject rows with unrecognized months.

### 13. CSV parsing collapses debit/credit columns and double-flips signs
`src/parsers/index.js:112,129-149`

`row['amount'] || row['debit'] || row['credit']` treats a value from a `credit` column identically to a `debit` value — no sign distinction. `applySignConvention` then unconditionally negates every amount, so a CSV already carrying signed amounts is double-flipped. `parseFloat(amountStr.replace(/[^0-9.\-]/g,''))` (`:138`) mangles accounting-negative `(1,234.00)`. The hand-rolled `splitCSVLine` (`:116-127`) doesn't handle escaped quotes or embedded newlines.

**Fix:** treat `debit` and `credit` columns as sign-bearing (credit → negate or not per the documented convention); support parenthesized negatives; consider a small CSV library (`csv-parse`) instead of the hand parser.

### 14. Parser output is not validated before upload
`src/parsers/utils.js:37` (unparseable dates returned verbatim); `src/parsers/index.js:74-78` (recognized-but-empty → `{success: true, transactions: []}`)

`normalizeDate` returns the original unparsed string when no pattern matches, which flows to LunchMoney as `date` and fails with an opaque API error at upload time. A recognized statement that parses to zero transactions reports success with no warning — silent wrong-data rather than a visible failure.

**Fix:** in the dispatcher, validate every transaction (`date` is real ISO, `amount` finite and non-zero) and warn on zero-transaction results before the file reaches the upload queue.

### 15. CSP allows `'unsafe-inline'` scripts; XSS safety rests on ~71 hand-escaped sinks
`renderer/index.html:6`; `renderer/app.js` (many `innerHTML` template literals)

`script-src 'self' 'unsafe-inline'` defeats most of the CSP's XSS protection. The renderer builds ~71 `innerHTML` strings; statement-derived data (payees, notes, account names — attacker-controllable via a crafted PDF) is escaped with `escHtml`/`escAttr` nearly everywhere, but the pattern is one missed call away from stored XSS, and numeric-id interpolations (`data-tx-id="${tx.id}"`, `app.js:3204`) bypass escaping on trust.

**Fix:** remove `'unsafe-inline'` from `script-src` (move any inline scripts/handlers to files) — this makes a missed escape far less exploitable. Longer term, replace hand-escaped `innerHTML` with a small DOM-builder helper that escapes by construction.

### 16. `export-s04-pdf`: renderer HTML executed with JS at a fixed temp path; resources leak on error
`main.js:757-788`

The handler writes renderer-supplied HTML to a **fixed, predictable** temp filename, loads it in a hidden window with `javascript: true` (`:764`), waits a fixed 900 ms (`:769` — a race on slow layouts, wasted time on fast ones), and cleans up only on the success path: if `loadURL`/`printToPDF`/the save dialog throws, `printWin.destroy()` and `fs.unlinkSync(tmpPath)` are skipped, leaking a hidden BrowserWindow and the temp file per failure.

**Fix:** disable JavaScript in the print window; use `fs.mkdtemp` for a unique path; replace the sleep with `did-finish-load`; wrap cleanup in `finally`.

### 17. Financial and tax data unencrypted at rest
`src/tracker.js`, `src/filings.js`, `src/p24.js`

Uploads, filings, P24 employment-income entries, and transaction-id lists live in plaintext SQLite in userData. Lower urgency than the API key (finding #1) but the same `safeStorage`-based approach — or SQLCipher — covers it.

### 18. No CI on pull requests; release workflow uses `npm install`
`.github/workflows/release.yml` is the only workflow (tag-triggered); `:35` runs `npm install` despite a committed lockfile

PRs merge with zero automated checks. Release builds can drift from the lockfile. No Dependabot, CodeQL, or dependency caching. Note also: no `v*` git tags exist in the repo despite the tag-driven workflow — worth confirming releases are actually being cut.

**Fix:** add a `ci.yml` on `pull_request`/`push` running `npm ci` + lint + tests (once finding #10 lands); switch `release.yml` to `npm ci`; enable `actions/setup-node` caching and Dependabot.

### 19. Version and documentation drift
- `CHANGELOG.md` stops at **1.2.17** while the code is at **1.2.25** — eight releases (including Smart Reconcile) undocumented.
- `README.md` is still titled "LunchMoney Importer — Jamaica Edition", says `cd LunchMoneyApp`, contains a stale `GITHUB_USERNAME_HERE` placeholder, and omits the JN Bank (`src/parsers/jn.js`) and UNFCU (`src/parsers/unfcu.js`) parsers plus several `src/` modules from its file-structure section.
- `build.bat` still prints "LunchMoney Importer — Build".
- Node version inconsistent: CI pins 20, README/build.bat say "18+"; no `.nvmrc`.
- `package.json` copyright says "© 2025"; publish target is `Bertitude/MiTax` while branding is FuzionWorks — confirm that's the real release repo or update checks will 404.

---

## Low

### 20. External-link buttons are broken: `require('electron')` in the renderer
`renderer/app.js:1669,3702`

With `contextIsolation: true` / `nodeIntegration: false`, `require` is undefined in the renderer — these `shell.openExternal` calls throw at runtime. **Fix:** add an `open-external` IPC handler that whitelists the specific URL(s) and expose it via the preload.

### 21. Inconsistent error handling in main process
- Tracker handlers (`main.js:139-169`) have no try/catch, unlike every other handler — a `better-sqlite3` throw reaches the renderer as a raw rejection instead of `{success: false}`.
- No global `process.on('uncaughtException'/'unhandledRejection')` in the main process.
- `get-dashboard-data` (`main.js:548-550`) and `check-duplicates` (`main.js:609-613`) swallow errors and return `success: true` with partial data — the renderer can't distinguish "no data" from "API failed" (the duplicates case is intentionally fail-open; the dashboard case looks unintentional).

### 22. Stuck-spinner error paths in the renderer
`renderer/app.js:517-550` (`parseAll`), `:2903-2912` (reconcile)

Button re-enable is not in `finally`; an unexpected rejection or early error return leaves the UI stuck on "Parsing…". Only 19 try/catch/`.catch` sites across ~4,000 renderer lines. **Fix:** wrap async UI actions in try/finally around the busy-state toggle.

### 23. Duplicated and contradictory sign/parsing logic
- `cleanPayee` re-implemented per parser with different allow-lists (`scotiabank.js:527`, `generic.js:202`, …).
- `BALANCE_RE`/balance-line regex duplicated between `scotiabank.js:48` and `main.js:244`.
- Coordinate row-bucketing copy-pasted (`scotiabank.js:120-133` vs `:247-256`).
- Sign-convention comments contradict across pipeline stages (`generic.js:5-7` says positive = debit; `utils.js:53-64` says negative = debit). This ambiguity is the root cause of the recurring sign bugs.

**Fix:** extract shared helpers into `src/parsers/utils.js` and write **one** authoritative sign-convention doc comment there stating the invariant at each pipeline stage (raw parser output → `applySignConvention` → LunchMoney upload).

### 24. Tooling gaps and minor debt
- `node-fetch@2` is likely removable (Node 20 and Electron both ship global `fetch`).
- No ESLint, no Prettier/`.editorconfig`.
- `renderer/app.js` is a 3,982-line monolith with a single shared mutable `state` global — split by tab/feature when convenient (parse queue, reconcile, account view, tax views, settings).

---

## What's done well

- **Electron security baseline is correct:** `contextIsolation: true` + `nodeIntegration: false` on every window, with a bounded `contextBridge` API using fixed channel names (no dynamic channel passthrough). This is the app's strongest area.
- **No SQL injection:** `better-sqlite3` prepared statements with bound parameters throughout.
- **Consistent `{success, error}` IPC envelope** on nearly all handlers; principled retry/backoff with an explicit retryable-error allow-list in `src/lunchmoney.js:20-38`.
- **Credential hygiene in projections:** `api_key` deliberately omitted from the accounts-list query; keys never cross the IPC boundary to the renderer.
- **Clean cross-platform release automation:** single workflow building Windows/macOS (x64+arm64)/Linux, correct `asar` + `asarUnpack` for native modules, all platform icons present, correct `postinstall` native rebuild.
- **Privacy-conscious `.gitignore`:** `*.db`, `*.db-journal`, `userData/` keep user financial data out of version control.
- **Tax parameters carry provenance** (`source`/`verifiedAt` in `TAX_PARAMS`) with a fallback-warning path.
- Detailed, specific CHANGELOG entries (when they're written).

---

## Recommended remediation order

**Phase 1 — quick wins (hours each):**
1. Fix the Account Summary sign inversion (#7) — one-line logic flip plus display swap.
2. Path allow-list for `read-file`/`parse-pdf`/`reconcile-statement` (#4).
3. Tracker timezone fix (#11) — string-slice date parsing.
4. `sandbox: true` + navigation guards (#5).
5. Fix broken `openExternal` buttons via a whitelisted IPC handler (#20).
6. try/finally around renderer busy states and tracker handlers (#21, #22).

**Phase 2 — foundation (days):**
7. Test harness: golden-file parser tests, sign-convention tests, S04 unit tests (#10).
8. PR CI with `npm ci` + tests; Dependabot (#18).
9. Electron upgrade off EOL 29 + better-sqlite3 bump (#2).
10. Replace `pdf-parse` with maintained `pdfjs-dist`/`unpdf` (#3).
11. Consolidate sign convention into one documented invariant; dedupe parser helpers (#23).

**Phase 3 — deeper work:**
12. `safeStorage` encryption for API keys, then broader at-rest encryption (#1, #17).
13. Integer-cents money representation (#8).
14. Reconcile matching redesign with payee-aware keys and scoped phantom deletion (#9).
15. Code signing + notarization; remove the signature-verification override (#6).
16. CSP hardening and DOM-builder rendering (#15); docs/version sync (#19).
