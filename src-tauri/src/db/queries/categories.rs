//! Categories: the chart, and deleting or merging a category with everything
//! that points at it.

use crate::models::Category;
use crate::db::undo;
use rusqlite::{params, Connection, OptionalExtension, Row};
use uuid::Uuid;
use super::*;

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/// Categories, income first, then expense, each ordered by display name.
///
/// `full_name` and `usage_count` are computed in SQL — the tree, the pickers
/// and the "deleting this orphans N transactions" warning all need them, and
/// doing it here keeps every caller consistent.
const CATEGORY_SELECT: &str = r#"
    WITH cat_usage AS (
        SELECT COALESCE(s.category_id, t.category_id) AS category_id,
               COUNT(*)                               AS n
          FROM transactions t
          LEFT JOIN splits s ON s.transaction_id = t.id
         WHERE COALESCE(s.category_id, t.category_id) IS NOT NULL
         GROUP BY 1
    )
    SELECT c.id,
           c.name,
           c.parent_id,
           c.kind,
           c.tax_line,
           CASE WHEN c.parent_id IS NULL THEN c.name
                ELSE p.name || ' : ' || c.name END AS full_name,
           COALESCE(u.n, 0)                        AS usage_count
      FROM categories c
      LEFT JOIN categories p ON p.id = c.parent_id
      LEFT JOIN cat_usage  u ON u.category_id = c.id
"#;

const CATEGORY_ORDER: &str =
    " ORDER BY CASE c.kind WHEN 'income' THEN 0 ELSE 1 END, full_name COLLATE NOCASE";

fn map_category(row: &Row) -> rusqlite::Result<Category> {
    Ok(Category {
        id: row.get(0)?,
        name: row.get(1)?,
        parent_id: row.get(2)?,
        kind: row.get(3)?,
        tax_line: row.get(4)?,
        full_name: row.get(5)?,
        usage_count: row.get(6)?,
    })
}

pub fn list_categories(conn: &Conn) -> Result<Vec<Category>, String> {
    let sql = format!("{CATEGORY_SELECT}{CATEGORY_ORDER}");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let out = stmt
        .query_map([], map_category)
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(out)
}

/// One category by id, with the same computed columns as `list_categories`.
pub fn get_category(conn: &Conn, id: &str) -> Result<Category, String> {
    let sql = format!("{CATEGORY_SELECT} WHERE c.id = ?1");
    conn.query_row(&sql, params![id], map_category)
        .map_err(|e| e.to_string())
}

/// Look up a category by exact name; create it if missing. Returns the id.
///
/// Used by import and by any path that only has a name. New categories land as
/// top-level `expense` — the Categories manager is where a user files them
/// under a parent or flips them to income.
pub fn ensure_category(conn: &Connection, name: &str) -> Result<String, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("category name is empty".into());
    }
    // Since 0015 a name is unique only within its parent, so a bare name can
    // match more than one row ("Insurance" top-level, and under Automobile).
    // Prefer the top-level one and fall back to any match, so an import can
    // never silently file into somebody's subcategory.
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM categories WHERE name = ?1 COLLATE NOCASE
              ORDER BY (parent_id IS NOT NULL), name LIMIT 1",
            params![name],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(id) = existing {
        return Ok(id);
    }
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO categories (id, name) VALUES (?1, ?2)",
        params![id, name],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

/// A QIF category path — `Food:Groceries` — resolved to the subcategory,
/// creating the parent and the child as needed. Until now the
/// importer flattened `Food:Groceries` to `Food`, which threw away the
/// half of the name Money and Quicken actually file by. A bare name goes
/// through `ensure_category`. Deeper paths keep only the first two levels,
/// which is all the category tree has.
pub fn ensure_category_path(conn: &Connection, path: &str) -> Result<String, String> {
    let mut parts = path.split(':').map(str::trim).filter(|p| !p.is_empty());
    let Some(top) = parts.next() else {
        return Err("category name is empty".into());
    };
    let Some(child) = parts.next() else {
        return ensure_category(conn, top);
    };
    let parent_id: Option<String> = conn
        .query_row(
            "SELECT id FROM categories WHERE name = ?1 COLLATE NOCASE AND parent_id IS NULL",
            params![top],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let parent_id = match parent_id {
        Some(id) => id,
        None => {
            let id = Uuid::new_v4().to_string();
            conn.execute("INSERT INTO categories (id, name) VALUES (?1, ?2)", params![id, top])
                .map_err(|e| e.to_string())?;
            id
        }
    };
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM categories WHERE name = ?1 COLLATE NOCASE AND parent_id = ?2",
            params![child, parent_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(id) = existing {
        return Ok(id);
    }
    let kind: String = conn
        .query_row("SELECT kind FROM categories WHERE id = ?1", params![parent_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO categories (id, name, parent_id, kind) VALUES (?1, ?2, ?3, ?4)",
        params![id, child, parent_id, kind],
    )
    .map_err(|e| e.to_string())?;
    Ok(id)
}

/// Add every standard category the file is missing. Additive and idempotent;
/// returns how many were created. See `db::standard_categories`.
pub fn seed_standard_categories(conn: &Conn) -> Result<usize, String> {
    crate::db::standard_categories::seed(conn)
}

fn check_kind(kind: &str) -> Result<(), String> {
    match kind {
        "income" | "expense" => Ok(()),
        other => Err(format!("unknown category kind '{other}' (expected income or expense)")),
    }
}

/// Money's tree is exactly two levels deep: a parent must itself be top-level.
/// Returns the parent's kind, which the child is forced to share.
fn validate_parent(conn: &Conn, parent_id: &str) -> Result<String, String> {
    let row: Option<(Option<String>, String)> = conn
        .query_row(
            "SELECT parent_id, kind FROM categories WHERE id = ?1",
            params![parent_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match row {
        None => Err("parent category not found".into()),
        Some((Some(_), _)) => {
            Err("a subcategory cannot have subcategories — Money's tree is two levels".into())
        }
        Some((None, kind)) => Ok(kind),
    }
}

/// Create a category (or subcategory). A subcategory inherits its parent's kind.
pub fn create_category(
    conn: &Conn,
    name: &str,
    kind: &str,
    parent_id: Option<&str>,
    tax_line: Option<&str>,
) -> Result<Category, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("category name is empty".into());
    }
    check_kind(kind)?;
    let kind = match parent_id {
        Some(pid) => validate_parent(conn, pid)?,
        None => kind.to_string(),
    };
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO categories (id, name, kind, parent_id, tax_line)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, name, kind, parent_id, tax_line],
    )
    .map_err(|e| {
        if e.to_string().contains("UNIQUE") {
            format!("a category named '{name}' already exists")
        } else {
            e.to_string()
        }
    })?;
    get_category(conn, &id)
}

/// Rename / reparent / retype a category. Changing a parent's kind cascades to
/// its children, because a subcategory always shares its parent's kind.
pub fn update_category(
    conn: &Conn,
    id: &str,
    name: &str,
    kind: &str,
    parent_id: Option<&str>,
    tax_line: Option<&str>,
) -> Result<Category, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("category name is empty".into());
    }
    check_kind(kind)?;

    let has_children: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM categories WHERE parent_id = ?1)",
            params![id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    let kind = match parent_id {
        Some(pid) if pid == id => return Err("a category cannot be its own parent".into()),
        Some(_) if has_children => {
            return Err("this category has subcategories, so it cannot become one itself".into())
        }
        Some(pid) => validate_parent(conn, pid)?,
        None => kind.to_string(),
    };

    conn.execute(
        "UPDATE categories SET name = ?2, kind = ?3, parent_id = ?4, tax_line = ?5
         WHERE id = ?1",
        params![id, name, kind, parent_id, tax_line],
    )
    .map_err(|e| {
        if e.to_string().contains("UNIQUE") {
            format!("a category named '{name}' already exists")
        } else {
            e.to_string()
        }
    })?;

    // Children follow their parent's kind.
    conn.execute(
        "UPDATE categories SET kind = ?2 WHERE parent_id = ?1",
        params![id, kind],
    )
    .map_err(|e| e.to_string())?;

    get_category(conn, id)
}

/// Delete a category.
///
/// `reassign_to` is Money's "what should happen to the transactions?" answer:
/// `Some(id)` refiles every transaction, split line, budget and payee default
/// onto that category; `None` leaves them uncategorized. Subcategories are
/// **promoted to top level**, never deleted — losing a whole branch because a
/// parent was tidied away is not recoverable.
///
/// With a target, this is a merge that promotes the children instead
/// of moving them, and it now runs the merge's own body (`fold_category`).
/// It used to re-point four things: transactions, splits, payee defaults and
/// budgets. Payee rules, scheduled bills, common transactions, statements and
/// a loan's escrow and interest categories were left to `ON DELETE SET NULL`
/// — the exact list the undoable merge fixed and never carried here — the year
/// plan was cascaded away, and a budget month the target already had was
/// dropped rather than folded. And it could not be undone, while
/// `undo_stack_invalidated` was not called either, so Ctrl+Z reached past it.
/// It returns the step now, with or without a target.
pub fn delete_category(conn: &Conn, id: &str, reassign_to: Option<&str>) -> Result<undo::Step, String> {
    if reassign_to == Some(id) {
        return Err("cannot reassign a category to itself".into());
    }
    if let Some(target) = reassign_to {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM categories WHERE id = ?1)",
                params![target],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !exists {
            return Err("the category to reassign to does not exist".into());
        }
        // Reassigning runs the merge's body, so it keeps the merge's
        // same-kind rule: income is not refiled as spending, or spending as income.
        let (from_kind, from_name, into_kind, into_name): (String, String, String, String) = conn
            .query_row(
                "SELECT f.kind, f.name, t.kind, t.name FROM categories f, categories t WHERE f.id = ?1 AND t.id = ?2",
                params![id, target],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .map_err(|e| e.to_string())?;
        if from_kind != into_kind {
            let (got, as_) = if from_kind == "income" { ("received", "spent") } else { ("spent", "received") };
            return Err(format!(
                "{from_name} is {} and {into_name} is {} — reassigning its transactions would file money you {got} as money you {as_}. Choose a category of the same kind.",
                if from_kind == "income" { "income" } else { "an expense" },
                if into_kind == "income" { "income" } else { "an expense" },
            ));
        }
    }

    // Promoting a child to top level can COLLIDE. Since 0015 a top-level name
    // must be unique, and the standard chart ships both `Automobile :
    // Insurance` and a top-level `Insurance` — so deleting Automobile would
    // fail deep in SQLite with "UNIQUE constraint failed". Name the offender
    // instead, and leave the tree untouched.
    //
    // This check runs BEFORE any write. It used to run after the transactions,
    // splits and payees had already been refiled, so a refused delete had
    // silently uncategorized every transaction and then claimed it had left
    // things alone. Everything below is one SQL transaction for the same
    // reason.
    let clashing: Vec<String> = {
        let mut stmt = conn
            .prepare(
                "SELECT c.name FROM categories c
                  WHERE c.parent_id = ?1
                    AND EXISTS (SELECT 1 FROM categories t
                                 WHERE t.parent_id IS NULL
                                   AND t.name = c.name
                                   AND t.id <> ?1)
                  ORDER BY c.name",
            )
            .map_err(|e| e.to_string())?;
        // Bind the Vec before returning it — the MappedRows temporary would
        // otherwise outlive `stmt` (E0597).
        let out = stmt
            .query_map(params![id], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<String>, _>>()
            .map_err(|e| e.to_string())?;
        out
    };
    if !clashing.is_empty() {
        return Err(format!(
            "cannot delete this category: its subcategories would move to the top \
             level, where these names are already taken — {}. Rename or move them first.",
            clashing.join(", ")
        ));
    }

    let label = format!("delete category {}", category_name(conn, id));
    // Promote children instead of cascading the delete into them.
    fold_category(conn, id, reassign_to, Subcategories::Promote, label)
}

/// Fold `from_id` into `into_id`: every transaction, split, budget, payee
/// default and subcategory moves across, then the source category is removed.
/// Every place in the schema that stores a category id, as
/// `(table, key column, category column)`.
///
/// A merge re-points every one of them and undo puts every one of them back.
/// The list is exhaustive against the FK declarations in `migrations.rs`, and
/// that matters: the merge used to re-point four of these and left the
/// other nine to `ON DELETE SET NULL`. Merging `Fuel` into `Gasoline`
/// therefore **silently defused every payee rule that filed to Fuel**, blanked
/// the category on any scheduled bill and common transaction that used it, and
/// unhooked a loan's escrow or interest category — none of which the
/// confirmation mentioned, and none of which showed up anywhere afterwards
/// except as transactions quietly arriving as Uncategorized.
///
/// A new table with a category column belongs in this list. `budgets` is
/// deliberately absent: it carries `UNIQUE (category_id, month_year)`, so it
/// cannot simply be re-pointed, and it is handled on its own below.
/// So is `budget_plans`, `UNIQUE (category_id, year)`, which the merge did
/// not know about at all; `plan::fold_plans` folds it.
const CATEGORY_REFS: &[(&str, &str, &str)] = &[
    ("transactions", "id", "category_id"),
    ("splits", "id", "category_id"),
    ("payees", "id", "last_category_id"),
    ("statements", "id", "service_charge_category_id"),
    ("statements", "id", "interest_category_id"),
    ("statements", "id", "adjustment_category_id"),
    ("common_transactions", "id", "category_id"),
    ("common_transaction_splits", "id", "category_id"),
    ("recurrences", "id", "category_id"),
    ("payee_rules", "id", "category_id"),
    ("loan_terms", "account_id", "escrow_category_id"),
    ("loan_terms", "account_id", "interest_category_id"),
    ("categories", "id", "parent_id"),
];

/// `cents`, stated in the `from` period, restated in the `to` period.
///
/// Adding a yearly 1,560 to a monthly 130 gives 1,690 of nothing at all, so
/// two budgets being folded together are put in the same units first.
pub fn in_period(cents: i64, from: &str, to: &str) -> i64 {
    match (from, to) {
        ("yearly", "monthly") => monthly_equivalent(cents, "yearly"),
        ("monthly", "yearly") => cents * 12,
        _ => cents,
    }
}

/// Why this merge cannot happen — `None` when it can.
///
/// The undoable merge split this out of `merge_categories` so that the dialog can ask the
/// same question the merge will ask, before the user presses anything. A
/// refusal discovered by pressing Merge is a refusal the user had already
/// decided was going to work.
pub fn merge_blocked(conn: &Conn, from_id: &str, into_id: &str) -> Result<Option<String>, String> {
    if from_id == into_id {
        return Ok(Some("cannot merge a category into itself".into()));
    }

    // Income and expense do not merge, in either direction.
    //
    // Found by walking M7: *"chose Income Interest : Interest and told it to
    // merge into Credit card : Interest... didn't stop me, didn't warn me."*
    // It merged.
    //
    // This is worse than a tidy-up gone wrong. `kind` is what every report,
    // the spending tracker, the year plan's two blocks and the Net line sort
    // on. Moving a year of interest RECEIVED under a category marked as money
    // spent does not produce a wrong-looking total — it produces a plausible
    // one, in the wrong block, and nothing anywhere says so afterwards.
    //
    // Undo does recover it (this was checked), but only if you notice.
    let kind_of = |id: &str| -> Result<Option<(String, String)>, String> {
        conn.query_row(
            "SELECT kind, name FROM categories WHERE id = ?1",
            params![id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())
    };
    if let (Some((from_kind, from_name)), Some((into_kind, into_name))) =
        (kind_of(from_id)?, kind_of(into_id)?)
    {
        if from_kind != into_kind {
            let word = |k: &str| if k == "income" { "income" } else { "an expense" };
            return Ok(Some(format!(
                "{from_name} is {} and {into_name} is {} — merging them would file money you received as money you spent. Move the transactions by hand if that is really what you want.",
                word(&from_kind),
                word(&into_kind)
            )));
        }
    }

    let target_is_child: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM categories WHERE id = ?1 AND parent_id IS NOT NULL)",
            params![into_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let source_has_children: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM categories WHERE parent_id = ?1)",
            params![from_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if target_is_child && source_has_children {
        return Ok(Some(
            "cannot merge a category that has subcategories into a subcategory — the tree is only two levels".into(),
        ));
    }
    // Moving the source's children under the target hits the same wall as
    // delete_category: the target may already have a child of that name.
    // Checked BEFORE any write, for the same reason as there.
    let clashing: Vec<String> = {
        let mut stmt = conn
            .prepare(
                "SELECT c.name FROM categories c
                  WHERE c.parent_id = ?1
                    AND EXISTS (SELECT 1 FROM categories t
                                 WHERE t.parent_id = ?2 AND t.name = c.name)
                  ORDER BY c.name",
            )
            .map_err(|e| e.to_string())?;
        let out = stmt
            .query_map(params![from_id, into_id], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<String>, _>>()
            .map_err(|e| e.to_string())?;
        out
    };
    if !clashing.is_empty() {
        return Ok(Some(format!(
            "cannot merge: the destination already has subcategories named {}. \
             Rename or merge those first.",
            clashing.join(", ")
        )));
    }
    Ok(None)
}

/// Key values of every row whose `column` currently holds `value`.
fn keys_pointing_at(
    conn: &Conn,
    table: &str,
    key: &str,
    column: &str,
    value: &str,
) -> Result<Vec<String>, String> {
    let mut st = conn
        .prepare(&format!("SELECT {key} FROM {table} WHERE {column} = ?1 ORDER BY {key}"))
        .map_err(|e| e.to_string())?;
    // Bind before returning — the MappedRows temporary would otherwise
    // outlive `st` (E0597).
    let out = st
        .query_map(params![value], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(out)
}

/// What a merge is about to do, counted before it does it.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePreview {
    pub transactions: i64,
    pub splits: i64,
    /// Budget months that move across, folded or otherwise.
    pub budgets: i64,
    /// Budget months where BOTH sides already have an amount, and the two
    /// will be added together. Called out on its own because it is the one
    /// number a merge changes rather than moves.
    pub budgets_folded: i64,
    pub payee_rules: i64,
    pub recurrences: i64,
    pub children: i64,
    /// Everything else that names the source: payees, statements, common
    /// transactions and loan terms. One number, because naming each of them
    /// in the dialog buries the two that matter.
    pub other_links: i64,
    pub blocked: Option<String>,
}

/// Count what a merge would touch, without touching it.
pub fn preview_merge(conn: &Conn, from_id: &str, into_id: &str) -> Result<MergePreview, String> {
    let mut p = MergePreview { blocked: merge_blocked(conn, from_id, into_id)?, ..Default::default() };
    if from_id == into_id {
        return Ok(p);
    }
    for &(table, key, column) in CATEGORY_REFS {
        let n = keys_pointing_at(conn, table, key, column, from_id)?.len() as i64;
        match (table, column) {
            ("transactions", _) => p.transactions = n,
            ("splits", _) => p.splits = n,
            ("payee_rules", _) => p.payee_rules = n,
            ("recurrences", _) => p.recurrences = n,
            ("categories", _) => p.children = n,
            _ => p.other_links += n,
        }
    }
    p.budgets = conn
        .query_row(
            "SELECT COUNT(*) FROM budgets WHERE category_id = ?1",
            params![from_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    p.budgets_folded = conn
        .query_row(
            "SELECT COUNT(*) FROM budgets f
              WHERE f.category_id = ?1
                AND EXISTS (SELECT 1 FROM budgets t
                             WHERE t.category_id = ?2 AND t.month_year = f.month_year)",
            params![from_id, into_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(p)
}

/// One budget row, as a merge needs to see it.
struct MergeBudget {
    id: String,
    target_cents: i64,
    month_year: String,
    period: String,
}

fn budgets_of(conn: &Conn, category_id: &str) -> Result<Vec<MergeBudget>, String> {
    let mut st = conn
        .prepare("SELECT id, target_cents, month_year, period FROM budgets WHERE category_id = ?1")
        .map_err(|e| e.to_string())?;
    let out = st
        .query_map(params![category_id], |r| {
            Ok(MergeBudget {
                id: r.get(0)?,
                target_cents: r.get(1)?,
                month_year: r.get(2)?,
                period: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(out)
}

/// Fold `from_id` into `into_id` and delete it, returning the step that puts
/// it back.
///
/// Undoable, because a user asked for it: which way a merge went
/// was not obvious, and getting it wrong looked permanent without a backup
/// taken just before. Both halves of that are addressed —
/// the direction is now spelled out in the dialog and in the button you
/// press, and getting it backwards costs one Ctrl+Z rather than a restore.
///
/// The step is built out of `undo::Cells` rather than the row photographs the
/// rest of `undo.rs` uses, because a merge does not delete the rows it
/// touches: it changes one column on each. See `undo::Snapshot` for why the
/// three parts are applied drops-inserts-cells in both directions.
pub fn merge_categories(conn: &Conn, from_id: &str, into_id: &str) -> Result<undo::Step, String> {
    if let Some(why) = merge_blocked(conn, from_id, into_id)? {
        return Err(why);
    }
    let label = format!("merge {} into {}", category_name(conn, from_id), category_name(conn, into_id));
    fold_category(conn, from_id, Some(into_id), Subcategories::MoveWith, label)
}

fn category_name(conn: &Conn, id: &str) -> String {
    conn.query_row("SELECT name FROM categories WHERE id = ?1", params![id], |r| r.get::<_, String>(0))
        .unwrap_or_else(|_| "a category".to_string())
}

/// Where a folded category's subcategories go: under the destination
/// (a merge), or up to the top level (a delete, which never takes a branch
/// with it).
#[derive(Clone, Copy, PartialEq)]
enum Subcategories {
    MoveWith,
    Promote,
}

/// Fold `from_id` into `into_id` (or, with no destination, uncategorize what
/// named it), delete it, and return the step that puts it back. The body
/// behind both `merge_categories` and `delete_category`, so the two
/// can no longer disagree about what names a category.
///
/// The step is built out of `undo::Cells` rather than the row photographs the
/// rest of `undo.rs` uses, because a merge does not delete the rows it
/// touches: it changes one column on each. See `undo::Snapshot` for why the
/// parts are applied drops-inserts-cells-late drops in both directions.
fn fold_category(
    conn: &Conn,
    from_id: &str,
    into_id: Option<&str>,
    children: Subcategories,
    label: String,
) -> Result<undo::Step, String> {
    use rusqlite::types::Value;
    // What each column holds afterwards: the destination, or NULL — for
    // every column when nothing is reassigned, and for `parent_id` when the
    // children are promoted.
    let after_for = |table: &str| -> Option<&str> {
        if table == "categories" && children == Subcategories::Promote {
            None
        } else {
            into_id
        }
    };
    let value_of = |v: Option<&str>| v.map_or(Value::Null, |s| Value::Text(s.to_string()));

    // ── Photograph, before a single write ─────────────────────────────────
    // Every column that names the source, and the key of every row holding
    // it. Undo puts the source id back into exactly these; redo puts what
    // the fold wrote into exactly these.
    let mut cells_before: Vec<undo::Cells> = Vec::new();
    let mut cells_after: Vec<undo::Cells> = Vec::new();
    for &(table, key, column) in CATEGORY_REFS {
        let keys = keys_pointing_at(conn, table, key, column, from_id)?;
        if keys.is_empty() {
            continue;
        }
        let at = |v: Value| -> Vec<(Value, Value)> {
            keys.iter().map(|k| (Value::Text(k.clone()), v.clone())).collect()
        };
        cells_before.push(undo::Cells { table, key, column, rows: at(Value::Text(from_id.to_string())) });
        cells_after.push(undo::Cells { table, key, column, rows: at(value_of(after_for(table))) });
    }

    // The category row itself, which the fold deletes.
    let category_row = undo::photograph(conn, "categories", "id", &[from_id.to_string()])?;

    // Budgets and year plans, photographed by CATEGORY rather than by
    // row id. The merge used to photograph the budget rows it folded by id, which was
    // exact while a merge only ever edited those rows; folding a year plan
    // means rebuilding the year's monthly rows (`plan::materialize` deletes
    // and re-inserts them under new ids) and re-running the envelope rule on
    // both parents, so the rows that change are every budget and plan of the
    // source, the destination and their parents. A photograph a little wider
    // than the change is harmless; one narrower loses a row.
    let parent_of = |id: &str| -> Result<Option<String>, String> {
        conn.query_row("SELECT parent_id FROM categories WHERE id = ?1", params![id], |r| r.get::<_, Option<String>>(0))
            .optional()
            .map(Option::flatten)
            .map_err(|e| e.to_string())
    };
    let mut touched: Vec<String> = vec![from_id.to_string()];
    touched.extend(parent_of(from_id)?);
    if let Some(into) = into_id {
        touched.push(into.to_string());
        touched.extend(parent_of(into)?);
    }
    touched.sort();
    touched.dedup();
    let budgets_before = undo::photograph(conn, "budgets", "category_id", &touched)?;
    let plans_before = undo::photograph(conn, "budget_plans", "category_id", &touched)?;

    let source_budgets = budgets_of(conn, from_id)?;
    let dest_budgets = match into_id {
        Some(into) => budgets_of(conn, into)?,
        None => Vec::new(),
    };

    // ── Write ─────────────────────────────────────────────────────────────
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for &(table, _key, column) in CATEGORY_REFS {
        tx.execute(
            &format!("UPDATE {table} SET {column} = ?2 WHERE {column} = ?1"),
            params![from_id, after_for(table)],
        )
        .map_err(|e| e.to_string())?;
    }

    // Budgets are folded, not re-pointed.
    //
    // `UNIQUE (category_id, month_year)` means the destination may already
    // hold a row for the same month. The old code said `UPDATE OR IGNORE`,
    // which left the source's row where it was — and three statements later
    // `DELETE FROM categories` fired `ON DELETE CASCADE` and took it. A
    // month's budget vanished, and nothing anywhere said so.
    //
    // Two envelopes for the same spending become one envelope holding both
    // (the envelope model), converted into the destination's period first.
    if let Some(into) = into_id {
        for s in &source_budgets {
            match dest_budgets.iter().find(|d| d.month_year == s.month_year) {
                Some(d) => {
                    tx.execute(
                        "UPDATE budgets SET target_cents = ?2 WHERE id = ?1",
                        params![
                            d.id,
                            d.target_cents + in_period(s.target_cents, &s.period, &d.period)
                        ],
                    )
                    .map_err(|e| e.to_string())?;
                }
                None => {
                    tx.execute(
                        "UPDATE budgets SET category_id = ?2 WHERE id = ?1",
                        params![s.id, into],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
        }
    }
    // Whatever is left pointing at the source here is a folded-in row (or,
    // with no destination, a budget of a category that is going), and the
    // cascade below would take it. Take it deliberately instead, so the
    // deletion is something this function did rather than something that
    // happened to it.
    tx.execute("DELETE FROM budgets WHERE category_id = ?1", params![from_id])
        .map_err(|e| e.to_string())?;
    // The year plans, the same way. `plan::fold_plans` writes through
    // `conn`, which is inside `tx`: same connection, same SQL transaction.
    let years = match into_id {
        Some(into) => crate::db::plan::fold_plans(conn, from_id, into)?,
        None => Vec::new(),
    };
    tx.execute("DELETE FROM budget_plans WHERE category_id = ?1", params![from_id])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM categories WHERE id = ?1", params![from_id])
        .map_err(|e| e.to_string())?;
    // The destination now carries the source's plan, and the source's old
    // parent has lost a child's claim: both envelopes are re-checked, and the
    // year's monthly rows rebuilt from the plans, or every screen reading
    // `budgets` would go on showing the pre-merge figures.
    for year in years {
        crate::db::plan::settle_after_fold(conn, &touched, year)?;
    }
    tx.commit().map_err(|e| e.to_string())?;

    // ── Photograph again ──────────────────────────────────────────────────
    let budgets_after = undo::photograph(conn, "budgets", "category_id", &touched)?;
    let plans_after = undo::photograph(conn, "budget_plans", "category_id", &touched)?;
    let by_category = |table: &'static str| undo::Removal {
        table,
        key: "category_id",
        values: touched.iter().map(|i| Value::Text(i.clone())).collect(),
    };

    Ok(undo::Step {
        label,
        // Undo: clear the budget and plan rows this fold could have touched,
        // put the category and the original rows back, then point everything
        // at the source again. The category goes in before the rows and the
        // cells because they are what point at it.
        before: undo::Snapshot {
            drops: vec![by_category("budgets"), by_category("budget_plans")],
            inserts: vec![category_row, budgets_before, plans_before],
            cells: cells_before,
            ..Default::default()
        },
        // Redo: clear them, put the folded ones back, point everything at the
        // destination — and only THEN delete the source. Deleting it first
        // would fire `ON DELETE SET NULL` on its subcategories and drop them to
        // top level, where a name collision can refuse the delete outright. By
        // the time `late_drops` runs, the row has nothing pointing at it and
        // no cascade fires.
        after: undo::Snapshot {
            drops: vec![by_category("budgets"), by_category("budget_plans")],
            inserts: vec![budgets_after, plans_after],
            cells: cells_after,
            late_drops: vec![undo::Removal {
                table: "categories",
                key: "id",
                values: vec![Value::Text(from_id.to_string())],
            }],
            ..Default::default()
        },
    })
}

#[cfg(test)]
mod tests {
    use crate::models::{NewCommonTransaction, NewRecurrence};
    use rusqlite::params;
    use super::*;
    use crate::db::queries::test_support::*;

    /// Income and expense do not merge, found by walking M7.
    ///
    /// > *"chose Income Interest : Interest and told it to merge into Credit
    /// >  card : Interest... Yeah, didn't stop me, didn't warn me that I was
    /// >  merging an income category into an expense and should have stopped
    /// >  me anyway."*
    ///
    /// It merged. Undo recovered it, but only because the user noticed — and a year
    /// of interest RECEIVED filed under a category marked as money spent does
    /// not look wrong afterwards, it looks plausible.
    #[test]
    fn income_and_expense_do_not_merge_in_either_direction() {
        let db = TestDb::new("merge-kinds");
        let c = db.conn();
        let earned = create_category(&c, "Interest earned", "income", None, None).unwrap().id;
        let paid = create_category(&c, "Interest paid", "expense", None, None).unwrap().id;

        let why = merge_blocked(&c, &earned, &paid).unwrap().expect("blocked");
        assert!(why.contains("money you received as money you spent"), "{why}");
        assert!(merge_categories(&c, &earned, &paid).is_err());

        // And the other way round, which is the direction actually driven.
        assert!(merge_blocked(&c, &paid, &earned).unwrap().is_some());
        assert!(merge_categories(&c, &paid, &earned).is_err());

        // Nothing was half-done: both categories are still there.
        for id in [&earned, &paid] {
            let n: i64 = c
                .query_row("SELECT COUNT(*) FROM categories WHERE id = ?1", params![id], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 1);
        }

        // Same kind still merges, so the guard has not swallowed the feature.
        let other = create_category(&c, "Bank fees", "expense", None, None).unwrap().id;
        assert!(merge_blocked(&c, &other, &paid).unwrap().is_none());
    }

    // ── categories ───────────────────────────────────────────────────────

    #[test]
    fn a_subcategory_may_share_a_name_across_parents() {
        let db = TestDb::new("cat-names");
        let c = db.conn();
        let auto = create_category(&c, "Automobile", "expense", None, None).expect("auto");
        let house = create_category(&c, "House", "expense", None, None).expect("house");

        // Migration 0015: unique per parent, not globally.
        create_category(&c, "Repairs", "expense", Some(auto.id.as_str()), None).expect("auto repairs");
        create_category(&c, "Repairs", "expense", Some(house.id.as_str()), None).expect("house repairs");

        // But one parent still cannot have two children with the same name…
        assert!(create_category(&c, "Repairs", "expense", Some(auto.id.as_str()), None).is_err());
        // …and two top-level categories still cannot collide.
        assert!(create_category(&c, "House", "expense", None, None).is_err());
    }

    #[test]
    fn a_subcategory_takes_its_parents_kind_and_full_name() {
        let db = TestDb::new("cat-kind");
        let c = db.conn();
        let wages = create_category(&c, "Wages", "income", None, None).expect("wages");

        // Asking for "expense" under an income parent must not win.
        let bonus = create_category(&c, "Bonus", "expense", Some(wages.id.as_str()), None).expect("bonus");
        assert_eq!(bonus.kind, "income");
        assert_eq!(bonus.full_name, "Wages : Bonus");
    }

    #[test]
    fn changing_a_parents_kind_cascades_to_its_children() {
        let db = TestDb::new("cat-cascade");
        let c = db.conn();
        let parent = create_category(&c, "Side Work", "expense", None, None).expect("parent");
        let child = create_category(&c, "Fees", "expense", Some(parent.id.as_str()), None).expect("child");

        update_category(&c, &parent.id, "Side Work", "income", None, None).expect("flip");

        assert_eq!(get_category(&c, &child.id).expect("child").kind, "income");
    }

    #[test]
    fn deleting_a_category_can_refile_its_transactions() {
        let db = TestDb::new("cat-delete");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        let old = create_category(&c, "Misc", "expense", None, None).expect("old");
        let new = create_category(&c, "Groceries", "expense", None, None).expect("new");
        create_transaction(&c, &acct, "2026-08-01", "Kroger", Some(old.id.as_str()), -4_250, None, None)
            .expect("txn");

        delete_category(&c, &old.id, Some(new.id.as_str())).expect("delete");

        assert_eq!(get_category(&c, &new.id).expect("new").usage_count, 1);
        assert_eq!(entered(&c, &acct)[0].category_id.as_deref(), Some(new.id.as_str()));
    }

    #[test]
    fn deleting_a_parent_promotes_its_children_instead_of_removing_them() {
        let db = TestDb::new("cat-promote");
        let c = db.conn();
        let parent = create_category(&c, "Automobile", "expense", None, None).expect("parent");
        let child = create_category(&c, "Fuel", "expense", Some(parent.id.as_str()), None).expect("child");

        delete_category(&c, &parent.id, None).expect("delete");

        let kept = get_category(&c, &child.id).expect("the child was deleted with its parent");
        assert_eq!(kept.parent_id, None);
        assert_eq!(kept.full_name, "Fuel");
    }

    #[test]
    fn deleting_a_parent_is_refused_when_promotion_would_collide() {
        let db = TestDb::new("cat-promote-clash");
        let c = db.conn();
        // Exactly the shape the standard chart ships: a top-level Insurance
        // AND an Automobile : Insurance. Promoting the child on delete would
        // put two `Insurance` rows at the top level.
        let auto = create_category(&c, "Automobile", "expense", None, None).expect("auto");
        create_category(&c, "Insurance", "expense", None, None).expect("top-level");
        create_category(&c, "Insurance", "expense", Some(auto.id.as_str()), None).expect("child");

        let err = delete_category(&c, &auto.id, None).expect_err("should be refused");
        assert!(err.contains("Insurance"), "the message must name the offender: {err}");

        // And nothing was half-done.
        assert!(get_category(&c, &auto.id).is_ok(), "the parent was deleted anyway");
        assert_eq!(
            list_categories(&c).expect("list").len(),
            3,
            "the tree was modified by a refused delete"
        );
    }

    #[test]
    fn merging_is_refused_when_the_destination_has_a_child_of_the_same_name() {
        let db = TestDb::new("cat-merge-clash");
        let c = db.conn();
        let from = create_category(&c, "Auto", "expense", None, None).expect("from");
        let into = create_category(&c, "Automobile", "expense", None, None).expect("into");
        create_category(&c, "Fuel", "expense", Some(from.id.as_str()), None).expect("from child");
        create_category(&c, "Fuel", "expense", Some(into.id.as_str()), None).expect("into child");

        let err = merge_categories(&c, &from.id, &into.id).expect_err("should be refused");
        assert!(err.contains("Fuel"), "the message must name the offender: {err}");
        assert!(get_category(&c, &from.id).is_ok(), "the source was removed anyway");
    }

    #[test]
    fn merging_categories_moves_transactions_and_budgets() {
        let db = TestDb::new("cat-merge");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        let from = create_category(&c, "Food", "expense", None, None).expect("from");
        let into = create_category(&c, "Groceries", "expense", None, None).expect("into");
        create_transaction(&c, &acct, "2026-08-01", "Kroger", Some(from.id.as_str()), -4_250, None, None)
            .expect("txn");
        set_budget(&c, &from.id, 40_000, "2026-08").expect("budget");

        merge_categories(&c, &from.id, &into.id).expect("merge");

        assert!(get_category(&c, &from.id).is_err(), "the source survived");
        assert_eq!(get_category(&c, &into.id).expect("into").usage_count, 1);
        let budgets = list_budgets(&c, "2026-08").expect("budgets");
        assert_eq!(budgets.len(), 1);
        assert_eq!(budgets[0].category_id, into.id, "the budget was orphaned");
    }

    // ── Undoable merges ───────────────────────────────────────────────────

    /// The links the old merge dropped on the floor. Every one of these
    /// pointed at the source and was left to `ON DELETE SET NULL`.
    #[test]
    fn merging_carries_every_link_across_not_just_transactions() {
        let db = TestDb::new("cat-merge-links");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        let from = create_category(&c, "Fuel", "expense", None, None).expect("from");
        let into = create_category(&c, "Gasoline", "expense", None, None).expect("into");

        create_transaction(&c, &acct, "2026-08-01", "Shell", Some(from.id.as_str()), -4_250, None, None)
            .expect("txn");
        create_payee_rule(&c, "SHELL OIL", "Shell", Some(from.id.as_str()), &Default::default()).expect("rule");

        merge_categories(&c, &from.id, &into.id).expect("merge");

        let rule_cat: Option<String> = c
            .query_row("SELECT category_id FROM payee_rules", [], |r| r.get(0))
            .expect("rule row");
        assert_eq!(
            rule_cat.as_deref(),
            Some(into.id.as_str()),
            "the payee rule was silently defused — it now files to nothing"
        );
    }

    #[test]
    fn merging_folds_a_clashing_budget_month_instead_of_deleting_it() {
        let db = TestDb::new("cat-merge-budget-fold");
        let c = db.conn();
        let from = create_category(&c, "Fuel", "expense", None, None).expect("from");
        let into = create_category(&c, "Gasoline", "expense", None, None).expect("into");
        set_budget(&c, &from.id, 6_000, "2026-08").expect("from budget");
        set_budget(&c, &into.id, 9_000, "2026-08").expect("into budget");
        // A month only the source has, to prove the plain move still works.
        set_budget(&c, &from.id, 5_000, "2026-09").expect("from sept");

        merge_categories(&c, &from.id, &into.id).expect("merge");

        let aug = list_budgets(&c, "2026-08").expect("aug");
        assert_eq!(aug.len(), 1, "two rows for one category-month cannot exist");
        assert_eq!(
            aug[0].target_cents, 15_000,
            "the source's 60.00 was dropped by the cascade instead of folded in"
        );
        let sep = list_budgets(&c, "2026-09").expect("sep");
        assert_eq!(sep.len(), 1);
        assert_eq!(sep[0].category_id, into.id);
        assert_eq!(sep[0].target_cents, 5_000);
    }

    #[test]
    fn a_yearly_budget_folded_into_a_monthly_one_is_converted_first() {
        let db = TestDb::new("cat-merge-budget-period");
        let c = db.conn();
        let from = create_category(&c, "Auto Registration", "expense", None, None).expect("from");
        let into = create_category(&c, "Registration", "expense", None, None).expect("into");
        set_budget_line(&c, &from.id, 156_000, "2026-08", "yearly").expect("from budget");
        set_budget_line(&c, &into.id, 13_000, "2026-08", "monthly").expect("into budget");

        merge_categories(&c, &from.id, &into.id).expect("merge");

        let aug = list_budgets(&c, "2026-08").expect("aug");
        assert_eq!(aug.len(), 1);
        // 1,560.00 a year is 130.00 a month, added to the destination's 130.00.
        assert_eq!(
            aug[0].target_cents, 26_000,
            "a yearly figure was added to a monthly one without being converted"
        );
    }

    /// The whole point of an undoable merge: get the direction wrong, press Ctrl+Z, and
    /// the file is exactly where it was.
    #[test]
    fn undoing_a_merge_puts_the_category_and_everything_pointing_at_it_back() {
        let db = TestDb::new("cat-merge-undo");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        let auto = create_category(&c, "Automobile", "expense", None, None).expect("parent");
        let from = create_category(&c, "Fuel", "expense", Some(auto.id.as_str()), None).expect("from");
        let into = create_category(&c, "Gasoline", "expense", Some(auto.id.as_str()), None).expect("into");

        let txn = create_transaction(
            &c, &acct, "2026-08-01", "Shell", Some(from.id.as_str()), -4_250, None, None,
        )
        .expect("txn");
        create_payee_rule(&c, "SHELL OIL", "Shell", Some(from.id.as_str()), &Default::default()).expect("rule");
        set_budget(&c, &from.id, 6_000, "2026-08").expect("from budget");
        set_budget(&c, &into.id, 9_000, "2026-08").expect("into budget");

        let step = merge_categories(&c, &from.id, &into.id).expect("merge");
        assert!(get_category(&c, &from.id).is_err(), "the source survived the merge");

        crate::db::undo::restore(&c, &step.before, &[]).expect("undo");

        let back = get_category(&c, &from.id).expect("the source category did not come back");
        assert_eq!(back.name, "Fuel");
        assert_eq!(back.parent_id.as_deref(), Some(auto.id.as_str()), "it came back at the wrong level");

        let cat: Option<String> = c
            .query_row("SELECT category_id FROM transactions WHERE id = ?1", params![txn.id], |r| r.get(0))
            .expect("txn row");
        assert_eq!(cat.as_deref(), Some(from.id.as_str()), "the transaction stayed merged");

        let rule: Option<String> = c
            .query_row("SELECT category_id FROM payee_rules", [], |r| r.get(0))
            .expect("rule row");
        assert_eq!(rule.as_deref(), Some(from.id.as_str()), "the payee rule stayed merged");

        let aug = list_budgets(&c, "2026-08").expect("aug");
        assert_eq!(aug.len(), 2, "the folded budget month did not come back apart");
        let mut by_cat: Vec<(String, i64)> =
            aug.iter().map(|b| (b.category_id.clone(), b.target_cents)).collect();
        by_cat.sort();
        let mut want = vec![(from.id.clone(), 6_000), (into.id.clone(), 9_000)];
        want.sort();
        assert_eq!(by_cat, want, "the amounts came back wrong");
    }

    #[test]
    fn redoing_a_merge_lands_where_the_merge_did() {
        let db = TestDb::new("cat-merge-redo");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        let from = create_category(&c, "Fuel", "expense", None, None).expect("from");
        let into = create_category(&c, "Gasoline", "expense", None, None).expect("into");
        let txn = create_transaction(
            &c, &acct, "2026-08-01", "Shell", Some(from.id.as_str()), -4_250, None, None,
        )
        .expect("txn");
        set_budget(&c, &from.id, 6_000, "2026-08").expect("from budget");
        set_budget(&c, &into.id, 9_000, "2026-08").expect("into budget");

        let step = merge_categories(&c, &from.id, &into.id).expect("merge");
        crate::db::undo::restore(&c, &step.before, &[]).expect("undo");
        crate::db::undo::restore(&c, &step.after, &[]).expect("redo");

        assert!(get_category(&c, &from.id).is_err(), "the source is back after a redo");
        let cat: Option<String> = c
            .query_row("SELECT category_id FROM transactions WHERE id = ?1", params![txn.id], |r| r.get(0))
            .expect("txn row");
        assert_eq!(cat.as_deref(), Some(into.id.as_str()));
        let aug = list_budgets(&c, "2026-08").expect("aug");
        assert_eq!(aug.len(), 1);
        assert_eq!(aug[0].target_cents, 15_000);
    }

    /// Undo has to survive being run twice in a row without the second run
    /// doubling anything — the dialog is not the only way in, Ctrl+Z is.
    #[test]
    fn undo_then_redo_then_undo_settles_in_the_same_place() {
        let db = TestDb::new("cat-merge-cycle");
        let c = db.conn();
        let from = create_category(&c, "Fuel", "expense", None, None).expect("from");
        let into = create_category(&c, "Gasoline", "expense", None, None).expect("into");
        set_budget(&c, &from.id, 6_000, "2026-08").expect("from budget");
        set_budget(&c, &into.id, 9_000, "2026-08").expect("into budget");

        let step = merge_categories(&c, &from.id, &into.id).expect("merge");
        for _ in 0..2 {
            crate::db::undo::restore(&c, &step.before, &[]).expect("undo");
            crate::db::undo::restore(&c, &step.after, &[]).expect("redo");
        }
        crate::db::undo::restore(&c, &step.before, &[]).expect("final undo");

        let aug = list_budgets(&c, "2026-08").expect("aug");
        assert_eq!(aug.len(), 2, "cycling produced {} budget rows", aug.len());
        assert_eq!(aug.iter().map(|b| b.target_cents).sum::<i64>(), 15_000);
        assert!(get_category(&c, &from.id).is_ok());
    }

    /// The order inside `undo::Snapshot` exists for this case, and nothing
    /// else in the suite reaches it.
    ///
    /// `Auto : Insurance` alongside a top-level `Insurance` is the standard
    /// chart's own shape. Redo has to move the child to the destination BEFORE
    /// deleting `Auto` — delete first and `ON DELETE SET NULL` drops the child
    /// to top level, where it collides with the `Insurance` already there and
    /// SQLite refuses the delete.
    #[test]
    fn redo_moves_the_children_before_deleting_the_parent_they_hung_off() {
        let db = TestDb::new("cat-merge-redo-children");
        let c = db.conn();
        create_category(&c, "Insurance", "expense", None, None).expect("top-level Insurance");
        let from = create_category(&c, "Auto", "expense", None, None).expect("from");
        let into = create_category(&c, "Automobile", "expense", None, None).expect("into");
        let child =
            create_category(&c, "Insurance", "expense", Some(from.id.as_str()), None).expect("child");

        let step = merge_categories(&c, &from.id, &into.id).expect("merge");
        crate::db::undo::restore(&c, &step.before, &[]).expect("undo");
        assert_eq!(
            get_category(&c, &child.id).expect("child").parent_id.as_deref(),
            Some(from.id.as_str()),
            "undo left the child under the wrong parent"
        );

        crate::db::undo::restore(&c, &step.after, &[]).expect("redo must not trip the name index");
        assert_eq!(
            get_category(&c, &child.id).expect("child").parent_id.as_deref(),
            Some(into.id.as_str())
        );
        assert!(get_category(&c, &from.id).is_err(), "the source survived the redo");
        // The unrelated top-level Insurance is untouched throughout.
        assert_eq!(
            list_categories(&c)
                .expect("list")
                .iter()
                .filter(|x| x.name == "Insurance")
                .count(),
            2
        );
    }

    #[test]
    fn the_preview_counts_what_the_merge_will_touch_and_names_a_refusal() {
        let db = TestDb::new("cat-merge-preview");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        let from = create_category(&c, "Fuel", "expense", None, None).expect("from");
        let into = create_category(&c, "Gasoline", "expense", None, None).expect("into");
        create_transaction(&c, &acct, "2026-08-01", "Shell", Some(from.id.as_str()), -4_250, None, None)
            .expect("txn");
        create_payee_rule(&c, "SHELL OIL", "Shell", Some(from.id.as_str()), &Default::default()).expect("rule");
        set_budget(&c, &from.id, 6_000, "2026-08").expect("from budget");
        set_budget(&c, &into.id, 9_000, "2026-08").expect("into budget");
        set_budget(&c, &from.id, 5_000, "2026-09").expect("from sept");

        let p = preview_merge(&c, &from.id, &into.id).expect("preview");
        assert!(p.blocked.is_none());
        assert_eq!(p.transactions, 1);
        assert_eq!(p.payee_rules, 1);
        assert_eq!(p.budgets, 2, "both budgeted months should be counted");
        assert_eq!(p.budgets_folded, 1, "only August clashes");
        assert_eq!(p.children, 0);

        // Nothing was written by asking.
        assert!(get_category(&c, &from.id).is_ok());

        let same = preview_merge(&c, &from.id, &from.id).expect("preview self");
        assert!(same.blocked.is_some(), "merging into itself must be refused up front");
    }

    #[test]
    fn renaming_a_category_keeps_its_budget() {
        let db = TestDb::new("cat-rename-budget");
        let c = db.conn();
        let cat = create_category(&c, "Groceries", "expense", None, None).expect("cat");
        set_budget(&c, &cat.id, 40_000, "2026-08").expect("budget");

        // Budgets were keyed by NAME before migration 0014, so this used to
        // orphan the budget silently.
        update_category(&c, &cat.id, "Food", "expense", None, None).expect("rename");

        let budgets = list_budgets(&c, "2026-08").expect("budgets");
        assert_eq!(budgets.len(), 1);
        assert_eq!(budgets[0].category_name, "Food");
        assert_eq!(budgets[0].target_cents, 40_000);
    }

    // -----------------------------------------------------------------------
    // What the review found
    // -----------------------------------------------------------------------

    #[test]
    fn a_refused_category_delete_leaves_every_transaction_filed_where_it_was() {
        // The clash check used to run AFTER the refile, so a refused delete
        // had already uncategorized everything and then said it had not.
        let db = TestDb::new("cat-delete-atomic");
        let c = db.conn();
        let acct = account(&c, "Checking", 0);
        let auto = create_category(&c, "Automobile", "expense", None, None).expect("auto");
        let ins_child =
            create_category(&c, "Insurance", "expense", Some(&auto.id), None).expect("child");
        create_category(&c, "Insurance", "expense", None, None).expect("top-level twin");
        let txn = create_transaction(
            &c, &acct, "2026-08-01", "Allstate", Some(auto.id.as_str()), -12_000, None, None,
        )
        .expect("txn");

        let err = delete_category(&c, &auto.id, None).expect_err("must be refused");
        assert!(err.contains("Insurance"), "{err}");

        let cat: Option<String> = c
            .query_row(
                "SELECT category_id FROM transactions WHERE id = ?1",
                params![txn.id],
                |r| r.get(0),
            )
            .expect("row");
        assert_eq!(cat.as_deref(), Some(auto.id.as_str()), "the refused delete refiled the row");
        assert_eq!(get_category(&c, &ins_child.id).expect("child").parent_id.as_deref(), Some(auto.id.as_str()));
    }

    // A category typed as "loan:heloc" is the same category as
    // "Loan : HELOC". The path lookup folds case at both levels, so an import
    // whose file spells a name differently from the file's chart does not
    // grow a duplicate.
    #[test]
    fn ensure_category_path_folds_case_at_both_levels() {
        let db = TestDb::new("catcase");
        let c = db.conn();
        let heloc = ensure_category_path(&c, "Loan : HELOC").unwrap();
        assert_eq!(ensure_category_path(&c, "loan:heloc").unwrap(), heloc);
        assert_eq!(ensure_category_path(&c, "LOAN : Heloc ").unwrap(), heloc);
        let loan = ensure_category(&c, "loan").unwrap();
        let (parent, n): (Option<String>, i64) = c
            .query_row(
                "SELECT (SELECT parent_id FROM categories WHERE id = ?1), (SELECT COUNT(*) FROM categories)",
                params![heloc],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(parent.as_deref(), Some(loan.as_str()));
        assert_eq!(n, 2, "one parent, one child, and no duplicates");
    }

    // ── Year plans and deleting into another category ────────────────────

    /// `merge_categories` never knew `budget_plans` existed: the source's
    /// year plan was cascaded away with it, and undo could not bring it back.
    #[test]
    fn a_merge_folds_the_year_plan_and_undo_takes_the_fold_apart() {
        use crate::db::plan::{self, ASIDE, EVERY_MONTH, SPENT};
        let db = TestDb::new("cat-merge-plans");
        let c = db.conn();
        let auto = create_category(&c, "Automobile", "expense", None, None).unwrap().id;
        let fuel = create_category(&c, "Fuel", "expense", Some(&auto), None).unwrap().id;
        let gas = create_category(&c, "Gasoline", "expense", Some(&auto), None).unwrap().id;
        plan::set_plan(&c, &fuel, 2027, 120_000, EVERY_MONTH, SPENT).unwrap();
        plan::set_plan(&c, &gas, 2027, 60_000, "111111000000", SPENT).unwrap();
        plan::set_plan(&c, &fuel, 2028, 240_000, EVERY_MONTH, ASIDE).unwrap();
        let auto_before = plan_row(&c, &auto, 2027).expect("the envelope rule gave Automobile a plan");
        assert_eq!(budget_of(&c, &fuel, "2027-07"), Some(10_000));
        assert_eq!(budget_of(&c, &gas, "2027-07"), None, "Gasoline runs January to June");

        let step = merge_categories(&c, &fuel, &gas).unwrap();

        // Both years planned: one line, the sum over the union of the months,
        // in the destination's reading, every figure still asked for.
        assert_eq!(plan_row(&c, &gas, 2027), Some((180_000, EVERY_MONTH.to_string(), SPENT.to_string(), Some(180_000))));
        // Only the source planned 2028: re-pointed as it was.
        assert_eq!(plan_row(&c, &gas, 2028), Some((240_000, EVERY_MONTH.to_string(), ASIDE.to_string(), Some(240_000))));
        assert_eq!(plan_row(&c, &fuel, 2027), None);
        // The monthly rows follow the plan, and the parent still covers it.
        assert_eq!(budget_of(&c, &gas, "2027-07"), Some(15_000));
        assert_eq!(budget_of(&c, &gas, "2028-03"), Some(20_000));
        assert!(budget_of(&c, &auto, "2027-07").unwrap() > 15_000);
        assert!(verify_file(&c, false).unwrap().foreign_keys.is_empty());

        crate::db::undo::restore(&c, &step.before, &[]).unwrap();
        assert_eq!(plan_row(&c, &fuel, 2027), Some((120_000, EVERY_MONTH.to_string(), SPENT.to_string(), Some(120_000))));
        assert_eq!(plan_row(&c, &fuel, 2028).map(|p| p.2), Some(ASIDE.to_string()));
        assert_eq!(plan_row(&c, &gas, 2027), Some((60_000, "111111000000".to_string(), SPENT.to_string(), Some(60_000))));
        assert_eq!(plan_row(&c, &gas, 2028), None);
        assert_eq!(plan_row(&c, &auto, 2027), Some(auto_before));
        assert_eq!(budget_of(&c, &fuel, "2027-07"), Some(10_000));
        assert_eq!(budget_of(&c, &gas, "2027-07"), None);
        assert_eq!(budget_of(&c, &gas, "2027-01"), Some(10_000));

        crate::db::undo::restore(&c, &step.after, &[]).unwrap();
        assert!(get_category(&c, &fuel).is_err());
        assert_eq!(plan_row(&c, &gas, 2027).map(|p| p.0), Some(180_000));
        assert_eq!(budget_of(&c, &gas, "2027-07"), Some(15_000));
        assert!(verify_file(&c, false).unwrap().foreign_keys.is_empty());
    }

    /// A delete with a target refiled four things and let `ON DELETE`
    /// have the rest; it now does everything a merge does, keeps its promise
    /// to promote the children, and can be undone.
    #[test]
    fn deleting_a_category_into_another_refiles_everything_a_merge_would_and_undo_puts_it_back() {
        use crate::db::plan::{self, EVERY_MONTH, SPENT};
        let db = TestDb::new("cat-delete-reassign");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        let fuel = create_category(&c, "Fuel", "expense", None, None).unwrap().id;
        let diesel = create_category(&c, "Diesel", "expense", Some(&fuel), None).unwrap().id;
        let gas = create_category(&c, "Gasoline", "expense", None, None).unwrap().id;
        let txn = create_transaction(&c, &acct, "2026-08-01", "Shell", Some(&fuel), -4_250, None, None).unwrap();
        create_payee_rule(&c, "SHELL OIL", "Shell", Some(&fuel), &Default::default()).unwrap();
        let rec = create_recurrence(&c, &NewRecurrence { category_id: Some(fuel.clone()), ..bill(&acct, "Fuel card", -8_000, "2026-09-01") }).unwrap();
        let common = create_common_transaction(&c, &NewCommonTransaction { category_id: Some(fuel.clone()), ..template("Fill up") }).unwrap();
        set_budget(&c, &fuel, 6_000, "2026-08").unwrap();
        set_budget(&c, &gas, 9_000, "2026-08").unwrap();
        plan::set_plan(&c, &fuel, 2027, 120_000, EVERY_MONTH, SPENT).unwrap();

        let cat_of = |sql: &str, id: &str| -> Option<String> { c.query_row(sql, params![id], |r| r.get(0)).unwrap() };
        let rule_cat = || -> Option<String> { c.query_row("SELECT category_id FROM payee_rules", [], |r| r.get(0)).unwrap() };

        let step = delete_category(&c, &fuel, Some(&gas)).unwrap();
        assert!(get_category(&c, &fuel).is_err());
        assert_eq!(cat_of("SELECT category_id FROM transactions WHERE id = ?1", &txn.id).as_deref(), Some(gas.as_str()));
        assert_eq!(rule_cat().as_deref(), Some(gas.as_str()), "the payee rule was defused");
        assert_eq!(cat_of("SELECT category_id FROM recurrences WHERE id = ?1", &rec.id).as_deref(), Some(gas.as_str()));
        assert_eq!(cat_of("SELECT category_id FROM common_transactions WHERE id = ?1", &common.id).as_deref(), Some(gas.as_str()));
        assert_eq!(get_category(&c, &diesel).unwrap().parent_id, None, "a delete promotes the children");
        let aug = list_budgets(&c, "2026-08").unwrap();
        assert_eq!(aug.len(), 1);
        assert_eq!(aug[0].target_cents, 15_000, "the month both had was dropped instead of folded");
        assert_eq!(plan_row(&c, &gas, 2027).map(|p| p.0), Some(120_000), "the year plan was cascaded away");
        assert_eq!(budget_of(&c, &gas, "2027-01"), Some(10_000));

        crate::db::undo::restore(&c, &step.before, &[]).unwrap();
        assert_eq!(get_category(&c, &fuel).unwrap().name, "Fuel");
        assert_eq!(get_category(&c, &diesel).unwrap().parent_id.as_deref(), Some(fuel.as_str()));
        assert_eq!(cat_of("SELECT category_id FROM transactions WHERE id = ?1", &txn.id).as_deref(), Some(fuel.as_str()));
        assert_eq!(rule_cat().as_deref(), Some(fuel.as_str()));
        assert_eq!(cat_of("SELECT category_id FROM recurrences WHERE id = ?1", &rec.id).as_deref(), Some(fuel.as_str()));
        assert_eq!(cat_of("SELECT category_id FROM common_transactions WHERE id = ?1", &common.id).as_deref(), Some(fuel.as_str()));
        assert_eq!((budget_of(&c, &fuel, "2026-08"), budget_of(&c, &gas, "2026-08")), (Some(6_000), Some(9_000)));
        assert_eq!(plan_row(&c, &fuel, 2027).map(|p| p.0), Some(120_000));
        assert_eq!((budget_of(&c, &fuel, "2027-01"), budget_of(&c, &gas, "2027-01")), (Some(10_000), None));

        crate::db::undo::restore(&c, &step.after, &[]).unwrap();
        assert!(get_category(&c, &fuel).is_err());
        assert_eq!(get_category(&c, &diesel).unwrap().parent_id, None);
        assert_eq!(rule_cat().as_deref(), Some(gas.as_str()));
        assert!(verify_file(&c, false).unwrap().foreign_keys.is_empty());
    }

    #[test]
    fn deleting_a_category_outright_uncategorizes_as_before_and_can_be_undone() {
        use crate::db::plan::{self, EVERY_MONTH, SPENT};
        let db = TestDb::new("cat-delete-none");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        let fuel = create_category(&c, "Fuel", "expense", None, None).unwrap().id;
        let txn = create_transaction(&c, &acct, "2026-08-01", "Shell", Some(&fuel), -4_250, None, None).unwrap();
        create_payee_rule(&c, "SHELL OIL", "Shell", Some(&fuel), &Default::default()).unwrap();
        plan::set_plan(&c, &fuel, 2027, 120_000, EVERY_MONTH, SPENT).unwrap();

        let step = delete_category(&c, &fuel, None).unwrap();
        let txn_cat: Option<String> = c.query_row("SELECT category_id FROM transactions WHERE id = ?1", params![txn.id], |r| r.get(0)).unwrap();
        assert_eq!(txn_cat, None);
        assert_eq!(plan_row(&c, &fuel, 2027), None);
        assert!(list_budgets(&c, "2027-01").unwrap().is_empty());

        crate::db::undo::restore(&c, &step.before, &[]).unwrap();
        let txn_cat: Option<String> = c.query_row("SELECT category_id FROM transactions WHERE id = ?1", params![txn.id], |r| r.get(0)).unwrap();
        assert_eq!(txn_cat.as_deref(), Some(fuel.as_str()));
        let rule_cat: Option<String> = c.query_row("SELECT category_id FROM payee_rules", [], |r| r.get(0)).unwrap();
        assert_eq!(rule_cat.as_deref(), Some(fuel.as_str()));
        assert_eq!(plan_row(&c, &fuel, 2027).map(|p| p.0), Some(120_000));
        assert_eq!(budget_of(&c, &fuel, "2027-01"), Some(10_000));
    }

    /// Reassigning keeps the merge's same-kind rule, in both directions.
    #[test]
    fn deleting_a_category_into_one_of_the_other_kind_is_refused() {
        let db = TestDb::new("cat-delete-kind");
        let c = db.conn();
        let acct = account(&c, "Checking", 100_000);
        let earned = create_category(&c, "Interest Earned", "income", None, None).unwrap().id;
        let paid = create_category(&c, "Interest Paid", "expense", None, None).unwrap().id;
        let txn = create_transaction(&c, &acct, "2026-08-01", "Bank", Some(&earned), 125, None, None).unwrap();

        let err = delete_category(&c, &earned, Some(&paid)).unwrap_err();
        assert!(err.contains("money you received as money you spent"), "{err}");
        let err = delete_category(&c, &paid, Some(&earned)).unwrap_err();
        assert!(err.contains("money you spent as money you received"), "{err}");
        let still: Option<String> = c.query_row("SELECT category_id FROM transactions WHERE id = ?1", params![txn.id], |r| r.get(0)).unwrap();
        assert_eq!(still.as_deref(), Some(earned.as_str()), "a refused delete writes nothing");
    }
}
