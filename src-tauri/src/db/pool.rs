//! Encrypted SQLite connection pool.
//!
//! Uses `r2d2` + `r2d2_sqlite` with `rusqlite` compiled against SQLCipher
//! (`bundled-sqlcipher-vendored-openssl`). The AES-256 encryption key is applied
//! via `PRAGMA key` on **every** connection the pool opens, through the
//! `SqliteConnectionManager::with_init` hook — which runs immediately after the
//! raw connection is created, before any other statement. That ordering is
//! mandatory for SQLCipher: the key must be the first thing sent to a new
//! connection.

use crate::db::migrations;
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::Connection;
use std::path::Path;
use std::sync::Arc;

/// A pooled, encrypted SQLite connection.
pub type DbPool = Pool<SqliteConnectionManager>;

/// Build a connection manager that applies the SQLCipher key and sane pragmas
/// to every new connection.
fn manager_for(path: &Path, key: &str) -> SqliteConnectionManager {
    // Capture the key by value so the closure is 'static + Send + Sync.
    let key = key.to_string();
    SqliteConnectionManager::file(path)
        .with_init(move |conn: &mut Connection| {
            // 1) The encryption key MUST be the first statement.
            //    SQLCipher accepts the key as a string literal.
            conn.execute_batch(&format!("PRAGMA key = '{}';", key.replace('\'', "''")))?;
            // 2) WAIT for a lock instead of failing on it.
            //
            //    SQLite's default `busy_timeout` is ZERO: a connection that
            //    meets a lock gives up instantly with "database is locked".
            //    This pool opens up to eight connections against one file, so
            //    that is not a rare case — it is any two things happening at
            //    once. It surfaced as a flaky test (two demo seeds in a row,
            //    one failing in `init_pool` before a single row was written),
            //    but the same race is a report running while an import writes,
            //    or the price timer firing mid-edit, and the user would have
            //    seen a bare "database is locked" for something that needed to
            //    wait a few milliseconds.
            //
            //    Set BEFORE `journal_mode = WAL` below, deliberately: taking a
            //    database into WAL needs a brief exclusive lock, and that is
            //    the statement that was losing the race.
            conn.execute_batch("PRAGMA busy_timeout = 5000;")?;
            // 3) Verify the key is correct by touching the schema. A wrong key
            //    makes the file look like "file is not a database".
            conn.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(()))?;
            // 4) Integrity / performance pragmas.
            conn.execute_batch(
                "PRAGMA foreign_keys = ON;
                 PRAGMA journal_mode = WAL;
                 PRAGMA synchronous = NORMAL;
                 PRAGMA temp_store = MEMORY;",
            )?;
            Ok(())
        })
}

/// Open (or create) the encrypted database at `path`, apply the key, run any
/// pending migrations, and return a ready connection pool.
///
/// `key` is the AES-256 passphrase. It is never written to disk — only the
/// encrypted database file is.
pub fn init_pool(path: &Path, key: &str) -> Result<DbPool, String> {
    // Ensure the parent directory exists.
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create data dir {}: {e}", parent.display()))?;
        }
    }

    let manager = manager_for(path, key);
    let pool = Pool::builder()
        .max_size(8)
        .min_idle(Some(1))
        .build(manager)
        .map_err(|e| format!("failed to build DB pool: {e}"))?;

    // Run migrations on a single connection.
    let mut conn = pool
        .get()
        .map_err(|e| format!("failed to acquire connection for migration: {e}"))?;
    let applied = migrations::migrate(&mut conn)
        .map_err(|e| format!("migration failed: {e}"))?;

    // A brand-new file starts with Money's standard chart of categories.
    // Money does the same, and an empty category list makes every picker in
    // the app useless — the Budget screen in particular offers nothing to
    // budget against. Only ever on a genuinely empty table: an existing file
    // is left alone, and the user pulls in what they want from the Categories
    // manager instead.
    if crate::db::standard_categories::is_empty(&conn)? {
        let n = crate::db::standard_categories::seed(&conn)?;
        eprintln!("[t-money] new database — seeded {n} standard categories");
    }
    drop(conn);

    eprintln!("[t-money] encrypted DB ready at {} ({} migration(s) applied)", path.display(), applied);
    Ok(pool)
}

/// Re-encrypt the database file with a new key.
///
/// **This is what makes changing the master key safe.** Storing a new key in
/// the OS keyring does NOT re-encrypt anything: SQLCipher needs an explicit
/// `PRAGMA rekey`. Without it, the next launch opens a file encrypted with the
/// old key using the new one and fails — and since the old key was never shown
/// to the user, the file is unrecoverable. That was the behavior of
/// `set_master_key` before this was fixed.
///
/// Deliberately takes a PATH rather than a pooled connection: the pool holds up
/// to eight connections already keyed with the old passphrase, and rekeying
/// under them leaves the rest stale. The caller drops the pool first, this
/// opens one connection, rekeys, and closes it.
pub fn rekey_file(path: &Path, old_key: &str, new_key: &str) -> Result<(), String> {
    if new_key.trim().is_empty() {
        return Err("the new master key cannot be empty".to_string());
    }
    let conn = Connection::open(path).map_err(|e| format!("could not open the database: {e}"))?;
    conn.execute_batch(&format!("PRAGMA key = '{}';", old_key.replace('\'', "''")))
        .map_err(|e| format!("could not unlock the database: {e}"))?;
    // Prove the old key was right before rekeying: PRAGMA rekey on a file we
    // cannot read would produce a file nobody can read.
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(()))
        .map_err(|_| "the current master key does not open this database".to_string())?;
    conn.execute_batch(&format!("PRAGMA rekey = '{}';", new_key.replace('\'', "''")))
        .map_err(|e| format!("re-encrypting the database failed: {e}"))?;
    drop(conn);
    Ok(())
}

/// Prove that `key` opens the SQLCipher file at `path`, without changing
/// anything. Used before a restore replaces the live database: a backup that
/// will not open with the key on offer must be refused BEFORE the real file
/// is touched, not discovered afterwards with the original already gone.
pub fn verify_key(path: &Path, key: &str) -> Result<(), String> {
    let conn = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("could not open {}: {e}", path.display()))?;
    conn.execute_batch(&format!("PRAGMA key = '{}';", key.replace('\'', "''")))
        .map_err(|e| format!("could not apply the key: {e}"))?;
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(()))
        .map_err(|_| "that key does not open this file".to_string())?;
    Ok(())
}

/// Convenience: get a connection from the pool.
pub fn get(pool: &DbPool) -> Result<r2d2::PooledConnection<SqliteConnectionManager>, String> {
    pool.get().map_err(|e| format!("pool error: {e}"))
}

/// Wrap the pool in an `Arc` for cheap sharing across Tauri state.
pub type SharedPool = Arc<DbPool>;

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Every connection the pool hands out waits for a lock rather
    /// than failing on it.
    ///
    /// The race itself cannot be tested deterministically; that the pragma is
    /// actually ON every connection can be, and that is the part that was
    /// missing. SQLite's default is 0, so an assertion of 5000 is an
    /// assertion that this was set on purpose.
    #[test]
    fn every_connection_waits_for_a_lock_instead_of_failing_on_it() {
        let dir = tmp_dir("busy");
        let pool = init_pool(&dir.join("busy.db"), "test-key").expect("init_pool");
        // Not just the first connection — `min_idle` means one is opened
        // eagerly and the rest lazily, and they all need it.
        for _ in 0..3 {
            let conn = pool.get().expect("conn");
            let ms: i64 = conn
                .query_row("PRAGMA busy_timeout", [], |r| r.get(0))
                .expect("busy_timeout");
            assert_eq!(ms, 5000, "SQLite defaults this to 0 — a lock would fail instantly");
        }
        crate::db::test_db::assert_consistent(&get(&pool).expect("conn"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An account and the row its balance comes from, so the file
    /// these tests write is one `verify_file` agrees with.
    fn account_with_row(conn: &rusqlite::Connection, id: &str, name: &str, kind: &str, cents: i64) {
        conn.execute(
            "INSERT INTO accounts (id, name, type, balance_cents) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![id, name, kind, cents],
        )
        .expect("insert account");
        conn.execute(
            "INSERT INTO transactions (id, account_id, date, payee, amount_cents) VALUES (?1, ?2, '2026-01-01', 'Opening Balance', ?3)",
            rusqlite::params![format!("{id}-open"), id, cents],
        )
        .expect("insert its row");
    }

    fn tmp_dir(tag: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("t-money-test-{}-{}", tag, std::process::id()));
        let _ = std::fs::create_dir_all(&p);
        p
    }

    /// Prove the database file on disk is genuinely encrypted:
    /// 1. Its first 16 bytes are NOT the plaintext "SQLite format 3\0" magic.
    /// 2. A correct key can read the schema; a wrong key cannot.
    #[test]
    fn database_file_is_encrypted_on_disk() {
        let dir = tmp_dir("enc");
        let db = dir.join("test.db");
        let _ = std::fs::remove_file(&db);

        let key = "correct-horse-battery-staple";
        let pool = init_pool(&db, key).expect("init_pool with correct key");

        // 1) Raw bytes must not be the plaintext SQLite header.
        let bytes = std::fs::read(&db).expect("read db file");
        let magic = b"SQLite format 3\0";
        let is_plaintext = bytes.len() >= 16 && &bytes[0..16] == magic;
        assert!(
            !is_plaintext,
            "DB file starts with plaintext SQLite magic — encryption not applied"
        );

        // 2) Correct key reads the schema.
        let conn = get(&pool).expect("conn");
        let n: i64 = conn
            .query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get(0))
            .expect("schema readable with correct key");
        assert!(n > 0, "expected tables after migration");
        crate::db::test_db::assert_consistent(&conn);
        drop(conn);

        // 3) A wrong key must fail to open the same file.
        let wrong = init_pool(&db, "totally-wrong-key");
        assert!(
            wrong.is_err(),
            "wrong key unexpectedly opened the encrypted DB"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The exact sequence `commands::backup_database` runs, minus the Tauri
    /// `State` plumbing: `VACUUM INTO` a second file. What matters is that the
    /// copy is *also* encrypted — a backup that silently writes plaintext
    /// financial data to the user's Documents folder is the worst bug this
    /// app could ship, and nothing tested it.
    #[test]
    fn a_backup_is_encrypted_and_reopens_with_the_same_key() {
        let dir = tmp_dir("backup");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        let live = dir.join("live.db");
        let backup = dir.join("backup.db");
        let key = "correct-horse-battery-staple";

        let pool = init_pool(&live, key).expect("init_pool");
        {
            let conn = get(&pool).expect("conn");
            account_with_row(&conn, "a1", "Checking", "checking", 123_456);

            let escaped = backup.to_string_lossy().replace('\'', "''");
            conn.execute_batch(&format!("VACUUM INTO '{escaped}';"))
                .expect("VACUUM INTO");
        }

        // 1) The backup is a real file with content.
        let bytes = std::fs::read(&backup).expect("read backup");
        assert!(bytes.len() > 512, "backup is suspiciously small");

        // 2) It is NOT plaintext SQLite.
        assert!(
            bytes.len() < 16 || &bytes[0..16] != b"SQLite format 3\0",
            "the backup was written UNENCRYPTED — financial data in the clear"
        );

        // 3) The same key opens it and the data is there.
        let restored = init_pool(&backup, key).expect("open backup with the key");
        let conn = get(&restored).expect("conn");
        let cents: i64 = conn
            .query_row("SELECT balance_cents FROM accounts WHERE id = 'a1'", [], |r| r.get(0))
            .expect("account in the backup");
        assert_eq!(cents, 123_456);
        crate::db::test_db::assert_consistent(&conn);
        drop(conn);

        // 4) A wrong key does not.
        assert!(init_pool(&backup, "totally-wrong-key").is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `commands::restore_database` drops the pool, copies the backup over the
    /// live file, clears the `-wal`/`-shm` sidecars, then rebuilds the pool.
    /// This walks that sequence and asserts the file comes back *consistent* —
    /// the restored state wins and the post-backup edit is gone.
    #[test]
    fn a_restore_replaces_the_live_file_and_the_pool_comes_back_consistent() {
        let dir = tmp_dir("restore");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        let live = dir.join("live.db");
        let backup = dir.join("backup.db");
        let key = "correct-horse-battery-staple";

        let pool = init_pool(&live, key).expect("init_pool");
        {
            let conn = get(&pool).expect("conn");
            account_with_row(&conn, "a1", "Checking", "checking", 100_000);
            let escaped = backup.to_string_lossy().replace('\'', "''");
            conn.execute_batch(&format!("VACUUM INTO '{escaped}';"))
                .expect("backup");

            // Work done after the backup, which the restore must discard.
            conn.execute("UPDATE accounts SET balance_cents = 999 WHERE id = 'a1'", [])
                .expect("update");
            account_with_row(&conn, "a2", "Savings", "savings", 5_000);

            // Step 1 of the real restore: fold the WAL into the main file and
            // empty it while a connection still exists. Without this the
            // sidecar cannot be cleared (Windows keeps it locked) and SQLite
            // replays the pre-restore writes over the restored file.
            conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
                .expect("checkpoint");
        }

        // 2) Drop the pool to release the OS handles (Windows will not let the
        //    copy proceed otherwise — this ordering IS the feature).
        drop(pool);

        // 3) Clear the sidecars. Deletion is best-effort, but a NON-EMPTY wal
        //    here would be replayed over the restored file, so that is the
        //    condition worth asserting — it is exactly what failed before the
        //    checkpoint above was added.
        let live_str = live.to_string_lossy().to_string();
        for suffix in ["-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{live_str}{suffix}"));
        }
        let wal = format!("{live_str}-wal");
        let wal_len = std::fs::metadata(&wal).map(|m| m.len()).unwrap_or(0);
        assert_eq!(
            wal_len, 0,
            "a non-empty WAL survived and will be replayed over the restored file"
        );

        // 4) Copy the backup over the live file.
        std::fs::copy(&backup, &live).expect("copy backup over live");

        // 5) Rebuild the pool: same key, migrations re-run idempotently.
        let pool = init_pool(&live, key).expect("pool rebuilt after restore");
        let conn = get(&pool).expect("conn");

        let cents: i64 = conn
            .query_row("SELECT balance_cents FROM accounts WHERE id = 'a1'", [], |r| r.get(0))
            .expect("a1 survived the restore");
        assert_eq!(
            cents, 100_000,
            "the restore did not roll the balance back"
        );

        let a2: i64 = conn
            .query_row("SELECT count(*) FROM accounts WHERE id = 'a2'", [], |r| r.get(0))
            .expect("count");
        assert_eq!(a2, 0, "work done after the backup survived the restore");

        // The file is genuinely usable, not just readable: writes still work
        // and the migration bookkeeping is intact.
        conn.execute("UPDATE accounts SET name = 'Checking (restored)' WHERE id = 'a1'", [])
            .expect("the restored file is writable");
        let migrated: i64 = conn
            .query_row("SELECT count(*) FROM schema_migrations", [], |r| r.get(0))
            .expect("schema_migrations");
        assert!(migrated > 0, "migration ledger lost in the restore");
        crate::db::test_db::assert_consistent(&conn);

        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Restoring a file that is not a T-Money database (or is encrypted with a
    /// different key) must fail loudly at open time rather than leaving the
    /// user with a half-broken app.
    #[test]
    fn restoring_a_foreign_file_fails_at_open_rather_than_corrupting_silently() {
        let dir = tmp_dir("restore-bad");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        let live = dir.join("live.db");
        std::fs::write(&live, b"this is not a database").expect("write junk");

        assert!(
            init_pool(&live, "correct-horse-battery-staple").is_err(),
            "a junk file opened as if it were a database"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Changing the master key has to RE-ENCRYPT the file, not just remember a
    /// different passphrase. The app used to do the latter, which left a
    /// file only the old — and never-displayed — key could open.
    #[test]
    fn rekeying_re_encrypts_the_file_so_the_new_key_opens_it() {
        let dir = tmp_dir("rekey");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        let db = dir.join("live.db");

        let pool = init_pool(&db, "old-key").expect("init");
        {
            let conn = get(&pool).expect("conn");
            account_with_row(&conn, "a1", "Checking", "checking", 4_242);
        }
        drop(pool);

        rekey_file(&db, "old-key", "new-key").expect("rekey");

        // The new key opens it, and the data is intact.
        let pool = init_pool(&db, "new-key").expect("open with the new key");
        let conn = get(&pool).expect("conn");
        let cents: i64 = conn
            .query_row("SELECT balance_cents FROM accounts WHERE id = 'a1'", [], |r| r.get(0))
            .expect("row");
        assert_eq!(cents, 4242);
        crate::db::test_db::assert_consistent(&conn);
        drop(conn);
        drop(pool);

        // ...and the old one does not.
        assert!(init_pool(&db, "old-key").is_err(), "the old key still opens it");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rekeying_with_the_wrong_current_key_refuses_rather_than_destroying_the_file() {
        // The dangerous failure: rekeying a file you cannot read would produce
        // one nobody can read.
        let dir = tmp_dir("rekey-wrong");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        let db = dir.join("live.db");
        drop(init_pool(&db, "right-key").expect("init"));

        let err = rekey_file(&db, "wrong-key", "new-key").unwrap_err();
        assert!(err.contains("does not open"), "{err}");

        // The file still opens with its real key, and still agrees with itself.
        let pool = init_pool(&db, "right-key").expect("the file was damaged");
        crate::db::test_db::assert_consistent(&get(&pool).expect("conn"));
        drop(pool);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_empty_new_key_is_refused() {
        let dir = tmp_dir("rekey-empty");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dir");
        let db = dir.join("live.db");
        drop(init_pool(&db, "k").expect("init"));
        assert!(rekey_file(&db, "k", "   ").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
