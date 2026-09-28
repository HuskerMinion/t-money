//! Goals, the per-transaction tax line and goal tag, and payments.

use crate::models::{Goal, Payment};
use rusqlite::{params, Connection, Row};
use uuid::Uuid;
use super::*;

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

const GOAL_SELECT: &str = "SELECT g.id, g.name, g.target_cents, g.saved_cents, g.deadline, g.notes, g.updated_at,
            g.account_id, a.name,
            COALESCE((SELECT SUM(t.amount_cents) FROM transactions t
                       WHERE t.goal_id = g.id AND t.is_void = 0), 0),
            (SELECT COUNT(*) FROM transactions t WHERE t.goal_id = g.id AND t.is_void = 0)
       FROM goals g
       LEFT JOIN accounts a ON a.id = g.account_id";

fn map_goal(row: &Row) -> rusqlite::Result<Goal> {
    let starting: i64 = row.get(3)?;
    let linked: i64 = row.get(9)?;
    Ok(Goal {
        id: row.get(0)?,
        name: row.get(1)?,
        target_cents: row.get(2)?,
        saved_cents: starting + linked,
        deadline: row.get(4)?,
        notes: row.get(5)?,
        updated_at: row.get(6)?,
        account_id: row.get(7)?,
        account_name: row.get(8)?,
        starting_cents: starting,
        linked_cents: linked,
        linked_count: row.get(10)?,
    })
}

pub fn list_goals(conn: &Conn) -> Result<Vec<Goal>, String> {
    let mut stmt = conn
        .prepare(&format!("{GOAL_SELECT} ORDER BY g.name"))
        .map_err(|e| e.to_string())?;
    let out = stmt
        .query_map([], map_goal)
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(out)
}

pub fn get_goal(conn: &Connection, id: &str) -> Result<Goal, String> {
    conn.query_row(&format!("{GOAL_SELECT} WHERE g.id = ?1"), params![id], map_goal)
        .map_err(|e| format!("goal {id} not found: {e}"))
}

fn check_goal_account(conn: &Connection, account_id: Option<&str>) -> Result<(), String> {
    if let Some(a) = account_id {
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM accounts WHERE id = ?1", params![a], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err(format!("account {a} not found"));
        }
    }
    Ok(())
}

/// `saved_cents` is the STARTING amount; with an `account_id` the goal's
/// progress grows with every row tagged for it (§46).
pub fn create_goal(
    conn: &Conn,
    name: &str,
    target_cents: i64,
    saved_cents: i64,
    deadline: Option<&str>,
    notes: Option<&str>,
    account_id: Option<&str>,
) -> Result<Goal, String> {
    let account_id = account_id.filter(|a| !a.is_empty());
    check_goal_account(conn, account_id)?;
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO goals (id, name, target_cents, saved_cents, deadline, notes, account_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, name, target_cents, saved_cents, deadline, notes, account_id],
    )
    .map_err(|e| e.to_string())?;
    get_goal(conn, &id)
}

/// Re-pointing a linked goal at another account drops the tags on the old
/// account's rows: a row can only count toward a goal in its own account.
pub fn update_goal(
    conn: &Conn,
    id: &str,
    name: &str,
    target_cents: i64,
    saved_cents: i64,
    deadline: Option<&str>,
    notes: Option<&str>,
    account_id: Option<&str>,
) -> Result<Goal, String> {
    let account_id = account_id.filter(|a| !a.is_empty());
    check_goal_account(conn, account_id)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE goals SET name = ?1, target_cents = ?2, saved_cents = ?3,
         deadline = ?4, notes = ?5, account_id = ?6, updated_at = datetime('now') WHERE id = ?7",
        params![name, target_cents, saved_cents, deadline, notes, account_id, id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE transactions SET goal_id = NULL
          WHERE goal_id = ?1 AND (?2 IS NULL OR account_id <> ?2)",
        params![id, account_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    get_goal(conn, id)
}

pub fn delete_goal(conn: &Conn, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM goals WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Tag a row for a goal, or untag it (`None`). The row must sit in the
/// goal's account — or be the other half of a transfer INTO it, in which
/// case the half in the goal's account is the one tagged, so "move $200 from
/// checking for the roof" can be said from either register.
/// Money's per-transaction tax line (§53). `None` follows the category
/// again; `Some("")` takes the row out of the tax reports; `Some(line)`
/// puts it on that line whatever its category says.
pub fn set_transaction_tax_line(conn: &Conn, transaction_id: &str, tax_line: Option<&str>) -> Result<(), String> {
    // The line names live in the frontend's list (src/lib/taxLines.ts), the
    // same as for a category's tax line; nothing here second-guesses them.
    let n = conn
        .execute("UPDATE transactions SET tax_line = ?2 WHERE id = ?1", params![transaction_id, tax_line])
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("transaction {transaction_id} not found"));
    }
    Ok(())
}

pub fn set_transaction_goal(conn: &Conn, transaction_id: &str, goal_id: Option<&str>) -> Result<(), String> {
    let (account_id, transfer_id): (String, Option<String>) = conn
        .query_row(
            "SELECT account_id, transfer_id FROM transactions WHERE id = ?1",
            params![transaction_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| format!("transaction {transaction_id} not found: {e}"))?;
    let Some(goal_id) = goal_id.filter(|g| !g.is_empty()) else {
        conn.execute(
            "UPDATE transactions SET goal_id = NULL WHERE id = ?1 OR id = ?2",
            params![transaction_id, transfer_id],
        )
        .map_err(|e| e.to_string())?;
        return Ok(());
    };
    let goal = get_goal(conn, goal_id)?;
    let Some(goal_account) = goal.account_id.as_deref() else {
        return Err(format!("the goal \"{}\" is not linked to an account", goal.name));
    };
    let target_row = if account_id == goal_account {
        transaction_id.to_string()
    } else if let Some(other) = transfer_id.as_deref() {
        let other_account: String = conn
            .query_row("SELECT account_id FROM transactions WHERE id = ?1", params![other], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if other_account != goal_account {
            return Err(format!("neither half of this transfer is in {}", goal.account_name.unwrap_or_default()));
        }
        other.to_string()
    } else {
        return Err(format!(
            "this row is not in {} — a goal counts only what lands in its account",
            goal.account_name.unwrap_or_default()
        ));
    };
    conn.execute("UPDATE transactions SET goal_id = ?2 WHERE id = ?1", params![target_row, goal_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Money's "contribute to a goal": a transfer from `from_account_id` into
/// the goal's account, with the receiving half tagged for the goal.
pub fn contribute_to_goal(
    conn: &Conn,
    goal_id: &str,
    from_account_id: &str,
    date: &str,
    amount_cents: i64,
    notes: Option<&str>,
) -> Result<Goal, String> {
    let goal = get_goal(conn, goal_id)?;
    let Some(to) = goal.account_id.clone() else {
        return Err(format!("the goal \"{}\" is not linked to an account — edit it and pick one first", goal.name));
    };
    if amount_cents <= 0 {
        return Err("the contribution must be more than zero".to_string());
    }
    parse_date(date)?;
    // §181 — a contribution is a new transfer.
    refuse_new_link_to_closed(conn, &[from_account_id, to.as_str()])?;
    let note = notes.map(str::to_string).unwrap_or_else(|| format!("For {}", goal.name));
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let (_from_id, to_id) = insert_transfer_pair(&tx, from_account_id, &to, date, amount_cents, Some(&note))?;
    tx.execute("UPDATE transactions SET goal_id = ?2 WHERE id = ?1", params![to_id, goal_id])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    get_goal(conn, goal_id)
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

fn map_payment(row: &Row) -> rusqlite::Result<Payment> {
    Ok(Payment {
        id: row.get(0)?,
        payee: row.get(1)?,
        amount_cents: row.get(2)?,
        due_date: row.get(3)?,
        status: row.get(4)?,
        notes: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

pub fn list_payments(conn: &Conn) -> Result<Vec<Payment>, String> {
    let mut stmt = conn
        .prepare("SELECT id, payee, amount_cents, due_date, status, notes, updated_at
                  FROM payments ORDER BY due_date ASC, payee ASC")
        .map_err(|e| e.to_string())?;
    let out = stmt
        .query_map([], map_payment)
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(out)
}

pub fn create_payment(
    conn: &Conn,
    payee: &str,
    amount_cents: i64,
    due_date: &str,
    notes: Option<&str>,
) -> Result<Payment, String> {
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO payments (id, payee, amount_cents, due_date, status, notes)
         VALUES (?1, ?2, ?3, ?4, 'due', ?5)",
        params![id, payee, amount_cents, due_date, notes],
    )
    .map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT id, payee, amount_cents, due_date, status, notes, updated_at
         FROM payments WHERE id = ?1",
        params![id],
        map_payment,
    )
    .map_err(|e| e.to_string())
}

pub fn update_payment(
    conn: &Conn,
    id: &str,
    payee: &str,
    amount_cents: i64,
    due_date: &str,
    status: &str,
    notes: Option<&str>,
) -> Result<Payment, String> {
    conn.execute(
        "UPDATE payments SET payee = ?1, amount_cents = ?2, due_date = ?3, status = ?4,
         notes = ?5, updated_at = datetime('now') WHERE id = ?6",
        params![payee, amount_cents, due_date, status, notes, id],
    )
    .map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT id, payee, amount_cents, due_date, status, notes, updated_at
         FROM payments WHERE id = ?1",
        params![id],
        map_payment,
    )
    .map_err(|e| e.to_string())
}

pub fn delete_payment(conn: &Conn, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM payments WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::queries::test_support::*;

    // ── goals that watch an account (§46) ────────────────────────────────

    #[test]
    fn a_linked_goal_grows_with_tagged_rows_and_an_unlinked_one_does_not() {
        let db = TestDb::new("goal-link");
        let c = db.conn();
        let chk = account(&c, "Checking", 500_000);
        let sav = account(&c, "Savings", 100_000);
        let g = create_goal(&c, "Roof", 1_000_000, 50_000, None, None, Some(&sav)).unwrap();
        assert_eq!((g.saved_cents, g.starting_cents, g.linked_cents), (50_000, 50_000, 0));

        // Contribute: a transfer into savings, its receiving half tagged.
        let g = contribute_to_goal(&c, &g.id, &chk, "2026-03-01", 20_000, None).unwrap();
        assert_eq!((g.saved_cents, g.linked_cents, g.linked_count), (70_000, 20_000, 1));
        assert_eq!(get_account(&c, &chk).unwrap().balance_cents, 480_000);
        assert_eq!(get_account(&c, &sav).unwrap().balance_cents, 120_000);
        let reg = get_register(&c, &sav).unwrap();
        let tagged = reg.iter().find(|r| r.goal_id.is_some()).expect("a tagged row");
        assert_eq!(tagged.goal_name.as_deref(), Some("Roof"));
        assert_eq!(tagged.amount_cents, 20_000);

        // Tagging from the OTHER register lands on the savings half.
        let t = create_transfer(&c, &chk, &sav, "2026-04-01", 5_000, None).unwrap();
        set_transaction_goal(&c, &t.id, Some(&g.id)).unwrap();
        assert_eq!(get_goal(&c, &g.id).unwrap().saved_cents, 75_000);
        // A row in an unrelated account is refused.
        let stray = create_transaction(&c, &chk, "2026-04-02", "x", None, 1_000, None, None).unwrap();
        assert!(set_transaction_goal(&c, &stray.id, Some(&g.id)).is_err());
        // Untag.
        set_transaction_goal(&c, &t.id, None).unwrap();
        assert_eq!(get_goal(&c, &g.id).unwrap().saved_cents, 70_000);
        // Voided rows do not count.
        set_void(&c, &tagged.id, true).unwrap();
        assert_eq!(get_goal(&c, &g.id).unwrap().saved_cents, 50_000);
        set_void(&c, &tagged.id, false).unwrap();

        // Re-pointing the goal at another account drops the old tags.
        let g2 = update_goal(&c, &g.id, "Roof", 1_000_000, 50_000, None, None, Some(&chk)).unwrap();
        assert_eq!((g2.saved_cents, g2.linked_count), (50_000, 0));
        // Unlinked goal: just the typed number; contributing is refused.
        let plain = create_goal(&c, "Cruise", 100, 42, None, None, None).unwrap();
        assert_eq!(plain.saved_cents, 42);
        assert!(contribute_to_goal(&c, &plain.id, &chk, "2026-05-01", 100, None).is_err());
        // Deleting a goal leaves the rows, untagged.
        delete_goal(&c, &g.id).unwrap();
        assert!(get_register(&c, &sav).unwrap().iter().all(|r| r.goal_id.is_none()));
    }
}
