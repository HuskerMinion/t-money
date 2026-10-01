//! Splits: a transaction's lines, including lines that transfer to
//! another account.

use crate::models::{NewSplit, Split};
use rusqlite::{params, Connection, OptionalExtension, Row};
use uuid::Uuid;
use super::*;

// ---------------------------------------------------------------------------
// Splits
// ---------------------------------------------------------------------------

fn map_split(row: &Row) -> rusqlite::Result<Split> {
    Ok(Split {
        id: row.get(0)?,
        transaction_id: row.get(1)?,
        category_id: row.get(2)?,
        description: row.get(3)?,
        amount_cents: row.get(4)?,
        sort_order: row.get(5)?,
        transfer_account_id: row.get(6)?,
        transfer_account_name: row.get(7)?,
        classes: Vec::new(),
    })
}

/// Remove the rows a transaction's transfer split lines wrote in other
/// accounts, putting each account's balance back. Called before the lines are
/// rewritten, and before the parent is deleted.
pub(crate) fn delete_split_transfer_rows(tx: &Connection, transaction_id: &str) -> Result<(), String> {
    let mut st = tx
        .prepare(
            "SELECT t.id, t.account_id, t.amount_cents, t.is_void
               FROM splits s JOIN transactions t ON t.id = s.transfer_txn_id
              WHERE s.transaction_id = ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, i64, i64)> = st
        .query_map(params![transaction_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    drop(st);
    for (id, account, amount, is_void) in rows {
        tx.execute("DELETE FROM transactions WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
        if is_void == 0 {
            tx.execute(
                "UPDATE accounts SET balance_cents = balance_cents - ?2,
                        updated_at = datetime('now') WHERE id = ?1",
                params![account, amount],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Every split line of one transaction, in the order the user arranged them.
pub fn list_splits(conn: &Conn, transaction_id: &str) -> Result<Vec<Split>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT s.id, s.transaction_id, s.category_id, s.description, s.amount_cents,
                    s.sort_order, s.transfer_account_id, a.name
               FROM splits s LEFT JOIN accounts a ON a.id = s.transfer_account_id
              WHERE s.transaction_id = ?1 ORDER BY s.sort_order, s.rowid",
        )
        .map_err(|e| e.to_string())?;
    // Bind the collected Vec before returning it — a tail-expression here
    // outlives `stmt` (E0597).
    let mut out: Vec<Split> = stmt
        .query_map(params![transaction_id], map_split)
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    for s in out.iter_mut() {
        s.classes = crate::db::classes::line_classes(conn, transaction_id, Some(&s.id))?;
    }
    Ok(out)
}

/// Replace a transaction's entire split set in one SQL transaction.
///
/// Passing an empty slice clears the splits. Otherwise the line amounts must
/// sum to the parent transaction's `amount_cents` — Money states this as
/// guidance in the dialog ("The amounts should add up to the total transaction
/// amount"), but the invariant is enforced here so the database can never hold
/// a split set that disagrees with its parent.
///
/// A split transaction has no single category, so the parent's `category_id`
/// is cleared. Reporting must aggregate `splits`, not `transactions.category_id`.
pub fn set_splits(
    conn: &Conn,
    transaction_id: &str,
    splits: &[NewSplit],
) -> Result<Vec<Split>, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    set_splits_in(&tx, transaction_id, splits)?;
    tx.commit().map_err(|e| e.to_string())?;
    list_splits(conn, transaction_id)
}

/// The body of `set_splits`, inside a SQL transaction the caller
/// holds, so a row and its lines (`create_transaction_with_splits`), an edit
/// and its lines (`update_transaction_with_splits`) and a loan payment are
/// each written whole or not at all.
pub(crate) fn set_splits_in(
    tx: &Connection,
    transaction_id: &str,
    splits: &[NewSplit],
) -> Result<(), String> {
    let (parent_amount, account_id, is_void, transfer_id, is_far): (i64, String, i64, Option<String>, i64) = tx
        .query_row(
            "SELECT amount_cents, account_id, is_void, transfer_id, is_split_transfer
               FROM transactions WHERE id = ?1",
            params![transaction_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no such transaction: {transaction_id}"))?;

    // A transfer half cannot be split at all — not only when the lines
    // would change its total. Lines that happened to add up used to be
    // accepted, clearing nothing and writing far rows off a row whose partner
    // already carries the money. The far row of a split line is refused for
    // the same reason: its lines would be a split of a split.
    if !splits.is_empty() {
        if transfer_id.is_some() {
            return Err("one half of a transfer cannot be split".to_string());
        }
        if is_far != 0 {
            return Err(far_row_refusal(tx, transaction_id, "split the payment instead")?);
        }
    }

    // The split lines ARE the amount. When they do not sum to what
    // the parent holds, the parent follows the lines — this is the one
    // place a split transaction's total changes, now that
    // `update_transaction` refuses to change it behind the lines. The
    // balance moves by the difference, unless the row is voided (it counts
    // for nothing).
    if !splits.is_empty() {
        let total: i64 = splits.iter().map(|s| s.amount_cents).sum();
        if total != parent_amount {
            tx.execute(
                "UPDATE transactions SET amount_cents = ?2 WHERE id = ?1",
                params![transaction_id, total],
            )
            .map_err(|e| e.to_string())?;
            if is_void == 0 {
                tx.execute(
                    "UPDATE accounts SET balance_cents = balance_cents + ?1,
                            updated_at = datetime('now') WHERE id = ?2",
                    params![total - parent_amount, account_id],
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }

    // The accounts the lines already transfer to. The lines are
    // rebuilt below, so a line that keeps its account is not a new link and
    // is allowed even when that account (or this one) has since been closed;
    // a line to any other account is, and a closed account refuses it.
    let kept_targets: std::collections::HashSet<String> = {
        let mut stmt = tx
            .prepare("SELECT transfer_account_id FROM splits WHERE transaction_id = ?1 AND transfer_account_id IS NOT NULL")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![transaction_id], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };
    for other in splits.iter().filter_map(|l| l.transfer_account_id.as_deref()).filter(|a| !a.is_empty()) {
        if !kept_targets.contains(other) {
            refuse_new_link_to_closed(tx, &[other, account_id.as_str()])?;
        }
    }

    // A split line can be a transfer. Its far row is rebuilt with the
    // lines, so editing a split never leaves a stale row in another account.
    delete_split_transfer_rows(tx, transaction_id)?;
    tx.execute(
        "DELETE FROM splits WHERE transaction_id = ?1",
        params![transaction_id],
    )
    .map_err(|e| e.to_string())?;

    let (payee, date, is_void_now): (String, String, i64) = tx
        .query_row(
            "SELECT payee, date, is_void FROM transactions WHERE id = ?1",
            params![transaction_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|e| e.to_string())?;

    for (i, split) in splits.iter().enumerate() {
        let id = Uuid::new_v4().to_string();
        // The far side of a transfer line: the opposite amount in the other
        // account. Money out of checking is money off a mortgage.
        let far_id = match split.transfer_account_id.as_deref().filter(|a| !a.is_empty()) {
            Some(other) => {
                if other == account_id {
                    return Err("a split line cannot transfer to its own account".to_string());
                }
                let exists: i64 = tx
                    .query_row("SELECT COUNT(*) FROM accounts WHERE id = ?1", params![other], |r| r.get(0))
                    .map_err(|e| e.to_string())?;
                if exists == 0 {
                    return Err(format!("account {other} not found"));
                }
                // The far row is the line's exact negation, which is only
                // right in one currency.
                require_same_currency(tx, &account_id, other, "A split line that moves money")?;
                let far = Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT INTO transactions
                       (id, account_id, date, payee, payee_id, category_id, amount_cents,
                        is_reconciled, notes, cleared_state, is_void, is_split_transfer)
                     VALUES (?1, ?2, ?3, ?4, NULL, NULL, ?5, 0, ?6, '', ?7, 1)",
                    params![far, other, date, payee, -split.amount_cents, split.description.as_deref(), is_void_now],
                )
                .map_err(|e| e.to_string())?;
                if is_void_now == 0 {
                    tx.execute(
                        "UPDATE accounts SET balance_cents = balance_cents + ?2,
                                updated_at = datetime('now') WHERE id = ?1",
                        params![other, -split.amount_cents],
                    )
                    .map_err(|e| e.to_string())?;
                }
                Some(far)
            }
            None => None,
        };
        tx.execute(
            "INSERT INTO splits
                 (id, transaction_id, category_id, description, amount_cents, sort_order,
                  transfer_account_id, transfer_txn_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id,
                transaction_id,
                // A transfer line has no category: the account IS where it went.
                if far_id.is_some() { None } else { split.category_id.as_deref() },
                split.description.as_deref(),
                split.amount_cents,
                i as i64,
                split.transfer_account_id.as_deref().filter(|a| !a.is_empty()),
                far_id.as_deref()
            ],
        )
        .map_err(|e| e.to_string())?;
        // The line's own classification values. The old lines' links
        // went with the DELETE above (CASCADE on split_id).
        crate::db::classes::write_line_classes(tx, transaction_id, Some(&id), &split.classes)?;
    }

    // A split transaction has no category of its own.
    if !splits.is_empty() {
        tx.execute(
            "UPDATE transactions SET category_id = NULL WHERE id = ?1",
            params![transaction_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::models::{NewSplit, Transaction};
    use rusqlite::params;
    use super::*;
    use crate::db::queries::test_support::*;

    #[test]
    fn voiding_a_split_payment_voids_its_rows_in_the_other_accounts() {
        let db = TestDb::new("void-split-payment");
        let c = db.conn();
        let chk = account(&c, "Checking", 1_000_000);
        let loan = account(&c, "Mortgage", 0);
        let escrow = account(&c, "Escrow", 0);
        let (pay, principal, _) = split_payment(&c, &chk, &loan, &escrow, "2026-03-01");
        assert_eq!((balance(&c, &loan), balance(&c, &escrow)), (80_000, 20_000));

        set_void(&c, &pay, true).unwrap();
        assert_eq!(balance(&c, &chk), 1_000_000);
        assert_eq!(balance(&c, &loan), 0, "the principal is no longer paid");
        assert_eq!(balance(&c, &escrow), 0);
        assert_consistent(&c);

        // Re-split while void: set_splits writes the new far rows void too.
        // Un-voiding the payment has to bring those back with it.
        set_splits(&c, &pay, &[plain_line(-60_000, None), plain_line(-70_000, Some(&loan)), plain_line(-20_000, Some(&escrow))]).unwrap();
        assert_consistent(&c);
        set_void(&c, &pay, false).unwrap();
        assert_eq!(balance(&c, &chk), 850_000);
        assert_eq!(balance(&c, &loan), 70_000);
        assert_eq!(balance(&c, &escrow), 20_000);
        assert_consistent(&c);

        // The far row on its own is refused, and names the payment.
        let principal_now: String = c
            .query_row(
                "SELECT transfer_txn_id FROM splits WHERE transaction_id = ?1 AND transfer_account_id = ?2",
                params![pay, loan],
                |r| r.get(0),
            )
            .unwrap();
        assert_ne!(principal_now, principal, "re-splitting wrote a new row");
        let err = set_void(&c, &principal_now, true).unwrap_err();
        assert!(err.contains("belongs to a split in Checking (Summit Home Loans, 3/1/2026)"), "{err}");
        assert_eq!(balance(&c, &loan), 70_000, "nothing was voided");
        assert_consistent(&c);
    }

    #[test]
    fn a_split_payments_row_in_another_account_cannot_be_changed_on_its_own() {
        let db = TestDb::new("far-row-refusals");
        let c = db.conn();
        let chk = account(&c, "Checking", 1_000_000);
        let loan = account(&c, "Mortgage", 0);
        let escrow = account(&c, "Escrow", 0);
        let sav = account(&c, "Savings", 0);
        let interest = ensure_category(&c, "Interest Paid").unwrap();
        let (_, principal, _) = split_payment(&c, &chk, &loan, &escrow, "2026-03-01");

        // Amount, date and category are the line's.
        let refused = |r: Result<Transaction, String>| {
            let e = r.unwrap_err();
            assert!(e.contains("belongs to a split in Checking") && e.contains("edit the payment"), "{e}");
        };
        refused(update_transaction(&c, &principal, "2026-03-01", "Summit Home Loans", None, 90_000, None, None));
        refused(update_transaction(&c, &principal, "2026-03-02", "Summit Home Loans", None, 80_000, None, None));
        refused(update_transaction(&c, &principal, "2026-03-01", "Summit Home Loans", Some(&interest), 80_000, None, None));
        // The name and the memo are the row's own.
        update_transaction(&c, &principal, "2026-03-01", "Principal", None, 80_000, Some("March"), None).unwrap();
        assert_consistent(&c);

        let e = convert_to_transfer(&c, &principal, &sav).unwrap_err();
        assert!(e.contains("already a transfer"), "{e}");
        let e = delete_transaction(&c, &principal).unwrap_err();
        assert!(e.contains("delete the payment"), "{e}");
        let e = set_splits(&c, &principal, &[plain_line(80_000, None)]).unwrap_err();
        assert!(e.contains("split the payment instead"), "{e}");
        assert_eq!(balance(&c, &loan), 80_000);
        assert_eq!(balance(&c, &sav), 0);
        assert_consistent(&c);

        // Two identical payments put two identical rows in the loan register
        // (the first one's was renamed above, so two more): the other side of
        // two payments, not a duplicate.
        split_payment(&c, &chk, &loan, &escrow, "2026-04-01");
        split_payment(&c, &chk, &loan, &escrow, "2026-04-01");
        let loan_dups = find_duplicates(&c, &loan, 3).unwrap();
        assert!(loan_dups.is_empty(), "{loan_dups:?}");
        assert_eq!(find_duplicates(&c, &chk, 3).unwrap().len(), 1, "the payments themselves still are");

        assert_consistent(&c);

        // A far row no line points at any more is only clean-up, and may go.
        // Cutting the link takes raw SQL, and the line is left naming a row
        // that is gone — which is what `verify_file` then says.
        db.expect_inconsistent("cuts a split line's link by raw SQL to prove its orphaned far row may be deleted");
        c.execute("UPDATE splits SET transfer_txn_id = NULL WHERE transfer_txn_id = ?1", params![principal]).unwrap();
        delete_transaction(&c, &principal).unwrap();
    }

    #[test]
    fn a_split_payments_new_date_reaches_its_rows_in_the_other_accounts() {
        let db = TestDb::new("split-date");
        let c = db.conn();
        let chk = account(&c, "Checking", 1_000_000);
        let loan = account(&c, "Mortgage", 0);
        let escrow = account(&c, "Escrow", 0);
        let (pay, principal, escrow_row) = split_payment(&c, &chk, &loan, &escrow, "2026-03-01");
        update_transaction(&c, &pay, "2026-03-03", "Summit Home Loans", None, -150_000, None, None).unwrap();
        for id in [&principal, &escrow_row] {
            let d: String = c.query_row("SELECT date FROM transactions WHERE id = ?1", params![id], |r| r.get(0)).unwrap();
            assert_eq!(d, "2026-03-03");
        }
        assert_consistent(&c);

        // And through the form's path, which rewrites the lines first and
        // so writes their rows at the old date.
        let p = crate::models::UpdateTransaction {
            id: pay.clone(),
            date: "2026-03-05".into(),
            payee: "Summit Home Loans".into(),
            category_id: None,
            amount_cents: -150_000,
            notes: None,
            check_number: None,
            splits: Some(vec![plain_line(-70_000, None), plain_line(-80_000, Some(&loan))]),
        };
        update_transaction_with_splits(&c, &p).unwrap();
        assert_eq!(balance(&c, &escrow), 0);
        assert_consistent(&c);
    }

    #[test]
    fn an_edit_refused_after_its_lines_takes_the_lines_back_with_it() {
        let db = TestDb::new("splits-atomic");
        let c = db.conn();
        let chk = account(&c, "Checking", 1_000_000);
        let loan = account(&c, "Mortgage", 0);
        let t = create_transaction(&c, &chk, "2026-03-01", "Summit Home Loans", None, -150_000, None, None).unwrap();
        // The lines total -$1,500.00 but the edit carries -$1,400.00: the
        // edit is refused, and the lines it came with must not stay behind.
        let p = crate::models::UpdateTransaction {
            id: t.id.clone(),
            date: "2026-03-01".into(),
            payee: "Summit Home Loans".into(),
            category_id: None,
            amount_cents: -140_000,
            notes: None,
            check_number: None,
            splits: Some(vec![plain_line(-70_000, None), plain_line(-80_000, Some(&loan))]),
        };
        assert!(update_transaction_with_splits(&c, &p).is_err());
        assert!(list_splits(&c, &t.id).unwrap().is_empty(), "no lines were left written");
        assert_eq!(balance(&c, &loan), 0, "and no row in the loan");
        assert_eq!(balance(&c, &chk), 850_000);
        assert_consistent(&c);

        // A new row whose lines are refused makes no row at all.
        let before = get_register(&c, &chk).unwrap().len();
        let n = crate::models::NewTransaction {
            account_id: chk.clone(),
            date: "2026-03-02".into(),
            payee: "Oops".into(),
            category_id: None,
            amount_cents: -1_000,
            notes: None,
            check_number: None,
            splits: Some(vec![plain_line(-1_000, Some(&chk))]),
        };
        assert!(create_transaction_with_splits(&c, &n).unwrap_err().contains("its own account"));
        assert_eq!(get_register(&c, &chk).unwrap().len(), before);
        assert_eq!(balance(&c, &chk), 850_000);
        assert_consistent(&c);
    }

    #[test]
    fn a_transfer_half_cannot_be_split_even_when_the_lines_add_up() {
        let db = TestDb::new("split-transfer-half");
        let c = db.conn();
        let chk = account(&c, "Checking", 100_000);
        let sav = account(&c, "Savings", 0);
        let t = create_transfer(&c, &chk, &sav, "2026-03-01", 30_000, None).unwrap();
        let e = set_splits(&c, &t.id, &[plain_line(-10_000, None), plain_line(-20_000, None)]).unwrap_err();
        assert!(e.contains("cannot be split"), "{e}");
        assert!(list_splits(&c, &t.id).unwrap().is_empty());
        // Clearing lines that are not there is still harmless.
        set_splits(&c, &t.id, &[]).unwrap();
        assert_consistent(&c);
    }

    #[test]
    fn payee_rules_rename_a_split_row_but_never_file_it() {
        let db = TestDb::new("rules-split");
        let c = db.conn();
        let chk = account(&c, "Checking", 1_000_000);
        let loan = account(&c, "Mortgage", 0);
        let escrow = account(&c, "Escrow", 0);
        let housing = ensure_category(&c, "Housing").unwrap();
        let (pay, _, _) = split_payment(&c, &chk, &loan, &escrow, "2026-03-01");
        create_payee_rule(&c, "SUMMIT HOME LOANS", "Summit Home Loans Servicing", Some(&housing), &Default::default()).unwrap();

        let changes = preview_payee_rules(&c).unwrap();
        let change = changes.iter().find(|x| x.transaction_id == pay).expect("the payment is still renamed");
        assert_eq!(change.new_category_id, None);
        apply_payee_rules(&c).unwrap();
        let (payee, cat): (String, Option<String>) = c
            .query_row("SELECT payee, category_id FROM transactions WHERE id = ?1", params![pay], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(payee, "Summit Home Loans Servicing");
        assert_eq!(cat, None, "a split row's category is its lines'");
        assert_consistent(&c);
    }

    // ── splits and spending ──────────────────────────────────────────────

    #[test]
    fn spending_is_counted_per_split_line_not_per_transaction() {
        let db = TestDb::new("splits");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        let groceries = create_category(&c, "Groceries", "expense", None, None).expect("g");
        let household = create_category(&c, "Household", "expense", None, None).expect("h");
        let txn = create_transaction(&c, &acct, "2026-08-10", "Walmart", None, -12_000, None, None)
            .expect("txn");

        set_splits(
            &c,
            &txn.id,
            &[
                NewSplit { classes: Vec::new(),
                    category_id: Some(groceries.id.clone()),
                    description: None,
                    amount_cents: -9_000,
                    transfer_account_id: None,
                },
                NewSplit { classes: Vec::new(),
                    category_id: Some(household.id.clone()),
                    description: None,
                    amount_cents: -3_000,
                    transfer_account_id: None,
                },
            ],
        )
        .expect("set_splits");

        let summary = get_spending_summary(&c, "2026-08").expect("summary");
        let spent = |name: &str| {
            summary
                .iter()
                .find(|r| r.category_name == name)
                .map(|r| r.spent_cents)
                .unwrap_or(0)
        };
        // A split transaction has no category of its own; grouping on
        // transactions.category_id would have dropped all of this.
        assert_eq!(spent("Groceries"), 9_000);
        assert_eq!(spent("Household"), 3_000);

        // The account balance is still the parent's single amount.
        assert_eq!(balance(&c, &acct), 88_000);
    }

    // -----------------------------------------------------------------------
    // What the review found
    // -----------------------------------------------------------------------

    #[test]
    fn a_split_transactions_total_cannot_be_changed_behind_its_lines() {
        let db = TestDb::new("edit-split-total");
        let c = db.conn();
        let acct = account(&c, "Checking", 0);
        let txn = create_transaction(&c, &acct, "2026-08-10", "Walmart", None, -10_000, None, None)
            .expect("txn");
        set_splits(
            &c,
            &txn.id,
            &[
                NewSplit { classes: Vec::new(), category_id: None, description: None, amount_cents: -6_000, transfer_account_id: None },
                NewSplit { classes: Vec::new(), category_id: None, description: None, amount_cents: -4_000, transfer_account_id: None },
            ],
        )
        .expect("splits");
        let err = update_transaction(&c, &txn.id, "2026-08-10", "Walmart", None, -11_000, None, None)
            .expect_err("refused");
        assert!(err.contains("$100.00"), "{err}");
        assert_eq!(balance(&c, &acct), -10_000, "the balance moved on a refused edit");
        // Same total, other fields: fine.
        update_transaction(&c, &txn.id, "2026-08-11", "Walmart Supercenter", None, -10_000, None, None)
            .expect("an edit that keeps the total is allowed");
    }

    #[test]
    fn the_split_dialog_is_where_a_split_total_changes() {
        // Reviewer's regression: with update_transaction refusing amount
        // changes on a split row, the dialog's new total had nowhere to go.
        // `set_splits` moves the parent to the lines' sum, balance included.
        let db = TestDb::new("split-total-moves");
        let c = db.conn();
        let acct = account(&c, "Checking", 0);
        let txn = create_transaction(&c, &acct, "2026-08-10", "Walmart", None, -10_000, None, None)
            .expect("txn");
        set_splits(
            &c,
            &txn.id,
            &[
                NewSplit { classes: Vec::new(), category_id: None, description: None, amount_cents: -6_000, transfer_account_id: None },
                NewSplit { classes: Vec::new(), category_id: None, description: None, amount_cents: -4_000, transfer_account_id: None },
            ],
        )
        .expect("splits");
        set_splits(
            &c,
            &txn.id,
            &[
                NewSplit { classes: Vec::new(), category_id: None, description: None, amount_cents: -6_000, transfer_account_id: None },
                NewSplit { classes: Vec::new(), category_id: None, description: None, amount_cents: -5_500, transfer_account_id: None },
            ],
        )
        .expect("a new total is allowed here");
        assert_eq!(balance(&c, &acct), -11_500, "the balance did not follow the new total");
        let amt: i64 = c
            .query_row("SELECT amount_cents FROM transactions WHERE id = ?1", params![txn.id], |r| r.get(0))
            .expect("row");
        assert_eq!(amt, -11_500);
        // Voided: the lines can change, the balance cannot.
        set_void(&c, &txn.id, true).expect("void");
        assert_eq!(balance(&c, &acct), 0);
        set_splits(&c, &txn.id, &[NewSplit { classes: Vec::new(), category_id: None, description: None, amount_cents: -1, transfer_account_id: None }])
            .expect("splits on a void row");
        assert_eq!(balance(&c, &acct), 0, "a voided row moved the balance");
    }

    // Enter on a split entry is ONE undo step: the row and its lines
    // are written together and taken back together.
    #[test]
    fn a_split_entry_is_written_and_undone_as_one_step() {
        use crate::db::undo;
        let db = TestDb::new("split-undo");
        let c = db.conn();
        let chk = account(&c, "Checking", 100_000);
        let groc = ensure_category(&c, "Groceries").unwrap();
        let fuel = ensure_category(&c, "Fuel").unwrap();
        let line = |cat: &str, cents: i64| NewSplit { classes: Vec::new(), category_id: Some(cat.to_string()), description: None, amount_cents: cents, transfer_account_id: None };
        let payload = crate::models::NewTransaction {
            account_id: chk.clone(),
            date: "2026-09-13".into(),
            payee: "Walmart".into(),
            category_id: None,
            amount_cents: -4_250,
            notes: None,
            check_number: None,
            splits: Some(vec![line(&groc, -3_000), line(&fuel, -1_250)]),
        };
        // Exactly what the command does: one recording around the whole thing.
        let (made, step) = undo::recording(&c, "add a transaction", &[], || create_transaction_with_splits(&c, &payload)).unwrap();
        let ids = undo::related_ids(&c, &made.id).unwrap();
        let mut step = step;
        step.after = undo::snapshot(&c, &ids).unwrap();
        step.before.txn_ids = ids;
        assert_eq!(list_splits(&c, &made.id).unwrap().len(), 2);
        assert_eq!(balance(&c, &chk), 95_750);

        // One undo: the row AND its lines are gone, and the balance is back.
        undo::restore(&c, &step.before, &step.after.accounts).unwrap();
        assert!(entered(&c, &chk).iter().all(|r| r.id != made.id));
        let n: i64 = c.query_row("SELECT COUNT(*) FROM splits WHERE transaction_id = ?1", params![made.id], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
        assert_eq!(balance(&c, &chk), 100_000);
        // And redo brings both back.
        undo::restore(&c, &step.after, &step.before.accounts).unwrap();
        assert_eq!(list_splits(&c, &made.id).unwrap().len(), 2);
        assert_eq!(balance(&c, &chk), 95_750);

        // Lines that are refused take the row with them: no half-entry.
        let mut bad = payload.clone();
        bad.splits = Some(vec![NewSplit { classes: Vec::new(), category_id: Some("no-such-category".into()), description: None, amount_cents: -4_250, transfer_account_id: None }]);
        let before = entered(&c, &chk).len();
        assert!(create_transaction_with_splits(&c, &bad).is_err());
        assert_eq!(entered(&c, &chk).len(), before, "a refused split leaves no row behind");
        assert_eq!(balance(&c, &chk), 95_750);

        // The edit path: lines and the edit in one call, lines first.
        let edit = crate::models::UpdateTransaction {
            id: made.id.clone(),
            date: "2026-09-13".into(),
            payee: "Walmart".into(),
            category_id: None,
            amount_cents: -5_000,
            notes: None,
            check_number: None,
            splits: Some(vec![line(&groc, -5_000)]),
        };
        update_transaction_with_splits(&c, &edit).unwrap();
        assert_eq!(list_splits(&c, &made.id).unwrap().len(), 1);
        assert_eq!(balance(&c, &chk), 95_000);
        // None leaves the lines alone; Some(empty) clears them.
        let mut keep = edit.clone();
        keep.splits = None;
        update_transaction_with_splits(&c, &keep).unwrap();
        assert_eq!(list_splits(&c, &made.id).unwrap().len(), 1);
        let mut clear = edit.clone();
        clear.splits = Some(Vec::new());
        update_transaction_with_splits(&c, &clear).unwrap();
        assert_eq!(list_splits(&c, &made.id).unwrap().len(), 0);
    }

    /// A split line is a transfer too. A NEW line to a closed account
    /// is refused; a payment whose line already went there before the close
    /// can still be edited and saved with that line.
    #[test]
    fn a_split_line_may_keep_a_closed_account_but_not_gain_one() {
        let db = TestDb::new("closed-split");
        let c = db.conn();
        let chk = account(&c, "Checking", 1_000_000);
        let loan = account(&c, "Loan", 0);
        let old = account(&c, "Old Loan", 0);
        let pay = create_transaction(&c, &chk, "2026-03-01", "Bank", None, -100_000, None, None).unwrap();
        set_splits(&c, &pay.id, &[transfer_line(-60_000, Some(&old)), transfer_line(-40_000, None)]).unwrap();
        close(&c, &old);

        // The same line again (the register re-sends every line on any save).
        set_splits(&c, &pay.id, &[transfer_line(-60_000, Some(&old)), transfer_line(-40_000, None)]).unwrap();
        assert_eq!(balance(&c, &old), 60_000);
        assert_consistent(&c);

        // A new payment with a line to it.
        let pay2 = create_transaction(&c, &chk, "2026-04-01", "Bank", None, -10_000, None, None).unwrap();
        let err = set_splits(&c, &pay2.id, &[transfer_line(-10_000, Some(&old))]).unwrap_err();
        assert!(err.contains("Old Loan is closed"), "{err}");
        // And the same through the one-command create the register uses.
        let err = create_transaction_with_splits(
            &c,
            &crate::models::NewTransaction {
                account_id: chk.clone(),
                date: "2026-04-02".into(),
                payee: "Bank".into(),
                category_id: None,
                amount_cents: -10_000,
                notes: None,
                check_number: None,
                splits: Some(vec![transfer_line(-10_000, Some(&old))]),
            },
        )
        .unwrap_err();
        assert!(err.contains("Old Loan is closed"), "{err}");
        assert_eq!(balance(&c, &old), 60_000, "no far row was written");
        // An open account is still fine on the same payment.
        set_splits(&c, &pay2.id, &[transfer_line(-10_000, Some(&loan))]).unwrap();
        assert_consistent(&c);
    }

    /// The register row says it is a split line's far row, and which
    /// account the payment is in, so the form can say so before a refusal.
    #[test]
    fn the_register_marks_a_far_row_and_names_its_payment_account() {
        let db = TestDb::new("far-row-flag");
        let c = db.conn();
        let chk = account(&c, "Checking", 1_000_000);
        let loan = account(&c, "Mortgage", 0);
        let escrow = account(&c, "Escrow", 0);
        let (pay, far, _) = split_payment(&c, &chk, &loan, &escrow, "2026-03-01");
        let rows = get_register(&c, &loan).unwrap();
        let row = rows.iter().find(|r| r.id == far).unwrap();
        assert!(row.is_split_transfer);
        assert_eq!(row.split_payment_account_name.as_deref(), Some("Checking"));
        let payment = get_register(&c, &chk).unwrap().into_iter().find(|r| r.id == pay).unwrap();
        assert!(!payment.is_split_transfer);
        assert_eq!(payment.split_payment_account_name, None);
    }
}
