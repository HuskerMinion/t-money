//! §112 — classifications: Money's second tagging axis, made general.
//!
//! A category says what KIND of money a line is (Repairs, Utilities). A
//! classification says what it was FOR (the Maple Street house, the Pickup, the
//! kitchen remodel). The two are orthogonal: "what did the Maple Street house cost
//! me last year" is every category, one classification value — and without
//! this axis the only ways to answer it are a cross product in the category
//! tree or a convention in the memo field.
//!
//! Shape (migration 0035): `classifications` are the axes ("Property"),
//! `classification_values` their values one sub-level deep ("Maple Street house"
//! → "Roof 2026"), and `transaction_classes` the links — one per line per
//! axis, keyed on the transaction, or on a split line when that line carries
//! its own value. A split line without one INHERITS the transaction's.
//!
//! Money's three limits, deliberately not repeated: exactly two axes; a value
//! that can never be deleted once used; and reports that honor the axis
//! inconsistently. Here an axis is a row, deleting drops links after the UI
//! has said how many, and the report scope (§113) reads the same effective
//! value every report does.

use crate::db::queries::Conn;
use crate::models::{ClassPick, Classification, ClassificationValue};
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ---------------------------------------------------------------------------
// Axes
// ---------------------------------------------------------------------------

/// Every axis with its values, in sort order then name. The values carry
/// `full_name` ("Parent : Child") and a usage count, so the manager can warn
/// before a delete and the pickers can show the path.
pub fn list_classifications(conn: &Conn) -> Result<Vec<Classification>, String> {
    let mut st = conn
        .prepare(
            "SELECT c.id, c.name, c.sort_order,
                    (SELECT COUNT(*) FROM transaction_classes x WHERE x.classification_id = c.id)
               FROM classifications c
              ORDER BY c.sort_order, c.name COLLATE NOCASE",
        )
        .map_err(err)?;
    let axes: Vec<(String, String, i64, i64)> = st
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .map_err(err)?
        .collect::<Result<_, _>>()
        .map_err(err)?;
    let mut vs = conn
        .prepare(
            "SELECT v.id, v.classification_id, v.parent_id, v.name,
                    CASE WHEN p.name IS NULL THEN v.name ELSE p.name || ' : ' || v.name END,
                    (SELECT COUNT(*) FROM transaction_classes x
                      WHERE x.value_id = v.id
                         OR x.value_id IN (SELECT id FROM classification_values k WHERE k.parent_id = v.id))
               FROM classification_values v
               LEFT JOIN classification_values p ON p.id = v.parent_id
              WHERE v.classification_id = ?1
              ORDER BY COALESCE(p.name, v.name) COLLATE NOCASE, p.name IS NOT NULL, v.name COLLATE NOCASE",
        )
        .map_err(err)?;
    let mut out = Vec::with_capacity(axes.len());
    for (id, name, sort_order, usage_count) in axes {
        let values: Vec<ClassificationValue> = vs
            .query_map(params![id], |r| {
                Ok(ClassificationValue {
                    id: r.get(0)?,
                    classification_id: r.get(1)?,
                    parent_id: r.get(2)?,
                    name: r.get(3)?,
                    full_name: r.get(4)?,
                    usage_count: r.get(5)?,
                })
            })
            .map_err(err)?
            .collect::<Result<_, _>>()
            .map_err(err)?;
        out.push(Classification { id, name, sort_order, usage_count, values });
    }
    Ok(out)
}

fn clean_name(name: &str, what: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err(format!("a {what} needs a name"));
    }
    if n.contains(':') {
        // The colon is the "Parent : Child" separator everywhere in the app.
        return Err(format!("a {what} name cannot contain ':'"));
    }
    Ok(n.to_string())
}

pub fn create_classification(conn: &Conn, name: &str) -> Result<Classification, String> {
    let name = clean_name(name, "classification")?;
    let id = Uuid::new_v4().to_string();
    let next: i64 = conn
        .query_row("SELECT COALESCE(MAX(sort_order), -1) + 1 FROM classifications", [], |r| r.get(0))
        .map_err(err)?;
    conn.execute(
        "INSERT INTO classifications (id, name, sort_order) VALUES (?1, ?2, ?3)",
        params![id, name, next],
    )
    .map_err(|e| {
        if e.to_string().contains("UNIQUE") {
            format!("there is already a classification named \"{name}\"")
        } else {
            e.to_string()
        }
    })?;
    find_axis(conn, &id)
}

pub fn rename_classification(conn: &Conn, id: &str, name: &str) -> Result<Classification, String> {
    let name = clean_name(name, "classification")?;
    let n = conn
        .execute("UPDATE classifications SET name = ?2 WHERE id = ?1", params![id, name])
        .map_err(|e| {
            if e.to_string().contains("UNIQUE") {
                format!("there is already a classification named \"{name}\"")
            } else {
                e.to_string()
            }
        })?;
    if n == 0 {
        return Err(format!("classification {id} not found"));
    }
    find_axis(conn, id)
}

/// Delete an axis, its values and every link to them. Returns how many links
/// were dropped — the UI asks first, with `usage_count`.
pub fn delete_classification(conn: &Conn, id: &str) -> Result<i64, String> {
    let dropped: i64 = conn
        .query_row("SELECT COUNT(*) FROM transaction_classes WHERE classification_id = ?1", params![id], |r| r.get(0))
        .map_err(err)?;
    let n = conn.execute("DELETE FROM classifications WHERE id = ?1", params![id]).map_err(err)?;
    if n == 0 {
        return Err(format!("classification {id} not found"));
    }
    Ok(dropped)
}

fn find_axis(conn: &Conn, id: &str) -> Result<Classification, String> {
    list_classifications(conn)?
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| format!("classification {id} not found"))
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

pub fn create_classification_value(
    conn: &Conn,
    classification_id: &str,
    name: &str,
    parent_id: Option<&str>,
) -> Result<ClassificationValue, String> {
    let name = clean_name(name, "classification value")?;
    let parent_id = parent_id.filter(|p| !p.is_empty());
    if let Some(p) = parent_id {
        // One level deep, as Money's were, and under the same axis.
        let (axis, grand): (String, Option<String>) = conn
            .query_row("SELECT classification_id, parent_id FROM classification_values WHERE id = ?1", params![p], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
            .map_err(err)?
            .ok_or_else(|| format!("parent value {p} not found"))?;
        if axis != classification_id {
            return Err("a sub-value must belong to the same classification as its parent".to_string());
        }
        if grand.is_some() {
            return Err("classification values go one level deep — a sub-value cannot have its own".to_string());
        }
    }
    let dup: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM classification_values
              WHERE classification_id = ?1 AND lower(name) = lower(?2) AND COALESCE(parent_id, '') = COALESCE(?3, '')",
            params![classification_id, name, parent_id],
            |r| r.get(0),
        )
        .map_err(err)?;
    if dup > 0 {
        return Err(format!("there is already a value named \"{name}\" there"));
    }
    let id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO classification_values (id, classification_id, parent_id, name) VALUES (?1, ?2, ?3, ?4)",
        params![id, classification_id, parent_id, name],
    )
    .map_err(|e| {
        if e.to_string().contains("FOREIGN KEY") {
            format!("classification {classification_id} not found")
        } else {
            e.to_string()
        }
    })?;
    find_value(conn, &id)
}

pub fn rename_classification_value(conn: &Conn, id: &str, name: &str) -> Result<ClassificationValue, String> {
    let name = clean_name(name, "classification value")?;
    // §180: the same rule as creating one, which a rename walked straight
    // past — two "Maple"s under one axis are two picks nobody can tell
    // apart, and a report that groups by value splits one house in two. The
    // value's own row is left out, so changing only its capitals is allowed.
    let dup: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM classification_values o
               JOIN classification_values me ON me.id = ?1
              WHERE o.id <> me.id AND o.classification_id = me.classification_id
                AND lower(o.name) = lower(?2) AND COALESCE(o.parent_id, '') = COALESCE(me.parent_id, '')",
            params![id, name],
            |r| r.get(0),
        )
        .map_err(err)?;
    if dup > 0 {
        return Err(format!("there is already a value named \"{name}\" there"));
    }
    let n = conn
        .execute("UPDATE classification_values SET name = ?2 WHERE id = ?1", params![id, name])
        .map_err(err)?;
    if n == 0 {
        return Err(format!("classification value {id} not found"));
    }
    find_value(conn, id)
}

/// Delete a value (and its sub-values) with every link to them. Returns the
/// number of links dropped.
pub fn delete_classification_value(conn: &Conn, id: &str) -> Result<i64, String> {
    let dropped: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM transaction_classes
              WHERE value_id = ?1 OR value_id IN (SELECT id FROM classification_values WHERE parent_id = ?1)",
            params![id],
            |r| r.get(0),
        )
        .map_err(err)?;
    let n = conn.execute("DELETE FROM classification_values WHERE id = ?1", params![id]).map_err(err)?;
    if n == 0 {
        return Err(format!("classification value {id} not found"));
    }
    Ok(dropped)
}

fn find_value(conn: &Conn, id: &str) -> Result<ClassificationValue, String> {
    let axis: String = conn
        .query_row("SELECT classification_id FROM classification_values WHERE id = ?1", params![id], |r| r.get(0))
        .optional()
        .map_err(err)?
        .ok_or_else(|| format!("classification value {id} not found"))?;
    find_axis(conn, &axis)?
        .values
        .into_iter()
        .find(|v| v.id == id)
        .ok_or_else(|| format!("classification value {id} not found"))
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/// Write one line's picks, replacing whatever it had on those axes. A pick
/// with an empty `value_id` clears its axis. Runs inside the caller's
/// transaction when it has one (`set_splits`), or on the connection.
pub(crate) fn write_line_classes(
    conn: &Connection,
    transaction_id: &str,
    split_id: Option<&str>,
    picks: &[ClassPick],
) -> Result<(), String> {
    for p in picks {
        conn.execute(
            "DELETE FROM transaction_classes
              WHERE transaction_id = ?1 AND COALESCE(split_id, '') = COALESCE(?2, '') AND classification_id = ?3",
            params![transaction_id, split_id, p.classification_id],
        )
        .map_err(err)?;
        if p.value_id.is_empty() {
            continue;
        }
        // The value must belong to the axis it is filed under, or a report
        // grouping on the axis would show a value from another one.
        let axis: Option<String> = conn
            .query_row("SELECT classification_id FROM classification_values WHERE id = ?1", params![p.value_id], |r| r.get(0))
            .optional()
            .map_err(err)?;
        match axis {
            None => return Err(format!("classification value {} not found", p.value_id)),
            Some(a) if a != p.classification_id => {
                return Err("that value belongs to a different classification".to_string());
            }
            _ => {}
        }
        conn.execute(
            "INSERT INTO transaction_classes (transaction_id, split_id, classification_id, value_id)
             VALUES (?1, ?2, ?3, ?4)",
            params![transaction_id, split_id, p.classification_id, p.value_id],
        )
        .map_err(err)?;
    }
    Ok(())
}

/// Set a TRANSACTION's values — the same on both halves of a transfer, so
/// the axis follows the money wherever it is looked at from.
pub fn set_transaction_classes(conn: &Conn, transaction_id: &str, picks: &[ClassPick]) -> Result<Vec<ClassPick>, String> {
    let transfer: Option<String> = conn
        .query_row("SELECT transfer_id FROM transactions WHERE id = ?1", params![transaction_id], |r| r.get(0))
        .optional()
        .map_err(err)?
        .ok_or_else(|| format!("transaction {transaction_id} not found"))?;
    let tx = conn.unchecked_transaction().map_err(err)?;
    write_line_classes(&tx, transaction_id, None, picks)?;
    if let Some(other) = transfer.as_deref() {
        write_line_classes(&tx, other, None, picks)?;
    }
    tx.commit().map_err(err)?;
    transaction_classes(conn, transaction_id)
}

/// A transaction's own picks (not a split line's), with labels.
pub fn transaction_classes(conn: &Connection, transaction_id: &str) -> Result<Vec<ClassPick>, String> {
    line_classes(conn, transaction_id, None)
}

pub(crate) fn line_classes(conn: &Connection, transaction_id: &str, split_id: Option<&str>) -> Result<Vec<ClassPick>, String> {
    let mut st = conn
        .prepare(
            "SELECT x.classification_id, x.value_id,
                    CASE WHEN p.name IS NULL THEN v.name ELSE p.name || ' : ' || v.name END
               FROM transaction_classes x
               JOIN classification_values v ON v.id = x.value_id
               LEFT JOIN classification_values p ON p.id = v.parent_id
               JOIN classifications c ON c.id = x.classification_id
              WHERE x.transaction_id = ?1 AND COALESCE(x.split_id, '') = COALESCE(?2, '')
              ORDER BY c.sort_order, c.name COLLATE NOCASE",
        )
        .map_err(err)?;
    let out = st
        .query_map(params![transaction_id, split_id], |r| {
            Ok(ClassPick { classification_id: r.get(0)?, value_id: r.get(1)?, label: r.get(2)? })
        })
        .map_err(err)?
        .collect::<Result<_, _>>()
        .map_err(err)?;
    Ok(out)
}

/// Every transaction-level pick in one account, keyed by transaction id —
/// one query for the whole register rather than one per row.
pub(crate) fn classes_by_transaction(conn: &Connection, account_id: &str) -> Result<std::collections::HashMap<String, Vec<ClassPick>>, String> {
    let mut st = conn
        .prepare(
            "SELECT x.transaction_id, x.classification_id, x.value_id,
                    CASE WHEN p.name IS NULL THEN v.name ELSE p.name || ' : ' || v.name END
               FROM transaction_classes x
               JOIN transactions t ON t.id = x.transaction_id
               JOIN classification_values v ON v.id = x.value_id
               LEFT JOIN classification_values p ON p.id = v.parent_id
               JOIN classifications c ON c.id = x.classification_id
              WHERE t.account_id = ?1 AND x.split_id IS NULL
              ORDER BY c.sort_order, c.name COLLATE NOCASE",
        )
        .map_err(err)?;
    let mut out: std::collections::HashMap<String, Vec<ClassPick>> = std::collections::HashMap::new();
    let rows = st
        .query_map(params![account_id], |r| {
            Ok((r.get::<_, String>(0)?, ClassPick { classification_id: r.get(1)?, value_id: r.get(2)?, label: r.get(3)? }))
        })
        .map_err(err)?;
    for row in rows {
        let (id, pick) = row.map_err(err)?;
        out.entry(id).or_default().push(pick);
    }
    Ok(out)
}

/// §117.3 — what a transaction's SPLIT LINES say, for the rows where the
/// transaction itself carries nothing.
///
/// The register row has always shown `split_id IS NULL` values — the
/// transaction's own — which is right for what it is and wrong for what it
/// looks like: a mortgage payment split into principal, interest and escrow,
/// with all three lines tagged to a house, showed NOTHING on its row and
/// "(none)" in its field. Reported as tagging that would not stick, which is
/// exactly how it reads.
///
/// Per axis: the one value every tagged line agrees on, or a marker with an
/// empty `value_id` when they differ (a receipt split across two houses is a
/// real thing to say, and saying "Maple" would be a lie). Axes the
/// transaction itself carries are left out — the caller already has those.
pub(crate) fn line_classes_by_transaction(
    conn: &Connection,
    account_id: &str,
) -> Result<std::collections::HashMap<String, Vec<ClassPick>>, String> {
    let mut st = conn
        .prepare(
            "SELECT x.transaction_id,
                    x.classification_id,
                    COUNT(DISTINCT x.value_id),
                    MIN(x.value_id),
                    MIN(CASE WHEN p.name IS NULL THEN v.name ELSE p.name || ' : ' || v.name END)
               FROM transaction_classes x
               JOIN transactions t ON t.id = x.transaction_id
               JOIN classification_values v ON v.id = x.value_id
               LEFT JOIN classification_values p ON p.id = v.parent_id
               JOIN classifications c ON c.id = x.classification_id
              WHERE t.account_id = ?1
                AND x.split_id IS NOT NULL
                -- Only where the transaction itself says nothing on this
                -- axis; its own value wins and is shown by the caller.
                AND NOT EXISTS (
                      SELECT 1 FROM transaction_classes o
                       WHERE o.transaction_id = x.transaction_id
                         AND o.split_id IS NULL
                         AND o.classification_id = x.classification_id)
              GROUP BY x.transaction_id, x.classification_id
              ORDER BY c.sort_order, c.name COLLATE NOCASE",
        )
        .map_err(err)?;
    let mut out: std::collections::HashMap<String, Vec<ClassPick>> = std::collections::HashMap::new();
    let rows = st
        .query_map(params![account_id], |r| {
            let txn: String = r.get(0)?;
            let axis: String = r.get(1)?;
            let distinct: i64 = r.get(2)?;
            let value_id: String = r.get(3)?;
            let label: String = r.get(4)?;
            Ok((
                txn,
                if distinct == 1 {
                    ClassPick { classification_id: axis, value_id, label }
                } else {
                    ClassPick { classification_id: axis, value_id: String::new(), label: format!("{distinct} values") }
                },
            ))
        })
        .map_err(err)?;
    for row in rows {
        let (id, pick) = row.map_err(err)?;
        out.entry(id).or_default().push(pick);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::queries;
    use crate::models::NewSplit;

    // §182 — checked whole when the test ends.
    use crate::db::test_db::TestDb;

    fn pick(axis: &str, value: &str) -> ClassPick {
        ClassPick { classification_id: axis.into(), value_id: value.into(), label: String::new() }
    }

    #[test]
    fn axes_and_values_round_trip_with_full_names() {
        let db = TestDb::new("axes");
        let c = db.conn();
        let prop = create_classification(&c, " Property ").unwrap();
        assert_eq!(prop.name, "Property");
        assert!(create_classification(&c, "Property").is_err(), "duplicate axis name");
        let maple = create_classification_value(&c, &prop.id, "Maple Street house", None).unwrap();
        let roof = create_classification_value(&c, &prop.id, "Roof 2026", Some(&maple.id)).unwrap();
        assert_eq!(roof.full_name, "Maple Street house : Roof 2026");
        assert!(create_classification_value(&c, &prop.id, "Deeper", Some(&roof.id)).is_err(), "one level deep");
        assert!(create_classification_value(&c, &prop.id, "maple street HOUSE", None).is_err(), "duplicate name under the same parent");
        assert!(create_classification_value(&c, &prop.id, "A : B", None).is_err(), "no colon");
        let axes = list_classifications(&c).unwrap();
        assert_eq!(axes.len(), 1);
        assert_eq!(axes[0].values.iter().map(|v| v.full_name.as_str()).collect::<Vec<_>>(), vec!["Maple Street house", "Maple Street house : Roof 2026"]);
    }

    /// §180 — renaming is held to the rule creating is.
    #[test]
    fn a_rename_cannot_make_a_duplicate_but_can_change_its_own_capitals() {
        let db = TestDb::new("rename-dup");
        let c = db.conn();
        let prop = create_classification(&c, "Property").unwrap();
        let person = create_classification(&c, "Person").unwrap();
        let maple = create_classification_value(&c, &prop.id, "Maple", None).unwrap();
        let birch = create_classification_value(&c, &prop.id, "Birch Lane", None).unwrap();
        let roof = create_classification_value(&c, &prop.id, "Roof", Some(&maple.id)).unwrap();
        let _sam = create_classification_value(&c, &person.id, "Sam", None).unwrap();

        let err = rename_classification_value(&c, &birch.id, "MAPLE").unwrap_err();
        assert!(err.contains("already a value named"), "{err}");
        assert_eq!(find_value(&c, &birch.id).unwrap().name, "Birch Lane", "nothing was written");
        // Its own name in other capitals is not a duplicate of itself.
        assert_eq!(rename_classification_value(&c, &maple.id, "MAPLE").unwrap().name, "MAPLE");
        // The same name is fine under another parent or on another axis.
        assert_eq!(rename_classification_value(&c, &roof.id, "Birch Lane").unwrap().name, "Birch Lane");
        let other_axis = create_classification_value(&c, &person.id, "Pat", None).unwrap();
        assert_eq!(rename_classification_value(&c, &other_axis.id, "Birch Lane").unwrap().name, "Birch Lane");
        assert!(rename_classification_value(&c, "no-such-id", "Anything").unwrap_err().contains("not found"));
    }

    #[test]
    fn a_transaction_carries_one_value_per_axis_and_a_transfer_shares_it() {
        let db = TestDb::new("links");
        let c = db.conn();
        let chk = queries::create_account(&c, "Checking", "checking", 0, None).unwrap().id;
        let sav = queries::create_account(&c, "Savings", "savings", 0, None).unwrap().id;
        let prop = create_classification(&c, "Property").unwrap();
        let person = create_classification(&c, "Person").unwrap();
        let maple = create_classification_value(&c, &prop.id, "Maple", None).unwrap();
        let birch = create_classification_value(&c, &prop.id, "Birch Lane", None).unwrap();
        let sam = create_classification_value(&c, &person.id, "Sam", None).unwrap();

        let t = queries::create_transaction(&c, &chk, "2026-03-01", "Roofer", None, -50_000, None, None).unwrap();
        let got = set_transaction_classes(&c, &t.id, &[pick(&prop.id, &maple.id), pick(&person.id, &sam.id)]).unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got.iter().map(|p| p.label.as_str()).collect::<Vec<_>>(), vec!["Maple", "Sam"]);
        // Re-picking the same axis replaces, not adds.
        let got = set_transaction_classes(&c, &t.id, &[pick(&prop.id, &birch.id)]).unwrap();
        assert_eq!(got.iter().map(|p| p.label.as_str()).collect::<Vec<_>>(), vec!["Birch Lane", "Sam"]);
        // An empty value clears that axis only.
        let got = set_transaction_classes(&c, &t.id, &[pick(&person.id, "")]).unwrap();
        assert_eq!(got.iter().map(|p| p.label.as_str()).collect::<Vec<_>>(), vec!["Birch Lane"]);
        // A value from the wrong axis is refused.
        assert!(set_transaction_classes(&c, &t.id, &[pick(&person.id, &maple.id)]).is_err());

        // Both halves of a transfer carry the same picks.
        let tr = queries::create_transfer(&c, &chk, &sav, "2026-03-02", 10_000, None).unwrap();
        set_transaction_classes(&c, &tr.id, &[pick(&prop.id, &maple.id)]).unwrap();
        let other: String = c.query_row("SELECT transfer_id FROM transactions WHERE id = ?1", params![tr.id], |r| r.get(0)).unwrap();
        assert_eq!(transaction_classes(&c, &other).unwrap()[0].value_id, maple.id);

        // The register carries them, one query for the account.
        let by = classes_by_transaction(&c, &chk).unwrap();
        assert_eq!(by[&t.id][0].label, "Birch Lane");
        assert_eq!(by[&tr.id][0].label, "Maple");

        // Deleting a value drops its links and says how many.
        assert_eq!(delete_classification_value(&c, &maple.id).unwrap(), 2);
        assert!(transaction_classes(&c, &tr.id).unwrap().is_empty());
        // Deleting the axis takes the rest.
        assert_eq!(delete_classification(&c, &prop.id).unwrap(), 1);
        assert!(transaction_classes(&c, &t.id).unwrap().is_empty());
        assert_eq!(list_classifications(&c).unwrap().len(), 1);
    }

    #[test]
    fn renaming_a_value_keeps_every_tag_including_a_split_three_ways() {
        // Sam: tagged a mortgage payment split three ways (principal,
        // interest, escrow), renamed the value in the Budget tab, and the
        // register came back "(none)".
        use crate::db::classes;
        use crate::models::NewSplit;
        let db = TestDb::new("rename-keeps");
        let c = db.conn();
        let chk = queries::create_account(&c, "Checking", "checking", 500_000, Some("2026-01-01")).unwrap().id;
        let loan = queries::create_account(&c, "HELOC", "loan", -100_000_00, Some("2026-01-01")).unwrap().id;
        let esc = queries::create_account(&c, "Escrow", "savings", 0, Some("2026-01-01")).unwrap().id;
        let interest = queries::ensure_category(&c, "HELOC Interest").unwrap();

        let prop = classes::create_classification(&c, "Property").unwrap();
        let v = classes::create_classification_value(&c, &prop.id, "Maple Street", None).unwrap();
        let pick = crate::models::ClassPick { classification_id: prop.id.clone(), value_id: v.id.clone(), label: String::new() };

        let t = queries::create_transaction(&c, &chk, "2026-09-01", "Mortgage", None, -150_000, None, None).unwrap();
        classes::set_transaction_classes(&c, &t.id, &[pick.clone()]).unwrap();
        queries::set_splits(&c, &t.id, &[
            NewSplit { classes: vec![pick.clone()], category_id: None, description: Some("principal".into()), amount_cents: -80_000, transfer_account_id: Some(loan.clone()) },
            NewSplit { classes: vec![pick.clone()], category_id: Some(interest.clone()), description: Some("interest".into()), amount_cents: -50_000, transfer_account_id: None },
            NewSplit { classes: vec![pick.clone()], category_id: None, description: Some("escrow".into()), amount_cents: -20_000, transfer_account_id: Some(esc.clone()) },
        ]).unwrap();

        let before = queries::get_register(&c, &chk).unwrap();
        let row = before.iter().find(|r| r.id == t.id).unwrap();
        assert_eq!(row.classes.len(), 1, "the register row is tagged before the rename");
        assert_eq!(row.classes[0].label, "Maple Street");

        // The rename itself.
        classes::rename_classification_value(&c, &v.id, "418 Maple Street").unwrap();

        let after = queries::get_register(&c, &chk).unwrap();
        let row = after.iter().find(|r| r.id == t.id).unwrap();
        assert_eq!(row.classes.len(), 1, "STILL tagged after the rename");
        assert_eq!(row.classes[0].label, "418 Maple Street", "and shows the new name");
        assert_eq!(row.classes[0].value_id, v.id, "same value, same id");

        // Every split line too.
        let lines = queries::list_splits(&c, &t.id).unwrap();
        assert_eq!(lines.len(), 3);
        for l in &lines {
            assert_eq!(l.classes.len(), 1, "line {:?} kept its value", l.description);
            assert_eq!(l.classes[0].label, "418 Maple Street");
        }
        let n: i64 = c.query_row("SELECT COUNT(*) FROM transaction_classes", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 4, "one on the transaction, one per line — nothing dropped");
    }

    #[test]
    fn a_row_shows_what_its_split_lines_say_when_it_says_nothing_itself() {
        // §117.3 — the register row has always shown `split_id IS NULL`
        // values. A mortgage split into principal, interest and escrow, with
        // every line tagged to a house and the transaction itself untagged,
        // therefore showed NOTHING on its row and "(none)" in its field —
        // which reads as tagging that would not stick, and was reported that
        // way.
        use crate::models::NewSplit;
        let db = TestDb::new("lines-summary");
        let c = db.conn();
        let chk = queries::create_account(&c, "Checking", "checking", 500_000, Some("2026-01-01")).unwrap().id;
        let prop = create_classification(&c, "Property").unwrap();
        let birch = create_classification_value(&c, &prop.id, "27 Birch Lane", None).unwrap();
        let maple = create_classification_value(&c, &prop.id, "418 Maple Street", None).unwrap();
        let line = |v: &str| NewSplit {
            classes: vec![pick(&prop.id, v)],
            category_id: None,
            description: None,
            amount_cents: -50_000,
            transfer_account_id: None,
        };

        // Every line the same house: the row says the house.
        let t = queries::create_transaction(&c, &chk, "2026-09-01", "Mortgage", None, -150_000, None, None).unwrap();
        queryless_splits(&c, &t.id, vec![line(&birch.id), line(&birch.id), line(&birch.id)]);
        let by = line_classes_by_transaction(&c, &chk).unwrap();
        assert_eq!(by[&t.id].len(), 1);
        assert_eq!(by[&t.id][0].label, "27 Birch Lane");
        assert_eq!(by[&t.id][0].value_id, birch.id, "a single value is the value, not a marker");

        // Lines that disagree say so rather than picking one — a receipt
        // split across two houses is a real thing, and "27 Birch Lane"
        // would be a lie.
        let t2 = queries::create_transaction(&c, &chk, "2026-09-02", "Home Depot", None, -100_000, None, None).unwrap();
        queryless_splits(&c, &t2.id, vec![line(&birch.id), line(&maple.id)]);
        let by = line_classes_by_transaction(&c, &chk).unwrap();
        assert_eq!(by[&t2.id][0].label, "2 values");
        assert_eq!(by[&t2.id][0].value_id, "", "no single value to name");

        // The transaction's OWN value wins and is not repeated here — the
        // register shows that one from `classes_by_transaction`.
        set_transaction_classes(&c, &t.id, &[pick(&prop.id, &maple.id)]).unwrap();
        let by = line_classes_by_transaction(&c, &chk).unwrap();
        assert!(!by.contains_key(&t.id), "the transaction answers for itself now");
        assert_eq!(classes_by_transaction(&c, &chk).unwrap()[&t.id][0].label, "418 Maple Street");

        // And the register row carries both halves.
        let rows = queries::get_register(&c, &chk).unwrap();
        let r2 = rows.iter().find(|r| r.id == t2.id).unwrap();
        assert!(r2.classes.is_empty());
        assert_eq!(r2.line_classes[0].label, "2 values");
    }

    #[test]
    fn the_reported_sequence_tagging_the_transaction_then_saving_the_split() {
        // Reported: a value picked on the main transaction, then the split
        // opened — its lines showing the value in brackets, which is the
        // inherited placeholder — Enter pressed, and back on the register
        // the tag was gone.
        //
        // The register saves an existing split row in this order: set_splits
        // first (it is the one call that may move the total), then
        // update_transaction, then the classification write. So the question
        // is whether either of the first two takes the tag with it.
        use crate::models::NewSplit;
        let db = TestDb::new("reported-seq");
        let c = db.conn();
        let chk = queries::create_account(&c, "Checking", "checking", 500_000, Some("2026-01-01")).unwrap().id;
        let loan = queries::create_account(&c, "HELOC", "loan", -100_000_00, Some("2026-01-01")).unwrap().id;
        let prop = create_classification(&c, "Property").unwrap();
        let v = create_classification_value(&c, &prop.id, "418 Maple Street", None).unwrap();

        let t = queries::create_transaction(&c, &chk, "2026-09-01", "Mortgage", None, -150_000, None, None).unwrap();
        set_transaction_classes(&c, &t.id, &[pick(&prop.id, &v.id)]).unwrap();
        assert_eq!(transaction_classes(&c, &t.id).unwrap().len(), 1, "tagged");

        // The split, with every line INHERITING (no value of its own) — which
        // is what the bracketed placeholder means, and what the dialog sends.
        let blank = |amt: i64, to: Option<String>| NewSplit {
            classes: vec![ClassPick { classification_id: prop.id.clone(), value_id: String::new(), label: String::new() }],
            category_id: None,
            description: None,
            amount_cents: amt,
            transfer_account_id: to,
        };
        queries::set_splits(&c, &t.id, &[blank(-80_000, Some(loan.clone())), blank(-50_000, None), blank(-20_000, None)]).unwrap();
        assert_eq!(
            transaction_classes(&c, &t.id).unwrap().len(),
            1,
            "set_splits must not touch the TRANSACTION's own value — the lines' rows are keyed on split_id"
        );

        // Then the ordinary edit that follows it.
        queries::update_transaction(&c, &t.id, "2026-09-01", "Mortgage", None, -150_000, None, None).unwrap();
        assert_eq!(transaction_classes(&c, &t.id).unwrap().len(), 1, "nor does update_transaction");

        let rows = queries::get_register(&c, &chk).unwrap();
        let row = rows.iter().find(|r| r.id == t.id).unwrap();
        assert_eq!(row.classes.len(), 1, "and the register row still shows it");
        assert_eq!(row.classes[0].label, "418 Maple Street");
    }

    /// `set_splits`, for a test that does not care about the returned lines.
    fn queryless_splits(c: &Conn, txn: &str, lines: Vec<crate::models::NewSplit>) {
        queries::set_splits(c, txn, &lines).unwrap();
    }

    #[test]
    fn a_split_line_carries_its_own_value_and_survives_a_rewrite() {
        let db = TestDb::new("splits");
        let c = db.conn();
        let chk = queries::create_account(&c, "Checking", "checking", 0, None).unwrap().id;
        let prop = create_classification(&c, "Property").unwrap();
        let maple = create_classification_value(&c, &prop.id, "Maple", None).unwrap();
        let birch = create_classification_value(&c, &prop.id, "Birch Lane", None).unwrap();
        let t = queries::create_transaction(&c, &chk, "2026-03-01", "Home Depot", None, -9_000, None, None).unwrap();
        let lines = queries::set_splits(
            &c,
            &t.id,
            &[
                NewSplit { classes: vec![pick(&prop.id, &maple.id)], category_id: None, description: None, amount_cents: -6_000, transfer_account_id: None },
                NewSplit { classes: vec![pick(&prop.id, &birch.id)], category_id: None, description: None, amount_cents: -3_000, transfer_account_id: None },
            ],
        )
        .unwrap();
        assert_eq!(lines[0].classes[0].label, "Maple");
        assert_eq!(lines[1].classes[0].label, "Birch Lane");
        assert_eq!(lines[1].classes[0].classification_id, prop.id);
        // Rewriting the lines rewrites the links: no orphans, new ids.
        let lines = queries::set_splits(
            &c,
            &t.id,
            &[NewSplit { classes: vec![], category_id: None, description: None, amount_cents: -9_000, transfer_account_id: None }],
        )
        .unwrap();
        assert!(lines[0].classes.is_empty());
        let n: i64 = c.query_row("SELECT COUNT(*) FROM transaction_classes", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }
}
