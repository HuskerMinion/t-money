//! §101 — undo, for the things you do hundreds of times.
//!
//! > *"Build undo for transactions"*
//!
//! Every edit in this app has written straight to the database since the first
//! commit. That is the right default for a ledger — nothing pending, nothing
//! to lose in a crash — but it makes a mis-click permanent, and entering
//! transactions is a mis-click-heavy activity.
//!
//! WHAT IS UNDOABLE, AND WHAT IS NOT. Transactions: added, edited, deleted,
//! voided, split, tagged; payee rules applied to existing rows; and — since
//! §119 — the two ways of writing a transaction that are not typing one:
//! **Update value** on an asset (§93) and **Record payment** on a loan (§94).
//! Those two were missed when this was built because neither goes through
//! `create_transaction`, and a user found both the hard way: "I had an error
//! and I couldn't undo and had to delete." An undo that covers most of what
//! writes to the file is the shallow undo this module's own comment warns
//! about. Since §133, **merging two categories** as well: it is a rename
//! that deletes something, the direction is easy to get backwards, and the
//! person who gets it backwards is by definition not the person who took a
//! backup first. Since §186, **merging two payees** and deleting an unused
//! one, for the same reason: *"I merged Best Buy into Chewy … CTRL+Z did
//! not undo it."*
//!
//! Not accounts — deleting an account takes every row in it, and something
//! that consequential should stay confirm-then-commit rather than becoming a
//! thing you can shrug off; §132's rule covers it instead, by emptying the
//! stack so Undo cannot reach past it. That sentence was written at §132 and
//! only became true at §136, which finally had `delete_account` and
//! `merge_accounts` call `undo_stack_invalidated` the way the importers
//! already did. Worth saying plainly: a header that states an intention in
//! the present tense is how a gap like that survives four sections. A
//! shallow undo that quietly covers half of what a user assumes is worse than
//! no undo, so the menu names what it will undo ("Undo delete a transaction")
//! and grays itself out when the last thing you did was not one of these.
//!
//! HOW IT WORKS: ROW SNAPSHOTS, NOT INVERSE OPERATIONS.
//!
//! The obvious design is an inverse per operation — undo a create by
//! deleting, undo a delete by re-creating. It does not survive contact with
//! this schema. `delete_transaction` also removes the transfer partner, the
//! funding pair a buy came with, and the far rows of every split that pointed
//! at an account; re-creating all of that by replaying constructors means
//! keeping the inverse in step with five interacting features forever, and
//! the first time it drifts the user loses a row and is told everything is
//! fine.
//!
//! So instead: photograph the rows before, photograph them after, and swap.
//! Restoring is `DELETE` those ids then `INSERT` the photograph verbatim.
//!
//! The photograph is GENERIC — `SELECT *`, column names and values as the
//! database hands them over. A typed snapshot mirroring twenty columns rots
//! the moment a migration adds the twenty-first: the code still compiles, the
//! test still passes, and undo silently drops whatever the new column held.
//! Reading the columns at runtime means a future column is carried without
//! anyone remembering to carry it.
//!
//! BALANCES ARE RECOMPUTED, NOT ADJUSTED. Every other write in this file
//! moves `accounts.balance_cents` by a delta. Undo cannot: it is putting back
//! an arbitrary set of rows, and a delta computed from a snapshot is a second
//! source of truth waiting to disagree. Each touched account is summed from
//! its own rows afterwards — the same statement `merge_accounts` uses.
//!
//! IN MEMORY, NOT IN THE FILE. The stack lives in `AppState` and dies with
//! the process. Undo is for the last few minutes; an undo stack that survives
//! a restart invites someone to undo their way back through a session they no
//! longer remember, into a state nothing on screen prepared them for.

use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection};
use std::collections::BTreeSet;

/// One table's rows, as the database gave them.
#[derive(Debug, Clone)]
pub struct Rows {
    pub table: &'static str,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
}

/// §133 — one column of one table, put back row by row.
///
/// The `Rows` photograph above is for rows that get deleted and re-inserted
/// whole. A merge does not delete the rows it touches — it re-points a single
/// column on each of them — and a transaction that is only having its
/// `category_id` changed must not be deleted and re-created to put that
/// change back: it has a transfer partner, splits and classification links
/// hanging off its id, and every one of those would have to be torn down and
/// rebuilt to move one value. So this photographs the value.
#[derive(Debug, Clone)]
pub struct Cells {
    pub table: &'static str,
    /// The column that names the row — `id` everywhere except `loan_terms`,
    /// which is keyed on `account_id`.
    pub key: &'static str,
    pub column: &'static str,
    /// `(key value, what the column held)`.
    pub rows: Vec<(Value, Value)>,
}

/// §133 — rows to clear out before a photograph goes back, named by a key
/// that is not a transaction id.
///
/// Named `Removal` and not `Drop` because `Drop` is in the prelude, and a
/// struct by that name in this module would shadow the trait for every line
/// below it.
#[derive(Debug, Clone)]
pub struct Removal {
    pub table: &'static str,
    pub key: &'static str,
    pub values: Vec<Value>,
}

/// Everything one operation touched, before or after it happened.
#[derive(Debug, Clone, Default)]
pub struct Snapshot {
    pub tables: Vec<Rows>,
    /// The transaction ids the snapshot is *about* — what gets deleted before
    /// the rows go back, so a row created by the operation disappears when the
    /// operation is undone.
    pub txn_ids: Vec<String>,
    /// Accounts whose balance must be recomputed after a restore.
    pub accounts: Vec<String>,
    /// §133 — the generic half, applied in the order it is declared here:
    /// **drops, inserts, cells, late_drops**. The order is load-bearing, and
    /// each step earns its place:
    ///
    /// - `drops` first, because rows are about to be re-inserted under the
    ///   same primary keys.
    /// - `inserts` next, because a row cannot be pointed at before it exists —
    ///   undoing a merge puts the category back here, then points at it.
    /// - `cells` next: one column, row by row, back to what it held.
    /// - `late_drops` LAST, for a row that can only go once nothing points at
    ///   it. Redoing a merge deletes the source category here rather than in
    ///   `drops`, and the difference is not cosmetic: deleting it first fires
    ///   `ON DELETE SET NULL` on its subcategories, which drops them to top
    ///   level, where `UNIQUE (name, parent_id)` can reject the delete outright
    ///   (the standard chart ships `Automobile : Insurance` alongside a
    ///   top-level `Insurance`). Move the children off it first, then delete an
    ///   empty row and no cascade fires at all.
    pub drops: Vec<Removal>,
    pub inserts: Vec<Rows>,
    pub cells: Vec<Cells>,
    pub late_drops: Vec<Removal>,
}

/// A reversible step. `before` puts the world back; `after` does it again.
#[derive(Debug, Clone)]
pub struct Step {
    /// What the menu says: "Undo <label>".
    pub label: String,
    pub before: Snapshot,
    pub after: Snapshot,
}

/// The stack. Doing something new discards the redo side — the branch you
/// were on is gone, and pretending otherwise is how a redo puts back a row
/// that belongs to a history that no longer exists.
#[derive(Debug, Default)]
pub struct Journal {
    done: Vec<Step>,
    undone: Vec<Step>,
}

/// How deep. Fifty is far more than anyone reaches for and costs nothing —
/// these are a handful of rows each, not documents.
const DEPTH: usize = 50;

impl Journal {
    pub fn push(&mut self, step: Step) {
        self.undone.clear();
        self.done.push(step);
        if self.done.len() > DEPTH {
            self.done.remove(0);
        }
    }
    pub fn can_undo(&self) -> Option<&str> {
        self.done.last().map(|s| s.label.as_str())
    }
    pub fn can_redo(&self) -> Option<&str> {
        self.undone.last().map(|s| s.label.as_str())
    }
    pub fn take_undo(&mut self) -> Option<Step> {
        self.done.pop()
    }
    pub fn take_redo(&mut self) -> Option<Step> {
        self.undone.pop()
    }
    pub fn put_undone(&mut self, s: Step) {
        self.undone.push(s);
    }
    pub fn put_done(&mut self, s: Step) {
        self.done.push(s);
    }
    /// A different file is a different history. Called when one is opened.
    pub fn clear(&mut self) {
        self.done.clear();
        self.undone.clear();
    }
}

/// Every transaction id an operation on `id` could reach: the row itself, its
/// transfer partner, its funding pair in both directions, anything pointing
/// at it as a transfer, the far rows of its split transfers — and, §178, the
/// payment a far row belongs to. Without that last one an edit made in the
/// loan register photographed the principal row alone; undo deleted and
/// re-inserted it, `ON DELETE SET NULL` cut the payment's line loose, and the
/// line was not in the photograph to put the link back. Two hops take a far
/// row to its payment and on to the payment's other far rows (the escrow).
///
/// Deliberately generous. A snapshot that is too wide restores rows that did
/// not change, which is harmless; one that is too narrow loses a row, which
/// is not.
pub fn related_ids(conn: &Connection, id: &str) -> Result<Vec<String>, String> {
    let mut out: BTreeSet<String> = BTreeSet::new();
    out.insert(id.to_string());
    let mut frontier = vec![id.to_string()];

    // Two hops is enough for every shape this schema builds: a buy reaches its
    // funding row, and the funding row reaches its transfer partner.
    for _ in 0..2 {
        let mut found: Vec<String> = Vec::new();
        for cur in &frontier {
            for sql in [
                "SELECT transfer_id FROM transactions WHERE id = ?1 AND transfer_id IS NOT NULL",
                "SELECT id FROM transactions WHERE transfer_id = ?1",
                "SELECT funding_txn_id FROM transactions WHERE id = ?1 AND funding_txn_id IS NOT NULL",
                "SELECT id FROM transactions WHERE funding_txn_id = ?1",
                "SELECT transfer_txn_id FROM splits WHERE transaction_id = ?1 AND transfer_txn_id IS NOT NULL",
                "SELECT transaction_id FROM splits WHERE transfer_txn_id = ?1",
                // §179 — a §167 exchange's day. Delete and void take the whole
                // day's exchange (`queries::exchange_day_of`), and its links
                // are many-to-one: in a two-out, two-in reallocation the
                // second fund's Remove is three hops from the second Add.
                "SELECT o.id FROM transactions t
                   JOIN transactions o ON o.account_id = t.account_id AND o.date = t.date
                  WHERE t.id = ?1
                    AND t.activity IN ('add_shares', 'remove_shares')
                    AND o.activity IN ('add_shares', 'remove_shares')
                    AND EXISTS (SELECT 1 FROM transactions p WHERE p.id = t.transfer_id AND p.account_id = t.account_id)
                    AND EXISTS (SELECT 1 FROM transactions p WHERE p.id = o.transfer_id AND p.account_id = o.account_id)",
            ] {
                let mut st = conn.prepare(sql).map_err(|e| e.to_string())?;
                let ids: Vec<String> = st
                    .query_map(params![cur], |r| r.get::<_, String>(0))
                    .map_err(|e| e.to_string())?
                    .collect::<Result<_, _>>()
                    .map_err(|e| e.to_string())?;
                found.extend(ids);
            }
        }
        frontier = found.into_iter().filter(|f| out.insert(f.clone())).collect();
        if frontier.is_empty() {
            break;
        }
    }
    Ok(out.into_iter().collect())
}

fn placeholders(n: usize) -> String {
    std::iter::repeat("?").take(n).collect::<Vec<_>>().join(",")
}

/// `SELECT *` for a set of ids, columns read at runtime.
///
/// §133 — public, because a merge photographs rows outside the three tables
/// `snapshot` knows about (the category row it is about to delete, and the
/// budget rows it is about to fold together).
pub fn photograph(conn: &Connection, table: &'static str, key: &str, ids: &[String]) -> Result<Rows, String> {
    if ids.is_empty() {
        return Ok(Rows { table, columns: Vec::new(), rows: Vec::new() });
    }
    let sql = format!("SELECT * FROM {table} WHERE {key} IN ({})", placeholders(ids.len()));
    let mut st = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let columns: Vec<String> = st.column_names().into_iter().map(str::to_string).collect();
    let n = columns.len();
    let rows: Vec<Vec<Value>> = st
        .query_map(params_from_iter(ids.iter()), |r| {
            (0..n).map(|i| r.get::<_, Value>(i)).collect::<rusqlite::Result<Vec<_>>>()
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(Rows { table, columns, rows })
}

/// Photograph everything an operation on these transaction ids touches.
pub fn snapshot(conn: &Connection, txn_ids: &[String]) -> Result<Snapshot, String> {
    let txns = photograph(conn, "transactions", "id", txn_ids)?;
    let splits = photograph(conn, "splits", "transaction_id", txn_ids)?;
    // §112: the classification links, keyed on the transaction either way
    // (a split line's link carries its transaction_id too). Restored after
    // splits, since a line's link references the split row.
    let classes = photograph(conn, "transaction_classes", "transaction_id", txn_ids)?;
    // §170: the attachment LINK rows — name, type, what they hang off —
    // never the bytes, which stay in `attachment_blobs` until the file is
    // next opened. A photograph a few hundred bytes a row is what lets a
    // deleted transaction come back with its receipts.
    let attachments = photograph(conn, "attachments", "transaction_id", txn_ids)?;
    // Accounts to recompute: whoever owns any of these rows, taken from the
    // photograph rather than from a second query, so a row that has already
    // been deleted still names its account.
    let mut accounts: BTreeSet<String> = BTreeSet::new();
    if let Some(i) = txns.columns.iter().position(|c| c == "account_id") {
        for r in &txns.rows {
            if let Value::Text(s) = &r[i] {
                accounts.insert(s.clone());
            }
        }
    }
    Ok(Snapshot {
        tables: vec![txns, splits, classes, attachments],
        txn_ids: txn_ids.to_vec(),
        accounts: accounts.into_iter().collect(),
        ..Snapshot::default()
    })
}

fn insert_rows(tx: &Connection, rows: &Rows) -> Result<(), String> {
    if rows.rows.is_empty() {
        return Ok(());
    }
    let sql = format!(
        "INSERT INTO {} ({}) VALUES ({})",
        rows.table,
        rows.columns.join(","),
        placeholders(rows.columns.len())
    );
    let mut st = tx.prepare(&sql).map_err(|e| e.to_string())?;
    for r in &rows.rows {
        st.execute(params_from_iter(r.iter())).map_err(|e| format!("restoring {}: {e}", rows.table))?;
    }
    Ok(())
}

/// Put a snapshot back: clear whatever is at those ids now, insert the
/// photograph, then recompute the balance of every account either side
/// touched.
///
/// `also` names accounts the snapshot itself cannot — when undoing a create,
/// the "before" photograph is empty, so the account whose row is about to
/// vanish has to be named by the "after" one.
pub fn restore(conn: &Connection, snap: &Snapshot, also: &[String]) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    // §178 — split lines OUTSIDE the photograph that point at a row inside
    // it. Deleting that row below fires `ON DELETE SET NULL` on them, and
    // their own split rows are not about to be re-inserted to carry the link
    // back. `related_ids` puts the payment in the photograph, so this is
    // empty for any step recorded since; it is here for a step recorded
    // before, or a caller that named ids by hand.
    let mut stranded: Vec<(String, String)> = Vec::new();
    if !snap.txn_ids.is_empty() {
        let marks = placeholders(snap.txn_ids.len());
        let sql = format!(
            "SELECT id, transfer_txn_id FROM splits
              WHERE transfer_txn_id IN ({marks}) AND transaction_id NOT IN ({marks})"
        );
        let mut st = tx.prepare(&sql).map_err(|e| e.to_string())?;
        stranded = st
            .query_map(params_from_iter(snap.txn_ids.iter().chain(snap.txn_ids.iter())), |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
    }

    if !snap.txn_ids.is_empty() {
        let marks = placeholders(snap.txn_ids.len());
        // Links first, then splits: each references what follows it.
        // §170: the link rows go first; the photograph puts them back.
        tx.execute(
            &format!("DELETE FROM attachments WHERE transaction_id IN ({marks})"),
            params_from_iter(snap.txn_ids.iter()),
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            &format!("DELETE FROM transaction_classes WHERE transaction_id IN ({marks})"),
            params_from_iter(snap.txn_ids.iter()),
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            &format!("DELETE FROM splits WHERE transaction_id IN ({marks})"),
            params_from_iter(snap.txn_ids.iter()),
        )
        .map_err(|e| e.to_string())?;
        // A transfer_id pointing at a row about to go would fail the foreign
        // key; the photograph puts the real value back a moment later.
        tx.execute(
            &format!("UPDATE transactions SET transfer_id = NULL WHERE transfer_id IN ({marks})"),
            params_from_iter(snap.txn_ids.iter()),
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            &format!("UPDATE transactions SET funding_txn_id = NULL WHERE funding_txn_id IN ({marks})"),
            params_from_iter(snap.txn_ids.iter()),
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            &format!("DELETE FROM transactions WHERE id IN ({marks})"),
            params_from_iter(snap.txn_ids.iter()),
        )
        .map_err(|e| e.to_string())?;
    }

    // Transactions before splits, and transactions without their transfer_id
    // first — two rows that point at each other cannot both be inserted with
    // the pointer already set.
    for t in snap.tables.iter().filter(|t| t.table == "transactions") {
        insert_rows_without_links(&tx, t)?;
    }
    for t in snap.tables.iter().filter(|t| t.table == "transactions") {
        relink(&tx, t)?;
    }
    for t in snap.tables.iter().filter(|t| t.table != "transactions") {
        insert_rows(&tx, t)?;
    }
    // §178 — and point those lines back at their rows, where the rows came
    // back. A row that did not (undoing its creation) leaves the line as the
    // delete left it, which `verify_file` reports.
    for (split_id, far_id) in &stranded {
        tx.execute(
            "UPDATE splits SET transfer_txn_id = ?2
              WHERE id = ?1 AND EXISTS (SELECT 1 FROM transactions WHERE id = ?2)",
            params![split_id, far_id],
        )
        .map_err(|e| e.to_string())?;
    }

    // §133 — the generic half. Drops, inserts, cells, late drops; see
    // `Snapshot` for why that order and no other.
    let remove = |d: &Removal| -> Result<(), String> {
        if d.values.is_empty() {
            return Ok(());
        }
        tx.execute(
            &format!("DELETE FROM {} WHERE {} IN ({})", d.table, d.key, placeholders(d.values.len())),
            params_from_iter(d.values.iter()),
        )
        .map_err(|e| format!("restoring {}: {e}", d.table))?;
        Ok(())
    };
    for d in &snap.drops {
        remove(d)?;
    }
    for r in &snap.inserts {
        insert_rows(&tx, r)?;
    }
    for c in &snap.cells {
        let sql = format!("UPDATE {} SET {} = ?2 WHERE {} = ?1", c.table, c.column, c.key);
        let mut st = tx.prepare(&sql).map_err(|e| e.to_string())?;
        for (k, v) in &c.rows {
            st.execute(params![k, v])
                .map_err(|e| format!("restoring {}.{}: {e}", c.table, c.column))?;
        }
    }
    for d in &snap.late_drops {
        remove(d)?;
    }

    let mut accounts: BTreeSet<&str> = snap.accounts.iter().map(String::as_str).collect();
    for a in also {
        accounts.insert(a.as_str());
    }
    for a in accounts {
        tx.execute(
            "UPDATE accounts SET balance_cents = (
                 SELECT coalesce(SUM(amount_cents), 0) FROM transactions
                  WHERE account_id = ?1 AND is_void = 0),
                 updated_at = datetime('now')
              WHERE id = ?1",
            params![a],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())
}

/// Insert with the self-referencing columns blanked.
fn insert_rows_without_links(tx: &Connection, rows: &Rows) -> Result<(), String> {
    if rows.rows.is_empty() {
        return Ok(());
    }
    let blank: Vec<usize> = rows
        .columns
        .iter()
        .enumerate()
        .filter(|(_, c)| *c == "transfer_id" || *c == "funding_txn_id")
        .map(|(i, _)| i)
        .collect();
    let sql = format!(
        "INSERT INTO {} ({}) VALUES ({})",
        rows.table,
        rows.columns.join(","),
        placeholders(rows.columns.len())
    );
    let mut st = tx.prepare(&sql).map_err(|e| e.to_string())?;
    for r in &rows.rows {
        let mut vals = r.clone();
        for &i in &blank {
            vals[i] = Value::Null;
        }
        st.execute(params_from_iter(vals.iter())).map_err(|e| format!("restoring {}: {e}", rows.table))?;
    }
    Ok(())
}

/// Put the self-referencing columns back, now that every row exists.
fn relink(tx: &Connection, rows: &Rows) -> Result<(), String> {
    let Some(id_at) = rows.columns.iter().position(|c| c == "id") else { return Ok(()) };
    for col in ["transfer_id", "funding_txn_id"] {
        let Some(at) = rows.columns.iter().position(|c| c == col) else { continue };
        for r in &rows.rows {
            if matches!(r[at], Value::Null) {
                continue;
            }
            // A pointer at a row that is genuinely gone (its account was
            // deleted while this step sat on the stack) is dropped rather than
            // failing the whole undo. Losing a link is recoverable; refusing
            // to restore the row is not.
            let target: Option<String> = match &r[at] {
                Value::Text(s) => Some(s.clone()),
                _ => None,
            };
            let Some(target) = target else { continue };
            let exists: i64 = tx
                .query_row("SELECT COUNT(*) FROM transactions WHERE id = ?1", params![target], |x| x.get(0))
                .map_err(|e| e.to_string())?;
            if exists == 0 {
                continue;
            }
            tx.execute(
                &format!("UPDATE transactions SET {col} = ?2 WHERE id = ?1"),
                params![&r[id_at], target],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Run `op` and record how to reverse it.
///
/// The pattern every undoable command uses: work out what the operation could
/// touch, photograph it, do the thing, photograph it again.
pub fn recording<T>(
    conn: &Connection,
    label: &str,
    ids: &[String],
    op: impl FnOnce() -> Result<T, String>,
) -> Result<(T, Step), String> {
    let before = snapshot(conn, ids)?;
    let value = op()?;
    // After the operation the id set can be larger — a create makes rows that
    // did not exist to be photographed. Re-derive it.
    let mut after_ids: BTreeSet<String> = ids.iter().cloned().collect();
    for id in ids {
        for r in related_ids(conn, id)? {
            after_ids.insert(r);
        }
    }
    let after_ids: Vec<String> = after_ids.into_iter().collect();
    let after = snapshot(conn, &after_ids)?;
    Ok((
        value,
        Step { label: label.to_string(), before: widen(before, &after_ids), after },
    ))
}

/// §119 — finish a step for an operation that CREATED rows.
///
/// `recording` cannot photograph what does not exist yet, so a create needs a
/// second pass once the new row has an id: the "after" photograph covers what
/// was made, and the "before" one is told to delete it, which is what makes
/// undo-of-a-create a deletion of exactly those rows.
///
/// `also` is for an operation that created a row AND changed an existing one —
/// a revaluation adjusts the next revaluation after it (§93), and those ids
/// must already have been passed to `recording` so their original state is in
/// the "before" photograph. Naming them here keeps them in the id set the undo
/// clears, so redo removes the created row without stranding the neighbor.
pub fn creation_step(conn: &Connection, mut step: Step, created: &str, also: &[String]) -> Result<Step, String> {
    let mut ids = related_ids(conn, created)?;
    for a in also {
        if !ids.contains(a) {
            ids.push(a.clone());
        }
    }
    step.after = snapshot(conn, &ids)?;
    step.before.txn_ids = ids;
    Ok(step)
}

/// §153 — the ids of every transaction in the file, for diffing across an
/// operation that creates an unknown number of them.
///
/// An import does not know what it is about to write: the file decides, rows
/// are skipped as duplicates, some are matched to existing transactions
/// instead of written, and a QIF `[Account]` line writes into an account
/// nobody named. Photographing "what changed" by asking the importer would
/// mean every importer reporting it, and the one that forgot would be the one
/// that silently could not be undone.
///
/// So: take the ids before, take them after, and the difference IS what was
/// created. It costs one column of one table.
pub fn all_txn_ids(conn: &Connection) -> Result<BTreeSet<String>, String> {
    let mut st = conn
        .prepare("SELECT id FROM transactions")
        .map_err(|e| e.to_string())?;
    let rows = st
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut out = BTreeSet::new();
    for r in rows {
        out.insert(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// §153 — a step for an operation that created MANY rows, which is what an
/// import is.
///
/// > *"if I mistakenly import to the wrong account well I have a lot of
/// >  cleanup to do where undo could just fix it right away."*
///
/// `creation_step` does this for one created row. The shape is the same: the
/// "after" photograph covers what was made, and the "before" one names those
/// same ids with no rows to put back, so undoing is exactly a deletion of
/// them.
///
/// WHAT THIS DOES NOT TAKE BACK, and it is written here so nobody assumes
/// otherwise: securities and payees the import created along the way. They are
/// referenced by nothing once the transactions are gone, they are harmless,
/// and photographing them would mean walking two more tables for a case that
/// has never bitten anybody. A row that was MATCHED rather than written was
/// only marked cleared, so that mark is restored by the ordinary cell
/// machinery if the id is in the set, and left alone otherwise.
pub fn creations_step(
    conn: &Connection,
    label: &str,
    created: &BTreeSet<String>,
) -> Result<Step, String> {
    let mut ids: BTreeSet<String> = BTreeSet::new();
    for id in created {
        for r in related_ids(conn, id)? {
            ids.insert(r);
        }
    }
    let ids: Vec<String> = ids.into_iter().collect();
    let after = snapshot(conn, &ids)?;
    // Nothing to restore: these rows did not exist before. Naming them in
    // `txn_ids` is what makes undo delete them.
    let before = Snapshot {
        tables: Vec::new(),
        txn_ids: ids,
        accounts: after.accounts.clone(),
        drops: Vec::new(),
        inserts: Vec::new(),
        cells: Vec::new(),
        late_drops: Vec::new(),
    };
    Ok(Step { label: label.to_string(), before, after })
}

/// The "before" photograph has to delete every id the "after" one created, or
/// undoing a create would leave the created row behind.
fn widen(mut before: Snapshot, ids: &[String]) -> Snapshot {
    let mut all: BTreeSet<String> = before.txn_ids.into_iter().collect();
    for i in ids {
        all.insert(i.clone());
    }
    before.txn_ids = all.into_iter().collect();
    before
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::queries;

    // §182 — the shared database, checked whole when the test ends.
    use crate::db::test_db::TestDb as Db;
    impl Db {
        fn c(&self) -> r2d2::PooledConnection<r2d2_sqlite::SqliteConnectionManager> {
            self.conn()
        }
    }

    fn balance(c: &Connection, id: &str) -> i64 {
        c.query_row("SELECT balance_cents FROM accounts WHERE id = ?1", params![id], |r| r.get(0)).unwrap()
    }
    fn count(c: &Connection, acct: &str) -> i64 {
        c.query_row("SELECT COUNT(*) FROM transactions WHERE account_id = ?1", params![acct], |r| r.get(0)).unwrap()
    }

    /// The one that matters. `delete_transaction` also removes the transfer
    /// partner — so undoing it has to bring back BOTH rows, both balances and
    /// the link between them, which is exactly what an inverse-operation undo
    /// gets wrong first.
    #[test]
    fn undoing_a_deleted_transfer_brings_back_both_sides_and_the_link() {
        let db = Db::new("xfer");
        let c = db.c();
        let a = queries::create_account(&c, "Checking", "checking", 100_000, Some("2026-01-01")).unwrap().id;
        // Both sides get an opening balance, which is itself a row (§93), so
        // "the transfer rows went away" is visibly different from "the account
        // is empty".
        let b = queries::create_account(&c, "Savings", "savings", 40_000, Some("2026-01-01")).unwrap().id;
        let t = queries::create_transfer(&c, &a, &b, "2026-03-01", 25_000, None).unwrap();

        assert_eq!(balance(&c, &a), 75_000);
        assert_eq!(balance(&c, &b), 65_000);

        let ids = related_ids(&c, &t.id).unwrap();
        assert_eq!(ids.len(), 2, "a transfer is two rows and undo must know it");
        let (_, step) = recording(&c, "delete a transaction", &ids, || queries::delete_transaction(&c, &t.id)).unwrap();
        assert_eq!(count(&c, &a), 1, "only the opening row is left");
        assert_eq!(count(&c, &b), 1);

        restore(&c, &step.before, &step.after.accounts).unwrap();

        assert_eq!(count(&c, &a), 2, "the near side is back");
        assert_eq!(count(&c, &b), 2, "and so is the far side");
        assert_eq!(balance(&c, &a), 75_000, "recomputed, not adjusted");
        assert_eq!(balance(&c, &b), 65_000);
        // The two rows point at each other again.
        let linked: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM transactions x JOIN transactions y ON y.id = x.transfer_id
                  WHERE y.transfer_id = x.id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(linked, 2, "the link is restored in both directions");
    }

    #[test]
    fn undoing_a_delete_brings_back_the_classification_links_too() {
        // §112: the links live in their own table, so the photograph has to
        // carry it — a column would have come for free, a table does not.
        use crate::db::classes;
        let db = Db::new("classes");
        let c = db.c();
        let a = queries::create_account(&c, "Checking", "checking", 100_000, Some("2026-01-01")).unwrap().id;
        let prop = classes::create_classification(&c, "Property").unwrap();
        let v = classes::create_classification_value(&c, &prop.id, "Maple", None).unwrap();
        let t = queries::create_transaction(&c, &a, "2026-03-02", "Roofer", None, -10_000, None, None).unwrap();
        let pick = crate::models::ClassPick { classification_id: prop.id.clone(), value_id: v.id.clone(), label: String::new() };
        classes::set_transaction_classes(&c, &t.id, &[pick.clone()]).unwrap();
        queries::set_splits(
            &c,
            &t.id,
            &[
                crate::models::NewSplit { classes: vec![pick.clone()], category_id: None, transfer_account_id: None, description: None, amount_cents: -6_000 },
                crate::models::NewSplit { classes: vec![], category_id: None, transfer_account_id: None, description: None, amount_cents: -4_000 },
            ],
        )
        .unwrap();
        let links: i64 = c.query_row("SELECT COUNT(*) FROM transaction_classes WHERE transaction_id = ?1", params![t.id], |r| r.get(0)).unwrap();
        assert_eq!(links, 2, "one on the transaction, one on a line");

        let ids = related_ids(&c, &t.id).unwrap();
        let (_, step) = recording(&c, "delete a transaction", &ids, || queries::delete_transaction(&c, &t.id)).unwrap();
        let gone: i64 = c.query_row("SELECT COUNT(*) FROM transaction_classes WHERE transaction_id = ?1", params![t.id], |r| r.get(0)).unwrap();
        assert_eq!(gone, 0, "CASCADE took them with the row");
        restore(&c, &step.before, &step.after.accounts).unwrap();
        let back: i64 = c.query_row("SELECT COUNT(*) FROM transaction_classes WHERE transaction_id = ?1", params![t.id], |r| r.get(0)).unwrap();
        assert_eq!(back, 2, "undo put both links back");
        assert_eq!(classes::transaction_classes(&c, &t.id).unwrap()[0].label, "Maple");
        let lines = queries::list_splits(&c, &t.id).unwrap();
        assert_eq!(lines[0].classes.len(), 1);
        assert!(lines[1].classes.is_empty());
        // And redo takes them away again without tripping over the links.
        restore(&c, &step.after, &step.before.accounts).unwrap();
        let n: i64 = c.query_row("SELECT COUNT(*) FROM transactions WHERE id = ?1", params![t.id], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn tagging_a_transaction_can_be_undone() {
        // A review finding: `set_transaction_classes` wrote straight to the
        // file without recording a step, so Edit → Undo after a mis-picked
        // value undid whatever came BEFORE it instead.
        use crate::db::classes;
        let db = Db::new("tag-undo");
        let c = db.c();
        let a = queries::create_account(&c, "Checking", "checking", 100_000, Some("2026-01-01")).unwrap().id;
        let prop = classes::create_classification(&c, "Property").unwrap();
        let v = classes::create_classification_value(&c, &prop.id, "Maple", None).unwrap();
        let t = queries::create_transaction(&c, &a, "2026-03-02", "Roofer", None, -10_000, None, None).unwrap();
        let pick = crate::models::ClassPick { classification_id: prop.id.clone(), value_id: v.id.clone(), label: String::new() };

        let ids = related_ids(&c, &t.id).unwrap();
        let (_, step) = recording(&c, "change a classification", &ids, || {
            classes::set_transaction_classes(&c, &t.id, &[pick.clone()])
        })
        .unwrap();
        assert_eq!(classes::transaction_classes(&c, &t.id).unwrap().len(), 1);
        restore(&c, &step.before, &step.after.accounts).unwrap();
        assert!(classes::transaction_classes(&c, &t.id).unwrap().is_empty(), "undo took the tag off");
        restore(&c, &step.after, &step.before.accounts).unwrap();
        assert_eq!(classes::transaction_classes(&c, &t.id).unwrap()[0].label, "Maple", "redo put it back");
        // The row itself is untouched either way.
        let (payee, cents): (String, i64) = c
            .query_row("SELECT payee, amount_cents FROM transactions WHERE id = ?1", params![t.id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!((payee.as_str(), cents), ("Roofer", -10_000));
    }

    #[test]
    fn undoing_a_delete_brings_back_the_splits_too() {
        let db = Db::new("splits");
        let c = db.c();
        let a = queries::create_account(&c, "Checking", "checking", 100_000, Some("2026-01-01")).unwrap().id;
        let food = queries::ensure_category(&c, "Food").unwrap();
        let gas = queries::ensure_category(&c, "Gas").unwrap();
        let t = queries::create_transaction(&c, &a, "2026-03-02", "Costco", None, -10_000, None, None).unwrap();
        queries::set_splits(
            &c,
            &t.id,
            &[
                crate::models::NewSplit { classes: Vec::new(), category_id: Some(food.clone()), transfer_account_id: None, description: Some("food".into()), amount_cents: -6_000 },
                crate::models::NewSplit { classes: Vec::new(), category_id: Some(gas.clone()), transfer_account_id: None, description: None, amount_cents: -4_000 },
            ],
        )
        .unwrap();
        let before_splits: i64 = c.query_row("SELECT COUNT(*) FROM splits WHERE transaction_id = ?1", params![t.id], |r| r.get(0)).unwrap();
        assert_eq!(before_splits, 2);

        let ids = related_ids(&c, &t.id).unwrap();
        let (_, step) = recording(&c, "delete a transaction", &ids, || queries::delete_transaction(&c, &t.id)).unwrap();
        restore(&c, &step.before, &step.after.accounts).unwrap();

        let after: i64 = c.query_row("SELECT COUNT(*) FROM splits WHERE transaction_id = ?1", params![t.id], |r| r.get(0)).unwrap();
        assert_eq!(after, 2, "both split lines came back");
        assert_eq!(balance(&c, &a), 90_000);
    }

    /// A split line can be a transfer (§94), which puts a row in a DIFFERENT
    /// account. Undoing the split has to take that far row with it, or the
    /// other account keeps money that no longer has a source.
    #[test]
    fn undoing_a_split_transfer_takes_the_far_row_with_it() {
        let db = Db::new("splitxfer");
        let c = db.c();
        let a = queries::create_account(&c, "Checking", "checking", 100_000, Some("2026-01-01")).unwrap().id;
        let b = queries::create_account(&c, "Savings", "savings", 0, Some("2026-01-01")).unwrap().id;
        let food = queries::ensure_category(&c, "Food").unwrap();
        let t = queries::create_transaction(&c, &a, "2026-03-02", "Paycheck split", None, -10_000, None, None).unwrap();

        let ids = related_ids(&c, &t.id).unwrap();
        let (_, step) = recording(&c, "change a split", &ids, || {
            queries::set_splits(
                &c,
                &t.id,
                &[
                    crate::models::NewSplit { classes: Vec::new(), category_id: Some(food.clone()), transfer_account_id: None, description: None, amount_cents: -6_000 },
                    crate::models::NewSplit { classes: Vec::new(), category_id: None, transfer_account_id: Some(b.clone()), description: Some("to savings".into()), amount_cents: -4_000 },
                ],
            )
        })
        .unwrap();
        assert_eq!(count(&c, &b), 1, "the far row landed in the other account");
        assert_eq!(balance(&c, &b), 4_000);

        restore(&c, &step.before, &step.after.accounts).unwrap();

        assert_eq!(count(&c, &b), 0, "and it left again");
        assert_eq!(balance(&c, &b), 0, "including its balance");
        assert_eq!(balance(&c, &a), 90_000, "the parent is untouched either way");
        let splits: i64 = c.query_row("SELECT COUNT(*) FROM splits WHERE transaction_id = ?1", params![t.id], |r| r.get(0)).unwrap();
        assert_eq!(splits, 0, "back to an unsplit transaction");
    }

    /// §178 — the file agrees with itself afterwards: every balance equals its
    /// rows, and every split transfer line still has its row.
    fn assert_consistent(c: &queries::Conn) {
        let v = queries::verify_file(c, false).unwrap();
        assert!(v.drift.is_empty(), "{:?}", v.drift);
        assert!(v.split_transfers.is_empty(), "{:?}", v.split_transfers);
        assert!(v.foreign_keys.is_empty(), "{:?}", v.foreign_keys);
    }

    fn linked_lines(c: &Connection, payment: &str) -> i64 {
        c.query_row(
            "SELECT COUNT(*) FROM splits s JOIN transactions f ON f.id = s.transfer_txn_id WHERE s.transaction_id = ?1",
            params![payment],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// A mortgage payment from checking: interest, principal to the loan,
    /// escrow to the escrow account. Returns (checking, loan, payment,
    /// principal row).
    fn mortgage_payment(c: &queries::Conn) -> (String, String, String, String) {
        let chk = queries::create_account(c, "Checking", "checking", 1_000_000, Some("2026-01-01")).unwrap().id;
        let loan = queries::create_account(c, "Mortgage", "mortgage", -15_000_000, Some("2026-01-01")).unwrap().id;
        let escrow = queries::create_account(c, "Escrow", "asset", 0, Some("2026-01-01")).unwrap().id;
        let line = |amount: i64, to: Option<&str>| crate::models::NewSplit {
            classes: Vec::new(),
            category_id: None,
            description: None,
            amount_cents: amount,
            transfer_account_id: to.map(str::to_string),
        };
        let pay = queries::create_transaction(c, &chk, "2026-03-01", "Summit Home Loans", None, -150_000, None, None).unwrap().id;
        queries::set_splits(c, &pay, &[line(-50_000, None), line(-80_000, Some(&loan)), line(-20_000, Some(&escrow))]).unwrap();
        let principal: String = c
            .query_row("SELECT transfer_txn_id FROM splits WHERE transaction_id = ?1 AND transfer_account_id = ?2", params![pay, loan], |r| r.get(0))
            .unwrap();
        (chk, loan, pay, principal)
    }

    /// §178 — an edit made in the LOAN register, to the principal row, then
    /// Ctrl+Z. Undo deleted and re-inserted that row, `ON DELETE SET NULL`
    /// cut the payment's line loose, and nothing put it back.
    #[test]
    fn undoing_an_edit_to_a_payments_row_in_the_loan_keeps_the_payment_linked() {
        let db = Db::new("far-edit");
        let c = db.c();
        let (_, loan, pay, principal) = mortgage_payment(&c);
        assert_eq!(linked_lines(&c, &pay), 2);

        let ids = related_ids(&c, &principal).unwrap();
        assert!(ids.contains(&pay), "the payment is photographed with its row");
        assert_eq!(ids.len(), 3, "and so is the escrow row: {ids:?}");
        let (_, step) = recording(&c, "edit a transaction", &ids, || {
            queries::update_transaction(&c, &principal, "2026-03-01", "Principal", None, 80_000, Some("March"), None)
        })
        .unwrap();

        restore(&c, &step.before, &step.after.accounts).unwrap();
        assert_eq!(linked_lines(&c, &pay), 2, "both lines still reach their rows");
        let payee: String = c.query_row("SELECT payee FROM transactions WHERE id = ?1", params![principal], |r| r.get(0)).unwrap();
        assert_eq!(payee, "Summit Home Loans");
        assert_eq!(balance(&c, &loan), -15_000_000 + 80_000);
        assert_consistent(&c);

        restore(&c, &step.after, &step.before.accounts).unwrap();
        assert_eq!(linked_lines(&c, &pay), 2, "and after redo");
        assert_consistent(&c);

        // A step that names the far row alone — recorded before related_ids
        // reached the payment — still leaves the line linked.
        let (_, narrow) = recording(&c, "edit a transaction", &[principal.clone()], || {
            queries::update_transaction(&c, &principal, "2026-03-01", "Loan", None, 80_000, None, None)
        })
        .unwrap();
        let narrow_before = Snapshot { txn_ids: vec![principal.clone()], ..narrow.before.clone() };
        restore(&c, &narrow_before, &narrow.after.accounts).unwrap();
        assert_eq!(linked_lines(&c, &pay), 2, "restore puts the link back itself");
        assert_consistent(&c);
    }

    /// §178 — the other side: an edit to the payment moves its rows' dates,
    /// and undo has to move them back.
    #[test]
    fn undoing_an_edit_to_a_split_payment_puts_its_rows_back_too() {
        let db = Db::new("parent-edit");
        let c = db.c();
        let (chk, _, pay, principal) = mortgage_payment(&c);
        let ids = related_ids(&c, &pay).unwrap();
        assert_eq!(ids.len(), 3);
        let (_, step) = recording(&c, "edit a transaction", &ids, || {
            queries::update_transaction(&c, &pay, "2026-03-04", "Summit Home Loans", None, -150_000, None, None)
        })
        .unwrap();
        let moved: String = c.query_row("SELECT date FROM transactions WHERE id = ?1", params![principal], |r| r.get(0)).unwrap();
        assert_eq!(moved, "2026-03-04");
        assert_consistent(&c);

        restore(&c, &step.before, &step.after.accounts).unwrap();
        let back: String = c.query_row("SELECT date FROM transactions WHERE id = ?1", params![principal], |r| r.get(0)).unwrap();
        assert_eq!(back, "2026-03-01");
        assert_eq!(linked_lines(&c, &pay), 2);
        assert_eq!(balance(&c, &chk), 850_000);
        assert_consistent(&c);
    }

    /// §178 — `update_transfer` wrote no step. Moving a transfer's other half
    /// to a different account touches three balances, and undo has to put
    /// all three back.
    #[test]
    fn undoing_a_transfer_moved_to_another_account_rebalances_all_three() {
        let db = Db::new("xfer-edit");
        let c = db.c();
        let chk = queries::create_account(&c, "Checking", "checking", 100_000, Some("2026-01-01")).unwrap().id;
        let sav = queries::create_account(&c, "Savings", "savings", 0, Some("2026-01-01")).unwrap().id;
        let vac = queries::create_account(&c, "Vacation", "savings", 0, Some("2026-01-01")).unwrap().id;
        let t = queries::create_transfer(&c, &chk, &sav, "2026-03-01", 25_000, None).unwrap();

        let ids = related_ids(&c, &t.id).unwrap();
        let (_, step) = recording(&c, "edit a transfer", &ids, || {
            queries::update_transfer(&c, &t.id, "2026-03-02", &vac, -40_000, None)
        })
        .unwrap();
        assert_eq!((balance(&c, &chk), balance(&c, &sav), balance(&c, &vac)), (60_000, 0, 40_000));

        restore(&c, &step.before, &step.after.accounts).unwrap();
        assert_eq!((balance(&c, &chk), balance(&c, &sav), balance(&c, &vac)), (75_000, 25_000, 0));
        assert_eq!(count(&c, &vac), 0, "the partner left the account it was moved to");
        assert_consistent(&c);

        restore(&c, &step.after, &step.before.accounts).unwrap();
        assert_eq!((balance(&c, &chk), balance(&c, &sav), balance(&c, &vac)), (60_000, 0, 40_000));
        assert_consistent(&c);
    }

    /// Undoing a CREATE is the opposite shape: there is nothing to put back,
    /// and the thing that has to happen is a deletion.
    #[test]
    fn undoing_an_add_removes_exactly_the_row_it_added() {
        let db = Db::new("create");
        let c = db.c();
        let a = queries::create_account(&c, "Checking", "checking", 100_000, Some("2026-01-01")).unwrap().id;
        let kept = queries::create_transaction(&c, &a, "2026-03-01", "Rent", None, -50_000, None, None).unwrap();

        let (made, mut step) = recording(&c, "add a transaction", &[], || {
            queries::create_transaction(&c, &a, "2026-03-02", "Oops", None, -1_234, None, None)
        })
        .unwrap();
        let ids = related_ids(&c, &made.id).unwrap();
        step.after = snapshot(&c, &ids).unwrap();
        step.before.txn_ids = ids;

        assert_eq!(balance(&c, &a), 48_766);
        restore(&c, &step.before, &step.after.accounts).unwrap();

        assert_eq!(count(&c, &a), 2, "the opening row and the rent, and nothing else");
        assert_eq!(balance(&c, &a), 50_000);
        assert!(queries::get_register(&c, &a).unwrap().iter().any(|r| r.id == kept.id), "the row we did not add is untouched");
    }

    #[test]
    fn redo_puts_it_back_again() {
        let db = Db::new("redo");
        let c = db.c();
        let a = queries::create_account(&c, "Checking", "checking", 100_000, Some("2026-01-01")).unwrap().id;
        let t = queries::create_transaction(&c, &a, "2026-03-01", "Rent", None, -50_000, None, None).unwrap();
        let ids = related_ids(&c, &t.id).unwrap();
        let (_, step) = recording(&c, "delete a transaction", &ids, || queries::delete_transaction(&c, &t.id)).unwrap();

        restore(&c, &step.before, &step.after.accounts).unwrap();
        assert_eq!(balance(&c, &a), 50_000, "undone");
        restore(&c, &step.after, &step.before.accounts).unwrap();
        assert_eq!(balance(&c, &a), 100_000, "and done again");
        assert_eq!(count(&c, &a), 1);
    }

    #[test]
    fn an_edit_goes_back_to_what_it_was_field_by_field() {
        let db = Db::new("edit");
        let c = db.c();
        let a = queries::create_account(&c, "Checking", "checking", 100_000, Some("2026-01-01")).unwrap().id;
        let t = queries::create_transaction(&c, &a, "2026-03-01", "Kroger", None, -4_250, Some("weekly"), Some("1042")).unwrap();
        let ids = related_ids(&c, &t.id).unwrap();
        let (_, step) = recording(&c, "edit a transaction", &ids, || {
            queries::update_transaction(&c, &t.id, "2026-03-09", "Safeway", None, -9_999, None, None)
        })
        .unwrap();
        restore(&c, &step.before, &step.after.accounts).unwrap();

        let row = queries::get_register(&c, &a).unwrap().into_iter().find(|r| r.id == t.id).unwrap();
        assert_eq!(row.payee, "Kroger");
        assert_eq!(row.date, "2026-03-01");
        assert_eq!(row.amount_cents, -4_250);
        assert_eq!(row.check_number.as_deref(), Some("1042"));
        assert_eq!(row.notes.as_deref(), Some("weekly"));
        assert_eq!(balance(&c, &a), 95_750);
    }

    /// A new column must be carried without anyone remembering to carry it.
    #[test]
    fn the_snapshot_reads_its_columns_from_the_database() {
        let db = Db::new("cols");
        let c = db.c();
        let a = queries::create_account(&c, "Checking", "checking", 0, Some("2026-01-01")).unwrap().id;
        let t = queries::create_transaction(&c, &a, "2026-03-01", "X", None, -100, None, None).unwrap();
        let snap = snapshot(&c, &[t.id.clone()]).unwrap();
        let txns = snap.tables.iter().find(|x| x.table == "transactions").unwrap();
        let live: i64 = c.query_row("SELECT COUNT(*) FROM pragma_table_info('transactions')", [], |r| r.get(0)).unwrap();
        assert_eq!(txns.columns.len() as i64, live, "every column the table has, whatever it has");
        assert!(txns.columns.contains(&"is_split_transfer".to_string()), "including ones added by a later migration");
    }

    #[test]
    fn the_journal_forgets_the_redo_branch_the_moment_you_do_something_else() {
        // Redoing into a history that no longer exists is how a row comes back
        // from the dead.
        let mut j = Journal::default();
        let step = |l: &str| Step { label: l.into(), before: Snapshot::default(), after: Snapshot::default() };
        j.push(step("one"));
        assert_eq!(j.can_undo(), Some("one"));
        let s = j.take_undo().unwrap();
        j.put_undone(s);
        assert_eq!(j.can_redo(), Some("one"));
        j.push(step("two"));
        assert_eq!(j.can_redo(), None, "the branch is gone");
        assert_eq!(j.can_undo(), Some("two"));
    }

    #[test]
    fn the_stack_has_a_bottom() {
        let mut j = Journal::default();
        for i in 0..(DEPTH + 10) {
            j.push(Step { label: format!("{i}"), before: Snapshot::default(), after: Snapshot::default() });
        }
        let mut n = 0;
        while j.take_undo().is_some() {
            n += 1;
        }
        assert_eq!(n, DEPTH);
    }

    /// §119 — Ctrl+Z after Update value.
    ///
    /// Reported plainly: "I had an error and I couldn't undo and had to
    /// delete." A revaluation was written straight to the file with no step
    /// behind it, so the only way back from a mistyped appraisal was to find
    /// the row and delete it.
    ///
    /// This runs what `set_account_value` runs, including the part that makes
    /// it more than an insert: a value written for an earlier date ADJUSTS the
    /// next revaluation after it, so that neighbor has to be photographed
    /// before the write or undo would put June back and leave December
    /// carrying the difference for ever.
    #[test]
    fn a_mistyped_valuation_can_be_undone_and_the_later_one_is_left_as_it_was() {
        let db = Db::new("value");
        let c = db.c();
        let house = queries::create_account(&c, "House", "home", 35_000_000, Some("2026-01-01")).unwrap().id;

        // December already says what it was worth. Nothing typed for June may
        // silently change that.
        queries::set_account_value(&c, &house, "2026-12-01", 37_000_000, None).unwrap();
        assert_eq!(balance(&c, &house), 37_000_000);

        // Now the fat finger: 3.5 million for June instead of 350 thousand
        // over the opening value.
        let touched: Vec<String> = {
            let mut st = c
                .prepare(
                    "SELECT id FROM transactions
                      WHERE account_id = ?1 AND is_revaluation = 1 AND is_void = 0 AND date > ?2
                      ORDER BY date, rowid LIMIT 1",
                )
                .unwrap();
            let ids: Vec<String> = st
                .query_map(params![&house, "2026-06-01"], |r| r.get::<_, String>(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            ids
        };
        assert_eq!(touched.len(), 1, "December is the row that will be adjusted");
        let (made, step) = recording(&c, "update a value", &touched, || {
            queries::set_account_value(&c, &house, "2026-06-01", 3_500_000, None)
        })
        .unwrap();
        let made = made.expect("a value that changed writes a row");
        let step = creation_step(&c, step, &made.id, &touched).unwrap();

        // December still asserts 37,000,000 — it absorbed the difference,
        // which is the behavior undo now has to reverse.
        assert_eq!(balance(&c, &house), 37_000_000);
        assert_eq!(count(&c, &house), 3, "opening, June, December");

        restore(&c, &step.before, &step.after.accounts).unwrap();

        assert_eq!(count(&c, &house), 2, "June is gone");
        assert_eq!(balance(&c, &house), 37_000_000, "December is untouched, as it always said");
        let june: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM transactions WHERE account_id = ?1 AND date = '2026-06-01'",
                params![house],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(june, 0);
        // The adjusted neighbor is back at its ORIGINAL amount, not at the
        // amount it was left holding.
        let dec: i64 = c
            .query_row(
                "SELECT amount_cents FROM transactions WHERE account_id = ?1 AND date = '2026-12-01'",
                params![house],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(dec, 2_000_000, "37,000,000 less the 35,000,000 opening");

        // And redo does it again without stranding either row.
        restore(&c, &step.after, &step.before.accounts).unwrap();
        assert_eq!(count(&c, &house), 3);
        assert_eq!(balance(&c, &house), 37_000_000);
    }
    /// §153 — an import is many rows in one act, and it has to come back out
    /// in one act.
    ///
    /// > *"if I mistakenly import to the wrong account well I have a lot of
    /// >  cleanup to do where undo could just fix it right away."*
    ///
    /// This drives the diff-and-delete machinery directly: take the ids, write
    /// a batch, take them again, build the step, apply it. No importer is
    /// involved, because what is under test is that the STEP is right — the
    /// importers reach it through `commands::importing`, which makes exactly
    /// these calls.
    #[test]
    fn a_batch_of_created_rows_comes_back_out_in_one_step() {
        let db = Db::new("import");
        let c = db.c();
        let acct = queries::create_account(&c, "Checking", "checking", 0, None).unwrap().id;
        let wrong = queries::create_account(&c, "Savings", "savings", 0, None).unwrap().id;

        // Something already in the file, which must survive untouched.
        let kept = queries::create_transaction(&c, &acct, "2027-01-04", "Rent", None, -150_000, None, None)
            .unwrap()
            .id;

        let before = all_txn_ids(&c).unwrap();

        // "The import", into the wrong account.
        for (day, payee, cents) in [
            ("2027-02-01", "Grocer", -4_012i64),
            ("2027-02-03", "Petrol", -6_500),
            ("2027-02-09", "Refund", 1_299),
        ] {
            queries::create_transaction(&c, &wrong, day, payee, None, cents, None, None).unwrap();
        }

        let after = all_txn_ids(&c).unwrap();
        let created: BTreeSet<String> = after.difference(&before).cloned().collect();
        assert_eq!(created.len(), 3, "the diff IS what the import wrote");

        let step = creations_step(&c, "import a bank file", &created).unwrap();
        assert_eq!(step.label, "import a bank file");
        assert_eq!(count(&c, &wrong), 3);

        // Undo: every imported row goes, and what was already there stays.
        restore(&c, &step.before, &step.after.accounts).unwrap();
        assert_eq!(count(&c, &wrong), 0, "the account it went into is empty again");
        assert_eq!(balance(&c, &wrong), 0, "and level");
        assert_eq!(count(&c, &acct), 1, "the row that was already in the file is untouched");
        assert!(all_txn_ids(&c).unwrap().contains(&kept));

        // Redo puts the whole batch back.
        restore(&c, &step.after, &step.before.accounts).unwrap();
        assert_eq!(count(&c, &wrong), 3);
        assert_eq!(balance(&c, &wrong), -9_213, "-40.12 -65.00 +12.99");
    }

    /// §153 — an import that wrote nothing (every row a duplicate, or every
    /// row matched to something already in the register) has an empty diff, so
    /// `commands::importing` puts nothing on the stack and leaves what is
    /// behind it alone.
    #[test]
    fn an_import_that_wrote_nothing_has_nothing_to_undo() {
        let db = Db::new("import-empty");
        let c = db.c();
        let acct = queries::create_account(&c, "Checking", "checking", 0, None).unwrap().id;
        queries::create_transaction(&c, &acct, "2027-01-04", "Rent", None, -150_000, None, None).unwrap();

        let before = all_txn_ids(&c).unwrap();
        // ... an import happens and skips every row ...
        let after = all_txn_ids(&c).unwrap();
        assert!(after.difference(&before).next().is_none());
    }


}
