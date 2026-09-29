# Sample import files

Four files to exercise the import path.

| File | What it is | What should happen |
|---|---|---|
| `sample-statement.ofx` | OFX, the format most banks and card issuers hand you | 8 transactions import; importing it a second time adds **0** (dedup) |
| `sample-tmoney.qif` | T-Money's own one-line-per-transaction QIF variant | 6 transactions import |
| `sample-brokerage.ofx` | An OFX **investment** statement: SECLIST, buys, a sale, a dividend, a reinvestment, a split, a transfer-in, margin interest, positions | Into an investment account: 1 cash row + 7 investment rows, 3 securities created, prices recorded; margin interest noted; into a checking account: refused whole |
| `sample-standard.qif` | Standard QIF, as Quicken and most banks write it | 4 transactions import; importing it a second time adds **0** |

Import into a scratch account, not one you care about. An import is one undo step (Ctrl+Z), but a scratch account keeps your real ones out of it entirely.
