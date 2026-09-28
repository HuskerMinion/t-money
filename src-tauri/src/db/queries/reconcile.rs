//! Reconcile (§6.1c / §6.1f, migration 0012): statements and cleared marks.

use crate::models::Statement;
use chrono::NaiveDate;
use rusqlite::{params, OptionalExtension, Row};
use uuid::Uuid;
use super::*;

// ---------------------------------------------------------------------------
// Reconcile (§6.1c / §6.1f, migration 0012)
// ---------------------------------------------------------------------------

fn map_statement(row: &Row) -> rusqlite::Result<Statement> {
    Ok(Statement {
        id: row.get(0)?,
        account_id: row.get(1)?,
        statement_date: row.get(2)?,
        starting_balance_cents: row.get(3)?,
        ending_balance_cents: row.get(4)?,
        status: row.get(5)?,
        reconciled_on: row.get(6)?,
        service_charge_cents: row.get(7)?,
        service_charge_category_id: row.get(8)?,
        interest_cents: row.get(9)?,
        interest_category_id: row.get(10)?,
        adjustment_cents: row.get(11)?,
        adjustment_category_id: row.get(12)?,
    })
}

const STATEMENT_COLS: &str = "id, account_id, statement_date, starting_balance_cents,
     ending_balance_cents, status, reconciled_on, service_charge_cents,
     service_charge_category_id, interest_cents, interest_category_id,
     adjustment_cents, adjustment_category_id";

/// The postponed statement for this account, if there is one. Its presence is
/// what triggers Money's resume dialog (§6.1f [A]).
pub fn get_open_statement(conn: &Conn, account_id: &str) -> Result<Option<Statement>, String> {
    let sql = format!(
        "SELECT {STATEMENT_COLS} FROM statements
         WHERE account_id = ?1 AND status = 'in_progress'
         ORDER BY statement_date DESC LIMIT 1"
    );
    conn.query_row(&sql, params![account_id], map_statement)
        .optional()
        .map_err(|e| e.to_string())
}

/// The most recently completed statement — supplies "Last statement
/// reconciled" and the next starting balance (§6.1c).
pub fn get_last_statement(conn: &Conn, account_id: &str) -> Result<Option<Statement>, String> {
    let sql = format!(
        "SELECT {STATEMENT_COLS} FROM statements
         WHERE account_id = ?1 AND status = 'completed'
         ORDER BY statement_date DESC LIMIT 1"
    );
    conn.query_row(&sql, params![account_id], map_statement)
        .optional()
        .map_err(|e| e.to_string())
}

/// Begin (or resume) balancing an account.
///
/// Service charge and interest each become a real categorized transaction, as
/// they do in Money — that is how bank fees and interest normally enter a file
/// at all (§6.1c). Re-starting an in-progress statement updates it in place and
/// does NOT duplicate those transactions.
#[allow(clippy::too_many_arguments)]
pub fn start_statement(
    conn: &Conn,
    account_id: &str,
    statement_date: &str,
    starting_balance_cents: i64,
    ending_balance_cents: i64,
    service_charge_cents: Option<i64>,
    service_charge_category_id: Option<&str>,
    interest_cents: Option<i64>,
    interest_category_id: Option<&str>,
) -> Result<Statement, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    let existing: Option<String> = tx
        .query_row(
            "SELECT id FROM statements WHERE account_id = ?1 AND status = 'in_progress'",
            params![account_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let id = match existing {
        Some(id) => {
            tx.execute(
                "UPDATE statements SET statement_date = ?2, starting_balance_cents = ?3,
                        ending_balance_cents = ?4 WHERE id = ?1",
                params![id, statement_date, starting_balance_cents, ending_balance_cents],
            )
            .map_err(|e| e.to_string())?;
            id
        }
        None => {
            let id = Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO statements
                     (id, account_id, statement_date, starting_balance_cents,
                      ending_balance_cents, service_charge_cents, service_charge_category_id,
                      interest_cents, interest_category_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    id,
                    account_id,
                    statement_date,
                    starting_balance_cents,
                    ending_balance_cents,
                    service_charge_cents,
                    service_charge_category_id,
                    interest_cents,
                    interest_category_id
                ],
            )
            .map_err(|e| e.to_string())?;

            // Only a brand-new statement writes the fee/interest transactions.
            if let Some(charge) = service_charge_cents.filter(|c| *c != 0) {
                insert_reconcile_txn(
                    &tx,
                    account_id,
                    statement_date,
                    "Service Charge",
                    -charge.abs(),
                    service_charge_category_id,
                )?;
            }
            if let Some(interest) = interest_cents.filter(|c| *c != 0) {
                insert_reconcile_txn(
                    &tx,
                    account_id,
                    statement_date,
                    "Interest",
                    interest.abs(),
                    interest_category_id,
                )?;
            }
            id
        }
    };

    tx.commit().map_err(|e| e.to_string())?;
    let sql = format!("SELECT {STATEMENT_COLS} FROM statements WHERE id = ?1");
    conn.query_row(&sql, params![id], map_statement)
        .map_err(|e| e.to_string())
}

/// A transaction created by the reconcile flow (fee, interest, adjustment).
/// Marked cleared straight away: it came off the statement, so it is by
/// definition on it.
fn insert_reconcile_txn(
    tx: &rusqlite::Transaction<'_>,
    account_id: &str,
    date: &str,
    payee: &str,
    amount_cents: i64,
    category_id: Option<&str>,
) -> Result<(), String> {
    let id = Uuid::new_v4().to_string();
    let payee_id = payee_id_for(tx, payee, category_id)?;
    tx.execute(
        "INSERT INTO transactions
             (id, account_id, date, payee, payee_id, category_id, amount_cents,
              cleared_state)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'C')",
        params![id, account_id, date, payee, payee_id, category_id, amount_cents],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE accounts SET balance_cents = balance_cents + ?1, updated_at = datetime('now')
         WHERE id = ?2",
        params![amount_cents, account_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Toggle one transaction's cleared state. Written as the user clicks so that
/// Postpone really does preserve the marks (§6.1f [A]).
pub fn set_cleared(conn: &Conn, transaction_id: &str, state: &str) -> Result<(), String> {
    if !matches!(state, "" | "C" | "R") {
        return Err(format!("invalid cleared state: {state:?}"));
    }
    conn.execute(
        "UPDATE transactions SET cleared_state = ?2, is_reconciled = ?3 WHERE id = ?1",
        params![transaction_id, state, (state == "R") as i64],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Mark every non-void row in the account dated on or before `through` as
/// reconciled (§70): the way to catch up an account whose history was
/// imported already balanced, without walking each old statement. Returns
/// how many rows changed; `dry_run` only counts.
pub fn reconcile_through(conn: &Conn, account_id: &str, through: &str, dry_run: bool) -> Result<u32, String> {
    if NaiveDate::parse_from_str(through, "%Y-%m-%d").is_err() {
        return Err(format!("{through:?} is not a date"));
    }
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM transactions
              WHERE account_id = ?1 AND date <= ?2 AND is_void = 0 AND cleared_state <> 'R'",
            params![account_id, through],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !dry_run && n > 0 {
        conn.execute(
            "UPDATE transactions SET cleared_state = 'R', is_reconciled = 1
              WHERE account_id = ?1 AND date <= ?2 AND is_void = 0 AND cleared_state <> 'R'",
            params![account_id, through],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(n as u32)
}

/// Abandon an in-progress statement.
///
/// The user's Postpone is a **cancel**: the statement header (date, balances,
/// fees) is discarded and the next attempt starts by re-entering the ending
/// balance. The per-transaction `C` marks are deliberately NOT touched — they
/// are everyday marks that live on the transaction, not on the statement, so
/// they survive (§6.1f).
///
/// Any service-charge or interest transactions the statement created stay too:
/// they are real transactions that happened, not statement scratch state.
pub fn discard_statement(conn: &Conn, statement_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM statements WHERE id = ?1 AND status = 'in_progress'",
        params![statement_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Finish balancing: promote every cleared row to reconciled, stamp the
/// statement, and optionally write the adjustment transaction Money offers when
/// the account will not balance (§6.1f [D]).
pub fn finish_statement(
    conn: &Conn,
    statement_id: &str,
    adjustment_cents: Option<i64>,
    adjustment_category_id: Option<&str>,
) -> Result<Statement, String> {
    let (account_id, statement_date, status): (String, String, String) = conn
        .query_row(
            "SELECT account_id, statement_date, status FROM statements WHERE id = ?1",
            params![statement_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|e| format!("statement {statement_id} not found: {e}"))?;
    // Finishing twice used to write a second Balance Adjustment and move the
    // balance again. A completed statement is done.
    if status != "in_progress" {
        return Err("this statement has already been balanced".to_string());
    }

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    if let Some(adjustment) = adjustment_cents.filter(|c| *c != 0) {
        insert_reconcile_txn(
            &tx,
            &account_id,
            &statement_date,
            "Balance Adjustment",
            adjustment,
            adjustment_category_id,
        )?;
    }

    // Only rows ON this statement become reconciled: dated up to the
    // statement date, and not voided. A row cleared early for next month's
    // statement stays `C` — stamping it `R` here would file it under a
    // statement it is not on, and Money never un-reconciles.
    tx.execute(
        "UPDATE transactions SET cleared_state = 'R', is_reconciled = 1
         WHERE account_id = ?1 AND cleared_state = 'C'
           AND date <= ?2 AND is_void = 0",
        params![account_id, statement_date],
    )
    .map_err(|e| e.to_string())?;

    tx.execute(
        "UPDATE statements
            SET status = 'completed', reconciled_on = date('now'),
                adjustment_cents = ?2, adjustment_category_id = ?3
          WHERE id = ?1",
        params![statement_id, adjustment_cents, adjustment_category_id],
    )
    .map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    let sql = format!("SELECT {STATEMENT_COLS} FROM statements WHERE id = ?1");
    conn.query_row(&sql, params![statement_id], map_statement)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::queries::test_support::*;

    // ── reconcile / statements ───────────────────────────────────────────
    //
    // Reconcile is the one flow that writes money the user did not type: the
    // service charge, the interest and the balance adjustment all become real
    // transactions. It is also the only flow with resumable state, so the
    // question these answer is "does Postpone lose anything, and does a
    // restart charge the fee twice?" (§21.5).

    /// A helper: the cleared_state of one transaction, read straight from the
    /// register so the tests exercise the same path the UI does.
    fn cleared_of(conn: &Conn, account_id: &str, txn_id: &str) -> String {
        get_register(conn, account_id)
            .expect("register")
            .into_iter()
            .find(|r| r.id == txn_id)
            .expect("row in register")
            .cleared_state
    }

    #[test]
    fn starting_a_statement_writes_the_fee_and_interest_as_real_cleared_transactions() {
        let db = TestDb::new("stmt-start");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        let fees = ensure_category(&c, "Bank Charges").expect("category");
        let earned = ensure_category(&c, "Interest Income").expect("category");

        let stmt = start_statement(
            &c,
            &acct,
            "2026-08-31",
            100_000,
            99_800,
            Some(500),
            Some(fees.as_str()),
            Some(300),
            Some(earned.as_str()),
        )
        .expect("start_statement");

        assert_eq!(stmt.status, "in_progress");

        // The fee is taken as a debit whichever sign it arrives with, and the
        // interest as a credit: 100000 - 500 + 300.
        assert_eq!(balance(&c, &acct), 99_800);

        let rows = entered(&c, &acct);
        assert_eq!(rows.len(), 2, "expected the fee and interest rows");
        for r in &rows {
            assert_eq!(
                r.cleared_state, "C",
                "{} came off the statement, so it is on it by definition",
                r.payee
            );
        }
        let fee = rows.iter().find(|r| r.payee == "Service Charge").expect("fee");
        assert_eq!(fee.amount_cents, -500);
        assert_eq!(fee.category_id.as_deref(), Some(fees.as_str()));
        let int = rows.iter().find(|r| r.payee == "Interest").expect("interest");
        assert_eq!(int.amount_cents, 300);
    }

    #[test]
    fn a_negative_service_charge_is_not_charged_twice_as_a_credit() {
        // Money's dialog takes the fee as a positive number, but nothing stops
        // a caller sending it signed. `-charge.abs()` is what makes both mean
        // the same thing; this pins it.
        let db = TestDb::new("stmt-sign");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);

        start_statement(&c, &acct, "2026-08-31", 100_000, 99_500, Some(-500), None, None, None)
            .expect("start_statement");

        assert_eq!(balance(&c, &acct), 99_500);
    }

    #[test]
    fn restarting_an_in_progress_statement_does_not_charge_the_fee_again() {
        let db = TestDb::new("stmt-restart");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);

        let first = start_statement(
            &c, &acct, "2026-08-31", 100_000, 99_500, Some(500), None, None, None,
        )
        .expect("first start");
        assert_eq!(balance(&c, &acct), 99_500);

        // The user reopens the wizard and corrects the ending balance.
        let second = start_statement(
            &c, &acct, "2026-08-31", 100_000, 99_400, Some(500), None, None, None,
        )
        .expect("second start");

        assert_eq!(second.id, first.id, "a restart must reuse the open statement");
        assert_eq!(second.ending_balance_cents, 99_400, "the header did not update");
        assert_eq!(
            entered(&c, &acct).len(),
            1,
            "the fee transaction was written twice"
        );
        assert_eq!(balance(&c, &acct), 99_500, "the fee was applied twice");
    }

    // §70 — reconciling by date, for history brought in already balanced.
    #[test]
    fn reconcile_through_marks_everything_up_to_the_date_and_nothing_after() {
        let db = TestDb::new("reconcile-through");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        let other = account(&c, "Savings", 0);
        let a = create_transaction(&c, &acct, "2026-07-03", "Kroger", None, -4_250, None, None).unwrap();
        let b = create_transaction(&c, &acct, "2026-07-31", "City Power & Light", None, -12_000, None, None).unwrap();
        let after = create_transaction(&c, &acct, "2026-08-02", "Shell", None, -4_000, None, None).unwrap();
        let voided = create_transaction(&c, &acct, "2026-07-10", "Oops", None, -1, None, None).unwrap();
        set_void(&c, &voided.id, true).unwrap();
        let elsewhere = create_transaction(&c, &other, "2026-07-10", "Interest", None, 100, None, None).unwrap();
        set_cleared(&c, &a.id, "R").unwrap();
        let before = get_account(&c, &acct).unwrap().balance_cents;
        // A dry run counts without writing: b only (a is R already, so is the
        // opening-balance row, the void is skipped, `after` is after).
        assert_eq!(reconcile_through(&c, &acct, "2026-07-31", true).unwrap(), 1);
        assert_eq!(get_register(&c, &acct).unwrap().iter().filter(|r| r.cleared_state == "R").count(), 2);
        assert_eq!(reconcile_through(&c, &acct, "2026-07-31", false).unwrap(), 1);
        let rows = get_register(&c, &acct).unwrap();
        let state = |id: &str| rows.iter().find(|r| r.id == id).unwrap().cleared_state.clone();
        assert_eq!((state(&a.id), state(&b.id), state(&after.id), state(&voided.id)), ("R".into(), "R".into(), "".into(), "".into()));
        assert!(rows.iter().find(|r| r.id == b.id).unwrap().is_reconciled);
        assert_eq!(rows.iter().filter(|r| r.cleared_state == "R").count(), 3, "a, b and the opening balance");
        assert_eq!(get_register(&c, &other).unwrap().iter().find(|r| r.id == elsewhere.id).unwrap().cleared_state, "");
        assert_eq!(get_account(&c, &acct).unwrap().balance_cents, before, "marking moves no money");
        assert_eq!(reconcile_through(&c, &acct, "2026-07-31", false).unwrap(), 0, "nothing left to mark");
        assert!(reconcile_through(&c, &acct, "7/31/2026", true).is_err());
    }

    #[test]
    fn set_cleared_refuses_a_state_that_is_not_one_of_moneys_three() {
        let db = TestDb::new("stmt-state");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        let txn = create_transaction(&c, &acct, "2026-08-01", "Kroger", None, -4_250, None, None)
            .expect("create");

        for ok in ["", "C", "R"] {
            set_cleared(&c, &txn.id, ok).unwrap_or_else(|e| panic!("{ok:?} rejected: {e}"));
        }
        assert!(set_cleared(&c, &txn.id, "X").is_err());
        assert!(set_cleared(&c, &txn.id, "c").is_err(), "state is case-sensitive");
    }

    #[test]
    fn clearing_a_transaction_never_moves_the_balance() {
        // The C column is a mark, not money. If this ever fails, reconciling
        // an account would silently restate it.
        let db = TestDb::new("stmt-nomoney");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        let txn = create_transaction(&c, &acct, "2026-08-01", "Kroger", None, -4_250, None, None)
            .expect("create");

        set_cleared(&c, &txn.id, "C").expect("clear");
        assert_eq!(balance(&c, &acct), 95_750);
        set_cleared(&c, &txn.id, "R").expect("reconcile");
        assert_eq!(balance(&c, &acct), 95_750);
        set_cleared(&c, &txn.id, "").expect("unclear");
        assert_eq!(balance(&c, &acct), 95_750);
    }

    #[test]
    fn postpone_discards_the_statement_but_keeps_the_cleared_marks_and_the_fee() {
        // §6.1f: Postpone is a cancel of the *header*. The C marks are
        // everyday marks that live on the transaction, and the fee is a real
        // transaction that happened. Losing either is the bug this catches.
        let db = TestDb::new("stmt-postpone");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        let txn = create_transaction(&c, &acct, "2026-08-01", "Kroger", None, -4_250, None, None)
            .expect("create");

        let stmt = start_statement(
            &c, &acct, "2026-08-31", 100_000, 95_250, Some(500), None, None, None,
        )
        .expect("start");
        set_cleared(&c, &txn.id, "C").expect("clear");

        discard_statement(&c, &stmt.id).expect("postpone");

        assert!(
            get_open_statement(&c, &acct).expect("open").is_none(),
            "the postponed header should be gone"
        );
        assert_eq!(cleared_of(&c, &acct, &txn.id), "C", "the C mark was lost");
        assert_eq!(
            entered(&c, &acct).len(),
            2,
            "the service-charge transaction was rolled back with the header"
        );
        assert_eq!(balance(&c, &acct), 95_250);
    }

    #[test]
    fn discarding_a_completed_statement_does_nothing() {
        let db = TestDb::new("stmt-discard-done");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        let stmt = start_statement(&c, &acct, "2026-08-31", 100_000, 100_000, None, None, None, None)
            .expect("start");
        finish_statement(&c, &stmt.id, None, None).expect("finish");

        discard_statement(&c, &stmt.id).expect("discard is a no-op, not an error");
        assert!(
            get_last_statement(&c, &acct).expect("last").is_some(),
            "a completed statement must survive a stray discard"
        );
    }

    #[test]
    fn finishing_promotes_every_cleared_row_and_leaves_the_rest_alone() {
        let db = TestDb::new("stmt-finish");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        let on_stmt = create_transaction(&c, &acct, "2026-08-01", "Kroger", None, -4_250, None, None)
            .expect("create");
        let not_yet = create_transaction(&c, &acct, "2026-08-30", "Shell", None, -3_000, None, None)
            .expect("create");

        let stmt = start_statement(&c, &acct, "2026-08-31", 100_000, 95_750, None, None, None, None)
            .expect("start");
        set_cleared(&c, &on_stmt.id, "C").expect("clear");

        let done = finish_statement(&c, &stmt.id, None, None).expect("finish");

        assert_eq!(done.status, "completed");
        assert!(done.reconciled_on.is_some(), "reconciled_on was not stamped");
        assert_eq!(cleared_of(&c, &acct, &on_stmt.id), "R");
        assert_eq!(
            cleared_of(&c, &acct, &not_yet.id),
            "",
            "an uncleared row must not be swept into the statement"
        );

        // And the account moves from in-progress to history.
        assert!(get_open_statement(&c, &acct).expect("open").is_none());
        assert_eq!(
            get_last_statement(&c, &acct).expect("last").expect("some").id,
            stmt.id
        );
    }

    #[test]
    fn the_balance_adjustment_is_a_real_transaction_that_moves_the_balance() {
        let db = TestDb::new("stmt-adjust");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        let cat = ensure_category(&c, "Miscellaneous").expect("category");
        let stmt = start_statement(&c, &acct, "2026-08-31", 100_000, 99_000, None, None, None, None)
            .expect("start");

        let done = finish_statement(&c, &stmt.id, Some(-1_000), Some(cat.as_str()))
            .expect("finish with adjustment");

        assert_eq!(done.adjustment_cents, Some(-1_000));
        assert_eq!(balance(&c, &acct), 99_000, "the adjustment did not move the balance");

        let rows = get_register(&c, &acct).expect("register");
        let adj = rows
            .iter()
            .find(|r| r.payee == "Balance Adjustment")
            .expect("adjustment row");
        assert_eq!(adj.amount_cents, -1_000);
        assert_eq!(
            adj.cleared_state, "R",
            "the adjustment is written cleared, then promoted by the same finish"
        );
    }

    #[test]
    fn a_zero_adjustment_writes_no_transaction() {
        let db = TestDb::new("stmt-adjust-zero");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        let stmt = start_statement(&c, &acct, "2026-08-31", 100_000, 100_000, None, None, None, None)
            .expect("start");

        finish_statement(&c, &stmt.id, Some(0), None).expect("finish");

        assert!(
            entered(&c, &acct).is_empty(),
            "a zero adjustment should not litter the register"
        );
        assert_eq!(balance(&c, &acct), 100_000);
    }

    #[test]
    fn finishing_an_unknown_statement_is_an_error_not_a_silent_no_op() {
        let db = TestDb::new("stmt-missing");
        let c = db.conn();
        assert!(finish_statement(&c, "no-such-statement", None, None).is_err());
    }

    #[test]
    fn a_completed_statement_is_never_resumed_as_the_next_one() {
        // `finish_statement` promotes every 'C' row in the ACCOUNT, so the
        // second month must open a fresh header and must not disturb what the
        // first one already reconciled.
        let db = TestDb::new("stmt-twice");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        let july = create_transaction(&c, &acct, "2026-07-15", "Kroger", None, -1_000, None, None)
            .expect("create");
        let august = create_transaction(&c, &acct, "2026-08-15", "Shell", None, -2_000, None, None)
            .expect("create");

        let s1 = start_statement(&c, &acct, "2026-07-31", 100_000, 99_000, None, None, None, None)
            .expect("start july");
        set_cleared(&c, &july.id, "C").expect("clear july");
        finish_statement(&c, &s1.id, None, None).expect("finish july");

        let s2 = start_statement(&c, &acct, "2026-08-31", 99_000, 97_000, None, None, None, None)
            .expect("start august");
        assert_ne!(
            s2.id, s1.id,
            "a completed statement must not be resumed as the next one"
        );

        set_cleared(&c, &august.id, "C").expect("clear august");
        finish_statement(&c, &s2.id, None, None).expect("finish august");

        assert_eq!(cleared_of(&c, &acct, &july.id), "R", "july was un-reconciled");
        assert_eq!(cleared_of(&c, &acct, &august.id), "R");
        assert_eq!(balance(&c, &acct), 97_000, "reconciling twice restated the account");
    }

    // -----------------------------------------------------------------------
    // §38 — what the review found
    // -----------------------------------------------------------------------

    #[test]
    fn a_statement_cannot_be_finished_twice() {
        let db = TestDb::new("finish-twice");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        let stmt = start_statement(&c, &acct, "2026-08-31", 100_000, 99_000, None, None, None, None)
            .expect("start");
        finish_statement(&c, &stmt.id, Some(-1_000), None).expect("first finish");
        assert_eq!(balance(&c, &acct), 99_000);
        let err = finish_statement(&c, &stmt.id, Some(-1_000), None).expect_err("refused");
        assert!(err.contains("already"), "{err}");
        assert_eq!(balance(&c, &acct), 99_000, "a second adjustment was written");
    }

    #[test]
    fn finishing_a_statement_reconciles_only_rows_on_that_statement() {
        let db = TestDb::new("finish-scope");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        let on = create_transaction(&c, &acct, "2026-08-20", "Kroger", None, -4_250, None, None).expect("on");
        let next = create_transaction(&c, &acct, "2026-09-02", "Shell", None, -3_000, None, None).expect("next month");
        let voided = create_transaction(&c, &acct, "2026-08-21", "Fraud", None, -9_900, None, None).expect("void");
        set_void(&c, &voided.id, true).expect("void");
        for id in [&on.id, &next.id, &voided.id] {
            set_cleared(&c, id, "C").expect("clear");
        }
        let stmt = start_statement(&c, &acct, "2026-08-31", 100_000, 95_750, None, None, None, None)
            .expect("start");
        finish_statement(&c, &stmt.id, None, None).expect("finish");
        assert_eq!(cleared_of(&c, &acct, &on.id), "R");
        assert_eq!(cleared_of(&c, &acct, &next.id), "C", "a row dated after the statement was reconciled");
        assert_eq!(cleared_of(&c, &acct, &voided.id), "C", "a voided row was reconciled");
    }
}
