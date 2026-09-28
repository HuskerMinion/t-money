//! Common Transactions (migration 0018): saved templates for entering a
//! transaction.

use crate::models::{CommonTransaction, NewCommonTransaction, NewSplit};
use rusqlite::{params, OptionalExtension};
use uuid::Uuid;
use super::*;

// ---------------------------------------------------------------------------
// Common Transactions (migration 0018)
// ---------------------------------------------------------------------------

/// Templates, most-used first — the menu should lead with the ones that earn
/// their place — then alphabetically so the order is stable for the rest.
pub fn list_common_transactions(conn: &Conn) -> Result<Vec<CommonTransaction>, String> {
    let sql = r#"
        SELECT ct.id, ct.name, ct.payee, ct.category_id,
               CASE WHEN c.id IS NULL THEN NULL
                    WHEN c.parent_id IS NULL THEN c.name
                    ELSE pc.name || ' : ' || c.name END AS category_name,
               ct.amount_cents, ct.check_number, ct.notes, ct.usage_count, ct.updated_at
          FROM common_transactions ct
          LEFT JOIN categories c  ON c.id = ct.category_id
          LEFT JOIN categories pc ON pc.id = c.parent_id
         ORDER BY ct.usage_count DESC, ct.name COLLATE NOCASE
    "#;
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows: Vec<CommonTransaction> = stmt
        .query_map([], |r| {
            Ok(CommonTransaction {
                id: r.get(0)?,
                name: r.get(1)?,
                payee: r.get(2)?,
                category_id: r.get(3)?,
                category_name: r.get(4)?,
                amount_cents: r.get(5)?,
                check_number: r.get(6)?,
                notes: r.get(7)?,
                usage_count: r.get(8)?,
                updated_at: r.get(9)?,
                splits: Vec::new(),
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;

    // Fill the split lines. A template that lost its splits on the way to the
    // menu would silently enter as a single uncategorized amount.
    let mut out = Vec::with_capacity(rows.len());
    for mut t in rows {
        t.splits = common_splits(conn, &t.id)?;
        out.push(t);
    }
    Ok(out)
}

fn common_splits(conn: &Conn, id: &str) -> Result<Vec<NewSplit>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT category_id, description, amount_cents
               FROM common_transaction_splits
              WHERE common_transaction_id = ?1
              ORDER BY sort_order, rowid",
        )
        .map_err(|e| e.to_string())?;
    // Bound to a local rather than returned straight from the expression:
    // `stmt` is dropped at the end of the block, and a tail expression still
    // borrowing it outlives it (E0597).
    let rows: Vec<NewSplit> = stmt
        .query_map(params![id], |r| {
            Ok(NewSplit { classes: Vec::new(),
                category_id: r.get(0)?,
                description: r.get(1)?,
                amount_cents: r.get(2)?,
                // §31 templates hold categories only; a transfer line is not
                // something a template can carry yet.
                transfer_account_id: None,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Save a template. The name is the handle the user picks it by, so it is
/// required, trimmed, and unique — saving over an existing name REPLACES it,
/// which is what "save this one again" means and avoids a menu full of
/// "Rent", "Rent 2", "Rent 3".
pub fn create_common_transaction(
    conn: &Conn,
    t: &NewCommonTransaction,
) -> Result<CommonTransaction, String> {
    let name = t.name.trim();
    if name.is_empty() {
        return Err("give the common transaction a name".to_string());
    }

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    // Replace by name, preserving how often it has been used: re-saving a
    // template you use weekly should not send it to the bottom of the menu.
    let existing: Option<(String, i64)> = tx
        .query_row(
            "SELECT id, usage_count FROM common_transactions WHERE name = ?1 COLLATE NOCASE",
            params![name],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (id, usage) = match existing {
        Some((id, usage)) => {
            tx.execute("DELETE FROM common_transactions WHERE id = ?1", params![id])
                .map_err(|e| e.to_string())?;
            (Uuid::new_v4().to_string(), usage)
        }
        None => (Uuid::new_v4().to_string(), 0),
    };

    let check_number = t.check_number.as_deref().map(str::trim).filter(|s| !s.is_empty());
    tx.execute(
        "INSERT INTO common_transactions
             (id, name, payee, category_id, amount_cents, check_number, notes, usage_count)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            id,
            name,
            t.payee.trim(),
            t.category_id,
            t.amount_cents,
            check_number,
            t.notes,
            usage
        ],
    )
    .map_err(|e| e.to_string())?;

    for (i, line) in t.splits.iter().enumerate() {
        tx.execute(
            "INSERT INTO common_transaction_splits
                 (id, common_transaction_id, category_id, description, amount_cents, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                Uuid::new_v4().to_string(),
                id,
                line.category_id,
                line.description,
                line.amount_cents,
                i as i64
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;

    list_common_transactions(conn)?
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| "the common transaction vanished after saving".to_string())
}

/// Note that a template was used, so the menu can order by it.
pub fn touch_common_transaction(conn: &Conn, id: &str) -> Result<(), String> {
    let n = conn
        .execute(
            "UPDATE common_transactions
                SET usage_count = usage_count + 1, updated_at = datetime('now')
              WHERE id = ?1",
            params![id],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("common transaction {id} not found"));
    }
    Ok(())
}

pub fn delete_common_transaction(conn: &Conn, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM common_transactions WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::models::NewSplit;
    use super::*;
    use crate::db::queries::test_support::*;

    // ── Common Transactions (§31) ────────────────────────────────────────

    #[test]
    fn a_template_round_trips_with_its_category_name_resolved() {
        let db = TestDb::new("ct-roundtrip");
        let c = db.conn();
        let parent = create_category(&c, "Home", "expense", None, None).expect("parent");
        let rent = create_category(&c, "Rent", "expense", Some(&parent.id), None).expect("child");

        let mut t = template("Rent");
        t.category_id = Some(rent.id.clone());
        t.check_number = Some("1042".to_string());
        create_common_transaction(&c, &t).expect("create");

        let all = list_common_transactions(&c).expect("list");
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "Rent");
        assert_eq!(all[0].amount_cents, Some(-145_000));
        assert_eq!(all[0].check_number.as_deref(), Some("1042"));
        // The menu shows the full name, as every other picker does (§6.1e).
        assert_eq!(all[0].category_name.as_deref(), Some("Home : Rent"));
    }

    #[test]
    fn a_template_may_have_no_amount() {
        // "Kroger, Groceries, whatever it came to this week" is a real
        // template. Forcing a number would make the user clear one every time.
        let db = TestDb::new("ct-noamount");
        let c = db.conn();
        let mut t = template("Groceries run");
        t.amount_cents = None;
        create_common_transaction(&c, &t).expect("create");
        assert_eq!(list_common_transactions(&c).expect("list")[0].amount_cents, None);
    }

    #[test]
    fn a_template_carries_its_split_lines_in_order() {
        // The motivating example: a Walmart trip across three categories. A
        // template that lost its splits would enter as one uncategorized
        // amount, silently.
        let db = TestDb::new("ct-splits");
        let c = db.conn();
        let g = ensure_category(&c, "Groceries").expect("g");
        let h = ensure_category(&c, "Household").expect("h");
        let p = ensure_category(&c, "Pharmacy").expect("p");

        let mut t = template("Walmart trip");
        t.amount_cents = Some(-12_000);
        t.splits = vec![
            NewSplit { classes: Vec::new(), category_id: Some(g.clone()), description: Some("Food".into()), amount_cents: -7_000, transfer_account_id: None },
            NewSplit { classes: Vec::new(), category_id: Some(h.clone()), description: None, amount_cents: -3_000, transfer_account_id: None },
            NewSplit { classes: Vec::new(), category_id: Some(p.clone()), description: None, amount_cents: -2_000, transfer_account_id: None },
        ];
        create_common_transaction(&c, &t).expect("create");

        let got = list_common_transactions(&c).expect("list").remove(0);
        assert_eq!(got.splits.len(), 3);
        assert_eq!(got.splits[0].category_id.as_deref(), Some(g.as_str()));
        assert_eq!(got.splits[0].description.as_deref(), Some("Food"));
        assert_eq!(got.splits[0].amount_cents, -7_000);
        // Order is the order they were given, not whatever SQLite returns.
        assert_eq!(got.splits[2].amount_cents, -2_000);
    }

    #[test]
    fn saving_over_a_name_replaces_it_and_keeps_its_usage_count() {
        // "Save this one again" means replace, not add — otherwise the menu
        // fills with Rent, Rent 2, Rent 3. And a template you use weekly must
        // not fall to the bottom of the menu just because you corrected it.
        let db = TestDb::new("ct-replace");
        let c = db.conn();
        let first = create_common_transaction(&c, &template("Rent")).expect("first");
        touch_common_transaction(&c, &first.id).expect("use");
        touch_common_transaction(&c, &first.id).expect("use");

        let mut corrected = template("Rent");
        corrected.amount_cents = Some(-150_000);
        create_common_transaction(&c, &corrected).expect("second");

        let all = list_common_transactions(&c).expect("list");
        assert_eq!(all.len(), 1, "the name was duplicated");
        assert_eq!(all[0].amount_cents, Some(-150_000));
        assert_eq!(all[0].usage_count, 2, "usage was reset by a re-save");
    }

    #[test]
    fn replacing_a_template_does_not_leave_its_old_split_lines_behind() {
        let db = TestDb::new("ct-replace-splits");
        let c = db.conn();
        let g = ensure_category(&c, "Groceries").expect("g");
        let mut t = template("Walmart trip");
        t.splits = vec![
            NewSplit { classes: Vec::new(), category_id: Some(g.clone()), description: None, amount_cents: -5_000, transfer_account_id: None },
            NewSplit { classes: Vec::new(), category_id: Some(g.clone()), description: None, amount_cents: -5_000, transfer_account_id: None },
        ];
        create_common_transaction(&c, &t).expect("first");

        let mut simpler = template("Walmart trip");
        simpler.splits = vec![NewSplit { classes: Vec::new(),
            category_id: Some(g.clone()),
            description: None,
            amount_cents: -9_000,
            transfer_account_id: None,
        }];
        create_common_transaction(&c, &simpler).expect("second");

        let got = list_common_transactions(&c).expect("list").remove(0);
        assert_eq!(got.splits.len(), 1, "old split lines survived the replace");
        let orphans: i64 = c
            .query_row("SELECT count(*) FROM common_transaction_splits", [], |r| r.get(0))
            .expect("count");
        assert_eq!(orphans, 1, "orphan split rows left behind");
    }

    #[test]
    fn the_menu_leads_with_the_templates_that_earn_their_place() {
        let db = TestDb::new("ct-order");
        let c = db.conn();
        let rarely = create_common_transaction(&c, &template("Zebra")).expect("a");
        let often = create_common_transaction(&c, &template("Apple")).expect("b");
        for _ in 0..3 {
            touch_common_transaction(&c, &often.id).expect("use");
        }
        let all = list_common_transactions(&c).expect("list");
        assert_eq!(all[0].id, often.id, "most-used should lead");
        assert_eq!(all[1].id, rarely.id);
    }

    #[test]
    fn an_unnamed_template_is_refused() {
        let db = TestDb::new("ct-noname");
        let c = db.conn();
        let mut t = template("   ");
        t.name = "   ".to_string();
        assert!(create_common_transaction(&c, &t).is_err());
    }

    #[test]
    fn deleting_a_template_takes_its_splits_with_it() {
        let db = TestDb::new("ct-delete");
        let c = db.conn();
        let g = ensure_category(&c, "Groceries").expect("g");
        let mut t = template("Walmart trip");
        t.splits = vec![NewSplit { classes: Vec::new(), category_id: Some(g), description: None, amount_cents: -9_000, transfer_account_id: None }];
        let saved = create_common_transaction(&c, &t).expect("create");

        delete_common_transaction(&c, &saved.id).expect("delete");

        assert!(list_common_transactions(&c).expect("list").is_empty());
        let orphans: i64 = c
            .query_row("SELECT count(*) FROM common_transaction_splits", [], |r| r.get(0))
            .expect("count");
        assert_eq!(orphans, 0, "ON DELETE CASCADE did not fire");
    }

    #[test]
    fn a_template_is_not_a_transaction() {
        // It has no account, no date and no cleared state, and saving one must
        // never touch the register or a balance.
        let db = TestDb::new("ct-inert");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        create_common_transaction(&c, &template("Rent")).expect("create");

        assert_eq!(balance(&c, &acct), 100_000);
        assert!(entered(&c, &acct).is_empty());
    }
}
