<p align="center">
  <img src="icon_branding/logo/png/tm-logo-horizontal-1200.png" alt="T-Money" width="480">
</p>

<h3 align="center">Home finance on your own computer. One encrypted file, no account, no cloud.</h3>

<p align="center">
  <a href="https://github.com/HuskerMinion/t-money/releases/latest"><img src="https://img.shields.io/github/v/release/HuskerMinion/t-money?label=release" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/runs%20on-Windows%20%7C%20macOS%20%7C%20Linux-0078D4" alt="Runs on Windows, macOS and Linux">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue" alt="GPL-3.0 license"></a>
</p>

---

**T-Money** is a desktop money manager for Windows, macOS and Linux, in the spirit of Microsoft Money. Your accounts,
register, bills, budget, investments and reports live in one file on your computer, encrypted with
SQLCipher. There is no sign-in, no subscription and no server. Nothing about your money leaves the
machine. If you want your bank's transactions fetched for you, [bank sync](#bank-sync) is optional and
goes through a separate service you sign up for.

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
| <img src="docs/screenshots/investment-register.png" alt="A 401(k) register with contributions, employer match, buys and reinvested dividends"> | <img src="docs/screenshots/register-euros.png" alt="The same register in a file kept in euros with German formats: 1.234,56 euro amounts, dates like 01.10.2026, and a US-dollar account in the sidebar"> |
| **Investment register.** Buys, reinvestments and employer match, share by share. | **Your currency and format.** The sample file kept in euros, written the German way, with a US-dollar account beside the others. |

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
- **Currencies and regions** — keep a file in US dollars, Canadian dollars, euros, British pounds,
  Mexican pesos or Australian dollars, with numbers and dates written the way your country writes
  them. An account can be kept in another of those currencies; it converts at exchange rates you
  type in or fetch.
- **Bank sync, if you want it** — fetch transactions from most US and Canadian banks through
  SimpleFIN. See [Bank sync](#bank-sync).
- **Import** — QIF from Microsoft Money (splits and transfers included), OFX and QFX from banks and
  brokers, CSV from most banks (either decimal mark), and the TSP activity file. Export a register as QIF or CSV, and any report as CSV.
- **Savings goals, classifications** (track a rental or a second house separately), attachments
  (receipts and statements kept inside the file), and built-in help.

## Bank sync

[SimpleFIN](https://bridge.simplefin.org) is a paid service (about $15 a year) that gives the apps you
choose read-only access to your bank transactions. You can turn an app off anytime. In T-Money you
pick which account each one fills. It covers most US and Canadian banks.

1. Sign up at SimpleFIN Bridge, connect your banks there, and make a setup token.
2. In T-Money, open **Settings → Money → Bank sync**, paste the token and click **Connect**.
3. Pick the T-Money account each bank account fills, then click **Get bank transactions**.

<p align="center">
  <img src="docs/screenshots/bank-sync.png" alt="Settings, Bank sync: connected to SimpleFIN, two demo bank accounts linked to Demo Checking and Demo Savings, and the result of a fetch with the bank's balance beside T-Money's" width="900">
</p>

- It fetches only when you click. The first fetch reaches back 88 days; later ones overlap the last
  by a few days, and anything already in the register is skipped.
- Transactions go through the same import as a statement file. Rename rules apply, they arrive
  cleared, and one you already typed in is matched instead of added twice. Each fetch is one Undo
  step.
- The result shows the bank's balance beside T-Money's, so a gap shows at once. SimpleFIN's own
  messages, such as a bank that needs you to sign in again, are shown as it wrote them.
- The connection is kept in your computer's credential store, not in the file.
  **Disconnect** removes it. T-Money stays under SimpleFIN's daily request limit.

## Your data

- Everything is in one `.tmny` file that you choose where to keep.
- The file is encrypted. Its key is kept in your computer's credential store (Credential Manager on
  Windows, the Keychain on a Mac, the keyring on Linux), so it opens without a password on your computer. **Settings → Security → Master key** shows the key. Keep a copy somewhere safe:
  you need it to open the file or a backup on another computer.
- **Settings → File → Backups** saves copies to a folder of your choice: once a day, and if you
  choose, whenever you close the app or the file.
- Without bank sync, the only things T-Money ever sends over the internet are ticker symbols when
  you ask it to update share prices, and currency codes when you ask it for today's exchange rates
  (both from Yahoo Finance). No amounts, no account names, no account or sign-in. Prices are off
  unless you press **Update prices** or turn on the timer in Settings; exchange rates are fetched
  only when you ask for them.
- Bank sync is off until you connect it. Once connected, T-Money asks SimpleFIN for your accounts
  and transactions only when you click **Get bank transactions**, and sends nothing about your
  file. The connection is kept in your computer's credential store, not in the file, and
  **Disconnect** removes it.

## Install

Download from the [latest release](https://github.com/HuskerMinion/t-money/releases/latest). None of
the downloads is code-signed: a signing certificate costs money every year, and this is a free app.
So each system warns you the first time, and the steps below get past it.

> **The Mac and Linux versions are new and not fully tested.** So far T-Money has been tested on
> macOS 26 and Ubuntu 24.04. It hasn't been tried on an Apple silicon Mac, older macOS versions, or
> other Linux distributions yet. If something doesn't work, or looks wrong, please
> [open an issue](https://github.com/HuskerMinion/t-money/issues) and say which Mac or distribution
> you're on.

### Windows 10 and 11

1. Download `T-Money_x.y.z_x64-setup.exe`. The `.msi` is the same app, for people who prefer an MSI.
2. Run it. Windows SmartScreen shows *"Windows protected your PC"*. Click **More info**, then
   **Run anyway**.

### Mac

One app for both kinds of Mac, Apple silicon (M1 and later) and Intel. It needs macOS 11 (Big Sur)
or newer.

1. Download `T-Money_x.y.z_universal.dmg` and open it.
2. Drag **T-Money** onto **Applications**.
3. Open T-Money from Applications. The first time, macOS stops it: *"T-Money" Not Opened. Apple
   could not verify "T-Money" is free of malware…* Click **Done** (not Move to Trash).
4. Open **System Settings → Privacy & Security** and scroll down to **Security**. It says
   *"T-Money" was blocked to protect your Mac.* Click **Open Anyway**.
5. macOS asks once more. Click **Open Anyway**, then type your Mac password.

From then on T-Money opens like any other app. After an update you do steps 3 to 5 again, because
macOS checks each new download. Right-click → Open, which used to skip the warning, no longer works
since macOS 15. If you'd rather use Terminal, this one line does the same as steps 3 to 5:

```sh
xattr -dr com.apple.quarantine /Applications/T-Money.app
```

The first time you save a file in Documents or Desktop, macOS asks whether T-Money may use that
folder. Click **Allow**.

### Linux

For 64-bit Intel or AMD PCs. Linux doesn't warn about unsigned apps.

- **Debian, Ubuntu, Mint, Pop!_OS:** download `T-Money_x.y.z_amd64.deb` and install it with
  `sudo apt install ./T-Money_x.y.z_amd64.deb`. T-Money is then in your applications menu.
- **Any distribution:** download `T-Money_x.y.z_amd64.AppImage`, then
  `chmod +x T-Money_x.y.z_amd64.AppImage` and run it.

T-Money keeps each file's key in your desktop's keyring, GNOME Keyring or KDE's KWallet, which most
desktops start when you log in. With no keyring running, T-Money says so and offers to let you keep
the key yourself; you then type it each time you open the file. If the window is blank (some
graphics drivers), start it with `WEBKIT_DISABLE_DMABUF_RENDERER=1` in front of the command.

### Checking a download

If you want to be sure a file is the real one before you run it:

- **Check the checksum.** Each release has a `SHA256SUMS.txt`. Use the name of the file you
  downloaded; the result must match the line for that file.

  ```powershell
  Get-FileHash .\T-Money_1.2.0_x64-setup.exe -Algorithm SHA256   # Windows, in PowerShell
  ```

  ```sh
  shasum -a 256 T-Money_1.2.0_universal.dmg      # Mac
  sha256sum T-Money_1.2.0_amd64.AppImage         # Linux
  ```

- **Check where it was built.** Every download is built by GitHub from the public source in this
  repository, never on anyone's own computer, and GitHub signs a record of that. With the
  [GitHub CLI](https://cli.github.com/):

  ```sh
  gh attestation verify T-Money_1.2.0_x64-setup.exe --repo HuskerMinion/t-money
  ```

## Coming from Microsoft Money

T-Money was built to replace Money Plus Sunset Deluxe. Compared with Sunset, it adds real encryption,
undo, built-in share prices, CSV import, attachments and recurring-charge detection. What it doesn't do:
open `.mny` files, sign in to your bank (Direct Connect; bank sync goes through SimpleFIN instead),
the Lifetime Planner, the tax estimator, or check printing. It handles six currencies, where Money handled dozens. **[The full side-by-side comparison](docs/money-comparison.md)**
covers both directions.

To move your data over: Money can't be read directly, but it exports each account as QIF. In Money, open an account and use
**File → Export → Loose QIF**. In T-Money, create the account first, then use
**File → Import → Bank or broker file (QIF, OFX, QFX)**. The *Import and export* page in
**Help → T-Money Help** (F1) walks through it, and
**File → New → Sample file with demo data** gives you a made-up household to try things on first.

## Building from source

You need [Node.js](https://nodejs.org/) 22 and [Rust](https://rustup.rs/) (stable), plus:

- **Windows:** the Visual Studio C++ build tools.
- **Mac:** Apple's Command Line Tools (`xcode-select --install`).
- **Linux (Debian/Ubuntu):** `sudo apt install build-essential pkg-config libssl-dev
  libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev`.

The first build compiles SQLCipher and OpenSSL, and takes a while.

```powershell
npm ci
npx tauri dev      # run it
npm test           # frontend tests
cd src-tauri; cargo test   # Rust tests
npx tauri build    # installers, in src-tauri/target/release/bundle
```

Releases are built by [`.github/workflows/release.yml`](.github/workflows/release.yml) when a
`vX.Y.Z` tag is pushed.

## Status

T-Money is used every day for one household's money, and has a large test suite (about 580 Rust
tests and 1,200 frontend tests). It has not yet been used by many people. Back up your file, and
please [open an issue](https://github.com/HuskerMinion/t-money/issues) if something is wrong.

There is no Direct Connect and no mobile app. Bank sync needs SimpleFIN, a separate paid service, and
covers US and Canadian banks. The tax reports follow US tax forms.

## License

[GPL-3.0-or-later](LICENSE). T-Money is not affiliated with Microsoft. Microsoft Money is a
trademark of Microsoft Corporation.
