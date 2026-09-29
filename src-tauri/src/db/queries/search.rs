//! Search, the import helpers, and the duplicate finder.

use crate::models::{DuplicateGroup, DuplicateRow, ImportSummary, SearchHit};
use rusqlite::{params, Connection, OptionalExtension};
use super::*;

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/// If `q` reads as an amount ("340", "$1,234.56", "-58.42", "(58.42)"),
/// its magnitude in cents. Integer arithmetic on the digits, no floats.
pub fn query_as_cents(q: &str) -> Option<i64> {
    let mut s: String = q.chars().filter(|c| !matches!(c, '$' | ',' | ' ')).collect();
    if s.starts_with('(') && s.ends_with(')') {
        s = s[1..s.len() - 1].to_string();
    }
    let s = s.trim_start_matches('-');
    if s.is_empty() {
        return None;
    }
    let (whole, frac) = match s.split_once('.') {
        Some((w, f)) => (w, f),
        None => (s, ""),
    };
    if !whole.chars().all(|c| c.is_ascii_digit()) || !frac.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if frac.len() > 2 || (whole.is_empty() && frac.is_empty()) {
        return None;
    }
    let dollars: i64 = if whole.is_empty() { 0 } else { whole.parse().ok()? };
    let cents: i64 = if frac.is_empty() {
        0
    } else {
        format!("{frac:0<2}").parse().ok()?
    };
    dollars.checked_mul(100)?.checked_add(cents)
}

/// Search across payee, memo, check number and amount — "where did that
/// $340 go", "when did I last pay the vet". Scoped to one account or all of
/// them. Text matches anywhere in the field, case-insensitively; an amount
/// query matches the magnitude exactly, so `340` finds a −$340.00 payment.
/// Newest first, capped, so a file with years of history answers quickly.
pub fn search_transactions(
    conn: &Conn,
    query: &str,
    account_id: Option<&str>,
    limit: i64,
) -> Result<Vec<SearchHit>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.clamp(1, 1000);
    // LIKE with an explicit ESCAPE so a user's `%` or `_` is literal.
    let pattern = format!(
        "%{}%",
        q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
    );
    let cents = query_as_cents(q);
    let sql = r#"
        SELECT t.id, t.account_id, a.name, t.date, t.payee, c.name, t.amount_cents,
               t.check_number, t.notes, t.is_void
          FROM transactions t
          JOIN accounts a ON a.id = t.account_id
          LEFT JOIN categories c ON c.id = t.category_id
         WHERE (?2 IS NULL OR t.account_id = ?2)
           AND (   t.payee LIKE ?1 ESCAPE '\'
                OR t.notes LIKE ?1 ESCAPE '\'
                OR t.check_number LIKE ?1 ESCAPE '\'
                OR c.name LIKE ?1 ESCAPE '\'
                OR (?3 IS NOT NULL AND abs(t.amount_cents) = ?3))
         ORDER BY t.date DESC, t.rowid DESC
         LIMIT ?4
    "#;
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let out = stmt
        .query_map(params![pattern, account_id, cents, limit], |r| {
            Ok(SearchHit {
                id: r.get(0)?,
                account_id: r.get(1)?,
                account_name: r.get(2)?,
                date: r.get(3)?,
                payee: r.get(4)?,
                category_name: r.get(5)?,
                amount_cents: r.get(6)?,
                check_number: r.get(7)?,
                notes: r.get(8)?,
                is_void: r.get::<_, i64>(9)? != 0,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(out)
}

// ---------------------------------------------------------------------------
// Import helpers
// ---------------------------------------------------------------------------

/// How many transactions the account already has with this date, amount and
/// payee — the duplicate-detection key when the source carries no id of its
/// own. A count rather than a boolean, so that two genuinely identical rows
/// in one file can both land (see `import_file`).
pub fn count_matching(
    conn: &Connection,
    account_id: &str,
    date: &str,
    amount_cents: i64,
    payee: &str,
) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*) FROM transactions
         WHERE account_id = ?1 AND date = ?2 AND amount_cents = ?3 AND payee = ?4",
        params![account_id, date, amount_cents, payee],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// One transaction in the account with this date, amount and payee that
/// carries NO bank id yet — a row imported before ids were stored, or entered
/// by hand. Returns its id so the caller can label it.
pub fn unlabeled_match(
    conn: &Connection,
    account_id: &str,
    date: &str,
    amount_cents: i64,
    payee: &str,
) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT id FROM transactions
          WHERE account_id = ?1 AND date = ?2 AND amount_cents = ?3 AND payee = ?4
            AND fitid IS NULL
          ORDER BY rowid LIMIT 1",
        params![account_id, date, amount_cents, payee],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// True if the account already holds a transaction with this bank-assigned
/// id (OFX `FITID`).
pub fn has_fitid(conn: &Connection, account_id: &str, fitid: &str) -> Result<bool, String> {
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM transactions WHERE account_id = ?1 AND fitid = ?2",
            params![account_id, fitid],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(n > 0)
}

/// Rebuild an `ImportSummary` from counts (used by the import module).
#[allow(dead_code)]
pub fn summary(
    account_id: &str,
    account_name: &str,
    imported: u32,
    skipped: u32,
    duplicates: u32,
    balance_delta_cents: i64,
) -> ImportSummary {
    ImportSummary {
        account_id: account_id.to_string(),
        account_name: account_name.to_string(),
        imported,
        skipped,
        duplicates,
        balance_delta_cents,
        investments: 0,
        securities_created: 0,
        transfers_linked: 0,
        matched: 0,
        user_skipped: 0,
        notes: Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// Duplicate finder
// ---------------------------------------------------------------------------

/// Rows in one account that share a date, an amount and a payee
/// (case-insensitive, trimmed) — the import dedupe key — grouped, so the
/// user can look at each set and delete the copy. Rows whose FITIDs differ
/// are still listed: a bank has been known to re-issue ids. Transfer halves
/// are listed and flagged; deleting one removes both halves, as always.
/// The far rows of split transfer lines are not listed. Two months of
/// the same mortgage principal in the loan register match by this key, and
/// they are the other side of two payments, not a copy; deleting one on its
/// own is refused anyway.
/// `window_days` widens the date: 0 = same day; 3 = within three days
/// (posted vs transacted), in which case rows are grouped by the earliest.
pub fn find_duplicates(conn: &Conn, account_id: &str, window_days: u32) -> Result<Vec<DuplicateGroup>, String> {
    let mut st = conn
        .prepare(
            "SELECT t.id, t.date, t.payee, t.amount_cents, t.cleared_state, c.name, t.notes, t.fitid, t.check_number, t.transfer_id IS NOT NULL
               FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
              WHERE t.account_id = ?1 AND t.is_void = 0 AND t.activity IS NULL
                AND t.is_split_transfer = 0
              ORDER BY lower(trim(t.payee)), t.amount_cents, t.date, t.rowid",
        )
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, String, i64, String, Option<String>, Option<String>, Option<String>, Option<String>, bool)> = st
        .query_map(params![account_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get::<_, i64>(9)? != 0))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    let mut out: Vec<DuplicateGroup> = Vec::new();
    let mut i = 0;
    while i < rows.len() {
        let key = (rows[i].2.trim().to_lowercase(), rows[i].3);
        let start = parse_date(&rows[i].1)?;
        let mut j = i + 1;
        while j < rows.len() {
            let same = (rows[j].2.trim().to_lowercase(), rows[j].3) == key;
            let d = parse_date(&rows[j].1)?;
            if !same || (d - start).num_days() > window_days as i64 {
                break;
            }
            j += 1;
        }
        if j - i >= 2 {
            out.push(DuplicateGroup {
                date: rows[i].1.clone(),
                payee: rows[i].2.clone(),
                amount_cents: rows[i].3,
                rows: rows[i..j]
                    .iter()
                    .map(|r| DuplicateRow {
                        id: r.0.clone(),
                        date: r.1.clone(),
                        cleared_state: r.4.clone(),
                        category_name: r.5.clone(),
                        notes: r.6.clone(),
                        fitid: r.7.clone(),
                        check_number: r.8.clone(),
                        is_transfer: r.9,
                    })
                    .collect(),
            });
        }
        i = j.max(i + 1);
    }
    out.sort_by(|a, b| b.date.cmp(&a.date));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::queries::test_support::*;

    // -----------------------------------------------------------------------
    // Search
    // -----------------------------------------------------------------------

    #[test]
    fn a_query_reads_as_cents_only_when_it_is_money() {
        assert_eq!(query_as_cents("340"), Some(34_000));
        assert_eq!(query_as_cents("$1,234.56"), Some(123_456));
        assert_eq!(query_as_cents("-58.42"), Some(5_842));
        assert_eq!(query_as_cents("(58.42)"), Some(5_842));
        assert_eq!(query_as_cents(".5"), Some(50));
        assert_eq!(query_as_cents("12.5"), Some(1_250));
        assert_eq!(query_as_cents("vet"), None);
        assert_eq!(query_as_cents("1.005"), None);
        assert_eq!(query_as_cents("1042a"), None);
        assert_eq!(query_as_cents(""), None);
    }

    #[test]
    fn search_finds_by_payee_memo_number_category_and_amount() {
        let db = TestDb::new("search");
        let c = db.conn();
        let chk = account(&c, "Checking", 0);
        let sav = account(&c, "Savings", 0);
        let vet = create_category(&c, "Pets : Vet", "expense", None, None).expect("cat");
        create_transaction(&c, &chk, "2026-08-01", "Banfield Animal Hospital", Some(vet.id.as_str()), -34_000, Some("annual shots"), None).expect("a");
        create_transaction(&c, &chk, "2026-08-02", "Kroger", None, -4_250, None, Some("1042")).expect("b");
        create_transaction(&c, &sav, "2026-08-03", "Kroger", None, -34_000, None, None).expect("c");
        create_transaction(&c, &chk, "2026-08-04", "Shell 50% off", None, -1_000, None, None).expect("d");

        let by_payee = search_transactions(&c, "banfield", None, 50).expect("search");
        assert_eq!(by_payee.len(), 1);
        assert_eq!(by_payee[0].account_name, "Checking");
        assert_eq!(by_payee[0].category_name.as_deref(), Some("Pets : Vet"));

        let by_memo = search_transactions(&c, "shots", None, 50).expect("search");
        assert_eq!(by_memo.len(), 1);

        let by_num = search_transactions(&c, "1042", None, 50).expect("search");
        assert_eq!(by_num.len(), 1, "a check number is found by text, not read as $1,042");
        assert_eq!(by_num[0].check_number.as_deref(), Some("1042"));

        let by_cat = search_transactions(&c, "vet", None, 50).expect("search");
        assert_eq!(by_cat.len(), 1);

        // An amount matches its magnitude in every account, newest first…
        let by_amount = search_transactions(&c, "340", None, 50).expect("search");
        assert_eq!(by_amount.iter().map(|h| h.date.as_str()).collect::<Vec<_>>(), ["2026-08-03", "2026-08-01"]);
        // …and scoped to one when asked.
        let scoped = search_transactions(&c, "$340.00", Some(&chk), 50).expect("search");
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].account_id, chk);

        // LIKE wildcards in the query are literal: "%" alone finds the one
        // payee that actually contains a percent sign, not every row.
        let pct = search_transactions(&c, "50%", None, 50).expect("search");
        assert_eq!(pct.len(), 1);
        let bare = search_transactions(&c, "%", None, 50).expect("search");
        assert_eq!(bare.len(), 1);
        assert_eq!(bare[0].payee, "Shell 50% off");
        assert_eq!(search_transactions(&c, "_", None, 50).expect("search").len(), 0);

        assert!(search_transactions(&c, "   ", None, 50).expect("search").is_empty());
    }
}
