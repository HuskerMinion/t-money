# T-Money and Microsoft Money Plus Sunset Deluxe

T-Money was built as a replacement for Money Sunset, the free, final edition of Microsoft Money. This page
is an honest comparison: what each one does that the other doesn't, and what they both do.

## Both do these about equally well

Registers with splits and transfers, reconciling, scheduled bills and deposits, budgets, loans with
amortization and escrow, the Debt Reduction Planner, savings goals, investments with lots and cost basis,
capital gains, around 40 reports with charts, performance against a benchmark, tax lines on categories,
classifications, and QIF/OFX/QFX import.

## What T-Money does that Money Sunset doesn't

| Feature | T-Money | Money Sunset |
|---|---|---|
| Real encryption | SQLCipher, key kept in Windows Credential Manager | Weak optional password |
| Undo (Ctrl+Z) | Almost everything, including a whole import, payee renames and payee merges | None |
| Share prices | Built in, on demand or daily/weekly | MSN quotes died with the online services |
| Import from CSV | Yes, with column mapping; knows most US banks' formats and reads either decimal mark | No |
| TSP (Thrift Savings Plan) import | Reads tsp.gov's activity file directly | No |
| Recurring charge detection | Finds subscriptions and repeat bills in your register | No |
| Attachments | Receipts and statements stored inside the file | No |
| Net worth by how reachable it is | Liquid, locked up, illiquid | No |
| Tax line on a single transaction | Yes | Categories only |
| Merge accounts | Yes | No |
| Looks and text size | 14 looks, 14 color themes, scalable text | One fixed 2008 look |
| Still maintained | Yes, with about 1,750 automated tests | No updates since 2010 |

## What Money Sunset does that T-Money doesn't

| Feature | Money Sunset | T-Money |
|---|---|---|
| Open .mny files | Yes | No. You export each account from Money as QIF and import it |
| Direct Connect (bank login inside the app) | Only with the few banks still running a compatible server | No. You download the file from your bank |
| Lifetime Planner, retirement and college planners | Yes | No |
| Tax estimator and TXF export to TurboTax | Yes | No |
| Check printing | Yes | No |
| Multi-currency | Dozens of currencies | Six: US, Canadian and Australian dollars, euros, British pounds and Mexican pesos |
| Reminders when the app is closed | Yes | No, only inside the app |
| Home Inventory | Yes | No |
| Stock option grants | Yes | No |
| 15+ years of muscle memory | Yes | Close, but not identical |

Several of these are left out on purpose, not just not yet: bank sync needs a server relationship banks
don't offer to small apps, and a tax estimator or lifetime planner is better done by tools built for it.

## Moving over

Money can't be read directly, but it exports each account as QIF, splits and transfers included. The
[README](../README.md#coming-from-microsoft-money) has the steps, and the *Import and export* page in
**Help → T-Money Help** (F1) goes through it in detail.

T-Money isn't affiliated with Microsoft. Microsoft Money is a trademark of Microsoft Corporation.
