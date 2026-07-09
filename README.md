# MiTax — Jamaica Edition

A desktop Electron app to import financial statements into [LunchMoney.app](https://lunchmoney.app), with Jamaica S04 tax return support.

---

## Installing a Release (pre-built)

Download the latest installer from the **[Releases](../../releases)** page:

| Platform | File | Notes |
|---|---|---|
| Windows | `MiTax-Setup-x.x.x.exe` | Run installer, launch from Start Menu |
| macOS | `MiTax-x.x.x.dmg` | Drag to Applications |
| Linux | `MiTax-x.x.x.AppImage` | `chmod +x` then run |

The app **checks for updates automatically** at startup and shows a banner when a new version is available. You can also trigger a manual check from the topbar at any time.

---

## Publishing an Update

When you're ready to release a new version:

### 1. Bump the version
Edit `package.json` → change `"version"` to the new number (e.g. `"1.2.0"`).

### 2. Commit and tag
```bash
git add package.json
git commit -m "chore: bump version to 1.2.0"
git tag v1.2.0
git push origin main --tags
```

### 3. GitHub Actions builds it automatically
Pushing a tag starting with `v` triggers `.github/workflows/release.yml`, which:
- Builds Windows (.exe), macOS (.dmg), and Linux (.AppImage) installers
- Creates a public GitHub Release and uploads all three installers

### 4. Users get notified
Within 5 seconds of launching the app, existing users see an **update available** banner with a one-click **"Download Now"** → **"Restart & Install"** flow.

---

## One-time GitHub setup (first release only)

1. Push the code to a **GitHub repository**
2. Confirm the `build.publish` owner/repo in `package.json` points at your release repo (currently `Bertitude/MiTax`)
3. Go to your repo → **Settings → Actions → General** → enable "Read and write permissions" for `GITHUB_TOKEN`
4. Tag a release (e.g. `v1.3.0`) and push — the build workflow will run

No extra secrets or code-signing certificates are required for basic builds. Code signing (to remove Windows "Unknown Publisher" warnings) can be added later via `WIN_CSC_LINK` secrets.

---

## Features

- **Drag & Drop** PDF/CSV statement importing
- **Auto-detects** institution: NCB, Scotiabank JA, JMMB, JN Bank, UNFCU, Wise, PayPal, Stripe, and generic fallback
- **Uploads** directly to your LunchMoney account via API
- **CSV export** in LunchMoney-compatible format
- **Coverage Tracker** — visual month-by-month grid per account, highlights missing months
- **Upload History** — full log of all imported statements
- **S04 Tax Return** — calculates Jamaica self-employed income tax (income tax, NIS, NHT, Education Tax)

---

## Quick Start

### 1. Install Node.js
Download from https://nodejs.org (v20 or later — required by better-sqlite3 12 / Electron 41)

### 2. Install dependencies
```bash
cd MiTax
npm install
```

### 3. Run the app
```bash
npm start
```

---

## Getting Your LunchMoney API Key

1. Log in at https://app.lunchmoney.app
2. Go to **Settings → Developers**
3. Click **Request Access Token**
4. Paste the token into the app under **Settings**

---

## Supported Institutions

| Institution | Type | Notes |
|---|---|---|
| NCB Jamaica | Bank | Chequing, savings, credit card |
| Scotiabank Jamaica | Bank | Chequing, savings, credit card |
| JMMB | Bank / Securities | Savings, investments, loans |
| JN Bank | Bank | Savings (JNLive e-statements) |
| UNFCU | Credit Union | Multi-account statements |
| Wise | International | Multi-currency |
| PayPal | International | USD statements |
| Stripe | International | Payout statements |
| Generic | Any | Fallback parser for unknown formats |

---

## S04 Tax Return

The S04 module calculates estimated Jamaica self-employed income tax for a given year using current TAJ rates:

- **Income Tax**: 25% on chargeable income up to $6M; 30% above
- **NIS**: 3% of gross income (insurable income capped at $5M, since Apr 2022)
- **NHT**: 2% of gross income
- **Education Tax**: 2.25% of statutory income
- **Personal Threshold**: $1,700,088 (2024); per-year values in `src/tax/s04.js`

> ⚠ This is an estimate only. Consult TAJ or a qualified accountant for official filing.

---

## File Structure

```
MiTax/
├── main.js              # Electron main process (IPC handlers)
├── preload.js           # Secure IPC bridge (contextBridge)
├── package.json
├── renderer/
│   ├── index.html       # UI
│   ├── app.js           # UI logic
│   └── styles.css       # Dark theme styles
├── test/                # node:test unit tests + fixtures
└── src/
    ├── parsers/
    │   ├── index.js     # Parser dispatcher + CSV + output validation
    │   ├── ncb.js  scotiabank.js  jmmb.js  jn.js  unfcu.js
    │   ├── wise.js  paypal.js  stripe.js  generic.js
    │   └── utils.js     # Shared date/sign helpers
    ├── pdf/extract.js   # pdfjs-dist text/coordinate extraction
    ├── lunchmoney.js    # LunchMoney API client
    ├── lm-accounts.js   # Encrypted multi-account store (safeStorage)
    ├── tracker.js       # SQLite upload tracker
    ├── date-utils.js    # Timezone-safe date helpers
    ├── reconcile.js     # Statement ↔ LM reconciliation
    ├── filings.js  p24.js  payee-detect.js  payee-matcher.js  updater.js
    └── tax/
        └── s04.js       # Jamaica S04 tax calculator
```

---

## Adding a New Bank Parser

1. Create `src/parsers/yourbank.js`
2. Export a `parse(text, filePath)` function returning `{ institution, accountType, accountName, currency, period, transactions }`
3. Add a detection pattern in `src/parsers/index.js` under `INSTITUTION_PATTERNS`

---

## Data Storage

The app stores its SQLite database in your OS user data folder:
- **macOS**: `~/Library/Application Support/MiTax/` (dev: `.../mitax/`)
- **Windows**: `%APPDATA%\MiTax\` (dev: `%APPDATA%\mitax\`)
- **Linux**: `~/.config/MiTax/` (dev: `~/.config/mitax/`)
