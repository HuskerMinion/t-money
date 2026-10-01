//! Payees (migration 0011) and payee rules.

use crate::models::{Payee, PayeeRule, PayeeRuleChange, RuleConditions, UsedText};
use rusqlite::{params, Connection, OptionalExtension, Row};
use uuid::Uuid;
use crate::db::undo;
use super::*;

// ---------------------------------------------------------------------------
// Payees (migration 0011)
// ---------------------------------------------------------------------------

/// Resolve a payee name to its id, creating the payee when it is new.
///
/// EVERY path that writes `transactions.payee` must also go through this, or
/// `payee_id` stays NULL and the payee never enters the `payees` table — which
/// is precisely a bug this app once had. An empty name yields `None`.
pub(super) fn payee_id_for(
    conn: &Connection,
    name: &str,
    category_id: Option<&str>,
) -> Result<Option<String>, String> {
    if name.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(upsert_payee(conn, name, category_id)?))
}

fn map_payee(row: &Row) -> rusqlite::Result<Payee> {
    Ok(Payee {
        id: row.get(0)?,
        name: row.get(1)?,
        last_category_id: row.get(2)?,
        last_category_name: row.get(3)?,
        usage_count: row.get(4)?,
        updated_at: row.get(5)?,
        last_amount_cents: row.get(6)?,
    })
}

/// Payees with their default category resolved and their transaction count.
/// The count is what makes "merge" and "delete" safe to offer in the UI.
const PAYEE_SELECT: &str = r#"
    SELECT pe.id,
           pe.name,
           pe.last_category_id,
           CASE WHEN c.id IS NULL THEN NULL
                WHEN c.parent_id IS NULL THEN c.name
                ELSE pc.name || ' : ' || c.name END AS last_category_name,
           (SELECT COUNT(*) FROM transactions t WHERE t.payee_id = pe.id) AS usage_count,
           pe.updated_at,
           -- The amount of this payee's most recent transaction. Money offers
           -- it alongside the category when you re-enter a known payee.
           --
           -- Derived rather than stored: a `payees.last_amount_cents` column
           -- would have to be maintained by all five write paths and by
           -- delete, void and merge, and would go stale the first time one of
           -- them was missed. This cannot.
           --
           -- Voided rows are excluded — a void means "this did not happen", so
           -- offering its amount would be offering a number the user reversed.
           -- Ties on date fall back to rowid, so the newest entry wins.
           (SELECT t.amount_cents FROM transactions t
             WHERE t.payee_id = pe.id AND t.is_void = 0
             ORDER BY t.date DESC, t.rowid DESC LIMIT 1) AS last_amount_cents
      FROM payees pe
      LEFT JOIN categories c  ON c.id = pe.last_category_id
      LEFT JOIN categories pc ON pc.id = c.parent_id
"#;

pub fn list_payees(conn: &Conn) -> Result<Vec<Payee>, String> {
    let sql = format!("{PAYEE_SELECT} ORDER BY pe.name COLLATE NOCASE");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let out = stmt
        .query_map([], map_payee)
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(out)
}

/// Every description a split line has carried, most-used first, so
/// the split dialog can complete one as it is typed the way the Payee field
/// completes a payee. Case folds: "milk" and "Milk" are one entry.
pub fn list_split_descriptions(conn: &Conn) -> Result<Vec<UsedText>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT MIN(description) AS name, COUNT(*) AS n
               FROM splits
              WHERE description IS NOT NULL AND TRIM(description) <> ''
              GROUP BY LOWER(TRIM(description))
              ORDER BY n DESC, name COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    let out = stmt
        .query_map([], |r| Ok(UsedText { name: r.get(0)?, usage_count: r.get(1)? }))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(out)
}

fn get_payee(conn: &Conn, id: &str) -> Result<Payee, String> {
    let sql = format!("{PAYEE_SELECT} WHERE pe.id = ?1");
    conn.query_row(&sql, params![id], map_payee)
        .map_err(|e| e.to_string())
}

/// Rename a payee and/or set its default category.
///
/// `transactions.payee` is a denormalized copy of the name (the register reads
/// it directly), so a rename has to update both or the register keeps showing
/// the old text. Renaming onto an existing payee is refused — that is a merge,
/// and merging silently would be a surprising way to lose a payee.
///
/// The copies of the name in scheduled bills, common transactions and
/// rename rules are rewritten too (`PAYEE_REFS`). They were left saying the
/// old name, and each of them turns a name back into a payee when used, so
/// the next bill entered from a schedule quietly recreated the payee just
/// renamed away. And the rename is recorded for undo — it was not, and did
/// not empty the stack either, so Ctrl+Z reached past it.
pub fn update_payee(
    conn: &Conn,
    id: &str,
    name: &str,
    last_category_id: Option<&str>,
) -> Result<(Payee, undo::Step), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("payee name must not be empty".into());
    }
    let clash: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM payees WHERE name = ?1 AND id <> ?2)",
            params![name, id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if clash {
        return Err(format!(
            "a payee named '{name}' already exists — merge them instead"
        ));
    }
    let old_name: String = conn
        .query_row("SELECT name FROM payees WHERE id = ?1", params![id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "that payee no longer exists".to_string())?;

    // ── Photograph ────────────────────────────────────────────────────────
    // The payee row's own columns as cells, not as a row to drop and put
    // back: transactions point at it, and deleting it to undo a rename would
    // trip their foreign key. A category-only save leaves the name copies
    // alone rather than rewriting them to what they already say.
    let mut cells_before: Vec<undo::Cells> = Vec::new();
    let mut cells_after: Vec<undo::Cells> = Vec::new();
    let payee_cell = |column: &'static str| -> Result<undo::Cells, String> {
        use rusqlite::types::Value;
        let v: Value = conn
            .query_row(&format!("SELECT {column} FROM payees WHERE id = ?1"), params![id], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        Ok(undo::Cells { table: "payees", key: "id", column, rows: vec![(Value::Text(id.to_string()), v)] })
    };
    for column in ["name", "last_category_id", "updated_at"] {
        cells_before.push(payee_cell(column)?);
    }
    if old_name != name {
        let (b, a) = payee_ref_cells(conn, id, &old_name, id, &name)?;
        cells_before.extend(b);
        cells_after.extend(a);
    }

    // ── Write ─────────────────────────────────────────────────────────────
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE payees SET name = ?2, last_category_id = ?3, updated_at = datetime('now')
         WHERE id = ?1",
        params![id, name, last_category_id],
    )
    .map_err(|e| e.to_string())?;
    write_cells(&tx, &cells_after)?;
    tx.commit().map_err(|e| e.to_string())?;

    // The payee row as the write left it — `updated_at` came from SQLite's
    // clock, so it is read back rather than guessed.
    let mut row_after = ["name", "last_category_id", "updated_at"]
        .into_iter()
        .map(payee_cell)
        .collect::<Result<Vec<_>, _>>()?;
    row_after.extend(cells_after);
    let cells_after = row_after;
    let step = undo::Step {
        label: "rename a payee".to_string(),
        before: undo::Snapshot { cells: cells_before, ..Default::default() },
        after: undo::Snapshot { cells: cells_after, ..Default::default() },
    };
    Ok((get_payee(conn, id)?, step))
}

/// How a column names a payee: by `payees.id`, or by the payee's
/// name, which is how a template, a schedule and a rename rule store one.
#[derive(Clone, Copy, PartialEq)]
enum NamedBy {
    Id,
    Name,
}

/// Every place in the schema that names a payee, as `(table, key
/// column, column to rewrite, column that picks the rows, how it names
/// one)`.
///
/// Only `transactions.payee_id` is a foreign key — the one `REFERENCES
/// payees(id)` in `migrations.rs`, which a test below holds this list to.
/// The other three store the payee's NAME, and each of them turns back into
/// a payee through `upsert_payee`, which matches on the name: entering a
/// scheduled bill, using a common transaction, applying a rename rule. Before
/// this fix, the merge rewrote `transactions` alone, so merging Best Buy into
/// Chewy left every schedule, template and rule still saying "Best Buy" —
/// and the next time one of them wrote a transaction, `upsert_payee` quietly
/// brought back the payee the merge had just retired.
///
/// `transactions.payee` is picked by `payee_id`, not by its text: it is the
/// denormalized copy of the name of whatever payee the row points at.
const PAYEE_REFS: &[(&str, &str, &str, &str, NamedBy)] = &[
    ("transactions", "id", "payee_id", "payee_id", NamedBy::Id),
    ("transactions", "id", "payee", "payee_id", NamedBy::Id),
    ("common_transactions", "id", "payee", "payee", NamedBy::Name),
    ("recurrences", "id", "payee", "payee", NamedBy::Name),
    ("payee_rules", "id", "payee_name", "payee_name", NamedBy::Name),
];

/// Every `PAYEE_REFS` cell that names payee `id` (called `name`), as
/// it is now and as it will be once it names `becomes_id` / `becomes_name`
/// instead. The first is the undo, the second the write and the redo.
///
/// What each cell held is kept row by row, so undo writes exactly those
/// values back — a template whose payee text carried a stray space gets its
/// space back too. A column that would not change (`payee_id` in a rename)
/// is left out.
fn payee_ref_cells(
    conn: &Conn,
    id: &str,
    name: &str,
    becomes_id: &str,
    becomes_name: &str,
) -> Result<(Vec<undo::Cells>, Vec<undo::Cells>), String> {
    use rusqlite::types::Value;
    let mut before: Vec<undo::Cells> = Vec::new();
    let mut after: Vec<undo::Cells> = Vec::new();
    for &(table, key, column, pick, by) in PAYEE_REFS {
        let names_the_id = by == NamedBy::Id && column == "payee_id";
        if names_the_id && becomes_id == id {
            continue;
        }
        // `trim`, because `upsert_payee` trims before it looks a name up:
        // " Best Buy" on a schedule becomes the Best Buy payee when entered.
        let (matches, value) = match by {
            NamedBy::Id => (format!("{pick} = ?1"), id),
            NamedBy::Name => (format!("trim({pick}) = ?1"), name),
        };
        let mut st = conn
            .prepare(&format!("SELECT {key}, {column} FROM {table} WHERE {matches} ORDER BY {key}"))
            .map_err(|e| e.to_string())?;
        let rows: Vec<(Value, Value)> = st
            .query_map(params![value], |r| Ok((r.get::<_, Value>(0)?, r.get::<_, Value>(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        if rows.is_empty() {
            continue;
        }
        let becomes = Value::Text(if names_the_id { becomes_id } else { becomes_name }.to_string());
        after.push(undo::Cells {
            table,
            key,
            column,
            rows: rows.iter().map(|(k, _)| (k.clone(), becomes.clone())).collect(),
        });
        before.push(undo::Cells { table, key, column, rows });
    }
    Ok((before, after))
}

/// Write photographed cells, row by row by key.
///
/// By key rather than `WHERE payee_id = ?1`: both `transactions` entries in
/// `PAYEE_REFS` pick their rows by that column, and the first UPDATE would
/// move the rows out from under the second.
fn write_cells(tx: &Connection, cells: &[undo::Cells]) -> Result<(), String> {
    for c in cells {
        let mut st = tx
            .prepare(&format!("UPDATE {} SET {} = ?2 WHERE {} = ?1", c.table, c.column, c.key))
            .map_err(|e| e.to_string())?;
        for (k, v) in &c.rows {
            st.execute(params![k, v]).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Fold `from_id` into `into_id` — every transaction moves across (both the
/// FK and the denormalized name), and so does every scheduled bill, common
/// transaction and rename rule that names it — then delete the source payee.
/// Returns the surviving payee and the step that puts it all back.
///
/// Undoable, the way a category merge is: *"I merged Best Buy
/// into Chewy … CTRL+Z did not undo it."* Nothing was recorded and nothing
/// was invalidated, so Ctrl+Z either did nothing or reached past the merge
/// and took back whatever came before it. Built from `undo::Cells`
/// for the same reason as `fold_category`: a merge changes one column on
/// each row it touches and deletes nothing but the payee itself.
///
/// It also ran its UPDATE and DELETE as two separate writes, so a failure
/// between them left the transactions moved and the source still listed.
/// One SQL transaction now.
pub fn merge_payees(conn: &Conn, from_id: &str, into_id: &str) -> Result<(Payee, undo::Step), String> {
    use rusqlite::types::Value;
    if from_id == into_id {
        return Err("cannot merge a payee into itself".into());
    }
    let name_of = |id: &str| -> Result<Option<String>, String> {
        conn.query_row("SELECT name FROM payees WHERE id = ?1", params![id], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())
    };
    let target_name = name_of(into_id)?.ok_or_else(|| "the payee to merge into does not exist".to_string())?;
    let source_name = name_of(from_id)?.ok_or_else(|| "the payee to merge does not exist".to_string())?;

    // ── Photograph, before a single write ─────────────────────────────────
    let (cells_before, cells_after) = payee_ref_cells(conn, from_id, &source_name, into_id, &target_name)?;
    let payee_row = undo::photograph(conn, "payees", "id", &[from_id.to_string()])?;

    // ── Write ─────────────────────────────────────────────────────────────
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    write_cells(&tx, &cells_after)?;
    tx.execute("DELETE FROM payees WHERE id = ?1", params![from_id])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    let step = undo::Step {
        label: "merge payees".to_string(),
        // Undo: the payee goes back in first, because the cells are about to
        // point transactions at it again.
        before: undo::Snapshot { inserts: vec![payee_row], cells: cells_before, ..Default::default() },
        // Redo: point everything at the survivor, and only then delete the
        // source — until the cells have run, its transactions still name it.
        after: undo::Snapshot {
            cells: cells_after,
            late_drops: vec![undo::Removal {
                table: "payees",
                key: "id",
                values: vec![Value::Text(from_id.to_string())],
            }],
            ..Default::default()
        },
    };
    Ok((get_payee(conn, into_id)?, step))
}

/// Delete a payee that nothing uses. A payee still on transactions must be
/// merged, not deleted — deleting would leave the register showing a name with
/// no payee behind it.
///
/// Recorded for undo rather than emptying the stack. The undo rules
/// allow either; this is one row that nothing points at, so the step is that row
/// and nothing else, and throwing away every earlier step on the stack to
/// delete a typo would cost the user far more than recording it does.
pub fn delete_payee(conn: &Conn, id: &str) -> Result<undo::Step, String> {
    use rusqlite::types::Value;
    let used: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM transactions WHERE payee_id = ?1",
            params![id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if used > 0 {
        return Err(format!(
            "this payee is used by {used} transaction(s) — merge it into another payee instead"
        ));
    }
    let row = undo::photograph(conn, "payees", "id", &[id.to_string()])?;
    if row.rows.is_empty() {
        return Err("that payee no longer exists".into());
    }
    conn.execute("DELETE FROM payees WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    let this_payee = || undo::Removal { table: "payees", key: "id", values: vec![Value::Text(id.to_string())] };
    Ok(undo::Step {
        label: "delete a payee".to_string(),
        before: undo::Snapshot { drops: vec![this_payee()], inserts: vec![row], ..Default::default() },
        after: undo::Snapshot { drops: vec![this_payee()], ..Default::default() },
    })
}

/// Ensure a payee row exists for `name` and remember the category it was filed
/// under, so the next entry can autofill it.
///
/// Takes `&Connection`, not `&Conn`: the transfer, reconcile and import paths
/// all hold a `rusqlite::Transaction`, and a payee written outside their
/// transaction would survive a rollback. Same reason `ensure_category` does.
pub fn upsert_payee(
    conn: &Connection,
    name: &str,
    category_id: Option<&str>,
) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("payee name must not be empty".to_string());
    }
    let existing: Option<String> = conn
        .query_row("SELECT id FROM payees WHERE name = ?1", params![trimmed], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;

    let id = match existing {
        Some(id) => {
            if category_id.is_some() {
                conn.execute(
                    "UPDATE payees SET last_category_id = ?2, updated_at = datetime('now')
                     WHERE id = ?1",
                    params![id, category_id],
                )
                .map_err(|e| e.to_string())?;
            }
            id
        }
        None => {
            let id = Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO payees (id, name, last_category_id) VALUES (?1, ?2, ?3)",
                params![id, trimmed, category_id],
            )
            .map_err(|e| e.to_string())?;
            id
        }
    };
    Ok(id)
}

/// Create a payee the user typed on the Payees screen.
///
/// Every payee until now arrived as a side effect of entering a transaction
/// (`upsert_payee`), so the Payees screen could rename, merge and delete rows
/// it had no way to create — you could not set up a payee and its category
/// before the first transaction, which is exactly when you would want to.
///
/// Unlike `upsert_payee` this REFUSES a name that already exists, case
/// insensitively. Quietly returning the existing row would look like success
/// and leave the user's typed category silently unapplied.
pub fn create_payee(
    conn: &Conn,
    name: &str,
    category_id: Option<&str>,
) -> Result<Payee, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("payee name must not be empty".to_string());
    }
    let existing: Option<String> = conn
        .query_row(
            "SELECT name FROM payees WHERE name = ?1 COLLATE NOCASE",
            params![trimmed],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(found) = existing {
        return Err(format!("there is already a payee called \"{found}\""));
    }

    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO payees (id, name, last_category_id) VALUES (?1, ?2, ?3)",
        params![id, trimmed, category_id],
    )
    .map_err(|e| e.to_string())?;
    get_payee(conn, &id)
}

// ---------------------------------------------------------------------------
// Payee rules
// ---------------------------------------------------------------------------

const PAYEE_RULE_SELECT: &str = "SELECT r.id, r.match_text, r.payee_name, r.category_id, c.name, r.created_at,
                                          r.min_cents, r.max_cents, r.memo_contains, r.account_id, a.name
                                   FROM payee_rules r LEFT JOIN categories c ON c.id = r.category_id
                                   LEFT JOIN accounts a ON a.id = r.account_id";

fn map_rule(r: &Row) -> rusqlite::Result<PayeeRule> {
    Ok(PayeeRule {
        id: r.get(0)?,
        match_text: r.get(1)?,
        payee_name: r.get(2)?,
        category_id: r.get(3)?,
        category_name: r.get(4)?,
        created_at: r.get(5)?,
        min_cents: r.get(6)?,
        max_cents: r.get(7)?,
        memo_contains: r.get(8)?,
        account_id: r.get(9)?,
        account_name: r.get(10)?,
    })
}

/// Most specific first: a rule's conditions count over the text's length, so
/// "AMAZON under $20" outranks "AMAZON", and "AMAZON PRIME" outranks
/// "AMAZON" on a row that contains both. Ties by name.
pub fn list_payee_rules(conn: &Connection) -> Result<Vec<PayeeRule>, String> {
    let mut st = conn
        .prepare(&format!(
            "{PAYEE_RULE_SELECT} ORDER BY (r.min_cents IS NOT NULL) + (r.max_cents IS NOT NULL) + (COALESCE(TRIM(r.memo_contains), '') <> '') + (r.account_id IS NOT NULL) DESC,
                                          length(r.match_text) DESC, lower(r.match_text)"
        ))
        .map_err(|e| e.to_string())?;
    let out = st.query_map([], map_rule).map_err(|e| e.to_string())?.collect::<Result<_, _>>().map_err(|e| e.to_string())?;
    Ok(out)
}

/// A rule: when a downloaded payee contains `match_text` — and
/// meets `when` — call it `payee_name` and file it under `category_id` if
/// the file gave none. Two rules on one text are allowed when their
/// conditions differ; the same text with the same conditions is refused.
pub fn create_payee_rule(
    conn: &Conn,
    match_text: &str,
    payee_name: &str,
    category_id: Option<&str>,
    when: &RuleConditions,
) -> Result<PayeeRule, String> {
    let m = match_text.trim();
    let p = payee_name.trim();
    if m.is_empty() {
        return Err("say what to look for in the downloaded payee".to_string());
    }
    if p.is_empty() {
        return Err("say what to call it".to_string());
    }
    let cat = category_id.map(str::trim).filter(|c| !c.is_empty());
    if let Some(c) = cat {
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM categories WHERE id = ?1", params![c], |r| r.get(0)).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("that category does not exist".to_string());
        }
    }
    let min = when.min_cents.map(|v| v.abs());
    let max = when.max_cents.map(|v| v.abs());
    if let (Some(lo), Some(hi)) = (min, max) {
        if lo > hi {
            return Err("the smallest amount is larger than the largest".to_string());
        }
    }
    let memo = when.memo_contains.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let account = when.account_id.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if let Some(a) = account {
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM accounts WHERE id = ?1", params![a], |r| r.get(0)).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("that account does not exist".to_string());
        }
    }
    let dup: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM payee_rules
              WHERE lower(match_text) = lower(?1)
                AND min_cents IS ?2 AND max_cents IS ?3
                AND lower(COALESCE(memo_contains, '')) = lower(COALESCE(?4, ''))
                AND account_id IS ?5",
            params![m, min, max, memo, account],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if dup > 0 {
        return Err(if when.count() == 0 {
            format!("there is already a rule for \"{m}\"")
        } else {
            format!("there is already a rule for \"{m}\" with those conditions")
        });
    }
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO payee_rules (id, match_text, payee_name, category_id, min_cents, max_cents, memo_contains, account_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![id, m, p, cat, min, max, memo, account],
    )
    .map_err(|e| e.to_string())?;
    conn.query_row(&format!("{PAYEE_RULE_SELECT} WHERE r.id = ?1"), params![id], map_rule).map_err(|e| e.to_string())
}

pub fn delete_payee_rule(conn: &Conn, id: &str) -> Result<(), String> {
    let n = conn.execute("DELETE FROM payee_rules WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("rule not found".to_string());
    }
    Ok(())
}

/// The rule for a downloaded row, if any: the first in `list_payee_rules`'
/// order (most specific first) whose `match_text` the payee contains,
/// case-insensitively, and whose conditions the row meets — the
/// amount's size within the rule's range, the memo containing its text,
/// the account being its account. A condition a rule does not set is met.
pub fn rule_for<'a>(rules: &'a [PayeeRule], payee: &str, amount_cents: i64, memo: &str, account_id: &str) -> Option<&'a PayeeRule> {
    let hay = payee.to_lowercase();
    let memo = memo.to_lowercase();
    let size = amount_cents.abs();
    rules.iter().find(|r| {
        !r.match_text.is_empty()
            && hay.contains(&r.match_text.to_lowercase())
            && r.min_cents.map_or(true, |lo| size >= lo.abs())
            && r.max_cents.map_or(true, |hi| size <= hi.abs())
            && r.memo_contains.as_deref().map(str::trim).filter(|m| !m.is_empty()).map_or(true, |m| memo.contains(&m.to_lowercase()))
            && r.account_id.as_deref().map_or(true, |a| a == account_id)
    })
}

/// What applying the rules WOULD do, row by row.
///
/// The apply below used to be the only way to find out: you pressed a button
/// and were told a number afterwards. On a file with ten years in it, "412
/// rows changed" is not information, it is a thing that has happened to you.
/// So the matching moved here, and the apply consumes the same list — a
/// preview that is computed differently from the change it previews is worse
/// than none, because it is believable.
fn payee_rule_changes(conn: &Conn) -> Result<Vec<PayeeRuleChange>, String> {
    let rules = list_payee_rules(conn)?;
    if rules.is_empty() {
        return Ok(Vec::new());
    }
    // Ordinary cash rows only: not a transfer half, not investment activity,
    // not a revaluation, not the far side of a split. None of those have a
    // payee a rule has any business rewriting.
    let mut st = conn
        .prepare(
            // The full name — "Auto : Fuel" — is composed here as it is
            // everywhere else; a bare child name appearing twice under
            // different parents is unreadable in a list of changes.
            "SELECT t.id, t.date, t.payee, t.amount_cents, t.category_id,
                    CASE WHEN c.id IS NULL THEN NULL
                         WHEN c.parent_id IS NULL THEN c.name
                         ELSE p.name || ' : ' || c.name END,
                    a.name, COALESCE(t.notes, ''), t.account_id,
                    EXISTS (SELECT 1 FROM splits s WHERE s.transaction_id = t.id),
                    a.currency
               FROM transactions t
               LEFT JOIN categories c ON c.id = t.category_id
               LEFT JOIN categories p ON p.id = c.parent_id
               JOIN accounts a ON a.id = t.account_id
              WHERE t.activity IS NULL AND t.transfer_id IS NULL AND t.is_void = 0
                AND t.is_revaluation = 0 AND t.is_split_transfer = 0
              ORDER BY t.date DESC, t.rowid DESC",
        )
        .map_err(|e| e.to_string())?;
    type Row = (String, String, String, i64, Option<String>, Option<String>, String, String, String, bool, String);
    let rows: Vec<Row> = st
        .query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?, r.get(10)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for (id, date, payee, amount_cents, category_id, category_name, account_name, notes, account_id, split, currency) in rows {
        let Some(rule) = rule_for(&rules, &payee, amount_cents, &notes, &account_id) else { continue };
        let rename = payee != rule.payee_name;
        // A category is only FILLED IN, never overwritten: a rule is a guess
        // about a name, and one that re-files something you categorized by
        // hand would be a rule you could not trust to run.
        //
        // A split row's empty category is not a gap to fill — its lines
        // carry the categories (`set_splits` clears the row's own). Filing
        // one wrote a category onto the mortgage payment that no line had.
        // It is still renamed; the name is the row's.
        let file = category_id.is_none() && rule.category_id.is_some() && !split;
        if !rename && !file {
            continue;
        }
        let new_category_name = if file {
            rule.category_name.clone()
        } else {
            category_name.clone()
        };
        out.push(PayeeRuleChange {
            transaction_id: id,
            account_name,
            currency,
            date,
            amount_cents,
            payee,
            new_payee: rule.payee_name.clone(),
            category_name,
            new_category_name,
            new_category_id: if file { rule.category_id.clone() } else { None },
            rule_id: rule.id.clone(),
            match_text: rule.match_text.clone(),
        });
    }
    Ok(out)
}

/// The preview, for the dialog.
pub fn preview_payee_rules(conn: &Conn) -> Result<Vec<PayeeRuleChange>, String> {
    payee_rule_changes(conn)
}

/// Apply the rules to the rows already in the file.
///
/// `only` limits it to the transaction ids the user left ticked in the
/// preview; `None` means all of them, which is what the old button did.
/// Returns the ids actually changed, so the caller can put them on the undo
/// stack — this is one bulk edit and it has to come back as one step.
///
/// The payee ROW created by a rename is left behind by an undo. That is
/// deliberate and harmless: an unused payee in the list costs nothing, where
/// deleting one on undo could take a payee that something else has since
/// started using.
pub fn apply_payee_rules_to(conn: &Conn, only: Option<&[String]>) -> Result<Vec<String>, String> {
    let changes = payee_rule_changes(conn)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut changed = Vec::new();
    for c in changes {
        if let Some(ids) = only {
            if !ids.iter().any(|i| i == &c.transaction_id) {
                continue;
            }
        }
        let cat = c.new_category_id.clone();
        let cat_for_row = match &cat {
            Some(id) => Some(id.clone()),
            // Not filing it: leave whatever the row already had.
            None => conn
                .query_row(
                    "SELECT category_id FROM transactions WHERE id = ?1",
                    params![c.transaction_id],
                    |r| r.get::<_, Option<String>>(0),
                )
                .map_err(|e| e.to_string())?,
        };
        let payee_id = upsert_payee(&tx, &c.new_payee, cat_for_row.as_deref()).map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE transactions SET payee = ?2, payee_id = ?3, category_id = ?4 WHERE id = ?1",
            params![c.transaction_id, c.new_payee, payee_id, cat_for_row],
        )
        .map_err(|e| e.to_string())?;
        changed.push(c.transaction_id);
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(changed)
}

/// The old signature, kept because an older button and its tests use it.
pub fn apply_payee_rules(conn: &Conn) -> Result<u32, String> {
    Ok(apply_payee_rules_to(conn, None)?.len() as u32)
}

#[cfg(test)]
mod tests {
    use crate::models::{NewCommonTransaction, NewSplit, Payee, RuleConditions};
    use super::*;
    use crate::db::queries::test_support::*;

    // ── payees ───────────────────────────────────────────────────────────

    #[test]
    fn renaming_a_payee_rewrites_every_transaction_that_uses_it() {
        let db = TestDb::new("payee-rename");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        create_transaction(&c, &acct, "2026-08-01", "KROGER #442", None, -4_250, None, None)
            .expect("a");
        create_transaction(&c, &acct, "2026-08-02", "KROGER #442", None, -1_100, None, None)
            .expect("b");

        let payee = list_payees(&c).expect("payees").remove(0);
        update_payee(&c, &payee.id, "Kroger", None).expect("rename");

        // The register reads the denormalized `transactions.payee`, so a
        // rename that only touched the payees row would leave stale text.
        let rows = entered(&c, &acct);
        assert!(rows.iter().all(|r| r.payee == "Kroger"), "{:?}", rows.iter().map(|r| &r.payee).collect::<Vec<_>>());
    }

    #[test]
    fn merging_payees_repoints_transactions_and_removes_the_duplicate() {
        let db = TestDb::new("payee-merge");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        create_transaction(&c, &acct, "2026-08-01", "Kroger", None, -4_250, None, None).expect("a");
        create_transaction(&c, &acct, "2026-08-02", "KROGER #442", None, -1_100, None, None)
            .expect("b");

        let payees = list_payees(&c).expect("payees");
        let dupe = payees.iter().find(|p| p.name == "KROGER #442").expect("dupe");
        let keep = payees.iter().find(|p| p.name == "Kroger").expect("keep");

        merge_payees(&c, &dupe.id, &keep.id).expect("merge");

        let after = list_payees(&c).expect("payees");
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].name, "Kroger");
        assert_eq!(after[0].usage_count, 2);
        assert!(entered(&c, &acct)
            .iter()
            .all(|r| r.payee == "Kroger"));
    }

    /// *"I merged Best Buy into Chewy … CTRL+Z did not undo it."*
    /// Undo brings back the payee and every reference to it, including the
    /// three that store its name rather than its id; redo lands where the
    /// merge did.
    #[test]
    fn undoing_a_payee_merge_puts_the_payee_and_every_reference_back_and_redo_merges_again() {
        let db = TestDb::new("payee-merge-undo");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        let cat = create_category(&c, "Electronics", "expense", None, None).expect("cat");
        let tv = create_transaction(&c, &acct, "2026-08-01", "Best Buy", Some(cat.id.as_str()), -49_900, None, None)
            .expect("tv");
        let cable = create_transaction(&c, &acct, "2026-08-03", "Best Buy", None, -1_999, None, None).expect("cable");
        let food = create_transaction(&c, &acct, "2026-08-02", "Chewy", None, -6_400, None, None).expect("food");
        let rec = create_recurrence(&c, &bill(&acct, "Best Buy", -2_500, "2026-09-01")).expect("schedule");
        let common = create_common_transaction(
            &c,
            &NewCommonTransaction { payee: "Best Buy".to_string(), ..template("Warranty") },
        )
        .expect("template");
        let rule = create_payee_rule(&c, "BESTBUY", "Best Buy", None, &RuleConditions::default()).expect("rule");

        let payees = list_payees(&c).expect("payees");
        let from = payees.iter().find(|p| p.name == "Best Buy").expect("Best Buy").clone();
        let into = payees.iter().find(|p| p.name == "Chewy").expect("Chewy").clone();

        let txn_payee = |id: &str| -> (Option<String>, String) {
            c.query_row("SELECT payee_id, payee FROM transactions WHERE id = ?1", params![id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .expect("txn row")
        };
        let text = |sql: &str, id: &str| -> String { c.query_row(sql, params![id], |r| r.get(0)).expect(sql) };
        let rec_payee = || text("SELECT payee FROM recurrences WHERE id = ?1", &rec.id);
        let common_payee = || text("SELECT payee FROM common_transactions WHERE id = ?1", &common.id);
        let rule_payee = || text("SELECT payee_name FROM payee_rules WHERE id = ?1", &rule.id);

        let merged = |why: &str| {
            assert!(!list_payees(&c).unwrap().iter().any(|p| p.id == from.id), "{why}: Best Buy is still listed");
            for t in [&tv.id, &cable.id, &food.id] {
                assert_eq!(txn_payee(t), (Some(into.id.clone()), "Chewy".to_string()), "{why}");
            }
            assert_eq!(rec_payee(), "Chewy", "{why}: the scheduled bill still says Best Buy");
            assert_eq!(common_payee(), "Chewy", "{why}: the common transaction still says Best Buy");
            assert_eq!(rule_payee(), "Chewy", "{why}: the rename rule still files to Best Buy");
            assert_eq!(list_payees(&c).unwrap().iter().find(|p| p.id == into.id).unwrap().usage_count, 3, "{why}");
        };

        let (survivor, step) = merge_payees(&c, &from.id, &into.id).expect("merge");
        assert_eq!(step.label, "merge payees");
        assert_eq!(survivor.id, into.id);
        merged("merge");

        crate::db::undo::restore(&c, &step.before, &[]).expect("undo");
        let back = list_payees(&c).unwrap().into_iter().find(|p| p.id == from.id).expect("Best Buy did not come back");
        assert_eq!(back.name, "Best Buy");
        assert_eq!(back.last_category_id.as_deref(), Some(cat.id.as_str()), "its default category was lost");
        assert_eq!(back.usage_count, 2);
        for t in [&tv.id, &cable.id] {
            assert_eq!(txn_payee(t), (Some(from.id.clone()), "Best Buy".to_string()), "a transaction stayed merged");
        }
        assert_eq!(txn_payee(&food.id), (Some(into.id.clone()), "Chewy".to_string()), "undo moved Chewy's own row");
        assert_eq!(rec_payee(), "Best Buy");
        assert_eq!(common_payee(), "Best Buy");
        assert_eq!(rule_payee(), "Best Buy");

        crate::db::undo::restore(&c, &step.after, &[]).expect("redo");
        merged("redo");
    }

    /// A rename reaches the schedule, the common transaction and the
    /// rename rule as well as the register, so none of them brings the old
    /// payee back when used; and undo and redo cover every one of them.
    #[test]
    fn renaming_a_payee_rewrites_every_copy_of_its_name_and_undo_and_redo_cover_them() {
        let db = TestDb::new("payee-rename-undo");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        let cat = create_category(&c, "Electronics", "expense", None, None).expect("cat");
        let tv = create_transaction(&c, &acct, "2026-08-01", "Best Buy", None, -49_900, None, None).expect("tv");
        let food = create_transaction(&c, &acct, "2026-08-02", "Chewy", None, -6_400, None, None).expect("food");
        let rec = create_recurrence(&c, &bill(&acct, "Best Buy", -2_500, "2026-09-01")).expect("schedule");
        let common = create_common_transaction(
            &c,
            &NewCommonTransaction { payee: "Best Buy".to_string(), ..template("Warranty") },
        )
        .expect("template");
        let rule = create_payee_rule(&c, "BESTBUY", "Best Buy", None, &RuleConditions::default()).expect("rule");
        let chewy_rule = create_payee_rule(&c, "CHEWY.COM", "Chewy", None, &RuleConditions::default()).expect("rule 2");
        let p = list_payees(&c).unwrap().into_iter().find(|p| p.name == "Best Buy").expect("Best Buy");

        let text = |sql: &str, id: &str| -> String { c.query_row(sql, params![id], |r| r.get(0)).expect(sql) };
        let names = || {
            (
                text("SELECT payee FROM transactions WHERE id = ?1", &tv.id),
                text("SELECT payee FROM recurrences WHERE id = ?1", &rec.id),
                text("SELECT payee FROM common_transactions WHERE id = ?1", &common.id),
                text("SELECT payee_name FROM payee_rules WHERE id = ?1", &rule.id),
            )
        };
        let all = |n: &str| (n.to_string(), n.to_string(), n.to_string(), n.to_string());
        let untouched = |why: &str| {
            assert_eq!(text("SELECT payee FROM transactions WHERE id = ?1", &food.id), "Chewy", "{why}");
            assert_eq!(text("SELECT payee_name FROM payee_rules WHERE id = ?1", &chewy_rule.id), "Chewy", "{why}");
        };
        let payee_now = || list_payees(&c).unwrap().into_iter().find(|x| x.id == p.id).expect("the payee row");

        let (renamed, step) = update_payee(&c, &p.id, "Best Buy Store", Some(cat.id.as_str())).expect("rename");
        assert_eq!(step.label, "rename a payee");
        assert_eq!(renamed.name, "Best Buy Store");
        assert_eq!(names(), all("Best Buy Store"), "a copy of the name was left behind");
        untouched("rename");

        crate::db::undo::restore(&c, &step.before, &[]).expect("undo");
        let back = payee_now();
        assert_eq!(back.name, "Best Buy");
        assert_eq!(back.last_category_id, None, "the default category stayed changed");
        assert_eq!(back.usage_count, 1);
        assert_eq!(names(), all("Best Buy"), "undo left a copy renamed");
        untouched("undo");

        crate::db::undo::restore(&c, &step.after, &[]).expect("redo");
        let again = payee_now();
        assert_eq!(again.name, "Best Buy Store");
        assert_eq!(again.last_category_id.as_deref(), Some(cat.id.as_str()));
        assert_eq!(names(), all("Best Buy Store"), "redo left a copy behind");
        untouched("redo");

        // Entering the schedule now files under the renamed payee — it does
        // not bring "Best Buy" back.
        let entered = enter_occurrence(&c, &rec.id, "2026-09-01", "2026-09-01", None, None).expect("enter");
        let payee_id: Option<String> = c
            .query_row("SELECT payee_id FROM transactions WHERE id = ?1", params![entered.id], |r| r.get(0))
            .unwrap();
        assert_eq!(payee_id.as_deref(), Some(p.id.as_str()));
        assert!(!list_payees(&c).unwrap().iter().any(|x| x.name == "Best Buy"), "the old payee came back");
    }

    /// Undoing a merge after the old name was typed again is refused
    /// (`UNIQUE (name)`), with words the shell's notice can show, and
    /// the refusal changes nothing: `restore` runs in one SQL transaction.
    #[test]
    fn undoing_a_merge_after_the_old_name_came_back_is_refused_and_changes_nothing() {
        let db = TestDb::new("payee-merge-undo-refused");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        let tv = create_transaction(&c, &acct, "2026-08-01", "Best Buy", None, -49_900, None, None).expect("tv");
        create_transaction(&c, &acct, "2026-08-02", "Chewy", None, -6_400, None, None).expect("food");
        let payees = list_payees(&c).unwrap();
        let from = payees.iter().find(|p| p.name == "Best Buy").unwrap().id.clone();
        let into = payees.iter().find(|p| p.name == "Chewy").unwrap().id.clone();

        let (_, step) = merge_payees(&c, &from, &into).expect("merge");
        create_payee(&c, "Best Buy", None).expect("the name typed again");

        let why = crate::db::undo::restore(&c, &step.before, &[]).expect_err("undo should be refused");
        assert!(why.contains("payees"), "{why}");
        let payee_id: Option<String> = c
            .query_row("SELECT payee_id FROM transactions WHERE id = ?1", params![tv.id], |r| r.get(0))
            .unwrap();
        assert_eq!(payee_id.as_deref(), Some(into.as_str()), "a refused undo moved a transaction");
        assert!(!list_payees(&c).unwrap().iter().any(|p| p.id == from), "a refused undo put the old row back");
    }

    /// `PAYEE_REFS` names every foreign key to `payees`. A migration
    /// that adds one fails here rather than in a merge that leaves it behind.
    #[test]
    fn every_foreign_key_to_payees_is_one_the_merge_rewrites() {
        let db = TestDb::new("payee-refs");
        let c = db.conn();
        let mut st = c
            .prepare(
                "SELECT m.name, f.\"from\" FROM sqlite_master m, pragma_foreign_key_list(m.name) f
                  WHERE m.type = 'table' AND f.\"table\" = 'payees'",
            )
            .unwrap();
        let fks: Vec<(String, String)> =
            st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().collect::<Result<_, _>>().unwrap();
        assert!(!fks.is_empty(), "the query found no foreign keys at all — it is not looking");
        for (table, column) in fks {
            assert!(
                PAYEE_REFS.iter().any(|&(t, _, col, pick, by)| t == table && col == column && pick == column && by == NamedBy::Id),
                "{table}.{column} references payees and a merge would leave it behind"
            );
        }
    }

    /// Deleting an unused payee is a step: undo puts the row back
    /// with its default category, redo takes it away again.
    #[test]
    fn deleting_an_unused_payee_can_be_undone_and_redone() {
        let db = TestDb::new("payee-delete-undo");
        let c = db.conn();
        let cat = create_category(&c, "Utilities", "expense", None, None).expect("cat");
        let p = create_payee(&c, "City Water", Some(cat.id.as_str())).expect("payee");

        let step = delete_payee(&c, &p.id).expect("delete");
        assert_eq!(step.label, "delete a payee");
        assert!(list_payees(&c).unwrap().is_empty());

        crate::db::undo::restore(&c, &step.before, &[]).expect("undo");
        let back = list_payees(&c).unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!((back[0].id.as_str(), back[0].name.as_str()), (p.id.as_str(), "City Water"));
        assert_eq!(back[0].last_category_id.as_deref(), Some(cat.id.as_str()));

        crate::db::undo::restore(&c, &step.after, &[]).expect("redo");
        assert!(list_payees(&c).unwrap().is_empty());
    }

    #[test]
    fn a_payee_in_use_cannot_be_deleted() {
        let db = TestDb::new("payee-delete");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        create_transaction(&c, &acct, "2026-08-01", "Kroger", None, -4_250, None, None).expect("txn");
        let payee = list_payees(&c).expect("payees").remove(0);

        assert!(delete_payee(&c, &payee.id).is_err(), "deleting orphaned a register row");
    }

    #[test]
    fn a_payee_remembers_the_category_it_was_last_filed_under() {
        let db = TestDb::new("payee-recall");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        let cat = create_category(&c, "Subscriptions", "expense", None, None).expect("cat");
        create_transaction(&c, &acct, "2026-08-01", "Netflix", Some(cat.id.as_str()), -1_599, None, None)
            .expect("txn");

        // This is what the entry form's autofill reads.
        let payee = list_payees(&c).expect("payees").remove(0);
        assert_eq!(payee.last_category_id.as_deref(), Some(cat.id.as_str()));
    }

    // ── payee amount recall ──────────────────────────────────────
    //
    // `last_amount_cents` is derived in SQL rather than stored, so these test
    // the derivation: which transaction counts as "last", and which do not.

    fn payee_named<'a>(payees: &'a [Payee], name: &str) -> &'a Payee {
        payees
            .iter()
            .find(|p| p.name == name)
            .unwrap_or_else(|| panic!("payee {name} not found"))
    }

    #[test]
    fn a_payee_remembers_the_amount_of_its_most_recent_transaction() {
        let db = TestDb::new("recall-amount");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);

        create_transaction(&c, &acct, "2026-06-01", "Netflix", None, -1_599, None, None)
            .expect("older");
        create_transaction(&c, &acct, "2026-08-01", "Netflix", None, -1_899, None, None)
            .expect("newest");
        create_transaction(&c, &acct, "2026-07-01", "Netflix", None, -1_699, None, None)
            .expect("middle");

        let payees = list_payees(&c).expect("payees");
        assert_eq!(
            payee_named(&payees, "Netflix").last_amount_cents,
            Some(-1_899),
            "recall must be by date, not by insertion order"
        );
    }

    #[test]
    fn two_transactions_on_the_same_date_recall_the_one_entered_last() {
        let db = TestDb::new("recall-tie");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);

        create_transaction(&c, &acct, "2026-08-01", "Kroger", None, -4_250, None, None)
            .expect("first");
        create_transaction(&c, &acct, "2026-08-01", "Kroger", None, -6_100, None, None)
            .expect("second");

        let payees = list_payees(&c).expect("payees");
        assert_eq!(payee_named(&payees, "Kroger").last_amount_cents, Some(-6_100));
    }

    #[test]
    fn a_voided_transaction_is_not_recalled() {
        // A void means "this did not happen". Offering its amount would be
        // offering back a number the user deliberately reversed.
        let db = TestDb::new("recall-void");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);

        create_transaction(&c, &acct, "2026-07-01", "Shell", None, -3_000, None, None)
            .expect("real");
        let bad = create_transaction(&c, &acct, "2026-08-01", "Shell", None, -99_900, None, None)
            .expect("mistake");
        set_void(&c, &bad.id, true).expect("void");

        let payees = list_payees(&c).expect("payees");
        assert_eq!(
            payee_named(&payees, "Shell").last_amount_cents,
            Some(-3_000),
            "the voided amount was offered back"
        );
    }

    #[test]
    fn a_payee_with_no_transactions_left_recalls_nothing() {
        let db = TestDb::new("recall-empty");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        let txn = create_transaction(&c, &acct, "2026-08-01", "Kroger", None, -4_250, None, None)
            .expect("create");

        delete_transaction(&c, &txn.id).expect("delete");

        let payees = list_payees(&c).expect("payees");
        assert_eq!(payee_named(&payees, "Kroger").last_amount_cents, None);
    }

    #[test]
    fn recall_is_per_payee_and_survives_a_rename() {
        let db = TestDb::new("recall-rename");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        create_transaction(&c, &acct, "2026-08-01", "Kroger", None, -4_250, None, None)
            .expect("a");
        create_transaction(&c, &acct, "2026-08-02", "Shell", None, -3_000, None, None)
            .expect("b");

        let payees = list_payees(&c).expect("payees");
        assert_eq!(payee_named(&payees, "Kroger").last_amount_cents, Some(-4_250));
        assert_eq!(payee_named(&payees, "Shell").last_amount_cents, Some(-3_000));

        // A rename keeps payee_id, so the recall follows the payee.
        let kroger = payee_named(&payees, "Kroger").id.clone();
        update_payee(&c, &kroger, "Kroger Fuel", None).expect("rename");
        let payees = list_payees(&c).expect("payees");
        assert_eq!(payee_named(&payees, "Kroger Fuel").last_amount_cents, Some(-4_250));
    }

    #[test]
    fn a_deposit_payee_recalls_a_positive_amount() {
        // The sign is what tells the form whether to fill Payment or Deposit.
        let db = TestDb::new("recall-sign");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        create_transaction(&c, &acct, "2026-08-01", "Paycheck", None, 250_000, None, None)
            .expect("create");

        let payees = list_payees(&c).expect("payees");
        assert_eq!(payee_named(&payees, "Paycheck").last_amount_cents, Some(250_000));
    }

    // The split dialog completes a description from the ones used
    // before, most used first, one entry per spelling.
    #[test]
    fn split_descriptions_are_listed_most_used_first_and_case_folded() {
        let db = TestDb::new("splitdesc");
        let c = db.conn();
        let chk = account(&c, "Checking", 100_000);
        let line = |d: Option<&str>, cents: i64| NewSplit {
            classes: Vec::new(),
            category_id: None,
            description: d.map(str::to_string),
            amount_cents: cents,
            transfer_account_id: None,
        };
        let t1 = create_transaction(&c, &chk, "2026-02-02", "Store", None, -5_000, None, None).unwrap();
        set_splits(&c, &t1.id, &[line(Some("Milk"), -3_000), line(Some("  "), -1_000), line(None, -1_000)]).unwrap();
        let t2 = create_transaction(&c, &chk, "2026-02-03", "Store", None, -4_000, None, None).unwrap();
        set_splits(&c, &t2.id, &[line(Some("milk"), -3_000), line(Some("Bread"), -1_000)]).unwrap();
        let got = list_split_descriptions(&c).unwrap();
        let names: Vec<(String, i64)> = got.into_iter().map(|u| (u.name, u.usage_count)).collect();
        assert_eq!(names, vec![("Milk".to_string(), 2), ("Bread".to_string(), 1)]);
    }

    // A rule can look at the amount, the memo and the account, and a
    // rule with a condition outranks one without.
    #[test]
    fn rules_with_conditions_match_by_amount_memo_and_account_and_outrank_plain_ones() {
        let db = TestDb::new("rule-conds");
        let c = db.conn();
        let chk = account(&c, "Checking", 100_000);
        let visa = account(&c, "Visa", 0);
        let books = ensure_category(&c, "Books").unwrap();
        let household = ensure_category(&c, "Household").unwrap();
        let prime = ensure_category(&c, "Subscriptions").unwrap();
        let plain = create_payee_rule(&c, "AMAZON", "Amazon", Some(&household), &Default::default()).unwrap();
        let small = create_payee_rule(&c, "AMAZON", "Amazon", Some(&books), &RuleConditions { max_cents: Some(2_000), ..Default::default() }).unwrap();
        let memo = create_payee_rule(&c, "AMAZON", "Amazon Prime", Some(&prime), &RuleConditions { memo_contains: Some("prime".into()), ..Default::default() }).unwrap();
        let card = create_payee_rule(&c, "AMAZON", "Amazon (card)", None, &RuleConditions { account_id: Some(visa.clone()), ..Default::default() }).unwrap();
        assert!(card.account_name.as_deref() == Some("Visa"));
        // The same text with the same conditions is a duplicate; with different ones it is not.
        assert!(create_payee_rule(&c, "amazon", "Amazon", None, &Default::default()).unwrap_err().contains("already a rule"));
        assert!(create_payee_rule(&c, "amazon", "Amazon", None, &RuleConditions { max_cents: Some(2_000), ..Default::default() }).unwrap_err().contains("those conditions"));
        assert!(create_payee_rule(&c, "AMAZON", "x", None, &RuleConditions { min_cents: Some(5_000), max_cents: Some(1_000), ..Default::default() }).unwrap_err().contains("larger"));

        let rules = list_payee_rules(&c).unwrap();
        // Conditioned rules first, the plain one last.
        assert_eq!(rules.last().unwrap().id, plain.id);
        let pick = |payee: &str, cents: i64, memo: &str, acct: &str| rule_for(&rules, payee, cents, memo, acct).map(|r| r.id.clone());
        assert_eq!(pick("AMAZON.COM*XYZ", -1_599, "", &chk), Some(small.id.clone()), "under $20: Books");
        assert_eq!(pick("AMAZON.COM*XYZ", -4_599, "", &chk), Some(plain.id.clone()), "over $20: the plain rule");
        assert_eq!(pick("AMAZON.COM*XYZ", -4_599, "Prime membership", &chk), Some(memo.id.clone()), "the memo says Prime");
        assert_eq!(pick("AMAZON.COM*XYZ", -4_599, "", &visa), Some(card.id.clone()), "on the card");
        assert_eq!(pick("KROGER", -4_599, "", &chk), None);
        // Sign is ignored: a refund of $15 is still "under $20".
        assert_eq!(pick("AMAZON", 1_500, "", &chk), Some(small.id.clone()));

        // The rules pass through the existing-rows scan with the row's memo and account.
        create_transaction(&c, &visa, "2026-09-01", "AMAZON.COM*AB12", None, -3_000, None, None).unwrap();
        create_transaction(&c, &chk, "2026-09-02", "AMAZON.COM*CD34", None, -3_000, Some("prime video"), None).unwrap();
        let changes = preview_payee_rules(&c).unwrap();
        let by_payee = |p: &str| changes.iter().find(|x| x.payee == p).unwrap();
        assert_eq!(by_payee("AMAZON.COM*AB12").rule_id, card.id, "the card row takes the card rule");
        assert_eq!(by_payee("AMAZON.COM*CD34").rule_id, memo.id, "the memo row takes the memo rule");
    }
}
