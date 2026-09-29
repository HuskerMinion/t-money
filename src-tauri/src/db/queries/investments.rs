//! Securities, prices and investment transactions (migration 0022).

use crate::models::{LotAllocation, NewInvestmentTransaction, Security, SecurityPrice};
use crate::db::lots;
use rusqlite::{params, Connection, OptionalExtension, Row};
use uuid::Uuid;
use super::*;

// ---------------------------------------------------------------------------
// Securities, prices and investment transactions (migration 0022)
// ---------------------------------------------------------------------------

const SECURITY_SELECT: &str = "SELECT s.id, s.name, s.symbol, s.kind, s.notes, s.updated_at,
            p.price_micro, p.date, p.source
       FROM securities s
       LEFT JOIN security_prices p
         ON p.security_id = s.id
        AND p.date = (SELECT MAX(date) FROM security_prices WHERE security_id = s.id)";

fn map_security(row: &Row) -> rusqlite::Result<Security> {
    Ok(Security {
        id: row.get(0)?,
        name: row.get(1)?,
        symbol: row.get(2)?,
        kind: row.get(3)?,
        notes: row.get(4)?,
        updated_at: row.get(5)?,
        last_price_micro: row.get(6)?,
        price_date: row.get(7)?,
        price_source: row.get(8)?,
    })
}

pub fn list_securities(conn: &Conn) -> Result<Vec<Security>, String> {
    let mut stmt = conn
        .prepare(&format!("{SECURITY_SELECT} ORDER BY s.name COLLATE NOCASE"))
        .map_err(|e| e.to_string())?;
    let out = stmt
        .query_map([], map_security)
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(out)
}

pub fn get_security(conn: &Connection, id: &str) -> Result<Security, String> {
    conn.query_row(&format!("{SECURITY_SELECT} WHERE s.id = ?1"), params![id], map_security)
        .map_err(|e| format!("security {id} not found: {e}"))
}

const SECURITY_KINDS: &[&str] = &["stock", "mutual_fund", "etf", "bond", "cd", "money_market", "other"];

fn check_security(name: &str, kind: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("a security needs a name".to_string());
    }
    if !SECURITY_KINDS.contains(&kind) {
        return Err(format!("unknown security kind {kind:?}"));
    }
    Ok(())
}

/// Does a security's NAME read as a ticker? Money's QIF export writes no
/// `!Type:Security` records, so a file whose securities were named by their
/// symbols ("MUB", "VTSAX", "BRK.B") arrives with every symbol blank — and
/// the price fetch needs the symbol. One to six capitals or digits,
/// optionally one ".X"/"-X" class suffix, the first character a letter.
pub fn ticker_like(name: &str) -> bool {
    let n = name.trim();
    let (base, suffix) = match n.find(['.', '-']) {
        Some(i) => (&n[..i], &n[i + 1..]),
        None => (n, ""),
    };
    let ok = |s: &str| s.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit());
    !base.is_empty()
        && base.len() <= 6
        && base.chars().next().is_some_and(|c| c.is_ascii_uppercase())
        && ok(base)
        && (suffix.is_empty() || (suffix.len() <= 2 && ok(suffix)))
        && (n.contains('.') as u8 + n.contains('-') as u8) <= 1
}

/// Give every security with no symbol whose name reads as a ticker that name
/// as its symbol. Returns how many were set. Nothing with a symbol changes.
pub fn fill_symbols_from_names(conn: &Conn) -> Result<u32, String> {
    let mut stmt = conn
        .prepare("SELECT id, name FROM securities WHERE TRIM(symbol) = ''")
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    let mut n = 0u32;
    for (id, name) in rows {
        if ticker_like(&name) {
            conn.execute(
                "UPDATE securities SET symbol = ?1, updated_at = datetime('now') WHERE id = ?2",
                params![name.trim(), id],
            )
            .map_err(|e| e.to_string())?;
            n += 1;
        }
    }
    Ok(n)
}

pub fn create_security(
    conn: &Connection,
    name: &str,
    symbol: &str,
    kind: &str,
    notes: Option<&str>,
) -> Result<Security, String> {
    check_security(name, kind)?;
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO securities (id, name, symbol, kind, notes) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, name.trim(), symbol.trim().to_uppercase(), kind, notes],
    )
    .map_err(|e| {
        if e.to_string().contains("UNIQUE") {
            format!("there is already a security named {:?}", name.trim())
        } else {
            e.to_string()
        }
    })?;
    get_security(conn, &id)
}

pub fn update_security(
    conn: &Conn,
    id: &str,
    name: &str,
    symbol: &str,
    kind: &str,
    notes: Option<&str>,
) -> Result<Security, String> {
    check_security(name, kind)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let n = tx
        .execute(
            "UPDATE securities SET name = ?1, symbol = ?2, kind = ?3, notes = ?4,
                    updated_at = datetime('now') WHERE id = ?5",
            params![name.trim(), symbol.trim().to_uppercase(), kind, notes, id],
        )
        .map_err(|e| {
            if e.to_string().contains("UNIQUE") {
                format!("there is already a security named {:?}", name.trim())
            } else {
                e.to_string()
            }
        })?;
    if n == 0 {
        return Err(format!("security {id} not found"));
    }
    // The register shows the security's name as the payee; keep it current.
    tx.execute(
        "UPDATE transactions SET payee = ?1 WHERE security_id = ?2 AND activity IS NOT NULL",
        params![name.trim(), id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    get_security(conn, id)
}

/// A security with history cannot be deleted — the lots would vanish with it.
pub fn delete_security(conn: &Conn, id: &str) -> Result<(), String> {
    let used: i64 = conn
        .query_row("SELECT COUNT(*) FROM transactions WHERE security_id = ?1", params![id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if used > 0 {
        return Err(format!(
            "{used} transaction{} refer to this security; delete or re-point them first",
            if used == 1 { "" } else { "s" }
        ));
    }
    conn.execute("DELETE FROM securities WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Record a price. `manual` and `fetched` replace whatever the day had;
/// `transaction` (the price implied by a buy or sell) only fills a day that
/// has no price yet — a quote beats an inference.
pub fn set_security_price(
    conn: &Connection,
    security_id: &str,
    date: &str,
    price_micro: i64,
    source: &str,
) -> Result<(), String> {
    parse_date(date)?;
    if price_micro < 0 {
        return Err("a price cannot be negative".to_string());
    }
    if !matches!(source, "manual" | "fetched" | "transaction") {
        return Err(format!("unknown price source {source:?}"));
    }
    let sql = if source == "transaction" {
        "INSERT OR IGNORE INTO security_prices (security_id, date, price_micro, source)
         VALUES (?1, ?2, ?3, ?4)"
    } else {
        "INSERT INTO security_prices (security_id, date, price_micro, source)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(security_id, date) DO UPDATE SET price_micro = excluded.price_micro,
                                                      source = excluded.source"
    };
    conn.execute(sql, params![security_id, date, price_micro, source])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// The price a buy / sell / reinvest implies for its day. A price the user
/// TYPED (a broker's NAV to six places, corrected after an import
/// rounded it) replaces a `transaction` row for that day — that row was
/// only ever an inference, from this transaction or another the same day.
/// A price DERIVED from the total never replaces anything. Neither touches
/// a `fetched` or `manual` row: a quote beats an inference, never the
/// reverse.
pub fn record_transaction_price(
    conn: &Connection,
    security_id: &str,
    date: &str,
    price_micro: i64,
    explicit: bool,
) -> Result<(), String> {
    if explicit {
        parse_date(date)?;
        if price_micro < 0 {
            return Err("a price cannot be negative".to_string());
        }
        conn.execute(
            "INSERT INTO security_prices (security_id, date, price_micro, source)
             VALUES (?1, ?2, ?3, 'transaction')
             ON CONFLICT(security_id, date) DO UPDATE SET price_micro = excluded.price_micro
             WHERE security_prices.source = 'transaction'",
            params![security_id, date, price_micro],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    } else {
        set_security_price(conn, security_id, date, price_micro, "transaction")
    }
}

pub fn delete_security_price(conn: &Conn, security_id: &str, date: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM security_prices WHERE security_id = ?1 AND date = ?2",
        params![security_id, date],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn list_security_prices(conn: &Conn, security_id: &str) -> Result<Vec<SecurityPrice>, String> {
    let mut stmt = conn
        .prepare("SELECT security_id, date, price_micro, source FROM security_prices
                   WHERE security_id = ?1 ORDER BY date DESC")
        .map_err(|e| e.to_string())?;
    let out = stmt
        .query_map(params![security_id], |r| {
            Ok(SecurityPrice { security_id: r.get(0)?, date: r.get(1)?, price_micro: r.get(2)?, source: r.get(3)? })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(out)
}

/// What an activity does to the account's cash. The ONE place this is decided.
pub fn investment_cash_effect(activity: &str, gross_cents: i64, commission_cents: i64) -> i64 {
    match activity {
        "buy" => -(gross_cents + commission_cents),
        "sell" => gross_cents - commission_cents,
        "dividend" | "interest" | "ltcg_dist" | "stcg_dist" | "return_of_capital" => gross_cents - commission_cents,
        _ => 0,
    }
}

fn needs_shares(activity: &str) -> bool {
    lots::OPENS_LOT.contains(&activity) || lots::CLOSES_LOT.contains(&activity) || activity == "split"
}

/// The category an income activity lands in when the form did not pick one:
/// the standard category of that name, if the file has it.
fn default_income_category(conn: &Connection, activity: &str) -> Result<Option<String>, String> {
    let name = match activity {
        "dividend" | "reinvest_dividend" => "Dividend Income",
        "interest" | "reinvest_interest" => "Interest Income",
        "ltcg_dist" | "stcg_dist" | "reinvest_ltcg" | "reinvest_stcg" => "Capital Gains",
        _ => return Ok(None),
    };
    conn.query_row(
        "SELECT id FROM categories WHERE name = ?1 COLLATE NOCASE ORDER BY parent_id IS NULL DESC LIMIT 1",
        params![name],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

struct Checked {
    shares: Option<i64>,
    price: Option<i64>,
    gross: i64,
    commission: i64,
    amount: i64,
    category: Option<String>,
    payee: String,
}

fn check_investment(conn: &Connection, t: &NewInvestmentTransaction) -> Result<Checked, String> {
    parse_date(&t.date)?;
    let a = t.activity.as_str();
    if !lots::ALL_ACTIVITIES.contains(&a) {
        return Err(format!("unknown investment activity {a:?}"));
    }
    let kind: String = conn
        .query_row("SELECT type FROM accounts WHERE id = ?1", params![t.account_id], |r| r.get(0))
        .map_err(|_| format!("account {} not found", t.account_id))?;
    if !matches!(kind.as_str(), "investment" | "retirement") {
        return Err("investment transactions belong in an investment or retirement account".to_string());
    }
    let sec = get_security(conn, &t.security_id)?;
    if t.gross_cents < 0 {
        return Err("the total cannot be negative — the activity gives the direction".to_string());
    }
    if t.commission_cents < 0 {
        return Err("a commission cannot be negative".to_string());
    }
    let shares = if needs_shares(a) {
        if t.shares_micro <= 0 {
            return Err(if a == "split" {
                "a split needs a ratio (2 for 1 is 2)".to_string()
            } else {
                format!("{} needs a number of shares", lots::activity_label(a))
            });
        }
        Some(t.shares_micro)
    } else {
        None
    };
    let price = if a == "split" {
        None
    } else if needs_shares(a) {
        t.price_micro.filter(|p| *p > 0).or_else(|| lots::price_from(t.gross_cents, t.shares_micro))
    } else {
        None
    };
    let gross = if a == "split" { 0 } else { t.gross_cents };
    let commission = if a == "split" { 0 } else { t.commission_cents };
    let category = if lots::INCOME.contains(&a) {
        match &t.category_id {
            Some(c) if !c.is_empty() => Some(c.clone()),
            _ => default_income_category(conn, a)?,
        }
    } else {
        None
    };
    Ok(Checked {
        shares,
        price,
        gross,
        commission,
        amount: investment_cash_effect(a, gross, commission),
        category,
        payee: sec.name,
    })
}

fn write_allocations(tx: &Connection, id: &str, activity: &str, allocs: &[LotAllocation]) -> Result<(), String> {
    tx.execute("DELETE FROM lot_allocations WHERE sell_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    if !lots::CLOSES_LOT.contains(&activity) {
        return Ok(());
    }
    for a in allocs {
        if a.shares_micro <= 0 {
            continue;
        }
        tx.execute(
            "INSERT INTO lot_allocations (sell_id, lot_id, shares_micro) VALUES (?1, ?2, ?3)
             ON CONFLICT(sell_id, lot_id) DO UPDATE SET shares_micro = shares_micro + excluded.shares_micro",
            params![id, a.lot_id, a.shares_micro],
        )
        .map_err(|e| format!("lot {}: {e}", a.lot_id))?;
    }
    Ok(())
}

/// Enter an investment transaction. The cash effect is derived from the
/// activity (`investment_cash_effect`), the price from the total when the
/// form left it blank, and a buy or sell with a funding account also writes
/// the transfer that moves the money — Money's "Transfer from: Checking" —
/// in the same SQL transaction. Returns the new row's id.
pub fn create_investment_transaction(conn: &Conn, t: &NewInvestmentTransaction) -> Result<String, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let id = insert_investment_transaction(&tx, t, None)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

/// The body of `create_investment_transaction`, inside a transaction the
/// caller holds — the OFX importer writes many in one. `fitid` is the
/// broker's id when there is one.
pub fn insert_investment_transaction(
    tx: &Connection,
    t: &NewInvestmentTransaction,
    fitid: Option<&str>,
) -> Result<String, String> {
    let c = check_investment(tx, t)?;
    let a = t.activity.as_str();
    let id = Uuid::new_v4().to_string();
    tx.execute(
        "INSERT INTO transactions
           (id, account_id, date, payee, payee_id, category_id, amount_cents, is_reconciled, notes,
            security_id, activity, shares_micro, price_micro, gross_cents, commission_cents, fitid)
         VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, 0, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            id, t.account_id, t.date, c.payee, c.category, c.amount, t.notes,
            t.security_id, a, c.shares, c.price, c.gross, c.commission, fitid
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE accounts SET balance_cents = balance_cents + ?1, updated_at = datetime('now') WHERE id = ?2",
        params![c.amount, t.account_id],
    )
    .map_err(|e| e.to_string())?;
    write_allocations(tx, &id, a, &t.lot_allocations)?;
    // A share move carries a price too — the quarterly fee share-out
    // was the newest price in the user's 401(k) file, and the portfolio was
    // valuing it six weeks stale because only buys and sells filed one.
    if let (Some(p), true) = (c.price, matches!(a, "buy" | "sell" | "add_shares" | "remove_shares") || a.starts_with("reinvest_")) {
        record_transaction_price(tx, &t.security_id, &t.date, p, t.price_micro.is_some())?;
    }
    if let Some(fund) = t.funding_account_id.as_deref().filter(|f| !f.is_empty()) {
        if fund == t.account_id {
            return Err("the funding account is the investment account itself".to_string());
        }
        if !matches!(a, "buy" | "sell" | "dividend" | "interest" | "ltcg_dist" | "stcg_dist" | "return_of_capital") {
            return Err("only a buy, a sell or income paid in cash can name another account — a reinvestment moves no cash".to_string());
        }
        let magnitude = c.amount.abs();
        if magnitude > 0 {
            let note = Some(format!("{} {}", lots::activity_label(a), c.payee));
            let mine = match a {
                "buy" => insert_transfer_pair(tx, fund, &t.account_id, &t.date, magnitude, note.as_deref())?.1,
                // A sale's proceeds, or income paid out (a dividend
                // swept to the bank), leave the investment account.
                "sell" | "dividend" | "interest" | "ltcg_dist" | "stcg_dist" | "return_of_capital" => {
                    insert_transfer_pair(tx, &t.account_id, fund, &t.date, magnitude, note.as_deref())?.0
                }
                _ => return Err("only a buy, a sell or income paid in cash can name another account".to_string()),
            };
            // The buy remembers its own funding pair, so "Pay from" can change later.
            tx.execute("UPDATE transactions SET funding_txn_id = ?2 WHERE id = ?1", params![id, mine]).map_err(|e| e.to_string())?;
        }
    }
    Ok(id)
}

/// Move shares between two investment accounts as one action: a
/// Remove Shares in `from` and an Add Shares in `to`, linked by
/// `transfer_id` like a money transfer. The lots travel with their dates
/// and basis — `lots::replay` reopens in `to` exactly what closed in
/// `from` — so a rollover does not restart the holding period. FIFO, or
/// the lots named in `lot_allocations`. Returns (remove id, add id).
pub fn create_share_transfer(
    conn: &Conn,
    from_account_id: &str,
    to_account_id: &str,
    date: &str,
    security_id: &str,
    shares_micro: i64,
    notes: Option<&str>,
    lot_allocations: &[LotAllocation],
) -> Result<(String, String), String> {
    if from_account_id == to_account_id {
        return Err("shares cannot be transferred to the account they are in".to_string());
    }
    // Shares moved into or out of a closed account are a new link too.
    refuse_new_link_to_closed(conn, &[from_account_id, to_account_id])?;
    let held: i64 = lots::replay(conn, Some(from_account_id), Some(security_id), Some(date))?
        .lots
        .iter()
        .map(|l| l.shares_micro)
        .sum();
    if shares_micro > held {
        return Err(format!(
            "only {} shares are held in that account on {date}; {} cannot be moved",
            lots::fmt_shares(held),
            lots::fmt_shares(shares_micro)
        ));
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let base = |account: &str, activity: &str| NewInvestmentTransaction {
        account_id: account.to_string(),
        date: date.to_string(),
        activity: activity.to_string(),
        security_id: security_id.to_string(),
        shares_micro,
        price_micro: None,
        gross_cents: 0,
        commission_cents: 0,
        category_id: None,
        notes: notes.map(str::to_string),
        funding_account_id: None,
        lot_allocations: vec![],
    };
    let mut out = base(from_account_id, "remove_shares");
    out.lot_allocations = lot_allocations.to_vec();
    let remove_id = insert_investment_transaction(&tx, &out, None)?;
    let add_id = insert_investment_transaction(&tx, &base(to_account_id, "add_shares"), None)?;
    tx.execute("UPDATE transactions SET transfer_id = ?2 WHERE id = ?1", params![remove_id, add_id])
        .map_err(|e| e.to_string())?;
    tx.execute("UPDATE transactions SET transfer_id = ?2 WHERE id = ?1", params![add_id, remove_id])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok((remove_id, add_id))
}

/// The account a buy was paid from (or a sell deposited to) through its
/// funding pair, if it still has one.
pub fn funding_account_of(conn: &Connection, id: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT p.account_id FROM transactions t
           JOIN transactions f ON f.id = t.funding_txn_id
           JOIN transactions p ON p.id = f.transfer_id
          WHERE t.id = ?1",
        params![id],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// The funding pair's row for a pre-0027 buy or sell, by the shape
/// `insert_transfer_pair` gave it, when exactly one row fits.
pub(super) fn legacy_funding_row(conn: &Connection, id: &str) -> Result<Option<String>, String> {
    let rows: Vec<String> = {
        let mut st = conn
            .prepare(
                "SELECT f.id FROM transactions t
                   JOIN transactions f ON f.account_id = t.account_id AND f.date = t.date
                  WHERE t.id = ?1 AND t.activity IN ('buy', 'sell')
                    AND f.activity IS NULL AND f.transfer_id IS NOT NULL
                    AND f.amount_cents = -t.amount_cents
                    AND f.notes = (CASE t.activity WHEN 'buy' THEN 'Buy ' ELSE 'Sell ' END) || t.payee
                    AND f.id NOT IN (SELECT funding_txn_id FROM transactions WHERE funding_txn_id IS NOT NULL)",
            )
            .map_err(|e| e.to_string())?;
        let v = st.query_map(params![id], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
        v
    };
    Ok(if rows.len() == 1 { rows.into_iter().next() } else { None })
}

/// Edit an investment transaction in place. The funding pair follows:
/// `funding_account_id` None removes it, a different account (or a changed
/// date or amount) rewrites it, and a buy that had none gets one.
pub fn update_investment_transaction(conn: &Conn, id: &str, t: &NewInvestmentTransaction) -> Result<(), String> {
    let (old_amount, old_account, is_void, activity, transfer_id, old_funding_txn): (i64, String, i64, Option<String>, Option<String>, Option<String>) = conn
        .query_row(
            "SELECT amount_cents, account_id, is_void, activity, transfer_id, funding_txn_id FROM transactions WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .map_err(|e| format!("transaction {id} not found: {e}"))?;
    // A buy from before migration 0027 that the backfill could not link
    // (two identical buys one day) is still found here when the match is
    // unambiguous — else its pair is left alone, as before.
    let old_funding_txn = match old_funding_txn {
        Some(f) => Some(f),
        None => legacy_funding_row(conn, id)?,
    };
    if let Some(f) = old_funding_txn.as_deref() {
        conn.execute("UPDATE transactions SET funding_txn_id = ?2 WHERE id = ?1 AND funding_txn_id IS NULL", params![id, f]).map_err(|e| e.to_string())?;
    }
    let old_funding_account = funding_account_of(conn, id)?;
    if activity.is_none() {
        return Err("this is not an investment transaction".to_string());
    }
    if transfer_id.is_some() {
        return Err("this is one half of a share transfer — delete it (both halves go) and enter it again".to_string());
    }
    if old_account != t.account_id {
        return Err("an investment transaction cannot change accounts; use Remove Shares and Add Shares".to_string());
    }
    let c = check_investment(conn, t)?;
    let a = t.activity.as_str();
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE transactions
            SET date = ?1, payee = ?2, category_id = ?3, amount_cents = ?4, notes = ?5,
                security_id = ?6, activity = ?7, shares_micro = ?8, price_micro = ?9,
                gross_cents = ?10, commission_cents = ?11
          WHERE id = ?12",
        params![
            t.date, c.payee, c.category, c.amount, t.notes, t.security_id, a, c.shares, c.price,
            c.gross, c.commission, id
        ],
    )
    .map_err(|e| e.to_string())?;
    let delta = if is_void != 0 { 0 } else { c.amount - old_amount };
    if delta != 0 {
        tx.execute(
            "UPDATE accounts SET balance_cents = balance_cents + ?1, updated_at = datetime('now') WHERE id = ?2",
            params![delta, t.account_id],
        )
        .map_err(|e| e.to_string())?;
    }
    write_allocations(&tx, id, a, &t.lot_allocations)?;
    // A share move carries a price too — the quarterly fee share-out
    // was the newest price in the user's 401(k) file, and the portfolio was
    // valuing it six weeks stale because only buys and sells filed one.
    if let (Some(p), true) = (c.price, matches!(a, "buy" | "sell" | "add_shares" | "remove_shares") || a.starts_with("reinvest_")) {
        record_transaction_price(&tx, &t.security_id, &t.date, p, t.price_micro.is_some())?;
    }
    // The funding pair. Anything that changes it is a delete-and-rewrite,
    // which keeps every balance honest through the one code path.
    let new_funding = t.funding_account_id.as_deref().filter(|f| !f.is_empty()).map(str::to_string);
    if new_funding.as_deref() == Some(t.account_id.as_str()) {
        return Err("the funding account is the investment account itself".to_string());
    }
    let fundable = matches!(a, "buy" | "sell" | "dividend" | "interest" | "ltcg_dist" | "stcg_dist" | "return_of_capital");
    let magnitude = c.amount.abs();
    let pair_changed = old_funding_account != new_funding || c.amount != old_amount || {
        // The pair's date is the row's old date; a moved date rewrites it.
        match old_funding_txn.as_deref() {
            Some(f) => {
                let d: Option<String> = tx.query_row("SELECT date FROM transactions WHERE id = ?1", params![f], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
                d.as_deref() != Some(t.date.as_str())
            }
            None => false,
        }
    };
    if pair_changed {
        if let Some(f) = old_funding_txn.as_deref() {
            delete_transfer_pair_in(&tx, f)?;
            tx.execute("UPDATE transactions SET funding_txn_id = NULL WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
        }
        if let (Some(fund), true, true) = (new_funding.as_deref(), fundable, magnitude > 0) {
            let note = Some(format!("{} {}", lots::activity_label(a), c.payee));
            let mine = match a {
                "buy" => insert_transfer_pair(&tx, fund, &t.account_id, &t.date, magnitude, note.as_deref())?.1,
                _ => insert_transfer_pair(&tx, &t.account_id, fund, &t.date, magnitude, note.as_deref())?.0,
            };
            tx.execute("UPDATE transactions SET funding_txn_id = ?2 WHERE id = ?1", params![id, mine]).map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Delete both halves of a linked pair, given either half, inside an open
/// SQL transaction; the balances step back on both accounts. Voided halves
/// were already out of the balance.
pub(super) fn delete_transfer_pair_in(tx: &Connection, id: &str) -> Result<(), String> {
    let Some((amount, account, other)) = tx
        .query_row(
            "SELECT CASE WHEN is_void = 1 THEN 0 ELSE amount_cents END, account_id, transfer_id FROM transactions WHERE id = ?1",
            params![id],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
    else {
        return Ok(());
    };
    // A paid occurrence goes back to due whichever half it was
    // entered as, released before either row goes (see `delete_transaction`).
    tx.execute(
        "DELETE FROM recurrence_exceptions WHERE status = 'paid' AND transaction_id IN (?1, ?2)",
        params![id, other],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("UPDATE transactions SET transfer_id = NULL WHERE id = ?1 OR transfer_id = ?1", params![id]).map_err(|e| e.to_string())?;
    if let Some(o) = other.as_deref() {
        let (oa, oacct): (i64, String) = tx
            .query_row("SELECT CASE WHEN is_void = 1 THEN 0 ELSE amount_cents END, account_id FROM transactions WHERE id = ?1", params![o], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM transactions WHERE id = ?1", params![o]).map_err(|e| e.to_string())?;
        tx.execute("UPDATE accounts SET balance_cents = balance_cents - ?1, updated_at = datetime('now') WHERE id = ?2", params![oa, oacct]).map_err(|e| e.to_string())?;
    }
    tx.execute("DELETE FROM transactions WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
    tx.execute("UPDATE accounts SET balance_cents = balance_cents - ?1, updated_at = datetime('now') WHERE id = ?2", params![amount, account]).map_err(|e| e.to_string())?;
    Ok(())
}

/// The lots a sale on `asof` could take: what is open in that account for
/// that security on that date.
pub fn list_lots(conn: &Conn, account_id: &str, security_id: &str, asof: &str) -> Result<Vec<crate::models::Lot>, String> {
    parse_date(asof)?;
    Ok(lots::replay(conn, Some(account_id), Some(security_id), Some(asof))?.lots)
}

/// The lots a specific sale took (its own allocations, or FIFO), for the
/// edit form and the lot detail.
pub fn disposals_for(conn: &Conn, sell_id: &str) -> Result<Vec<crate::models::Disposal>, String> {
    let (acct, sec): (String, String) = conn
        .query_row(
            "SELECT account_id, security_id FROM transactions WHERE id = ?1 AND activity IS NOT NULL",
            params![sell_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| format!("transaction {sell_id} not found: {e}"))?;
    Ok(lots::replay(conn, Some(&acct), Some(&sec), None)?
        .disposals
        .into_iter()
        .filter(|d| d.sell_id == sell_id)
        .collect())
}

#[cfg(test)]
mod tests {
    use crate::models::LotAllocation;
    use crate::db::lots;
    use rusqlite::{params, OptionalExtension};
    use super::*;
    use crate::db::queries::test_support::*;

    #[test]
    fn dated_roi_takes_contributions_out_and_counts_income_and_realized_gains() {
        let db = TestDb::new("roi");
        let c = db.conn();
        let k = inv_account(&c, "401(k)", "retirement");
        let fund = create_security(&c, "Fund", "FUND", "mutual_fund", None).unwrap();
        // 2025: buy 100 at $10. Price at year end $12.
        create_investment_transaction(&c, &inv(&k, "2025-03-01", "buy", &fund.id, 100 * lots::MICRO, 100_000)).unwrap();
        set_security_price(&c, &fund.id, "2025-12-31", 12_000_000, "manual").unwrap();
        // 2026: a $600 contribution (add shares at $12), a $30 dividend, a sale of 20 at $13 (gain 60), price $14 now.
        create_investment_transaction(&c, &inv(&k, "2026-02-01", "add_shares", &fund.id, 50 * lots::MICRO, 60_000)).unwrap();
        create_investment_transaction(&c, &inv(&k, "2026-05-01", "dividend", &fund.id, 0, 3_000)).unwrap();
        create_investment_transaction(&c, &inv(&k, "2026-06-01", "sell", &fund.id, 20 * lots::MICRO, 26_000)).unwrap();
        set_security_price(&c, &fund.id, "2026-08-06", 14_000_000, "manual").unwrap();
        set_security_price(&c, &fund.id, "2026-09-06", 14_000_000, "manual").unwrap();

        let r = lots::roi(&c, Some(&k), "2026-09-06").unwrap();
        let ytd = r.iter().find(|p| p.label == "Year to date").unwrap();
        // Start of year: 100 sh × $12 = 1,200, cost 1,000 → unrealized 200.
        // Now: 130 sh × $14 = 1,820, cost 1,000 − 200 (sold, FIFO) + 600 = 1,400 → unrealized 420.
        assert_eq!((ytd.start_value_cents, ytd.end_value_cents), (120_000, 182_000));
        assert_eq!((ytd.unrealized_change_cents, ytd.realized_cents, ytd.income_cents), (22_000, 6_000, 3_000));
        assert_eq!(ytd.return_cents, 31_000);
        assert_eq!(ytd.return_bps, Some(2_583)); // 310 / 1,200
        // Past month: nothing happened, price flat → 0.
        let m = r.iter().find(|p| p.label == "Past month").unwrap();
        assert_eq!((m.return_cents, m.start_value_cents), (0, 182_000));
        // All time: everything ever put in is 1,600 (1,000 + 600); return = 420 + 60 + 30 = 510.
        let all = r.iter().find(|p| p.label == "All time").unwrap();
        assert_eq!((all.return_cents, all.return_bps), (51_000, Some(3_188)));
        // An account with nothing held at the start has no percentage.
        let empty = inv_account(&c, "New", "investment");
        assert!(lots::roi(&c, Some(&empty), "2026-09-06").unwrap().iter().all(|p| p.return_bps.is_none() && p.return_cents == 0));
    }

    // ── investments: securities, lots, gains ───────────────────────

    #[test]
    fn the_cash_effect_follows_from_the_activity_never_the_form() {
        assert_eq!(investment_cash_effect("buy", 10_000, 495), -10_495);
        assert_eq!(investment_cash_effect("sell", 10_000, 495), 9_505);
        assert_eq!(investment_cash_effect("dividend", 625, 0), 625);
        assert_eq!(investment_cash_effect("reinvest_dividend", 625, 0), 0);
        assert_eq!(investment_cash_effect("add_shares", 10_000, 0), 0);
        assert_eq!(investment_cash_effect("split", 0, 0), 0);
        assert_eq!(investment_cash_effect("return_of_capital", 300, 0), 300);
    }

    #[test]
    fn a_buy_takes_cash_and_opens_a_lot_with_the_commission_in_its_basis() {
        let db = TestDb::new("inv-buy");
        let c = db.conn();
        let acct = inv_account(&c, "Brokerage", "investment");
        create_transaction(&c, &acct, "2025-01-02", "Opening Balance", None, 500_000, None, None).unwrap();
        let sec = create_security(&c, "Apple Inc.", "aapl", "stock", None).unwrap();
        assert_eq!(sec.symbol, "AAPL", "symbols are upper-cased");
        let mut t = inv(&acct, "2025-02-01", "buy", &sec.id, 10 * lots::MICRO, 150_000);
        t.commission_cents = 495;
        let id = create_investment_transaction(&c, &t).unwrap();

        assert_eq!(get_account(&c, &acct).unwrap().balance_cents, 500_000 - 150_495);
        let reg = get_register(&c, &acct).unwrap();
        let row = reg.iter().find(|r| r.id == id).unwrap();
        assert_eq!(row.activity.as_deref(), Some("buy"));
        assert_eq!(row.payee, "Apple Inc.");
        assert_eq!(row.price_micro, Some(150 * lots::MICRO), "price derived from the total");
        assert_eq!(row.amount_cents, -150_495);
        // The buy's price is now the price history's first entry.
        let s = get_security(&c, &sec.id).unwrap();
        assert_eq!((s.last_price_micro, s.price_date.as_deref(), s.price_source.as_deref()), (Some(150 * lots::MICRO), Some("2025-02-01"), Some("transaction")));

        let p = lots::portfolio(&c, None, "2025-12-31").unwrap();
        assert_eq!(p.positions.len(), 1);
        assert_eq!((p.positions[0].shares_micro, p.positions[0].cost_cents), (10 * lots::MICRO, 150_495));
        assert_eq!(p.positions[0].lots[0].id, id);
        // Before the buy, nothing.
        assert!(lots::portfolio(&c, None, "2025-01-31").unwrap().positions.is_empty());
        // The plain editor refuses the row; the cash column is not the user's to type.
        assert!(update_transaction(&c, &id, "2025-02-01", "Apple Inc.", None, -1, None, None).is_err());
        // An investment row cannot go in a checking account.
        let chk = account(&c, "Checking", 0);
        assert!(create_investment_transaction(&c, &inv(&chk, "2025-02-01", "buy", &sec.id, lots::MICRO, 100)).is_err());
    }

    // A broker's confirmation says 12.3456 shares, NAV 34.5678, total
    // 426.74. The app kept the total (the cash) and the day's price came from
    // the rounded NAV, so the portfolio was pennies off the statement. Typing
    // the six-place NAV on the row fixes the day's price and leaves the total
    // alone; a derived price never overwrites; a fetched quote is never touched.
    #[test]
    fn a_typed_price_corrects_the_days_inferred_price_but_not_the_total_nor_a_quote() {
        let db = TestDb::new("inv-price-fix");
        let c = db.conn();
        let acct = inv_account(&c, "401(k)", "retirement");
        create_transaction(&c, &acct, "2025-01-02", "Opening Balance", None, 100_000, None, None).unwrap();
        let sec = create_security(&c, "VTSAX", "VTSAX", "mutual_fund", None).unwrap();
        // As imported: shares, a four-place price, and the broker's total.
        let mut t = inv(&acct, "2025-03-03", "buy", &sec.id, 12_345_600, 42_674);
        t.price_micro = Some(34_567_800);
        let id = create_investment_transaction(&c, &t).unwrap();
        let price_on = |c: &Conn, d: &str| -> Option<(i64, String)> {
            c.query_row("SELECT price_micro, source FROM security_prices WHERE security_id = ?1 AND date = ?2", params![sec.id, d], |r| Ok((r.get(0)?, r.get(1)?))).optional().unwrap()
        };
        assert_eq!(price_on(&c, "2025-03-03"), Some((34_567_800, "transaction".to_string())));

        // The correction: the NAV to six places, everything else as it was.
        t.price_micro = Some(34_567_890);
        update_investment_transaction(&c, &id, &t).unwrap();
        let row = get_register(&c, &acct).unwrap().into_iter().find(|r| r.id == id).unwrap();
        assert_eq!((row.price_micro, row.gross_cents, row.amount_cents), (Some(34_567_890), Some(42_674), -42_674), "price changed, total and cash did not");
        assert_eq!(price_on(&c, "2025-03-03"), Some((34_567_890, "transaction".to_string())), "the day's inferred price follows the typed one");
        let p = lots::portfolio(&c, Some(&acct), "2025-03-31").unwrap();
        assert_eq!(p.positions[0].cost_cents, 42_674, "basis is the total paid");
        assert_eq!(p.positions[0].value_cents, lots::mul_div(12_345_600, 34_567_890, 10_000_000_000), "valued at the corrected price");

        // A price derived from the total (none typed) never overwrites the day's row.
        t.price_micro = None;
        update_investment_transaction(&c, &id, &t).unwrap();
        assert_eq!(price_on(&c, "2025-03-03"), Some((34_567_890, "transaction".to_string())));

        // A quote for that day outranks anything a transaction says.
        set_security_price(&c, &sec.id, "2025-03-03", 34_570_000, "fetched").unwrap();
        t.price_micro = Some(34_000_000);
        update_investment_transaction(&c, &id, &t).unwrap();
        assert_eq!(price_on(&c, "2025-03-03"), Some((34_570_000, "fetched".to_string())));
        assert_eq!(get_register(&c, &acct).unwrap().into_iter().find(|r| r.id == id).unwrap().price_micro, Some(34_000_000), "the row itself still says what was typed");
    }

    // 20.125 shares of Fund A (FNDAX) @ $10.07 = 202.65875 → the app
    // rounds to 202.66, a broker that truncates says 202.65; 10.25 shares of
    // Fund B (FNDBX) @ $50.07 = 513.2175 → 513.22 rounded, 513.21 truncated.
    // Some brokers truncate. The file can say so, and then every place that
    // values a holding — the Portfolio, the sidebar's account worth, net
    // worth — agrees with the statement, with the numbers as they are.
    #[test]
    fn holding_values_can_round_down_the_way_some_brokers_do_and_the_sidebar_agrees_with_the_portfolio() {
        let db = TestDb::new("inv-rounding");
        let c = db.conn();
        let acct = inv_account(&c, "Brokerage", "investment");
        let fund_a = create_security(&c, "Fund A", "FNDAX", "mutual_fund", None).unwrap();
        let fund_b = create_security(&c, "Fund B", "FNDBX", "mutual_fund", None).unwrap();
        // Two lots of FNDAX so per-lot and per-position rounding could differ.
        create_investment_transaction(&c, &inv(&acct, "2026-02-03", "add_shares", &fund_a.id, 12_000_000, 12_000)).unwrap();
        create_investment_transaction(&c, &inv(&acct, "2026-03-03", "add_shares", &fund_a.id, 8_125_000, 8_000)).unwrap();
        create_investment_transaction(&c, &inv(&acct, "2026-03-03", "add_shares", &fund_b.id, 10_250_000, 50_000)).unwrap();
        set_security_price(&c, &fund_a.id, "2026-09-05", 10_070_000, "fetched").unwrap();
        set_security_price(&c, &fund_b.id, "2026-09-05", 50_070_000, "fetched").unwrap();

        let value_of = |c: &Conn, sym: &str| lots::portfolio(c, Some(&acct), "2026-09-07").unwrap().positions.into_iter().find(|p| p.symbol == sym).unwrap().value_cents;
        // Default: nearest.
        assert_eq!(lots::rounding(&c).unwrap(), lots::Rounding::Nearest);
        assert_eq!(value_of(&c, "FNDAX"), 20_266);
        assert_eq!(value_of(&c, "FNDBX"), 51_322);
        assert_eq!(lots::portfolio(&c, Some(&acct), "2026-09-07").unwrap().rounding, "nearest");

        // The file asks for the broker's arithmetic.
        set_setting(&c, lots::ROUNDING_KEY, "down").unwrap();
        assert_eq!(lots::rounding(&c).unwrap(), lots::Rounding::Down);
        assert_eq!(value_of(&c, "FNDAX"), 20_265, "20.125 × 10.07 = 202.65875, truncated");
        assert_eq!(value_of(&c, "FNDBX"), 51_321, "10.25 × 50.07 = 513.2175, truncated");
        let p = lots::portfolio(&c, Some(&acct), "2026-09-07").unwrap();
        assert_eq!((p.total_value_cents, p.rounding.as_str()), (20_265 + 51_321, "down"));
        // The sidebar's number is the Portfolio's number, exactly.
        assert_eq!(get_account(&c, &acct).unwrap().holdings_value_cents, p.total_value_cents);

        // Anything else stored means nearest.
        set_setting(&c, lots::ROUNDING_KEY, "sideways").unwrap();
        assert_eq!(lots::rounding(&c).unwrap(), lots::Rounding::Nearest);

        // An account can go its own way. File says nearest; this
        // account says down; a second account follows the file.
        let other = inv_account(&c, "Other broker", "investment");
        create_investment_transaction(&c, &inv(&other, "2026-03-03", "add_shares", &fund_a.id, 20_125_000, 20_000)).unwrap();
        assert!(get_account(&c, &acct).unwrap().value_rounding.is_none());
        set_account_value_rounding(&c, &acct, Some("down")).unwrap();
        assert_eq!(get_account(&c, &acct).unwrap().value_rounding.as_deref(), Some("down"));
        let p = lots::portfolio(&c, None, "2026-09-07").unwrap();
        let by = |name: &str, sym: &str| p.positions.iter().find(|x| x.account_name == name && x.symbol == sym).unwrap();
        assert_eq!((by("Brokerage", "FNDAX").value_cents, by("Brokerage", "FNDAX").rounding.as_str()), (20_265, "down"));
        assert_eq!((by("Other broker", "FNDAX").value_cents, by("Other broker", "FNDAX").rounding.as_str()), (20_266, "nearest"));
        assert_eq!(get_account(&c, &acct).unwrap().holdings_value_cents, 20_265 + 51_321);
        assert_eq!(get_account(&c, &other).unwrap().holdings_value_cents, 20_266);
        set_account_value_rounding(&c, &acct, None).unwrap();
        assert!(get_account(&c, &acct).unwrap().value_rounding.is_none());
        assert!(set_account_value_rounding(&c, &acct, Some("sideways")).is_err());
    }

    #[test]
    fn fifo_sells_the_oldest_lot_and_specify_lots_overrides_it() {
        let db = TestDb::new("inv-fifo");
        let c = db.conn();
        let acct = inv_account(&c, "Brokerage", "investment");
        let sec = create_security(&c, "Fund", "FUND", "mutual_fund", None).unwrap();
        let lot1 = create_investment_transaction(&c, &inv(&acct, "2024-01-10", "buy", &sec.id, 100 * lots::MICRO, 100_000)).unwrap(); // $10
        let lot2 = create_investment_transaction(&c, &inv(&acct, "2025-06-10", "buy", &sec.id, 100 * lots::MICRO, 200_000)).unwrap(); // $20
        // Sell 150 at $30 on 2025-09-01: FIFO takes all of lot1 (LT) and 50 of lot2 (ST).
        let sell = create_investment_transaction(&c, &inv(&acct, "2025-09-01", "sell", &sec.id, 150 * lots::MICRO, 450_000)).unwrap();
        let d = disposals_for(&c, &sell).unwrap();
        assert_eq!(d.len(), 2);
        assert_eq!((d[0].lot_id.as_str(), d[0].shares_micro, d[0].cost_cents, d[0].proceeds_cents, d[0].gain_cents, d[0].long_term), (lot1.as_str(), 100 * lots::MICRO, 100_000, 300_000, 200_000, true));
        assert_eq!((d[1].lot_id.as_str(), d[1].shares_micro, d[1].cost_cents, d[1].proceeds_cents, d[1].gain_cents, d[1].long_term), (lot2.as_str(), 50 * lots::MICRO, 100_000, 150_000, 50_000, false));
        let p = lots::portfolio(&c, Some(&acct), "2025-12-31").unwrap();
        assert_eq!((p.positions[0].shares_micro, p.positions[0].cost_cents), (50 * lots::MICRO, 100_000));
        assert_eq!(get_account(&c, &acct).unwrap().balance_cents, -100_000 - 200_000 + 450_000);

        // Now say: take the 150 from lot2 first. Only 100 are there, so 50 fall back to FIFO (lot1).
        let mut t = inv(&acct, "2025-09-01", "sell", &sec.id, 150 * lots::MICRO, 450_000);
        t.lot_allocations = vec![LotAllocation { lot_id: lot2.clone(), shares_micro: 150 * lots::MICRO }];
        update_investment_transaction(&c, &sell, &t).unwrap();
        let d = disposals_for(&c, &sell).unwrap();
        assert_eq!(d.len(), 2);
        assert_eq!((d[0].lot_id.as_str(), d[0].shares_micro, d[0].gain_cents), (lot2.as_str(), 100 * lots::MICRO, 100_000));
        assert_eq!((d[1].lot_id.as_str(), d[1].shares_micro, d[1].gain_cents), (lot1.as_str(), 50 * lots::MICRO, 100_000));
        let ledger = lots::replay(&c, Some(&acct), None, None).unwrap();
        assert_eq!(ledger.problems.len(), 1, "the short lot is reported: {:?}", ledger.problems);
        assert_eq!(ledger.lots[0].id, lot1);
        assert_eq!(ledger.lots[0].shares_micro, 50 * lots::MICRO);

        // Capital gains report picks both up under the right term.
        let rep = crate::db::reports::run_report(&c, &crate::models::ReportRequest {
            kind: "capital_gains".into(), from: "2025-01-01".into(), to: "2025-12-31".into(),
            account_ids: None, category_ids: None, compare_from: None, compare_to: None, detail: None, security_ids: None, tax_scope: None, ..Default::default()
        }).unwrap();
        let labels: Vec<&str> = rep.rows.iter().map(|r| r.label.as_str()).collect();
        assert!(labels.contains(&"Short-term (held one year or less)") && labels.contains(&"Long-term (held more than one year)"), "{labels:?}");
        let net = rep.rows.last().unwrap();
        assert_eq!(net.cells.last().unwrap().cents, Some(200_000));
    }

    #[test]
    fn splits_reinvestments_return_of_capital_and_oversells_do_what_they_say() {
        let db = TestDb::new("inv-misc");
        let c = db.conn();
        let acct = inv_account(&c, "401(k)", "retirement");
        let sec = create_security(&c, "Fund", "FUND", "mutual_fund", None).unwrap();
        create_category(&c, "Dividend Income", "income", None, None).unwrap();
        create_investment_transaction(&c, &inv(&acct, "2025-01-10", "add_shares", &sec.id, 100 * lots::MICRO, 100_000)).unwrap();
        // Reinvested dividend: no cash, a new lot, and income for the reports.
        let div = create_investment_transaction(&c, &inv(&acct, "2025-03-10", "reinvest_dividend", &sec.id, 2 * lots::MICRO, 2_400)).unwrap();
        assert_eq!(get_account(&c, &acct).unwrap().balance_cents, 0);
        let row = get_register(&c, &acct).unwrap().into_iter().find(|r| r.id == div).unwrap();
        assert!(row.category_name.is_some(), "the income category is filled in by default");
        assert_eq!(row.gross_cents, Some(2_400));
        // 2-for-1 split: shares double, cost does not.
        create_investment_transaction(&c, &inv(&acct, "2025-04-01", "split", &sec.id, 2 * lots::MICRO, 0)).unwrap();
        let l = lots::replay(&c, Some(&acct), None, None).unwrap();
        assert_eq!(l.lots.iter().map(|x| x.shares_micro).sum::<i64>(), 204 * lots::MICRO);
        assert_eq!(l.lots.iter().map(|x| x.cost_cents).sum::<i64>(), 102_400);
        // Return of capital: cash in, basis down pro rata, nothing sold.
        create_investment_transaction(&c, &inv(&acct, "2025-05-01", "return_of_capital", &sec.id, 0, 10_240)).unwrap();
        assert_eq!(get_account(&c, &acct).unwrap().balance_cents, 10_240);
        let l = lots::replay(&c, Some(&acct), None, None).unwrap();
        assert_eq!(l.lots.iter().map(|x| x.cost_cents).sum::<i64>(), 102_400 - 10_240);
        assert_eq!(l.lots[0].cost_cents, 90_000);
        assert_eq!(l.lots[1].cost_cents, 2_160);
        assert!(l.problems.is_empty());
        // Sell more than held: clamped and reported, never silently negative.
        create_investment_transaction(&c, &inv(&acct, "2025-06-01", "sell", &sec.id, 300 * lots::MICRO, 600_000)).unwrap();
        let l = lots::replay(&c, Some(&acct), None, None).unwrap();
        assert!(l.lots.is_empty());
        assert_eq!(l.problems.len(), 1);
        assert!(l.problems[0].contains("only 204"), "{}", l.problems[0]);
        // Remove Shares realizes nothing.
        let acct2 = inv_account(&c, "IRA", "retirement");
        create_investment_transaction(&c, &inv(&acct2, "2025-01-10", "buy", &sec.id, 10 * lots::MICRO, 10_000)).unwrap();
        create_investment_transaction(&c, &inv(&acct2, "2025-02-10", "remove_shares", &sec.id, 10 * lots::MICRO, 0)).unwrap();
        assert!(lots::realized(&c, Some(&acct2), "2025-01-01", "2025-12-31").unwrap().is_empty());
        // A security with history cannot be deleted; one without can.
        assert!(delete_security(&c, &sec.id).is_err());
        let spare = create_security(&c, "Spare", "", "other", None).unwrap();
        delete_security(&c, &spare.id).unwrap();
    }

    #[test]
    fn a_share_transfer_carries_the_lots_dates_and_basis_across() {
        let db = TestDb::new("inv-xfer");
        let c = db.conn();
        let ira = inv_account(&c, "Old 401(k)", "retirement");
        let roll = inv_account(&c, "Rollover IRA", "retirement");
        let sec = create_security(&c, "Fund", "FUND", "mutual_fund", None).unwrap();
        create_investment_transaction(&c, &inv(&ira, "2024-01-10", "buy", &sec.id, 100 * lots::MICRO, 100_000)).unwrap();
        create_investment_transaction(&c, &inv(&ira, "2025-06-10", "buy", &sec.id, 100 * lots::MICRO, 200_000)).unwrap();

        // Move 150 (FIFO: all of the 2024 lot, half of the 2025 lot).
        assert!(create_share_transfer(&c, &ira, &roll, "2025-09-01", &sec.id, 250 * lots::MICRO, None, &[]).is_err(), "more than held");
        let (rm, add) = create_share_transfer(&c, &ira, &roll, "2025-09-01", &sec.id, 150 * lots::MICRO, Some("Rollover"), &[]).unwrap();

        // Nothing realized, no cash moved.
        assert!(lots::realized(&c, None, "2025-01-01", "2025-12-31").unwrap().is_empty());
        assert_eq!(get_account(&c, &ira).unwrap().balance_cents, -300_000);
        assert_eq!(get_account(&c, &roll).unwrap().balance_cents, 0);

        // The receiving account holds the ORIGINAL lots: 2024 and 2025 dates, original basis.
        let p = lots::portfolio(&c, Some(&roll), "2025-12-31").unwrap();
        assert!(p.problems.is_empty(), "{:?}", p.problems);
        let got: Vec<(String, i64, i64)> = p.positions[0].lots.iter().map(|l| (l.acquired_on.clone(), l.shares_micro, l.cost_cents)).collect();
        assert_eq!(got, vec![("2024-01-10".to_string(), 100 * lots::MICRO, 100_000), ("2025-06-10".to_string(), 50 * lots::MICRO, 100_000)]);
        // The sender keeps the rest.
        let p = lots::portfolio(&c, Some(&ira), "2025-12-31").unwrap();
        assert_eq!((p.positions[0].shares_micro, p.positions[0].cost_cents), (50 * lots::MICRO, 100_000));

        // A later sale in the new account is long-term, because the 2024 date came with it.
        create_investment_transaction(&c, &inv(&roll, "2025-10-01", "sell", &sec.id, 100 * lots::MICRO, 300_000)).unwrap();
        let d = lots::realized(&c, Some(&roll), "2025-01-01", "2025-12-31").unwrap();
        assert_eq!(d.len(), 1);
        assert!(d[0].long_term);
        assert_eq!(d[0].gain_cents, 200_000);

        // The halves are linked and edit-protected; deleting one removes both.
        let reg = get_register(&c, &roll).unwrap();
        let half = reg.iter().find(|r| r.id == add).unwrap();
        assert_eq!(half.transfer_account_name.as_deref(), Some("Old 401(k)"));
        assert!(update_investment_transaction(&c, &add, &inv(&roll, "2025-09-01", "add_shares", &sec.id, lots::MICRO, 0)).is_err());
        delete_transaction(&c, &rm).unwrap();
        assert!(get_register(&c, &roll).unwrap().iter().all(|r| r.id != add));
        let p = lots::portfolio(&c, Some(&ira), "2025-12-31").unwrap();
        assert_eq!(p.positions[0].shares_micro, 200 * lots::MICRO, "the shares are back where they were");
    }

    // "Pay from" can change after entry.
    #[test]
    fn a_buys_funding_account_can_be_changed_removed_and_added_after_entry() {
        let db = TestDb::new("inv-refund");
        let c = db.conn();
        let chk = create_account(&c, "Checking", "checking", 1_000_000, Some("2025-01-01")).unwrap().id;
        let sav = create_account(&c, "Savings", "savings", 500_000, Some("2025-01-01")).unwrap().id;
        let acct = inv_account(&c, "Brokerage", "investment");
        let sec = create_security(&c, "Fund", "FUND", "etf", None).unwrap();
        let mut t = inv(&acct, "2025-02-01", "buy", &sec.id, 10 * lots::MICRO, 100_000);
        t.funding_account_id = Some(chk.clone());
        let buy = create_investment_transaction(&c, &t).unwrap();
        let reg = get_register(&c, &acct).unwrap();
        let row = reg.iter().find(|r| r.id == buy).unwrap();
        assert_eq!(row.funding_account_id.as_deref(), Some(chk.as_str()), "the register says where the cash came from");
        assert_eq!(funding_account_of(&c, &buy).unwrap().as_deref(), Some(chk.as_str()));
        let bal = |id: &str| get_account(&c, id).unwrap().balance_cents;
        assert_eq!((bal(&chk), bal(&sav), bal(&acct)), (900_000, 500_000, 0));

        // Oops — it was Savings. Checking gets its money back; Savings pays.
        t.funding_account_id = Some(sav.clone());
        update_investment_transaction(&c, &buy, &t).unwrap();
        assert_eq!((bal(&chk), bal(&sav), bal(&acct)), (1_000_000, 400_000, 0));
        assert_eq!(funding_account_of(&c, &buy).unwrap().as_deref(), Some(sav.as_str()));
        // Exactly one funding pair exists: two cash rows, linked.
        let pairs: i64 = c.query_row("SELECT count(*) FROM transactions WHERE activity IS NULL AND transfer_id IS NOT NULL AND account_id IN (?1, ?2, ?3)", params![chk, sav, acct], |r| r.get(0)).unwrap();
        assert_eq!(pairs, 2);

        // A changed amount rewrites the pair at the new amount.
        t.gross_cents = 120_000;
        update_investment_transaction(&c, &buy, &t).unwrap();
        assert_eq!((bal(&chk), bal(&sav), bal(&acct)), (1_000_000, 380_000, 0));

        // No funding: the pair goes, the brokerage paid from its own cash.
        t.funding_account_id = None;
        update_investment_transaction(&c, &buy, &t).unwrap();
        assert_eq!((bal(&chk), bal(&sav), bal(&acct)), (1_000_000, 500_000, -120_000));
        assert!(funding_account_of(&c, &buy).unwrap().is_none());
        let pairs: i64 = c.query_row("SELECT count(*) FROM transactions WHERE activity IS NULL AND transfer_id IS NOT NULL", [], |r| r.get(0)).unwrap();
        assert_eq!(pairs, 0);

        // And back on: a buy that had none gets a pair.
        t.funding_account_id = Some(chk.clone());
        update_investment_transaction(&c, &buy, &t).unwrap();
        assert_eq!((bal(&chk), bal(&sav), bal(&acct)), (880_000, 500_000, 0));
        // The shares never moved through any of it.
        let pf = lots::portfolio(&c, Some(&acct), "2025-12-31").unwrap();
        assert_eq!(pf.positions[0].shares_micro, 10 * lots::MICRO);
        assert_eq!(pf.positions[0].cost_cents, 120_000);
        // Deleting the buy takes its funding pair with it — Checking
        // gets the $1,200 back; nothing is left in either register.
        delete_transaction(&c, &buy).unwrap();
        assert_eq!((bal(&chk), bal(&acct)), (1_000_000, 0));
        let pairs: i64 = c.query_row("SELECT count(*) FROM transactions WHERE activity IS NULL AND transfer_id IS NOT NULL", [], |r| r.get(0)).unwrap();
        assert_eq!(pairs, 0);

        // A buy from before 0027 — same shape, no link — is found by its pair's
        // shape, so changing its account does not leave the old transfer behind.
        let mut t2 = inv(&acct, "2025-05-01", "buy", &sec.id, 5 * lots::MICRO, 50_000);
        t2.funding_account_id = Some(chk.clone());
        let old = create_investment_transaction(&c, &t2).unwrap();
        c.execute("UPDATE transactions SET funding_txn_id = NULL WHERE id = ?1", params![old]).unwrap();
        assert_eq!(bal(&chk), 950_000);
        t2.funding_account_id = Some(sav.clone());
        update_investment_transaction(&c, &old, &t2).unwrap();
        assert_eq!((bal(&chk), bal(&sav)), (1_000_000, 450_000), "Checking got its money back; Savings paid");
        let pairs: i64 = c.query_row("SELECT count(*) FROM transactions WHERE activity IS NULL AND transfer_id IS NOT NULL AND date = '2025-05-01'", [], |r| r.get(0)).unwrap();
        assert_eq!(pairs, 2, "one pair, not two");

        // Deleting the buy takes its funding pair with it — Savings gets
        // its $500 back and no orphan transfer is left in either register.
        delete_transaction(&c, &old).unwrap();
        assert_eq!((bal(&chk), bal(&sav), bal(&acct)), (1_000_000, 500_000, 0));
        let pairs: i64 = c.query_row("SELECT count(*) FROM transactions WHERE activity IS NULL AND transfer_id IS NOT NULL AND date = '2025-05-01'", [], |r| r.get(0)).unwrap();
        assert_eq!(pairs, 0, "the funding pair went with the buy");
    }

    // A dividend paid out to the bank is one entry.
    #[test]
    fn a_dividend_can_be_deposited_to_another_account_but_a_reinvestment_cannot() {
        let db = TestDb::new("inv-div-sweep");
        let c = db.conn();
        let chk = create_account(&c, "Checking", "checking", 100_000, Some("2025-01-01")).unwrap().id;
        let acct = inv_account(&c, "Brokerage", "investment");
        let sec = create_security(&c, "MUB", "MUB", "etf", None).unwrap();
        create_investment_transaction(&c, &inv(&acct, "2025-02-01", "buy", &sec.id, 10 * lots::MICRO, 100_000)).unwrap();
        let bal = |id: &str| get_account(&c, id).unwrap().balance_cents;
        assert_eq!(bal(&acct), -100_000);
        let mut div = inv(&acct, "2025-03-15", "dividend", &sec.id, 0, 290);
        div.funding_account_id = Some(chk.clone());
        let d = create_investment_transaction(&c, &div).unwrap();
        // The dividend lands in the brokerage and leaves for Checking in the same breath.
        assert_eq!((bal(&acct), bal(&chk)), (-100_000, 100_290));
        assert_eq!(funding_account_of(&c, &d).unwrap().as_deref(), Some(chk.as_str()));
        // Income reports still see the dividend.
        let inc = crate::db::reports::run_report(&c, &crate::models::ReportRequest {
            kind: "investment_income".into(), from: "2025-01-01".into(), to: "2025-12-31".into(),
            account_ids: None, category_ids: None, compare_from: None, compare_to: None, detail: None, security_ids: None, tax_scope: None, ..Default::default()
        }).unwrap();
        assert!(inc.rows.iter().any(|r| r.cells.iter().any(|x| x.cents == Some(290))), "{:?}", inc.rows.iter().map(|r| &r.label).collect::<Vec<_>>());
        // Taking the sweep off leaves the cash in the brokerage.
        div.funding_account_id = None;
        update_investment_transaction(&c, &d, &div).unwrap();
        assert_eq!((bal(&acct), bal(&chk)), (-99_710, 100_000));
        // A reinvested dividend moves no cash, so it cannot name an account.
        let mut re = inv(&acct, "2025-06-15", "reinvest_dividend", &sec.id, 25_000, 290);
        re.price_micro = Some(116 * lots::MICRO);
        re.funding_account_id = Some(chk.clone());
        assert!(create_investment_transaction(&c, &re).is_err());
    }

    #[test]
    fn migration_0028_links_old_buys_to_their_funding_pairs_when_unambiguous() {
        let db = TestDb::new("inv-backfill");
        let c = db.conn();
        let chk = create_account(&c, "Checking", "checking", 1_000_000, Some("2025-01-01")).unwrap().id;
        let acct = inv_account(&c, "Brokerage", "investment");
        let sec = create_security(&c, "Fund", "FUND", "etf", None).unwrap();
        let mut t = inv(&acct, "2025-02-01", "buy", &sec.id, 10 * lots::MICRO, 100_000);
        t.funding_account_id = Some(chk.clone());
        let one = create_investment_transaction(&c, &t).unwrap();
        // Two identical buys on one day: ambiguous, left unlinked.
        let mut t2 = inv(&acct, "2025-03-01", "buy", &sec.id, 3 * lots::MICRO, 30_000);
        t2.funding_account_id = Some(chk.clone());
        let twin_a = create_investment_transaction(&c, &t2).unwrap();
        let twin_b = create_investment_transaction(&c, &t2).unwrap();
        c.execute("UPDATE transactions SET funding_txn_id = NULL", []).unwrap();
        let sql = crate::db::migrations::MIGRATIONS.iter().find(|m| m.0 == "0028").unwrap().2;
        c.execute_batch(sql).unwrap();
        assert_eq!(funding_account_of(&c, &one).unwrap().as_deref(), Some(chk.as_str()));
        assert!(funding_account_of(&c, &twin_a).unwrap().is_none());
        assert!(funding_account_of(&c, &twin_b).unwrap().is_none());
    }

    #[test]
    fn a_funded_buy_writes_the_transfer_and_prices_value_the_account_by_date() {
        let db = TestDb::new("inv-fund");
        let c = db.conn();
        let chk = create_account(&c, "Checking", "checking", 1_000_000, Some("2025-01-01")).unwrap().id;
        let acct = inv_account(&c, "Brokerage", "investment");
        let sec = create_security(&c, "Fund", "FUND", "etf", None).unwrap();
        let mut t = inv(&acct, "2025-02-01", "buy", &sec.id, 10 * lots::MICRO, 100_000);
        t.funding_account_id = Some(chk.clone());
        create_investment_transaction(&c, &t).unwrap();
        // Checking is down by the buy; the brokerage's cash is back to zero
        // (the transfer in, the buy out); the shares are the account's worth.
        assert_eq!(get_account(&c, &chk).unwrap().balance_cents, 900_000);
        let b = get_account(&c, &acct).unwrap();
        assert_eq!(b.balance_cents, 0);
        assert_eq!(b.holdings_value_cents, 100_000, "no later price: valued at cost");
        set_security_price(&c, &sec.id, "2025-06-30", 150 * lots::MICRO, "manual").unwrap();
        assert_eq!(get_account(&c, &acct).unwrap().holdings_value_cents, 150_000);
        // A quote beats an inference on the same day; an inference never overwrites a quote.
        set_security_price(&c, &sec.id, "2025-06-30", 160 * lots::MICRO, "transaction").unwrap();
        assert_eq!(lots::price_asof(&c, &sec.id, "2025-06-30").unwrap().unwrap().0, 150 * lots::MICRO);
        // Net worth on a date uses the price of that date, not today's.
        let nw = |asof: &str| {
            crate::db::reports::run_report(&c, &crate::models::ReportRequest {
                kind: "net_worth".into(), from: asof.into(), to: asof.into(),
                account_ids: None, category_ids: None, compare_from: None, compare_to: None, detail: None, security_ids: None, tax_scope: None, ..Default::default()
            }).unwrap().rows.last().unwrap().cells[0].cents.unwrap()
        };
        assert_eq!(nw("2025-01-31"), 1_000_000);
        assert_eq!(nw("2025-03-31"), 1_000_000, "bought at cost, valued at cost");
        assert_eq!(nw("2025-07-31"), 1_050_000);
        // The register's uncategorized filter is the frontend's, but the
        // category reports must not see the buy as spending.
        let sp = crate::db::reports::run_report(&c, &crate::models::ReportRequest {
            kind: "spending_by_category".into(), from: "2025-01-01".into(), to: "2025-12-31".into(),
            account_ids: None, category_ids: None, compare_from: None, compare_to: None, detail: None, security_ids: None, tax_scope: None, ..Default::default()
        }).unwrap();
        // The buy must not appear as 100,000 of uncategorized spending (the
        // spending report leaves income out, so the opening balance's
        // uncategorized 1,000,000 is not on it either — nothing is).
        let uncategorized: Vec<i64> = sp.rows.iter().filter(|r| r.label == "Uncategorized").map(|r| r.cells[0].cents.unwrap()).collect();
        assert_eq!(uncategorized, Vec::<i64>::new(), "{:?}", sp.rows.iter().map(|r| (&r.label, r.cells.first().and_then(|c| c.cents))).collect::<Vec<_>>());
        assert_eq!(sp.rows.iter().find(|r| r.label == "Total spending").unwrap().cells[0].cents, Some(0));
    }

    #[test]
    fn securities_named_by_their_ticker_get_it_as_the_symbol() {
        assert!(ticker_like("MUB"));
        assert!(ticker_like("VTSAX"));
        assert!(ticker_like("BRK.B"));
        assert!(ticker_like("BF-B"));
        assert!(ticker_like("F"));
        assert!(!ticker_like("Vanguard Total Market"));
        assert!(!ticker_like("mub"));
        assert!(!ticker_like("ABCDEFG"));
        assert!(!ticker_like("A.B.C"));
        assert!(!ticker_like("123"));
        assert!(!ticker_like(""));

        let db = TestDb::new("sym-fill");
        let conn = db.conn();
        create_security(&conn, "MUB", "", "etf", None).unwrap();
        create_security(&conn, "Vanguard Total Market", "", "mutual_fund", None).unwrap();
        create_security(&conn, "AAPL", "aapl", "stock", None).unwrap();
        assert_eq!(fill_symbols_from_names(&conn).unwrap(), 1);
        let by_name = |n: &str| {
            list_securities(&conn).unwrap().into_iter().find(|s| s.name == n).unwrap().symbol
        };
        assert_eq!(by_name("MUB"), "MUB");
        assert_eq!(by_name("Vanguard Total Market"), "");
        assert_eq!(by_name("AAPL"), "AAPL");
        assert_eq!(fill_symbols_from_names(&conn).unwrap(), 0);
    }

    // A TSP reallocation is an exchange within the account: the lots
    // that left one fund arrive in the other with their basis and dates, and
    // nothing is realized on the way. Written as a Sell and a Buy it booked a
    // gain inside a tax-deferred plan and made the basis that day's price.
    #[test]
    fn an_exchange_within_an_account_carries_basis_and_dates_across_funds() {
        use crate::import::tsp::{REALLOC_IN, REALLOC_OUT};
        let db = TestDb::new("exchange");
        let c = db.conn();
        let acct = inv_account(&c, "TSP", "retirement");
        let g = create_security(&c, "TSP G Fund", "TSPG", "mutual_fund", None).unwrap();
        let i = create_security(&c, "TSP I Fund", "TSPI", "mutual_fund", None).unwrap();
        // Two contributions into G: 100 shares at $10 in 2024, 100 at $20 in 2025.
        create_investment_transaction(&c, &inv(&acct, "2024-01-10", "buy", &g.id, 100 * lots::MICRO, 100_000)).unwrap();
        create_investment_transaction(&c, &inv(&acct, "2025-01-10", "buy", &g.id, 100 * lots::MICRO, 200_000)).unwrap();
        // Everything moves to I: 200 G out worth $5,000, 250 I in worth $5,000.
        // The TSP lists the in-row FIRST on such a day (the import orders adds
        // before removes), which is exactly why the in-rows wait for the day to end.
        let mut into = inv(&acct, "2026-03-01", "add_shares", &i.id, 250 * lots::MICRO, 500_000);
        into.notes = Some(REALLOC_IN.into());
        let in_id = create_investment_transaction(&c, &into).unwrap();
        let mut out = inv(&acct, "2026-03-01", "remove_shares", &g.id, 200 * lots::MICRO, 500_000);
        out.notes = Some(REALLOC_OUT.into());
        let out_id = create_investment_transaction(&c, &out).unwrap();

        // Unlinked they are a plain Remove and Add: I is "bought" today at $5,000.
        let l = lots::replay(&c, Some(&acct), None, None).unwrap();
        assert_eq!(l.lots.iter().map(|x| x.cost_cents).sum::<i64>(), 500_000);

        assert_eq!(link_same_day_exchanges(&c, &acct, REALLOC_OUT, REALLOC_IN).unwrap(), 2);
        assert_eq!(link_same_day_exchanges(&c, &acct, REALLOC_OUT, REALLOC_IN).unwrap(), 0, "linking again does nothing");
        let l = lots::replay(&c, Some(&acct), None, None).unwrap();
        assert!(l.problems.is_empty(), "{:?}", l.problems);
        let i_lots: Vec<&crate::models::Lot> = l.lots.iter().filter(|x| x.security_id == i.id).collect();
        assert_eq!(i_lots.len(), 2, "one lot per contribution, still: {:?}", l.lots);
        assert_eq!(i_lots.iter().map(|x| x.shares_micro).sum::<i64>(), 250 * lots::MICRO);
        assert_eq!(i_lots.iter().map(|x| x.cost_cents).sum::<i64>(), 300_000, "the basis is what was paid in, not the day's price");
        assert_eq!((i_lots[0].acquired_on.as_str(), i_lots[0].cost_cents), ("2024-01-10", 100_000));
        assert_eq!((i_lots[1].acquired_on.as_str(), i_lots[1].cost_cents), ("2025-01-10", 200_000));
        // The new shares follow the VALUE each lot had on the way out — the
        // same 100 shares of G at the same NAV, so half each — and each keeps
        // its own cost: the 2024 lot is up 150%, the 2025 lot 25%. Spreading
        // by cost would have given both the same cost per share and hidden
        // which was which.
        assert_eq!(i_lots[0].shares_micro, 125 * lots::MICRO);
        assert_eq!(i_lots[1].shares_micro, 125 * lots::MICRO);
        assert!(l.lots.iter().all(|x| x.security_id != g.id), "G is empty");
        assert!(lots::realized(&c, Some(&acct), "2026-01-01", "2026-12-31").unwrap().is_empty(), "an exchange realizes nothing");
        // Selling I later sells the ORIGINAL lots: the 2024 one is long-term.
        let sell = create_investment_transaction(&c, &inv(&acct, "2026-06-01", "sell", &i.id, 250 * lots::MICRO, 750_000)).unwrap();
        let d = disposals_for(&c, &sell).unwrap();
        assert_eq!(d.iter().map(|x| x.cost_cents).sum::<i64>(), 300_000);
        assert_eq!(d.iter().map(|x| x.gain_cents).sum::<i64>(), 450_000);
        assert!(d.iter().all(|x| x.long_term), "held since 2024 and 2025: {d:?}");
        // The register calls both halves an exchange, and cash never moved for it.
        let reg = get_register(&c, &acct).unwrap();
        for id in [&out_id, &in_id] {
            let r = reg.iter().find(|r| &r.id == id).unwrap();
            assert!(r.is_exchange, "{id} is an exchange");
            assert_eq!(r.transfer_account_id.as_deref(), Some(acct.as_str()));
            assert_eq!(r.amount_cents, 0);
        }
        assert_eq!(get_account(&c, &acct).unwrap().balance_cents, -300_000 + 750_000);
    }

    #[test]
    fn a_reallocation_across_several_funds_splits_the_basis_by_the_value_each_took() {
        use crate::import::tsp::{REALLOC_IN, REALLOC_OUT};
        let db = TestDb::new("exchange2");
        let c = db.conn();
        let acct = inv_account(&c, "TSP", "retirement");
        let g = create_security(&c, "TSP G Fund", "TSPG", "mutual_fund", None).unwrap();
        let cf = create_security(&c, "TSP C Fund", "TSPC", "mutual_fund", None).unwrap();
        let i = create_security(&c, "TSP I Fund", "TSPI", "mutual_fund", None).unwrap();
        let s = create_security(&c, "TSP S Fund", "TSPS", "mutual_fund", None).unwrap();
        create_investment_transaction(&c, &inv(&acct, "2024-01-10", "buy", &g.id, 100 * lots::MICRO, 100_000)).unwrap();
        create_investment_transaction(&c, &inv(&acct, "2025-01-10", "buy", &cf.id, 100 * lots::MICRO, 300_000)).unwrap();
        // G and C out, $5,000 each; I takes $6,000 of it, S $4,000.
        let row = |date: &str, activity: &str, sec: &str, shares: i64, gross: i64, memo: &str| {
            let mut t = inv(&acct, date, activity, sec, shares, gross);
            t.notes = Some(memo.into());
            create_investment_transaction(&c, &t).unwrap()
        };
        row("2026-03-01", "remove_shares", &g.id, 100 * lots::MICRO, 500_000, REALLOC_OUT);
        row("2026-03-01", "remove_shares", &cf.id, 100 * lots::MICRO, 500_000, REALLOC_OUT);
        row("2026-03-01", "add_shares", &i.id, 300 * lots::MICRO, 600_000, REALLOC_IN);
        row("2026-03-01", "add_shares", &s.id, 100 * lots::MICRO, 400_000, REALLOC_IN);
        assert_eq!(link_same_day_exchanges(&c, &acct, REALLOC_OUT, REALLOC_IN).unwrap(), 4);
        let l = lots::replay(&c, Some(&acct), None, None).unwrap();
        assert!(l.problems.is_empty(), "{:?}", l.problems);
        let cost_of = |sec: &str| l.lots.iter().filter(|x| x.security_id == sec).map(|x| x.cost_cents).sum::<i64>();
        let shares_of = |sec: &str| l.lots.iter().filter(|x| x.security_id == sec).map(|x| x.shares_micro).sum::<i64>();
        // 60% of every lot's basis went to I, 40% to S — the whole $4,000 is still there.
        assert_eq!(cost_of(&i.id), 60_000 + 180_000);
        assert_eq!(cost_of(&s.id), 40_000 + 120_000);
        assert_eq!(cost_of(&i.id) + cost_of(&s.id), 400_000);
        assert_eq!((shares_of(&i.id), shares_of(&s.id)), (300 * lots::MICRO, 100 * lots::MICRO));
        assert_eq!((shares_of(&g.id), shares_of(&cf.id)), (0, 0));
        // Within each fund the shares split by the value that came from G
        // and from C — equal here — so the cheap G lot (cost $1,000 for
        // $5,000 of value) and the dear C lot ($3,000 for $5,000) each hold
        // half the shares and keep their own cost per share.
        let by_date = |sec: &str, date: &str| l.lots.iter().find(|x| x.security_id == sec && x.acquired_on == date).map(|x| (x.shares_micro, x.cost_cents)).unwrap();
        assert_eq!(by_date(&i.id, "2024-01-10"), (150 * lots::MICRO, 60_000));
        assert_eq!(by_date(&i.id, "2025-01-10"), (150 * lots::MICRO, 180_000));
        assert_eq!(by_date(&s.id, "2024-01-10"), (50 * lots::MICRO, 40_000));
        assert_eq!(by_date(&s.id, "2025-01-10"), (50 * lots::MICRO, 120_000));
        // Each fund holds a 2024 lot and a 2025 lot.
        for sec in [&i.id, &s.id] {
            let mut dates: Vec<&str> = l.lots.iter().filter(|x| &x.security_id == sec).map(|x| x.acquired_on.as_str()).collect();
            dates.sort();
            assert_eq!(dates, vec!["2024-01-10", "2025-01-10"]);
        }
    }

    // Migration 0042 turns the Sell/Buy pairs an earlier import wrote
    // into the linked exchange they should have been, without moving cash.
    #[test]
    fn migration_0042_turns_imported_reallocation_sells_and_buys_into_a_linked_exchange() {
        use crate::import::tsp::{REALLOC_IN, REALLOC_OUT};
        let db = TestDb::new("m0042");
        let c = db.conn();
        let acct = inv_account(&c, "TSP", "retirement");
        let g = create_security(&c, "TSP G Fund", "TSPG", "mutual_fund", None).unwrap();
        let i = create_security(&c, "TSP I Fund", "TSPI", "mutual_fund", None).unwrap();
        create_investment_transaction(&c, &inv(&acct, "2024-01-10", "buy", &g.id, 100 * lots::MICRO, 100_000)).unwrap();
        let mut sell = inv(&acct, "2026-03-01", "sell", &g.id, 100 * lots::MICRO, 250_000);
        sell.notes = Some(REALLOC_OUT.into());
        let sell_id = create_investment_transaction(&c, &sell).unwrap();
        let mut buy = inv(&acct, "2026-03-01", "buy", &i.id, 125 * lots::MICRO, 250_000);
        buy.notes = Some(REALLOC_IN.into());
        let buy_id = create_investment_transaction(&c, &buy).unwrap();
        let before = get_account(&c, &acct).unwrap().balance_cents;
        assert_eq!(before, -100_000, "the day nets to zero");
        assert!(!lots::realized(&c, Some(&acct), "2026-01-01", "2026-12-31").unwrap().is_empty(), "as a sale it realized a gain");

        let sql = crate::db::migrations::MIGRATIONS.iter().find(|m| m.0 == "0042").expect("0042").2;
        c.execute_batch(sql).unwrap();

        let reg = get_register(&c, &acct).unwrap();
        let s = reg.iter().find(|r| r.id == sell_id).unwrap();
        let b = reg.iter().find(|r| r.id == buy_id).unwrap();
        assert_eq!((s.activity.as_deref(), s.amount_cents, s.is_exchange), (Some("remove_shares"), 0, true));
        assert_eq!((b.activity.as_deref(), b.amount_cents, b.is_exchange), (Some("add_shares"), 0, true));
        assert_eq!(get_account(&c, &acct).unwrap().balance_cents, before, "cash is where it was");
        assert!(lots::realized(&c, Some(&acct), "2026-01-01", "2026-12-31").unwrap().is_empty(), "nothing realized any more");
        let l = lots::replay(&c, Some(&acct), None, None).unwrap();
        assert_eq!(l.lots.len(), 1);
        assert_eq!((l.lots[0].security_id.as_str(), l.lots[0].acquired_on.as_str(), l.lots[0].cost_cents, l.lots[0].shares_micro), (i.id.as_str(), "2024-01-10", 100_000, 125 * lots::MICRO));
        assert!(verify_file(&c, false).unwrap().drift.is_empty());
        // Running it again changes nothing.
        c.execute_batch(sql).unwrap();
        assert_eq!(get_register(&c, &acct).unwrap().iter().filter(|r| r.is_exchange).count(), 2);
    }

    // A TSP contribution imported through the QIF path gets its cash
    // side when the importer supplies what its own memos mean.
    #[test]
    fn a_tsp_contribution_buy_arrives_with_its_cash_side_when_the_memo_rules_are_supplied() {
        let db = TestDb::new("tsp-cash");
        let c = db.conn();
        let plan = inv_account(&c, "TSP", "retirement");
        let plain = inv_account(&c, "Other plan", "retirement");
        let qif = "!Type:Invst\nD09/03/2026\nNBuy\nYTSP G Fund\nI20.0000\nQ10.000000\nT200.00\nMTSP Traditional payroll deferral\n^\n";
        let path = db.dir.join("contrib.qif");
        std::fs::write(&path, qif).unwrap();
        drop(c);
        let rules = crate::import::tsp::contribution_rules();
        assert_eq!(rules.len(), 4, "three contribution memos and the payroll loan repayment");
        crate::import::import_file_with_rules(&db.pool, &path.to_string_lossy(), &plan, &rules).unwrap();
        crate::import::import_file(&db.pool, &path.to_string_lossy(), &plain).unwrap();
        let c = db.conn();
        // With the rules: the buy and a deposit for the same money, so the
        // plan's cash nets to zero and the contribution is a reportable row.
        assert_eq!(get_account(&c, &plan).unwrap().balance_cents, 0);
        let reg = get_register(&c, &plan).unwrap();
        let cash = reg.iter().find(|r| r.activity.is_none()).expect("the cash side");
        assert_eq!((cash.amount_cents, cash.category_name.as_deref()), (20_000, Some("Retirement Contributions")));
        // Without them (every older import): the buy alone, cash drifting negative.
        assert_eq!(get_account(&c, &plain).unwrap().balance_cents, -20_000);
    }

    // Migration 0044 writes that cash side for the contributions an
    // earlier import left bare, once, and links each buy to its deposit.
    #[test]
    fn migration_0044_gives_bare_tsp_contribution_buys_their_cash_side_once() {
        let db = TestDb::new("m0044");
        let c = db.conn();
        let plan = inv_account(&c, "TSP", "retirement");
        let g = create_security(&c, "TSP G Fund", "TSPG", "mutual_fund", None).unwrap();
        let mut buy = inv(&plan, "2026-09-03", "buy", &g.id, 10 * lots::MICRO, 20_000);
        buy.notes = Some("TSP Agency Match employer contribution".into());
        let buy_id = create_investment_transaction(&c, &buy).unwrap();
        // A buy that is NOT a contribution — bought with the plan's own cash — is left alone.
        let mut other = inv(&plan, "2026-09-04", "buy", &g.id, 5 * lots::MICRO, 10_000);
        other.notes = Some("TSP reallocation into fund".into());
        create_investment_transaction(&c, &other).unwrap();
        assert_eq!(get_account(&c, &plan).unwrap().balance_cents, -30_000);

        let sql = crate::db::migrations::MIGRATIONS.iter().find(|m| m.0 == "0044").expect("0044").2;
        c.execute_batch(sql).unwrap();
        assert_eq!(get_account(&c, &plan).unwrap().balance_cents, -10_000, "the contribution's cash arrived; the other buy still spent cash");
        let reg = get_register(&c, &plan).unwrap();
        let cash = reg.iter().find(|r| r.id == format!("ctb-{buy_id}")).expect("the deposit, keyed by the buy");
        assert_eq!((cash.amount_cents, cash.category_name.as_deref(), cash.payee.as_str()), (20_000, Some("Retirement Contributions"), "TSP Agency Match employer contribution"));
        let funding: Option<String> = c.query_row("SELECT funding_txn_id FROM transactions WHERE id = ?1", params![buy_id], |r| r.get(0)).unwrap();
        assert_eq!(funding.as_deref(), Some(format!("ctb-{buy_id}").as_str()));
        assert!(verify_file(&c, false).unwrap().drift.is_empty());
        // Again: nothing more.
        c.execute_batch(sql).unwrap();
        assert_eq!(get_account(&c, &plan).unwrap().balance_cents, -10_000);
        assert_eq!(get_register(&c, &plan).unwrap().len(), 3);
    }

    // Valuing on many days is one replay, and it agrees with the
    // portfolio on every one of them; and one fund can be looked at alone,
    // its edge being what it was bought and sold for.
    #[test]
    fn performance_values_many_days_in_one_pass_and_can_look_at_one_fund() {
        let db = TestDb::new("perf-fund");
        let c = db.conn();
        let plan = inv_account(&c, "TSP", "retirement");
        let g = create_security(&c, "TSP G Fund", "TSPG", "mutual_fund", None).unwrap();
        let s = create_security(&c, "TSP S Fund", "TSPS", "mutual_fund", None).unwrap();
        create_transaction(&c, &plan, "2026-01-02", "Opening", None, 100_000, None, None).unwrap();
        create_investment_transaction(&c, &inv(&plan, "2026-01-05", "buy", &g.id, 10 * lots::MICRO, 20_000)).unwrap();
        set_security_price(&c, &g.id, "2026-02-05", 22 * lots::MICRO, "manual").unwrap();
        create_investment_transaction(&c, &inv(&plan, "2026-02-05", "buy", &g.id, 10 * lots::MICRO, 22_000)).unwrap();
        create_investment_transaction(&c, &inv(&plan, "2026-02-05", "buy", &s.id, 5 * lots::MICRO, 10_000)).unwrap();
        set_security_price(&c, &g.id, "2026-03-05", 24 * lots::MICRO, "manual").unwrap();
        set_security_price(&c, &s.id, "2026-03-05", 21 * lots::MICRO, "manual").unwrap();
        create_investment_transaction(&c, &inv(&plan, "2026-03-05", "sell", &s.id, 2 * lots::MICRO, 4_200)).unwrap();

        // One pass, five days, the portfolio's own numbers on each.
        let days: Vec<String> = ["2026-01-04", "2026-01-05", "2026-02-05", "2026-02-20", "2026-03-05"].iter().map(|d| d.to_string()).collect();
        let worth = lots::worth_on_dates(&c, Some(&plan), None, &days).unwrap();
        for d in &days {
            let p = lots::portfolio(&c, Some(&plan), d).unwrap();
            assert_eq!(worth[d], p.total_value_cents + p.cash_cents, "worth on {d}");
        }
        assert_eq!(worth["2026-01-04"], 100_000, "cash only");
        assert_eq!(worth["2026-03-05"], 20 * 2_400 + 3 * 2_100 + (100_000 - 20_000 - 22_000 - 10_000 + 4_200));

        // The G fund alone: bought at $20 and $22, worth $24 — the fund's
        // stretches are 10% then 9.09%, 20% together; $6,000 earned on
        // $42,000 put in; the sale of S is not its business.
        let g_days: Vec<String> = ["2026-01-04", "2026-03-05"].iter().map(|d| d.to_string()).collect();
        let gw = lots::worth_on_dates(&c, Some(&plan), Some(&g.id), &g_days).unwrap();
        assert_eq!((gw["2026-01-04"], gw["2026-03-05"]), (0, 48_000), "shares only, no cash");
        let p = lots::performance_between(&c, Some(&plan), Some(&g.id), "2026-01-04", "2026-03-05").unwrap();
        assert_eq!((p.start_value_cents, p.end_value_cents, p.flows_in_cents, p.flows_out_cents, p.gain_cents, p.flow_days), (0, 48_000, 42_000, 0, 6_000, 2));
        // 1.1 x 1.0909... chained in fixed point lands a basis point under 20%.
        assert!((1_999..=2_000).contains(&p.twr_bps.unwrap()), "{:?}", p.twr_bps);
        assert!(p.mwr_annual_bps.is_none(), "two months is not put on a yearly footing");
        // S alone: $10,000 in, $4,200 out, 3 shares at $21 = $6,300 left: $500 earned.
        let q = lots::performance_between(&c, Some(&plan), Some(&s.id), "2026-01-04", "2026-03-05").unwrap();
        assert_eq!((q.flows_in_cents, q.flows_out_cents, q.end_value_cents, q.gain_cents), (10_000, 4_200, 6_300, 500));
        // The table for one fund starts from the fund's first row.
        let table = lots::performance(&c, Some(&plan), Some(&s.id), "2026-03-05").unwrap();
        let all = table.iter().find(|r| r.label == "All time").expect("all time");
        assert_eq!(all.from, "2026-02-04");
    }

    // Contributions that came in through the Import QIF dialog
    // already have each one's deposit, under the file's own
    // categories. The migration must see that and write nothing there;
    // only a bare buy gets one. Counted in groups: two equal same-day
    // contributions with one deposit between them get exactly one more.
    #[test]
    fn migration_0044_leaves_a_contribution_that_already_has_its_deposit_alone() {
        let db = TestDb::new("m0044-dialog");
        let c = db.conn();
        let plan = inv_account(&c, "TSP", "retirement");
        let g = create_security(&c, "TSP G Fund", "TSPG", "mutual_fund", None).unwrap();
        let memo = "TSP Traditional payroll deferral";
        let own = ensure_category(&c, "TSP Traditional").unwrap();
        // 1. A contribution the dialog wrote: the buy, and the deposit beside
        //    it — payee is the memo, note is the dialog's, no funding link.
        let mut b1 = inv(&plan, "2026-09-03", "buy", &g.id, 10 * lots::MICRO, 20_000);
        b1.notes = Some(memo.into());
        create_investment_transaction(&c, &b1).unwrap();
        create_transaction(&c, &plan, "2026-09-03", memo, Some(&own), 20_000, Some("Contribution — TSP G Fund"), None).unwrap();
        // 2. Two equal contributions on one day, ONE deposit between them.
        for _ in 0..2 {
            let mut b = inv(&plan, "2026-09-17", "buy", &g.id, 5 * lots::MICRO, 10_000);
            b.notes = Some(memo.into());
            create_investment_transaction(&c, &b).unwrap();
        }
        create_transaction(&c, &plan, "2026-09-17", memo, Some(&own), 10_000, Some("Contribution — TSP G Fund"), None).unwrap();
        // 3. A bare one from the command-line importer.
        let mut b3 = inv(&plan, "2026-10-01", "buy", &g.id, 5 * lots::MICRO, 10_000);
        b3.notes = Some(memo.into());
        let bare = create_investment_transaction(&c, &b3).unwrap();
        assert_eq!(get_account(&c, &plan).unwrap().balance_cents, -20_000, "two deposits short: one of the pair, and the bare one");

        let sql = crate::db::migrations::MIGRATIONS.iter().find(|m| m.0 == "0044").expect("0044").2;
        c.execute_batch(sql).unwrap();
        let reg = get_register(&c, &plan).unwrap();
        assert_eq!(get_account(&c, &plan).unwrap().balance_cents, 0, "the plan's cash nets to zero — not positive");
        assert_eq!(reg.len(), 8, "six rows before, two deposits added: not one per buy");
        assert!(reg.iter().any(|r| r.id == format!("ctb-{bare}")), "the bare buy got its deposit");
        assert_eq!(reg.iter().filter(|r| r.date == "2026-09-03" && r.activity.is_none()).count(), 1, "the dialog's deposit stands alone");
        assert_eq!(reg.iter().filter(|r| r.date == "2026-09-17" && r.activity.is_none()).count(), 2, "the pair now has two deposits");
        assert_eq!(reg.iter().filter(|r| r.category_name.as_deref() == Some("Retirement Contributions")).count(), 2, "only the new ones; the user's categories stand");
        assert!(verify_file(&c, false).unwrap().drift.is_empty());
        c.execute_batch(sql).unwrap();
        assert_eq!(get_register(&c, &plan).unwrap().len(), 8, "again: nothing more");

        // A file whose every contribution already has its deposit: nothing
        // at all — not even the category.
        let db2 = TestDb::new("m0044-nothing");
        let c2 = db2.conn();
        let plan2 = inv_account(&c2, "TSP", "retirement");
        let g2 = create_security(&c2, "TSP G Fund", "TSPG", "mutual_fund", None).unwrap();
        let own2 = ensure_category(&c2, "TSP Traditional").unwrap();
        let mut b = inv(&plan2, "2026-09-03", "buy", &g2.id, 10 * lots::MICRO, 20_000);
        b.notes = Some(memo.into());
        create_investment_transaction(&c2, &b).unwrap();
        create_transaction(&c2, &plan2, "2026-09-03", memo, Some(&own2), 20_000, Some("Contribution — TSP G Fund"), None).unwrap();
        let before = get_register(&c2, &plan2).unwrap().len();
        c2.execute_batch(sql).unwrap();
        assert_eq!(get_register(&c2, &plan2).unwrap().len(), before);
        assert_eq!(get_account(&c2, &plan2).unwrap().balance_cents, 0);
        let n: i64 = c2.query_row("SELECT COUNT(*) FROM categories WHERE name = 'Retirement Contributions'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "no category for nothing");
    }

    // The time-weighted return is the investments'; the money-weighted
    // return is the investor's. Money that crossed the account's edge is a
    // flow; a fee paid from cash is a cost; a dividend paid in cash is return.
    #[test]
    fn performance_chains_growth_between_flows_and_discounts_them_for_the_investor() {
        let db = TestDb::new("perf");
        let c = db.conn();
        let chk = account(&c, "Checking", 5_000_000);
        let ira = inv_account(&c, "IRA", "retirement");
        let fund = create_security(&c, "Index Fund", "IDX", "mutual_fund", None).unwrap();
        // $10,000 in on 5 Jan, all of it into the fund at $100 the next day.
        create_transfer(&c, &chk, &ira, "2026-01-05", 1_000_000, None).unwrap();
        create_investment_transaction(&c, &inv(&ira, "2026-01-06", "buy", &fund.id, 100 * lots::MICRO, 1_000_000)).unwrap();
        set_security_price(&c, &fund.id, "2026-01-06", 100_000_000, "manual").unwrap();
        // Up 10% by midsummer; another $10,000 arrives and sits in cash.
        set_security_price(&c, &fund.id, "2026-06-30", 110_000_000, "manual").unwrap();
        create_transfer(&c, &chk, &ira, "2026-07-01", 1_000_000, None).unwrap();
        // Up another 10% by year end.
        set_security_price(&c, &fund.id, "2026-12-31", 121_000_000, "manual").unwrap();

        let p = lots::performance_between(&c, Some(&ira), None, "2025-12-31", "2026-12-31").unwrap();
        assert_eq!((p.start_value_cents, p.end_value_cents), (0, 1_210_000 + 1_000_000));
        assert_eq!((p.flows_in_cents, p.flows_out_cents, p.flow_days), (2_000_000, 0, 2));
        assert_eq!(p.gain_cents, 210_000, "what the investments earned, in dollars");
        // Time-weighted: 1.10 (the fund, Jan–Jun) × 1.0524 (the whole account,
        // half of it idle cash, Jul–Dec) − 1 = 15.76%.
        assert_eq!(p.twr_bps, Some(1_576));
        let annual = p.twr_annual_bps.expect("a year is long enough to annualize");
        assert!((1_570..=1_600).contains(&annual), "≈15.8% a year over a year: {annual}");
        // Money-weighted: the second $10,000 earned nothing for six months, so
        // the investor's rate is below the investments': well under 15.8%,
        // and comfortably above the 10.5% of the whole-account second half.
        let mwr = p.mwr_annual_bps.expect("a rate exists");
        assert!(mwr < annual && mwr > 1_050, "money-weighted {mwr} vs time-weighted {annual}");

        // A fee paid from cash is a cost inside the return, not money out;
        // a dividend paid in cash is return, not money in.
        let fees = ensure_category(&c, "Investment Fees").unwrap();
        c.execute("UPDATE categories SET kind = 'expense' WHERE id = ?1", params![fees]).unwrap();
        create_transaction(&c, &ira, "2026-12-15", "Custodian", Some(&fees), -5_000, None, None).unwrap();
        create_category(&c, "Dividend Income", "income", None, None).ok();
        create_investment_transaction(&c, &inv(&ira, "2026-12-20", "dividend", &fund.id, 0, 20_000)).unwrap();
        let q = lots::performance_between(&c, Some(&ira), None, "2025-12-31", "2026-12-31").unwrap();
        assert_eq!((q.flows_in_cents, q.flows_out_cents), (2_000_000, 0), "neither the fee nor the dividend is a flow");
        assert_eq!(q.gain_cents, 210_000 - 5_000 + 20_000);

        // The periods table: a fresh account has nothing before its first row.
        let table = lots::performance(&c, Some(&ira), None, "2026-12-31").unwrap();
        let labels: Vec<&str> = table.iter().map(|t| t.label.as_str()).collect();
        assert_eq!(labels, vec!["Past month", "Year to date", "12 months", "3 years", "All time"]);
        let all = table.iter().find(|t| t.label == "All time").unwrap();
        assert_eq!(all.from, "2026-01-04");
        // A period under a year is not annualized: not a week, and not eleven months.
        let week = lots::performance_between(&c, Some(&ira), None, "2026-12-24", "2026-12-31").unwrap();
        assert!(week.twr_annual_bps.is_none() && week.mwr_annual_bps.is_none());
        let eleven = lots::performance_between(&c, Some(&ira), None, "2026-01-31", "2026-12-31").unwrap();
        assert!(eleven.twr_bps.is_some() && eleven.twr_annual_bps.is_none() && eleven.mwr_annual_bps.is_none());
        // The whole file sees the transfers between its own accounts net to
        // nothing: checking is not an investment account, so here they are
        // flows; between two investment accounts they would not be.
        let ira2 = inv_account(&c, "Roth", "retirement");
        create_transfer(&c, &ira, &ira2, "2026-12-28", 100_000, None).unwrap();
        let whole = lots::performance_between(&c, None, None, "2026-12-27", "2026-12-31").unwrap();
        assert_eq!((whole.flows_in_cents, whole.flows_out_cents), (0, 0), "a move between two plans is not money from outside");
    }

    // ── Deleting and voiding a reallocation ──────────────────────────────

    /// The 2-out/2-in reallocation, deleted and voided from its second
    /// in-row. Its link names the FIRST fund's out-row, which another in-row
    /// also points at: the delete failed the foreign key, and the void voided
    /// a row from a different fund.
    #[test]
    fn a_reallocation_is_deleted_and_voided_as_one_days_exchange() {
        use crate::import::tsp::{REALLOC_IN, REALLOC_OUT};
        let db = TestDb::new("exchange-delete");
        let c = db.conn();
        let acct = inv_account(&c, "TSP", "retirement");
        let g = create_security(&c, "TSP G Fund", "TSPG", "mutual_fund", None).unwrap();
        let cf = create_security(&c, "TSP C Fund", "TSPC", "mutual_fund", None).unwrap();
        let i = create_security(&c, "TSP I Fund", "TSPI", "mutual_fund", None).unwrap();
        let s = create_security(&c, "TSP S Fund", "TSPS", "mutual_fund", None).unwrap();
        create_investment_transaction(&c, &inv(&acct, "2024-01-10", "buy", &g.id, 100 * lots::MICRO, 100_000)).unwrap();
        create_investment_transaction(&c, &inv(&acct, "2025-01-10", "buy", &cf.id, 100 * lots::MICRO, 300_000)).unwrap();
        let row = |activity: &str, sec: &str, shares: i64, gross: i64, memo: &str| {
            let mut t = inv(&acct, "2026-03-01", activity, sec, shares, gross);
            t.notes = Some(memo.into());
            create_investment_transaction(&c, &t).unwrap()
        };
        let day = vec![
            row("remove_shares", &g.id, 100 * lots::MICRO, 500_000, REALLOC_OUT),
            row("remove_shares", &cf.id, 100 * lots::MICRO, 500_000, REALLOC_OUT),
            row("add_shares", &i.id, 300 * lots::MICRO, 600_000, REALLOC_IN),
            row("add_shares", &s.id, 100 * lots::MICRO, 400_000, REALLOC_IN),
        ];
        link_same_day_exchanges(&c, &acct, REALLOC_OUT, REALLOC_IN).unwrap();
        // A contribution the same day is not part of the exchange.
        let contribution = create_investment_transaction(&c, &inv(&acct, "2026-03-01", "buy", &i.id, 10 * lots::MICRO, 20_000)).unwrap();
        let cash = balance(&c, &acct);
        let voided = |c: &Conn| -> i64 {
            c.query_row("SELECT COUNT(*) FROM transactions WHERE date = '2026-03-01' AND is_void = 1", [], |r| r.get(0)).unwrap()
        };
        let cost_of = |c: &Conn, sec: &str| {
            lots::replay(c, Some(&acct), None, None).unwrap().lots.iter().filter(|x| x.security_id == sec).map(|x| x.cost_cents).sum::<i64>()
        };

        set_void(&c, &day[3], true).unwrap();
        assert_eq!(voided(&c), 4, "the whole day's exchange is void, and only it");
        assert_eq!((cost_of(&c, &g.id), cost_of(&c, &cf.id)), (100_000, 300_000), "the funds are where they were");
        set_void(&c, &day[3], false).unwrap();
        assert_eq!(voided(&c), 0);
        assert_eq!(cost_of(&c, &s.id), 160_000);
        assert_eq!(balance(&c, &acct), cash);

        let ids = crate::db::undo::related_ids(&c, &day[3]).unwrap();
        for id in &day {
            assert!(ids.contains(id), "undo would not photograph {id}");
        }
        let (_, step) = crate::db::undo::recording(&c, "delete a transaction", &ids, || delete_transaction(&c, &day[3])).unwrap();
        for id in &day {
            assert!(get_transactions(&c, &acct, None).unwrap().iter().all(|t| &t.id != id), "{id} survived");
        }
        assert!(get_transactions(&c, &acct, None).unwrap().iter().any(|t| t.id == contribution));
        assert_eq!((cost_of(&c, &g.id), cost_of(&c, &cf.id)), (100_000, 300_000));
        assert_eq!(balance(&c, &acct), cash);
        let v = verify_file(&c, false).unwrap();
        assert!(v.drift.is_empty() && v.half_transfers.is_empty() && v.foreign_keys.is_empty(), "{v:?}");

        crate::db::undo::restore(&c, &step.before, &[]).unwrap();
        assert_eq!(get_register(&c, &acct).unwrap().iter().filter(|r| r.is_exchange).count(), 4);
        assert!(lots::replay(&c, Some(&acct), None, None).unwrap().problems.is_empty());
        assert_eq!(cost_of(&c, &s.id), 160_000);
    }
}
