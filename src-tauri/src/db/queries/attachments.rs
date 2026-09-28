//! Attachments (§170): receipts, statements and photos on a transaction or an
//! account.

use crate::models::Attachment;
use rusqlite::{params, Row};
use uuid::Uuid;
use super::*;

// ---------------------------------------------------------------------------
// §170 — attachments: a receipt, a statement, a photo, on a transaction or
// an account. Bytes in `attachment_blobs`, the link in `attachments`.
// ---------------------------------------------------------------------------

/// The largest file that may be attached. Receipts and statements are
/// kilobytes to a few megabytes; a backup copies every byte of every
/// attachment, ten times over by default, so the cap is a kindness.
pub const MAX_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;

fn map_attachment(r: &Row) -> rusqlite::Result<Attachment> {
    Ok(Attachment {
        id: r.get(0)?,
        transaction_id: r.get(1)?,
        account_id: r.get(2)?,
        name: r.get(3)?,
        mime: r.get(4)?,
        size_bytes: r.get(5)?,
        added_at: r.get(6)?,
    })
}

const ATTACHMENT_COLS: &str = "id, transaction_id, account_id, name, mime, size_bytes, added_at";

/// What is attached to one transaction or one account, oldest first.
pub fn list_attachments(conn: &Conn, transaction_id: Option<&str>, account_id: Option<&str>) -> Result<Vec<Attachment>, String> {
    let (col, id) = match (transaction_id, account_id) {
        (Some(t), _) => ("transaction_id", t),
        (None, Some(a)) => ("account_id", a),
        (None, None) => return Err("say which transaction or account".to_string()),
    };
    let mut st = conn
        .prepare(&format!("SELECT {ATTACHMENT_COLS} FROM attachments WHERE {col} = ?1 ORDER BY added_at, rowid"))
        .map_err(|e| e.to_string())?;
    let out = st
        .query_map(params![id], map_attachment)
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(out)
}

pub fn get_attachment(conn: &Conn, id: &str) -> Result<Attachment, String> {
    conn.query_row(&format!("SELECT {ATTACHMENT_COLS} FROM attachments WHERE id = ?1"), params![id], map_attachment)
        .map_err(|e| format!("attachment {id} not found: {e}"))
}

/// Attach `data` as `name` to a transaction or an account: the bytes and the
/// link in one SQL transaction. Refuses an empty file, one over the cap, and
/// a target that does not exist (the foreign key would anyway, less kindly).
pub fn add_attachment(
    conn: &Conn,
    transaction_id: Option<&str>,
    account_id: Option<&str>,
    name: &str,
    mime: &str,
    data: &[u8],
) -> Result<Attachment, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("the file has no name".to_string());
    }
    if data.is_empty() {
        return Err("the file is empty".to_string());
    }
    if data.len() > MAX_ATTACHMENT_BYTES {
        return Err(format!("{name} is {} MB; attachments are limited to {} MB", data.len() / (1024 * 1024), MAX_ATTACHMENT_BYTES / (1024 * 1024)));
    }
    match (transaction_id, account_id) {
        (Some(t), None) => {
            let n: i64 = conn.query_row("SELECT COUNT(*) FROM transactions WHERE id = ?1", params![t], |r| r.get(0)).map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("that transaction does not exist".to_string());
            }
        }
        (None, Some(a)) => {
            let n: i64 = conn.query_row("SELECT COUNT(*) FROM accounts WHERE id = ?1", params![a], |r| r.get(0)).map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("that account does not exist".to_string());
            }
        }
        _ => return Err("attach to one transaction or one account".to_string()),
    }
    let blob_id = Uuid::new_v4().to_string();
    let id = Uuid::new_v4().to_string();
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO attachment_blobs (id, data) VALUES (?1, ?2)", params![blob_id, data]).map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO attachments (id, blob_id, transaction_id, account_id, name, mime, size_bytes) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, blob_id, transaction_id, account_id, name, mime, data.len() as i64],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    get_attachment(conn, &id)
}

/// The bytes, with what they are.
pub fn attachment_bytes(conn: &Conn, id: &str) -> Result<(Attachment, Vec<u8>), String> {
    let a = get_attachment(conn, id)?;
    let data: Vec<u8> = conn
        .query_row("SELECT b.data FROM attachments a JOIN attachment_blobs b ON b.id = a.blob_id WHERE a.id = ?1", params![id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    Ok((a, data))
}

/// Remove the link. The bytes stay until the file is next opened, so that
/// Ctrl+Z can put the link back pointing at them (undo photographs the link,
/// never the bytes).
pub fn remove_attachment(conn: &Conn, id: &str) -> Result<(), String> {
    let n = conn.execute("DELETE FROM attachments WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("attachment {id} not found"));
    }
    Ok(())
}

/// Bytes nothing points at any more — a removed attachment, or one that went
/// with a deleted transaction — once undo can no longer want them back.
/// Called when a file is opened, which is when the undo history is let go.
pub fn sweep_orphan_attachment_blobs(conn: &Conn) -> Result<usize, String> {
    conn.execute("DELETE FROM attachment_blobs WHERE id NOT IN (SELECT blob_id FROM attachments)", [])
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::queries::test_support::*;

    // §170 — a receipt on a transaction and a statement on an account: the
    // bytes in the file, the link photographed by undo, the orphans swept.
    #[test]
    fn attachments_are_stored_listed_returned_removed_and_survive_an_undone_delete() {
        use crate::db::undo;
        let db = TestDb::new("attach");
        let c = db.conn();
        let chk = account(&c, "Checking", 100_000);
        let t = create_transaction(&c, &chk, "2026-09-13", "Home Depot", None, -4_250, None, None).unwrap();
        let pdf = b"%PDF-1.4 receipt".to_vec();
        let a = add_attachment(&c, Some(&t.id), None, "receipt.pdf", "application/pdf", &pdf).unwrap();
        assert_eq!((a.name.as_str(), a.mime.as_str(), a.size_bytes), ("receipt.pdf", "application/pdf", pdf.len() as i64));
        let s = add_attachment(&c, None, Some(&chk), "statement.pdf", "application/pdf", b"%PDF statement").unwrap();
        assert_eq!(list_attachments(&c, Some(&t.id), None).unwrap().len(), 1);
        assert_eq!(list_attachments(&c, None, Some(&chk)).unwrap().iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), vec![s.id.as_str()]);
        let (got, bytes) = attachment_bytes(&c, &a.id).unwrap();
        assert_eq!((got.id, bytes), (a.id.clone(), pdf.clone()));
        // The register counts it.
        assert_eq!(get_register(&c, &chk).unwrap().iter().find(|r| r.id == t.id).unwrap().attachment_count, 1);
        // Refusals: empty, nowhere, both, and a target that is not there.
        assert!(add_attachment(&c, Some(&t.id), None, "x.txt", "text/plain", b"").unwrap_err().contains("empty"));
        assert!(add_attachment(&c, None, None, "x.txt", "text/plain", b"a").is_err());
        assert!(add_attachment(&c, Some(&t.id), Some(&chk), "x.txt", "text/plain", b"a").is_err());
        assert!(add_attachment(&c, Some("nope"), None, "x.txt", "text/plain", b"a").unwrap_err().contains("does not exist"));

        // Delete the transaction, undo it: the receipt is back, bytes intact.
        let ids = undo::related_ids(&c, &t.id).unwrap();
        let ((), step) = undo::recording(&c, "delete a transaction", &ids, || delete_transaction(&c, &t.id)).unwrap();
        assert!(list_attachments(&c, Some(&t.id), None).unwrap().is_empty(), "cascaded with the row");
        undo::restore(&c, &step.before, &step.after.accounts).unwrap();
        let back = list_attachments(&c, Some(&t.id), None).unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(attachment_bytes(&c, &back[0].id).unwrap().1, pdf);

        // Removing keeps the bytes for undo's sake; opening the file sweeps them.
        remove_attachment(&c, &a.id).unwrap();
        assert!(list_attachments(&c, Some(&t.id), None).unwrap().is_empty());
        let blobs = |c: &Conn| c.query_row("SELECT COUNT(*) FROM attachment_blobs", [], |r| r.get::<_, i64>(0)).unwrap();
        assert_eq!(blobs(&c), 2, "the receipt's bytes are still there");
        assert_eq!(sweep_orphan_attachment_blobs(&c).unwrap(), 1);
        assert_eq!(blobs(&c), 1, "only the statement's bytes remain");
        assert!(remove_attachment(&c, &a.id).is_err(), "already gone");
    }
}
