//! QIF writer: one account's register as a Quicken Interchange file,
//! the mirror of `qif.rs`. Money's "Export an account as QIF".
//!
//! What goes out, and how:
//!
//! - `!Type:Bank` / `CCard` / `Cash` / `Oth A` / `Oth L` / `Invst` from the
//!   account type, so Quicken and Money file it under the right kind.
//! - Dates `MM/DD/YYYY`; amounts with two decimals, sign as stored (a
//!   payment is negative). Cents in, text out — no floats anywhere.
//! - `N` check number, `P` payee, `M` memo, `C*` cleared / `CX` reconciled,
//!   `L` category as `Parent:Child`, or `[Account]` for a transfer; a split
//!   transaction writes its `S` / `E` / `$` lines, which is how QIF says
//!   "these categories add up to T".
//! - Investment rows write the `!Type:Invst` record: `N` action (Buy, Sell,
//!   Div, IntInc, CGLong, CGShort, ReinvDiv, ReinvInt, ReinvLg, ReinvSh,
//!   ShrsIn, ShrsOut, RtrnCap, StkSplit), `Y` security, `I` price, `Q`
//!   quantity, `T` amount, `O` commission. Cash-only rows in an investment
//!   account go out as `N` XIn / XOut with the category, which is what
//!   Quicken writes for them.
//! - Void rows are left out: they are not money. The count is reported.
//!
//! Field text has newlines flattened to spaces; nothing else in QIF needs
//! escaping (there is no quoting in the format).

use rusqlite::{params, Connection};

use crate::db::lots::MICRO;

/// The account's rows as QIF text, plus how many records were written and
/// how many void rows were left out.
pub struct QifExport {
    pub text: String,
    pub records: u32,
    pub voided: u32,
}

fn qif_type(account_type: &str) -> &'static str {
    match account_type {
        "bank" | "checking" | "savings" => "Bank",
        "credit" | "line_of_credit" | "home_equity_line_of_credit" => "CCard",
        "cash" => "Cash",
        "investment" | "retirement" | "employee_stock_option" | "watch" => "Invst",
        "loan" | "mortgage" | "liability" => "Oth L",
        _ => "Oth A",
    }
}

fn us_date(iso: &str) -> String {
    // YYYY-MM-DD → MM/DD/YYYY; anything odd is passed through untouched.
    let b = iso.as_bytes();
    if b.len() == 10 && b[4] == b'-' && b[7] == b'-' {
        format!("{}/{}/{}", &iso[5..7], &iso[8..10], &iso[0..4])
    } else {
        iso.to_string()
    }
}

/// Cents → "-1234.56".
pub fn money(cents: i64) -> String {
    let sign = if cents < 0 { "-" } else { "" };
    let a = cents.unsigned_abs();
    format!("{sign}{}.{:02}", a / 100, a % 100)
}

/// Micro-units → a decimal with the trailing zeros dropped ("12.5", "100").
fn micro(v: i64) -> String {
    let sign = if v < 0 { "-" } else { "" };
    let a = v.unsigned_abs();
    let whole = a / MICRO as u64;
    let frac = a % MICRO as u64;
    if frac == 0 {
        format!("{sign}{whole}")
    } else {
        let f = format!("{frac:06}");
        format!("{sign}{whole}.{}", f.trim_end_matches('0'))
    }
}

fn flat(s: &str) -> String {
    s.replace(['\r', '\n'], " ")
}

fn action(activity: &str) -> &'static str {
    match activity {
        "buy" => "Buy",
        "sell" => "Sell",
        "dividend" => "Div",
        "interest" => "IntInc",
        "ltcg_dist" => "CGLong",
        "stcg_dist" => "CGShort",
        "reinvest_dividend" => "ReinvDiv",
        "reinvest_interest" => "ReinvInt",
        "reinvest_ltcg" => "ReinvLg",
        "reinvest_stcg" => "ReinvSh",
        "add_shares" => "ShrsIn",
        "remove_shares" => "ShrsOut",
        "return_of_capital" => "RtrnCap",
        "split" => "StkSplit",
        _ => "XOut",
    }
}

struct Row {
    date: String,
    payee: String,
    amount_cents: i64,
    check_number: Option<String>,
    notes: Option<String>,
    cleared_state: String,
    is_void: bool,
    category: Option<String>,
    transfer_account: Option<String>,
    activity: Option<String>,
    security: Option<String>,
    shares_micro: Option<i64>,
    price_micro: Option<i64>,
    gross_cents: Option<i64>,
    commission_cents: Option<i64>,
    splits: Vec<(Option<String>, Option<String>, i64)>,
}

pub fn export_account(conn: &Connection, account_id: &str) -> Result<QifExport, String> {
    let account_type: String = conn
        .query_row("SELECT type FROM accounts WHERE id = ?1", params![account_id], |r| r.get(0))
        .map_err(|_| format!("account {account_id} not found"))?;
    let invest = qif_type(&account_type) == "Invst";

    let mut stmt = conn
        .prepare(
            "SELECT t.id, t.date, t.payee, t.amount_cents, t.check_number, t.notes, t.cleared_state, t.is_void,
                    CASE WHEN c.id IS NULL THEN NULL
                         WHEN p.id IS NULL THEN c.name ELSE p.name || ':' || c.name END,
                    (SELECT a2.name FROM transactions tp JOIN accounts a2 ON a2.id = tp.account_id WHERE tp.id = t.transfer_id),
                    t.activity, s.name, t.shares_micro, t.price_micro, t.gross_cents, t.commission_cents
               FROM transactions t
               LEFT JOIN categories c ON c.id = t.category_id
               LEFT JOIN categories p ON p.id = c.parent_id
               LEFT JOIN securities s ON s.id = t.security_id
              WHERE t.account_id = ?1
              ORDER BY t.date, t.rowid",
        )
        .map_err(|e| e.to_string())?;
    let mut split_stmt = conn
        .prepare(
            "SELECT CASE WHEN c.id IS NULL THEN NULL WHEN p.id IS NULL THEN c.name ELSE p.name || ':' || c.name END,
                    s.description, s.amount_cents
               FROM splits s
               LEFT JOIN categories c ON c.id = s.category_id
               LEFT JOIN categories p ON p.id = c.parent_id
              WHERE s.transaction_id = ?1
              ORDER BY s.sort_order, s.rowid",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![account_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                Row {
                    date: r.get(1)?,
                    payee: r.get(2)?,
                    amount_cents: r.get(3)?,
                    check_number: r.get(4)?,
                    notes: r.get(5)?,
                    cleared_state: r.get(6)?,
                    is_void: r.get::<_, i64>(7)? != 0,
                    category: r.get(8)?,
                    transfer_account: r.get(9)?,
                    activity: r.get(10)?,
                    security: r.get(11)?,
                    shares_micro: r.get(12)?,
                    price_micro: r.get(13)?,
                    gross_cents: r.get(14)?,
                    commission_cents: r.get(15)?,
                    splits: Vec::new(),
                },
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut out = String::new();
    out.push_str(&format!("!Type:{}\n", qif_type(&account_type)));
    let mut records = 0u32;
    let mut voided = 0u32;
    for (id, mut row) in rows {
        if row.is_void {
            voided += 1;
            continue;
        }
        row.splits = split_stmt
            .query_map(params![id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        write_record(&mut out, &row, invest);
        records += 1;
    }
    Ok(QifExport { text: out, records, voided })
}

fn write_record(out: &mut String, row: &Row, invest: bool) {
    out.push_str(&format!("D{}\n", us_date(&row.date)));
    let category_line = match (&row.transfer_account, &row.category) {
        (Some(a), _) => Some(format!("[{}]", flat(a))),
        (None, Some(c)) => Some(flat(c)),
        (None, None) => None,
    };
    if invest {
        // Investment record. A cash-only row (no activity) is XIn / XOut.
        match row.activity.as_deref() {
            Some(a) => {
                out.push_str(&format!("N{}\n", action(a)));
                if let Some(s) = &row.security {
                    out.push_str(&format!("Y{}\n", flat(s)));
                }
                if a == "split" {
                    // Quicken's StkSplit quantity is new-per-old × 10.
                    if let Some(q) = row.shares_micro {
                        out.push_str(&format!("Q{}\n", micro(q.saturating_mul(10))));
                    }
                } else {
                    if let Some(p) = row.price_micro {
                        out.push_str(&format!("I{}\n", micro(p)));
                    }
                    if let Some(q) = row.shares_micro {
                        if q != 0 {
                            out.push_str(&format!("Q{}\n", micro(q)));
                        }
                    }
                    // T is the money side of the record: the gross for buys,
                    // sells and income (positive, as Quicken writes it), and
                    // for anything without cash the gross as recorded.
                    let t = row.gross_cents.unwrap_or(row.amount_cents.abs());
                    out.push_str(&format!("T{}\n", money(t)));
                    if let Some(c) = row.commission_cents.filter(|c| *c != 0) {
                        out.push_str(&format!("O{}\n", money(c)));
                    }
                }
            }
            None => {
                out.push_str(&format!("N{}\n", if row.amount_cents < 0 { "XOut" } else { "XIn" }));
                out.push_str(&format!("T{}\n", money(row.amount_cents.abs())));
            }
        }
    } else {
        out.push_str(&format!("T{}\n", money(row.amount_cents)));
    }
    match row.cleared_state.as_str() {
        "R" => out.push_str("CX\n"),
        "C" => out.push_str("C*\n"),
        _ => {}
    }
    // Not in an investment record. There `N` is the action, already
    // written above, and a second `N` is read as a replacement action — so a
    // cash row with a check number came back as the action "1043" and was
    // left out of the import. `!Type:Invst` has no check-number field; the
    // number is the one thing that does not survive the trip.
    if !invest {
        if let Some(n) = row.check_number.as_deref().filter(|n| !n.is_empty()) {
            out.push_str(&format!("N{}\n", flat(n)));
        }
    }
    if !row.payee.is_empty() {
        out.push_str(&format!("P{}\n", flat(&row.payee)));
    }
    if let Some(m) = row.notes.as_deref().filter(|m| !m.is_empty()) {
        out.push_str(&format!("M{}\n", flat(m)));
    }
    if let Some(l) = &category_line {
        out.push_str(&format!("L{l}\n"));
    }
    for (cat, memo, cents) in &row.splits {
        out.push_str(&format!("S{}\n", cat.as_deref().map(flat).unwrap_or_default()));
        if let Some(m) = memo.as_deref().filter(|m| !m.is_empty()) {
            out.push_str(&format!("E{}\n", flat(m)));
        }
        out.push_str(&format!("${}\n", money(*cents)));
    }
    out.push_str("^\n");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_come_out_as_quicken_writes_them() {
        assert_eq!(money(-123_456), "-1234.56");
        assert_eq!(money(5), "0.05");
        assert_eq!(money(0), "0.00");
        assert_eq!(micro(12_500_000), "12.5");
        assert_eq!(micro(100 * MICRO), "100");
        assert_eq!(micro(34_567_800), "34.5678");
        assert_eq!(us_date("2026-08-03"), "08/03/2026");
        assert_eq!(qif_type("credit"), "CCard");
        assert_eq!(qif_type("retirement"), "Invst");
    }
}
