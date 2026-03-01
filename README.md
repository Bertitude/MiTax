# LunchMoney Importer — Jamaica Edition

A desktop Electron app to import financial statements into [LunchMoney.app](https://lunchmoney.app), with Jamaica S04 tax return support.

---

## Installing a Release (pre-built)

Download the latest installer from the **[Releases](../../releases)** page:

| Platform | File | Notes |
|---|---|---|
| Windows | `LunchMoney-Importer-Setup-x.x.x.exe` | Run installer, launch from Start Menu |
| macOS | `LunchMoney-Importer-x.x.x.dmg` | Drag to Applications |
| Linux | `LunchMoney-Importer-x.x.x.AppImage` | `chmod +x` then run |

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
2. In `package.json`, replace `GITHUB_USERNAME_HERE` with your GitHub username
3. Go to your repo → **Settings → Actions → General** → enable "Read and write permissions" for `GITHUB_TOKEN`
4. Tag `v1.1.0` and push — the first build will run

No extra secrets or code-signing certificates are required for basic builds. Code signing (to remove Windows "Unknown Publisher" warnings) can be added later via `WIN_CSC_LINK` secrets.

---

## Features

- **Drag & Drop** PDF/CSV statement importing
- **Auto-detects** institution: NCB, Scotiabank JA, JMMB, Wise, PayPal, Stripe, and generic fallback
- **Uploads** directly to your LunchMoney account via API
- **CSV export** in LunchMoney-compatible format
- **Coverage Tracker** — visual month-by-month grid per account, highlights missing months
- **Upload History** — full log of all imported statements
- **S04 Tax Return** — calculates Jamaica self-employed income tax (income tax, NIS, NHT, Education Tax)

---

## Quick Start

### 1. Install Node.js
Download from https://nodejs.org (v18 or later recommended)

### 2. Install dependencies
```bash
cd LunchMoneyApp
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
| Wise | International | Multi-currency |
| PayPal | International | USD statements |
| Stripe | International | Payout statements |
| Generic | Any | Fallback parser for unknown formats |

---

## S04 Tax Return

The S04 module calculates estimated Jamaica self-employed income tax for a given year using current TAJ rates:

- **Income Tax**: 25% on chargeable income up to $6M; 30% above
- **NIS**: 3% of gross income (capped at $1.5M)
- **NHT**: 2% of gross income
- **Education Tax**: 2.25% of statutory income
- **Personal Threshold**: $1,500,096 (2024)

> ⚠ This is an estimate only. Consult TAJ or a qualified accountant for official filing.

---

## File Structure

```
LunchMoneyApp/
├── main.js              # Electron main process
├── preload.js           # Secure IPC bridge
├── package.json
├── renderer/
│   ├── index.html       # UI
│   ├── app.js           # UI logic
│   └── styles.css       # Dark theme styles
└── src/
    ├── parsers/
    │   ├── index.js     # Parser dispatcher
    │   ├── ncb.js
    │   ├── scotiabank.js
    │   ├── jmmb.js
    │   ├── wise.js
    │   ├── paypal.js
    │   ├── stripe.js
    │   └── generic.js
    ├── lunchmoney.js    # LunchMoney API client
    ├── tracker.js       # SQLite upload tracker
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
- **macOS**: `~/Library/Application Support/lunchmoney-importer/`
- **Windows**: `%APPDATA%\lunchmoney-importer\`
- **Linux**: `~/.config/lunchmoney-importer/`
