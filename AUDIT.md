# MiTax Project Audit — v1.3.0 (post-remediation)

**Date:** 2026-07-08 · **Version audited:** 1.3.0 (commit `1a3eaaf`) · **Scope:** full repository — follow-up to the 2026-07-02 audit of v1.2.25.

This is a fresh audit of the codebase after the v1.3.0 remediation release (PR #7). Every prior finding was re-verified against current source, and all new/changed code (pdfjs extraction, reconcile engine, integer-cents tax math, safeStorage key encryption, hardened IPC surface, test suite) was reviewed in depth. High-severity claims below were confirmed **by executing the code**, not just by reading it.

**Baseline:** all 27 tests pass (`npm test`); `npm audit` reports 1 moderate advisory (js-yaml quadratic-complexity DoS, transitive via `electron-updater`/`electron-builder`). electron 41.9.2 · pdfjs-dist 4.10.38 · better-sqlite3 12.11.1.

---

## Prior findings — remediation status (24)

| # | Prior finding | Status | Evidence |
|---|---|---|---|
| 1 | Plaintext API keys | **Fixed** | safeStorage encryption (`lm-accounts.js`); the localStorage plaintext mirror that nullified it (N1) was removed 2026-07-08 — the key now stays main-process-side |
| 2 | Electron 29 EOL | **Fixed** | electron 41.9.2 |
| 3 | Vulnerable pdf-parse | **Fixed** | pdfjs-dist 4.10.38 with `isEvalSupported:false` (`src/pdf/extract.js:33`); lifecycle gaps → N13 |
| 4 | Unrestricted `read-file` IPC | **Fixed** | Handler deleted; `allowedFiles` allow-list enforced in `parse-pdf`/`reconcile-statement` (`main.js:94,318`); minor symlink gap → N20 |
| 5 | No sandbox / nav guards | **Mostly fixed** | `sandbox:true` + `hardenWindow()` on both windows (`main.js:18-21,64,808`); `senderFrame` checks never added → N8 |
| 6 | Update signing disabled | **Not fixed** | `src/updater.js:23` override intact; `CSC_IDENTITY_AUTO_DISCOVERY:"false"` (`release.yml:42`) → N6 |
| 7 | Account-view sign inversion | **Fixed** | `isCredit = amount > 0` (`renderer/app.js:3284`) agrees with monthly buckets and `debit_as_negative:true` |
| 8 | Float money math | **Mostly fixed** | S04 core is integer-cents with a clean single boundary (`s04.js:221-267,398-433`); S04A still float → N4/N24 |
| 9 | Reconcile fragility | **Mostly fixed** | Deterministic pure module (`src/reconcile.js`), sentinel-scoped deletion; one masking edge → N10 |
| 10 | Zero tests | **Partially fixed** | 27 tests + CI, but 7 of 9 parsers untested — exactly where new Highs N2/N3 live |
| 11 | Tracker timezone bug | **Fixed** | All four sites replaced with `date-utils` string-slice helpers (`tracker.js:139,211,217`) |
| 12 | Scotia silent year default | **Fixed** | Missing-period-header warning (`scotiabank.js:117`); unrecognized months rejected with warning (`:381`) |
| 13 | CSV sign collapse / double-flip | **Mostly fixed** | debit/credit are sign-bearing, parens negatives handled, pinned by tests; two edge bugs remain → N12 |
| 14 | Parser output unvalidated | **Fixed** | `validateResult` drops bad dates/amounts with warnings, flags zero-transaction results (`parsers/index.js:102-130`) |
| 15 | CSP `'unsafe-inline'` scripts | **Mostly fixed** | `script-src 'self'`, zero inline handlers; `style-src 'unsafe-inline'` remains and 2 of ~70 sinks unescaped → N16, N22 |
| 16 | export-s04-pdf races/leaks | **Fixed** | `mkdtempSync`, `javascript:false`, `loadFile` await, cleanup in `finally` (`main.js:792-837`); no CSP on temp doc → N21 |
| 17 | Data unencrypted at rest | **Not fixed** | tracker/filings/p24 SQLite still plaintext (keys-only remediation) |
| 18 | No PR CI | **Fixed** | `ci.yml` on push+PR with `npm ci`, least-privilege permissions; `release.yml` uses `npm ci` |
| 19 | Version/doc drift | **Partially fixed** | README/CHANGELOG refreshed for 1.3.0, but 1.2.18–1.2.25 still undocumented and CHANGELOG misdocuments the sign convention → N18, N28 |
| 20 | Broken `openExternal` | **Fixed** | Allow-listed `open-external` IPC (`main.js:106-117`); zero `require(` in renderer |
| 21 | Inconsistent main-process errors | **Fixed** | Global crash handlers (`main.js:36-42`); tracker handlers wrapped in try/catch |
| 22 | Stuck-spinner busy states | **Partially fixed** | `parseAll`/`startReconcile` fixed; `uploadValidated`, reconcile-apply and others still lack try/finally → N17 |
| 23 | Duplicated/contradictory sign logic | **Partially fixed** | One documented `applySignConvention` invariant, applied once per parser — but five pass-through parsers violate it → N2 |
| 24 | Tooling debt | **Partially fixed** | Tests+CI exist; node-fetch still a dep, no ESLint, `renderer/app.js` still a ~4k-line monolith |

**Bottom line:** the remediation was real — 10 findings fully fixed, and the fixed paths (Scotiabank, CSV happy path, S04 annual math, IPC surface) are solid. But two of the headline fixes were undermined by follow-on bugs: the key-encryption work was nullified by a plaintext localStorage mirror (N1 — **now resolved**), and the sign-convention consolidation exposed that five untested parsers systematically violate the new invariant (N2).

---

## New findings — severity summary

| Severity | Count | Themes |
|---|---|---|
| Critical | 1 | Encrypted API key re-persisted in plaintext |
| High | 6 | Parser sign inversions, JMMB crash, PayPal dates, S04A due dates & months math, unsigned updates |
| Medium | 13 | Crypto fallback gaps, IPC hardening, reconcile edge, upload duplication, CSV/PDF gaps, tax params, XSS sinks, busy states |
| Low | 9 (grouped) | Reconcile UX, tax/date nits, API-layer nits, docs/hygiene |

---

## Critical

### N1. Decrypted API key round-trips to the renderer and is re-persisted in plaintext localStorage — **RESOLVED 2026-07-08**
`renderer/app.js:8,1680,1822,1837,1859`; `main.js:397-448` (`lm-accounts:get-active/add/switch` return the decrypted `api_key`)

The v1.3.0 safeStorage work encrypts keys in SQLite — and then the renderer immediately writes the same key back in plaintext: `localStorage.setItem('lm_api_key', …)` on connect (`:1680`), add (`:1822`), switch (`:1837`), and remove (`:1859`), and reads it into `state.apiKey` at startup (`:8`). The legacy-migration path never calls `removeItem`. The plaintext key therefore sits permanently in Chromium's Local Storage leveldb inside the **same `userData` directory** the encryption was meant to protect — any local process, backup sync, or malware reading the profile recovers it, encryption or not. The prior audit's praise that "keys never cross the IPC boundary" is no longer true.

**Fixed:** the key is now resolved entirely in the main process. A shared `activeApiKey()` (`main.js`) supplies the decrypted active key to every LunchMoney handler, which no longer accepts an `apiKey` from the renderer; the account handlers (`get-active`/`switch`/`remove`) return a `publicAccount` projection that strips `api_key` and exposes only a `connected` flag. The renderer keeps `state.connected` (boolean) instead of the key, no longer writes `lm_api_key` to localStorage, and deletes any pre-1.3 plaintext key from localStorage after migrating it. Also (companion to N26): `decryptKey` now returns `null` on failure instead of the raw ciphertext, so a keychain reset surfaces as "not connected" rather than a ciphertext blob silently used as a key.

---

## High

### N2. Five untested parsers silently produce sign-inverted or fabricated amounts — **RESOLVED 2026-07-08**
All verified by executing the parser modules. `applySignConvention` (`parsers/utils.js`) flips every amount at the boundary on the assumption that parsers emit bank-convention (positive = debit) values — these parsers emit user-convention or broken values, so the flip corrupts them:

- **Wise** (`wise.js:29,47,67`): amounts are already signed user-convention; pass-through + flip inverts everything. "Received money … 1,500.00" → **−1500 (expense)**.
- **Stripe** (`stripe.js:23,42`): payout net amounts are positive money-in; all Stripe revenue becomes expenses ("Charge … 96.80" → **−96.80**).
- **PayPal** (`paypal.js:30,42,62`): same inversion for received payments.
- **NCB** (`ncb.js:27,91`): the main regex requires wide spacing that real two-number rows never have, so everything falls to a fallback that assumes `amounts[0]` is a debit — "SALARY PAYMENT 500.00 10,500.00" → **−500** with the amount text left inside the payee. The `-amounts[1]` branch at `:91` is unreachable.
- **generic** (`generic.js:159-168,148-151`): the header column map assigns ordinals assuming every monetary column is populated, so a row with an empty debit cell has its credit land in the debit slot ("SALARY DEPOSIT 500.00 10,500.00" under a Debit/Credit header → **−500**); and the DR/CR-suffix rule doesn't exclude the balance column — "…5,000.00 105,000.00 CR" emits the **balance +105,000 as Income**.

For a tax app this is worse than a crash: wrong-sign data uploads silently and flows into S04 income figures. None of these paths have tests (prior finding #10's gap).

**Fixed:** Wise/Stripe/PayPal now negate their user-convention amounts to the internal convention before the boundary flip; NCB and the generic parser infer debit vs credit from the **running-balance delta** (new `signedByBalanceDelta` in `parsers/utils.js`), with an opening-balance seed and a payee-keyword fallback for the first row. The generic parser now only trusts positional column mapping when the row's amount count matches the header's column count, and ignores a DR/CR marker on the balance (last) amount. Golden fixtures + tests added for JMMB, NCB, Wise, Stripe, PayPal, and the generic empty-cell/balance-CR cases. **Note:** only PayPal was validated against a real statement; the NCB/JMMB/Wise/Stripe/generic fixes are validated against synthetic fixtures encoding the documented conventions and should be spot-checked against a real statement when one is available.

### N3. JMMB parser crashes on every statement; latent balance-as-amount bug behind it — **RESOLVED 2026-07-08**
`jmmb.js:57` references `accountNumber`, which is never defined — every JMMB parse threw `ReferenceError` (verified), surfaced to users as a generic parse error. The two-amount heuristic also took the **running balance** as the transaction amount whenever balance > amount, i.e. almost always.

**Fixed:** `accountNumber` is derived from `accountMatch` (last 4 digits); the transaction amount is always the first number, with the second treated as the running balance and used for balance-delta sign inference (opening-balance seed + keyword fallback). Fixture + test added.

### N4. PayPal dates are MM/DD/YYYY but parsed as DD/MM — months and days swapped — **RESOLVED 2026-07-08**
`paypal.js:19` routed dates through `normalizeDate`, whose DD/MM branch (`utils.js:17`) matches every slash date first. Verified: `7/4/2024` (July 4) → `2024-04-07`.

**Fixed:** added `parseMDY` to `parsers/utils.js` and the PayPal parser now uses it (month-first), so `7/4/2024` → `2024-07-04`. Pinned by a test that also documents the `normalizeDate` day-first behaviour. *(The `normalizeDate` DD/MM-first default is retained for the Caribbean bank parsers that depend on it.)* Note: PayPal often syncs to LunchMoney directly, so this parser may see little real-world use — but it is reachable via file upload and is now correct.

### N5. S04A due dates are malformed; "past due" detection can never fire and corrupt dates are persisted — **RESOLVED 2026-07-08**
`s04.js:511-513`: `due` is `'Mar 15'`, so `` `${year}-${due.replace('Mar','03')…}-15` `` yields `"2026-03 15-15"` — an Invalid Date. Consequently `isPast` is always false, the renderer's overdue badge (`app.js:3614`) can never appear, and saving a quarter persists the malformed string into `tax_filings.due_date`, which filing history then renders as "Invalid Date". The S04A test asserts only `quarters.length === 4`.

**Fixed:** `S04A_DUE_DATES` now stores `{month, day, dueLabel}`; `dueDate` is built as valid `${year}-MM-DD` and `isPast` is a lexicographic `todayStr > dueDate` compare. Renderer trusts the server `q.isPast`. Pinned by tests.

### N6. S04A `monthsElapsed` overcounts by ~1 month, distorting provisional-tax recommendations — **RESOLVED 2026-07-08**
`s04.js:490`: `(now.getMonth() + 1) + (now.getDate() / 31)` counts the current partial month as a full month *and* adds its day fraction (Jan 31 → 2.0 months when 1.0 has elapsed). Verified scenario: steady J$1M/month income, generated 2026-07-08 → annualized trend J$10.35M instead of ~J$12M → trend ratio 0.86 trips the ±10% adjustment and recommended quarterly drops from the correct $200,000 to $172,498 — a ~$110k/year provisional-tax underpayment for a filer whose income is flat. The dashboard's own formula (`main.js:536`, `getMonth() + date/30.5`) is the correct shape; the two disagree by ~1 month on the same date. Related: generating S04A for a **past** year (`main.js:740-743`) fetches YTD through *today* (a multi-year window) but still divides by ≤12.26 months, inflating the trend ~2.5× in the verified example.

**Fixed:** `monthsElapsed = (month-1) + day/daysInMonth` (string-sliced `todayStr`, no Date round-trip); fully-past years use 12 months, and the `generate-s04a` handler clamps the LunchMoney fetch window to `min(todayStr, ${currentYear}-12-31)`. Pinned by tests.

### N7. Auto-update code-signature verification still disabled; builds still unsigned *(carried: prior #6)*
`src/updater.js:23` (`verifyUpdateCodeSignature = () => null`) + `release.yml:42`. With `autoInstallOnAppQuit:true` and silent NSIS install, anyone who can publish a release to the configured repo ships arbitrary code; the SHA512 in `latest.yml` comes from the same release the attacker controls. macOS auto-update remains silently broken (Squirrel requires a valid signature).

**Fix:** unchanged from the prior audit — certs + notarization in `release.yml`, delete the override.

---

## Medium

### N8. No `senderFrame` validation on privileged IPC handlers
`main.js` — zero occurrences of `senderFrame` (verified). Prior finding #5 recommended it; sandbox+nav-guards landed, the sender check didn't. Any code execution in the renderer (or a sub-frame) can directly invoke `apply-reconciliation` (irreversible deletes), `export-s04-pdf`, `open-external`. **Fix:** shared guard asserting `event.senderFrame.url` is the local `index.html` top frame on mutating handlers.

### N9. `apply-reconciliation` accepts unvalidated IDs that are string-interpolated into API URL paths
`main.js:346-371` does no shape check on `flipIds`/`deleteIds`; `lunchmoney.js:359,367,421` builds `` `/transactions/${txId}` ``. A compromised renderer can send `deleteIds:["group/123"]` → `DELETE /v1/transactions/group/123`, or steer requests via crafted fragments. **Fix:** `filter(Number.isInteger)`, cap lengths, `encodeURIComponent` in `lunchmoney.js`.

### N10. Reconcile pairing prefers same-sign-any over payee-exact opposite-sign, masking flips in equal-magnitude ± pairs
`reconcile.js:73-76`. Verified: statement `SALARY +50000` / `RENT −50000` same day, both LM rows sign-flipped → **0 mismatches** (each flipped row pairs cross-payee with the other's statement tx). This is exactly the flip-bug class reconcile exists to catch. **Fix:** candidate order `same-sign+payee` → `opposite-sign+payee (flag)` → `same-sign-any` → `opposite-any`.

### N11. Non-idempotent POST `/transactions` is blindly retried on 5xx
`lunchmoney.js:70-75` retries any 429/5xx regardless of method. A commit-then-500 (or timeout-after-write) re-inserts the whole batch → duplicate transactions whenever `skipDuplicates` is off. **Fix:** restrict blind retry to GET; for POST retry only on network-error-before-response/429.

### N12. CSV edge bugs: `0.00` debit shadows a real credit; quoted embedded newlines drop rows
`parsers/index.js:211` tests string truthiness, so `…,0.00,500.00` (debit,credit) parses as **amount 0** instead of +500 (verified) and uploads. `index.js:136-140` splits records on raw `\n` before quote-aware parsing, so a quoted multi-line field silently loses the transaction (verified; no warning in multi-row files), and headers use naive `split(',')`. **Fix:** prefer the nonzero parsed value; scan records with quote state; count drops into `warnings`.

### N13. pdfjs documents are never destroyed; PDFs parsed twice; no password handling
`src/pdf/extract.js:33,52-77` — no `doc.destroy()`/`cleanup()` and no try/finally, so every parsed statement permanently retains a `PDFDocumentProxy` in the long-lived main process; coordinate parsers additionally load each PDF twice (`extractText` + `extractPageItems`). Password-protected statements (common for Caribbean banks) reject with a raw `PasswordException` and no user-facing message. **Fix:** `finally { await doc.destroy() }`; single-pass extraction; catch `PasswordException` → targeted error.

### N14. Dashboard quarterly estimate bypasses `getTaxParams`
`main.js:535` — `TAX_PARAMS[year] || TAX_PARAMS[2025]`: any year without an entry (2027+) silently uses **2025** params instead of nearest-earlier, overstating annual tax by ~J$19.3k above threshold, with no fallback warning. **Fix:** `getTaxParams(year)`.

### N15. TAX_PARAMS threshold convention was internally inconsistent across years — **RESOLVED 2026-07-08**
`s04.js:35,48` — the 2026 entry used TAJ's weighted full-year-effective threshold (1,876,614), but 2024/2025 used raw post-April-1 values despite those increases also being effective April 1. Verified against TAJ's published guidance ([JIS technical advisory](https://jis.gov.jm/taj-develops-technical-advisory-for-revised-income-tax-threshold-and-pension-exemptions/), [Dawgen Global 2024 payroll changes](https://www.dawgen.global/understanding-the-new-changes-to-payroll-taxes-in-jamaica-a-closer-look-at-the-increased-income-tax-threshold-and-exemptions/), [JIS April 2026 increase](https://jis.gov.jm/increase-in-income-tax-threshold-now-in-effect/)): the pro-rated convention is TAJ's official one, so 2024/2025 were understating tax by ~J$12.5k/~J$6.2k for above-threshold filers. **Fixed:** 2024 → 1,650,090 and 2025 → 1,774,470 (TAJ's published figures), pinned by tests; a params-staleness banner now warns when `TAX_PARAMS` haven't been re-verified since the most recent April 1 (`taxParamsStatus` in `s04.js`, surfaced via `tax-params:status`).

### N16. Two unescaped `innerHTML` sinks interpolate statement-derived strings
`renderer/app.js:493-495` (`item.parsed.institution/accountName/period` and `item.path` — accountName is extracted verbatim from PDF text, i.e. attacker-influenced via a crafted statement) and `:642` (period strings); `:2350-2356` renders S04 `report.notes` unescaped (app-generated today, an injection point tomorrow). CSP (`script-src 'self'`) blocks script execution, so impact is HTML/UI spoofing — but this is the missed-escape class finding #15 warned about. Of ~70 sinks sampled, all others escape correctly. **Fix:** wrap in `escHtml`.

### N17. Busy-state and partial-failure reporting regressions
- `renderer/app.js:3097-3115` (reconcile apply): the `await` has no try/finally — an IPC rejection leaves the button stuck on "Applying…" with the user unable to tell whether deletions executed. `uploadValidated` (`:1109-1234`), `saveS04Filing`, `applyPayeeUpdates` similarly lack try/finally (CHANGELOG 1.3.0's "no more stuck spinners" overstates).
- `main.js:352-365` flattens flip failures to bare strings (tx id dropped) and discards `skipped` entirely; on success-with-errors the renderer closes the modal and shows only an error **count** — the user can never learn which irreversible deletes failed. **Fix:** structured `{failedFlips, skipped, failedDeletes}`; keep the modal open and list failing rows.

### N18. CHANGELOG actively misdocuments the live sign convention; 1.2.18–1.2.25 still missing *(carried: prior #19)*
`CHANGELOG.md:68` (1.2.17 entry) documents "**positive = expense/debit**" — the exact opposite of the shipped convention (`lunchmoney.js:295`, `debit_as_negative: true`) — with no later entry recording the reversal, and eight versions remain undocumented even though code comments reference them ("pre-v1.2.18 sign-flip bug"). For a codebase whose recurring bug class is sign confusion, the changelog is part of the attack surface. **Fix:** add a corrective note + backfill entries.

### N19. Reconcile's sign comparison rides on LunchMoney's *default* GET sign convention
`lunchmoney.js:176-201` never pins `debit_as_negative` on GET while uploads pin it on POST (`:295`). If LM's GET default differs (or changes), every expense false-flags as a mismatch and Apply corrupts correct data. Works today by inheritance; should be pinned explicitly (`params.append('debit_as_negative','true')`). Also confirm `DELETE /v1/transactions/:id` is a supported public endpoint — if not, every phantom deletion fails at runtime.

---

## Low

### N20. Path allow-list is not symlink/swap-resistant
`main.js:120-134` — `register-statement-file` validates with `statSync` (follows symlinks), never canonicalizes, and the Set is never pruned; enforcement re-checks string membership only (TOCTOU window). Low exploitability (renderer can't create symlinks). **Fix:** `realpathSync` at registration, re-`lstat` at parse.

### N21. Print window loads report HTML with no CSP — remote sub-resources fetch during export
`main.js:792-837` — `javascript:false` blocks scripts, but `<img src="http://…">` in report HTML beacons out during `printToPDF`. **Fix:** inject a `default-src 'none'` meta CSP into the temp HTML.

### N22. `style-src 'unsafe-inline'` remains in the CSP *(carried: prior #15 residue)*
`renderer/index.html:6` — residual CSS-exfiltration channel if an injection sink is hit (see N16). Meta-only delivery is a platform constraint for `loadFile`; acceptable.

### N23. Reconcile scope/UX gaps
One-directional: statement transactions missing from LM and duplicate LM rows are silently dropped (`reconcile.js:89`), then the UI declares "All transactions match" — false reassurance for exactly the missed-upload/double-upload cases. LM fetch spans the whole selected year vs a ~1-month statement, so every balance-payee row in the year reappears as a suspected phantom on each run, and a year-mismatch yields "all match" instead of a no-overlap warning (`main.js:316-339`). `balanceSentinels` are only emitted by the Scotiabank coordinate path (`scotiabank.js:122,161`) — "confirmed phantom" structurally doesn't exist for other institutions or the Scotia regex fallback. The final confirm dialog merges confirmed+suspected into one "delete N phantoms" count (`app.js:3088-3095`), and multi-selected files silently reconcile only the first (`app.js:2938`).

### N24. Tax/date nits
~~`generateS04A` still computes in float `r2` — 4× quarterly can differ from the cents-based annual by cents~~ **(resolved 2026-07-08: `splitInstalments` splits the annual in integer cents, Q4 carrying the remainder, so the four instalments sum exactly);** `methodUsed` label ignores `manualData.useActualExpenses` (`:313`); `buildMonthlyBreakdown` ignores `userCategoryMappings` so monthly income can exceed `grossIncome`, and unclassified credits are silently excluded from gross income rather than defaulting to `other` (`:436-459`); renderer still derives "today" from UTC (`app.js:814,2367,2669` — after 7 PM in Jamaica the filed-date defaults to tomorrow); `yearMonthOf` accepts month `00`–`99` (`date-utils.js:16`); `getMostRecentS04` ties on same-second saves (`filings.js:121` — add `, id DESC`).

### N25. LunchMoney API-layer nits
No request timeout (node-fetch v2 default: none) — a stalled connection hangs uploads forever (`lunchmoney.js:56`); 429 handling ignores `Retry-After`; `getPayees`/`getAssetMonthCoverage` swallow all errors into empty results, making auth failure indistinguishable from no-data (`:154-172,210-219`).

### N26. Key-storage secondary gaps
~~`decryptKey` returns the raw **ciphertext as if it were the key** on decrypt failure~~ **(resolved 2026-07-08: returns `null`, surfacing as "not connected");** `keyStorageInsecure` is still computed from `encryptionAvailable()` rather than what was actually stored, so a transient `encryptString` throw stores plaintext while reporting secure (`:27-31,92`); lazy migration re-encrypts only the *active* account and never scrubs old plaintext pages (no `secure_delete`/VACUUM) (`:82-90`); `api_key UNIQUE` is vestigial under non-deterministic ciphertext and the decrypt-and-scan dedupe fails open on decrypt failure (`:54,111-114`); the insecure-storage warning is a single 4-second toast, once per install (`app.js:193-196`).

### N27. Parser nits
Detection order routes a statement mentioning "Scotiabank" in a payee to the Scotiabank parser (`parsers/index.js:31-35`); generic's two-amount fallback and header-mapped path give the same unsigned row opposite signs (`generic.js:173,186-189`); JN drops wrapped description continuation lines and its em-dash payee join leaves double spaces (`jn.js:126-127,207-210`); a Scotia date-row whose amount never arrives is discarded without warning (`scotiabank.js:151,181-183`); `reflowItems` deviates from pdf-parse for `y=0` baselines despite the "replicates exactly" comment (`extract.js:45`).

### N28. Docs/hygiene
README still names `LunchMoney-Importer-Setup-*.exe` artifacts (productName is `MiTax`), says `cd LunchMoneyApp`, references the removed `GITHUB_USERNAME_HERE` step, claims Node "v18+" (CI pins 20; better-sqlite3 12 needs ≥20), and points Data Storage at `lunchmoney-importer/` paths; `build.bat:3,8` still says "LunchMoney Importer"; `package.json:29` copyright says © 2025; no `v*` git tags exist despite the tag-driven release workflow; js-yaml moderate advisory (via electron-updater at runtime — it parses `latest.yml`); node-fetch remains removable in favor of global fetch.

---

## What's done well

- **The remediation held up where it was applied.** The IPC surface is genuinely hardened: the arbitrary-read handler was deleted (not wrapped), the path allow-list is enforced in every path-accepting handler, `open-external` is written the *correct* way (normalized href + trailing-slash prefix + https-only — resistant to userinfo/subdomain bypasses), and the print-window flow fixed all four prior defects.
- **The integer-cents S04 core is a clean single-boundary design** — convert in once, compute entirely in cents, convert out in one block; no mixed-unit comparison exists anywhere in the annual path, and every subtraction is floor-guarded.
- **The reconcile rewrite is deterministic and safe-by-default**: multi-key sort + splice consumption survives input permutation; suspected phantoms render unchecked with warnings; sentinel matching is robust to sign/representation drift; 404s skip instead of failing the batch.
- **`src/pdf/extract.js` is a careful pdf-parse replacement** — `isEvalSupported:false` addresses the CVE vector, the pure/IO split makes coordinate parsers testable without PDFs, and the fixtures use it.
- **Escaping discipline is near-total** (2 misses in ~70 sinks), the CSP now has no inline scripts, and API keys never appear in logs or error messages.
- **CI is real**: push+PR tests with `npm ci`, least-privilege permissions, and the 27-test suite pins the previously regression-prone Scotiabank/CSV/S04 paths.

---

## Recommended remediation order

**Phase 1 — stop the bleeding (hours each):**
1. ~~Delete the localStorage key mirror; resolve keys main-process-side (N1)~~ — done 2026-07-08.
2. ~~Fix the five parser sign inversions + JMMB crash + PayPal dates (N2–N4)~~ — done 2026-07-08, with golden fixtures + tests for JMMB/NCB/Wise/Stripe/PayPal/generic (only PayPal validated against a real statement).
3. ~~S04A due-date format and `monthsElapsed` (N5, N6)~~ — done 2026-07-08 (N5, N6, and the N24 instalment rounding resolved together).
4. Validate/encode IDs in `apply-reconciliation` (N9); pin `debit_as_negative` on GET (N19).

**Phase 2 — harden (days):**
5. `decryptKey` failure path + storage-security flag from stored value + migrate-all-rows (N26); persistent insecure-storage banner.
6. `senderFrame` guard on mutating handlers (N8); realpath in the allow-list (N20).
7. POST retry idempotency (N11); CSV zero-debit/newline fixes (N12); pdfjs destroy/password handling (N13).
8. Escape the two missed sinks (N16); try/finally sweep + structured apply-errors (N17).
9. Dashboard `getTaxParams` (N14). ~~Verify 2024/2025 thresholds with TAJ (N15)~~ — done 2026-07-08; values corrected.

**Phase 3 — finish the story:**
10. Code signing + notarization; remove the verification override (N7).
11. Reconcile bidirectional reporting + period-scoped fetch + sentinel coverage beyond Scotia (N10, N23).
12. Changelog backfill + sign-convention corrective note; README/build.bat sweep; tag releases (N18, N28).
13. Carried structural items: at-rest encryption (#17), renderer decomposition, ESLint, drop node-fetch (#24).
