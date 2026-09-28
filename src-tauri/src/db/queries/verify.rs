//! Verify this file (§83): reading the whole file back against itself.

use crate::models::{BalanceDrift, FileCheck};
use rusqlite::{params, Connection};

// ---------------------------------------------------------------------------
// Verify this file (§83)
// ---------------------------------------------------------------------------

/// Every balance in the file is kept incrementally on write and nothing ever
/// re-derived one — a drift would have been silent until a statement did not
/// balance. This reads the whole file back against itself: SQLite's own
/// integrity and foreign-key checks, every account's stored balance against
/// the sum of its rows, transfers whose other half is missing, splits that
/// do not add up. `repair` recomputes drifted balances and unlinks orphaned
/// transfer halves — the two things with one right answer. The rest is
/// reported for a person to look at. One transaction; nothing partial.
pub fn verify_file(conn: &Connection, repair: bool) -> Result<FileCheck, String> {
    let mut out = FileCheck::default();
    // integrity_check returns one row "ok" or up to 100 problem lines.
    {
        let mut st = conn.prepare("PRAGMA integrity_check").map_err(|e| e.to_string())?;
        let lines: Vec<String> = st.query_map([], |r| r.get(0)).map_err(|e| e.to_string())?.collect::<Result<_, _>>().map_err(|e| e.to_string())?;
        out.integrity = lines.into_iter().filter(|l| l != "ok").collect();
    }
    {
        let mut st = conn.prepare("PRAGMA foreign_key_check").map_err(|e| e.to_string())?;
        let rows: Vec<(String, i64, String)> = st
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        out.foreign_keys = rows.into_iter().map(|(t, id, p)| format!("{t}: rowid {id} → {p}")).collect();
    }
    out.accounts = conn.query_row("SELECT COUNT(*) FROM accounts", [], |r| r.get::<_, i64>(0)).map_err(|e| e.to_string())? as u32;
    out.transactions = conn.query_row("SELECT COUNT(*) FROM transactions", [], |r| r.get::<_, i64>(0)).map_err(|e| e.to_string())? as u32;
    {
        let mut st = conn
            .prepare(
                "SELECT a.id, a.name, a.balance_cents,
                        COALESCE((SELECT SUM(t.amount_cents) FROM transactions t WHERE t.account_id = a.id AND t.is_void = 0), 0)
                   FROM accounts a ORDER BY a.name",
            )
            .map_err(|e| e.to_string())?;
        let rows: Vec<BalanceDrift> = st
            .query_map([], |r| {
                Ok(BalanceDrift { account_id: r.get(0)?, account_name: r.get(1)?, stored_cents: r.get(2)?, computed_cents: r.get(3)? })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        out.drift = rows.into_iter().filter(|d| d.stored_cents != d.computed_cents).collect();
    }
    let halves: Vec<(String, String)> = {
        let mut st = conn
            .prepare(
                "SELECT t.id, t.date, t.payee, t.amount_cents, a.name
                   FROM transactions t JOIN accounts a ON a.id = t.account_id
                  WHERE t.transfer_id IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM transactions p WHERE p.id = t.transfer_id)
                  ORDER BY t.date",
            )
            .map_err(|e| e.to_string())?;
        let rows: Vec<(String, String)> = st
            .query_map([], |r| {
                let (id, date, payee, cents, acct): (String, String, String, i64, String) = (r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?);
                Ok((id, format!("{date} {payee} {} ({acct})", crate::models::format_cents(cents))))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };
    out.half_transfers = halves.iter().map(|h| h.1.clone()).collect();
    {
        let mut st = conn
            .prepare(
                "SELECT t.date, t.payee, s.total, t.amount_cents
                   FROM transactions t
                   JOIN (SELECT transaction_id, SUM(amount_cents) AS total FROM splits GROUP BY transaction_id) s ON s.transaction_id = t.id
                  WHERE s.total <> t.amount_cents
                  ORDER BY t.date",
            )
            .map_err(|e| e.to_string())?;
        out.split_mismatch = st
            .query_map([], |r| {
                let (date, payee, lines, row): (String, String, i64, i64) = (r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?);
                Ok(format!("{date} {payee}: lines {}, row {}", crate::models::format_cents(lines), crate::models::format_cents(row)))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
    }
    let split_transfers = split_transfer_problems(conn)?;
    out.split_transfers = split_transfers.iter().map(|p| p.label.clone()).collect();

    let repairable = split_transfers.iter().any(|p| p.fix.is_some());
    if repair && (!out.drift.is_empty() || !halves.is_empty() || repairable) {
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        for p in &split_transfers {
            match &p.fix {
                Some(SplitTransferFix::Relink { split_id, far_id }) => {
                    tx.execute("UPDATE splits SET transfer_txn_id = ?2 WHERE id = ?1", params![split_id, far_id])
                        .map_err(|e| e.to_string())?;
                    out.repaired.push(format!("{}: relinked to its row in the other account", p.label));
                }
                Some(SplitTransferFix::Sync { far_id, account_id, date, amount_cents, is_void }) => {
                    tx.execute(
                        "UPDATE transactions SET account_id = ?2, date = ?3, amount_cents = ?4, is_void = ?5 WHERE id = ?1",
                        params![far_id, account_id, date, amount_cents, is_void],
                    )
                    .map_err(|e| e.to_string())?;
                    out.repaired.push(format!("{}: the other account's row now matches the split line", p.label));
                }
                None => {}
            }
        }
        // A relinked or resynced row moves money, so balances are recomputed
        // AFTER those, from the rows as they now stand — not from the drift
        // measured before anything was touched.
        let drift_now: Vec<BalanceDrift> = {
            let mut st = tx
                .prepare(
                    "SELECT a.id, a.name, a.balance_cents,
                            COALESCE((SELECT SUM(t.amount_cents) FROM transactions t WHERE t.account_id = a.id AND t.is_void = 0), 0)
                       FROM accounts a ORDER BY a.name",
                )
                .map_err(|e| e.to_string())?;
            let rows: Vec<BalanceDrift> = st
                .query_map([], |r| {
                    Ok(BalanceDrift { account_id: r.get(0)?, account_name: r.get(1)?, stored_cents: r.get(2)?, computed_cents: r.get(3)? })
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<_, _>>()
                .map_err(|e| e.to_string())?;
            rows.into_iter().filter(|d| d.stored_cents != d.computed_cents).collect()
        };
        for d in &drift_now {
            tx.execute(
                "UPDATE accounts SET balance_cents = ?2, updated_at = datetime('now') WHERE id = ?1",
                params![d.account_id, d.computed_cents],
            )
            .map_err(|e| e.to_string())?;
            out.repaired.push(format!(
                "{}: balance set to {} (was {})",
                d.account_name,
                crate::models::format_cents(d.computed_cents),
                crate::models::format_cents(d.stored_cents)
            ));
        }
        for (id, label) in &halves {
            tx.execute("UPDATE transactions SET transfer_id = NULL WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
            out.repaired.push(format!("{label}: unlinked — its other half was gone"));
        }
        tx.commit().map_err(|e| e.to_string())?;
    }
    Ok(out)
}

/// What `repair` may do about one split-transfer problem. Only the cases with
/// one right answer carry a fix; the rest are reported for a person.
enum SplitTransferFix {
    /// The line lost its link, and exactly one unlinked row in the account it
    /// names has its date and opposite amount: that row is its far side.
    Relink { split_id: String, far_id: String },
    /// The link is intact but the far row disagrees with the line or its
    /// parent. The line is what the user entered, so the far row follows it.
    Sync { far_id: String, account_id: String, date: String, amount_cents: i64, is_void: i64 },
}

struct SplitTransferProblem {
    label: String,
    fix: Option<SplitTransferFix>,
}

/// §177 — a split line that is a transfer (§94) writes a row in the other
/// account and keeps its id in `splits.transfer_txn_id`. Nothing else ties
/// the two, so a write that follows `transactions.transfer_id` alone — void,
/// undo, the duplicates dialog — could leave them disagreeing, and the balance
/// check above cannot see it: each account still equals its own rows. The
/// mortgage payment voided in checking, with the loan still showing the
/// principal paid, is the case this was written for.
fn split_transfer_problems(conn: &Connection) -> Result<Vec<SplitTransferProblem>, String> {
    let err = |e: rusqlite::Error| e.to_string();
    let money = crate::models::format_cents;

    // 1. Linked, but the far row does not say what the line says.
    let mut problems: Vec<SplitTransferProblem> = Vec::new();
    {
        let mut st = conn
            .prepare(
                "SELECT t.date, t.payee, a.name, s.amount_cents, t.is_void,
                        s.transfer_account_id, f.id, f.account_id, f.date, f.amount_cents, f.is_void, f.is_split_transfer
                   FROM splits s
                   JOIN transactions t ON t.id = s.transaction_id
                   JOIN accounts a ON a.id = t.account_id
                   JOIN transactions f ON f.id = s.transfer_txn_id
                  WHERE s.transfer_account_id IS NOT NULL
                    AND (f.account_id <> s.transfer_account_id OR f.date <> t.date
                         OR f.amount_cents <> -s.amount_cents OR f.is_void <> t.is_void
                         OR f.is_split_transfer = 0)
                  ORDER BY t.date",
            )
            .map_err(err)?;
        let rows = st
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?,
                    r.get::<_, i64>(4)?, r.get::<_, String>(5)?, r.get::<_, String>(6)?, r.get::<_, String>(7)?,
                    r.get::<_, String>(8)?, r.get::<_, i64>(9)?, r.get::<_, i64>(10)?, r.get::<_, i64>(11)?,
                ))
            })
            .map_err(err)?;
        for row in rows {
            let (date, payee, acct, line, void, to_acct, far_id, f_acct, f_date, f_amount, f_void, is_far) = row.map_err(err)?;
            let mut why = Vec::new();
            if f_acct != to_acct {
                why.push("it is in a different account".to_string());
            }
            if f_date != date {
                why.push(format!("it is dated {f_date}"));
            }
            if f_amount != -line {
                why.push(format!("it is {}", money(f_amount)));
            }
            if f_void != void {
                why.push(if void != 0 { "the payment is void and it is not".to_string() } else { "it is void and the payment is not".to_string() });
            }
            if is_far == 0 {
                why.push("it is an ordinary transaction, not a split's row".to_string());
            }
            problems.push(SplitTransferProblem {
                label: format!("{date} {payee} ({acct}), line {}: the other account's row disagrees — {}", money(line), why.join(", ")),
                // An ordinary row is somebody's own entry; rewriting it is not
                // one right answer.
                fix: (is_far != 0).then(|| SplitTransferFix::Sync {
                    far_id,
                    account_id: to_acct,
                    date,
                    amount_cents: -line,
                    is_void: void,
                }),
            });
        }
    }

    // 2. Lines whose far row is gone, and 3. far rows no line points at. They
    // are read together because one is often the other's missing half: an
    // undo that re-inserted the far row cut the line's link (fixed in §178).
    let lost: Vec<(String, String, String, String, i64, String, i64)> = {
        let mut st = conn
            .prepare(
                "SELECT s.id, t.date, t.payee, a.name, s.amount_cents, s.transfer_account_id, t.is_void
                   FROM splits s
                   JOIN transactions t ON t.id = s.transaction_id
                   JOIN accounts a ON a.id = t.account_id
                  WHERE s.transfer_account_id IS NOT NULL
                    AND (s.transfer_txn_id IS NULL
                         OR NOT EXISTS (SELECT 1 FROM transactions f WHERE f.id = s.transfer_txn_id))
                  ORDER BY t.date",
            )
            .map_err(err)?;
        let rows = st
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)))
            .map_err(err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(err)?;
        rows
    };
    let orphans: Vec<(String, String, String, String, i64, String, i64)> = {
        let mut st = conn
            .prepare(
                "SELECT f.id, f.date, f.payee, a.name, f.amount_cents, f.account_id, f.is_void
                   FROM transactions f JOIN accounts a ON a.id = f.account_id
                  WHERE f.is_split_transfer = 1
                    AND NOT EXISTS (SELECT 1 FROM splits s WHERE s.transfer_txn_id = f.id)
                  ORDER BY f.date",
            )
            .map_err(err)?;
        let rows = st
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)))
            .map_err(err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(err)?;
        rows
    };
    let candidates = |date: &str, amount: i64, account: &str| -> Vec<usize> {
        orphans
            .iter()
            .enumerate()
            .filter(|(_, o)| o.1 == date && o.4 == -amount && o.5 == account)
            .map(|(i, _)| i)
            .collect()
    };
    let mut claimed = vec![0u32; orphans.len()];
    for l in &lost {
        for i in candidates(&l.1, l.4, &l.5) {
            claimed[i] += 1;
        }
    }
    let mut relinked = vec![false; orphans.len()];
    for (split_id, date, payee, acct, line, to_acct, void) in &lost {
        let found = candidates(date, *line, to_acct);
        // Exactly one row fits, and no other lost line wants the same row.
        let unique = (found.len() == 1 && claimed[found[0]] == 1).then(|| found[0]);
        let label = format!("{date} {payee} ({acct}), line {}: its row in the other account is missing", money(*line));
        match unique {
            Some(i) => {
                relinked[i] = true;
                let far = &orphans[i];
                problems.push(SplitTransferProblem {
                    label: label.clone(),
                    fix: Some(SplitTransferFix::Relink { split_id: split_id.clone(), far_id: far.0.clone() }),
                });
                if far.6 != *void {
                    problems.push(SplitTransferProblem {
                        label: format!("{label} — and that row's void mark differs from the payment's"),
                        fix: Some(SplitTransferFix::Sync {
                            far_id: far.0.clone(),
                            account_id: to_acct.clone(),
                            date: date.clone(),
                            amount_cents: -line,
                            is_void: *void,
                        }),
                    });
                }
            }
            None => problems.push(SplitTransferProblem {
                label: format!("{label} — open the payment and save it again to rewrite it"),
                fix: None,
            }),
        }
    }
    for (i, (_, date, payee, acct, amount, _, _)) in orphans.iter().enumerate() {
        if !relinked[i] {
            problems.push(SplitTransferProblem {
                label: format!(
                    "{date} {payee} {} ({acct}): a split's row that no payment refers to — it still counts in this account",
                    money(*amount)
                ),
                fix: None,
            });
        }
    }
    Ok(problems)
}

#[cfg(test)]
mod tests {
    use crate::models::NewSplit;
    use rusqlite::params;
    use super::*;
    use crate::db::queries::*;
    use crate::db::queries::test_support::*;

    // §80: the register's running balance was a correlated subquery — O(n²),
    // seconds on a couple of years of a real checking account. Now a window
    // function. This test checks it against a plain fold over 20,000 rows
    // (dates shuffled, voids sprinkled) and prints the time; the number is
    // not asserted (CI machines vary) but it should be well under a second.
    // §83: a balance nudged behind the app's back, a transfer whose other
    // half was deleted by hand, a split that no longer adds up.
    #[test]
    fn verify_file_finds_drift_half_transfers_and_bad_splits_and_repairs_the_first_two() {
        let db = TestDb::new("verify");
        db.expect_inconsistent("breaks a balance, a transfer and a split by raw SQL, and a split that does not add up is never repaired");
        let c = db.conn();
        let chk = account(&c, "Checking", 100_000);
        let sav = account(&c, "Savings", 0);
        let clean = verify_file(&c, false).unwrap();
        assert!(clean.integrity.is_empty() && clean.foreign_keys.is_empty() && clean.drift.is_empty() && clean.half_transfers.is_empty() && clean.split_mismatch.is_empty());
        assert_eq!((clean.accounts, clean.transactions), (2, 1));

        create_transfer(&c, &chk, &sav, "2026-02-01", 25_000, None).unwrap();
        let t = create_transaction(&c, &chk, "2026-02-02", "Store", None, -5_000, None, None).unwrap();
        set_splits(&c, &t.id, &[NewSplit { classes: Vec::new(), category_id: None, description: None, amount_cents: -3_000, transfer_account_id: None }, NewSplit { classes: Vec::new(), category_id: None, description: None, amount_cents: -2_000, transfer_account_id: None }]).unwrap();
        assert!(verify_file(&c, false).unwrap().drift.is_empty(), "the app's own writes keep balances right");

        // Behind the app's back.
        c.execute("UPDATE accounts SET balance_cents = balance_cents + 1 WHERE id = ?1", params![chk]).unwrap();
        // The FK refuses this while enforcement is on — which is the point:
        // a half transfer can only come from a tool that switched it off.
        c.execute_batch("PRAGMA foreign_keys = OFF").unwrap();
        c.execute("DELETE FROM transactions WHERE account_id = ?1 AND transfer_id IS NOT NULL", params![sav]).unwrap();
        c.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        c.execute("UPDATE splits SET amount_cents = -2_500 WHERE amount_cents = -3_000", []).unwrap();

        let found = verify_file(&c, false).unwrap();
        assert_eq!(found.drift.len(), 2, "Checking nudged; Savings lost its row but kept its balance");
        let chk_drift = found.drift.iter().find(|d| d.account_id == chk).unwrap();
        assert_eq!((chk_drift.stored_cents, chk_drift.computed_cents), (70_001, 70_000));
        assert_eq!(found.half_transfers.len(), 1);
        assert!(found.half_transfers[0].contains("(Checking)"), "{}", found.half_transfers[0]);
        assert_eq!(found.split_mismatch, vec!["2026-02-02 Store: lines -$45.00, row -$50.00".to_string()]);
        assert!(found.repaired.is_empty(), "a dry run repairs nothing");
        assert_eq!(get_account(&c, &chk).unwrap().balance_cents, 70_001);

        let fixed = verify_file(&c, true).unwrap();
        assert_eq!(fixed.repaired.len(), 3);
        assert_eq!(get_account(&c, &chk).unwrap().balance_cents, 70_000);
        assert_eq!(get_account(&c, &sav).unwrap().balance_cents, 0);
        let again = verify_file(&c, false).unwrap();
        assert!(again.drift.is_empty() && again.half_transfers.is_empty());
        assert_eq!(again.split_mismatch.len(), 1, "a split that does not add up is reported, never guessed at");
    }

    // §177: a mortgage payment split into interest, principal (to the loan)
    // and escrow (to the escrow account). Each account equals its own rows in
    // every case below, so the balance check sees nothing — this one must.
    #[test]
    fn verify_file_finds_split_transfer_rows_that_disagree_with_their_payment() {
        let db = TestDb::new("verify-split-transfers");
        db.expect_inconsistent("ends on a raw-SQL orphan row that repair must report and leave alone");
        let c = db.conn();
        let chk = account(&c, "Checking", 1_000_000);
        let loan = account(&c, "Mortgage", 0);
        let escrow = account(&c, "Escrow", 0);
        let pay = create_transaction(&c, &chk, "2026-03-01", "Summit Home Loans", None, -150_000, None, None).unwrap();
        let line = |amount, to: Option<&str>| NewSplit {
            classes: Vec::new(),
            category_id: None,
            description: None,
            amount_cents: amount,
            transfer_account_id: to.map(str::to_string),
        };
        set_splits(&c, &pay.id, &[line(-50_000, None), line(-80_000, Some(&loan)), line(-20_000, Some(&escrow))]).unwrap();
        let clean = verify_file(&c, false).unwrap();
        assert!(clean.split_transfers.is_empty(), "{:?}", clean.split_transfers);

        // 1. The payment voided the way set_void did before §177: only the
        // checking row. The loan and escrow rows still count.
        c.execute("UPDATE transactions SET is_void = 1 WHERE id = ?1", params![pay.id]).unwrap();
        c.execute("UPDATE accounts SET balance_cents = balance_cents + 150000 WHERE id = ?1", params![chk]).unwrap();
        let found = verify_file(&c, false).unwrap();
        assert!(found.drift.is_empty(), "every account still equals its own rows");
        assert_eq!(found.split_transfers.len(), 2, "{:?}", found.split_transfers);
        assert!(found.split_transfers.iter().all(|l| l.contains("the payment is void and it is not")), "{:?}", found.split_transfers);
        let fixed = verify_file(&c, true).unwrap();
        assert!(!fixed.repaired.is_empty());
        assert_eq!(get_account(&c, &loan).unwrap().balance_cents, 0);
        assert_eq!(get_account(&c, &escrow).unwrap().balance_cents, 0);
        assert_eq!(get_account(&c, &chk).unwrap().balance_cents, 1_000_000);
        let after = verify_file(&c, false).unwrap();
        assert!(after.split_transfers.is_empty() && after.drift.is_empty(), "{:?}", after.split_transfers);

        // 2. The principal line's link cut, as an undo that re-inserted the
        // loan row used to leave it: one lost line, one unlinked row that fits.
        c.execute("UPDATE transactions SET is_void = 0 WHERE is_void = 1", []).unwrap();
        verify_file(&c, true).unwrap(); // balances back after un-voiding by hand
        c.execute("UPDATE splits SET transfer_txn_id = NULL WHERE transfer_account_id = ?1", params![loan]).unwrap();
        let cut = verify_file(&c, false).unwrap();
        assert_eq!(cut.split_transfers.len(), 1, "the lost line and its row are one problem: {:?}", cut.split_transfers);
        assert!(cut.split_transfers[0].contains("line -$800.00"), "{}", cut.split_transfers[0]);
        verify_file(&c, true).unwrap();
        assert!(verify_file(&c, false).unwrap().split_transfers.is_empty());
        let linked: i64 = c
            .query_row("SELECT COUNT(*) FROM splits WHERE transfer_account_id = ?1 AND transfer_txn_id IS NOT NULL", params![loan], |r| r.get(0))
            .unwrap();
        assert_eq!(linked, 1, "relinked to the row that was there, not a second one written");
        assert_eq!(get_account(&c, &loan).unwrap().balance_cents, 80_000);

        // 3. A second escrow row no line refers to: nothing says which is
        // real, so it is reported and left alone.
        c.execute(
            "INSERT INTO transactions (id, account_id, date, payee, amount_cents, is_reconciled, cleared_state, is_void, is_split_transfer)
             SELECT 'dup-escrow', account_id, date, payee, amount_cents, 0, '', 0, 1 FROM transactions
              WHERE account_id = ?1 AND is_split_transfer = 1",
            params![escrow],
        )
        .unwrap();
        let orphan = verify_file(&c, true).unwrap();
        assert_eq!(orphan.split_transfers.len(), 1, "{:?}", orphan.split_transfers);
        assert!(orphan.split_transfers[0].contains("no payment refers to"), "{}", orphan.split_transfers[0]);
        let still: i64 = c.query_row("SELECT COUNT(*) FROM transactions WHERE id = 'dup-escrow'", [], |r| r.get(0)).unwrap();
        assert_eq!(still, 1, "repair never deletes a row it cannot place");
    }
}
