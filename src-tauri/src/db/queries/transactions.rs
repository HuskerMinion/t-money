//! Transactions and transfers: the register, entering, editing, deleting and
//! voiding, same-day exchanges, and converting to and from a transfer.

use crate::models::{RegisterRow, Transaction};
use chrono::NaiveDate;
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;
use super::*;

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

pub fn get_transactions(
    conn: &Conn,
    account_id: &str,
    limit: Option<i64>,
) -> Result<Vec<Transaction>, String> {
    let limit = limit.unwrap_or(500).min(5000);
    let sql = format!(
        "SELECT id, account_id, date, payee, category_id, amount_cents, is_reconciled, notes
         FROM transactions WHERE account_id = ?1
         ORDER BY date DESC, rowid DESC LIMIT ?2"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let out = stmt
        .query_map(params![account_id, limit], map_txn)
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(out)
}

/// The account register: every transaction for the account in chronological
/// order with the running balance after each row (window function), plus the
/// category name joined in. This mirrors the MS Money register exactly.
pub fn get_register(conn: &Conn, account_id: &str) -> Result<Vec<RegisterRow>, String> {
    let sql = r#"
        SELECT t.id, t.date, t.payee, c.name, t.amount_cents,
               -- One pass, not a subquery per row (which was O(n²) and
               -- took seconds on a real account). Void rows contribute 0
               -- but keep their place in the sequence.
               SUM(CASE WHEN t.is_void = 0 THEN t.amount_cents ELSE 0 END)
                 OVER (ORDER BY t.date ASC, t.rowid ASC
                       ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
               AS running_balance,
               t.cleared_state = 'R' AS is_reconciled,
               t.cleared_state, t.check_number, t.is_void, t.notes,
               (SELECT a2.name
                  FROM transactions tp
                  JOIN accounts a2 ON a2.id = tp.account_id
                 WHERE tp.id = t.transfer_id) AS transfer_account_name,
               t.category_id,
               (SELECT tp.account_id FROM transactions tp WHERE tp.id = t.transfer_id)
                 AS transfer_account_id,
               t.activity, t.security_id, sec.name, t.shares_micro, t.price_micro,
               t.gross_cents, t.commission_cents,
               EXISTS(SELECT 1 FROM lot_allocations la WHERE la.sell_id = t.id) AS lot_specified,
               t.goal_id, g.name, t.tax_line,
               (SELECT p.account_id FROM transactions f JOIN transactions p ON p.id = f.transfer_id WHERE f.id = t.funding_txn_id) AS funding_account_id,
               t.is_revaluation,
               -- Linked to a row in THIS account — an exchange, not a transfer.
               COALESCE((SELECT tp.account_id = t.account_id FROM transactions tp WHERE tp.id = t.transfer_id), 0) AS is_exchange,
               -- The 📎 count.
               (SELECT COUNT(*) FROM attachments at WHERE at.transaction_id = t.id) AS attachment_count,
               -- A split line's far row, and the account of the payment
               -- that wrote it, so the edit form can say where to go before
               -- the user types a change the far-row rule would refuse. Only far rows pay
               -- for the lookup; the line is found through its
               -- transfer_account_id, which is indexed.
               t.is_split_transfer,
               CASE WHEN t.is_split_transfer = 1 THEN
                 (SELECT pa.name FROM splits s
                    JOIN transactions p ON p.id = s.transaction_id
                    JOIN accounts pa ON pa.id = p.account_id
                   WHERE s.transfer_account_id = t.account_id AND s.transfer_txn_id = t.id
                   LIMIT 1)
               END AS split_payment_account_name,
               (SELECT tp.amount_cents FROM transactions tp WHERE tp.id = t.transfer_id)
                 AS transfer_amount_cents
        FROM transactions t
        LEFT JOIN categories c ON c.id = t.category_id
        LEFT JOIN securities sec ON sec.id = t.security_id
        LEFT JOIN goals g ON g.id = t.goal_id
        WHERE t.account_id = ?1
        ORDER BY t.date ASC, t.rowid ASC
    "#;
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let out = stmt
        .query_map(params![account_id], |r| {
            Ok(RegisterRow {
                id: r.get(0)?,
                date: r.get(1)?,
                payee: r.get(2)?,
                category_name: r.get(3)?,
                amount_cents: r.get(4)?,
                running_balance_cents: r.get(5)?,
                is_reconciled: r.get::<_, i64>(6)? != 0,
                cleared_state: r.get(7)?,
                check_number: r.get(8)?,
                is_void: r.get::<_, i64>(9)? != 0,
                notes: r.get(10)?,
                transfer_account_name: r.get(11)?,
                category_id: r.get(12)?,
                transfer_account_id: r.get(13)?,
                activity: r.get(14)?,
                security_id: r.get(15)?,
                security_name: r.get(16)?,
                shares_micro: r.get(17)?,
                price_micro: r.get(18)?,
                gross_cents: r.get(19)?,
                commission_cents: r.get(20)?,
                lot_specified: r.get::<_, i64>(21)? != 0,
                goal_id: r.get(22)?,
                goal_name: r.get(23)?,
                tax_line: r.get(24)?,
                funding_account_id: r.get(25)?,
                is_revaluation: r.get::<_, i64>(26)? != 0,
                is_exchange: r.get::<_, i64>(27)? != 0,
                attachment_count: r.get(28)?,
                is_split_transfer: r.get::<_, i64>(29)? != 0,
                split_payment_account_name: r.get(30)?,
                transfer_amount_cents: r.get(31)?,
                classes: Vec::new(),
                line_classes: Vec::new(),
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<RegisterRow>, _>>()
        .map_err(|e| e.to_string())?;
    // One query for the account's classification picks, not one per row.
    // And one more for what the split lines say, on the axes the
    // transaction itself is silent about.
    let mut by = crate::db::classes::classes_by_transaction(conn, account_id)?;
    let mut by_line = crate::db::classes::line_classes_by_transaction(conn, account_id)?;
    let mut out = out;
    for r in out.iter_mut() {
        if let Some(c) = by.remove(&r.id) {
            r.classes = c;
        }
        if let Some(c) = by_line.remove(&r.id) {
            r.line_classes = c;
        }
    }
    Ok(out)
}

/// The body of `create_transaction`, for callers that already hold a SQL
/// transaction (`enter_occurrence`). Writes the row and the balance step;
/// returns the new id.
pub(super) fn insert_transaction(
    conn: &Connection,
    account_id: &str,
    date: &str,
    payee: &str,
    category_id: Option<&str>,
    amount_cents: i64,
    notes: Option<&str>,
    check_number: Option<&str>,
) -> Result<String, String> {
    parse_date(date)?;
    let id = Uuid::new_v4().to_string();
    let payee_id = payee_id_for(conn, payee, category_id)?;
    let check_number = check_number.map(str::trim).filter(|s| !s.is_empty());
    conn.execute(
        "INSERT INTO transactions
           (id, account_id, date, payee, payee_id, category_id, amount_cents,
            is_reconciled, notes, check_number)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9)",
        params![id, account_id, date, payee, payee_id, category_id, amount_cents, notes, check_number],
    )
    .map_err(|e| e.to_string())?;
    // Keep the account balance in sync.
    conn.execute(
        "UPDATE accounts SET balance_cents = balance_cents + ?1, updated_at = datetime('now')
         WHERE id = ?2",
        params![amount_cents, account_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

pub fn create_transaction(
    conn: &Conn,
    account_id: &str,
    date: &str,
    payee: &str,
    category_id: Option<&str>,
    amount_cents: i64,
    notes: Option<&str>,
    // Money's Num column: a check number, or a marker like ATM / EFT / DEP.
    // Free text, because that is what Money accepts. Blank is stored as NULL.
    check_number: Option<&str>,
) -> Result<Transaction, String> {
    // One SQL transaction: the payee upsert, the row and the balance move
    // together or not at all. `accounts.balance_cents` is maintained
    // incrementally and nothing recomputes it, so a row without its balance
    // step would be a permanent, silent drift.
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let id = insert_transaction(&tx, account_id, date, payee, category_id, amount_cents, notes, check_number)?;
    tx.commit().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT id, account_id, date, payee, category_id, amount_cents, is_reconciled, notes
         FROM transactions WHERE id = ?1",
        params![id],
        map_txn,
    )
    .map_err(|e| e.to_string())
}

/// Edit a transaction in place. The account balance is adjusted by the delta
/// (new amount − old amount) so it stays consistent.
///
/// Three things this refuses or handles, each of which used to corrupt the
/// balance quietly:
///
/// - **A voided row contributes nothing**, so changing its amount must not
///   move the balance. It did: void a −$50 row, edit it to −$60, and the
///   account dropped $10 for a transaction that "did not happen".
/// - **One half of a transfer** cannot be edited here — `update_transfer`
///   keeps the pair in step. Editing a half on its own desyncs the other
///   account.
/// - **A split transaction's amount is the sum of its lines.** Changing the
///   parent's amount without the lines would leave `splits` disagreeing with
///   the row, which `set_splits` promises can never happen. Refused; the
///   split dialog is where the total changes.
///
/// And a fourth: **the far row of a split transfer line** (the
/// principal row in the loan register) is the line's, not its own. Its
/// amount, date and category are what the line in the payment says, so a
/// change to any of them here is refused and pointed at the payment. Payee,
/// memo and Num stay editable: nothing checks them against the line, and
/// renaming "Summit Home Loans" to "Principal" in the loan's own register is a
/// reasonable thing to want. There is no account to change here — moving a
/// row between accounts is not something this function does.
///
/// A split parent's DATE is carried to its far rows, for the same reason: the
/// line and its row say one date, and `verify_file` reports them the moment
/// they do not.
pub fn update_transaction(
    conn: &Conn,
    id: &str,
    date: &str,
    payee: &str,
    category_id: Option<&str>,
    amount_cents: i64,
    notes: Option<&str>,
    check_number: Option<&str>,
) -> Result<Transaction, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    update_transaction_in(&tx, id, date, payee, category_id, amount_cents, notes, check_number)?;
    tx.commit().map_err(|e| e.to_string())?;

    conn.query_row(
        "SELECT id, account_id, date, payee, category_id, amount_cents, is_reconciled, notes
         FROM transactions WHERE id = ?1",
        params![id],
        map_txn,
    )
    .map_err(|e| e.to_string())
}

/// The body of `update_transaction`, inside a SQL transaction the
/// caller holds, so `update_transaction_with_splits` can refuse the edit and
/// take its split lines back with it.
#[allow(clippy::too_many_arguments)]
fn update_transaction_in(
    tx: &Connection,
    id: &str,
    date: &str,
    payee: &str,
    category_id: Option<&str>,
    amount_cents: i64,
    notes: Option<&str>,
    check_number: Option<&str>,
) -> Result<(), String> {
    parse_date(date)?;
    let (old_amount, account_id, is_void, transfer_id, activity, old_date, is_far): (i64, String, i64, Option<String>, Option<String>, String, i64) = tx
        .query_row(
            "SELECT amount_cents, account_id, is_void, transfer_id, activity, date, is_split_transfer
               FROM transactions WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
        )
        .map_err(|e| format!("transaction {id} not found: {e}"))?;
    if activity.is_some() {
        return Err(
            "this is an investment transaction — its amount follows from the shares and price, so edit it as one"
                .to_string(),
        );
    }
    if transfer_id.is_some() {
        return Err(
            "this is one half of a transfer — edit it as a transfer so both accounts stay in step"
                .to_string(),
        );
    }
    if is_far != 0 && (amount_cents != old_amount || date != old_date || category_id.is_some()) {
        return Err(far_row_refusal(tx, id, "edit the payment to change its amount, date or category")?);
    }
    if amount_cents != old_amount {
        let split_total: Option<i64> = tx
            .query_row(
                "SELECT SUM(amount_cents) FROM splits WHERE transaction_id = ?1",
                params![id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if let Some(total) = split_total {
            return Err(format!(
                "this transaction is split into lines totaling {}; change the split lines, not the total",
                crate::models::format_cents_in(total, &account_currency(tx, &account_id)?)
            ));
        }
    }

    let payee_id = payee_id_for(tx, payee, category_id)?;
    let check_number = check_number.map(str::trim).filter(|s| !s.is_empty());
    tx.execute(
        "UPDATE transactions
         SET date = ?1, payee = ?2, payee_id = ?3, category_id = ?4,
             amount_cents = ?5, notes = ?6, check_number = ?7
         WHERE id = ?8",
        params![date, payee, payee_id, category_id, amount_cents, notes, check_number, id],
    )
    .map_err(|e| e.to_string())?;
    if date != old_date {
        tx.execute(
            "UPDATE transactions SET date = ?2
              WHERE id IN (SELECT transfer_txn_id FROM splits WHERE transaction_id = ?1 AND transfer_txn_id IS NOT NULL)",
            params![id, date],
        )
        .map_err(|e| e.to_string())?;
    }

    let delta = if is_void != 0 { 0 } else { amount_cents - old_amount };
    if delta != 0 {
        tx.execute(
            "UPDATE accounts SET balance_cents = balance_cents + ?1, updated_at = datetime('now')
             WHERE id = ?2",
            params![delta, account_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The payment a split transfer line's far row belongs to, as the
/// refusal names it: "a split in Checking (Summit Home Loans, 03/01/2026)". None when
/// no line points at the row any more — the link was cut, and `verify_file`
/// is where that is reported.
fn split_payment_of(conn: &Connection, far_id: &str) -> Result<Option<String>, String> {
    let found: Option<(String, String, String)> = conn
        .query_row(
            "SELECT a.name, t.payee, t.date
               FROM splits s
               JOIN transactions t ON t.id = s.transaction_id
               JOIN accounts a ON a.id = t.account_id
              WHERE s.transfer_txn_id = ?1
              LIMIT 1",
            params![far_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(found.map(|(account, payee, date)| {
        let us = NaiveDate::parse_from_str(&date, "%Y-%m-%d")
            .map(crate::region::date)
            .unwrap_or(date);
        if payee.trim().is_empty() {
            format!("a split in {account} ({us})")
        } else {
            format!("a split in {account} ({payee}, {us})")
        }
    }))
}

/// The one shape every refusal on a far row takes, so the user is
/// sent to the same place — the payment — whichever button they pressed.
pub(super) fn far_row_refusal(conn: &Connection, far_id: &str, then: &str) -> Result<String, String> {
    Ok(match split_payment_of(conn, far_id)? {
        Some(payment) => format!("this row belongs to {payment} — {then}"),
        None => format!("this row was written by a split line in another account — {then}"),
    })
}

/// Delete a transaction and roll its amount back out of the account balance.
/// Delete a transaction. If it is one half of a transfer, **both** halves go —
/// a one-sided transfer would silently corrupt the other account's balance.
///
/// The far row of a split transfer line is refused. Deleting it would
/// leave the payment's line pointing at nothing (`ON DELETE SET NULL`) and
/// the loan paid down by a line with no row behind it; the payment is the
/// thing to delete or re-split. A far row no line points at any more is
/// allowed to go: nothing refers to it, and deleting it is how the "no
/// payment refers to" row `verify_file` reports is cleaned up.
pub fn delete_transaction(conn: &Conn, id: &str) -> Result<(), String> {
    let (raw_amount, account_id, transfer_id, is_void, activity, funding_txn): (i64, String, Option<String>, i64, Option<String>, Option<String>) = conn
        .query_row(
            "SELECT amount_cents, account_id, transfer_id, is_void, activity, funding_txn_id
             FROM transactions WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .map_err(|e| format!("transaction {id} not found: {e}"))?;
    if split_payment_of(conn, id)?.is_some() {
        return Err(far_row_refusal(conn, id, "delete the payment, or take this line out of its split")?);
    }
    if let Some(day) = exchange_day_of(conn, id)? {
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        delete_exchange_day_in(&tx, &day)?;
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(());
    }
    // A voided row was already removed from the balance when it was voided —
    // subtracting again here would double-count it.
    let amount = if is_void != 0 { 0 } else { raw_amount };

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    // If this row was a scheduled bill being entered, deleting it means the
    // bill was NOT paid: the occurrence goes back to due. The FK is `ON
    // DELETE SET NULL`, which would have kept a "paid" mark pointing at
    // nothing — the bill gone from Upcoming and the forecast, the money never
    // moved.
    //
    // Either half, and FIRST. A scheduled transfer's occurrence points
    // at the SENDING half (`enter_occurrence`). Deleting the transfer from the
    // savings register — the receiving half — deleted the sending half below,
    // `ON DELETE SET NULL` blanked the mark's link, and by the time this ran
    // there was nothing left to match: the transfer stayed "paid" and gone
    // from Upcoming although no money had moved.
    tx.execute(
        "DELETE FROM recurrence_exceptions WHERE transaction_id IN (?1, ?2) AND status = 'paid'",
        params![id, transfer_id],
    )
    .map_err(|e| e.to_string())?;

    // A split line that was a transfer wrote a row in another account.
    // Deleting the payment must take those with it, or the mortgage keeps a
    // principal reduction for a payment that no longer exists.
    delete_split_transfer_rows(&tx, id)?;

    // And a buy, sell or swept dividend takes its
    // funding pair with it. The cash that paid for the buy came from
    // somewhere; with the buy gone, that transfer describes nothing. Rows
    // from before 0027 that the backfill could not link are found the same
    // way the editor finds them.
    if activity.is_some() {
        let pair = match funding_txn {
            Some(f) => Some(f),
            None => legacy_funding_row(&tx, id)?,
        };
        if let Some(f) = pair {
            tx.execute("UPDATE transactions SET funding_txn_id = NULL WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
            delete_transfer_pair_in(&tx, &f)?;
        }
    }

    if let Some(other) = transfer_id.as_deref() {
        if let Some((other_amount, other_account)) = tx
            .query_row(
                "SELECT CASE WHEN is_void = 1 THEN 0 ELSE amount_cents END, account_id
                 FROM transactions WHERE id = ?1",
                params![other],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?
        {
            // Break the link first so the FK cannot block either delete.
            tx.execute(
                "UPDATE transactions SET transfer_id = NULL WHERE id IN (?1, ?2)",
                params![id, other],
            )
            .map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM transactions WHERE id = ?1", params![other])
                .map_err(|e| e.to_string())?;
            tx.execute(
                "UPDATE accounts SET balance_cents = balance_cents - ?1,
                        updated_at = datetime('now') WHERE id = ?2",
                params![other_amount, other_account],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    tx.execute("DELETE FROM transactions WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE accounts SET balance_cents = balance_cents - ?1, updated_at = datetime('now')
         WHERE id = ?2",
        params![amount, account_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Move money between two accounts as a single user action.
///
/// Writes TWO linked transactions in one SQL transaction: a withdrawal from
/// `from_account_id` and a matching deposit into `to_account_id`, each carrying
/// the other's id in `transfer_id`. `amount_cents` is treated as a magnitude —
/// the direction comes from the account arguments.
///
/// Transfers are internal movement, not spending: neither row gets a category,
/// so they never appear in a spending summary (transfers are
/// excluded from them). Returns the withdrawal side.
/// A NEW link into or out of a closed account is refused.
///
/// > "I see Demo Old Checking … in the transfer picker and I was able to
/// >  transfer to it. Account is closed is checked."
///
/// Closing an account is how its history is kept while it gets out of
/// the way; money moving into it afterwards is a mistake the pickers now
/// prevent and this catches from anywhere else. Only NEW links: a transfer
/// written before the account was closed still opens, edits and saves, so
/// every caller passes just the accounts a write would newly link. An
/// unknown id is left to the caller's own "does not exist" check.
pub(crate) fn refuse_new_link_to_closed(conn: &Connection, account_ids: &[&str]) -> Result<(), String> {
    for id in account_ids {
        let found: Option<(String, i64)> = conn
            .query_row("SELECT name, is_closed FROM accounts WHERE id = ?1", params![id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some((name, 1)) = found {
            return Err(format!(
                "{name} is closed — nothing new can be transferred into or out of it. \
                 Choose another account, or clear \"Account is closed\" in its details first."
            ));
        }
    }
    Ok(())
}

pub fn create_transfer(
    conn: &Conn,
    from_account_id: &str,
    to_account_id: &str,
    date: &str,
    amount_cents: i64,
    notes: Option<&str>,
) -> Result<Transaction, String> {
    if from_account_id == to_account_id {
        return Err("cannot transfer to the same account".to_string());
    }
    refuse_new_link_to_closed(conn, &[from_account_id, to_account_id])?;
    let magnitude = magnitude(amount_cents)?;

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let (from_id, _to_id) = insert_transfer_pair(&tx, from_account_id, to_account_id, date, magnitude, notes)?;
    tx.commit().map_err(|e| e.to_string())?;

    conn.query_row(
        "SELECT id, account_id, date, payee, category_id, amount_cents, is_reconciled, notes
         FROM transactions WHERE id = ?1",
        params![from_id],
        map_txn,
    )
    .map_err(|e| e.to_string())
}

/// A transfer that names an amount for each side: `sent` leaves `from` in
/// its currency and `received` arrives in `to` in its own. For two accounts
/// kept in different currencies; between two in one currency the amounts
/// must agree, and it is an ordinary `create_transfer`.
pub fn create_transfer_between(
    conn: &Conn,
    from_account_id: &str,
    to_account_id: &str,
    date: &str,
    sent_cents: i64,
    received_cents: i64,
    notes: Option<&str>,
) -> Result<Transaction, String> {
    let (sent, received) = (magnitude(sent_cents)?, magnitude(received_cents)?);
    if account_currency(conn, from_account_id)? == account_currency(conn, to_account_id)? {
        if sent != received {
            return Err("Both accounts are kept in the same currency, so the amount sent and the amount received must be the same.".to_string());
        }
        return create_transfer(conn, from_account_id, to_account_id, date, sent, notes);
    }
    if from_account_id == to_account_id {
        return Err("cannot transfer to the same account".to_string());
    }
    refuse_new_link_to_closed(conn, &[from_account_id, to_account_id])?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let (from_id, _) = insert_transfer_pair_amounts(&tx, from_account_id, to_account_id, date, sent, received, notes, "Transfer Money")?;
    tx.commit().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT id, account_id, date, payee, category_id, amount_cents, is_reconciled, notes
         FROM transactions WHERE id = ?1",
        params![from_id],
        map_txn,
    )
    .map_err(|e| e.to_string())
}

/// The currency an account is kept in.
pub(crate) fn account_currency(conn: &Connection, id: &str) -> Result<String, String> {
    conn.query_row("SELECT currency FROM accounts WHERE id = ?1", params![id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("account {id} not found"))
}

/// The two linked rows of a transfer, inside a transaction the caller holds.
/// `magnitude` is positive; the direction is the account order. Returns
/// (withdrawal id, deposit id).
pub(super) fn insert_transfer_pair(
    tx: &Connection,
    from_account_id: &str,
    to_account_id: &str,
    date: &str,
    magnitude: i64,
    notes: Option<&str>,
) -> Result<(String, String), String> {
    insert_transfer_pair_named(tx, from_account_id, to_account_id, date, magnitude, notes, "Transfer Money")
}

/// The pair with a payee of the caller's choosing — a scheduled transfer
/// keeps its rule's name ("401(k) contribution") so the register
/// says what it was.
pub(crate) fn insert_transfer_pair_named(
    tx: &Connection,
    from_account_id: &str,
    to_account_id: &str,
    date: &str,
    magnitude: i64,
    notes: Option<&str>,
    payee: &str,
) -> Result<(String, String), String> {
    // One amount for both sides is only right in one currency. Every caller
    // that names one amount — goals, investment cash, schedules, imports —
    // is refused across currencies here; `create_transfer_between` takes two.
    require_same_currency(tx, from_account_id, to_account_id, "Moving one amount")?;
    insert_transfer_pair_amounts(tx, from_account_id, to_account_id, date, magnitude, magnitude, notes, payee)
}

/// The pair with an amount for each side: `sent` leaves `from_account_id`
/// in its currency, `received` arrives in `to_account_id` in its own. Both
/// positive. Equal unless the accounts are kept in different currencies.
pub(crate) fn insert_transfer_pair_amounts(
    tx: &Connection,
    from_account_id: &str,
    to_account_id: &str,
    date: &str,
    sent: i64,
    received: i64,
    notes: Option<&str>,
    payee: &str,
) -> Result<(String, String), String> {
    let from_id = Uuid::new_v4().to_string();
    let to_id = Uuid::new_v4().to_string();

    // Insert BOTH rows with a null transfer_id first, then link them.
    // `transfer_id` is a self-referencing FK and `PRAGMA foreign_keys = ON`, so
    // writing the first row already pointing at the second would fail — the
    // target row does not exist yet.
    // A transfer has no category by construction, so the payee carries none
    // either — offering "Transfer Money" a default category would be wrong.
    let payee_id = payee_id_for(tx, payee, None)?;

    tx.execute(
        "INSERT INTO transactions
             (id, account_id, date, payee, payee_id, category_id, amount_cents,
              notes, transfer_id)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, NULL)",
        params![from_id, from_account_id, date, payee, payee_id, -sent, notes],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO transactions
             (id, account_id, date, payee, payee_id, category_id, amount_cents,
              notes, transfer_id)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, NULL)",
        params![to_id, to_account_id, date, payee, payee_id, received, notes],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("UPDATE transactions SET transfer_id = ?2 WHERE id = ?1", params![from_id, to_id])
        .map_err(|e| e.to_string())?;
    tx.execute("UPDATE transactions SET transfer_id = ?2 WHERE id = ?1", params![to_id, from_id])
        .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE accounts SET balance_cents = balance_cents - ?1, updated_at = datetime('now')
         WHERE id = ?2",
        params![sent, from_account_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE accounts SET balance_cents = balance_cents + ?1, updated_at = datetime('now')
         WHERE id = ?2",
        params![received, to_account_id],
    )
    .map_err(|e| e.to_string())?;
    Ok((from_id, to_id))
}

/// Edit an existing transfer in place — date, amount, notes, and **which
/// account the other half sits in**.
///
/// Previously the UI refused this and told the user to delete and re-enter,
/// on the grounds that editing one side would desync the other. That was a
/// shortcut, not a law: both halves are known, so both can be moved together.
/// Sending a transfer to the wrong account is one of the easiest mistakes to
/// make and re-entering it loses the reconcile state on the row.
///
/// `id` is the half the user is looking at; `amount_cents` is signed from
/// THAT side's point of view, so the register's Payment/Deposit boxes decide
/// the direction. The partner always takes the negation.
///
/// Every balance is unwound at its old value and re-applied at the new one,
/// so a change of account, amount, or both lands correctly. A **voided**
/// transfer contributes nothing to any balance, so its amounts are treated as
/// zero on both sides of the swap rather than special-cased at the end.
pub fn update_transfer(
    conn: &Conn,
    id: &str,
    date: &str,
    other_account_id: &str,
    amount_cents: i64,
    notes: Option<&str>,
) -> Result<Transaction, String> {
    update_transfer_amounts(conn, id, date, other_account_id, amount_cents, None, notes)
}

/// `update_transfer` with the amount on the OTHER side, for a transfer
/// between accounts kept in different currencies. `other_amount_cents` is a
/// magnitude in the other account's currency; its sign follows from
/// `amount_cents`. Between two accounts in one currency it must be None or
/// the same magnitude, and the partner takes the negation as always.
pub fn update_transfer_amounts(
    conn: &Conn,
    id: &str,
    date: &str,
    other_account_id: &str,
    amount_cents: i64,
    other_amount_cents: Option<i64>,
    notes: Option<&str>,
) -> Result<Transaction, String> {
    magnitude(amount_cents)?;
    if let Some(o) = other_amount_cents.filter(|o| *o != 0) {
        magnitude(o)?;
    }

    let (this_account, this_amount, transfer_id, is_void): (String, i64, Option<String>, i64) =
        conn.query_row(
            "SELECT account_id, amount_cents, transfer_id, is_void
             FROM transactions WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map_err(|e| format!("transaction {id} not found: {e}"))?;

    let other_id = transfer_id.ok_or_else(|| "this transaction is not a transfer".to_string())?;

    if other_account_id == this_account {
        return Err("cannot transfer to the same account".to_string());
    }

    let (other_account, other_amount): (String, i64) = conn
        .query_row(
            "SELECT account_id, amount_cents FROM transactions WHERE id = ?1",
            params![other_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| format!("the paired transaction is missing: {e}"))?;
    // Moving the other half to a different account is a new link, so
    // it may not land in (or leave from) a closed one. Keeping the account it
    // already has is not, even when that account has since been closed.
    if other_account_id != other_account {
        refuse_new_link_to_closed(conn, &[other_account_id, this_account.as_str()])?;
    }

    // What the partner row holds: the negation in one currency, or the
    // amount the other side names, signed the opposite way, across two.
    let this_currency = account_currency(conn, &this_account)?;
    let other_currency = account_currency(conn, other_account_id)?;
    let partner_amount = if this_currency == other_currency {
        if other_amount_cents.is_some_and(|o| o.abs() != amount_cents.abs()) {
            return Err("Both accounts are kept in the same currency, so the amount sent and the amount received must be the same.".to_string());
        }
        -amount_cents
    } else {
        match other_amount_cents.filter(|o| *o != 0) {
            Some(o) => -amount_cents.signum() * o.abs(),
            None => return Err(format!("Enter the amount in {other_currency} as well: the two accounts are kept in different currencies.")),
        }
    };

    // A voided transfer never contributed to a balance; unwinding it would
    // invent money. Re-applying is suppressed the same way.
    let (old_this, old_other, new_this, new_other) = if is_void != 0 {
        (0, 0, 0, 0)
    } else {
        (this_amount, other_amount, amount_cents, partner_amount)
    };

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    let adjust = |account: &str, delta: i64| -> Result<(), String> {
        if delta == 0 {
            return Ok(());
        }
        tx.execute(
            "UPDATE accounts SET balance_cents = balance_cents + ?1,
                    updated_at = datetime('now') WHERE id = ?2",
            params![delta, account],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    };

    // Unwind both halves at their old values, then re-apply at the new ones.
    // Done in that order so moving the partner between accounts is just two
    // ordinary adjustments rather than a special case.
    adjust(&this_account, -old_this)?;
    adjust(&other_account, -old_other)?;

    tx.execute(
        "UPDATE transactions SET date = ?2, amount_cents = ?3, notes = ?4 WHERE id = ?1",
        params![id, date, amount_cents, notes],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE transactions
            SET date = ?2, amount_cents = ?3, notes = ?4, account_id = ?5
          WHERE id = ?1",
        params![other_id, date, partner_amount, notes, other_account_id],
    )
    .map_err(|e| e.to_string())?;

    adjust(&this_account, new_this)?;
    adjust(other_account_id, new_other)?;

    tx.commit().map_err(|e| e.to_string())?;

    conn.query_row(
        "SELECT id, account_id, date, payee, category_id, amount_cents, is_reconciled, notes
         FROM transactions WHERE id = ?1",
        params![id],
        map_txn,
    )
    .map_err(|e| e.to_string())
}

/// A new transaction WITH its split lines, as one operation.
///
/// Enter on a split entry used to be two commands and therefore two undo
/// steps — "add a transaction", then "change a split" — so Ctrl+Z took the
/// lines off and left the row, which read as undo doing nothing. The row and
/// its lines are one thing the user did, so they are written together and
/// undone together. Lines that are refused take the row with them: one
/// Enter makes a row or it makes none.
///
/// One SQL transaction, not a create followed by a delete when the
/// lines were refused. The delete could itself fail and leave the row, and
/// in between the file held a row whose lines never arrived.
pub fn create_transaction_with_splits(conn: &Conn, p: &crate::models::NewTransaction) -> Result<Transaction, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let id = insert_transaction(
        &tx,
        &p.account_id,
        &p.date,
        &p.payee,
        p.category_id.as_deref(),
        p.amount_cents,
        p.notes.as_deref(),
        p.check_number.as_deref(),
    )?;
    if let Some(lines) = p.splits.as_deref().filter(|l| !l.is_empty()) {
        set_splits_in(&tx, &id, lines)?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    // Read back after the lines: they clear the category and may move the total.
    conn.query_row(
        "SELECT id, account_id, date, payee, category_id, amount_cents, is_reconciled, notes
         FROM transactions WHERE id = ?1",
        params![id],
        map_txn,
    )
    .map_err(|e| e.to_string())
}

/// An edit WITH its split lines, as one operation. The lines go first:
/// `set_splits` is the one call that may move a split row's total (the parent
/// follows its lines), and `update_transaction` refuses to change the amount
/// of a row that has lines, so the amount the edit then carries is already
/// the row's. `None` leaves the lines alone; `Some(empty)` clears them.
///
/// Both halves in ONE SQL transaction. The lines used to commit on
/// their own before the edit was checked, so an edit that was then refused
/// (a transfer half, a total that disagreed with the lines) left the new
/// lines — and their rows in other accounts — written anyway.
pub fn update_transaction_with_splits(conn: &Conn, p: &crate::models::UpdateTransaction) -> Result<Transaction, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    if let Some(lines) = p.splits.as_deref() {
        set_splits_in(&tx, &p.id, lines)?;
    }
    update_transaction_in(
        &tx,
        &p.id,
        &p.date,
        &p.payee,
        p.category_id.as_deref(),
        p.amount_cents,
        p.notes.as_deref(),
        p.check_number.as_deref(),
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT id, account_id, date, payee, category_id, amount_cents, is_reconciled, notes
         FROM transactions WHERE id = ?1",
        params![p.id],
        map_txn,
    )
    .map_err(|e| e.to_string())
}

/// Link a day's reallocation rows to each other as an EXCHANGE within
/// the account: every Add Shares row of the day points at its first Remove
/// Shares row, and every Remove Shares row at the first Add Shares row. The
/// lot engine reads a `transfer_id` that points into the same account as an
/// exchange and pools the day's lots (`lots::replay`), so the basis and the
/// dates of the shares that went out become the basis and dates of the
/// shares that came in.
///
/// Only rows carrying the given memos and not yet linked are touched, so
/// running it again does nothing. Returns how many rows were linked.
pub fn link_same_day_exchanges(conn: &Conn, account_id: &str, out_memo: &str, in_memo: &str) -> Result<usize, String> {
    let mut st = conn
        .prepare(
            "SELECT id, date, activity FROM transactions
              WHERE account_id = ?1 AND transfer_id IS NULL AND is_void = 0
                AND ((activity = 'remove_shares' AND notes = ?2) OR (activity = 'add_shares' AND notes = ?3))
              ORDER BY date, rowid",
        )
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, String)> = st
        .query_map(params![account_id, out_memo, in_memo], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    let mut by_day: std::collections::BTreeMap<String, (Vec<String>, Vec<String>)> = std::collections::BTreeMap::new();
    for (id, date, activity) in rows {
        let e = by_day.entry(date).or_default();
        if activity == "remove_shares" {
            e.0.push(id);
        } else {
            e.1.push(id);
        }
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut linked = 0;
    for (_, (outs, ins)) in by_day {
        let (Some(first_out), Some(first_in)) = (outs.first(), ins.first()) else { continue };
        for id in &ins {
            tx.execute("UPDATE transactions SET transfer_id = ?2 WHERE id = ?1", params![id, first_out]).map_err(|e| e.to_string())?;
            linked += 1;
        }
        for id in &outs {
            tx.execute("UPDATE transactions SET transfer_id = ?2 WHERE id = ?1", params![id, first_in]).map_err(|e| e.to_string())?;
            linked += 1;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(linked)
}

/// Every exchange row on the same account and day as `id`, when
/// `id` is one of them; `None` for any other row.
///
/// An exchange is not a pair. `link_same_day_exchanges` points every Add
/// Shares at the day's first Remove Shares and every Remove at the first
/// Add, so in a two-out, two-in reallocation three rows point at two. Delete
/// and void followed `transfer_id` as if it were a transfer's one partner:
/// deleting the second Add took the FIRST fund's Remove with it and then
/// failed the foreign key on the other Add still pointing there; voiding it
/// voided a Remove from a different fund.
///
/// WHY THE WHOLE DAY. The lot engine pools an exchange by (account, date)
/// and shares the pool out by the value each in-row brought, so the
/// day's rows are one event that has to add up — the reason the exchange rules already
/// refuse editing one of them. Removing a single row does not fail; it
/// silently moves basis from one fund to another, or turns an in-row into a
/// purchase at that day's price, which is exactly what those rules were built to
/// stop. Deleting or voiding an exchange therefore takes the day's exchange,
/// the same way deleting one half of a transfer takes both.
pub(crate) fn exchange_day_of(conn: &Connection, id: &str) -> Result<Option<Vec<String>>, String> {
    const EXCHANGE_ROWS: &str = "
        SELECT t.id FROM transactions t
         WHERE t.account_id = ?1 AND t.date = ?2
           AND t.activity IN ('add_shares', 'remove_shares')
           AND (EXISTS (SELECT 1 FROM transactions p WHERE p.id = t.transfer_id AND p.account_id = t.account_id)
                OR EXISTS (SELECT 1 FROM transactions q WHERE q.transfer_id = t.id AND q.account_id = t.account_id))
         ORDER BY t.rowid";
    let Some((account, date)) = conn
        .query_row("SELECT account_id, date FROM transactions WHERE id = ?1", params![id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .optional()
        .map_err(|e| e.to_string())?
    else {
        return Ok(None);
    };
    let mut st = conn.prepare(EXCHANGE_ROWS).map_err(|e| e.to_string())?;
    let rows = st
        .query_map(params![account, date], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<String>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows.iter().any(|r| r == id).then_some(rows))
}

/// Delete a day's exchange rows, inside the caller's transaction.
/// Every link pointing at any of them is cut first, so the order of the
/// deletes cannot trip the foreign key however the day was linked.
fn delete_exchange_day_in(tx: &Connection, ids: &[String]) -> Result<(), String> {
    for id in ids {
        tx.execute(
            "DELETE FROM recurrence_exceptions WHERE status = 'paid' AND transaction_id = ?1",
            params![id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("UPDATE transactions SET transfer_id = NULL WHERE id = ?1 OR transfer_id = ?1", params![id])
            .map_err(|e| e.to_string())?;
    }
    for id in ids {
        let (amount, account): (i64, String) = tx
            .query_row(
                "SELECT CASE WHEN is_void = 1 THEN 0 ELSE amount_cents END, account_id FROM transactions WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM transactions WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE accounts SET balance_cents = balance_cents - ?1, updated_at = datetime('now') WHERE id = ?2",
            params![amount, account],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Turn an ordinary transaction into a transfer to `other_account_id`.
///
/// A bank file cannot say where a transfer went: the row arrives as a plain
/// transaction, with the bank's own "Transfer" as its category, and the only
/// way to make it a real transfer was to delete it and enter the pair by hand,
/// losing its cleared state and whatever else had been typed on it.
/// This writes the partner row in the other account, links the two, clears
/// this row's category (a transfer has none), and moves the other account's
/// balance. This account's balance already carries the row.
///
/// The row keeps its payee, date, notes, Num and cleared mark; the partner
/// takes the same payee and notes, the negated amount, and is void if this
/// row is. Refused: a row that is already a transfer, an investment row, a
/// split row (its lines can be transfers themselves), a zero amount,
/// and the same account. And the far row of a split transfer line — it
/// is already the other side of a transfer, the payment's, and a second
/// partner would move the money twice.
pub fn convert_to_transfer(conn: &Conn, id: &str, other_account_id: &str) -> Result<Transaction, String> {
    let (this_account, amount, date, payee, payee_id, notes, transfer_id, is_void, activity, lines, is_far): (
        String, i64, String, String, Option<String>, Option<String>, Option<String>, i64, Option<String>, i64, i64,
    ) = conn
        .query_row(
            "SELECT account_id, amount_cents, date, payee, payee_id, notes, transfer_id, is_void, activity,
                    (SELECT COUNT(*) FROM splits s WHERE s.transaction_id = t.id), is_split_transfer
               FROM transactions t WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?, r.get(10)?)),
        )
        .map_err(|e| format!("transaction {id} not found: {e}"))?;
    if transfer_id.is_some() {
        return Err("this transaction is already a transfer — edit it as one".to_string());
    }
    if is_far != 0 {
        return Err(far_row_refusal(conn, id, "it is already a transfer from that payment's split line")?);
    }
    if activity.is_some() {
        return Err("an investment transaction cannot become a transfer".to_string());
    }
    if lines > 0 {
        return Err("a split transaction cannot become a transfer — make one of its lines the transfer instead".to_string());
    }
    if other_account_id == this_account {
        return Err("cannot transfer to the same account".to_string());
    }
    if amount == 0 {
        return Err("transfer amount must not be zero".to_string());
    }
    let exists: i64 = conn
        .query_row("SELECT COUNT(*) FROM accounts WHERE id = ?1", params![other_account_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if exists == 0 {
        return Err("the other account does not exist".to_string());
    }
    // Becoming a transfer writes a new row in the other account.
    refuse_new_link_to_closed(conn, &[other_account_id, this_account.as_str()])?;
    // The new row would carry the same amount, which is only right in one
    // currency. Across two, the transfer has to be entered with both amounts.
    require_same_currency(conn, &this_account, other_account_id, "Turning an entry into a transfer")?;

    let other_id = Uuid::new_v4().to_string();
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO transactions
             (id, account_id, date, payee, payee_id, category_id, amount_cents, notes, transfer_id, is_void)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, NULL, ?8)",
        params![other_id, other_account_id, date, payee, payee_id, -amount, notes, is_void],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE transactions SET transfer_id = ?2, category_id = NULL WHERE id = ?1",
        params![id, other_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("UPDATE transactions SET transfer_id = ?2 WHERE id = ?1", params![other_id, id])
        .map_err(|e| e.to_string())?;
    if is_void == 0 {
        tx.execute(
            "UPDATE accounts SET balance_cents = balance_cents + ?1, updated_at = datetime('now') WHERE id = ?2",
            params![-amount, other_account_id],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;

    conn.query_row(
        "SELECT id, account_id, date, payee, category_id, amount_cents, is_reconciled, notes
         FROM transactions WHERE id = ?1",
        params![id],
        map_txn,
    )
    .map_err(|e| e.to_string())
}

/// The reverse: a transfer becomes an ordinary transaction in THIS
/// account, filed under `category_id` (or nothing). The partner row is
/// deleted and its account's balance unwound; this row keeps everything else
/// it had. Refused on a row that is not a transfer.
pub fn convert_from_transfer(conn: &Conn, id: &str, category_id: Option<&str>) -> Result<Transaction, String> {
    let (transfer_id, is_void): (Option<String>, i64) = conn
        .query_row("SELECT transfer_id, is_void FROM transactions WHERE id = ?1", params![id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| format!("transaction {id} not found: {e}"))?;
    let other_id = transfer_id.ok_or_else(|| "this transaction is not a transfer".to_string())?;
    if let Some(c) = category_id {
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM categories WHERE id = ?1", params![c], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("that category does not exist".to_string());
        }
    }
    let (other_account, other_amount): (String, i64) = conn
        .query_row("SELECT account_id, amount_cents FROM transactions WHERE id = ?1", params![other_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| format!("the paired transaction is missing: {e}"))?;

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // Unlink first: `transfer_id` is a self-referencing FK, so the partner
    // cannot go while this row still points at it.
    tx.execute("UPDATE transactions SET transfer_id = NULL, category_id = ?2 WHERE id = ?1", params![id, category_id])
        .map_err(|e| e.to_string())?;
    tx.execute("UPDATE transactions SET transfer_id = NULL WHERE id = ?1", params![other_id])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM transactions WHERE id = ?1", params![other_id]).map_err(|e| e.to_string())?;
    if is_void == 0 {
        tx.execute(
            "UPDATE accounts SET balance_cents = balance_cents - ?1, updated_at = datetime('now') WHERE id = ?2",
            params![other_amount, other_account],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;

    conn.query_row(
        "SELECT id, account_id, date, payee, category_id, amount_cents, is_reconciled, notes
         FROM transactions WHERE id = ?1",
        params![id],
        map_txn,
    )
    .map_err(|e| e.to_string())
}

/// Void or un-void a transaction.
///
/// The row stays exactly as it is — date, payee, amount, category — but stops
/// counting. `accounts.balance_cents` is maintained incrementally, so voiding
/// subtracts the amount and un-voiding adds it back; every read path filters on
/// `is_void = 0` so nothing counts it twice.
///
/// Both halves of a transfer are voided together, for the same reason both are
/// deleted together: a one-sided void silently corrupts the other account.
///
/// And so are the far rows of a split payment's transfer lines,
/// which `transfer_id` does not reach: voiding a mortgage payment in checking
/// used to leave the principal paid off the loan and the escrow sitting in
/// the escrow account. Every row is set to
/// the requested state only if it is not in it already, so un-voiding a
/// payment whose lines were re-split while it was void — `set_splits` writes
/// those far rows void — brings them back with it.
///
/// Voiding a far row on its own is refused, pointing at the payment. Routing
/// the void to the payment was the other choice, and it is how a transfer
/// half behaves, but a transfer half IS the whole transfer seen from one
/// side; the principal row in the loan register is one line of a payment
/// that also paid interest and escrow, and voiding "this row" should not
/// quietly void two others the user is not looking at.
pub fn set_void(conn: &Conn, id: &str, is_void: bool) -> Result<(), String> {
    let transfer_id: Option<String> = conn
        .query_row("SELECT transfer_id FROM transactions WHERE id = ?1", params![id], |r| r.get(0))
        .map_err(|e| format!("transaction {id} not found: {e}"))?;
    if split_payment_of(conn, id)?.is_some() {
        let then = if is_void { "void the payment instead" } else { "un-void the payment instead" };
        return Err(far_row_refusal(conn, id, then)?);
    }

    // The row, its transfer partner, and the far rows of its split lines.
    // Or, for an exchange row, the day's exchange: its
    // `transfer_id` names the day's first row of the other kind, which may
    // be another fund's (see `exchange_day_of`).
    let mut ids: Vec<String> = vec![id.to_string()];
    match exchange_day_of(conn, id)? {
        Some(day) => ids = day,
        None => ids.extend(transfer_id),
    }
    {
        let mut st = conn
            .prepare("SELECT transfer_txn_id FROM splits WHERE transaction_id = ?1 AND transfer_txn_id IS NOT NULL")
            .map_err(|e| e.to_string())?;
        let far: Vec<String> = st
            .query_map(params![id], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        ids.extend(far);
    }

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for txn_id in &ids {
        let Some((amount, account, already)) = tx
            .query_row(
                "SELECT amount_cents, account_id, is_void FROM transactions WHERE id = ?1",
                params![txn_id],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?
        else {
            continue;
        };
        if (already != 0) == is_void {
            continue; // already in the requested state — nothing to adjust
        }
        tx.execute(
            "UPDATE transactions SET is_void = ?2 WHERE id = ?1",
            params![txn_id, is_void as i64],
        )
        .map_err(|e| e.to_string())?;
        // Voiding removes the amount from the balance; un-voiding restores it.
        let delta = if is_void { -amount } else { amount };
        tx.execute(
            "UPDATE accounts SET balance_cents = balance_cents + ?1,
                    updated_at = datetime('now') WHERE id = ?2",
            params![delta, account],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::models::NewSplit;
    use rusqlite::params;
    use super::*;
    use crate::db::queries::test_support::*;

    // ── ordinary transactions ────────────────────────────────────────────

    #[test]
    fn create_transaction_moves_the_balance_and_records_the_payee() {
        let db = TestDb::new("create-txn");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);

        create_transaction(&c, &acct, "2026-08-01", "Kroger", None, -4_250, None, None)
            .expect("create_transaction");

        assert_eq!(balance(&c, &acct), 95_750);

        // Every write path must maintain payee_id — the bug this
        // assertion exists to catch left it NULL for a month.
        let payees = list_payees(&c).expect("list_payees");
        assert_eq!(payees.len(), 1);
        assert_eq!(payees[0].name, "Kroger");
        assert_eq!(payees[0].usage_count, 1, "payee_id was not written");
    }

    #[test]
    fn update_transaction_applies_only_the_difference() {
        let db = TestDb::new("update-txn");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        let txn = create_transaction(&c, &acct, "2026-08-01", "Kroger", None, -4_250, None, None)
            .expect("create");

        update_transaction(&c, &txn.id, "2026-08-01", "Kroger", None, -5_000, None, None)
            .expect("update");

        // 100000 - 5000, NOT 100000 - 4250 - 5000.
        assert_eq!(balance(&c, &acct), 95_000);
    }

    #[test]
    fn delete_transaction_puts_the_money_back() {
        let db = TestDb::new("delete-txn");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        let txn = create_transaction(&c, &acct, "2026-08-01", "Kroger", None, -4_250, None, None)
            .expect("create");

        delete_transaction(&c, &txn.id).expect("delete");
        assert_eq!(balance(&c, &acct), 100_000);
    }

    #[test]
    fn voiding_removes_the_amount_and_un_voiding_restores_it() {
        let db = TestDb::new("void");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        let txn = create_transaction(&c, &acct, "2026-08-01", "Fraud", None, -9_900, None, None)
            .expect("create");
        assert_eq!(balance(&c, &acct), 90_100);

        set_void(&c, &txn.id, true).expect("void");
        assert_eq!(balance(&c, &acct), 100_000);

        // Voiding twice must not double-count.
        set_void(&c, &txn.id, true).expect("void again");
        assert_eq!(balance(&c, &acct), 100_000);

        set_void(&c, &txn.id, false).expect("un-void");
        assert_eq!(balance(&c, &acct), 90_100);
    }

    #[test]
    fn deleting_a_voided_transaction_does_not_double_refund() {
        let db = TestDb::new("void-delete");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        let txn = create_transaction(&c, &acct, "2026-08-01", "Fraud", None, -9_900, None, None)
            .expect("create");
        set_void(&c, &txn.id, true).expect("void");
        assert_eq!(balance(&c, &acct), 100_000);

        delete_transaction(&c, &txn.id).expect("delete");
        assert_eq!(balance(&c, &acct), 100_000, "the void was refunded twice");
    }

    // ── transfers ────────────────────────────────────────────────────────

    #[test]
    fn create_transfer_moves_money_without_changing_the_total() {
        let db = TestDb::new("transfer-create");
        let c = db.conn();
        let chk = account(&c, "Checking", 100_000);
        let sav = account(&c, "Savings", 50_000);
        let before = total_of_all_accounts(&c);

        create_transfer(&c, &chk, &sav, "2026-08-01", 25_000, None).expect("transfer");

        assert_eq!(balance(&c, &chk), 75_000);
        assert_eq!(balance(&c, &sav), 75_000);
        assert_eq!(total_of_all_accounts(&c), before, "a transfer invented money");
    }

    #[test]
    fn update_transfer_can_move_the_other_half_to_a_different_account() {
        let db = TestDb::new("transfer-move");
        let c = db.conn();
        let chk = account(&c, "Checking", 100_000);
        let sav = account(&c, "Savings", 50_000);
        let vac = account(&c, "Vacation", 7_000);
        let before = total_of_all_accounts(&c);

        create_transfer(&c, &chk, &sav, "2026-08-01", 25_000, None).expect("transfer");
        let this_half = entered(&c, &chk)[0].id.clone();

        update_transfer(&c, &this_half, "2026-08-01", &vac, -25_000, None).expect("update");

        assert_eq!(balance(&c, &sav), 50_000, "savings was not put back");
        assert_eq!(balance(&c, &vac), 32_000, "vacation did not receive it");
        assert_eq!(balance(&c, &chk), 75_000, "the edited side should not move");
        assert_eq!(total_of_all_accounts(&c), before);
    }

    #[test]
    fn update_transfer_changes_the_amount_on_both_halves() {
        let db = TestDb::new("transfer-amount");
        let c = db.conn();
        let chk = account(&c, "Checking", 100_000);
        let sav = account(&c, "Savings", 50_000);
        let before = total_of_all_accounts(&c);

        create_transfer(&c, &chk, &sav, "2026-08-01", 25_000, None).expect("transfer");
        let this_half = entered(&c, &chk)[0].id.clone();

        update_transfer(&c, &this_half, "2026-08-02", &sav, -40_000, None).expect("update");

        assert_eq!(balance(&c, &chk), 60_000);
        assert_eq!(balance(&c, &sav), 90_000);
        assert_eq!(total_of_all_accounts(&c), before);
    }

    #[test]
    fn editing_a_transfer_back_restores_the_original_balances() {
        let db = TestDb::new("transfer-roundtrip");
        let c = db.conn();
        let chk = account(&c, "Checking", 100_000);
        let sav = account(&c, "Savings", 50_000);
        let vac = account(&c, "Vacation", 7_000);

        create_transfer(&c, &chk, &sav, "2026-08-01", 25_000, None).expect("transfer");
        let this_half = entered(&c, &chk)[0].id.clone();
        let after_create = (
            balance(&c, &chk),
            balance(&c, &sav),
            balance(&c, &vac),
        );

        update_transfer(&c, &this_half, "2026-08-05", &vac, -40_000, None).expect("away");
        update_transfer(&c, &this_half, "2026-08-01", &sav, -25_000, None).expect("back");

        assert_eq!(
            (balance(&c, &chk), balance(&c, &sav), balance(&c, &vac)),
            after_create,
            "a round trip did not return to where it started"
        );
    }

    #[test]
    fn update_transfer_on_a_voided_transfer_moves_no_money() {
        let db = TestDb::new("transfer-void");
        let c = db.conn();
        let chk = account(&c, "Checking", 100_000);
        let sav = account(&c, "Savings", 50_000);

        create_transfer(&c, &chk, &sav, "2026-08-01", 25_000, None).expect("transfer");
        let this_half = entered(&c, &chk)[0].id.clone();
        set_void(&c, &this_half, true).expect("void");
        let frozen = (balance(&c, &chk), balance(&c, &sav));

        update_transfer(&c, &this_half, "2026-09-01", &sav, -99_999, None).expect("update");

        assert_eq!(
            (balance(&c, &chk), balance(&c, &sav)),
            frozen,
            "editing a voided transfer changed a balance"
        );
    }

    #[test]
    fn update_transfer_refuses_the_same_account_and_a_zero_amount() {
        let db = TestDb::new("transfer-refuse");
        let c = db.conn();
        let chk = account(&c, "Checking", 100_000);
        let sav = account(&c, "Savings", 50_000);
        create_transfer(&c, &chk, &sav, "2026-08-01", 25_000, None).expect("transfer");
        let this_half = entered(&c, &chk)[0].id.clone();

        assert!(update_transfer(&c, &this_half, "2026-08-01", &chk, -25_000, None).is_err());
        assert!(update_transfer(&c, &this_half, "2026-08-01", &sav, 0, None).is_err());
    }

    #[test]
    fn deleting_one_half_of_a_transfer_deletes_both() {
        let db = TestDb::new("transfer-delete");
        let c = db.conn();
        let chk = account(&c, "Checking", 100_000);
        let sav = account(&c, "Savings", 50_000);
        let before = total_of_all_accounts(&c);

        create_transfer(&c, &chk, &sav, "2026-08-01", 25_000, None).expect("transfer");
        let this_half = entered(&c, &chk)[0].id.clone();

        delete_transaction(&c, &this_half).expect("delete");

        // A one-sided delete would leave the other account permanently wrong.
        assert!(entered(&c, &chk).is_empty());
        assert!(entered(&c, &sav).is_empty());
        assert_eq!(balance(&c, &chk), 100_000);
        assert_eq!(balance(&c, &sav), 50_000);
        assert_eq!(total_of_all_accounts(&c), before);
    }

    // ── the register ─────────────────────────────────────────────────────

    #[test]
    fn get_register_scales_to_a_real_history() {
        let db = TestDb::new("register-scale");
        let c = db.conn();
        let acct = account(&c, "Checking", 0);
        let n = 20_000;
        let tx = c.unchecked_transaction().unwrap();
        {
            let mut ins = tx
                .prepare("INSERT INTO transactions (id, account_id, date, payee, amount_cents, is_void) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
                .unwrap();
            let mut seed: u64 = 0x9E3779B97F4A7C15;
            for i in 0..n {
                seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17;
                let day = (seed % 730) as i64; // two years, out of order
                let date = chrono::NaiveDate::from_ymd_opt(2024, 1, 1).unwrap() + chrono::Days::new(day as u64);
                let amount = ((seed >> 20) % 200_000) as i64 - 100_000;
                let void = (seed >> 40) % 50 == 0;
                ins.execute(params![format!("t{i}"), acct, date.to_string(), "Payee", amount, void as i64]).unwrap();
            }
        }
        // Raw inserts move no balance, so the account is brought up to
        // its rows the way `create_transaction` would have kept it.
        tx.execute(
            "UPDATE accounts SET balance_cents = (SELECT COALESCE(SUM(amount_cents), 0) FROM transactions WHERE account_id = ?1 AND is_void = 0) WHERE id = ?1",
            params![acct],
        )
        .unwrap();
        tx.commit().unwrap();
        let t0 = std::time::Instant::now();
        let rows = get_register(&c, &acct).unwrap();
        let elapsed = t0.elapsed();
        eprintln!("get_register over {n} rows: {elapsed:?}");
        assert_eq!(rows.len(), n, "opening balance 0 writes no row");
        let mut running = 0i64;
        for (i, r) in rows.iter().enumerate() {
            if !r.is_void {
                running += r.amount_cents;
            }
            assert_eq!(r.running_balance_cents, running, "row {i} ({})", r.date);
            if i > 0 {
                assert!(rows[i - 1].date <= r.date, "date order");
            }
        }
        assert!(elapsed.as_secs() < 5, "the register took {elapsed:?} for {n} rows — the running balance has gone quadratic again");
    }

    #[test]
    fn get_register_running_balance_accumulates_in_date_order() {
        let db = TestDb::new("register");
        let c = db.conn();
        let acct = account(&c, "Checking", 0);
        create_transaction(&c, &acct, "2026-08-01", "Pay", None, 200_000, None, None).expect("a");
        create_transaction(&c, &acct, "2026-08-02", "Rent", None, -120_000, None, None).expect("b");
        create_transaction(&c, &acct, "2026-08-03", "Food", None, -5_000, None, None).expect("c");

        let rows = get_register(&c, &acct).expect("register");
        let running: Vec<i64> = rows.iter().map(|r| r.running_balance_cents).collect();
        assert_eq!(running, vec![200_000, 80_000, 75_000]);
        assert_eq!(*running.last().unwrap(), balance(&c, &acct));
    }

    #[test]
    fn a_voided_row_stays_in_the_register_but_leaves_the_running_balance_alone() {
        let db = TestDb::new("register-void");
        let c = db.conn();
        let acct = account(&c, "Checking", 0);
        create_transaction(&c, &acct, "2026-08-01", "Pay", None, 200_000, None, None).expect("a");
        let bad = create_transaction(&c, &acct, "2026-08-02", "Fraud", None, -50_000, None, None)
            .expect("b");
        create_transaction(&c, &acct, "2026-08-03", "Food", None, -5_000, None, None).expect("c");
        set_void(&c, &bad.id, true).expect("void");

        let rows = get_register(&c, &acct).expect("register");
        assert_eq!(rows.len(), 3, "the voided row should still be visible");
        assert_eq!(
            rows.iter().map(|r| r.running_balance_cents).collect::<Vec<_>>(),
            vec![200_000, 200_000, 195_000]
        );
    }

    // ── the Num column (check_number) ────────────────────────────────────
    //
    // The column landed in migration 0011 and `RegisterGrid` has rendered it
    // ever since, but nothing could ever set it — no command, payload or form
    // field. These pin the write path now that it exists.

    fn num_of(conn: &Conn, account_id: &str, txn_id: &str) -> Option<String> {
        get_register(conn, account_id)
            .expect("register")
            .into_iter()
            .find(|r| r.id == txn_id)
            .expect("row in register")
            .check_number
    }

    #[test]
    fn a_check_number_round_trips_to_the_register() {
        let db = TestDb::new("num-create");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);

        let txn = create_transaction(
            &c, &acct, "2026-08-01", "Kroger", None, -4_250, None, Some("1042"),
        )
        .expect("create");

        assert_eq!(num_of(&c, &acct, &txn.id).as_deref(), Some("1042"));
    }

    #[test]
    fn the_num_field_is_free_text_not_a_number() {
        // Money accepts ATM, EFT, DEP, Print and similar in this column, so
        // storing it as an INTEGER would have been wrong.
        let db = TestDb::new("num-text");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);

        let txn = create_transaction(
            &c, &acct, "2026-08-01", "Cash", None, -2_000, None, Some("ATM"),
        )
        .expect("create");

        assert_eq!(num_of(&c, &acct, &txn.id).as_deref(), Some("ATM"));
    }

    #[test]
    fn a_blank_num_is_stored_as_null_rather_than_an_empty_string() {
        // The form always sends a string. Without the trim-and-filter, every
        // transaction entered without a check number would store "" and the
        // register would render an empty cell that is not actually empty —
        // and `check_number IS NULL` filters would quietly stop working.
        let db = TestDb::new("num-blank");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);

        let blank = create_transaction(
            &c, &acct, "2026-08-01", "Kroger", None, -4_250, None, Some("   "),
        )
        .expect("create");
        assert_eq!(num_of(&c, &acct, &blank.id), None);

        let nulls: i64 = c
            .query_row(
                "SELECT count(*) FROM transactions WHERE check_number IS NULL AND payee <> 'Opening Balance'",
                [],
                |r| r.get(0),
            )
            .expect("count");
        assert_eq!(nulls, 1);
    }

    #[test]
    fn editing_a_transaction_can_set_clear_and_change_the_num() {
        // The same shape as an old category bug: an edit must be able to put
        // a value in, change it, and take it out again.
        let db = TestDb::new("num-update");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        let txn = create_transaction(&c, &acct, "2026-08-01", "Kroger", None, -4_250, None, None)
            .expect("create");
        assert_eq!(num_of(&c, &acct, &txn.id), None);

        update_transaction(
            &c, &txn.id, "2026-08-01", "Kroger", None, -4_250, None, Some("1042"),
        )
        .expect("set");
        assert_eq!(num_of(&c, &acct, &txn.id).as_deref(), Some("1042"));

        update_transaction(
            &c, &txn.id, "2026-08-01", "Kroger", None, -4_250, None, Some("1043"),
        )
        .expect("change");
        assert_eq!(num_of(&c, &acct, &txn.id).as_deref(), Some("1043"));

        update_transaction(&c, &txn.id, "2026-08-01", "Kroger", None, -4_250, None, Some(""))
            .expect("clear");
        assert_eq!(num_of(&c, &acct, &txn.id), None, "the Num could not be cleared");
    }

    #[test]
    fn setting_a_num_does_not_disturb_the_balance_or_the_payee() {
        let db = TestDb::new("num-safe");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        let cat = ensure_category(&c, "Groceries").expect("cat");
        let txn = create_transaction(
            &c, &acct, "2026-08-01", "Kroger", Some(cat.as_str()), -4_250, None, None,
        )
        .expect("create");

        update_transaction(
            &c, &txn.id, "2026-08-01", "Kroger", Some(cat.as_str()), -4_250, None, Some("1042"),
        )
        .expect("update");

        assert_eq!(balance(&c, &acct), 95_750, "adding a Num moved the balance");
        let row = entered(&c, &acct).remove(0);
        assert_eq!(row.category_name.as_deref(), Some("Groceries"), "category lost");
        let payees = list_payees(&c).expect("payees");
        assert_eq!(payees.len(), 1);
        assert_eq!(payees[0].usage_count, 1);
    }

    // -----------------------------------------------------------------------
    // What the review found
    // -----------------------------------------------------------------------

    #[test]
    fn an_opening_balance_is_a_register_row_so_the_running_balance_agrees() {
        // Open with $1,000, spend $42.50: the register used to say −42.50
        // next to a sidebar saying 957.50, because the opening amount had no
        // row behind it.
        let db = TestDb::new("opening-row");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        create_transaction(&c, &acct, "2026-08-01", "Kroger", None, -4_250, None, None)
            .expect("txn");
        let rows = get_register(&c, &acct).expect("register");
        assert_eq!(rows[0].payee, "Opening Balance");
        assert_eq!(rows[0].date, "2026-01-01", "dated as of the opening, not today");
        assert_eq!(rows[0].amount_cents, 100_000);
        assert_eq!(rows[0].cleared_state, "R", "an opening balance is not reconcilable");
        assert_eq!(rows.last().unwrap().running_balance_cents, 95_750);
        assert_eq!(balance(&c, &acct), 95_750);
        // Zero opening: no row at all.
        let empty = account(&c, "New", 0);
        assert!(get_register(&c, &empty).expect("register").is_empty());
    }

    #[test]
    fn editing_a_voided_transaction_does_not_move_the_balance() {
        let db = TestDb::new("edit-void");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        let txn = create_transaction(&c, &acct, "2026-08-01", "Fraud", None, -5_000, None, None)
            .expect("txn");
        set_void(&c, &txn.id, true).expect("void");
        assert_eq!(balance(&c, &acct), 100_000);
        update_transaction(&c, &txn.id, "2026-08-01", "Fraud", None, -6_000, None, None)
            .expect("edit");
        assert_eq!(balance(&c, &acct), 100_000, "a voided row moved the balance");
    }

    #[test]
    fn one_half_of_a_transfer_cannot_be_edited_on_its_own() {
        let db = TestDb::new("edit-transfer-half");
        let c = db.conn();
        let chk = account(&c, "Checking", 0);
        let sav = account(&c, "Savings", 0);
        let half = create_transfer(&c, &chk, &sav, "2026-08-05", 20_000, None).expect("transfer");
        let err = update_transaction(&c, &half.id, "2026-08-05", "x", None, -30_000, None, None)
            .expect_err("refused");
        assert!(err.contains("transfer"), "{err}");
        assert_eq!(balance(&c, &chk) + balance(&c, &sav), 0);
    }

    #[test]
    fn a_transaction_needs_a_real_date() {
        let db = TestDb::new("txn-date");
        let c = db.conn();
        let acct = account(&c, "Checking", 0);
        assert!(create_transaction(&c, &acct, "08/01/2026", "Kroger", None, -1, None, None).is_err());
        assert!(create_transaction(&c, &acct, "2026-13-01", "Kroger", None, -1, None, None).is_err());
        assert_eq!(balance(&c, &acct), 0);
    }

    // An imported row can become a transfer, and a transfer an
    // ordinary row again, without deleting anything by hand.
    #[test]
    fn convert_to_transfer_writes_the_partner_and_can_be_undone_by_hand() {
        let db = TestDb::new("convert");
        let c = db.conn();
        let chk = account(&c, "Checking", 100_000);
        let sav = account(&c, "Savings", 50_000);
        let before = total_of_all_accounts(&c);
        let bank_says = ensure_category(&c, "Transfer").unwrap();
        let t = create_transaction(&c, &chk, "2026-03-01", "ONLINE XFER TO SAV", Some(&bank_says), -25_000, Some("web"), None).unwrap();
        assert_eq!(balance(&c, &chk), 75_000);

        let got = convert_to_transfer(&c, &t.id, &sav).unwrap();
        assert_eq!(got.category_id, None, "a transfer has no category");
        assert_eq!(balance(&c, &chk), 75_000, "this side already carried the row");
        assert_eq!(balance(&c, &sav), 75_000, "the other side gained it");
        assert_eq!(total_of_all_accounts(&c), before, "a transfer moves money; it does not make any");
        let (partner_id, partner_acct, partner_amt, partner_payee, partner_notes): (String, String, i64, String, Option<String>) = c
            .query_row(
                "SELECT p.id, p.account_id, p.amount_cents, p.payee, p.notes
                   FROM transactions t JOIN transactions p ON p.id = t.transfer_id WHERE t.id = ?1",
                params![t.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!((partner_acct.as_str(), partner_amt, partner_payee.as_str(), partner_notes.as_deref()), (sav.as_str(), 25_000, "ONLINE XFER TO SAV", Some("web")));
        let back: Option<String> = c.query_row("SELECT transfer_id FROM transactions WHERE id = ?1", params![partner_id], |r| r.get(0)).unwrap();
        assert_eq!(back.as_deref(), Some(t.id.as_str()), "the partner points back");
        assert!(verify_file(&c, false).unwrap().half_transfers.is_empty());

        // Refused: already a transfer; the same account.
        assert!(convert_to_transfer(&c, &t.id, &sav).unwrap_err().contains("already a transfer"));
        // Editing it as a transfer now works, which is the point.
        update_transfer(&c, &t.id, "2026-03-02", &sav, -30_000, None).unwrap();
        assert_eq!(balance(&c, &sav), 80_000);
        assert_eq!(balance(&c, &chk), 70_000);

        // And back again: the partner goes, its balance is unwound, the
        // category asked for is set.
        let groceries = ensure_category(&c, "Groceries").unwrap();
        let plain = convert_from_transfer(&c, &t.id, Some(&groceries)).unwrap();
        assert_eq!(plain.category_id.as_deref(), Some(groceries.as_str()));
        assert_eq!(balance(&c, &sav), 50_000);
        assert_eq!(balance(&c, &chk), 70_000);
        let n: i64 = c.query_row("SELECT COUNT(*) FROM transactions WHERE id = ?1", params![partner_id], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "the partner row is gone");
        assert!(convert_from_transfer(&c, &t.id, None).unwrap_err().contains("not a transfer"));
        assert!(convert_to_transfer(&c, &t.id, &chk).unwrap_err().contains("same account"));
        assert!(convert_to_transfer(&c, &t.id, "no-such-account").unwrap_err().contains("does not exist"));
    }

    #[test]
    fn convert_to_transfer_refuses_a_split_row_and_keeps_a_void_row_out_of_balances() {
        let db = TestDb::new("convert2");
        let c = db.conn();
        let chk = account(&c, "Checking", 100_000);
        let sav = account(&c, "Savings", 50_000);
        let split = create_transaction(&c, &chk, "2026-03-01", "Store", None, -5_000, None, None).unwrap();
        set_splits(&c, &split.id, &[NewSplit { classes: Vec::new(), category_id: None, description: None, amount_cents: -5_000, transfer_account_id: None }]).unwrap();
        assert!(convert_to_transfer(&c, &split.id, &sav).unwrap_err().contains("split"));

        let t = create_transaction(&c, &chk, "2026-03-01", "Xfer", None, -1_000, None, None).unwrap();
        c.execute("UPDATE transactions SET is_void = 1 WHERE id = ?1", params![t.id]).unwrap();
        c.execute("UPDATE accounts SET balance_cents = balance_cents + 1000 WHERE id = ?1", params![chk]).unwrap();
        convert_to_transfer(&c, &t.id, &sav).unwrap();
        assert_eq!(balance(&c, &sav), 50_000, "a voided row moves nothing");
        let partner_void: i64 = c.query_row("SELECT p.is_void FROM transactions t JOIN transactions p ON p.id = t.transfer_id WHERE t.id = ?1", params![t.id], |r| r.get(0)).unwrap();
        assert_eq!(partner_void, 1, "the partner is void too");
        convert_from_transfer(&c, &t.id, None).unwrap();
        assert_eq!(balance(&c, &sav), 50_000);
    }

    /// "it's also in the transfer picker and I was able to transfer to
    /// it. Account is closed is checked." A new transfer, a transfer moved to
    /// a closed account, and a row converted into one are refused, with the
    /// account named; nothing is written.
    #[test]
    fn a_new_transfer_into_or_out_of_a_closed_account_is_refused() {
        let db = TestDb::new("closed-transfer");
        let c = db.conn();
        let chk = account(&c, "Checking", 500_000);
        let sav = account(&c, "Savings", 100_000);
        let old = account(&c, "Old Checking", 50_000);
        // Written while the account was open: the history a close keeps.
        let before = create_transfer(&c, &old, &chk, "2026-01-05", 50_000, None).unwrap();
        close(&c, &old);

        let err = create_transfer(&c, &chk, &old, "2026-09-01", 1_000, None).unwrap_err();
        assert!(err.starts_with("Old Checking is closed — nothing new can be transferred into or out of it."), "{err}");
        assert!(create_transfer(&c, &old, &chk, "2026-09-01", 1_000, None).is_err(), "out of it, too");
        assert_eq!((balance(&c, &chk), balance(&c, &old)), (550_000, 0), "nothing was written");

        // An existing transfer to the closed account still edits in place…
        update_transfer(&c, &before.id, "2026-01-06", &chk, -45_000, Some("memo")).unwrap();
        assert_eq!(balance(&c, &old), 5_000);
        // …but moving an open transfer's other half INTO it is a new link.
        let t = create_transfer(&c, &chk, &sav, "2026-09-02", 2_000, None).unwrap();
        let err = update_transfer(&c, &t.id, "2026-09-02", &old, -2_000, None).unwrap_err();
        assert!(err.contains("Old Checking is closed"), "{err}");
        assert_eq!(balance(&c, &sav), 102_000);

        // Converting an ordinary row into a transfer to it.
        let row = create_transaction(&c, &chk, "2026-09-03", "Someone", None, -3_000, None, None).unwrap();
        let err = convert_to_transfer(&c, &row.id, &old).unwrap_err();
        assert!(err.contains("Old Checking is closed"), "{err}");
        assert!(get_register(&c, &old).unwrap().iter().all(|r| r.date != "2026-09-03"));
        assert!(verify_file(&c, false).unwrap().drift.is_empty());
    }
}
