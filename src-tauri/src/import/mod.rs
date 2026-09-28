//! QIF/OFX import: read a file, detect the format, parse, and insert.

use crate::db::pool::DbPool;
use crate::models::NewInvestmentTransaction;
use rusqlite::{Connection, OptionalExtension};
use crate::db::queries::{count_matching, create_security, ensure_category_path, has_fitid, insert_investment_transaction, insert_transfer_pair_named, list_payee_rules, rule_for, set_security_price, unlabeled_match, upsert_payee};
use crate::models::ImportSummary;
use rusqlite::params;
use std::collections::HashMap;
use std::path::Path;
use uuid::Uuid;

mod amount;
pub mod csv;
pub mod tsp;
pub mod matching;
pub mod plan;
mod ofx;
mod qif;
pub mod qif_export;

pub use amount::{normalize_ofx_date, normalize_qif_date, parse_amount_cents};

/// A normalized transaction ready for insertion, regardless of source format.
struct ParsedTxn {
    date: String,
    amount_cents: i64,
    payee: String,
    category: Option<String>,
    notes: Option<String>,
    /// OFX `FITID`. QIF has nothing like it.
    fitid: Option<String>,
    check_number: Option<String>,
    cleared_state: String,
    /// QIF split lines (§65).
    splits: Vec<qif::QifSplit>,
    /// QIF investment fields (§66).
    invest: Option<qif::QifInvest>,
    /// §84: the payee as the file had it, when a rule renamed it — the
    /// dedupe still has to recognize a row imported before the rule existed.
    raw_payee: Option<String>,
    /// §84: the rule's category, used only when the file gave none.
    rule_category_id: Option<String>,
    /// §90: an investment action the app has no meaning for. Such a row used
    /// to become an ordinary cash row named after the action ("null" for
    /// the "Change in Market Value" some plans write); now it is left out
    /// and named.
    unknown_action: Option<String>,
}

/// The file's text, whatever it was saved as. Money and Quicken write QIF
/// in the Windows ANSI code page (1252), so a payee with an accented
/// letter, a curly apostrophe or a ½ used to fail the whole import with
/// "stream did not contain valid UTF-8". UTF-8 (with or without a BOM) and
/// UTF-16 with a BOM are read as themselves; anything else is taken as
/// Windows-1252, which decodes every byte to something.
pub fn decode_text(bytes: &[u8]) -> String {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(rest).into_owned();
    }
    if bytes.len() >= 2 && (bytes[..2] == [0xFF, 0xFE] || bytes[..2] == [0xFE, 0xFF]) {
        let be = bytes[0] == 0xFE;
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| if be { u16::from_be_bytes([c[0], c[1]]) } else { u16::from_le_bytes([c[0], c[1]]) })
            .collect();
        return String::from_utf16_lossy(&units);
    }
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_string();
    }
    // Windows-1252: 0x80–0x9F are the printable extras; the rest is Latin-1.
    const HIGH: [char; 32] = [
        '\u{20AC}', '\u{FFFD}', '\u{201A}', '\u{0192}', '\u{201E}', '\u{2026}', '\u{2020}', '\u{2021}',
        '\u{02C6}', '\u{2030}', '\u{0160}', '\u{2039}', '\u{0152}', '\u{FFFD}', '\u{017D}', '\u{FFFD}',
        '\u{FFFD}', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}', '\u{2022}', '\u{2013}', '\u{2014}',
        '\u{02DC}', '\u{2122}', '\u{0161}', '\u{203A}', '\u{0153}', '\u{FFFD}', '\u{017E}', '\u{0178}',
    ];
    bytes
        .iter()
        .map(|&b| match b {
            0x80..=0x9F => HIGH[(b - 0x80) as usize],
            _ => b as char,
        })
        .collect()
}

/// True for a QIF `L[Account]` line — Quicken's spelling of a transfer. Not a
/// category, and not something to create one called "[Savings]" for.
fn is_transfer_category(cat: &str) -> bool {
    let c = cat.trim();
    c.starts_with('[') && c.ends_with(']')
}

/// The account named inside the brackets, if the file has one and it is
/// not the account being imported into. Case-insensitive on the name.
fn transfer_target(tx: &Connection, cat: &str, account_id: &str) -> Result<Option<(String, String)>, String> {
    let name = cat.trim().trim_start_matches('[').trim_end_matches(']').trim();
    if name.is_empty() {
        return Ok(None);
    }
    tx.query_row(
        "SELECT id, name FROM accounts WHERE lower(name) = lower(?1) AND id <> ?2 ORDER BY is_closed LIMIT 1",
        params![name, account_id],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// How many linked transfers between these two accounts the importing
/// account already holds on this date for this amount — the duplicate test
/// for a `[Account]` row, since the other account's file writes the same
/// transfer from its side.
fn count_linked(tx: &Connection, account_id: &str, other: &str, date: &str, amount_cents: i64) -> Result<i64, String> {
    tx.query_row(
        "SELECT COUNT(*) FROM transactions t JOIN transactions p ON p.id = t.transfer_id
          WHERE t.account_id = ?1 AND p.account_id = ?2 AND t.date = ?3 AND t.amount_cents = ?4",
        params![account_id, other, date, amount_cents],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// An unlinked, uncategorized row in the other account that is this
/// transfer's far side — written by an earlier import of that account's
/// file before this one existed to link to.
fn unlinked_counterpart(tx: &Connection, other: &str, date: &str, amount_cents: i64) -> Result<Option<String>, String> {
    tx.query_row(
        "SELECT id FROM transactions
          WHERE account_id = ?1 AND date = ?2 AND amount_cents = ?3
            AND transfer_id IS NULL AND category_id IS NULL AND is_void = 0
            AND activity IS NULL
          ORDER BY rowid LIMIT 1",
        params![other, date, -amount_cents],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Import a QIF or OFX file into `account_id`.
///
/// The file format is auto-detected from the extension and content. Each parsed
/// transaction is inserted (with its category ensured) and its signed amount is
/// applied to the account balance.
///
/// **Duplicates.** An OFX row carries the bank's own id (`FITID`), and a row
/// whose id the account already holds is a duplicate, full stop. Without one
/// (QIF, or a bank that omits it) the key is date + amount + payee — but
/// counted, not boolean: two identical rows in one file are two transactions
/// (two $4.50 coffees at the same shop the same morning), and the second is a
/// duplicate only if the account already held two. The boolean check that
/// preceded this saw the first insert of the loop and dropped the second row
/// of every such pair, silently. Re-importing a statement is still idempotent
/// — see `importing_the_same_statement_twice_changes_nothing_the_second_time`.
pub fn import_file(pool: &DbPool, file_path: &str, account_id: &str) -> Result<ImportSummary, String> {
    let src = parse_source(file_path, None)?;
    import_parsed(pool, account_id, src, &HashMap::new(), &[])
}

/// §172 — `import_file`, with §90's memo rules supplied by the caller rather
/// than asked for. The TSP importer knows what its own memos mean — it wrote
/// them — so it hands the contribution ones in here, and every contribution
/// Buy gets the cash side §90 gives one: a deposit for the same amount on
/// the same day, filed under Retirement Contributions. Without it the plan's
/// cash drifted negative by every dollar ever paid in, and the account's
/// worth — cash plus holdings — was short by the same.
pub fn import_file_with_rules(pool: &DbPool, file_path: &str, account_id: &str, memo_rules: &[plan::MemoRule]) -> Result<ImportSummary, String> {
    let src = parse_source(file_path, None)?;
    import_parsed(pool, account_id, src, &HashMap::new(), memo_rules)
}

/// A file read and parsed, with nothing written. §89 splits this out of
/// `import_file` / `import_csv` so the same bytes can be looked at first
/// (`preview_import`) and imported after (`import_with_decisions`) — the
/// parse is deterministic, so a row's position is a stable key for the
/// user's decision about it.
struct ParsedSource {
    txns: Vec<ParsedTxn>,
    qif_securities: Vec<qif::QifSecurity>,
    /// §92: a `!Type:Prices` block, applied after the rows are written.
    qif_prices: Vec<qif::QifPrice>,
    unreadable: u32,
    /// The file's text, kept for the OFX investment statement (§44).
    text: String,
    is_ofx: bool,
    /// CSV rows the mapping could not read, named for the summary (§88).
    bad: Vec<String>,
}

fn parse_source(file_path: &str, mapping: Option<&csv::CsvMapping>) -> Result<ParsedSource, String> {
    if let Some(mapping) = mapping {
        return parse_csv_source(file_path, mapping);
    }
    let path = Path::new(file_path);
    let bytes = std::fs::read(path).map_err(|e| format!("failed to read {}: {e}", path.display()))?;
    let text = decode_text(&bytes);

    let ext_is_ofx = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("ofx") || e.eq_ignore_ascii_case("qfx"))
        .unwrap_or(false);
    let is_ofx = ext_is_ofx || ofx::looks_like_ofx(&text);

    let mut unreadable = 0u32;
    let mut qif_securities: Vec<qif::QifSecurity> = Vec::new();
    let mut qif_prices: Vec<qif::QifPrice> = Vec::new();
    let txns: Vec<ParsedTxn> = if is_ofx {
        ofx::parse_ofx(&text)
            .into_iter()
            .map(|t| ParsedTxn {
                date: t.date,
                amount_cents: t.amount_cents,
                payee: t.payee,
                category: t.category,
                notes: t.notes,
                fitid: t.fitid,
                check_number: t.check_number,
                cleared_state: String::new(),
                splits: Vec::new(),
                invest: None,
                raw_payee: None,
                rule_category_id: None,
                unknown_action: None,
            })
            .collect()
    } else {
        let parsed = qif::parse_qif_full(&text);
        unreadable = parsed.unreadable;
        qif_securities = parsed.securities;
        qif_prices = parsed.prices;
        parsed
            .transactions
            .into_iter()
            .map(|t| ParsedTxn {
                date: t.date,
                amount_cents: t.amount_cents,
                payee: t.payee,
                category: t.category,
                notes: t.notes,
                fitid: None,
                check_number: t.check_number,
                cleared_state: t.cleared_state,
                splits: t.splits,
                invest: t.invest,
                raw_payee: None,
                rule_category_id: None,
                unknown_action: None,
            })
            .map(qif_cash_side)
            .collect()
    };
    Ok(ParsedSource { txns, qif_securities, qif_prices, unreadable, text, is_ofx, bad: Vec::new() })
}

/// §88: look at a CSV before importing it — the columns, the first rows,
/// a guessed mapping. Writes nothing.
pub fn preview_csv(file_path: &str, has_header: Option<bool>, mapping: Option<&csv::CsvMapping>) -> Result<csv::CsvPreview, String> {
    let bytes = std::fs::read(file_path).map_err(|e| format!("failed to read {file_path}: {e}"))?;
    csv::preview(&decode_text(&bytes), 12, has_header, mapping)
}

/// §88: import a CSV with the mapping the user confirmed. Rows the mapping
/// cannot read (no date, no amount) are counted as skipped and named in the
/// notes, up to ten; everything else goes through the same writer as a QIF.
pub fn import_csv(pool: &DbPool, file_path: &str, account_id: &str, mapping: &csv::CsvMapping) -> Result<ImportSummary, String> {
    let src = parse_source(file_path, Some(mapping))?;
    import_parsed(pool, account_id, src, &HashMap::new(), &[])
}

fn parse_csv_source(file_path: &str, mapping: &csv::CsvMapping) -> Result<ParsedSource, String> {
    if mapping.date.is_none() {
        return Err("choose the Date column".to_string());
    }
    if mapping.amount.is_none() && mapping.debit.is_none() && mapping.credit.is_none() {
        return Err("choose an Amount column, or Debit and Credit columns".to_string());
    }
    let bytes = std::fs::read(file_path).map_err(|e| format!("failed to read {file_path}: {e}"))?;
    let text = decode_text(&bytes);
    let delimiter = csv::sniff_delimiter(&text);
    let records = csv::parse_records(&text, delimiter);
    let data = records.into_iter().skip(if mapping.has_header { 1 } else { 0 });
    let mut txns: Vec<ParsedTxn> = Vec::new();
    let mut unreadable = 0u32;
    let mut bad: Vec<String> = Vec::new();
    for (i, row) in data.enumerate() {
        match csv::row_to_txn(&row, mapping) {
            Ok(r) => txns.push(ParsedTxn {
                date: r.date,
                amount_cents: r.amount_cents,
                payee: r.payee,
                category: r.category,
                notes: r.memo,
                fitid: None,
                check_number: r.check_number,
                cleared_state: String::new(),
                splits: Vec::new(),
                invest: None,
                raw_payee: None,
                rule_category_id: None,
                unknown_action: None,
            }),
            Err(why) => {
                unreadable += 1;
                if bad.len() < 10 {
                    bad.push(format!("line {}: {why}", i + 1 + if mapping.has_header { 1 } else { 0 }));
                }
            }
        }
    }
    Ok(ParsedSource { txns, qif_securities: Vec::new(), qif_prices: Vec::new(), unreadable, text: String::new(), is_ofx: false, bad })
}

/// §89: read the file and say, row by row, what it would do — which rows are
/// already in the register exactly (skipped as before), and which ones are
/// close enough to something already there to be worth a decision. Writes
/// nothing. `mapping` is `Some` for a CSV (§88), `None` for QIF/OFX.
pub fn preview_import(
    pool: &DbPool,
    file_path: &str,
    account_id: &str,
    mapping: Option<&csv::CsvMapping>,
    window_days: u32,
) -> Result<matching::ImportMatchPreview, String> {
    let src = parse_source(file_path, mapping)?;
    let conn = pool.get().map_err(|e| e.to_string())?;
    let account_name: String = conn
        .query_row("SELECT name FROM accounts WHERE id = ?1", params![account_id], |r| r.get(0))
        .map_err(|e| format!("account {account_id} not found: {e}"))?;
    let txns = apply_payee_rules_to(&conn, account_id, src.txns)?;

    let mut rows: Vec<matching::IncomingRow> = Vec::new();
    let mut uncategorized: Vec<matching::UncategorizedRow> = Vec::new();
    let mut duplicates = 0u32;
    let mut new_rows = 0u32;
    let mut total = 0u32;
    // Register rows already claimed by an earlier row of this same file.
    let mut taken: std::collections::HashSet<String> = std::collections::HashSet::new();
    // §90: the file's distinct memos, in the order they first appear.
    let mut memo_groups: Vec<plan::MemoGroupSeed> = Vec::new();
    // The exact-duplicate count, counted the way the writer counts it, so
    // two identical rows in one file are not both called duplicates.
    let mut seen: HashMap<(String, i64, String), (i64, i64)> = HashMap::new();

    for (index, t) in txns.iter().enumerate() {
        if t.unknown_action.is_some() {
            continue;
        }
        // Investment records and bracketed transfers have their own dedupe
        // and their own shape; they are not offered for matching. An
        // investment row is instead grouped by its memo, for §90.
        if let Some(inv) = t.invest.as_ref().filter(|i| qif_activity(&i.action).is_some()) {
            let activity = qif_activity(&inv.action).unwrap();
            let memo = t.notes.as_deref().unwrap_or("").trim().to_string();
            let shares = inv.quantity_micro.unwrap_or(0).abs();
            match memo_groups.iter_mut().find(|g| g.memo == memo && g.activity == activity) {
                Some(g) => {
                    g.count += 1;
                    g.gross_cents += t.amount_cents.abs();
                    g.shares_micro += shares;
                }
                None => memo_groups.push(plan::MemoGroupSeed {
                    memo,
                    action: inv.action.trim().to_string(),
                    activity: activity.to_string(),
                    count: 1,
                    gross_cents: t.amount_cents.abs(),
                    shares_micro: shares,
                }),
            }
            continue;
        }
        if t.category.as_deref().filter(|c| is_transfer_category(c)).is_some()
            && transfer_target(&conn, t.category.as_deref().unwrap(), account_id)?.is_some()
        {
            continue;
        }
        total += 1;

        // Exactly what is already there, by the bank's id or by the old key.
        let exact = if let Some(fitid) = t.fitid.as_deref() {
            has_fitid(&conn, account_id, fitid)?
                || unlabeled_match(&conn, account_id, &t.date, t.amount_cents, &t.payee)?.is_some()
        } else {
            let key = (t.date.clone(), t.amount_cents, t.payee.clone());
            let entry = match seen.get(&key) {
                Some(e) => *e,
                None => {
                    let mut n = count_matching(&conn, account_id, &t.date, t.amount_cents, &t.payee)?;
                    if let Some(raw) = t.raw_payee.as_deref() {
                        n += count_matching(&conn, account_id, &t.date, t.amount_cents, raw)?;
                    }
                    (n, 0)
                }
            };
            let (existing, seen_so_far) = entry;
            seen.insert(key, (existing, seen_so_far + 1));
            seen_so_far < existing
        };
        if exact {
            duplicates += 1;
            continue;
        }

        let candidates = matching::candidates_for(
            &conn,
            account_id,
            &t.date,
            t.amount_cents,
            &t.payee,
            t.check_number.as_deref(),
            window_days,
            &taken,
        )?;
        if candidates.is_empty() {
            new_rows += 1;
            // §159 — nothing to match and nothing to file it under: the
            // review asks, rather than the row landing as Uncategorized.
            let file_says = t.category.as_deref().map(str::trim).filter(|c| !c.is_empty() && *c != "--Split--");
            if file_says.is_none() && t.rule_category_id.is_none() && t.splits.is_empty() {
                uncategorized.push(matching::UncategorizedRow {
                    index,
                    date: t.date.clone(),
                    payee: t.payee.clone(),
                    amount_cents: t.amount_cents,
                });
            }
            continue;
        }
        let likely = candidates[0].score >= matching::LIKELY;
        if likely {
            // Reserve it so the next row of this file cannot claim it too.
            taken.insert(candidates[0].existing.id.clone());
        }
        rows.push(matching::IncomingRow {
            index,
            date: t.date.clone(),
            payee: t.payee.clone(),
            amount_cents: t.amount_cents,
            check_number: t.check_number.clone(),
            candidates,
            likely,
        });
    }

    Ok(matching::ImportMatchPreview {
        account_id: account_id.to_string(),
        account_name,
        total_rows: total,
        duplicates,
        unreadable: src.unreadable,
        new_rows,
        rows,
        uncategorized,
        window_days,
        memo_groups: memo_groups.into_iter().map(|g| g.into_group()).collect(),
    })
}

/// §89: import the file with the user's answers from the review dialog.
/// Rows they did not answer for take the ordinary path.
pub fn import_with_decisions(
    pool: &DbPool,
    file_path: &str,
    account_id: &str,
    mapping: Option<&csv::CsvMapping>,
    decisions: Vec<matching::RowDecision>,
    memo_rules: Vec<plan::MemoRule>,
) -> Result<ImportSummary, String> {
    let src = parse_source(file_path, mapping)?;
    let mut by_index: HashMap<usize, matching::RowDecision> = HashMap::new();
    for d in decisions {
        if d.action == "match" && d.existing_id.as_deref().unwrap_or("").is_empty() {
            return Err(format!("row {} was marked as a match with nothing to match it to", d.index + 1));
        }
        // §159 — a category that is not there is refused up front, not
        // discovered as a foreign-key error halfway through the write.
        if let Some(cat) = d.category_id.as_deref().filter(|c| !c.trim().is_empty()) {
            let conn = pool.get().map_err(|e| e.to_string())?;
            let exists: bool = conn
                .query_row("SELECT EXISTS(SELECT 1 FROM categories WHERE id = ?1)", params![cat], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            if !exists {
                return Err(format!("row {}: the category chosen for it no longer exists", d.index + 1));
            }
        }
        by_index.insert(d.index, d);
    }
    import_parsed(pool, account_id, src, &by_index, &memo_rules)
}

/// §90: the category a plan's paired cash row lands in, created on the right
/// side of the tree if it is not there. `ensure_category_path` creates a new
/// top-level category as an expense, which is wrong for a contribution.
fn ensure_category_of_kind(tx: &Connection, path: &str, kind: &str) -> Result<String, String> {
    let mut parts = path.split(':').map(str::trim).filter(|p| !p.is_empty());
    let Some(top) = parts.next() else {
        return Err("category name is empty".to_string());
    };
    let existing: Option<String> = tx
        .query_row(
            "SELECT id FROM categories WHERE name = ?1 COLLATE NOCASE AND parent_id IS NULL",
            params![top],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if existing.is_none() {
        tx.execute(
            "INSERT INTO categories (id, name, kind) VALUES (?1, ?2, ?3)",
            params![Uuid::new_v4().to_string(), top, kind],
        )
        .map_err(|e| e.to_string())?;
    }
    ensure_category_path(tx, path)
}

/// §84's rename rules, applied before anything is matched or written. An
/// investment record's payee is its security; rules leave those alone.
fn apply_payee_rules_to(conn: &Connection, account_id: &str, txns: Vec<ParsedTxn>) -> Result<Vec<ParsedTxn>, String> {
    let rules = list_payee_rules(conn)?;
    Ok(txns
        .into_iter()
        .map(|mut t| {
            if t.invest.is_none() {
                // §171 — the row.s amount, memo and account are the rule.s to look at too.
                if let Some(rule) = rule_for(&rules, &t.payee, t.amount_cents, t.notes.as_deref().unwrap_or(""), account_id) {
                    if t.payee != rule.payee_name {
                        t.raw_payee = Some(std::mem::replace(&mut t.payee, rule.payee_name.clone()));
                    }
                    t.rule_category_id = rule.category_id.clone();
                }
            }
            t
        })
        .collect())
}

/// The writing half of an import, shared by QIF, OFX and CSV (§88): payee
/// rules, dedupe, categories, payees, transfers, splits, the investment
/// side — one SQL transaction. `ofx_text` is the OFX file when there is one,
/// for its investment statement (§44).
fn import_parsed(
    pool: &DbPool,
    account_id: &str,
    src: ParsedSource,
    decisions: &HashMap<usize, matching::RowDecision>,
    memo_rules: &[plan::MemoRule],
) -> Result<ImportSummary, String> {
    let ParsedSource { txns, qif_securities, qif_prices, unreadable, text: source_text, is_ofx, bad } = src;
    let ofx_text = if is_ofx { Some(source_text.as_str()) } else { None };

    let txns: Vec<ParsedTxn> = {
        let conn = pool.get().map_err(|e| e.to_string())?;
        apply_payee_rules_to(&conn, account_id, txns)?
    };

    let account_name: String = {
        let conn = pool.get().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT name FROM accounts WHERE id = ?1",
            params![account_id],
            |r| r.get(0),
        )
        .map_err(|e| format!("account {account_id} not found: {e}"))?
    };

    let conn = pool.get().map_err(|e| e.to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let account_kind: String = tx
        .query_row("SELECT type FROM accounts WHERE id = ?1", params![account_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let is_invest_account = matches!(account_kind.as_str(), "investment" | "retirement");
    let mut investments = 0u32;
    let mut securities_created = 0u32;
    // QIF security names → ids, resolved as they are met (§66).
    let mut qif_sec_ids: HashMap<String, String> = HashMap::new();

    let mut imported = 0u32;
    let mut skipped = unreadable;
    let mut duplicates = 0u32;
    // §90: the cash rows written beside the plan's share rows.
    let (mut contributed, mut contributed_cents) = (0u32, 0i64);
    let (mut fees_booked, mut fees_cents) = (0u32, 0i64);
    let (mut withdrawn, mut withdrawn_cents) = (0u32, 0i64);
    // §89: rows the user paired with one already in the register, and rows
    // they told the importer to leave out.
    let mut matched = 0u32;
    let mut user_skipped = 0u32;
    // Register rows already claimed by a decision in this file.
    let mut claimed: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut balance_delta = 0i64;
    let mut transfers_linked = 0u32;
    // Movement the transfer pairs already applied to this account's stored
    // balance — reported, not applied again.
    let mut pair_delta = 0i64;
    let mut notes: Vec<String> = Vec::new();
    // Bracketed targets with no account of that name, each noted once.
    let mut unknown_targets: Vec<String> = Vec::new();
    // (date, amount, payee) → how many the account held BEFORE this import,
    // and how many of this file's rows with that key have been seen so far.
    let mut seen: HashMap<(String, i64, String), (i64, i64)> = HashMap::new();

    for (row_index, t) in txns.iter().enumerate() {
        // §90: an investment action with no meaning here. Named, not guessed
        // at, and above all not turned into a cash row.
        if let Some(action) = t.unknown_action.as_deref() {
            skipped += 1;
            let line = format!("{action} on {} was left out: not an action this reads.", t.date);
            if !notes.contains(&line) {
                notes.push(line);
            }
            continue;
        }

        // A QIF investment record that moves shares or books income (§66).
        // Cash-only actions (XIn, XOut, Cash, MiscInc…) were already turned
        // into ordinary signed rows by `qif_cash_side` and take the paths
        // below like any bank row.
        if let Some(inv) = t.invest.as_ref().filter(|i| qif_activity(&i.action).is_some()) {
            if !is_invest_account {
                return Err(format!(
                    "this is an investment QIF (a {} on {}) and {account_name} is a {account_kind} account — import it into an investment or retirement account",
                    inv.action, t.date
                ));
            }
            let file_activity = qif_activity(&inv.action).unwrap();
            // §90: what this memo means in this plan's wording. `AsIs` is
            // every import before §90 and every file with no rules given.
            let memo = t.notes.as_deref().unwrap_or("").trim().to_string();
            let rule = plan::rule_for(memo_rules, &memo, file_activity);
            let treatment = rule.map(|r| r.treatment).unwrap_or(plan::Treatment::AsIs);
            let activity = match treatment {
                // The plan called it a purchase; it is a distribution paid in
                // shares. Books the income, moves no cash.
                plan::Treatment::Reinvest if file_activity == "buy" => "reinvest_dividend",
                // Shares taken to pay a fee: a real disposal, so the lots
                // close and the basis is right.
                plan::Treatment::Fee if file_activity == "remove_shares" => "sell",
                _ => file_activity,
            };
            let Some(sec_name) = inv.security.as_deref().filter(|s| !s.trim().is_empty()) else {
                notes.push(format!("{} on {} names no security and was left out.", inv.action, t.date));
                continue;
            };
            let security_id = match qif_sec_ids.get(sec_name) {
                Some(id) => id.clone(),
                None => {
                    let known = qif_securities.iter().find(|q| q.name.eq_ignore_ascii_case(sec_name));
                    let sec = ofx::OfxSecurity {
                        unique_id: sec_name.to_string(),
                        name: sec_name.to_string(),
                        ticker: known.and_then(|k| k.symbol.clone()),
                        kind: qif_security_kind(known.and_then(|k| k.kind.as_deref())).to_string(),
                    };
                    let (id, created) = resolve_security(&tx, &sec)?;
                    if created {
                        securities_created += 1;
                    }
                    qif_sec_ids.insert(sec_name.to_string(), id.clone());
                    id
                }
            };
            let money = t.amount_cents.abs();
            let commission = inv.commission_cents.abs();
            let shares = inv.quantity_micro.unwrap_or(0).abs();
            let (shares_micro, gross_cents, price_micro) = match activity {
                // Quicken's T on a buy is the total paid (with commission); on a sell the net received.
                "buy" => (shares, money.saturating_sub(commission), inv.price_micro),
                "sell" => (shares, money + commission, inv.price_micro),
                // Ratio × 10 in the file.
                "split" => (shares / 10, 0, None),
                "add_shares" | "remove_shares" => (shares, if money > 0 { money } else { shares_times_price(shares, inv.price_micro) }, inv.price_micro),
                _ => (shares, money, inv.price_micro),
            };
            let needs_shares = matches!(activity, "buy" | "sell" | "add_shares" | "remove_shares") || activity.starts_with("reinvest_");
            if needs_shares && shares_micro == 0 {
                notes.push(format!("{} of {} on {} has no share count and was left out.", inv.action, sec_name, t.date));
                continue;
            }
            // Duplicate: the account already holds this activity for this
            // security on this date for this gross, counted like the bank rows.
            let key = (t.date.clone(), gross_cents, format!("\u{0}invest:{activity}:{security_id}:{shares_micro}"));
            let entry = match seen.get(&key) {
                Some(e) => *e,
                None => (count_invest_matching(&tx, account_id, &t.date, activity, &security_id, shares_micro, gross_cents)?, 0),
            };
            let (existing, seen_so_far) = entry;
            seen.insert(key, (existing, seen_so_far + 1));
            if seen_so_far < existing {
                duplicates += 1;
                continue;
            }
            // BuyX / SellX: the cash came from, or went to, another account.
            let funding = match t.category.as_deref().filter(|c| is_transfer_category(c)) {
                Some(cat) if matches!(activity, "buy" | "sell" | "dividend" | "interest" | "ltcg_dist" | "stcg_dist" | "return_of_capital") => transfer_target(&tx, cat, account_id)?.map(|(id, _)| id),
                _ => None,
            };
            let row = NewInvestmentTransaction {
                account_id: account_id.to_string(),
                date: t.date.clone(),
                activity: activity.to_string(),
                security_id,
                shares_micro,
                price_micro,
                gross_cents,
                commission_cents: commission,
                category_id: None,
                notes: t.notes.clone(),
                funding_account_id: funding,
                lot_allocations: vec![],
            };
            let id = insert_investment_transaction(&tx, &row, None).map_err(|e| {
                format!("import aborted, nothing was written: the {} of {} dated {} was refused — {e}", inv.action, sec_name, t.date)
            })?;
            tx.execute(
                "UPDATE transactions SET is_reconciled = ?2, cleared_state = ?3 WHERE id = ?1",
                params![id, (t.cleared_state == "R") as i64, t.cleared_state],
            )
            .map_err(|e| e.to_string())?;
            investments += 1;

            // §90: the cash side the plan's file never wrote. The paired row
            // is exactly the opposite of what the investment row did to the
            // cash, so the account nets to zero and the money is finally
            // somewhere a report can see it.
            if matches!(treatment, plan::Treatment::Contribution | plan::Treatment::Fee | plan::Treatment::Withdrawal) {
                let effect = crate::db::queries::investment_cash_effect(activity, gross_cents, commission);
                if effect != 0 {
                    let (default_path, kind) = treatment.default_category().unwrap_or(("", "expense"));
                    let path = rule
                        .and_then(|r| r.category.clone())
                        .filter(|c| !c.trim().is_empty())
                        .unwrap_or_else(|| default_path.to_string());
                    let category_id = if path.trim().is_empty() { None } else { Some(ensure_category_of_kind(&tx, &path, kind)?) };
                    let payee = if memo.is_empty() { treatment.label().to_string() } else { memo.clone() };
                    let payee_id = upsert_payee(&tx, &payee, category_id.as_deref()).map_err(|e| e.to_string())?;
                    let cash_id = Uuid::new_v4().to_string();
                    tx.execute(
                        "INSERT INTO transactions
                           (id, account_id, date, payee, payee_id, category_id, amount_cents,
                            is_reconciled, notes, check_number, cleared_state)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10)",
                        params![
                            cash_id,
                            account_id,
                            t.date,
                            payee,
                            payee_id,
                            category_id,
                            -effect,
                            (t.cleared_state == "R") as i64,
                            Some(format!("{} — {}", treatment.label(), sec_name)),
                            t.cleared_state
                        ],
                    )
                    .map_err(|e| e.to_string())?;
                    balance_delta += -effect;
                    match treatment {
                        plan::Treatment::Contribution => {
                            contributed += 1;
                            contributed_cents += -effect;
                        }
                        plan::Treatment::Fee => {
                            fees_booked += 1;
                            fees_cents += effect;
                        }
                        _ => {
                            withdrawn += 1;
                            withdrawn_cents += effect;
                        }
                    }
                }
            }
            continue;
        }

        // A QIF transfer (§65): `L[Savings]`. When an account by that name
        // exists the row becomes one side of a LINKED transfer — matched to
        // the far side if the other file already put it there unlinked,
        // skipped if the far side's import already wrote the pair, else
        // written as a pair now (so the other file's row is then the
        // duplicate). No account by that name: a plain row, as before.
        if let Some(cat) = t.category.as_deref().filter(|c| is_transfer_category(c)) {
            if let Some((other_id, other_name)) = transfer_target(&tx, cat, account_id)? {
                let key = (t.date.clone(), t.amount_cents, format!("\u{0}transfer:{other_id}"));
                let entry = match seen.get(&key) {
                    Some(e) => *e,
                    None => (count_linked(&tx, account_id, &other_id, &t.date, t.amount_cents)?, 0),
                };
                let (existing, seen_so_far) = entry;
                seen.insert(key, (existing, seen_so_far + 1));
                if seen_so_far < existing {
                    duplicates += 1;
                    continue;
                }
                let payee = if t.payee.trim().is_empty() { "Transfer Money".to_string() } else { t.payee.clone() };
                let this_id = if let Some(far_id) = unlinked_counterpart(&tx, &other_id, &t.date, t.amount_cents)? {
                    // Link to the row the other file left waiting.
                    let id = Uuid::new_v4().to_string();
                    let payee_id = upsert_payee(&tx, &payee, None).map_err(|e| e.to_string())?;
                    tx.execute(
                        "INSERT INTO transactions
                           (id, account_id, date, payee, payee_id, category_id, amount_cents, is_reconciled, notes, check_number, cleared_state)
                         VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?8, ?9, ?10)",
                        params![id, account_id, t.date, payee, payee_id, t.amount_cents, (t.cleared_state == "R") as i64, t.notes, t.check_number, t.cleared_state],
                    )
                    .map_err(|e| e.to_string())?;
                    tx.execute("UPDATE transactions SET transfer_id = ?2 WHERE id = ?1", params![id, far_id]).map_err(|e| e.to_string())?;
                    tx.execute("UPDATE transactions SET transfer_id = ?2 WHERE id = ?1", params![far_id, id]).map_err(|e| e.to_string())?;
                    balance_delta += t.amount_cents;
                    id
                } else {
                    // Write the pair; the other account's balance moves with it.
                    let magnitude = t.amount_cents.abs();
                    if magnitude == 0 {
                        continue;
                    }
                    let (from, to) = if t.amount_cents < 0 { (account_id, other_id.as_str()) } else { (other_id.as_str(), account_id) };
                    let (from_id, to_id) = insert_transfer_pair_named(&tx, from, to, &t.date, magnitude, t.notes.as_deref(), &payee)?;
                    let mine = if t.amount_cents < 0 { from_id } else { to_id };
                    tx.execute(
                        "UPDATE transactions SET is_reconciled = ?2, cleared_state = ?3, check_number = ?4 WHERE id = ?1",
                        params![mine, (t.cleared_state == "R") as i64, t.cleared_state, t.check_number],
                    )
                    .map_err(|e| e.to_string())?;
                    // The pair moved THIS account's stored balance already; the
                    // delta reported is still what this file added here.
                    pair_delta += t.amount_cents;
                    mine
                };
                let _ = this_id;
                imported += 1;
                transfers_linked += 1;
                let _ = &other_name;
                continue;
            } else {
                let name = cat.trim().trim_matches(|c| c == '[' || c == ']').trim().to_string();
                if !unknown_targets.contains(&name) {
                    unknown_targets.push(name);
                }
            }
        }

        // §89: the user looked at this row in the review dialog and said what
        // it is. Their answer stands over the automatic dedupe below — the
        // whole point of asking is that the automatic test could not tell.
        match decisions.get(&row_index).map(|d| d.action.as_str()) {
            Some("skip") => {
                user_skipped += 1;
                continue;
            }
            Some("match") => {
                let existing_id = decisions[&row_index].existing_id.clone().unwrap_or_default();
                let found: Option<(i64, i64, Option<String>)> = tx
                    .query_row(
                        "SELECT amount_cents, is_void, activity FROM transactions
                          WHERE id = ?1 AND account_id = ?2",
                        params![existing_id, account_id],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?;
                let Some((amount_cents, is_void, activity)) = found else {
                    return Err(format!(
                        "import aborted, nothing was written: the row dated {} for {} was matched to a transaction that is no longer in {account_name}",
                        t.date, t.payee
                    ));
                };
                // The gate the whole feature rests on. A pairing that does not
                // agree to the cent is a mistake, not a match.
                if amount_cents != t.amount_cents || is_void != 0 || activity.is_some() {
                    return Err(format!(
                        "import aborted, nothing was written: the row dated {} for {} ({}) cannot be matched to that transaction — the amounts differ or it is void",
                        t.date,
                        t.payee,
                        crate::models::format_cents(t.amount_cents)
                    ));
                }
                if !claimed.insert(existing_id.clone()) {
                    return Err(format!(
                        "import aborted, nothing was written: two rows were matched to the same transaction in {account_name}"
                    ));
                }
                // Keep the user's payee, category and memo — they cleaned
                // those up. Take the cleared mark (this is a statement, so
                // the bank has seen it), the bank's id so a re-import is
                // answered by the id alone, and a check number if the row
                // had none.
                tx.execute(
                    "UPDATE transactions
                        SET cleared_state = CASE WHEN cleared_state = 'R' THEN 'R' ELSE 'C' END,
                            fitid         = COALESCE(fitid, ?2),
                            check_number  = COALESCE(NULLIF(check_number, ''), ?3)
                      WHERE id = ?1",
                    params![existing_id, t.fitid, t.check_number],
                )
                .map_err(|e| e.to_string())?;
                matched += 1;
                continue;
            }
            _ => {}
        }
        // "new" — the user looked at the candidates and said this really is a
        // separate transaction. The automatic test does not get to overrule
        // that, so it is not run for this row.
        let force_new = decisions.get(&row_index).map(|d| d.action.as_str()) == Some("new");

        // By the bank's id first. A row that arrived before ids were stored
        // (any import before migration 0021) has `fitid = NULL`, so when the
        // id is not found the text key is tried as well — against unlabeled
        // rows only — and a match is labeled with the id, so the next
        // re-import is answered by the id alone. Without this, re-importing
        // an already-imported statement doubled every row.
        let mut is_dup = false;
        if force_new {
            // Nothing to test: the user already answered for this row.
        } else if let Some(fitid) = t.fitid.as_deref() {
            if has_fitid(&tx, account_id, fitid)? {
                is_dup = true;
            } else if let Some(row_id) = match unlabeled_match(&tx, account_id, &t.date, t.amount_cents, &t.payee)? {
                Some(r) => Some(r),
                None => match t.raw_payee.as_deref() {
                    Some(raw) => unlabeled_match(&tx, account_id, &t.date, t.amount_cents, raw)?,
                    None => None,
                },
            } {
                tx.execute(
                    "UPDATE transactions SET fitid = ?2 WHERE id = ?1",
                    params![row_id, fitid],
                )
                .map_err(|e| e.to_string())?;
                is_dup = true;
            }
        } else {
            let key = (t.date.clone(), t.amount_cents, t.payee.clone());
            let entry = match seen.get(&key) {
                Some(e) => *e,
                None => {
                    // Rows imported before a rule existed carry the raw name.
                    let mut n = count_matching(&tx, account_id, &t.date, t.amount_cents, &t.payee)?;
                    if let Some(raw) = t.raw_payee.as_deref() {
                        n += count_matching(&tx, account_id, &t.date, t.amount_cents, raw)?;
                    }
                    (n, 0)
                }
            };
            let (existing, seen_so_far) = entry;
            seen.insert(key, (existing, seen_so_far + 1));
            is_dup = seen_so_far < existing;
        }
        if is_dup {
            duplicates += 1;
            continue;
        }

        // Ensure the category exists. `Food:Groceries` resolves to the
        // subcategory since §54 (it used to be flattened to `Food`). A
        // bracketed QIF transfer target is left uncategorized on purpose.
        let category_id = match &t.category {
            _ if !t.splits.is_empty() => None,
            Some(cat) if is_transfer_category(cat) => None,
            Some(cat) if cat.trim().trim_matches(':').is_empty() || cat.trim().eq_ignore_ascii_case("--Split--") => None,
            Some(cat) => Some(ensure_category_path(&tx, cat).map_err(|e| e.to_string())?),
            None => t.rule_category_id.clone(),
        };
        // §159 — what the review chose for a row that had none. It never
        // overrides a category the file or a rule supplied, because the
        // review only offers the choice for rows that had neither; and a
        // split keeps its lines' categories, not a header one.
        let category_id = match category_id {
            Some(c) => Some(c),
            None if t.splits.is_empty() => decisions
                .get(&row_index)
                .and_then(|d| d.category_id.clone())
                .filter(|c| !c.trim().is_empty()),
            None => None,
        };

        // Import is where most payees come from in practice, so this is the
        // most important of the five write paths to get right (§13).
        let payee_id = if t.payee.trim().is_empty() {
            None
        } else {
            Some(
                upsert_payee(&tx, &t.payee, category_id.as_deref())
                    .map_err(|e| e.to_string())?,
            )
        };

        let id = Uuid::new_v4().to_string();
        match tx.execute(
            "INSERT INTO transactions
               (id, account_id, date, payee, payee_id, category_id, amount_cents,
                is_reconciled, notes, fitid, check_number, cleared_state)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                id,
                account_id,
                t.date,
                t.payee,
                payee_id,
                category_id,
                t.amount_cents,
                (t.cleared_state == "R") as i64,
                t.notes,
                t.fitid,
                t.check_number,
                t.cleared_state,
            ],
        ) {
            Ok(_) => {
                imported += 1;
                balance_delta += t.amount_cents;
                // Split lines (§65), each under its own category — and
                // §122: a bracketed account in a split line is a TRANSFER.
                //
                // Migration 0033 gave `splits` a `transfer_account_id` for
                // exactly this, and 0034 gave the far row
                // `is_split_transfer` so no report counts it. The importer
                // used neither: a bracketed split line was written as an
                // uncategorized line and nothing else, so a QIF whose
                // mortgage payment splits interest to a category and
                // principal to the loan put the interest in the right place,
                // never moved the loan at all, and left the principal
                // sitting in Uncategorized spending — the precise failure
                // `is_split_transfer` was added to prevent. One transaction
                // in the register split across accounts is the shape this
                // application is built around; it just could not be
                // imported.
                for (i, sp) in t.splits.iter().enumerate() {
                    let bracketed = sp.category.as_deref().filter(|c| is_transfer_category(c));
                    let target = match bracketed {
                        Some(c) => {
                            let found = transfer_target(&tx, c, account_id)?;
                            if found.is_none() {
                                // Named, not silently swallowed — the same
                                // note the top-level path gives.
                                let name = c.trim().trim_matches(|ch| ch == '[' || ch == ']').trim().to_string();
                                if !unknown_targets.contains(&name) {
                                    unknown_targets.push(name);
                                }
                            }
                            found
                        }
                        None => None,
                    };
                    let cat_id = match sp.category.as_deref() {
                        Some(c) if is_transfer_category(c) => None,
                        Some(c) if c.trim().trim_matches(':').is_empty() => None,
                        Some(c) => Some(ensure_category_path(&tx, c).map_err(|e| e.to_string())?),
                        None => None,
                    };
                    // The far row: the opposite amount in the other account,
                    // no category and no payee of its own, marked as a split
                    // transfer. Written the same way `set_splits` writes it,
                    // so an imported payment and one typed into Record
                    // payment are the same rows afterwards.
                    let far_id = match target.as_ref() {
                        Some((other_id, _)) if sp.amount_cents != 0 => {
                            let far = Uuid::new_v4().to_string();
                            tx.execute(
                                "INSERT INTO transactions
                                   (id, account_id, date, payee, payee_id, category_id, amount_cents,
                                    is_reconciled, notes, cleared_state, is_void, is_split_transfer)
                                 VALUES (?1, ?2, ?3, ?4, NULL, NULL, ?5, 0, ?6, '', 0, 1)",
                                params![far, other_id, t.date, t.payee, -sp.amount_cents, sp.memo],
                            )
                            .map_err(|e| e.to_string())?;
                            tx.execute(
                                "UPDATE accounts SET balance_cents = balance_cents + ?2,
                                        updated_at = datetime('now') WHERE id = ?1",
                                params![other_id, -sp.amount_cents],
                            )
                            .map_err(|e| e.to_string())?;
                            transfers_linked += 1;
                            Some(far)
                        }
                        _ => None,
                    };
                    tx.execute(
                        "INSERT INTO splits (id, transaction_id, category_id, description, amount_cents,
                                             sort_order, transfer_account_id, transfer_txn_id)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                        params![
                            Uuid::new_v4().to_string(),
                            id,
                            cat_id,
                            sp.memo,
                            sp.amount_cents,
                            i as i64,
                            target.as_ref().map(|(a, _)| a.as_str()),
                            far_id
                        ],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
            // Not silent: a row the database refused is a row the user
            // needs to hear about, with the reason.
            Err(e) => {
                return Err(format!(
                    "import aborted, nothing was written: the row dated {} for {} ({}) was refused — {e}",
                    t.date,
                    t.payee,
                    crate::models::format_cents(t.amount_cents)
                ))
            }
        }
    }

    // Apply the net balance change to the account.
    tx.execute(
        "UPDATE accounts SET balance_cents = balance_cents + ?1, updated_at = datetime('now')
         WHERE id = ?2",
        params![balance_delta, account_id],
    )
    .map_err(|e| e.to_string())?;

    // The investment side (§44): buys, sells, income, reinvestments, share
    // moves, splits — into lots. `insert_investment_transaction` keeps the
    // account's cash in step itself, so nothing is added to `balance_delta`.
    for name in &unknown_targets {
        notes.push(format!("Transfers to \"{name}\" came in as plain rows: there is no account by that name yet. Add it and import its file, and they link up."));
    }
    if let Some(text) = ofx_text.filter(|t| ofx::has_investments(t)) {
        let inv = ofx::parse_ofx_investments(text);
        notes.extend(inv.skipped.iter().cloned());
        if !inv.transactions.is_empty() || !inv.prices.is_empty() {
            let kind: String = tx
                .query_row("SELECT type FROM accounts WHERE id = ?1", params![account_id], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            if !matches!(kind.as_str(), "investment" | "retirement") {
                return Err(format!(
                    "this is an investment statement ({} investment rows) and {account_name} is a {kind} account — import it into an investment or retirement account",
                    inv.transactions.len()
                ));
            }
            let mut by_uid: HashMap<String, String> = HashMap::new();
            for sec in &inv.securities {
                let (id, created) = resolve_security(&tx, sec)?;
                if created {
                    securities_created += 1;
                }
                by_uid.insert(sec.unique_id.clone(), id);
            }
            for t in &inv.transactions {
                let Some(security_id) = by_uid.get(&t.unique_id).cloned() else {
                    // Named in a transaction but not in SECLIST: make one from the id.
                    let (id, created) = resolve_security(
                        &tx,
                        &ofx::OfxSecurity { unique_id: t.unique_id.clone(), name: t.unique_id.clone(), ticker: None, kind: "other".to_string() },
                    )?;
                    if created {
                        securities_created += 1;
                    }
                    by_uid.insert(t.unique_id.clone(), id.clone());
                    continue_with(&tx, account_id, t, &id, &mut investments, &mut duplicates)?;
                    continue;
                };
                continue_with(&tx, account_id, t, &security_id, &mut investments, &mut duplicates)?;
            }
            for p in &inv.prices {
                if let Some(id) = by_uid.get(&p.unique_id) {
                    set_security_price(&tx, id, &p.date, p.price_micro, "fetched")?;
                }
            }
        }
    }

    // §92: the file's price block, applied after the rows so a security the
    // file created is there to attach a price to. Matched by symbol first,
    // then by name — a plan's funds have no ticker, so the name is all there
    // is. A price for a security this file never mentioned is named, not
    // silently dropped: it usually means a typo in the file.
    let mut priced = 0u32;
    let mut unknown_priced: Vec<String> = Vec::new();
    for p in &qif_prices {
        let id: Option<String> = tx
            .query_row(
                "SELECT id FROM securities WHERE symbol = ?1 COLLATE NOCASE
                  UNION ALL SELECT id FROM securities WHERE name = ?1 COLLATE NOCASE
                  LIMIT 1",
                params![p.security],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        match id {
            Some(id) => {
                set_security_price(&tx, &id, &p.date, p.price_micro, "fetched")?;
                priced += 1;
            }
            None => {
                if !unknown_priced.contains(&p.security) {
                    unknown_priced.push(p.security.clone());
                }
            }
        }
    }
    if priced > 0 {
        notes.push(format!("{priced} price{} read from the file.", if priced == 1 { "" } else { "s" }));
    }
    if !unknown_priced.is_empty() {
        notes.push(format!(
            "Prices for {} were left out: no security of that name or symbol.",
            unknown_priced.join(", ")
        ));
    }

    tx.commit().map_err(|e| e.to_string())?;

    // §90: say what was booked beside the plan's share rows, in money.
    if contributed > 0 {
        notes.push(format!(
            "Booked {contributed} contribution{} totaling {} beside the purchases — the plan's file records only the shares.",
            if contributed == 1 { "" } else { "s" },
            crate::models::format_cents(contributed_cents)
        ));
    }
    if fees_booked > 0 {
        notes.push(format!(
            "{fees_booked} fee{} totaling {} came out as shares and are now in your spending too.",
            if fees_booked == 1 { "" } else { "s" },
            crate::models::format_cents(fees_cents)
        ));
    }
    if withdrawn > 0 {
        notes.push(format!(
            "{withdrawn} withdrawal{} totaling {} left the account.",
            if withdrawn == 1 { "" } else { "s" },
            crate::models::format_cents(withdrawn_cents)
        ));
    }

    // §88: the CSV rows the mapping could not read, named.
    if !bad.is_empty() {
        notes.push(format!(
            "{unreadable} row{} could not be read: {}",
            if unreadable == 1 { "" } else { "s" },
            bad.join("; ")
        ));
    }

    Ok(ImportSummary {
        account_id: account_id.to_string(),
        account_name,
        imported,
        skipped,
        duplicates,
        balance_delta_cents: balance_delta + pair_delta,
        investments,
        securities_created,
        transfers_linked,
        matched,
        user_skipped,
        notes,
    })
}

/// Quicken's investment action → the app's activity, for the actions that
/// move shares or book income. Cash actions are not here: see
/// `qif_cash_side`.
fn qif_activity(action: &str) -> Option<&'static str> {
    Some(match action.trim().to_ascii_lowercase().as_str() {
        "buy" | "buyx" => "buy",
        "sell" | "sellx" => "sell",
        "div" | "divx" => "dividend",
        "intinc" | "intincx" => "interest",
        "cglong" | "cglongx" => "ltcg_dist",
        "cgshort" | "cgshortx" => "stcg_dist",
        "reinvdiv" => "reinvest_dividend",
        "reinvint" => "reinvest_interest",
        "reinvlg" => "reinvest_ltcg",
        "reinvsh" => "reinvest_stcg",
        "shrsin" => "add_shares",
        "shrsout" => "remove_shares",
        "rtrncap" | "rtrncapx" => "return_of_capital",
        "stksplit" => "split",
        _ => return None,
    })
}

/// A `!Type:Security` T value → the app's kind.
fn qif_security_kind(t: Option<&str>) -> &'static str {
    match t.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("stock") => "stock",
        Some("mutual fund") | Some("mutual_fund") => "mutual_fund",
        Some("etf") => "etf",
        Some("bond") => "bond",
        Some("cd") => "cd",
        Some("money market") | Some("money_market") => "money_market",
        _ => "other",
    }
}

fn shares_times_price(shares_micro: i64, price_micro: Option<i64>) -> i64 {
    match price_micro {
        Some(p) => ((shares_micro as i128 * p as i128 + 5_000_000_000) / 10_000_000_000) as i64,
        None => 0,
    }
}

/// The cash-only investment actions become ordinary signed rows so the
/// transfer and category paths handle them: XIn / XOut and their `$`
/// amount to a bracketed account, Cash / MiscInc / MiscExp / ContribX /
/// WithdrwX with a category. Share actions pass through untouched.
fn qif_cash_side(mut t: ParsedTxn) -> ParsedTxn {
    let Some(inv) = t.invest.as_ref() else { return t };
    if qif_activity(&inv.action).is_some() {
        return t;
    }
    let action = inv.action.trim().to_ascii_lowercase();
    // §90: an action that is neither a share activity nor one of Quicken's
    // cash actions is not a cash row. Some plans write "Change in Market
    // Value" with no action at all, and it used to arrive as a deposit of
    // its eight cents under the payee "null".
    const CASH_ACTIONS: &[&str] = &[
        "xin", "xout", "contribx", "withdrwx", "miscinc", "miscincx", "miscexp", "miscexpx", "cash", "margint",
    ];
    if !CASH_ACTIONS.contains(&action.as_str()) {
        t.unknown_action = Some(if inv.action.trim().is_empty() { "(no action)".to_string() } else { inv.action.trim().to_string() });
        return t;
    }
    let amount = inv.xfer_cents.filter(|a| *a != 0).unwrap_or(t.amount_cents).abs();
    t.amount_cents = match action.as_str() {
        "xin" | "contribx" | "miscinc" | "miscincx" | "cash" if t.amount_cents >= 0 => amount,
        "xout" | "withdrwx" | "miscexp" | "miscexpx" | "margint" => -amount,
        _ => t.amount_cents,
    };
    if t.payee.trim().is_empty() {
        t.payee = match action.as_str() {
            "xin" | "xout" | "contribx" | "withdrwx" => "Transfer Money".to_string(),
            _ => inv.action.clone(),
        };
    }
    t.invest = None;
    t
}

/// How many identical investment rows the account already holds.
fn count_invest_matching(tx: &Connection, account_id: &str, date: &str, activity: &str, security_id: &str, shares_micro: i64, gross_cents: i64) -> Result<i64, String> {
    tx.query_row(
        "SELECT COUNT(*) FROM transactions
          WHERE account_id = ?1 AND date = ?2 AND activity = ?3 AND security_id = ?4
            AND COALESCE(shares_micro, 0) = ?5 AND COALESCE(gross_cents, 0) = ?6 AND is_void = 0",
        params![account_id, date, activity, security_id, shares_micro, gross_cents],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// One investment row: skip it if the broker's id is already in the account,
/// else write it.
fn continue_with(
    tx: &Connection,
    account_id: &str,
    t: &ofx::OfxInvestment,
    security_id: &str,
    investments: &mut u32,
    duplicates: &mut u32,
) -> Result<(), String> {
    if let Some(f) = t.fitid.as_deref() {
        if has_fitid(tx, account_id, f)? {
            *duplicates += 1;
            return Ok(());
        }
    }
    let row = NewInvestmentTransaction {
        account_id: account_id.to_string(),
        date: t.date.clone(),
        activity: t.activity.clone(),
        security_id: security_id.to_string(),
        shares_micro: t.shares_micro,
        price_micro: t.price_micro,
        gross_cents: t.gross_cents,
        commission_cents: t.commission_cents,
        category_id: None,
        notes: t.memo.clone(),
        funding_account_id: None,
        lot_allocations: vec![],
    };
    insert_investment_transaction(tx, &row, t.fitid.as_deref()).map_err(|e| {
        format!("import aborted, nothing was written: the {} dated {} was refused — {e}", t.activity, t.date)
    })?;
    *investments += 1;
    Ok(())
}

/// The app's security for a broker's: by ticker, then by name, then by the
/// CUSIP kept in the notes of one created here; else create it. Returns
/// (id, created).
fn resolve_security(tx: &Connection, sec: &ofx::OfxSecurity) -> Result<(String, bool), String> {
    let cusip_note = format!("CUSIP {}", sec.unique_id);
    if let Some(t) = sec.ticker.as_deref().filter(|t| !t.is_empty()) {
        if let Some(id) = tx
            .query_row("SELECT id FROM securities WHERE symbol = ?1 COLLATE NOCASE", params![t], |r| r.get::<_, String>(0))
            .optional()
            .map_err(|e| e.to_string())?
        {
            return Ok((id, false));
        }
    }
    if let Some(id) = tx
        .query_row("SELECT id FROM securities WHERE name = ?1 COLLATE NOCASE", params![sec.name], |r| r.get::<_, String>(0))
        .optional()
        .map_err(|e| e.to_string())?
    {
        return Ok((id, false));
    }
    if let Some(id) = tx
        .query_row("SELECT id FROM securities WHERE notes LIKE '%' || ?1 || '%'", params![cusip_note], |r| r.get::<_, String>(0))
        .optional()
        .map_err(|e| e.to_string())?
    {
        return Ok((id, false));
    }
    // Money's QIF has no security records: a file whose securities are named
    // by ticker arrives with no symbols. A name that reads as one is one (§75).
    let ticker = match sec.ticker.as_deref().filter(|t| !t.is_empty()) {
        Some(t) => t.to_string(),
        None if crate::db::queries::ticker_like(&sec.name) => sec.name.trim().to_string(),
        None => String::new(),
    };
    let created = create_security(tx, &sec.name, &ticker, &sec.kind, Some(&cusip_note))?;
    Ok((created.id, true))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
//
// `qif.rs` and `ofx.rs` test their parsers. Nothing tested `import_file`
// itself, which is where the money actually moves: the dedup guard that makes
// a re-import idempotent, the balance delta, and the payee rows an import
// creates (§21.5). Import is how most payees enter a real file, so the payee
// assertions here matter as much as the balance ones.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::queries::{create_account, get_account, list_payees, get_register};

    // §182 — the shared database, checked whole when the test ends. The
    // methods below are this module's own conveniences on it.
    use crate::db::test_db::TestDb;

    impl TestDb {
        /// Write `text` to a file in this test's own directory and return the
        /// path `import_file` should be given.
        fn file(&self, name: &str, text: &str) -> String {
            let p = self.dir.join(name);
            std::fs::write(&p, text).expect("write import file");
            p.to_string_lossy().to_string()
        }

        fn account(&self, name: &str, opening: i64) -> String {
            self.account_of(name, "checking", opening)
        }

        fn account_of(&self, name: &str, kind: &str, opening: i64) -> String {
            let conn = self.pool.get().expect("conn");
            create_account(&conn, name, kind, opening, Some("2026-01-01"))
                .expect("create_account")
                .id
        }

        fn balance(&self, id: &str) -> i64 {
            let conn = self.pool.get().expect("conn");
            get_account(&conn, id).expect("account").balance_cents
        }
    }

    const QIF: &str = "\
!Type:Bank
^
2026-08-01   -42.50   Kroger^Food:Groceries
2026-08-03   -20.00   Shell^Auto:Gas
2026-08-15   1500.00  Paycheck
";

    /// §89. The failure this section exists for: the user writes rows into
    /// the register as they spend, then imports the bank's file. The bank
    /// posts a day late and writes its own description, so the exact key
    /// (date + amount + payee) misses and every row arrives a second time.
    #[test]
    fn near_misses_are_offered_for_review_and_matching_one_clears_it_instead_of_importing_it() {
        use crate::db::queries::create_transaction;
        let db = TestDb::new("match-review");
        let acct = db.account("Checking", 100_000);

        // What the user typed during the month.
        let (typed_safeway, typed_check, typed_netflix) = {
            let conn = db.pool.get().expect("conn");
            (
                create_transaction(&conn, &acct, "2026-08-02", "Safeway", None, -4_250, None, None).expect("safeway").id,
                create_transaction(&conn, &acct, "2026-08-04", "Anytown Plumbing", None, -68_000, None, Some("1043")).expect("check").id,
                create_transaction(&conn, &acct, "2026-08-09", "Netflix", None, -1_599, None, None).expect("netflix").id,
            )
        };
        let after_typing = db.balance(&acct);

        // What the bank sends: the same three, one day late, described the
        // bank's way — plus one row that really is new.
        let path = db.file(
            "bank.qif",
            "\
!Type:Bank
D08/03/2026
T-42.50
PSAFEWAY #1234 ANYTOWN US
^
D08/07/2026
T-680.00
N1043
PCHECK 1043
^
D08/10/2026
T-15.99
PNETFLIX.COM
^
D08/12/2026
T-31.10
PGAS STATION 0001
^
",
        );

        let preview = preview_import(&db.pool, &path, &acct, None, 3).expect("preview");
        assert_eq!(preview.total_rows, 4);
        assert_eq!(preview.duplicates, 0, "none of these match the old exact key — that is the bug");
        assert_eq!(preview.new_rows, 1, "the gas station row has nothing to pair with");
        assert_eq!(preview.rows.len(), 3, "the other three should be offered: {:?}", preview.rows);

        // Each is paired with the right register row, and confidently enough
        // to be ticked without the user hunting for it.
        let paired: Vec<(usize, &str, bool)> = preview
            .rows
            .iter()
            .map(|r| (r.index, r.candidates[0].existing.id.as_str(), r.likely))
            .collect();
        assert_eq!(
            paired,
            vec![(0, typed_safeway.as_str(), true), (1, typed_check.as_str(), true), (2, typed_netflix.as_str(), true)],
            "why: {:?}",
            preview.rows.iter().map(|r| r.candidates[0].why.clone()).collect::<Vec<_>>()
        );

        // The user takes two of them, says the third really is separate.
        let decisions = vec![
            matching::RowDecision { index: 0, action: "match".into(), existing_id: Some(typed_safeway.clone()), category_id: None },
            matching::RowDecision { index: 1, action: "match".into(), existing_id: Some(typed_check.clone()), category_id: None },
            matching::RowDecision { index: 2, action: "new".into(), existing_id: None, category_id: None },
        ];
        let s = import_with_decisions(&db.pool, &path, &acct, None, decisions, Vec::new()).expect("import");

        assert_eq!(s.matched, 2);
        assert_eq!(s.imported, 2, "the Netflix row the user kept, and the gas station row");
        assert_eq!(s.user_skipped, 0);
        // A match writes no row, so it moves no money: only the two imported.
        assert_eq!(s.balance_delta_cents, -1_599 - 3_110);
        assert_eq!(db.balance(&acct), after_typing - 1_599 - 3_110);

        let conn = db.pool.get().expect("conn");
        let rows = get_register(&conn, &acct).expect("register");
        // Opening balance + three typed + two imported. Without §89 this
        // would be eight, and the user would be deleting three by hand.
        assert_eq!(rows.len(), 6, "{:?}", rows.iter().map(|r| (&r.date, &r.payee)).collect::<Vec<_>>());

        // The matched rows kept the user's names and gained the cleared mark.
        let safeway = rows.iter().find(|r| r.id == typed_safeway).expect("safeway row");
        assert_eq!(safeway.payee, "Safeway", "the user's name must survive a match");
        assert_eq!(safeway.cleared_state, "C");
        assert_eq!(safeway.date, "2026-08-02", "the user's date stands too");
        let check = rows.iter().find(|r| r.id == typed_check).expect("check row");
        assert_eq!(check.check_number.as_deref(), Some("1043"), "the check number was already right");
        assert_eq!(check.cleared_state, "C");
    }

    #[test]
    fn a_matched_row_is_refused_when_the_amounts_do_not_agree_and_nothing_is_written() {
        use crate::db::queries::create_transaction;
        let db = TestDb::new("match-guard");
        let acct = db.account("Checking", 100_000);
        let other = {
            let conn = db.pool.get().expect("conn");
            create_transaction(&conn, &acct, "2026-08-02", "Safeway", None, -9_900, None, None).expect("row").id
        };
        let before = db.balance(&acct);
        let path = db.file("bank.qif", "!Type:Bank\n^\n2026-08-03   -42.50   SAFEWAY #1234^\n");

        // Nothing in the UI offers this pairing — the query gates on the
        // amount — but a decision arriving with the wrong id must not be
        // taken on trust.
        let err = import_with_decisions(
            &db.pool,
            &path,
            &acct,
            None,
            vec![matching::RowDecision { index: 0, action: "match".into(), existing_id: Some(other), category_id: None }],
            Vec::new(),
        )
        .expect_err("a mismatched amount should be refused");
        assert!(err.contains("amounts differ"), "{err}");
        assert_eq!(db.balance(&acct), before, "the whole import must roll back");

        let conn = db.pool.get().expect("conn");
        assert_eq!(get_register(&conn, &acct).expect("register").len(), 2, "opening balance and the one typed row");
    }

    #[test]
    fn a_row_the_user_skips_is_not_written_and_a_reconciled_row_keeps_its_mark() {
        use crate::db::queries::{create_transaction, set_cleared};
        let db = TestDb::new("match-skip");
        let acct = db.account("Checking", 100_000);
        let reconciled = {
            let conn = db.pool.get().expect("conn");
            let t = create_transaction(&conn, &acct, "2026-08-02", "Safeway", None, -4_250, None, None).expect("row");
            set_cleared(&conn, &t.id, "R").expect("reconcile");
            t.id
        };
        let before = db.balance(&acct);
        let path = db.file(
            "bank.qif",
            "!Type:Bank\n^\n2026-08-03   -42.50   SAFEWAY #1234^\n2026-08-04   -12.00   PANERA 601^\n",
        );

        let s = import_with_decisions(
            &db.pool,
            &path,
            &acct,
            None,
            vec![
                matching::RowDecision { index: 0, action: "match".into(), existing_id: Some(reconciled.clone()), category_id: None },
                matching::RowDecision { index: 1, action: "skip".into(), existing_id: None, category_id: None },
            ],
            Vec::new(),
        )
        .expect("import");

        assert_eq!((s.matched, s.imported, s.user_skipped), (1, 0, 1));
        assert_eq!(s.balance_delta_cents, 0);
        assert_eq!(db.balance(&acct), before);

        let conn = db.pool.get().expect("conn");
        let rows = get_register(&conn, &acct).expect("register");
        assert_eq!(rows.len(), 2, "the skipped row must not be written");
        let row = rows.iter().find(|r| r.id == reconciled).expect("row");
        assert_eq!(row.cleared_state, "R", "a reconciled row is not demoted to cleared");
    }

    /// A statement re-imported after the user matched its rows must be quiet:
    /// the bank's id was written onto the row they matched, so the ordinary
    /// dedupe answers it without asking again.
    #[test]
    fn matching_an_ofx_row_labels_it_so_the_next_import_is_a_plain_duplicate() {
        use crate::db::queries::create_transaction;
        let db = TestDb::new("match-fitid");
        let acct = db.account("Checking", 100_000);
        let typed = {
            let conn = db.pool.get().expect("conn");
            create_transaction(&conn, &acct, "2026-08-02", "Safeway", None, -4_250, None, None).expect("row").id
        };
        let path = db.file(
            "bank.ofx",
            "OFXHEADER:100\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>\
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260803<TRNAMT>-42.50<FITID>20260803-42<NAME>SAFEWAY #1234 ANYTOWN US</STMTTRN>\
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>",
        );

        let preview = preview_import(&db.pool, &path, &acct, None, 3).expect("preview");
        assert_eq!(preview.rows.len(), 1, "the OFX row should be offered against the typed one");
        let first = import_with_decisions(
            &db.pool,
            &path,
            &acct,
            None,
            vec![matching::RowDecision { index: 0, action: "match".into(), existing_id: Some(typed.clone()), category_id: None }],
            Vec::new(),
        )
        .expect("import");
        assert_eq!(first.matched, 1);

        // Same file again: answered by the id, with nothing to review.
        let again = preview_import(&db.pool, &path, &acct, None, 3).expect("second preview");
        assert_eq!((again.duplicates, again.rows.len()), (1, 0));
        let second = import_with_decisions(&db.pool, &path, &acct, None, Vec::new(), Vec::new()).expect("second import");
        assert_eq!((second.imported, second.duplicates, second.matched), (0, 1, 0));
    }

    /// §90. A 401(k) export as plan administrators actually write them: only
    /// the share side, with the meaning in the memo. Shaped like a typical
    /// plan administrator's QIF export, with a second fund because most plans
    /// hold several.
    const PLAN_QIF: &str = "\
!Type:Invst
D01/15/2026
NBuy
YTARGET DATE FUND (0000)
I10.00000
Q10.000
T100.00
MEMPLOYEE DEFERRAL
^
D01/15/2026
NBuy
YVANGUARD TOTAL BOND
I20.00000
Q2.500
T50.00
MEMPLOYEE DEFERRAL
^
D03/31/2026
NShrsOut
YTARGET DATE FUND (0000)
I12.00000
Q1.000
T12.00
MFees
^
D04/15/2026
NBuy
YTARGET DATE FUND (0000)
I12.00000
Q0.500
T6.00
MDividends
^
D05/01/2026
NSell
YVANGUARD TOTAL BOND
I20.00000
Q1.000
T20.00
MWithdrawals
^
";

    #[test]
    fn a_plan_statement_imported_literally_leaves_the_cash_deeply_negative() {
        // The bug the user hit, kept as a test so the fix cannot quietly be
        // undone: with no rules the file spends money it never provides.
        let db = TestDb::new("plan-asis");
        let acct = db.account_of("401(k)", "retirement", 0);
        let path = db.file("plan.qif", PLAN_QIF);

        let s = import_file(&db.pool, &path, &acct).expect("import");

        assert_eq!(s.investments, 5);
        assert_eq!(db.balance(&acct), -13_600, "buys spend cash the file never brings in");
    }

    #[test]
    fn the_memos_say_what_a_plan_statement_means_and_the_cash_comes_out_at_zero() {
        use crate::db::lots::portfolio;
        let db = TestDb::new("plan-rules");
        let acct = db.account_of("401(k)", "retirement", 0);
        let path = db.file("plan.qif", PLAN_QIF);

        // What the dialog would show.
        let preview = preview_import(&db.pool, &path, &acct, None, 3).expect("preview");
        let seen: Vec<(String, String, u32, plan::Treatment)> = preview
            .memo_groups
            .iter()
            .map(|g| (g.memo.clone(), g.activity.clone(), g.count, g.guess))
            .collect();
        assert_eq!(
            seen,
            vec![
                ("EMPLOYEE DEFERRAL".to_string(), "buy".to_string(), 2, plan::Treatment::Contribution),
                ("Fees".to_string(), "remove_shares".to_string(), 1, plan::Treatment::Fee),
                ("Dividends".to_string(), "buy".to_string(), 1, plan::Treatment::Reinvest),
                ("Withdrawals".to_string(), "sell".to_string(), 1, plan::Treatment::Withdrawal),
            ]
        );
        // The rows themselves are not offered for matching — they have their
        // own dedupe and their own shape.
        assert!(preview.rows.is_empty());

        let rules: Vec<plan::MemoRule> = preview
            .memo_groups
            .iter()
            .map(|g| plan::MemoRule { memo: g.memo.clone(), activity: g.activity.clone(), treatment: g.guess, category: None })
            .collect();
        let s = import_with_decisions(&db.pool, &path, &acct, None, Vec::new(), rules).expect("import");

        // Five share rows, and the cash rows the plan never wrote.
        assert_eq!(s.investments, 5);
        assert_eq!(s.imported, 0, "the paired rows are counted in the notes, not as imported file rows");
        assert_eq!(db.balance(&acct), 0, "every share row's cash is accounted for: {:?}", s.notes);
        assert!(s.notes.iter().any(|n| n.contains("2 contributions totaling $150.00")), "{:?}", s.notes);
        assert!(s.notes.iter().any(|n| n.contains("1 fee totaling $12.00")), "{:?}", s.notes);
        assert!(s.notes.iter().any(|n| n.contains("1 withdrawal totaling $20.00")), "{:?}", s.notes);

        let conn = db.pool.get().expect("conn");

        // Shares: the fee sold one, the dividend bought half of one.
        let p = portfolio(&conn, Some(&acct), "2026-09-07").expect("portfolio");
        let mut held: Vec<(String, i64)> = p.positions.iter().map(|x| (x.security_name.clone(), x.shares_micro)).collect();
        held.sort();
        assert_eq!(
            held,
            vec![("TARGET DATE FUND (0000)".to_string(), 9_500_000), ("VANGUARD TOTAL BOND".to_string(), 1_500_000)]
        );
        // Valued at the newest price each fund has — the fee share-out's
        // price counts now (§90), which is what it did not before.
        assert_eq!(p.positions.iter().map(|x| x.value_cents).sum::<i64>(), 9_500_000 / 1_000_000 * 1_200 + 500_000 * 1_200 / 1_000_000 + 3_000);

        // The fee is in the spending reports, where it was invisible before.
        let rows = get_register(&conn, &acct).expect("register");
        let fee_row = rows.iter().find(|r| r.category_name.as_deref() == Some("Investment Fees")).expect("fee row");
        assert_eq!(fee_row.amount_cents, -1_200);
        assert_eq!(fee_row.date, "2026-03-31");

        // The contributions are income, not an expense — the money was
        // earned and deferred, never seen.
        let contrib: Vec<i64> = rows
            .iter()
            .filter(|r| r.category_name.as_deref() == Some("Retirement Contributions"))
            .map(|r| r.amount_cents)
            .collect();
        assert_eq!(contrib, vec![10_000, 5_000]);
        let kind: String = conn
            .query_row("SELECT kind FROM categories WHERE name = 'Retirement Contributions'", [], |r| r.get(0))
            .expect("kind");
        assert_eq!(kind, "income");

        // The reinvested dividend booked income and moved no cash.
        let div = rows.iter().find(|r| r.activity.as_deref() == Some("reinvest_dividend")).expect("reinvestment");
        assert_eq!(div.amount_cents, 0);
        assert_eq!(div.category_name.as_deref(), Some("Dividend Income"));
    }

    #[test]
    fn an_investment_action_the_app_cannot_read_is_left_out_rather_than_banked() {
        // Some plan administrators write "Change in Market Value" with no
        // action. It used to arrive as an eight-cent deposit under the payee
        // "null".
        let db = TestDb::new("plan-unknown");
        let acct = db.account_of("401(k)", "retirement", 0);
        let path = db.file(
            "odd.qif",
            "!Type:Invst\nD3/16/2026\nNnull\nYTARGET DATE FUND (0000)\nI10.00000\nQ0.008\nT0.08\nMChange in Market Value\n^\n",
        );

        let s = import_file(&db.pool, &path, &acct).expect("import");

        assert_eq!((s.imported, s.investments), (0, 0));
        assert_eq!(s.skipped, 1);
        assert!(s.notes.iter().any(|n| n.contains("null on 2026-03-16 was left out")), "{:?}", s.notes);
        assert_eq!(db.balance(&acct), 0);
        let conn = db.pool.get().expect("conn");
        assert!(get_register(&conn, &acct).expect("register").iter().all(|r| r.payee != "null"));
    }

    /// §92. A plan's own statements carry no unit price, so a file built from
    /// them has to bring the prices with it. Quicken's `!Type:Prices` block is
    /// how QIF says so, and the importer used to skip it.
    #[test]
    fn a_price_block_prices_the_holdings_and_names_what_it_could_not_match() {
        use crate::db::lots::portfolio;
        let db = TestDb::new("qif-prices");
        let acct = db.account_of("401(k)", "retirement", 0);
        let path = db.file(
            "plan.qif",
            r#"!Type:Invst
D01/15/2026
NShrsIn
YSlow And Steady Fd
I100.000000
Q10.000000
T1000.00
MOpening balance
^
!Type:Prices
"Slow And Steady Fd",110.500000,"03/31/2026"
^
"A Fund Nobody Holds",4.000000,"03/31/2026"
^
"#,
        );

        let s = import_file(&db.pool, &path, &acct).expect("import");
        assert_eq!(s.investments, 1);
        // One matched, one did not — the count is of prices actually filed.
        assert!(s.notes.iter().any(|n| n == "1 price read from the file."), "{:?}", s.notes);
        assert!(
            s.notes.iter().any(|n| n.contains("A Fund Nobody Holds") && n.contains("no security of that name")),
            "a price for something the file never held is named, not dropped: {:?}",
            s.notes
        );

        let conn = db.pool.get().expect("conn");
        // The transaction's own price (100.00) held on its date; the price
        // block moved it on for the quarter end.
        let at_buy = portfolio(&conn, Some(&acct), "2026-01-15").expect("portfolio");
        assert_eq!(at_buy.positions[0].value_cents, 100_000);
        let later = portfolio(&conn, Some(&acct), "2026-03-31").expect("portfolio");
        assert_eq!(later.positions[0].value_cents, 110_500, "the price block should be what values it");
    }

    #[test]
    fn a_qif_import_moves_the_balance_by_the_net_of_its_rows() {
        let db = TestDb::new("qif-basic");
        let acct = db.account("Checking", 100_000);
        let path = db.file("statement.qif", QIF);

        let s = import_file(&db.pool, &path, &acct).expect("import");

        assert_eq!(s.imported, 3);
        assert_eq!(s.duplicates, 0);
        assert_eq!(s.skipped, 0);
        assert_eq!(s.balance_delta_cents, -4_250 - 2_000 + 150_000);
        assert_eq!(db.balance(&acct), 100_000 + s.balance_delta_cents);
        assert_eq!(s.account_name, "Checking");
    }

    #[test]
    fn importing_the_same_statement_twice_changes_nothing_the_second_time() {
        // The whole point of the dedup guard: a user who clicks Import twice,
        // or whose bank re-sends a month, must not double their balance.
        let db = TestDb::new("qif-dedup");
        let acct = db.account("Checking", 100_000);
        let path = db.file("statement.qif", QIF);

        let first = import_file(&db.pool, &path, &acct).expect("first import");
        let after_first = db.balance(&acct);

        let second = import_file(&db.pool, &path, &acct).expect("second import");

        assert_eq!(second.imported, 0, "rows were inserted twice");
        assert_eq!(second.duplicates, first.imported, "every row should be a duplicate");
        assert_eq!(second.balance_delta_cents, 0);
        assert_eq!(db.balance(&acct), after_first, "the balance moved on a re-import");

        let conn = db.pool.get().expect("conn");
        // Three imported rows, plus the account's own Opening Balance row.
        assert_eq!(get_register(&conn, &acct).expect("register").len(), 4);
    }

    #[test]
    fn dedup_is_scoped_to_the_account() {
        // Same date, amount and payee in a different account is a different
        // transaction — two people shopping at the same store on the same day.
        let db = TestDb::new("qif-scope");
        let a = db.account("Checking", 100_000);
        let b = db.account("Savings", 100_000);
        let path = db.file("statement.qif", QIF);

        import_file(&db.pool, &path, &a).expect("import a");
        let s = import_file(&db.pool, &path, &b).expect("import b");

        assert_eq!(s.duplicates, 0, "another account's rows were treated as duplicates");
        assert_eq!(s.imported, 3);
    }

    /// Byte-for-byte what `samples/sample-standard.qif` holds, so the file the
    /// user is told to try is the file this test covers (§37.5).
    const STANDARD_QIF: &str = "\
!Type:Bank
D08/03/2026
T-58.42
PKroger
LFood:Groceries
MWeekly shop
^
D08/04/2026
T-41.10
PShell
LAutomobile:Gasoline
^
D08/07/2026
T2140.88
PAcme Corp Payroll
LIncome:Salary
^
D08/10/2026
T-1450.00
POakridge Property Mgmt
LBills:Rent
^
";

    #[test]
    fn a_real_bank_qif_file_imports_end_to_end() {
        // Before §37.5 this file imported *successfully* with zero rows: the
        // field-code lines were skipped, and an empty import looks like a
        // working one.
        let db = TestDb::new("qif-real");
        let acct = db.account("Checking", 100_000);

        let s = import_file(&db.pool, &db.file("bank.qif", STANDARD_QIF), &acct).expect("import");

        assert_eq!(s.imported, 4, "real QIF imported {} rows", s.imported);
        assert_eq!(s.duplicates, 0);

        // -58.42 -41.10 +2140.88 -1450.00 = +591.36 on a $1,000 opening balance.
        let conn = crate::db::pool::get(&db.pool).expect("conn");
        let balance: i64 = conn
            .query_row("SELECT balance_cents FROM accounts WHERE id = ?1", [&acct], |r| r.get(0))
            .expect("balance");
        assert_eq!(balance, 100_000 + 59_136);
    }

    #[test]
    fn importing_the_same_bank_file_twice_adds_nothing() {
        let db = TestDb::new("qif-real-dupe");
        let acct = db.account("Checking", 100_000);
        import_file(&db.pool, &db.file("bank.qif", STANDARD_QIF), &acct).expect("first");

        let s = import_file(&db.pool, &db.file("bank2.qif", STANDARD_QIF), &acct).expect("second");

        assert_eq!(s.imported, 0);
        assert_eq!(s.duplicates, 4);
    }

    /// §159 — a row the file did not categorize and no rule caught is
    /// listed by the preview, and a category chosen for it in the review is
    /// what the row is written with. A row a rule DID catch, or the file
    /// categorized, is not listed and is not overridden.
    #[test]
    fn a_row_with_no_category_is_offered_one_and_written_with_it() {
        use crate::db::queries::{create_category, create_payee_rule, get_register};
        let db = TestDb::new("uncat");
        let acct = db.account("Checking", 0);
        let fuel = {
            let conn = db.pool.get().unwrap();
            let s = create_category(&conn, "Streaming", "expense", None, None).unwrap().id;
            let f = create_category(&conn, "Fuel", "expense", None, None).unwrap().id;
            create_payee_rule(&conn, "netflix", "Netflix", Some(&s), &Default::default()).unwrap();
            f
        };
        let path = db.file(
            "bank.qif",
            "\
!Type:Bank
D08/10/2026
T-15.99
PNETFLIX.COM
^
D08/11/2026
T-40.00
PFRESH MARKET
LFood
^
D08/12/2026
T-31.10
PGAS STATION 0001
^
",
        );

        let preview = preview_import(&db.pool, &path, &acct, None, 3).expect("preview");
        assert_eq!(preview.new_rows, 3, "nothing to match: all new");
        assert!(preview.rows.is_empty());
        let listed: Vec<(usize, &str)> = preview.uncategorized.iter().map(|r| (r.index, r.payee.as_str())).collect();
        assert_eq!(listed, vec![(2, "GAS STATION 0001")], "the rule caught Netflix and the file categorized the groceries");

        let summary = import_with_decisions(
            &db.pool,
            &path,
            &acct,
            None,
            vec![matching::RowDecision { index: 2, action: "new".into(), existing_id: None, category_id: Some(fuel.clone()) }],
            vec![],
        )
        .expect("import");
        assert_eq!(summary.imported, 3);

        let conn = db.pool.get().unwrap();
        let reg = get_register(&conn, &acct).unwrap();
        assert_eq!(cat_of_raw(&reg, "GAS STATION 0001"), Some("Fuel".to_string()), "the review's choice");
        assert_eq!(cat_of_raw(&reg, "Netflix"), Some("Streaming".to_string()), "the rule's category, untouched");
        assert_eq!(cat_of_raw(&reg, "FRESH MARKET"), Some("Food".to_string()), "the file's category, untouched");

        // A category that is not there is refused before anything is written.
        let err = import_with_decisions(
            &db.pool,
            &path,
            &acct,
            None,
            vec![matching::RowDecision { index: 2, action: "new".into(), existing_id: None, category_id: Some("nope".into()) }],
            vec![],
        )
        .unwrap_err();
        assert!(err.contains("no longer exists"), "{err}");
    }

    /// The register keeps the payee as written unless a rule renamed it.
    fn cat_of_raw(reg: &[crate::models::RegisterRow], payee: &str) -> Option<String> {
        reg.iter().find(|r| r.payee == payee).and_then(|r| r.category_name.clone())
    }

    /// §106 — the preview, and applying only what was left ticked.
    ///
    /// The apply has always rewritten existing rows; what it did not do was
    /// say WHICH rows first. "412 rows changed" after the fact is not
    /// information, it is a thing that has happened to you.
    #[test]
    fn the_preview_says_what_would_change_and_the_apply_takes_only_what_was_ticked() {
        use crate::db::queries::{
            create_category, create_payee_rule, get_register, preview_payee_rules,
        };
        let db = TestDb::new("preview-rules");
        let acct = db.account("Checking", 100_000);
        let raw = "!Type:Bank\n^\n2026-08-02   -15.49   NETFLIX.COM 866-579-7172 CA\n2026-08-05   -61.20   AMAZON.COM*2K3 AMZN.COM/BILL\n";
        import_file(&db.pool, &db.file("a.qif", raw), &acct).expect("import");
        let conn = db.pool.get().unwrap();
        let ent = create_category(&conn, "Streaming", "expense", None, None).unwrap();
        create_payee_rule(&conn, "netflix", "Netflix", Some(&ent.id), &Default::default()).unwrap();
        create_payee_rule(&conn, "amazon", "Amazon", None, &Default::default()).unwrap();

        // The preview changes nothing and carries BOTH halves of each change,
        // because a preview that shows only the destination asks the user to
        // remember what they are agreeing to lose.
        let plan = preview_payee_rules(&conn).unwrap();
        assert_eq!(plan.len(), 2, "{plan:?}");
        let netflix = plan.iter().find(|c| c.new_payee == "Netflix").expect("netflix row");
        assert!(netflix.payee.contains("NETFLIX.COM"), "the name it has now: {}", netflix.payee);
        assert_eq!(netflix.category_name, None);
        assert_eq!(netflix.new_category_name.as_deref(), Some("Streaming"));
        assert_eq!(netflix.match_text, "netflix", "traceable to the rule that claimed it");
        let before = get_register(&conn, &acct).unwrap();
        assert!(
            before.iter().any(|r| r.payee.contains("NETFLIX.COM")),
            "the preview must not have touched anything"
        );

        // Apply ONE of them.
        assert_eq!(
            apply_payee_rules_only(&conn, &[netflix.transaction_id.clone()]).unwrap(),
            1
        );
        let reg = get_register(&conn, &acct).unwrap();
        assert!(reg.iter().any(|r| r.payee == "Netflix"), "the ticked row changed");
        assert!(
            reg.iter().any(|r| r.payee.contains("AMAZON.COM")),
            "the unticked row did NOT"
        );

        // And the preview now offers only what is left.
        let rest = preview_payee_rules(&conn).unwrap();
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0].new_payee, "Amazon");
    }

    /// A rule fills an EMPTY category and never overwrites one you chose —
    /// a rule that re-files something you categorized by hand is a rule you
    /// could not trust to run.
    #[test]
    fn a_rule_never_overwrites_a_category_you_chose() {
        use crate::db::queries::{
            create_category, create_payee_rule, get_register, preview_payee_rules, update_transaction,
        };
        let db = TestDb::new("rules-category");
        let acct = db.account("Checking", 100_000);
        let raw = "!Type:Bank\n^\n2026-08-02   -15.49   NETFLIX.COM 866-579-7172 CA\n";
        import_file(&db.pool, &db.file("a.qif", raw), &acct).expect("import");
        let conn = db.pool.get().unwrap();
        let streaming = create_category(&conn, "Streaming", "expense", None, None).unwrap();
        // "Entertainment" is one of the 98 standard categories a new file is
        // seeded with, so take the one that is there.
        let fun = crate::db::queries::ensure_category(&conn, "Entertainment").unwrap();
        create_payee_rule(&conn, "netflix", "Netflix", Some(&streaming.id), &Default::default()).unwrap();

        // File it by hand first.
        let row = get_register(&conn, &acct).unwrap().into_iter().find(|r| r.payee.contains("NETFLIX")).unwrap();
        update_transaction(&conn, &row.id, &row.date, &row.payee, Some(&fun), row.amount_cents, None, None).unwrap();

        let plan = preview_payee_rules(&conn).unwrap();
        assert_eq!(plan.len(), 1, "still worth renaming");
        assert_eq!(plan[0].category_name.as_deref(), Some("Entertainment"));
        assert_eq!(
            plan[0].new_category_name.as_deref(),
            Some("Entertainment"),
            "the category it would end up with is the one already there"
        );
        assert_eq!(plan[0].new_category_id, None, "nothing is being re-filed");

        apply_payee_rules_only(&conn, &[plan[0].transaction_id.clone()]).unwrap();
        let after = get_register(&conn, &acct).unwrap();
        let r = after.iter().find(|r| r.payee == "Netflix").expect("renamed");
        assert_eq!(r.category_name.as_deref(), Some("Entertainment"), "kept");
    }

    /// The command wraps this; the test calls the query directly so it needs
    /// no Tauri state.
    fn apply_payee_rules_only(
        conn: &crate::db::queries::Conn,
        ids: &[String],
    ) -> Result<usize, String> {
        crate::db::queries::apply_payee_rules_to(conn, Some(ids)).map(|v| v.len())
    }

    // §84: a rule renames on import, files a category when the file gave
    // none, and a re-import of a file imported BEFORE the rule existed is
    // still all duplicates. Then the rules tidy what was already there.
    #[test]
    fn payee_rules_rename_at_import_and_still_dedupe_rows_imported_before_the_rule() {
        use crate::db::queries::{apply_payee_rules, create_category, create_payee_rule, find_duplicates};
        let db = TestDb::new("rules");
        let acct = db.account("Checking", 100_000);
        let raw = "!Type:Bank\n^\n2026-08-02   -15.49   NETFLIX.COM 866-579-7172 CA\n2026-08-05   -61.20   AMAZON.COM*2K3 AMZN.COM/BILL\n";
        import_file(&db.pool, &db.file("a.qif", raw), &acct).expect("first");
        let conn = db.pool.get().unwrap();
        let ent = create_category(&conn, "Streaming", "expense", None, None).unwrap();
        create_payee_rule(&conn, "netflix", "Netflix", Some(&ent.id), &Default::default()).unwrap();
        create_payee_rule(&conn, "amazon", "Amazon", None, &Default::default()).unwrap();
        create_payee_rule(&conn, "AMAZON PRIME", "Amazon Prime", None, &Default::default()).unwrap();
        assert!(create_payee_rule(&conn, "Netflix", "Other", None, &Default::default()).is_err(), "one rule per match text, case-insensitively");

        // Same file again: every row is a duplicate, though the rule now renames them.
        let again = import_file(&db.pool, &db.file("a2.qif", raw), &acct).expect("re-import");
        assert_eq!((again.imported, again.duplicates), (0, 2));

        // The rows already in the file are tidied on request.
        assert_eq!(apply_payee_rules(&conn).unwrap(), 2);
        assert_eq!(apply_payee_rules(&conn).unwrap(), 0, "idempotent");
        let reg = get_register(&conn, &acct).unwrap();
        let net = reg.iter().find(|r| r.payee == "Netflix").expect("renamed");
        assert_eq!(net.category_name.as_deref(), Some("Streaming"));
        assert!(reg.iter().any(|r| r.payee == "Amazon"));
        let payees = list_payees(&conn).unwrap();
        assert_eq!(payees.iter().find(|p| p.name == "Netflix").unwrap().usage_count, 1);

        // New rows: renamed as they land; the longest match wins; a file
        // category beats the rule's.
        let more = "!Type:Bank\n^\n2026-09-02   -15.49   NETFLIX.COM 866-579-7172 CA^Gifts\n2026-09-03   -14.99   AMAZON PRIME*PMTS\n";
        let s = import_file(&db.pool, &db.file("b.qif", more), &acct).expect("second");
        assert_eq!(s.imported, 2);
        let reg = get_register(&conn, &acct).unwrap();
        let sept = reg.iter().find(|r| r.date == "2026-09-02").unwrap();
        assert_eq!((sept.payee.as_str(), sept.category_name.as_deref()), ("Netflix", Some("Gifts")));
        assert_eq!(reg.iter().find(|r| r.date == "2026-09-03").unwrap().payee, "Amazon Prime");

        // Duplicate finder: a second copy of the Netflix charge, two days
        // later, entered by hand.
        crate::db::queries::create_transaction(&conn, &acct, "2026-09-04", "netflix", None, -15_49, None, None).unwrap();
        assert!(find_duplicates(&conn, &acct, 0).unwrap().is_empty(), "same day only: nothing");
        let groups = find_duplicates(&conn, &acct, 3).unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!((groups[0].payee.as_str(), groups[0].amount_cents, groups[0].rows.len()), ("Netflix", -1_549, 2));
        assert_eq!(groups[0].rows[1].date, "2026-09-04");
    }

    // §88: a bank CSV with Withdrawal / Deposit columns, a quoted payee with
    // a comma, a check number, a card-style file with positive charges, a
    // row the mapping cannot read, and the same file twice.
    #[test]
    fn a_csv_imports_through_the_confirmed_mapping_and_reimports_as_duplicates() {
        let db = TestDb::new("csv");
        let acct = db.account("Checking", 100_000);
        let text = "Date,Check Number,Description,Withdrawal,Deposit,Balance\r\n\
            9/3/2026,1051,\"FRESH MARKET #123, ANYTOWN US\",$42.50,,957.50\r\n\
            09/04/2026,,Paycheck,,\"1,500.00\",2457.50\r\n\
            ,,Opening balance line,,,1000.00\r\n\
            9/5/2026,,Shell Oil,20.00,,2437.50\r\n";
        let path = db.file("bank.csv", text);
        let p = preview_csv(&path, None, None).unwrap();
        assert_eq!(p.headers[2], "Description");
        assert_eq!((p.total_rows, p.mapping.date, p.mapping.check_number, p.mapping.payee, p.mapping.debit, p.mapping.credit, p.mapping.amount), (4, Some(0), Some(1), Some(2), Some(3), Some(4), None));
        let s = import_csv(&db.pool, &path, &acct, &p.mapping).unwrap();
        assert_eq!((s.imported, s.skipped, s.duplicates), (3, 1, 0));
        assert!(s.notes.iter().any(|n| n.contains("line 4") && n.contains("no date")), "{:?}", s.notes);
        assert_eq!(s.balance_delta_cents, -4_250 + 150_000 - 2_000);
        assert_eq!(db.balance(&acct), 100_000 - 4_250 + 150_000 - 2_000);
        let conn = db.pool.get().unwrap();
        let reg = get_register(&conn, &acct).unwrap();
        let ks = reg.iter().find(|r| r.payee.starts_with("FRESH")).unwrap();
        assert_eq!((ks.check_number.as_deref(), ks.amount_cents, ks.date.as_str()), (Some("1051"), -4_250, "2026-09-03"));
        // Again: nothing new.
        let s2 = import_csv(&db.pool, &path, &acct, &p.mapping).unwrap();
        assert_eq!((s2.imported, s2.duplicates), (0, 3));

        // A card statement: one Amount column, charges positive → negate.
        let card = db.account_of("Visa", "credit", 0);
        let ctext = "Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n\
            2026-09-02,2026-09-03,NETFLIX.COM,Entertainment,Sale,15.49,\n\
            2026-09-06,2026-09-06,Payment Thank You,,Payment,-200.00,\n";
        let cpath = db.file("card.csv", ctext);
        let mut cp = preview_csv(&cpath, None, None).unwrap();
        assert_eq!((cp.mapping.date, cp.mapping.payee, cp.mapping.amount, cp.mapping.category), (Some(0), Some(2), Some(5), Some(3)));
        cp.mapping.negate = true;
        let cs = import_csv(&db.pool, &cpath, &card, &cp.mapping).unwrap();
        assert_eq!(cs.imported, 2);
        let reg = get_register(&conn, &card).unwrap();
        assert_eq!(reg.iter().find(|r| r.payee == "NETFLIX.COM").unwrap().amount_cents, -1_549);
        assert_eq!(reg.iter().find(|r| r.payee == "Payment Thank You").unwrap().amount_cents, 20_000);
        assert_eq!(reg.iter().find(|r| r.payee == "NETFLIX.COM").unwrap().category_name.as_deref(), Some("Entertainment"), "the file's category column is used");

        // A mapping without a date column is refused before anything is read.
        let mut bad = p.mapping.clone();
        bad.date = None;
        assert!(import_csv(&db.pool, &path, &acct, &bad).is_err());
    }

    #[test]
    fn a_row_that_differs_only_in_amount_is_not_a_duplicate() {
        let db = TestDb::new("qif-amount");
        let acct = db.account("Checking", 100_000);
        import_file(&db.pool, &db.file("a.qif", QIF), &acct).expect("first");

        // Same day, same payee, one cent apart.
        let changed = "!Type:Bank\n2026-08-01   -42.51   Kroger^Food:Groceries\n";
        let s = import_file(&db.pool, &db.file("b.qif", changed), &acct).expect("second");

        assert_eq!(s.imported, 1);
        assert_eq!(s.duplicates, 0);
    }

    #[test]
    fn an_import_creates_the_payees_and_files_them_under_the_imported_category() {
        // §16: import is the biggest of the five payee write paths. If it
        // leaves payee_id NULL the Payees manager is empty on a real file.
        let db = TestDb::new("qif-payees");
        let acct = db.account("Checking", 100_000);
        import_file(&db.pool, &db.file("s.qif", QIF), &acct).expect("import");

        let conn = db.pool.get().expect("conn");
        let payees = list_payees(&conn).expect("list_payees");
        let by_name = |n: &str| {
            payees
                .iter()
                .find(|p| p.name == n)
                .unwrap_or_else(|| panic!("payee {n} was not created"))
        };

        assert_eq!(payees.len(), 3);
        assert_eq!(by_name("Kroger").usage_count, 1, "payee_id was not written");
        assert_eq!(
            by_name("Kroger").last_category_name.as_deref(),
            Some("Food : Groceries"),
            "the imported category should become the payee's default"
        );
        // No category on that line, so no default to remember.
        assert_eq!(by_name("Paycheck").last_category_name, None);
    }

    #[test]
    fn re_importing_does_not_multiply_the_payees() {
        let db = TestDb::new("qif-payee-dedup");
        let acct = db.account("Checking", 100_000);
        let path = db.file("s.qif", QIF);
        import_file(&db.pool, &path, &acct).expect("first");
        import_file(&db.pool, &path, &acct).expect("second");

        let conn = db.pool.get().expect("conn");
        let payees = list_payees(&conn).expect("list_payees");
        assert_eq!(payees.len(), 3);
        for p in &payees {
            assert_eq!(p.usage_count, 1, "{} was pointed at twice", p.name);
        }
    }

    #[test]
    fn a_category_path_becomes_the_subcategory() {
        // `Food:Groceries` is Groceries under Food (§54). It used to be
        // flattened to `Food`, which threw away the half Money files by.
        let db = TestDb::new("qif-cat");
        let acct = db.account("Checking", 100_000);
        import_file(&db.pool, &db.file("s.qif", QIF), &acct).expect("import");

        let conn = db.pool.get().expect("conn");
        let rows = get_register(&conn, &acct).expect("register");
        let kroger = rows.iter().find(|r| r.payee == "Kroger").expect("kroger");
        assert_eq!(kroger.category_name.as_deref(), Some("Groceries"));
        let (parent, kind): (Option<String>, String) = conn
            .query_row("SELECT p.name, c.kind FROM categories c LEFT JOIN categories p ON p.id = c.parent_id WHERE c.id = ?1", [kroger.category_id.as_deref().unwrap()], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!((parent.as_deref(), kind.as_str()), (Some("Food"), "expense"));
        // Importing again finds the same pair rather than making a second one.
        let count = || -> i64 { conn.query_row("SELECT COUNT(*) FROM categories", [], |r| r.get(0)).unwrap() };
        let before = count();
        import_file(&db.pool, &db.file("s2.qif", QIF), &db.account("Other", 0)).expect("import");
        assert_eq!(count(), before);
    }

    #[test]
    fn an_ofx_file_is_detected_by_its_content_not_only_its_extension() {
        let db = TestDb::new("ofx-detect");
        let acct = db.account("Checking", 100_000);
        let ofx = "\
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNAMT>-42.50</TRNAMT><DTPOSTED>20260801</DTPOSTED><NAME>Kroger</NAME></STMTTRN>
<STMTTRN><TRNAMT>1500.00</TRNAMT><DTPOSTED>20260815</DTPOSTED><NAME>Paycheck</NAME></STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>
";
        // Deliberately NOT named .ofx — the `<OFX` prefix has to carry it.
        let s = import_file(&db.pool, &db.file("statement.txt", ofx), &acct).expect("import");

        assert_eq!(s.imported, 2, "the OFX content was parsed as QIF");
        assert_eq!(s.balance_delta_cents, -4_250 + 150_000);
    }

    #[test]
    fn importing_into_an_unknown_account_fails_before_touching_anything() {
        let db = TestDb::new("bad-account");
        let path = db.file("s.qif", QIF);
        assert!(import_file(&db.pool, &path, "no-such-account").is_err());

        let conn = db.pool.get().expect("conn");
        assert!(list_payees(&conn).expect("payees").is_empty());
    }

    #[test]
    fn a_missing_file_is_an_error_not_an_empty_import() {
        let db = TestDb::new("missing-file");
        let acct = db.account("Checking", 100_000);
        let err = import_file(&db.pool, "does-not-exist.qif", &acct).expect_err("should fail");
        assert!(err.contains("failed to read"), "unhelpful error: {err}");
        assert_eq!(db.balance(&acct), 100_000);
    }

    // -----------------------------------------------------------------------
    // §38
    // -----------------------------------------------------------------------

    #[test]
    fn two_identical_rows_in_one_file_are_two_transactions() {
        // Two $4.50 coffees at the same shop on the same morning. The boolean
        // duplicate check saw the first insert and dropped the second.
        let db = TestDb::new("same-row-twice");
        let acct = db.account("Checking", 0);
        let qif = "D08/03/2026\nT-4.50\nPCorner Cafe\n^\nD08/03/2026\nT-4.50\nPCorner Cafe\n^\n";
        let s = import_file(&db.pool, &db.file("coffee.qif", qif), &acct).expect("import");
        assert_eq!(s.imported, 2, "the second identical row was dropped");
        assert_eq!(s.duplicates, 0);
        assert_eq!(db.balance(&acct), -900);

        // And the SAME file again is fully a duplicate — still idempotent.
        let again = import_file(&db.pool, &db.file("coffee.qif", qif), &acct).expect("re-import");
        assert_eq!(again.imported, 0);
        assert_eq!(again.duplicates, 2);
        assert_eq!(db.balance(&acct), -900);
    }

    #[test]
    fn the_shipped_sgml_sample_imports_and_reimports_cleanly() {
        // This file imported ZERO rows before §38 — successfully.
        let db = TestDb::new("sample-ofx");
        let acct = db.account("Checking", 0);
        let text = include_str!("../../../samples/sample-statement.ofx");
        let path = db.file("sample-statement.ofx", text);
        let s = import_file(&db.pool, &path, &acct).expect("import");
        assert_eq!(s.imported, 8);
        assert_eq!(s.balance_delta_cents, 2 * 214_088 - 5_842 - 4_110 - 145_000 - 9_263 - 1_499 - 6_375);
        let again = import_file(&db.pool, &path, &acct).expect("re-import");
        assert_eq!(again.imported, 0, "FITID dedupe did not hold");
        assert_eq!(again.duplicates, 8);
    }

    #[test]
    fn ofx_dedupes_on_the_banks_own_id_not_on_the_text() {
        // Same FITID, different memo (banks do re-send with tidied names):
        // one transaction. Different FITID, identical text: two.
        let db = TestDb::new("fitid");
        let acct = db.account("Checking", 0);
        let first = "OFXHEADER:100\n<OFX><STMTTRN><DTPOSTED>20260803<TRNAMT>-5.00<FITID>A1<NAME>SHOP</STMTTRN></OFX>";
        let renamed = "OFXHEADER:100\n<OFX><STMTTRN><DTPOSTED>20260803<TRNAMT>-5.00<FITID>A1<NAME>SHOP INC</STMTTRN>\
<STMTTRN><DTPOSTED>20260803<TRNAMT>-5.00<FITID>A2<NAME>SHOP</STMTTRN></OFX>";
        import_file(&db.pool, &db.file("a.qfx", first), &acct).expect("first");
        let s = import_file(&db.pool, &db.file("b.qfx", renamed), &acct).expect("second");
        assert_eq!(s.duplicates, 1, "A1 should be recognized by id");
        assert_eq!(s.imported, 1, "A2 is a new transaction even though it reads the same");
        assert_eq!(db.balance(&acct), -1_000);
    }

    #[test]
    fn a_statement_imported_before_ids_were_stored_is_still_a_duplicate() {
        // Rows from before migration 0021 have no fitid. Re-importing the
        // same statement must recognize them by text and label them, not
        // double the balance.
        let db = TestDb::new("fitid-backfill");
        let acct = db.account("Checking", 0);
        let text = "<OFX><STMTTRN><DTPOSTED>20260803<TRNAMT>-5.00<FITID>A1<NAME>SHOP</STMTTRN>\
<STMTTRN><DTPOSTED>20260804<TRNAMT>-7.00<FITID>A2<NAME>SHOP</STMTTRN></OFX>";
        import_file(&db.pool, &db.file("a.ofx", text), &acct).expect("first");
        let conn = db.pool.get().expect("conn");
        conn.execute("UPDATE transactions SET fitid = NULL", []).expect("pretend pre-0021");
        drop(conn);

        let again = import_file(&db.pool, &db.file("a.ofx", text), &acct).expect("second");
        assert_eq!(again.imported, 0, "old unlabeled rows were imported again");
        assert_eq!(again.duplicates, 2);
        assert_eq!(db.balance(&acct), -1_200);
        let conn = db.pool.get().expect("conn");
        let labeled: i64 = conn
            .query_row("SELECT count(*) FROM transactions WHERE fitid IS NOT NULL", [], |r| r.get(0))
            .expect("count");
        assert_eq!(labeled, 2, "the matched rows should now carry their ids");
    }

    #[test]
    fn a_qfx_extension_is_ofx() {
        let db = TestDb::new("qfx-ext");
        let acct = db.account("Checking", 0);
        let text = "<OFX><STMTTRN><DTPOSTED>20260803<TRNAMT>-5.00<FITID>A1<NAME>SHOP</STMTTRN></OFX>";
        let s = import_file(&db.pool, &db.file("download.QFX", text), &acct).expect("import");
        assert_eq!(s.imported, 1);
    }

    #[test]
    fn a_qif_transfer_target_does_not_become_a_category() {
        let db = TestDb::new("bracket-cat");
        let acct = db.account("Checking", 0);
        let qif = "D08/03/2026\nT-500.00\nPTransfer\nL[Savings]\n^\n";
        let s = import_file(&db.pool, &db.file("x.qif", qif), &acct).expect("import");
        assert_eq!(s.imported, 1);
        let conn = db.pool.get().expect("conn");
        let n: i64 = conn
            .query_row("SELECT count(*) FROM categories WHERE name LIKE '%[%'", [], |r| r.get(0))
            .expect("count");
        assert_eq!(n, 0, "a category called [Savings] was invented");
        let row = get_register(&conn, &acct).expect("register").remove(0);
        assert!(row.category_id.is_none());
    }

    // §65 — QIF transfers link up across the two accounts' files.
    #[test]
    fn qif_transfers_link_whichever_file_comes_first_and_never_double() {
        let db = TestDb::new("qif-transfers");
        let chk = db.account("Checking", 100_000);
        let sav = db.account("Savings", 0);
        // Checking's file: a transfer to Savings, a transfer to an account
        // that does not exist yet, and an ordinary purchase.
        let chk_qif = "D08/03/2026\nT-500.00\nPTransfer Money\nL[Savings]\nC*\n^\nD08/05/2026\nT-100.00\nPTransfer Money\nL[Brokerage]\n^\nD08/06/2026\nT-20.00\nPKroger\nLGroceries\n^\n";
        let s1 = import_file(&db.pool, &db.file("chk.qif", chk_qif), &chk).expect("import");
        assert_eq!((s1.imported, s1.transfers_linked, s1.duplicates), (3, 1, 0));
        assert_eq!(s1.balance_delta_cents, -62_000);
        assert!(s1.notes.iter().any(|n| n.contains("Brokerage")), "{:?}", s1.notes);
        // The pair exists: Savings gained 500 without importing anything.
        assert_eq!(db.balance(&chk), 100_000 - 62_000);
        assert_eq!(db.balance(&sav), 50_000);
        let conn = db.pool.get().expect("conn");
        let sav_rows = get_register(&conn, &sav).expect("register");
        assert_eq!(sav_rows.len(), 1);
        assert_eq!(sav_rows[0].transfer_account_name.as_deref(), Some("Checking"));
        let chk_rows = get_register(&conn, &chk).expect("register");
        let linked = chk_rows.iter().find(|r| r.amount_cents == -50_000).unwrap();
        assert_eq!(linked.transfer_account_name.as_deref(), Some("Savings"));
        assert_eq!(linked.cleared_state, "C", "the file's cleared mark rides on this side");
        drop(conn);

        // Savings' file: the same transfer from its side, plus interest.
        let sav_qif = "D08/03/2026\nT500.00\nPTransfer Money\nL[Checking]\n^\nD08/31/2026\nT1.25\nPInterest\nLInterest Income\n^\n";
        let s2 = import_file(&db.pool, &db.file("sav.qif", sav_qif), &sav).expect("import");
        assert_eq!((s2.imported, s2.transfers_linked, s2.duplicates), (1, 0, 1), "the far side of a pair already written is a duplicate");
        assert_eq!(db.balance(&sav), 50_125);
        // Importing the same file again changes nothing.
        let s3 = import_file(&db.pool, &db.file("sav2.qif", sav_qif), &sav).expect("import");
        assert_eq!((s3.imported, s3.duplicates), (0, 2));

        // Now the missing account arrives: its file's [Checking] row finds the
        // plain row Checking's import left waiting, and links to it.
        let brk = db.account("Brokerage", 0);
        let brk_qif = "D08/05/2026\nT100.00\nPTransfer Money\nL[Checking]\n^\n";
        let s4 = import_file(&db.pool, &db.file("brk.qif", brk_qif), &brk).expect("import");
        assert_eq!((s4.imported, s4.transfers_linked, s4.duplicates), (1, 1, 0));
        assert_eq!(db.balance(&brk), 10_000);
        assert_eq!(db.balance(&chk), 100_000 - 62_000, "Checking already held its side");
        let conn = db.pool.get().expect("conn");
        let waiting = get_register(&conn, &chk).expect("register").into_iter().find(|r| r.amount_cents == -10_000).unwrap();
        assert_eq!(waiting.transfer_account_name.as_deref(), Some("Brokerage"));
        // Every row on both sides is linked: no plain transfer rows left anywhere.
        let unlinked: i64 = conn.query_row("SELECT count(*) FROM transactions WHERE payee = 'Transfer Money' AND transfer_id IS NULL", [], |r| r.get(0)).unwrap();
        assert_eq!(unlinked, 0);
    }

    // §65 — split lines come in under their own categories.
    #[test]
    fn qif_splits_are_written_as_split_lines() {
        let db = TestDb::new("qif-splits");
        let chk = db.account("Checking", 0);
        let qif = "!Type:Bank\nD08/06/2026\nT-90.00\nPWalmart\nL--Split--\nSFood:Groceries\nEfood\n$-60.00\nSAutomobile:Fuel\n$-30.00\n^\n";
        let s = import_file(&db.pool, &db.file("split.qif", qif), &chk).expect("import");
        assert_eq!(s.imported, 1);
        assert_eq!(db.balance(&chk), -9_000);
        let conn = db.pool.get().expect("conn");
        let row = get_register(&conn, &chk).expect("register").remove(0);
        assert!(row.category_id.is_none(), "a split parent carries no category of its own");
        let lines: Vec<(Option<String>, i64)> = conn
            .prepare("SELECT c.name, s.amount_cents FROM splits s LEFT JOIN categories c ON c.id = s.category_id WHERE s.transaction_id = ?1 ORDER BY s.sort_order")
            .unwrap()
            .query_map(params![row.id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(lines, vec![(Some("Groceries".to_string()), -6_000), (Some("Fuel".to_string()), -3_000)]);
        let made: i64 = conn.query_row("SELECT count(*) FROM categories WHERE name = '--Split--'", [], |r| r.get(0)).unwrap();
        assert_eq!(made, 0);
    }

    /// §122 — one bank row, split across accounts, imported.
    ///
    /// A HELOC payment: one $1,000.00 debit the bank shows as one line, of
    /// which $680.00 is interest (spending) and $320.00 is principal (a
    /// transfer that moves the loan). Before this the bracketed line was
    /// written as an uncategorized split and nothing else — the loan never
    /// moved, and the principal was counted as spending.
    #[test]
    fn a_bracketed_split_line_moves_the_other_account_and_is_not_spending() {
        let db = TestDb::new("qif-split-xfer");
        let chk = db.account("Checking", 500_000);
        let heloc = db.account_of("Ridgeline Servicing - Birch Lane House HELOC", "home_equity_line_of_credit", -8_500_000);
        let qif = concat!(
            "!Type:Bank\n",
            "D01/09/2026\nT-1000.00\nPRidgeline Servicing\nMRegular Payment\n",
            "SInterest Paid\nEInterest\n$-680.00\n",
            "S[Ridgeline Servicing - Birch Lane House HELOC]\nEPrincipal\n$-320.00\n^\n",
        );
        let s = import_file(&db.pool, &db.file("heloc.qif", qif), &chk).expect("import");
        assert_eq!(s.imported, 1, "one bank row, not two");

        // Both sides moved, and by the split line's amount.
        assert_eq!(db.balance(&chk), 500_000 - 100_000);
        assert_eq!(db.balance(&heloc), -8_500_000 + 32_000, "the principal reached the loan");

        let conn = db.pool.get().expect("conn");
        let row = get_register(&conn, &chk).expect("register").into_iter().find(|r| r.amount_cents == -100_000).expect("the payment");
        let lines: Vec<(Option<String>, Option<String>, i64, Option<String>)> = conn
            .prepare(
                "SELECT c.name, s.description, s.amount_cents, s.transfer_account_id
                   FROM splits s LEFT JOIN categories c ON c.id = s.category_id
                  WHERE s.transaction_id = ?1 ORDER BY s.sort_order",
            )
            .unwrap()
            .query_map(params![row.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(lines[0].0.as_deref(), Some("Interest Paid"));
        assert_eq!(lines[0].3, None, "the interest line is a category, not a transfer");
        assert_eq!(lines[1].0, None, "principal is not spending, so it carries no category");
        assert_eq!(lines[1].2, -32_000);
        assert_eq!(lines[1].3.as_deref(), Some(heloc.as_str()), "and it names the loan");

        // The far row is marked, so no report counts it — the whole reason
        // `is_split_transfer` exists (0034).
        let far: (i64, i64, Option<String>) = conn
            .query_row(
                "SELECT amount_cents, is_split_transfer, category_id FROM transactions WHERE account_id = ?1 AND is_split_transfer = 1",
                params![heloc],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(far, (32_000, 1, None));

        // Only the interest is spending. Not the principal, on either side.
        use crate::db::reports::run_report;
        use crate::models::ReportRequest;
        let rep = run_report(
            &conn,
            &ReportRequest {
                kind: "spending_by_category".into(),
                from: "2026-01-01".into(),
                to: "2026-12-31".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let amount = |label: &str| rep.rows.iter().find(|x| x.label == label).and_then(|x| x.cells.first()).and_then(|c| c.cents);
        assert_eq!(amount("Interest Paid"), Some(68_000));
        assert!(rep.rows.iter().all(|x| x.label != "Uncategorized"), "the principal leaked into spending");
    }

    /// A bracketed split line naming no account anyone has is still a line —
    /// it just is not a transfer, and the name is reported rather than lost.
    #[test]
    fn a_split_line_naming_an_unknown_account_is_noted_and_stays_a_plain_line() {
        let db = TestDb::new("qif-split-unknown");
        let chk = db.account("Checking", 500_000);
        let qif = concat!(
            "!Type:Bank\n",
            "D01/09/2026\nT-1000.00\nPRidgeline Servicing\nMPayment\n",
            "SInterest Paid\nEInterest\n$-680.00\n",
            "S[No Such Account]\nEPrincipal\n$-320.00\n^\n",
        );
        let s = import_file(&db.pool, &db.file("u.qif", qif), &chk).expect("import");
        assert_eq!(s.imported, 1);
        assert_eq!(db.balance(&chk), 400_000, "the bank row is still the bank row");
        assert!(s.notes.iter().any(|n| n.contains("No Such Account")), "{:?}", s.notes);
    }

    // §66 — Money's investment QIF: shares, income, a split, cash in and out.
    #[test]
    fn an_investment_qif_builds_lots_and_links_its_cash_transfers() {
        let db = TestDb::new("qif-invst");
        let chk = db.account("Checking", 500_000);
        let brk = db.account_of("Brokerage", "investment", 0);
        let qif = concat!(
            "!Type:Security\nNVanguard Total Stock\nSVTSAX\nTMutual Fund\n^\n",
            "!Type:Invst\n",
            "D01/10/2026\nNXIn\nT2000.00\nPTransfer Money\nL[Checking]\n^\n",
            "D01/12/2026\nNBuy\nYVanguard Total Stock\nI100.00\nQ10\nT1005.00\nO5.00\n^\n",
            "D03/15/2026\nNDiv\nYVanguard Total Stock\nT12.50\n^\n",
            "D06/15/2026\nNReinvDiv\nYVanguard Total Stock\nI125.00\nQ0.1\nT12.50\n^\n",
            "D07/01/2026\nNStkSplit\nYVanguard Total Stock\nQ20\n^\n",
            "D08/01/2026\nNSell\nYVanguard Total Stock\nI60.00\nQ4\nT235.00\nO5.00\n^\n",
            "D08/15/2026\nNShrsIn\nYVanguard Total Stock\nI55.00\nQ2\n^\n",
            "D08/20/2026\nNXOut\nT100.00\nPTransfer Money\nL[Checking]\n^\n",
            "D08/25/2026\nNMiscExp\nT7.50\nPAccount fee\nLBank Charges\n^\n",
        );
        let s = import_file(&db.pool, &db.file("brk.qif", qif), &brk).expect("import");
        assert_eq!(s.investments, 6, "{:?}", s.notes);
        assert_eq!(s.securities_created, 1);
        assert_eq!(s.transfers_linked, 2);
        assert_eq!(s.imported, 3, "two transfers and the fee are cash rows");
        // Cash: +2000 −1005 +12.50 −100 −7.50 +235 = 1135.00 (the reinvestment moves none).
        assert_eq!(db.balance(&brk), 113_500);
        assert_eq!(db.balance(&chk), 500_000 - 200_000 + 10_000);
        let conn = db.pool.get().expect("conn");
        let pf = crate::db::lots::portfolio(&conn, Some(&brk), "2026-09-01").expect("portfolio");
        assert!(pf.problems.is_empty(), "{:?}", pf.problems);
        let pos = &pf.positions[0];
        assert_eq!(pos.symbol, "VTSAX");
        // 10 + 0.1 = 10.1 shares, ×2 on the split = 20.2, −4 sold, +2 in = 18.2.
        assert_eq!(pos.shares_micro, 18_200_000);
        // Cost: the buy's basis is 1005 with its commission (50.25 a share
        // after the split); 4 sold FIFO take 201 → 804, + 12.50 reinvested
        // + 110 (2 shares in at 55) = 926.50.
        assert_eq!(pos.cost_cents, 92_650);
        drop(conn);
        // Checking's own file then finds both transfers already there.
        let chk_qif = "!Type:Bank\nD01/10/2026\nT-2000.00\nPTransfer Money\nL[Brokerage]\n^\nD08/20/2026\nT100.00\nPTransfer Money\nL[Brokerage]\n^\n";
        let s2 = import_file(&db.pool, &db.file("chk.qif", chk_qif), &chk).expect("import");
        assert_eq!((s2.imported, s2.duplicates), (0, 2));
        // The investment file a second time: nothing doubles.
        let s3 = import_file(&db.pool, &db.file("brk2.qif", qif), &brk).expect("import");
        assert_eq!((s3.imported, s3.investments, s3.duplicates), (0, 0, 9), "{:?}", s3.notes);
        assert_eq!(db.balance(&brk), 113_500);
        // An investment file into a checking account is refused whole.
        let err = import_file(&db.pool, &db.file("brk3.qif", qif), &chk).unwrap_err();
        assert!(err.contains("investment QIF"), "{err}");
    }

    #[test]
    fn a_windows_ansi_qif_with_an_accented_payee_still_imports() {
        // "Café Olé" as Money writes it: é is 0xE9 in Windows-1252, and a
        // curly apostrophe is 0x92. Neither is UTF-8.
        let mut bytes = b"!Type:Bank\nD08/03/2026\nT-4.50\nPCaf".to_vec();
        bytes.push(0xE9);
        bytes.extend_from_slice(b" Ol");
        bytes.push(0xE9);
        bytes.extend_from_slice(b"\nMSam");
        bytes.push(0x92);
        bytes.extend_from_slice(b"s coffee\n^\n");
        assert_eq!(decode_text(&bytes), "!Type:Bank\nD08/03/2026\nT-4.50\nPCafé Olé\nMSam’s coffee\n^\n");
        assert_eq!(decode_text(&[0xEF, 0xBB, 0xBF, b'D', b'1']), "D1");
        assert_eq!(decode_text(&[0xFF, 0xFE, b'D', 0, b'1', 0]), "D1");
        let db = TestDb::new("qif-ansi");
        let acct = db.account("Checking", 0);
        let dir = db.dir.clone();
        let path = dir.join("ansi.qif");
        std::fs::write(&path, &bytes).unwrap();
        let s = import_file(&db.pool, path.to_str().unwrap(), &acct).expect("import");
        assert_eq!(s.imported, 1);
        let conn = db.pool.get().expect("conn");
        let row = get_register(&conn, &acct).expect("register").remove(0);
        assert_eq!(row.payee, "Café Olé");
        assert_eq!(row.notes.as_deref(), Some("Sam’s coffee"));
    }

    #[test]
    fn an_unreadable_qif_record_is_counted_as_skipped_not_lost() {
        let db = TestDb::new("qif-unreadable");
        let acct = db.account("Checking", 0);
        let qif = "D08/03/2026\nT-1.00\nPOk\n^\nD3.8.2026\nT-2.00\nPBad date\n^\nD08/04/2026\nTabc\nPBad amount\n^\n";
        let s = import_file(&db.pool, &db.file("x.qif", qif), &acct).expect("import");
        assert_eq!(s.imported, 1);
        assert_eq!(s.skipped, 2, "unreadable records vanished from the count");
    }

    #[test]
    fn qif_check_numbers_and_cleared_flags_are_carried() {
        let db = TestDb::new("qif-num");
        let acct = db.account("Checking", 0);
        let qif = "D08/03/2026\nT-100.00\nN1042\nCX\nPLandlord\n^\nD08/04/2026\nT-5.00\nC*\nPShop\n^\n";
        import_file(&db.pool, &db.file("x.qif", qif), &acct).expect("import");
        let conn = db.pool.get().expect("conn");
        let rows = get_register(&conn, &acct).expect("register");
        assert_eq!(rows[0].check_number.as_deref(), Some("1042"));
        assert_eq!(rows[0].cleared_state, "R");
        assert!(rows[0].is_reconciled);
        assert_eq!(rows[1].cleared_state, "C");
    }

    #[test]
    fn a_date_with_multibyte_characters_is_refused_not_a_panic() {
        let db = TestDb::new("qif-utf8");
        let acct = db.account("Checking", 0);
        let qif = "D2026年08月03日\nT-1.00\nPX\n^\n";
        let s = import_file(&db.pool, &db.file("x.qif", qif), &acct).expect("must not panic");
        assert_eq!(s.imported, 0);
        assert_eq!(s.skipped, 1);
    }

    // ── investment statements (§44) ──────────────────────────────────────

    fn brokerage_ofx() -> String {
        std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../samples/sample-brokerage.ofx")).expect("sample")
    }

    #[test]
    fn a_brokerage_statement_becomes_lots_cash_and_prices() {
        let db = TestDb::new("ofx-inv");
        let acct = db.account_of("Brokerage", "investment", 0);
        let path = db.file("brokerage.ofx", &brokerage_ofx());

        let s = import_file(&db.pool, &path, &acct).expect("import");
        // The cash side: one INVBANKTRAN credit. The investment side: buy,
        // buy, dividend, reinvest, sell, split, transfer-in = 7; margin
        // interest is noted, not written.
        assert_eq!(s.imported, 1);
        assert_eq!(s.investments, 7);
        assert_eq!(s.securities_created, 3);
        assert!(s.notes.iter().any(|n| n.contains("MARGININTEREST")), "{:?}", s.notes);

        let conn = db.pool.get().expect("conn");
        // Cash: 2500 − 1897.45 − 499.53 + 2.50 + 815.05 (reinvest and
        // transfer move no cash).
        assert_eq!(db.balance(&acct), 250_000 - 189_745 - 49_953 + 250 + 81_505);

        let p = crate::db::lots::portfolio(&conn, Some(&acct), "2026-08-31").expect("portfolio");
        assert!(p.problems.is_empty(), "{:?}", p.problems);
        let by: std::collections::HashMap<&str, &crate::models::Position> = p.positions.iter().map(|x| (x.symbol.as_str(), x)).collect();
        // Apple: 10 bought, 4 sold, then 2-for-1 → 12; priced from the position list.
        let aapl = by["AAPL"];
        assert_eq!(aapl.shares_micro, 12_000_000);
        assert_eq!(aapl.price_micro, Some(101_100_000));
        // Basis of the 6 that stayed: 1,897.45 less the 758.98 the 4 sold took.
        assert_eq!(aapl.cost_cents, 189_745 - 75_898);
        // VTSAX: the buy plus the reinvested dividend's shares.
        let vtsax = by["VTSAX"];
        assert_eq!(vtsax.shares_micro, 4_218_300 + 25_100);
        assert_eq!(vtsax.cost_cents, 49_953 + 310);
        // MSFT came in by transfer at the price the broker gave: basis 3 × 410.
        let msft = by["MSFT"];
        assert_eq!((msft.shares_micro, msft.cost_cents), (3_000_000, 123_000));
        // The sale realized a gain: 4 of the $189.745 shares at $205 net of $4.95.
        let gains = crate::db::lots::realized(&conn, Some(&acct), "2026-01-01", "2026-12-31").expect("realized");
        assert_eq!(gains.len(), 1);
        assert_eq!(gains[0].proceeds_cents, 81_505);
        assert_eq!(gains[0].cost_cents, 75_898);
        assert!(!gains[0].long_term);
        // The securities carry their CUSIPs so a later file without tickers still matches.
        let sec = crate::db::queries::list_securities(&conn).expect("securities");
        assert!(sec.iter().any(|x| x.symbol == "AAPL" && x.notes.as_deref() == Some("CUSIP 037833100")));

        // Re-import: every row is a duplicate by FITID, nothing moves.
        let again = import_file(&db.pool, &path, &acct).expect("second import");
        assert_eq!((again.imported, again.investments, again.securities_created), (0, 0, 0));
        assert_eq!(again.duplicates, 8);
        assert_eq!(db.balance(&acct), 250_000 - 189_745 - 49_953 + 250 + 81_505);
    }

    #[test]
    fn an_investment_statement_into_a_checking_account_is_refused_whole() {
        let db = TestDb::new("ofx-inv-wrong");
        let acct = db.account("Checking", 0);
        let path = db.file("brokerage.ofx", &brokerage_ofx());
        let err = import_file(&db.pool, &path, &acct).expect_err("must refuse");
        assert!(err.contains("investment statement"), "{err}");
        // Nothing — not even the cash row — was written.
        assert_eq!(db.balance(&acct), 0);
    }

    #[test]
    fn the_parser_maps_every_aggregate_to_an_activity() {
        let f = ofx::parse_ofx_investments(&brokerage_ofx());
        let acts: Vec<&str> = f.transactions.iter().map(|t| t.activity.as_str()).collect();
        assert_eq!(acts, ["buy", "buy", "dividend", "reinvest_dividend", "sell", "split", "add_shares"]);
        let buy = &f.transactions[0];
        assert_eq!((buy.shares_micro, buy.price_micro, buy.gross_cents, buy.commission_cents), (10_000_000, Some(189_250_000), 189_250, 495));
        let sell = &f.transactions[4];
        assert_eq!((sell.shares_micro, sell.gross_cents, sell.commission_cents), (4_000_000, 82_000, 495));
        let split = &f.transactions[5];
        assert_eq!(split.shares_micro, 2_000_000);
        assert_eq!(f.prices.len(), 2);
        assert_eq!(f.securities.iter().map(|s| s.kind.as_str()).collect::<Vec<_>>(), ["stock", "stock", "mutual_fund"]);
    }

    #[test]
    fn a_qif_export_round_trips_through_the_reader() {
        use crate::db::queries::{create_category, create_transaction, create_transfer, set_cleared, set_splits};
        use crate::models::NewSplit;
        let db = TestDb::new("qif-export");
        let chk = db.account("Checking", 100_000);
        let sav = db.account("Savings", 0);
        let conn = db.pool.get().unwrap();
        let food = create_category(&conn, "Food", "expense", None, None).unwrap().id;
        let groc = create_category(&conn, "Groceries", "expense", Some(&food), None).unwrap().id;
        let gas = create_category(&conn, "Gas", "expense", None, None).unwrap().id;
        let t1 = create_transaction(&conn, &chk, "2026-08-03", "Kroger", Some(&groc), -4_250, Some("Weekly\nshop"), Some("1042")).unwrap();
        set_cleared(&conn, &t1.id, "R").unwrap();
        let t2 = create_transaction(&conn, &chk, "2026-08-04", "Costco", None, -9_000, None, None).unwrap();
        set_splits(&conn, &t2.id, &[NewSplit { classes: Vec::new(), category_id: Some(groc.clone()), description: Some("food".into()), amount_cents: -6_000, transfer_account_id: None }, NewSplit { classes: Vec::new(), category_id: Some(gas.clone()), description: None, amount_cents: -3_000, transfer_account_id: None }]).unwrap();
        create_transfer(&conn, &chk, &sav, "2026-08-05", 25_000, None).unwrap();
        let v = create_transaction(&conn, &chk, "2026-08-06", "Oops", Some(&gas), -100, None, None).unwrap();
        crate::db::queries::set_void(&conn, &v.id, true).unwrap();

        let q = qif_export::export_account(&conn, &chk).unwrap();
        assert_eq!((q.records, q.voided), (4, 1)); // opening balance + 3
        assert!(q.text.starts_with("!Type:Bank\n"));
        assert!(q.text.contains("D08/03/2026\nT-42.50\nCX\nN1042\nPKroger\nMWeekly shop\nLFood:Groceries\n^\n"), "{}", q.text);
        assert!(q.text.contains("PCostco\nSFood:Groceries\nEfood\n$-60.00\nSGas\n$-30.00\n^"), "{}", q.text);
        assert!(q.text.contains("T-250.00\n") && q.text.contains("L[Savings]\n"), "{}", q.text);
        assert!(!q.text.contains("Oops"));

        // Read it back into an empty account with the real importer.
        let again = db.account("Again", 0);
        let path = db.file("out.qif", &q.text);
        let s = import_file(&db.pool, &path, &again).unwrap();
        assert_eq!((s.imported, s.skipped), (4, 0));
        // Balance: 1,000 opening − 42.50 − 90 − 250 = 617.50, the same as the source.
        assert_eq!(db.balance(&again), 61_750);
        assert_eq!(db.balance(&chk), 61_750);
        let reg = get_register(&conn, &again).unwrap();
        let kroger = reg.iter().find(|r| r.payee == "Kroger").unwrap();
        assert_eq!((kroger.check_number.as_deref(), kroger.cleared_state.as_str(), kroger.category_name.as_deref()), (Some("1042"), "R", Some("Groceries")));
    }

    #[test]
    fn an_investment_account_exports_quicken_actions() {
        use crate::db::queries::{create_investment_transaction, create_security};
        use crate::models::NewInvestmentTransaction;
        let db = TestDb::new("qif-export-inv");
        let ira = db.account_of("IRA", "retirement", 0);
        let conn = db.pool.get().unwrap();
        let sec = create_security(&conn, "Total Market", "VTSAX", "mutual_fund", None).unwrap();
        let row = |activity: &str, shares: i64, gross: i64, commission: i64| NewInvestmentTransaction {
            account_id: ira.clone(), date: "2026-03-10".into(), activity: activity.into(), security_id: sec.id.clone(),
            shares_micro: shares, price_micro: None, gross_cents: gross, commission_cents: commission, category_id: None, notes: None, funding_account_id: None, lot_allocations: vec![],
        };
        create_investment_transaction(&conn, &row("buy", 12_500_000, 150_000, 495)).unwrap();
        create_investment_transaction(&conn, &row("reinvest_dividend", 500_000, 6_250, 0)).unwrap();
        create_investment_transaction(&conn, &row("split", 2_000_000, 0, 0)).unwrap();
        let q = qif_export::export_account(&conn, &ira).unwrap();
        assert!(q.text.starts_with("!Type:Invst\n"));
        assert!(q.text.contains("NBuy\nYTotal Market\nI120\nQ12.5\nT1500.00\nO4.95\n"), "{}", q.text);
        assert!(q.text.contains("NReinvDiv\nYTotal Market\nI125\nQ0.5\nT62.50\n"), "{}", q.text);
        assert!(q.text.contains("NStkSplit\nYTotal Market\nQ20\n"), "{}", q.text);
        assert_eq!(q.records, 3);
    }

    /// §180 — a cash row with a check number in an investment account. The
    /// number went out as a second `N`, the reader took it as the action,
    /// and the row was left out of the re-import as "1043 … not an action
    /// this reads".
    #[test]
    fn an_investment_cash_row_with_a_check_number_survives_the_round_trip() {
        use crate::db::queries::create_transaction;
        let db = TestDb::new("qif-export-inv-check");
        let brk = db.account_of("Brokerage", "investment", 0);
        let conn = db.pool.get().unwrap();
        create_transaction(&conn, &brk, "2026-08-03", "Deposit", None, 50_000, None, Some("1043")).unwrap();
        create_transaction(&conn, &brk, "2026-08-04", "Wire out", None, -12_500, None, Some("1044")).unwrap();

        let q = qif_export::export_account(&conn, &brk).unwrap();
        assert!(q.text.starts_with("!Type:Invst\n"), "{}", q.text);
        assert!(q.text.contains("D08/03/2026\nNXIn\nT500.00\nPDeposit\n^\n"), "{}", q.text);
        assert!(!q.text.contains("N1043") && !q.text.contains("N1044"), "{}", q.text);

        let again = db.account_of("Again", "investment", 0);
        let s = import_file(&db.pool, &db.file("inv.qif", &q.text), &again).unwrap();
        assert!(s.notes.iter().all(|n| !n.contains("not an action")), "{:?}", s.notes);
        assert_eq!(s.skipped, 0, "{:?}", s.notes);
        assert_eq!(db.balance(&again), db.balance(&brk));
        assert_eq!(db.balance(&again), 37_500);
    }
}
