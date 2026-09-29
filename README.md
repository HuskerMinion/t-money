<p align="center">
  <img src="icon_branding/logo/png/tm-logo-horizontal-1200.png" alt="T-Money" width="480">
</p>

<h3 align="center">Home finance on your own computer. One encrypted file, no account, no cloud.</h3>

<p align="center">
  <a href="https://github.com/HuskerMinion/t-money/releases/latest"><img src="https://img.shields.io/github/v/release/HuskerMinion/t-money?label=release" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/Windows-10%20%7C%2011-0078D4" alt="Windows 10 and 11">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue" alt="GPL-3.0 license"></a>
</p>

---

**T-Money** is a desktop money manager for Windows, in the spirit of Microsoft Money. Your accounts,
register, bills, budget, investments and reports live in one file on your computer, encrypted with
SQLCipher. There is no sign-in, no subscription and no server. Nothing about your money leaves the
machine.

<p align="center">
  <img src="docs/screenshots/register.png" alt="An account register: dated transactions with payees, categories, payments, deposits and a running balance" width="900">
</p>

## Screenshots

All screenshots use the made-up household in **File → New → Sample file with demo data**.

| | |
|---|---|
| <img src="docs/screenshots/bills-forecast.png" alt="Bills and income for the next 90 days, with a cash forecast chart and the recurring charges T-Money noticed"> | <img src="docs/screenshots/investing.png" alt="The portfolio: holdings with cost basis and gains, performance over several periods, and asset allocation"> |
| **Bills and forecast.** Scheduled bills, paychecks and the balance they lead to. | **Investing.** Holdings, cost basis, returns and allocation. |
| <img src="docs/screenshots/spending-chart.png" alt="A 3-D pie chart of one month's spending by category"> | <img src="docs/screenshots/reports.png" alt="The reports gallery: income and expenses, assets and liabilities, investment, taxes, classifications and monthly reports"> |
| **Charts.** Any report as a bar, line, area or pie chart. | **Reports.** Close to 40 reports, all customizable. |
| <img src="docs/screenshots/investment-register.png" alt="A 401(k) register with contributions, employer match, buys and reinvested dividends"> | |
| **Investment register.** Buys, reinvestments and employer match, share by share. | |

## What it does

- **Accounts and the register** — checking, savings, credit cards, loans, assets and investment
  accounts. Type-ahead payees and categories, splits, linked transfers, and real Undo (Ctrl+Z) for
  almost everything.
- **Balancing** — reconcile an account against a statement, the way Money did it.
- **Bills and deposits** — scheduled payments and paychecks, a cash forecast, and subscriptions it
  notices on its own.
- **Budgets** — a monthly budget and a year plan, including Level Pay for bills that come once or
  twice a year.
- **Investments** — holdings, lots and cost basis, returns, asset allocation, and share prices
  fetched on request.
- **Loans and debt** — loan terms, payments split into principal, interest and escrow, and a
  debt reduction planner.
- **Reports and charts** — spending, income and expenses, net worth, taxes and more, all
  customizable.
- **Import** — QIF from Microsoft Money (splits and transfers included), OFX and QFX from banks and
  brokers, CSV from most US banks, and the TSP activity file. Export a register as QIF or CSV, and any report as CSV.
- **Savings goals, classifications** (track a rental or a second house separately), attachments
  (receipts and statements kept inside the file), and built-in help.

## Your data

- Everything is in one `.tmny` file that you choose where to keep.
- The file is encrypted. Its key is kept in the Windows Credential Manager, so it opens without a
  password on your computer. **Settings → Security → Master key** shows the key. Keep a copy somewhere safe:
  you need it to open the file or a backup on another computer.
- **Settings → File → Backups** saves copies to a folder of your choice: once a day, and if you
  choose, whenever you close the app or the file.
- The only thing T-Money ever sends over the internet is the list of ticker symbols when you ask it
  to update share prices (from Yahoo Finance). No amounts, no account names, no account or sign-in. It is off
  unless you press **Update prices** or turn on the timer in Settings.

## Install

1. Download `T-Money_x.y.z_x64-setup.exe` from the
   [latest release](https://github.com/HuskerMinion/t-money/releases/latest). The `.msi` is the same
   app, for people who prefer an MSI.
2. Run it.

**Windows will warn you the first time.** The installer is not code-signed. A signing certificate
costs money every year, and this is a free app. Windows SmartScreen shows *"Windows protected your
PC"*. Click **More info**, then **Run anyway**.

If you want to be sure the file is the real one before you run it:

- **Check the checksum.** Each release has a `SHA256SUMS.txt`. In PowerShell:

  ```powershell
  Get-FileHash .\T-Money_1.0.0_x64-setup.exe -Algorithm SHA256
  ```

  The hash must match the line for that file.

- **Check where it was built.** Every installer is built by GitHub from the public source in this
  repository, never on anyone's own computer, and GitHub signs a record of that. With the
  [GitHub CLI](https://cli.github.com/):

  ```powershell
  gh attestation verify .\T-Money_1.0.0_x64-setup.exe --repo HuskerMinion/t-money
  ```

## Coming from Microsoft Money

T-Money was built to replace Money Plus Sunset Deluxe. Compared with Sunset, it adds real encryption,
undo, built-in share prices, CSV import, attachments and recurring-charge detection. What it doesn't do:
open `.mny` files, sign in to your bank (Direct Connect), the Lifetime Planner, the tax estimator, check
printing, or more than one currency. **[The full side-by-side comparison](docs/money-comparison.md)**
covers both directions.

To move your data over: Money can't be read directly, but it exports each account as QIF. In Money, open an account and use
**File → Export → Loose QIF**. In T-Money, create the account first, then use
**File → Import → Bank or broker file (QIF, OFX, QFX)**. The *Import and export* page in
**Help → T-Money Help** (F1) walks through it, and
**File → New → Sample file with demo data** gives you a made-up household to try things on first.

## Building from source

You need [Node.js](https://nodejs.org/) 22, [Rust](https://rustup.rs/) (stable), and the Visual
Studio C++ build tools. The first build compiles SQLCipher and OpenSSL, and takes a while.

```powershell
npm ci
npx tauri dev      # run it
npm test           # frontend tests
cd src-tauri; cargo test   # Rust tests
npx tauri build    # installers, in src-tauri\target\release\bundle
```

Releases are built by [`.github/workflows/release.yml`](.github/workflows/release.yml) when a
`vX.Y.Z` tag is pushed.

## Status

T-Money is used every day for one household's money, and has a large test suite (about 500 Rust
tests and 1,000 frontend tests). It has not yet been used by many people. Back up your file, and
please [open an issue](https://github.com/HuskerMinion/t-money/issues) if something is wrong.

There is no bank sync (Direct Connect), no mobile app, and one currency.

## License

[GPL-3.0-or-later](LICENSE). T-Money is not affiliated with Microsoft. Microsoft Money is a
trademark of Microsoft Corporation.
