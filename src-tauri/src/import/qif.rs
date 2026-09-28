//! QIF (Quicken Interchange Format) parser.
//!
//! **Two formats, because we have to read two.**
//!
//! 1. **Real QIF** — what Quicken, Money and every bank's export button
//!    actually writes. A record is a run of field-code lines terminated by a
//!    lone `^`:
//!
//!    ```text
//!    !Type:Bank
//!    D08/03/2026
//!    T-58.42
//!    PKroger
//!    LFood:Groceries
//!    MWeekly shop
//!    ^
//!    ```
//!
//! 2. **The line format this parser was originally written against**, which is
//!    not QIF at all but is what the demo data and the existing tests use:
//!
//!    ```text
//!    2026-08-03   -58.42   Kroger^Food:Groceries^Weekly shop
//!    ```
//!
//! Until §37.5 only the second was handled — and worse, the field-code lines
//! of the first were explicitly skipped as "header/meta", so a genuine QIF
//! file parsed to **zero transactions and imported successfully with nothing
//! in it**. For an app whose point is reading your bank's export, that is the
//! quietest possible way to be broken.
//!
//! The two cannot collide: a real QIF data line starts with a letter, a line
//! in the old format starts with a digit.

use crate::import::amount::{normalize_qif_date, parse_amount_cents, parse_micro};

/// A parsed QIF transaction (pre-insertion).
#[derive(Debug, Clone)]
pub struct QifTransaction {
    pub date: String,
    pub amount_cents: i64,
    pub payee: String,
    /// Full category path, e.g. `Food:Drinks`.
    pub category: Option<String>,
    pub notes: Option<String>,
    /// `N` — the check number, or a marker like ATM / EFT / DEP.
    pub check_number: Option<String>,
    /// `C` — `*` or `c` is cleared, `X` or `R` is reconciled.
    pub cleared_state: String,
    /// `S` / `E` / `$` lines of a bank record (§65): category path (or a
    /// bracketed account), memo, amount.
    pub splits: Vec<QifSplit>,
    /// Set for a record inside `!Type:Invst` (§66).
    pub invest: Option<QifInvest>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QifSplit {
    pub category: Option<String>,
    pub memo: Option<String>,
    pub amount_cents: i64,
}

/// The investment fields of a `!Type:Invst` record. `T` (the money side)
/// is the transaction's `amount_cents`; `L[Account]` its `category`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct QifInvest {
    /// Quicken's action: Buy, Sell, Div, ReinvDiv, ShrsIn, XIn, StkSplit…
    pub action: String,
    /// `Y` — the security's name.
    pub security: Option<String>,
    /// `I` — price per share, millionths.
    pub price_micro: Option<i64>,
    /// `Q` — shares, millionths (a StkSplit's ratio × 10, as Quicken writes it).
    pub quantity_micro: Option<i64>,
    /// `O` — commission, cents.
    pub commission_cents: i64,
    /// `$` — the amount transferred for XIn / XOut / BuyX / SellX, cents.
    pub xfer_cents: Option<i64>,
}

/// A `!Type:Prices` line: `"VTSAX",21.35,"12/31/2025"`. Quicken writes the
/// symbol; a file whose securities have no symbol names them instead, so the
/// importer tries both (§92).
#[derive(Debug, Clone, PartialEq)]
pub struct QifPrice {
    /// The symbol, or the security's name when it has none.
    pub security: String,
    pub price_micro: i64,
    pub date: String,
}

/// A `!Type:Security` record: what the file calls a security and its symbol.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct QifSecurity {
    pub name: String,
    pub symbol: Option<String>,
    /// `T` — Stock, Mutual Fund, Bond, CD, Index, Option…
    pub kind: Option<String>,
}

/// What a parse produced, and what it could not read.
///
/// A record whose date or amount would not parse (`D3.8.2026`, `Tabc`) used
/// to vanish: neither imported nor counted, so the summary said "imported 3,
/// skipped 0" for a four-row file. `unreadable` is that count, for the
/// import summary to report as skipped.
#[derive(Debug, Default)]
pub struct QifParse {
    pub transactions: Vec<QifTransaction>,
    pub unreadable: u32,
    /// `!Type:Security` records, so a security named by `Y` gets its symbol.
    pub securities: Vec<QifSecurity>,
    /// `!Type:Prices` lines (§92).
    pub prices: Vec<QifPrice>,
}

/// Which block the parser is inside.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Block {
    /// A transaction block: Bank, CCard, Cash, Oth A, Oth L, or none.
    Txn,
    /// `!Type:Invst`.
    Invest,
    /// `!Type:Security`.
    Security,
    /// `!Type:Prices` (§92).
    Prices,
    /// Categories, classes, memorized, prices, budgets, `!Account` lists.
    Other,
}

/// A record being accumulated from field-code lines.
#[derive(Default)]
struct Record {
    date: Option<String>,
    amount_cents: Option<i64>,
    payee: Option<String>,
    category: Option<String>,
    notes: Option<String>,
    check_number: Option<String>,
    cleared_state: String,
    /// A `D` or `T` line was present but did not parse.
    broken: bool,
    splits: Vec<QifSplit>,
    invest: Option<QifInvest>,
    security: QifSecurity,
}

impl Record {
    /// A record is a transaction only if it has both a date and an amount.
    ///
    /// QIF files also carry `!Account` and `!Type:Cat` blocks, whose records
    /// are terminated by the same `^`. Requiring both fields is what keeps an
    /// account list from arriving as a pile of transactions.
    fn into_transaction(self) -> Option<QifTransaction> {
        // An investment record can have no `T` (ShrsIn, StkSplit): its money
        // side is zero.
        let amount_cents = match (self.amount_cents, &self.invest) {
            (Some(a), _) => a,
            (None, Some(_)) => 0,
            (None, None) => return None,
        };
        Some(QifTransaction {
            date: self.date?,
            amount_cents,
            payee: self.payee.unwrap_or_default(),
            category: self.category.filter(|c| !c.is_empty()),
            notes: self.notes.filter(|n| !n.is_empty()),
            check_number: self.check_number.filter(|n| !n.is_empty()),
            cleared_state: self.cleared_state,
            splits: self.splits,
            invest: self.invest,
        })
    }
}

/// Parse QIF text into a list of transactions.
#[cfg_attr(not(test), allow(dead_code))]
pub fn parse_qif(text: &str) -> Vec<QifTransaction> {
    parse_qif_full(text).transactions
}

/// `parse_qif`, plus the count of records that could not be read.
pub fn parse_qif_full(text: &str) -> QifParse {
    let mut out = Vec::new();
    let mut securities = Vec::new();
    let mut prices = Vec::new();
    let mut unreadable = 0u32;
    let mut current = Record::default();
    // Inside an `!Account` or `!Type:Cat` block, `T` is an account type and
    // `D` a description — not a broken date and amount. Only a transaction
    // block's unreadable records are counted. No header at all (a bare
    // export, or the flat format) counts as a transaction block.
    let mut block = Block::Txn;

    // Close out a record: a transaction, an unreadable one, or neither (an
    // account or category block, which has no date and no amount).
    let finish = |rec: Record, out: &mut Vec<QifTransaction>, unreadable: &mut u32| {
        let broken = rec.broken;
        match rec.into_transaction() {
            Some(t) => out.push(t),
            None if broken => *unreadable += 1,
            None => {}
        }
    };

    for raw in text.lines() {
        let line = raw.trim_end();
        if line.is_empty() {
            continue;
        }

        // `!Type:Bank`, `!Account`, `!Clear:AutoSwitch` — block markers. A new
        // block also abandons whatever record was half-read.
        if line.starts_with('!') {
            current = Record::default();
            let header = line.to_ascii_lowercase();
            block = if header.starts_with("!type:") {
                match header.trim_start_matches("!type:").trim() {
                    "invst" => Block::Invest,
                    "security" => Block::Security,
                    "prices" => Block::Prices,
                    "cat" | "class" | "memorized" | "budget" | "tag" => Block::Other,
                    _ => Block::Txn,
                }
            } else {
                Block::Other
            };
            if block == Block::Invest {
                current.invest = Some(QifInvest::default());
            }
            continue;
        }
        // §92: a price block's records are one line each, not field codes.
        if block == Block::Prices {
            if !line.starts_with('^') {
                if let Some(p) = parse_price_line(line) {
                    prices.push(p);
                }
            }
            continue;
        }

        let in_txn_block = matches!(block, Block::Txn | Block::Invest);

        // End of record.
        if line.starts_with('^') {
            if block == Block::Security {
                let sec = std::mem::take(&mut current).security;
                if !sec.name.is_empty() {
                    securities.push(sec);
                }
            } else {
                finish(std::mem::take(&mut current), &mut out, &mut unreadable);
                if block == Block::Invest {
                    current.invest = Some(QifInvest::default());
                }
            }
            continue;
        }

        if block == Block::Security {
            let mut chars = line.chars();
            let Some(code) = chars.next() else { continue };
            let value = chars.as_str().trim().to_string();
            match code {
                'N' => current.security.name = value,
                'S' => current.security.symbol = Some(value).filter(|v| !v.is_empty()),
                'T' => current.security.kind = Some(value).filter(|v| !v.is_empty()),
                _ => {}
            }
            continue;
        }

        // The original line format: date first, so it starts with a digit.
        if looks_like_date_start(line) {
            if let Some(t) = parse_flat_line(line) {
                out.push(t);
            }
            continue;
        }

        // Otherwise: one field-code line, `X` then its value.
        let mut chars = line.chars();
        let Some(code) = chars.next() else { continue };
        let value = chars.as_str().trim();
        match code {
            'D' => {
                current.date = normalize_qif_date(value);
                if current.date.is_none() && in_txn_block {
                    current.broken = true;
                }
            }
            // `T` is the amount; `U` is Quicken's duplicate of it. Whichever
            // arrives first wins, so a `U` cannot overwrite a good `T`.
            'T' | 'U' => {
                if current.amount_cents.is_none() {
                    current.amount_cents = parse_amount_cents(value);
                    if current.amount_cents.is_none() && code == 'T' && in_txn_block {
                        current.broken = true;
                    }
                }
            }
            'P' => current.payee = Some(value.to_string()),
            // `L[Account]` is QIF's spelling of a transfer. Keep the text as
            // written — the import path recognizes the brackets and leaves
            // the row uncategorized rather than inventing a category called
            // "[Savings]", which is the honest outcome until transfers are
            // handled properly.
            'L' => current.category = Some(value.to_string()),
            'M' => current.notes = Some(value.to_string()),
            // In an investment record `N` is the action, not a check number.
            'N' => match current.invest.as_mut() {
                Some(inv) => inv.action = value.to_string(),
                None => current.check_number = Some(value.to_string()),
            },
            'Y' => {
                if let Some(inv) = current.invest.as_mut() {
                    inv.security = Some(value.to_string()).filter(|v| !v.is_empty());
                }
            }
            'I' => {
                if let Some(inv) = current.invest.as_mut() {
                    inv.price_micro = parse_micro(value);
                }
            }
            'Q' => {
                if let Some(inv) = current.invest.as_mut() {
                    inv.quantity_micro = parse_micro(value);
                }
            }
            'O' => {
                if let Some(inv) = current.invest.as_mut() {
                    inv.commission_cents = parse_amount_cents(value).unwrap_or(0);
                }
            }
            // Splits (§65): `S` starts a line, `E` and `$` fill it in. In an
            // investment record `$` is the amount transferred instead.
            'S' => current.splits.push(QifSplit { category: Some(value.to_string()).filter(|v| !v.is_empty()), memo: None, amount_cents: 0 }),
            'E' => {
                if let Some(last) = current.splits.last_mut() {
                    last.memo = Some(value.to_string()).filter(|v| !v.is_empty());
                }
            }
            '$' => match current.invest.as_mut() {
                Some(inv) => inv.xfer_cents = parse_amount_cents(value),
                None => {
                    if let Some(last) = current.splits.last_mut() {
                        last.amount_cents = parse_amount_cents(value).unwrap_or(0);
                    }
                }
            },
            'C' => {
                current.cleared_state = match value {
                    "X" | "R" | "x" | "r" => "R".to_string(),
                    "*" | "c" | "C" => "C".to_string(),
                    _ => String::new(),
                }
            }
            // 'A' is the payee address. Not carried.
            _ => {}
        }
    }

    // A final record with no trailing `^` is still a transaction.
    if block != Block::Security {
        finish(current, &mut out, &mut unreadable);
    }

    QifParse { transactions: out, unreadable, securities, prices }
}

/// One line of the original flat format:
/// `2026-08-03   -58.42   Kroger^Food:Groceries^Weekly shop`
fn parse_flat_line(line: &str) -> Option<QifTransaction> {
    let (date_part, rest) = line.split_once(' ')?;
    let rest = rest.trim_start();
    let date = normalize_qif_date(date_part)?;

    let (amount_str, rest) = rest.split_once(' ')?;
    let rest = rest.trim_start();
    let amount_cents = parse_amount_cents(amount_str)?;

    let mut payee = String::new();
    let mut category: Option<String> = None;
    let mut notes: Option<String> = None;

    let mut parts = rest.splitn(3, '^');
    if let Some(p) = parts.next() {
        payee = p.trim().to_string();
    }
    if let Some(p) = parts.next() {
        let p = p.trim();
        if !p.is_empty() {
            category = Some(p.to_string());
        }
    }
    if let Some(p) = parts.next() {
        let p = p.trim();
        if !p.is_empty() {
            notes = Some(p.to_string());
        }
    }

    Some(QifTransaction {
        date,
        amount_cents,
        payee,
        category,
        notes,
        check_number: None,
        cleared_state: String::new(),
        splits: Vec::new(),
        invest: None,
    })
}

/// Heuristic: does the line start with a plausible date (`YYYY-`)?
fn looks_like_date_start(line: &str) -> bool {
    let b = line.as_bytes();
    b.len() >= 5
        && b[0].is_ascii_digit()
        && b[1].is_ascii_digit()
        && b[2].is_ascii_digit()
        && b[3].is_ascii_digit()
        && b[4] == b'-'
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic() {
        let qif = "\
!Type:Cash
^
2024-01-15:10:30:00   -123.45   Coffee Shop^Food:Drinks
2024-01-16            500.00    Paycheck
";
        let txs = parse_qif(qif);
        assert_eq!(txs.len(), 2);
        assert_eq!(txs[0].date, "2024-01-15");
        assert_eq!(txs[0].amount_cents, -12345);
        assert_eq!(txs[0].payee, "Coffee Shop");
        assert_eq!(txs[0].category.as_deref(), Some("Food:Drinks"));
        assert_eq!(txs[1].amount_cents, 50000);
        assert_eq!(txs[1].category, None);
    }
}

#[cfg(test)]
mod real_qif_tests {
    use super::*;

    /// What a bank's export button actually writes (§37.5).
    const REAL: &str = "\
!Type:Bank
D08/03/2026
T-58.42
PKroger
LFood:Groceries
MWeekly shop
^
D08/07/2026
T2140.88
PAcme Corp Payroll
LIncome:Salary
^
";

    #[test]
    fn a_real_qif_file_is_no_longer_read_as_empty() {
        // The bug this test exists for: field-code lines were skipped as
        // "header/meta", so this file imported successfully with nothing in it.
        let txs = parse_qif(REAL);
        assert_eq!(txs.len(), 2, "real QIF parsed to {} transactions", txs.len());
    }

    #[test]
    fn every_field_survives_the_trip() {
        let txs = parse_qif(REAL);
        assert_eq!(txs[0].date, "2026-08-03");
        assert_eq!(txs[0].amount_cents, -5842);
        assert_eq!(txs[0].payee, "Kroger");
        assert_eq!(txs[0].category.as_deref(), Some("Food:Groceries"));
        assert_eq!(txs[0].notes.as_deref(), Some("Weekly shop"));
        assert_eq!(txs[1].amount_cents, 214_088);
    }

    #[test]
    fn the_original_flat_format_still_works() {
        // The demo data and every existing test use it; reading real QIF must
        // not cost us the format we already had.
        let flat = "\
!Type:Bank
^
2026-08-03   -58.42   Kroger^Food:Groceries^Weekly shop
2026-08-07   2140.88  Acme Corp Payroll
";
        let txs = parse_qif(flat);
        assert_eq!(txs.len(), 2);
        assert_eq!(txs[0].notes.as_deref(), Some("Weekly shop"));
        assert_eq!(txs[1].category, None);
    }

    #[test]
    fn both_formats_in_one_file_land_on_the_same_answer() {
        let mixed = format!("{REAL}2026-08-10   -1450.00 Oakridge^Bills:Rent\n");
        let txs = parse_qif(&mixed);
        assert_eq!(txs.len(), 3);
        assert_eq!(txs[2].payee, "Oakridge");
    }

    #[test]
    fn an_account_block_does_not_arrive_as_a_transaction() {
        // `!Account` records end with the same `^`. Requiring a date AND an
        // amount is what keeps an account list out of the register.
        let with_accounts = "\
!Account
NChecking
TBank
^
!Type:Bank
D08/03/2026
T-58.42
PKroger
^
";
        let txs = parse_qif(with_accounts);
        assert_eq!(txs.len(), 1, "the !Account block leaked into the results");
        assert_eq!(txs[0].payee, "Kroger");
    }

    #[test]
    fn a_last_record_without_a_closing_caret_is_not_dropped() {
        let truncated = "!Type:Bank\nD08/03/2026\nT-58.42\nPKroger\n";
        assert_eq!(parse_qif(truncated).len(), 1);
    }

    #[test]
    fn a_record_missing_its_amount_is_skipped_rather_than_guessed() {
        let no_amount = "!Type:Bank\nD08/03/2026\nPKroger\n^\n";
        assert!(parse_qif(no_amount).is_empty());
    }

    #[test]
    fn a_transfer_keeps_its_bracketed_account_name() {
        // Not resolved yet — but it must not be silently dropped either.
        let transfer = "!Type:Bank\nD08/03/2026\nT-200.00\nPTransfer\nL[Savings]\n^\n";
        let txs = parse_qif(transfer);
        assert_eq!(txs[0].category.as_deref(), Some("[Savings]"));
    }

    #[test]
    fn account_and_category_blocks_are_not_unreadable_transactions() {
        let text = "!Account\nNChecking\nTBank\nDMain account\n^\n!Clear:AutoSwitch\n\
!Type:Cat\nNFood\nE\n^\n!Type:Bank\nD08/03/2026\nT-1.00\nPOk\n^\nDnot a date\nT-2.00\n^\n";
        let p = parse_qif_full(text);
        assert_eq!(p.transactions.len(), 1);
        assert_eq!(p.unreadable, 1, "only the bad record in the Bank block counts");
    }
}

/// §92: one `!Type:Prices` line — `"VTSAX",21.35,"12/31/2025"`.
///
/// Quicken quotes the symbol and the date and leaves the price bare, but
/// files in the wild quote all three or none, and some write the price as a
/// fraction (`21 3/8`) which nothing here has ever produced; a line that does
/// not read as three fields is skipped rather than guessed at.
fn parse_price_line(line: &str) -> Option<QifPrice> {
    let parts: Vec<String> = split_csv(line);
    if parts.len() < 3 {
        return None;
    }
    let security = parts[0].trim().to_string();
    if security.is_empty() {
        return None;
    }
    let price = parts[1].trim();
    if price.is_empty() {
        return None;
    }
    let price_micro = parse_micro(price)?;
    let date = normalize_qif_date(parts[2].trim())?;
    Some(QifPrice { security, price_micro, date })
}

/// Split on commas that are not inside quotes, and unquote each field.
fn split_csv(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    for c in line.chars() {
        match c {
            '"' => quoted = !quoted,
            ',' if !quoted => out.push(std::mem::take(&mut cur)),
            _ => cur.push(c),
        }
    }
    out.push(cur);
    out
}

#[cfg(test)]
mod price_tests {
    use super::*;

    #[test]
    fn a_price_block_is_read_and_the_transactions_beside_it_are_not_disturbed() {
        let qif = "!Type:Invst\nD01/15/2026\nNBuy\nYTotal Market\nI10.00\nQ5\nT50.00\n^\n\
                   !Type:Prices\n\"VTSAX\",21.35,\"12/31/2025\"\n^\n\"Total Market\",11.125,\"03/31/2026\"\n^\n";
        let p = parse_qif_full(qif);
        assert_eq!(p.transactions.len(), 1, "the price block must not eat the transaction");
        assert_eq!(p.unreadable, 0, "a price line is not an unreadable transaction");
        assert_eq!(
            p.prices,
            vec![
                QifPrice { security: "VTSAX".into(), price_micro: 21_350_000, date: "2025-12-31".into() },
                QifPrice { security: "Total Market".into(), price_micro: 11_125_000, date: "2026-03-31".into() },
            ]
        );
    }

    #[test]
    fn a_price_line_that_does_not_read_is_skipped_rather_than_guessed_at() {
        let qif = "!Type:Prices\n\"VTSAX\",,\"12/31/2025\"\n^\n\"VTSAX\",21 3/8,\"12/31/2025\"\n^\n\
                   ,10.00,\"12/31/2025\"\n^\n\"VTSAX\",10.00\n^\n\"OK\",1.5,\"01/02/2026\"\n^\n";
        let p = parse_qif_full(qif);
        assert_eq!(p.prices, vec![QifPrice { security: "OK".into(), price_micro: 1_500_000, date: "2026-01-02".into() }]);
    }
}
