//! Accounts: listing, creating, editing, valuing, deleting and merging.

use crate::models::{
    Account, HoldingChange, MergeSummary, NewInvestmentTransaction, StatementHolding, Transaction,
};
use crate::db::lots;
use rusqlite::{params, Connection, OptionalExtension, Row};
use uuid::Uuid;
use super::*;

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

fn map_row(row: &Row) -> rusqlite::Result<Account> {
    Ok(Account {
        id: row.get(0)?,
        name: row.get(1)?,
        r#type: row.get(2)?,
        balance_cents: row.get(3)?,
        holdings_value_cents: 0,
        tax_included: row.get::<_, i64>(17)? != 0,
        value_rounding: row.get(18)?,
        secured_by_account_id: row.get(19)?,
        sort_order: row.get(20)?,
        is_favorite: row.get::<_, i64>(4)? != 0,
        is_closed: row.get::<_, i64>(5)? != 0,
        updated_at: row.get(6)?,
        institution: row.get(7)?,
        account_number: row.get(8)?,
        routing_number: row.get(9)?,
        opened_on: row.get(10)?,
        credit_limit_cents: row.get(11)?,
        contact_phone: row.get(12)?,
        contact_email: row.get(13)?,
        website: row.get(14)?,
        address: row.get(15)?,
        account_notes: row.get(16)?,
    })
}

pub fn get_favorite_accounts(conn: &Conn) -> Result<Vec<Account>, String> {
    let mut stmt = conn
        .prepare("SELECT id, name, type, balance_cents, is_favorite, is_closed, updated_at,
                institution, account_number, routing_number, opened_on,
                credit_limit_cents, contact_phone, contact_email, website,
                address, account_notes, tax_included, value_rounding, secured_by_account_id, sort_order
                  FROM accounts WHERE is_favorite = 1 ORDER BY (sort_order IS NULL), sort_order, name")
        .map_err(|e| e.to_string())?;
    let out = stmt
        .query_map([], map_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    with_holdings(conn, out)
}

pub fn get_all_accounts(conn: &Conn) -> Result<Vec<Account>, String> {
    let mut stmt = conn
        .prepare("SELECT id, name, type, balance_cents, is_favorite, is_closed, updated_at,
                institution, account_number, routing_number, opened_on,
                credit_limit_cents, contact_phone, contact_email, website,
                address, account_notes, tax_included, value_rounding, secured_by_account_id, sort_order
                  FROM accounts ORDER BY (sort_order IS NULL), sort_order, name")
        .map_err(|e| e.to_string())?;
    let out = stmt
        .query_map([], map_row)
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    with_holdings(conn, out)
}

/// §169 — put the accounts in this order, everywhere accounts are listed.
///
/// `ids` is the whole order the user arranged; each named account takes its
/// position in the list, and an account not named (one created later) keeps
/// no position and sorts after the placed ones, by name — see the ORDER BY
/// on every account query. An id that is not an account is ignored rather
/// than refused: the dialog sends what it showed, and a row deleted under it
/// is not worth failing the rest for.
pub fn set_account_order(conn: &Conn, ids: &[String]) -> Result<usize, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut placed = 0;
    for (i, id) in ids.iter().enumerate() {
        placed += tx
            .execute("UPDATE accounts SET sort_order = ?2 WHERE id = ?1", params![id, i as i64])
            .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(placed)
}

/// Stamp each investment account with the market value of what it holds
/// today (§41). Every other kind stays at zero; nothing is stored.
fn with_holdings(conn: &Connection, mut accounts: Vec<Account>) -> Result<Vec<Account>, String> {
    if !accounts.iter().any(|a| matches!(a.r#type.as_str(), "investment" | "retirement")) {
        return Ok(accounts);
    }
    let today = chrono::Local::now().date_naive().format("%Y-%m-%d").to_string();
    let values = lots::holdings_by_account(conn, &today)?;
    for a in accounts.iter_mut() {
        a.holdings_value_cents = values.get(&a.id).copied().unwrap_or(0);
    }
    Ok(accounts)
}

pub fn create_account(
    conn: &Conn,
    name: &str,
    account_type: &str,
    opening_balance_cents: i64,
    // The date the opening balance is "as of" — Money's wizard asks for it.
    // `None` is today. It is also stored as the account's `opened_on`.
    opened_on: Option<&str>,
) -> Result<Account, String> {
    let opened_on = match opened_on.map(str::trim).filter(|d| !d.is_empty()) {
        Some(d) => {
            parse_date(d)?;
            d.to_string()
        }
        None => chrono::Local::now().date_naive().to_string(),
    };
    let id = Uuid::new_v4().to_string();
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        // Retirement accounts start out of the tax reports (§48).
        "INSERT INTO accounts (id, name, type, balance_cents, is_favorite, opened_on, tax_included)
         VALUES (?1, ?2, ?3, 0, 0, ?4, ?5)",
        params![id, name, account_type, opened_on, (account_type != "retirement") as i64],
    )
    .map_err(|e| e.to_string())?;
    // The opening balance is a ROW, not a bare number on the account.
    //
    // It used to be written straight into `balance_cents` with no
    // transaction behind it, so the register's running balance — a sum over
    // rows — started from zero while the sidebar started from the opening
    // amount. Open an account with $1,000, enter one $42.50 purchase, and the
    // register said −42.50 next to a sidebar saying 957.50. Money shows the
    // opening balance as the first row of the register; so does this now.
    // Migration 0021 wrote the same row for every account that already had
    // the gap.
    if opening_balance_cents != 0 {
        let txn_id = Uuid::new_v4().to_string();
        tx.execute(
            // §93/§94: an opening balance is what was already there — a
            // house's appraisal, a mortgage's remaining debt, the money in
            // the account the day you started keeping records. None of it is
            // income or spending, and counting it made a $150,000 mortgage
            // read as $150,000 of uncategorized expense the month it was
            // added. Marked as a revaluation so every category and payee
            // report leaves it alone, exactly as they leave a later Update
            // value alone; balances and net worth still count it.
            "INSERT INTO transactions
               (id, account_id, date, payee, amount_cents, is_reconciled, cleared_state, is_revaluation)
             VALUES (?1, ?2, ?3, 'Opening Balance', ?4, 1, 'R', ?5)",
            params![txn_id, id, opened_on, opening_balance_cents, 1],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE accounts SET balance_cents = balance_cents + ?1 WHERE id = ?2",
            params![opening_balance_cents, id],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT id, name, type, balance_cents, is_favorite, is_closed, updated_at,
                institution, account_number, routing_number, opened_on,
                credit_limit_cents, contact_phone, contact_email, website,
                address, account_notes, tax_included, value_rounding, secured_by_account_id, sort_order
         FROM accounts WHERE id = ?1",
        params![id],
        map_row,
    )
    .map_err(|e| e.to_string())
    .and_then(|a| with_holdings(conn, vec![a]).map(|mut v| v.remove(0)))
}

pub fn set_favorite(conn: &Conn, account_id: &str, is_favorite: bool) -> Result<(), String> {
    conn.execute(
        "UPDATE accounts SET is_favorite = ?1, updated_at = datetime('now') WHERE id = ?2",
        params![is_favorite as i64, account_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Delete an account and all of its transactions.
///
/// A transfer's other half lives in another account and points back here
/// through `transfer_id` (no `ON DELETE` clause, foreign keys on). Deleting
/// this account's rows with that link still in place failed with a raw
/// "FOREIGN KEY constraint failed" — so any account that had ever received a
/// transfer could not be deleted at all. The partner rows are unlinked first
/// and stay in their own account as ordinary entries, which is what they
/// still are: money that moved.
///
/// §179 — refused while a split payment has a line on either side of this
/// account. A split transfer line (§94) is one line of a payment, not a
/// transfer with two free-standing halves. Deleting the loan left every
/// checking payment's principal line with `transfer_account_id` NULLed — and
/// `CATEGORY_LINES` only leaves a line out while that column is set, so years
/// of principal arrived in every report as uncategorized spending. Deleting
/// the checking account the other way round strands the loan's rows as
/// "a split's row that no payment refers to". Neither is something a
/// confirmation dialog can explain, so the delete names the payments and
/// stops; closing the account keeps its history and hides it.
pub fn delete_account(conn: &Conn, id: &str) -> Result<(), String> {
    let name: String = conn
        .query_row("SELECT name FROM accounts WHERE id = ?1", params![id], |r| r.get(0))
        .map_err(|_| format!("account {id} not found"))?;
    let (incoming, outgoing): (i64, i64) = conn
        .query_row(
            "SELECT
                (SELECT COUNT(DISTINCT s.transaction_id) FROM splits s
                   JOIN transactions t ON t.id = s.transaction_id
                  WHERE s.transfer_account_id = ?1 AND t.account_id <> ?1),
                (SELECT COUNT(DISTINCT s.transaction_id) FROM splits s
                   JOIN transactions t ON t.id = s.transaction_id
                  WHERE t.account_id = ?1 AND s.transfer_account_id IS NOT NULL
                    AND s.transfer_account_id <> ?1)",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    if incoming > 0 || outgoing > 0 {
        let payments = |n: i64| if n == 1 { "payment sends" } else { "payments send" };
        let mut why = Vec::new();
        if incoming > 0 {
            why.push(format!("{incoming} split {} a line to it from another account", payments(incoming)));
        }
        if outgoing > 0 {
            why.push(format!("{outgoing} split {} a line from it to another account", payments(outgoing)));
        }
        return Err(format!(
            "{name} cannot be deleted: {}. Deleting it would leave those payments filed as uncategorized money. \
             Take those lines out of their splits first, or mark the account closed in its details instead.",
            why.join(", and ")
        ));
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE transactions SET transfer_id = NULL
          WHERE transfer_id IN (SELECT id FROM transactions WHERE account_id = ?1)",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    // Bills that were entered into this account are no longer paid by
    // anything; same rule as `delete_transaction`.
    tx.execute(
        "DELETE FROM recurrence_exceptions
          WHERE status = 'paid'
            AND transaction_id IN (SELECT id FROM transactions WHERE account_id = ?1)",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM transactions WHERE account_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM accounts WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Money's 401(k) Manager / "Update your shares" (§50): the statement says
/// what is held on `date`; this writes an Add Shares or Remove Shares row per
/// security for the difference from what the register says is held, and
/// records the statement's price. A 401(k) that only sends statements can
/// be kept honest without typing every contribution.
///
/// Per line: shares from the statement, or value ÷ price (the given price,
/// or the latest known one on or before `date`). Added shares get their
/// basis at that price; removed shares go FIFO. A line that cannot be
/// worked out (no price to divide by, no shares and no value) is reported
/// in `problem` and skipped. `dry_run` computes everything, writes nothing.
pub fn update_holdings(
    conn: &Conn,
    account_id: &str,
    date: &str,
    lines: &[StatementHolding],
    dry_run: bool,
) -> Result<Vec<HoldingChange>, String> {
    parse_date(date)?;
    get_account(conn, account_id)?;
    let held = lots::portfolio(conn, Some(account_id), date)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(lines.len());
    for l in lines {
        let (name, symbol): (String, String) = tx
            .query_row("SELECT name, symbol FROM securities WHERE id = ?1", params![l.security_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|_| format!("unknown security {}", l.security_id))?;
        let held_micro = held.positions.iter().find(|p| p.security_id == l.security_id).map(|p| p.shares_micro).unwrap_or(0);
        let mut change = HoldingChange {
            security_id: l.security_id.clone(),
            security_name: name,
            symbol,
            held_micro,
            statement_micro: held_micro,
            delta_micro: 0,
            price_micro: 0,
            gross_cents: 0,
            transaction_id: None,
            problem: None,
        };
        // The price: the statement's, else derived from value and shares,
        // else the latest known.
        let known = lots::price_asof(&tx, &l.security_id, date)?.map(|(p, _, _)| p);
        let price = match (l.price_micro, l.shares_micro, l.value_cents) {
            (Some(p), _, _) => Some(p),
            (None, Some(sh), Some(v)) if sh > 0 => Some(lots::mul_div(v, 10_000_000_000, sh)),
            _ => known,
        };
        let statement = match (l.shares_micro, l.value_cents, price) {
            (Some(sh), _, _) => Some(sh),
            (None, Some(v), Some(p)) if p > 0 => Some(lots::mul_div(v, 10_000_000_000, p)),
            (None, Some(_), _) => {
                change.problem = Some("No price to turn the value into shares — enter the price too.".into());
                None
            }
            (None, None, _) => {
                change.problem = Some("Enter the shares held or the value.".into());
                None
            }
        };
        if let Some(p) = price {
            if p < 0 {
                change.problem = Some("A price cannot be negative.".into());
            }
        }
        if let (Some(sh), None) = (statement, &change.problem) {
            if sh < 0 {
                change.problem = Some("Shares held cannot be negative.".into());
            }
        }
        if change.problem.is_none() {
            let sh = statement.unwrap();
            let p = price.unwrap_or(0);
            change.statement_micro = sh;
            change.delta_micro = sh - held_micro;
            change.price_micro = p;
            change.gross_cents = lots::mul_div(change.delta_micro.abs(), p, 10_000_000_000);
            if !dry_run {
                if l.price_micro.is_some() || (l.shares_micro.is_some() && l.value_cents.is_some()) {
                    set_security_price(&tx, &l.security_id, date, p, "manual")?;
                }
                if change.delta_micro != 0 {
                    let row = NewInvestmentTransaction {
                        account_id: account_id.to_string(),
                        date: date.to_string(),
                        activity: if change.delta_micro > 0 { "add_shares" } else { "remove_shares" }.to_string(),
                        security_id: l.security_id.clone(),
                        shares_micro: change.delta_micro.abs(),
                        price_micro: Some(p),
                        gross_cents: change.gross_cents,
                        commission_cents: 0,
                        category_id: None,
                        notes: Some("Updated from statement".to_string()),
                        funding_account_id: None,
                        lot_allocations: vec![],
                    };
                    change.transaction_id = Some(insert_investment_transaction(&tx, &row, None)?);
                }
            }
        }
        out.push(change);
    }
    if dry_run {
        tx.rollback().map_err(|e| e.to_string())?;
    } else {
        tx.commit().map_err(|e| e.to_string())?;
    }
    Ok(out)
}

/// Money's "Merge duplicate accounts" (§49). `from_id` is folded into
/// `into_id` and deleted. What moves:
///
/// - Its transactions — all of them, or with `after_last` only those dated
///   after the survivor's last transaction (Money's rule: the survivor's
///   own history is kept, the other account fills in from where it ends).
///   A row the survivor already has (same date, amount, payee and the
///   investment fields) stays behind, as does the duplicate's own opening
///   balance, so the merged balance is not doubled.
/// - Transfers between the two accounts would become money moving from the
///   survivor to itself; both sides are deleted. A transfer to a third
///   account keeps its link. A row that stays behind is unlinked from its
///   partner first, like `delete_account`.
/// - Statements, recurrences and goals pointing at the duplicate now point
///   at the survivor.
///
/// `dry_run` does all of it and rolls back, returning the same summary, so
/// the dialog can say what will happen before it does.
pub fn merge_accounts(
    conn: &Conn,
    into_id: &str,
    from_id: &str,
    after_last: bool,
    dry_run: bool,
) -> Result<MergeSummary, String> {
    if into_id == from_id {
        return Err("Pick two different accounts.".into());
    }
    let into = get_account(conn, into_id)?;
    let from = get_account(conn, from_id)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut out = MergeSummary::default();

    // Which of the duplicate's rows move. The survivor's opening-balance
    // row is the one we keep; the duplicate's is dropped (it is the same
    // account's opening balance twice). With `after_last`, only rows dated
    // after the survivor's newest row move.
    let last: Option<String> = tx
        .query_row(
            "SELECT MAX(date) FROM transactions WHERE account_id = ?1 AND is_void = 0",
            params![into_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let cutoff = if after_last { last.unwrap_or_default() } else { String::new() };
    tx.execute("DROP TABLE IF EXISTS temp.merge_move", [])
        .map_err(|e| e.to_string())?;
    tx.execute(
        "CREATE TEMP TABLE merge_move AS
         SELECT f.id
           FROM transactions f
          WHERE f.account_id = ?1
            -- §179 — a split payment's row (§94) always moves: its line in
            -- the other account survives the merge and must still find it.
            -- Left behind it would be deleted with the duplicate and the
            -- payment would lose the row that pays down the loan.
            AND (f.is_split_transfer = 1 OR (
                f.date > ?2
            AND NOT (f.payee = 'Opening Balance' AND f.category_id IS NULL AND f.activity IS NULL)
            AND NOT EXISTS (
                SELECT 1 FROM transactions s
                 WHERE s.account_id = ?3
                   AND s.is_void = 0
                   AND s.date = f.date
                   AND s.amount_cents = f.amount_cents
                   AND lower(s.payee) = lower(f.payee)
                   AND coalesce(s.activity, '') = coalesce(f.activity, '')
                   AND coalesce(s.security_id, '') = coalesce(f.security_id, '')
                   AND coalesce(s.shares_micro, 0) = coalesce(f.shares_micro, 0)
                   AND coalesce(s.gross_cents, 0) = coalesce(f.gross_cents, 0))))",
        params![from_id, cutoff, into_id],
    )
    .map_err(|e| e.to_string())?;
    let count = |sql: &str, p: &[&dyn rusqlite::ToSql]| -> Result<u32, String> {
        tx.query_row(sql, p, |r| r.get::<_, i64>(0))
            .map(|n| n as u32)
            .map_err(|e| e.to_string())
    };
    let total = count("SELECT COUNT(*) FROM transactions WHERE account_id = ?1", &[&from_id])?;
    out.duplicates = count(
        "SELECT COUNT(*) FROM transactions f
          WHERE f.account_id = ?1 AND f.date > ?2 AND f.id NOT IN (SELECT id FROM merge_move)
            AND NOT (f.payee = 'Opening Balance' AND f.category_id IS NULL AND f.activity IS NULL)",
        &[&from_id, &cutoff],
    )?;

    // §179 — a split line cannot transfer to its own account (§94), and a
    // merge would make one: a payment moving into the account its own line
    // pays, or a survivor's payment whose line pays the duplicate. Refused
    // before anything is written, so the dry run says it too and the Merge
    // button never offers a merge that would corrupt the payment.
    let own_account_lines = count(
        "SELECT COUNT(DISTINCT s.transaction_id) FROM splits s
          WHERE (s.transaction_id IN (SELECT id FROM merge_move) AND s.transfer_account_id = ?1)
             OR (s.transfer_account_id = ?2
                 AND s.transaction_id IN (SELECT id FROM transactions WHERE account_id = ?1))",
        &[&into_id, &from_id],
    )?;
    if own_account_lines > 0 {
        return Err(format!(
            "{} cannot be merged into {}: {own_account_lines} split {} a line that moves money between the two, \
             and after the merge that line would transfer to its own account. Take those lines out of their splits first.",
            from.name,
            into.name,
            if own_account_lines == 1 { "payment has" } else { "payments have" }
        ));
    }

    // Transfers between the two accounts: a moving row whose partner is in
    // the survivor. Both sides go.
    //
    // §179 — "or is moving too" used to be part of that test, and the only
    // pair it could ever match is two rows of the duplicate linked to each
    // other: a §167 exchange, whose `transfer_id` points into its own
    // account. Merging a TSP account deleted every reallocation it held, and
    // the lots they carried went with them. An exchange is not money moving
    // between the two accounts; it moves with the rest.
    out.self_transfers = count(
        "SELECT COUNT(*) FROM transactions a
           JOIN transactions b ON b.id = a.transfer_id
          WHERE a.id IN (SELECT id FROM merge_move)
            AND b.account_id = ?1",
        &[&into_id],
    )?;
    tx.execute(
        "DELETE FROM recurrence_exceptions
          WHERE status = 'paid' AND transaction_id IN (
                SELECT a.id FROM transactions a JOIN transactions b ON b.id = a.transfer_id
                 WHERE a.id IN (SELECT id FROM merge_move)
                   AND b.account_id = ?1
                UNION
                SELECT b.id FROM transactions a JOIN transactions b ON b.id = a.transfer_id
                 WHERE a.id IN (SELECT id FROM merge_move)
                   AND b.account_id = ?1)",
        params![into_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "CREATE TEMP TABLE merge_gone AS
         SELECT a.id FROM transactions a JOIN transactions b ON b.id = a.transfer_id
          WHERE a.id IN (SELECT id FROM merge_move)
            AND b.account_id = ?1
         UNION
         SELECT b.id FROM transactions a JOIN transactions b ON b.id = a.transfer_id
          WHERE a.id IN (SELECT id FROM merge_move)
            AND b.account_id = ?1",
        params![into_id],
    )
    .map_err(|e| e.to_string())?;
    // Unlink first so the FK on transfer_id does not object to the order.
    tx.execute(
        "UPDATE transactions SET transfer_id = NULL WHERE id IN (SELECT id FROM merge_gone)",
        [],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM transactions WHERE id IN (SELECT id FROM merge_gone)", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM merge_move WHERE id IN (SELECT id FROM merge_gone)", [])
        .map_err(|e| e.to_string())?;
    tx.execute("DROP TABLE merge_gone", []).map_err(|e| e.to_string())?;

    // Move what is left to move.
    out.moved = tx
        .execute(
            "UPDATE transactions SET account_id = ?1 WHERE id IN (SELECT id FROM merge_move)",
            params![into_id],
        )
        .map_err(|e| e.to_string())? as u32;
    tx.execute("DROP TABLE merge_move", []).map_err(|e| e.to_string())?;
    out.left_behind = total.saturating_sub(out.moved + out.duplicates + out.self_transfers);

    // The rest of the duplicate goes the way `delete_account` sends it:
    // partners unlinked, paid exceptions released, rows deleted.
    //
    // §179 — and a payment left behind takes its split rows in other
    // accounts with it, as `delete_transaction` does. It is a row the
    // survivor already has (or history before the survivor's last date), and
    // the survivor's copy has its own rows; leaving these would pay the loan
    // twice, and as rows no payment refers to.
    let staying_payments: Vec<String> = {
        let mut st = tx
            .prepare(
                "SELECT DISTINCT s.transaction_id FROM splits s
                   JOIN transactions t ON t.id = s.transaction_id
                  WHERE t.account_id = ?1 AND s.transfer_txn_id IS NOT NULL",
            )
            .map_err(|e| e.to_string())?;
        let ids = st
            .query_map(params![from_id], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<String>, _>>()
            .map_err(|e| e.to_string())?;
        ids
    };
    for p in &staying_payments {
        delete_split_transfer_rows(&tx, p)?;
    }
    tx.execute(
        "UPDATE transactions SET transfer_id = NULL
          WHERE transfer_id IN (SELECT id FROM transactions WHERE account_id = ?1)",
        params![from_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM recurrence_exceptions
          WHERE status = 'paid'
            AND transaction_id IN (SELECT id FROM transactions WHERE account_id = ?1)",
        params![from_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM transactions WHERE account_id = ?1", params![from_id])
        .map_err(|e| e.to_string())?;

    out.statements = tx
        .execute("UPDATE statements SET account_id = ?1 WHERE account_id = ?2", params![into_id, from_id])
        .map_err(|e| e.to_string())? as u32;
    out.recurrences = tx
        .execute("UPDATE recurrences SET account_id = ?1 WHERE account_id = ?2", params![into_id, from_id])
        .map_err(|e| e.to_string())? as u32;
    out.goals = tx
        .execute("UPDATE goals SET account_id = ?1 WHERE account_id = ?2", params![into_id, from_id])
        .map_err(|e| e.to_string())? as u32;
    // Favorite if either was.
    if from.is_favorite && !into.is_favorite {
        tx.execute("UPDATE accounts SET is_favorite = 1 WHERE id = ?1", params![into_id])
            .map_err(|e| e.to_string())?;
    }

    // §179 — everything else that names the duplicate, re-pointed BEFORE it
    // is deleted. Every `REFERENCES accounts(id)` in `migrations.rs` is here
    // or above (transactions, statements, recurrences, goals). Left to their
    // `ON DELETE` clauses these went quietly wrong: a checking payment's
    // principal line lost its account and became uncategorized spending, a
    // scheduled transfer into the duplicate became a plain bill, the loan
    // forgot its escrow account and the house its mortgage, a payee rule
    // scoped to the account started matching everywhere, and the loan terms
    // and the account's attachments were cascaded away.
    let repoint = |sql: &str| -> Result<usize, String> {
        tx.execute(sql, params![into_id, from_id]).map_err(|e| e.to_string())
    };
    repoint("UPDATE splits SET transfer_account_id = ?1 WHERE transfer_account_id = ?2")?;
    repoint("UPDATE payee_rules SET account_id = ?1 WHERE account_id = ?2")?;
    repoint("UPDATE attachments SET account_id = ?1 WHERE account_id = ?2")?;

    // A scheduled transfer between the two would move money from the
    // survivor to itself — the recurrence twin of `self_transfers`, and it
    // goes the same way. The duplicate's own rules were moved to the
    // survivor above, so both directions now start in the survivor.
    let self_scheduled = tx
        .execute(
            "DELETE FROM recurrences WHERE account_id = ?1 AND transfer_account_id IN (?1, ?2)",
            params![into_id, from_id],
        )
        .map_err(|e| e.to_string())?;
    if self_scheduled > 0 {
        out.notes.push(format!(
            "{self_scheduled} scheduled {} between the two accounts removed.",
            if self_scheduled == 1 { "transfer" } else { "transfers" }
        ));
    }
    repoint("UPDATE recurrences SET transfer_account_id = ?1 WHERE transfer_account_id = ?2")?;

    // Loan terms are one row per account. The survivor's win when both have
    // them — they are the ones the survivor's payments were recorded against
    // — and the dialog says so rather than dropping the duplicate's in
    // silence.
    let terms_of = |id: &str| -> Result<bool, String> {
        tx.query_row("SELECT EXISTS(SELECT 1 FROM loan_terms WHERE account_id = ?1)", params![id], |r| r.get(0))
            .map_err(|e| e.to_string())
    };
    if terms_of(from_id)? {
        if terms_of(into_id)? {
            out.notes.push(format!("Both accounts had loan terms; {}'s are kept.", into.name));
        } else {
            repoint("UPDATE loan_terms SET account_id = ?1 WHERE account_id = ?2")?;
        }
    }
    // A loan whose escrow or payments ran through the duplicate now runs
    // through the survivor — unless the loan IS the survivor (its own terms,
    // or the duplicate's just moved onto it), where that would name the loan
    // as its own escrow account.
    for column in ["escrow_account_id", "from_account_id"] {
        tx.execute(
            &format!("UPDATE loan_terms SET {column} = NULL WHERE account_id = ?1 AND {column} IN (?1, ?2)"),
            params![into_id, from_id],
        )
        .map_err(|e| e.to_string())?;
        repoint(&format!("UPDATE loan_terms SET {column} = ?1 WHERE {column} = ?2"))?;
    }
    // §93 — the same for what a debt is secured by, in both directions.
    tx.execute(
        "UPDATE accounts SET secured_by_account_id = NULL WHERE id = ?1 AND secured_by_account_id = ?2",
        params![into_id, from_id],
    )
    .map_err(|e| e.to_string())?;
    repoint("UPDATE accounts SET secured_by_account_id = ?1 WHERE secured_by_account_id = ?2")?;
    tx.execute(
        "UPDATE accounts
            SET secured_by_account_id = (SELECT secured_by_account_id FROM accounts WHERE id = ?2)
          WHERE id = ?1 AND secured_by_account_id IS NULL
            AND (SELECT secured_by_account_id FROM accounts WHERE id = ?2) <> ?1",
        params![into_id, from_id],
    )
    .map_err(|e| e.to_string())?;

    tx.execute("DELETE FROM accounts WHERE id = ?1", params![from_id])
        .map_err(|e| e.to_string())?;

    // The balance is kept incrementally everywhere else; here it is simply
    // the sum of what the survivor now holds.
    tx.execute(
        "UPDATE accounts SET balance_cents = (
             SELECT coalesce(SUM(amount_cents), 0) FROM transactions
              WHERE account_id = ?1 AND is_void = 0),
             updated_at = datetime('now')
          WHERE id = ?1",
        params![into_id],
    )
    .map_err(|e| e.to_string())?;
    out.balance_cents = tx
        .query_row("SELECT balance_cents FROM accounts WHERE id = ?1", params![into_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    if dry_run {
        tx.rollback().map_err(|e| e.to_string())?;
    } else {
        tx.commit().map_err(|e| e.to_string())?;
    }
    Ok(out)
}

/// Money's "Change account details". Updates the identity and contact fields of
/// one account; balance is never touched here — it is derived from
/// transactions. Passing None for a field clears it.
#[allow(clippy::too_many_arguments)]
pub fn update_account(
    conn: &Conn,
    id: &str,
    name: &str,
    account_type: &str,
    is_closed: bool,
    institution: Option<&str>,
    account_number: Option<&str>,
    routing_number: Option<&str>,
    opened_on: Option<&str>,
    credit_limit_cents: Option<i64>,
    contact_phone: Option<&str>,
    contact_email: Option<&str>,
    website: Option<&str>,
    address: Option<&str>,
    account_notes: Option<&str>,
) -> Result<Account, String> {
    conn.execute(
        "UPDATE accounts SET
             name = ?2, type = ?3, is_closed = ?4,
             institution = ?5, account_number = ?6, routing_number = ?7,
             opened_on = ?8, credit_limit_cents = ?9, contact_phone = ?10,
             contact_email = ?11, website = ?12, address = ?13, account_notes = ?14,
             updated_at = datetime('now')
         WHERE id = ?1",
        params![
            id,
            name,
            account_type,
            is_closed as i64,
            institution,
            account_number,
            routing_number,
            opened_on,
            credit_limit_cents,
            contact_phone,
            contact_email,
            website,
            address,
            account_notes
        ],
    )
    .map_err(|e| e.to_string())?;
    get_account(conn, id)
}

/// One account by id.
/// Money's "Choose accounts to include in tax return information" (§48).
pub fn set_account_tax_included(conn: &Conn, id: &str, included: bool) -> Result<(), String> {
    let n = conn
        .execute(
            "UPDATE accounts SET tax_included = ?2, updated_at = datetime('now') WHERE id = ?1",
            params![id, included as i64],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("account {id} not found"));
    }
    Ok(())
}

/// §81: this account rounds its holding values its own way, or follows the
/// file (None). Only meaningful on investment / retirement accounts, but
/// harmless elsewhere.
pub fn set_account_value_rounding(conn: &Conn, id: &str, rounding: Option<&str>) -> Result<(), String> {
    let r = match rounding.map(str::trim).filter(|s| !s.is_empty()) {
        None => None,
        Some("nearest") => Some("nearest"),
        Some("down") => Some("down"),
        Some(other) => return Err(format!("unknown rounding {other:?} — nearest, down, or nothing")),
    };
    let n = conn
        .execute(
            "UPDATE accounts SET value_rounding = ?2, updated_at = datetime('now') WHERE id = ?1",
            params![id, r],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("account {id} not found"));
    }
    Ok(())
}

/// §93: the kinds of account whose value is a judgment rather than a
/// balance — a house, a car, a boat, a coin collection. These get **Update
/// value**; a checking account's balance is the sum of its transactions and
/// nobody revalues it.
pub fn is_valued_asset(kind: &str) -> bool {
    matches!(kind, "asset" | "vehicle" | "home" | "other")
}

/// §93: what the thing is worth now.
///
/// Not "adjust by": the user knows the Pickup is worth $9,000, not that it
/// fell $1,850 since the last time they looked. The difference is worked out
/// here and written as a dated **revaluation** — a row that moves the balance
/// and shows in Net worth and Net worth over time, but that every income,
/// spending, payee and tax report ignores (migration 0032). A house gaining
/// $20,000 is not income, and counting it as such would bury a year of real
/// spending.
///
/// Revaluing a date in the past works and is the point: the value on each
/// date is what makes the net-worth curve true rather than a flat line that
/// jumps today.
pub fn set_account_value(
    conn: &Conn,
    account_id: &str,
    date: &str,
    value_cents: i64,
    notes: Option<&str>,
) -> Result<Option<Transaction>, String> {
    parse_date(date)?;
    let (kind, name): (String, String) = conn
        .query_row("SELECT type, name FROM accounts WHERE id = ?1", params![account_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|_| format!("account {account_id} not found"))?;
    if !is_valued_asset(&kind) {
        return Err(format!(
            "{name} is a {kind} account — its balance is the sum of its transactions. Update value is for a house, a vehicle or another asset you appraise."
        ));
    }
    // What the account says it is worth on that date, ignoring anything
    // dated after it: revaluing last June must not be thrown off by this
    // month's row.
    let asof: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(amount_cents), 0) FROM transactions
              WHERE account_id = ?1 AND is_void = 0 AND date <= ?2",
            params![account_id, date],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let delta = value_cents - asof;
    if delta == 0 {
        return Ok(None);
    }
    let id = Uuid::new_v4().to_string();
    let payee = if delta > 0 { "Increase in value" } else { "Decrease in value" };
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO transactions
           (id, account_id, date, payee, payee_id, category_id, amount_cents,
            is_reconciled, notes, cleared_state, is_revaluation)
         VALUES (?1, ?2, ?3, ?4, NULL, NULL, ?5, 0, ?6, '', 1)",
        params![id, account_id, date, payee, delta, notes],
    )
    .map_err(|e| e.to_string())?;

    // Each revaluation asserts what the thing was worth ON ITS DATE. Filling
    // in a value for last June must not silently push December up by the same
    // amount — December already said what it was worth. So the next
    // revaluation after this one absorbs the difference, and every stated
    // value stays true.
    let later: Option<(String, i64, String)> = tx
        .query_row(
            "SELECT id, amount_cents, payee FROM transactions
              WHERE account_id = ?1 AND is_revaluation = 1 AND is_void = 0 AND date > ?2
              ORDER BY date, rowid LIMIT 1",
            params![account_id, date],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match later {
        Some((later_id, later_amount, later_payee)) => {
            let absorbed = later_amount - delta;
            if absorbed == 0 {
                // §179 — the later value was exactly what this one now says
                // it already was: its row would move nothing and read
                // "Increase in value 0.00" in the register. It goes. (The
                // command photographed it before the write, so undo puts it
                // back.)
                tx.execute("DELETE FROM transactions WHERE id = ?1", params![later_id])
                    .map_err(|e| e.to_string())?;
            } else {
                // §179 — absorbing the difference can turn the later rise
                // into a fall. Its label follows its sign, as this row's
                // does; a label someone typed over is theirs and is left.
                let relabel = match later_payee.as_str() {
                    "Increase in value" | "Decrease in value" => {
                        if absorbed > 0 { "Increase in value" } else { "Decrease in value" }.to_string()
                    }
                    _ => later_payee,
                };
                tx.execute(
                    "UPDATE transactions SET amount_cents = ?2, payee = ?3 WHERE id = ?1",
                    params![later_id, absorbed, relabel],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        None => {
            tx.execute(
                "UPDATE accounts SET balance_cents = balance_cents + ?2, updated_at = datetime('now') WHERE id = ?1",
                params![account_id, delta],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(Some(Transaction {
        id,
        account_id: account_id.to_string(),
        date: date.to_string(),
        payee: payee.to_string(),
        category_id: None,
        amount_cents: delta,
        is_reconciled: false,
        notes: notes.map(str::to_string),
    }))
}

/// §93: the asset a debt is borrowed against — the mortgage names the house.
/// `None` unlinks. The link lives on the liability so one asset can carry
/// several debts while each debt is secured on exactly one thing.
pub fn set_account_security(conn: &Conn, liability_id: &str, asset_id: Option<&str>) -> Result<(), String> {
    let kind: String = conn
        .query_row("SELECT type FROM accounts WHERE id = ?1", params![liability_id], |r| r.get(0))
        .map_err(|_| format!("account {liability_id} not found"))?;
    if !matches!(kind.as_str(), "loan" | "mortgage" | "home_equity_line_of_credit" | "liability" | "line_of_credit" | "credit") {
        return Err(format!("a {kind} account is not a debt, so it is not secured on anything"));
    }
    if let Some(asset) = asset_id {
        if asset == liability_id {
            return Err("an account cannot be secured on itself".to_string());
        }
        let akind: String = conn
            .query_row("SELECT type FROM accounts WHERE id = ?1", params![asset], |r| r.get(0))
            .map_err(|_| format!("account {asset} not found"))?;
        if !is_valued_asset(&akind) {
            return Err(format!("a debt is secured on a house, a vehicle or another asset — not on a {akind} account"));
        }
    }
    conn.execute(
        "UPDATE accounts SET secured_by_account_id = ?2, updated_at = datetime('now') WHERE id = ?1",
        params![liability_id, asset_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// §93: what is owed against each asset — the asset's id to the total of the
/// debts secured on it, as a positive number. Equity is the asset's worth
/// less this.
pub fn debts_by_asset(conn: &Conn) -> Result<std::collections::HashMap<String, i64>, String> {
    let mut st = conn
        .prepare(
            "SELECT secured_by_account_id, COALESCE(SUM(balance_cents), 0)
               FROM accounts
              WHERE secured_by_account_id IS NOT NULL
              GROUP BY secured_by_account_id",
        )
        .map_err(|e| e.to_string())?;
    let rows = st
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    // A debt's balance is negative in its own register; owed is positive.
    Ok(rows.into_iter().map(|(k, v)| (k, -v)).collect())
}

pub fn get_account(conn: &Conn, id: &str) -> Result<Account, String> {
    conn.query_row(
        "SELECT id, name, type, balance_cents, is_favorite, is_closed, updated_at,
                institution, account_number, routing_number, opened_on,
                credit_limit_cents, contact_phone, contact_email, website,
                address, account_notes, tax_included, value_rounding, secured_by_account_id, sort_order
         FROM accounts WHERE id = ?1",
        params![id],
        map_row,
    )
    .map_err(|e| e.to_string())
    .and_then(|a| with_holdings(conn, vec![a]).map(|mut v| v.remove(0)))
}

#[cfg(test)]
mod tests {
    use crate::models::{NewRecurrence, RuleConditions, StatementHolding};
    use crate::db::lots;
    use rusqlite::{params, OptionalExtension};
    use super::*;
    use crate::db::queries::test_support::*;

    // ── retirement accounts stay out of tax reports (§48) ────────────────

    #[test]
    fn a_retirement_account_is_left_out_of_tax_reports_unless_included() {
        let db = TestDb::new("tax-scope");
        let c = db.conn();
        let brok = inv_account(&c, "Brokerage", "investment");
        let ira = inv_account(&c, "IRA", "retirement");
        assert!(get_account(&c, &brok).unwrap().tax_included);
        assert!(!get_account(&c, &ira).unwrap().tax_included, "retirement starts excluded");
        let sec = create_security(&c, "Fund", "FUND", "mutual_fund", None).unwrap();
        create_category(&c, "Dividend Income", "income", None, Some("Schedule B: Dividend income")).unwrap();
        for acct in [&brok, &ira] {
            create_investment_transaction(&c, &inv(acct, "2025-01-10", "buy", &sec.id, 10 * lots::MICRO, 10_000)).unwrap();
            create_investment_transaction(&c, &inv(acct, "2025-03-10", "dividend", &sec.id, 0, 500)).unwrap();
            create_investment_transaction(&c, &inv(acct, "2025-06-10", "sell", &sec.id, 10 * lots::MICRO, 15_000)).unwrap();
        }
        let run = |kind: &str, tax_scope: Option<bool>| {
            crate::db::reports::run_report(&c, &crate::models::ReportRequest {
                kind: kind.into(), from: "2025-01-01".into(), to: "2025-12-31".into(),
                account_ids: None, category_ids: None, compare_from: None, compare_to: None, detail: None, security_ids: None, tax_scope, ..Default::default()
            }).unwrap()
        };
        // Tax summary: only the brokerage dividend.
        let ts = run("tax_summary", None);
        let div = ts.rows.iter().find(|r| r.label == "Dividend Income").unwrap();
        assert_eq!(div.cells[0].cents, Some(500));
        // Capital gains from the Taxes tab: one sale, not two.
        let cg = run("capital_gains", Some(true));
        assert_eq!(cg.rows.iter().filter(|r| r.key_kind.as_deref() == Some("transaction")).count(), 1);
        // The Reports gallery's capital gains, unscoped: both.
        let cg_all = run("capital_gains", None);
        assert_eq!(cg_all.rows.iter().filter(|r| r.key_kind.as_deref() == Some("transaction")).count(), 2);
        // Investment income the same way.
        let ii = run("investment_income", Some(true));
        assert_eq!(ii.rows.iter().find(|r| r.style == "total").unwrap().cells[0].cents, Some(500));
        // Flip the IRA in: everything counts.
        set_account_tax_included(&c, &ira, true).unwrap();
        let cg = run("capital_gains", Some(true));
        assert_eq!(cg.rows.iter().filter(|r| r.key_kind.as_deref() == Some("transaction")).count(), 2);
        let ts = run("tax_summary", None);
        assert_eq!(ts.rows.iter().find(|r| r.label == "Dividend Income").unwrap().cells[0].cents, Some(1000));
    }

    #[test]
    fn updating_holdings_from_a_statement_writes_the_difference_and_the_price() {
        let db = TestDb::new("stmt");
        let c = db.conn();
        let k = inv_account(&c, "401(k)", "retirement");
        let fund = create_security(&c, "Target Fund", "TGTF", "mutual_fund", None).unwrap();
        let bond = create_security(&c, "Bond Index", "BNDX", "mutual_fund", None).unwrap();
        create_investment_transaction(&c, &inv(&k, "2026-01-15", "buy", &fund.id, 100 * lots::MICRO, 250_000)).unwrap(); // $25
        let line = |sec: &str, sh: Option<i64>, p: Option<i64>, v: Option<i64>| StatementHolding { security_id: sec.to_string(), shares_micro: sh, price_micro: p, value_cents: v };

        // Statement: 112.5 TGTF at $26.40, and $1,000 of BNDX at $10 (a new holding).
        let lines = vec![line(&fund.id, Some(112_500_000), Some(26_400_000), None), line(&bond.id, None, Some(10_000_000), Some(100_000))];
        let plan = update_holdings(&c, &k, "2026-03-31", &lines, true).unwrap();
        assert_eq!(plan[0].delta_micro, 12_500_000);
        assert_eq!(plan[0].gross_cents, 33_000); // 12.5 x 26.40
        assert_eq!((plan[1].held_micro, plan[1].statement_micro, plan[1].gross_cents), (0, 100 * lots::MICRO, 100_000));
        assert!(plan.iter().all(|p| p.transaction_id.is_none() && p.problem.is_none()));
        assert_eq!(get_register(&c, &k).unwrap().len(), 1, "dry run wrote nothing");

        let done = update_holdings(&c, &k, "2026-03-31", &lines, false).unwrap();
        assert!(done.iter().all(|p| p.transaction_id.is_some()));
        let p = lots::portfolio(&c, Some(&k), "2026-03-31").unwrap();
        let by: Vec<(String, i64, i64)> = p.positions.iter().map(|x| (x.symbol.clone(), x.shares_micro, x.cost_cents)).collect();
        assert_eq!(by, vec![("BNDX".into(), 100 * lots::MICRO, 100_000), ("TGTF".into(), 112_500_000, 283_000)]);
        assert_eq!(lots::price_asof(&c, &fund.id, "2026-03-31").unwrap().map(|(p, d, _)| (p, d)), Some((26_400_000, "2026-03-31".to_string())));
        // No cash moved: a 401(k) contribution shows up as shares, not as a buy.
        assert_eq!(balance(&c, &k), -250_000);

        // Next statement: fewer shares (a fee) — Remove Shares, FIFO; value only, at the known price.
        let next = vec![line(&fund.id, None, None, Some(264_000))]; // $2,640 at $26.40 = 100 sh
        let r = update_holdings(&c, &k, "2026-06-30", &next, false).unwrap();
        assert_eq!((r[0].delta_micro, r[0].price_micro), (-12_500_000, 26_400_000));
        assert_eq!(lots::portfolio(&c, Some(&k), "2026-06-30").unwrap().positions.iter().find(|x| x.symbol == "TGTF").unwrap().shares_micro, 100 * lots::MICRO);
        // Same again: nothing to do, nothing written.
        let again = update_holdings(&c, &k, "2026-07-01", &vec![line(&fund.id, Some(100 * lots::MICRO), None, None)], false).unwrap();
        assert_eq!((again[0].delta_micro, again[0].transaction_id.is_none()), (0, true));
        // A value with no price anywhere is a problem, not a guess.
        let nop = create_security(&c, "Mystery", "", "stock", None).unwrap();
        let bad = update_holdings(&c, &k, "2026-07-01", &vec![line(&nop.id, None, None, Some(5_000))], true).unwrap();
        assert!(bad[0].problem.as_deref().unwrap_or("").contains("price"));
    }

    #[test]
    fn merging_a_duplicate_account_moves_its_rows_and_drops_what_the_survivor_has() {
        let db = TestDb::new("merge");
        let c = db.conn();
        let keep = account(&c, "Checking", 100_000); // opening balance row dated today
        let dup = account(&c, "Checking (2)", 100_000);
        let sav = account(&c, "Savings", 0);
        // Both hold the same March rent; only the duplicate has April's.
        create_transaction(&c, &keep, "2026-03-01", "Rent", None, -50_000, None, None).unwrap();
        create_transaction(&c, &dup, "2026-03-01", "rent", None, -50_000, None, None).unwrap();
        create_transaction(&c, &dup, "2026-04-01", "Rent", None, -50_000, None, None).unwrap();
        // A transfer between the two, and one from the duplicate to savings.
        create_transfer(&c, &keep, &dup, "2026-04-02", 10_000, None).unwrap();
        create_transfer(&c, &dup, &sav, "2026-04-03", 2_000, None).unwrap();
        // A recurrence and a goal that point at the duplicate.
        create_recurrence(&c, &NewRecurrence { payee: "Gym".into(), amount_cents: -4_000, account_id: Some(dup.clone()), category_id: None, freq: "monthly".into(), interval_n: 1, start_date: "2026-01-05".into(), end_date: None, second_day: None, weekend_rule: "none".into(), notes: None , transfer_account_id: None, goal_id: None,}).unwrap();
        create_goal(&c, "Roof", 1_000_000, 0, None, None, Some(&dup)).unwrap();
        let before = total_of_all_accounts(&c);

        assert!(merge_accounts(&c, &keep, &keep, false, false).is_err());
        // Dry run: the numbers, nothing changed.
        let plan = merge_accounts(&c, &keep, &dup, false, true).unwrap();
        assert_eq!((plan.moved, plan.duplicates, plan.self_transfers, plan.left_behind), (2, 1, 1, 1), "{plan:?}");
        assert_eq!((plan.recurrences, plan.goals), (1, 1));
        assert!(get_account(&c, &dup).is_ok());
        assert_eq!(balance(&c, &keep), 40_000);

        let done = merge_accounts(&c, &keep, &dup, false, false).unwrap();
        assert_eq!(done, plan);
        assert!(get_account(&c, &dup).is_err());
        // Survivor: opening 100,000 − rent 50,000 − rent 50,000 − 2,000 to savings.
        // The 10,000 self-transfer is gone from both sides, the duplicate's
        // opening balance stayed behind.
        assert_eq!(balance(&c, &keep), -2_000);
        assert_eq!(done.balance_cents, -2_000);
        let reg = get_register(&c, &keep).unwrap();
        assert_eq!(reg.len(), 4, "{:?}", reg.iter().map(|r| (&r.date, &r.payee, r.amount_cents)).collect::<Vec<_>>());
        // The transfer to savings still knows its partner.
        assert!(reg.iter().any(|r| r.amount_cents == -2_000 && r.transfer_account_id.is_some()));
        assert_eq!(balance(&c, &sav), 2_000);
        // The whole file lost exactly what was dropped: the duplicate's
        // opening balance and its copy of the March rent (the self-transfer nets to zero).
        assert_eq!(total_of_all_accounts(&c), before - 100_000 + 50_000);
        assert_eq!(get_goal(&c, &list_goals(&c).unwrap()[0].id).unwrap().account_id.as_deref(), Some(keep.as_str()));

        // after_last: only rows newer than the survivor's last row move.
        let keep2 = account(&c, "Visa", 0);
        let dup2 = account(&c, "Visa (2)", 0);
        create_transaction(&c, &keep2, "2026-05-10", "Fuel", None, -3_000, None, None).unwrap();
        create_transaction(&c, &dup2, "2026-05-09", "Older", None, -1_000, None, None).unwrap();
        create_transaction(&c, &dup2, "2026-05-10", "Same day", None, -1_000, None, None).unwrap();
        create_transaction(&c, &dup2, "2026-05-11", "Newer", None, -1_000, None, None).unwrap();
        let r = merge_accounts(&c, &keep2, &dup2, true, false).unwrap();
        assert_eq!((r.moved, r.left_behind, r.duplicates), (1, 2, 0), "{r:?}");
        assert_eq!(balance(&c, &keep2), -4_000);
    }

    // -----------------------------------------------------------------------
    // §38 — what the review found
    // -----------------------------------------------------------------------

    #[test]
    fn an_account_that_received_a_transfer_can_be_deleted() {
        // `transfer_id` references the other account's row with no ON DELETE
        // clause, so this failed with a raw FK error for any account that had
        // ever been on either end of a transfer.
        let db = TestDb::new("delete-transfer-account");
        let c = db.conn();
        let chk = account(&c, "Checking", 0);
        let sav = account(&c, "Savings", 0);
        create_transfer(&c, &chk, &sav, "2026-08-05", 20_000, None).expect("transfer");
        delete_account(&c, &sav).expect("delete");
        let rows = entered(&c, &chk);
        assert_eq!(rows.len(), 1, "the checking half must survive as an ordinary row");
        assert!(rows[0].transfer_account_id.is_none());
        assert_eq!(balance(&c, &chk), -20_000);
    }

    // §169 — the accounts come back in the order they were put in; the
    // unplaced ones after, by name, so a file that never arranged anything
    // reads as it did.
    #[test]
    fn accounts_list_in_the_order_they_were_placed_and_the_unplaced_by_name_after() {
        let db = TestDb::new("acct-order");
        let c = db.conn();
        let visa = account(&c, "Visa", 0);
        let chk = account(&c, "Checking", 100_000);
        let sav = account(&c, "Savings", 50_000);
        c.execute("UPDATE accounts SET is_favorite = 1 WHERE id IN (?1, ?2)", params![visa, sav]).unwrap();
        let names = |c: &Conn| get_all_accounts(c).unwrap().into_iter().map(|a| a.name).collect::<Vec<_>>();
        assert_eq!(names(&c), vec!["Checking", "Savings", "Visa"], "never placed: by name");
        assert!(get_all_accounts(&c).unwrap().iter().all(|a| a.sort_order.is_none()));

        assert_eq!(set_account_order(&c, &[visa.clone(), sav.clone(), "no-such-account".into()]).unwrap(), 2);
        assert_eq!(names(&c), vec!["Visa", "Savings", "Checking"], "placed first, in order; the unplaced after");
        let favs: Vec<String> = get_favorite_accounts(&c).unwrap().into_iter().map(|a| a.name).collect();
        assert_eq!(favs, vec!["Visa", "Savings"], "favorites follow the same order");
        let by_id = get_account(&c, &visa).unwrap();
        assert_eq!(by_id.sort_order, Some(0));
        assert_eq!(get_account(&c, &chk).unwrap().sort_order, None);

        set_account_order(&c, &[chk.clone(), visa.clone(), sav.clone()]).unwrap();
        assert_eq!(names(&c), vec!["Checking", "Visa", "Savings"]);
    }

    // ── §179 ─────────────────────────────────────────────────────────────

    fn loan_terms(acct: &str, from: Option<&str>, escrow: Option<&str>, apr_micro: i64) -> crate::models::LoanTerms {
        crate::models::LoanTerms {
            account_id: acct.to_string(),
            apr_micro,
            payment_cents: 130_000,
            escrow_cents: 0,
            extra_principal_cents: 0,
            escrow_account_id: escrow.map(str::to_string),
            escrow_category_id: None,
            interest_category_id: None,
            from_account_id: from.map(str::to_string),
            payment_day: Some(1),
            first_payment_date: None,
            term_months: Some(360),
            notes: None,
        }
    }

    /// §179 — every link to the duplicate is re-pointed before it is deleted.
    #[test]
    fn merging_a_duplicate_loan_carries_every_link_to_it() {
        let db = TestDb::new("merge-links");
        let c = db.conn();
        let chk = account(&c, "Checking", 1_000_000);
        let escrow = account(&c, "Escrow", 0);
        let keep = create_account(&c, "Mortgage", "mortgage", 0, Some("2026-01-01")).unwrap().id;
        let dup = create_account(&c, "Mortgage (2)", "mortgage", 0, Some("2026-01-01")).unwrap().id;
        let house = create_account(&c, "House", "home", 0, Some("2026-01-01")).unwrap().id;
        let (pay, principal, _) = split_payment(&c, &chk, &dup, &escrow, "2026-03-01");
        set_account_security(&c, &dup, Some(&house)).unwrap();
        crate::db::loans::set_terms(&c, &loan_terms(&dup, Some(&chk), None, 6_000_000)).unwrap();
        let rec = create_recurrence(&c, &NewRecurrence { transfer_account_id: Some(dup.clone()), ..bill(&chk, "Extra principal", -10_000, "2026-04-01") }).unwrap();
        create_payee_rule(&c, "SUMMIT HOME LOANS", "Summit Home Loans", None, &RuleConditions { account_id: Some(dup.clone()), ..Default::default() }).unwrap();
        add_attachment(&c, None, Some(&dup), "note.pdf", "application/pdf", b"%PDF-1.4").unwrap();

        let plan = merge_accounts(&c, &keep, &dup, false, true).unwrap();
        assert_eq!(plan.moved, 1, "the principal row moves");
        assert!(get_account(&c, &dup).is_ok(), "a dry run writes nothing");
        let done = merge_accounts(&c, &keep, &dup, false, false).unwrap();
        assert_eq!(done, plan);

        let line_to: Option<String> = c
            .query_row("SELECT transfer_account_id FROM splits WHERE transaction_id = ?1 AND transfer_txn_id = ?2", params![pay, principal], |r| r.get(0))
            .unwrap();
        assert_eq!(line_to.as_deref(), Some(keep.as_str()), "the principal line lost its account");
        assert_eq!(balance(&c, &keep), 80_000);
        // Principal is still a transfer, not uncategorized spending.
        let uncategorized_principal: i64 = c
            .query_row(&format!("{CATEGORY_LINES} SELECT COUNT(*) FROM lines WHERE txn_id = ?1 AND amount_cents = -80000"), params![pay], |r| r.get(0))
            .unwrap();
        assert_eq!(uncategorized_principal, 0);
        let rec_to = list_recurrences(&c).unwrap().into_iter().find(|r| r.id == rec.id).unwrap().transfer_account_id;
        assert_eq!(rec_to.as_deref(), Some(keep.as_str()), "the scheduled transfer became a plain bill");
        let terms = crate::db::loans::get_terms(&c, &keep).unwrap().expect("the loan terms were cascaded away");
        assert_eq!((terms.apr_micro, terms.from_account_id.as_deref()), (6_000_000, Some(chk.as_str())));
        assert_eq!(get_account(&c, &keep).unwrap().secured_by_account_id.as_deref(), Some(house.as_str()));
        let rule_acct: Option<String> = c.query_row("SELECT account_id FROM payee_rules", [], |r| r.get(0)).unwrap();
        assert_eq!(rule_acct.as_deref(), Some(keep.as_str()), "a rule scoped to the account now matched everywhere");
        assert_eq!(list_attachments(&c, None, Some(&keep)).unwrap().len(), 1);
        assert!(done.notes.is_empty(), "{:?}", done.notes);
        assert_consistent(&c);
    }

    #[test]
    fn merging_duplicate_checking_accounts_repoints_the_loan_and_refuses_a_line_that_would_pay_itself() {
        let db = TestDb::new("merge-self-line");
        let c = db.conn();
        let chk = account(&c, "Checking", 1_000_000);
        let dup = account(&c, "Checking (2)", 1_000_000);
        let loan = create_account(&c, "Mortgage", "mortgage", 0, Some("2026-01-01")).unwrap().id;
        crate::db::loans::set_terms(&c, &loan_terms(&loan, Some(&dup), Some(&dup), 6_000_000)).unwrap();
        // A payment in the duplicate with a line into the survivor, and one in
        // the survivor with a line into the duplicate: after a merge each
        // would transfer to its own account.
        let a = create_transaction(&c, &dup, "2026-03-01", "Move", None, -10_000, None, None).unwrap();
        set_splits(&c, &a.id, &[plain_line(-4_000, None), plain_line(-6_000, Some(&chk))]).unwrap();
        let b = create_transaction(&c, &chk, "2026-03-02", "Move back", None, -10_000, None, None).unwrap();
        set_splits(&c, &b.id, &[plain_line(-4_000, None), plain_line(-6_000, Some(&dup))]).unwrap();
        let before = (balance(&c, &chk), balance(&c, &dup));

        let err = merge_accounts(&c, &chk, &dup, false, true).unwrap_err();
        assert!(err.contains("Checking (2) cannot be merged into Checking: 2 split payments have a line"), "{err}");
        assert!(merge_accounts(&c, &chk, &dup, false, false).is_err());
        assert!(get_account(&c, &dup).is_ok());
        assert_eq!((balance(&c, &chk), balance(&c, &dup)), before);
        assert_consistent(&c);

        set_splits(&c, &a.id, &[]).unwrap();
        set_splits(&c, &b.id, &[]).unwrap();
        merge_accounts(&c, &chk, &dup, false, false).unwrap();
        let terms = crate::db::loans::get_terms(&c, &loan).unwrap().unwrap();
        assert_eq!(terms.from_account_id.as_deref(), Some(chk.as_str()));
        assert_eq!(terms.escrow_account_id.as_deref(), Some(chk.as_str()));
        assert_consistent(&c);
    }

    #[test]
    fn when_both_loans_have_terms_the_survivors_are_kept_and_the_merge_says_so() {
        let db = TestDb::new("merge-both-terms");
        let c = db.conn();
        let keep = create_account(&c, "Mortgage", "mortgage", 0, Some("2026-01-01")).unwrap().id;
        let dup = create_account(&c, "Mortgage (2)", "mortgage", 0, Some("2026-01-01")).unwrap().id;
        // The survivor names the duplicate as its escrow account: after the
        // merge that would be the loan itself, so it is let go.
        crate::db::loans::set_terms(&c, &loan_terms(&keep, None, Some(&dup), 6_000_000)).unwrap();
        crate::db::loans::set_terms(&c, &loan_terms(&dup, None, None, 7_000_000)).unwrap();
        create_recurrence(&c, &NewRecurrence { transfer_account_id: Some(dup.clone()), ..bill(&keep, "Shuffle", -10_000, "2026-04-01") }).unwrap();
        create_recurrence(&c, &NewRecurrence { transfer_account_id: Some(keep.clone()), ..bill(&dup, "Shuffle back", -10_000, "2026-04-02") }).unwrap();

        let plan = merge_accounts(&c, &keep, &dup, false, true).unwrap();
        assert_eq!(
            plan.notes,
            vec![
                "2 scheduled transfers between the two accounts removed.".to_string(),
                "Both accounts had loan terms; Mortgage's are kept.".to_string()
            ]
        );
        merge_accounts(&c, &keep, &dup, false, false).unwrap();
        let terms = crate::db::loans::get_terms(&c, &keep).unwrap().unwrap();
        assert_eq!((terms.apr_micro, terms.escrow_account_id), (6_000_000, None));
        assert!(list_recurrences(&c).unwrap().is_empty());
        assert!(verify_file(&c, false).unwrap().foreign_keys.is_empty());
    }

    /// §179 — "a transfer between the two accounts" also matched a §167
    /// exchange, whose two rows are both in the duplicate. Every reallocation
    /// was deleted, and the basis it carried with it.
    #[test]
    fn merging_a_retirement_account_keeps_the_reallocations_it_holds() {
        use crate::import::tsp::{REALLOC_IN, REALLOC_OUT};
        let db = TestDb::new("merge-exchange");
        let c = db.conn();
        let keep = inv_account(&c, "TSP", "retirement");
        let dup = inv_account(&c, "TSP (2)", "retirement");
        let g = create_security(&c, "TSP G Fund", "TSPG", "mutual_fund", None).unwrap();
        let cf = create_security(&c, "TSP C Fund", "TSPC", "mutual_fund", None).unwrap();
        let i = create_security(&c, "TSP I Fund", "TSPI", "mutual_fund", None).unwrap();
        let s = create_security(&c, "TSP S Fund", "TSPS", "mutual_fund", None).unwrap();
        create_investment_transaction(&c, &inv(&dup, "2024-01-10", "buy", &g.id, 100 * lots::MICRO, 100_000)).unwrap();
        create_investment_transaction(&c, &inv(&dup, "2025-01-10", "buy", &cf.id, 100 * lots::MICRO, 300_000)).unwrap();
        let row = |activity: &str, sec: &str, shares: i64, gross: i64, memo: &str| {
            let mut t = inv(&dup, "2026-03-01", activity, sec, shares, gross);
            t.notes = Some(memo.into());
            create_investment_transaction(&c, &t).unwrap()
        };
        row("remove_shares", &g.id, 100 * lots::MICRO, 500_000, REALLOC_OUT);
        row("remove_shares", &cf.id, 100 * lots::MICRO, 500_000, REALLOC_OUT);
        row("add_shares", &i.id, 300 * lots::MICRO, 600_000, REALLOC_IN);
        row("add_shares", &s.id, 100 * lots::MICRO, 400_000, REALLOC_IN);
        assert_eq!(link_same_day_exchanges(&c, &dup, REALLOC_OUT, REALLOC_IN).unwrap(), 4);

        let done = merge_accounts(&c, &keep, &dup, false, false).unwrap();
        assert_eq!((done.moved, done.self_transfers), (6, 0), "{done:?}");
        assert_eq!(get_register(&c, &keep).unwrap().iter().filter(|r| r.is_exchange).count(), 4);
        let l = lots::replay(&c, Some(&keep), None, None).unwrap();
        assert!(l.problems.is_empty(), "{:?}", l.problems);
        let cost_of = |sec: &str| l.lots.iter().filter(|x| x.security_id == sec).map(|x| x.cost_cents).sum::<i64>();
        assert_eq!((cost_of(&i.id), cost_of(&s.id)), (240_000, 160_000), "the basis followed the money");
        let v = verify_file(&c, false).unwrap();
        assert!(v.drift.is_empty() && v.half_transfers.is_empty() && v.foreign_keys.is_empty(), "{v:?}");
    }

    /// §179 — deleting an account a split payment still sends a line to turned
    /// years of principal into uncategorized spending.
    #[test]
    fn an_account_a_split_payment_still_pays_cannot_be_deleted() {
        let db = TestDb::new("delete-split-account");
        let c = db.conn();
        let chk = account(&c, "Checking", 1_000_000);
        let loan = account(&c, "Mortgage", 0);
        let escrow = account(&c, "Escrow", 0);
        let (pay, _, _) = split_payment(&c, &chk, &loan, &escrow, "2026-03-01");

        let err = delete_account(&c, &loan).unwrap_err();
        assert!(err.starts_with("Mortgage cannot be deleted: 1 split payment sends a line to it from another account"), "{err}");
        let err = delete_account(&c, &chk).unwrap_err();
        assert!(err.contains("1 split payment sends a line from it to another account"), "{err}");
        assert_eq!((balance(&c, &chk), balance(&c, &loan), balance(&c, &escrow)), (850_000, 80_000, 20_000));
        assert_consistent(&c);

        // Take the lines out of the split and the loan can go.
        set_splits(&c, &pay, &[]).unwrap();
        delete_account(&c, &loan).unwrap();
        assert!(get_account(&c, &loan).is_err());
        assert_consistent(&c);
    }

    /// §179 — a later revaluation that absorbs a difference follows its new
    /// sign, and goes when it comes to nothing; undo puts it back.
    #[test]
    fn a_revaluation_that_absorbs_a_difference_follows_its_sign_and_goes_at_zero() {
        let db = TestDb::new("revalue-absorb");
        let c = db.conn();
        let house = create_account(&c, "House", "home", 0, Some("2026-01-01")).unwrap().id;
        set_account_value(&c, &house, "2026-06-01", 30_000_000, None).unwrap();
        let dec = set_account_value(&c, &house, "2026-12-01", 31_000_000, None).unwrap().unwrap();
        let row = |id: &str| -> Option<(i64, String)> {
            c.query_row("SELECT amount_cents, payee FROM transactions WHERE id = ?1", params![id], |r| Ok((r.get(0)?, r.get(1)?)))
                .optional()
                .unwrap()
        };
        assert_eq!(row(&dec.id), Some((1_000_000, "Increase in value".to_string())));

        // September says $320,000: December's rise becomes a $10,000 fall.
        set_account_value(&c, &house, "2026-09-01", 32_000_000, None).unwrap();
        assert_eq!(row(&dec.id), Some((-1_000_000, "Decrease in value".to_string())));
        assert_eq!(balance(&c, &house), 31_000_000);

        // October says $310,000, which is what December says: December's row
        // moves nothing and goes. Recorded the way the command records it.
        let touched = vec![dec.id.clone()];
        let (made, step) = crate::db::undo::recording(&c, "update a value", &touched, || {
            set_account_value(&c, &house, "2026-10-01", 31_000_000, None)
        })
        .unwrap();
        let step = crate::db::undo::creation_step(&c, step, &made.unwrap().id, &touched).unwrap();
        assert_eq!(row(&dec.id), None, "a $0 revaluation stayed in the register");
        assert_eq!(balance(&c, &house), 31_000_000);
        assert!(get_register(&c, &house).unwrap().iter().all(|r| r.amount_cents != 0));

        crate::db::undo::restore(&c, &step.before, &[]).unwrap();
        assert_eq!(row(&dec.id), Some((-1_000_000, "Decrease in value".to_string())));
        assert_eq!(balance(&c, &house), 31_000_000);
        crate::db::undo::restore(&c, &step.after, &[]).unwrap();
        assert_eq!(row(&dec.id), None);
        assert!(verify_file(&c, false).unwrap().drift.is_empty());
    }
}
