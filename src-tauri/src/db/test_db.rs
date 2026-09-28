//! §182 — the one throwaway database the tests write money into, and the
//! whole-file check every one of them ends with.
//!
//! Before this there were nine copies of the same helper, and each test
//! asserted the number or two it was written about. None of them looked at
//! the rest of the file, which is how 460-odd tests passed over the thirty
//! real bugs the review of 2026-09-15 found: a balance one account off, a
//! transfer missing its other half, a split line whose far row disagreed —
//! all invisible to a test asserting the other account's balance.
//!
//! So the check lives in `Drop`, where nobody can forget it: when the test is
//! over, `queries::verify_file` (§83, §177) reads the whole file back and the
//! test fails if anything it reports is wrong. A test that corrupts the file
//! on purpose says so, with its reason, through `expect_inconsistent`.

#![cfg(test)]

use crate::db::{pool, queries};
use std::cell::Cell;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

/// A real SQLCipher file in its own temp dir, migrated and seeded by the same
/// `init_pool` the app uses, checked and deleted when the test ends.
pub struct TestDb {
    pub dir: PathBuf,
    pub pool: pool::DbPool,
    /// Why this test leaves the file inconsistent on purpose, if it does.
    inconsistent: Cell<Option<&'static str>>,
}

impl TestDb {
    pub fn new(tag: &str) -> Self {
        // The counter as well as the clock: two tests with one tag can start
        // in the same tick on Windows, and would then share a file.
        static N: AtomicU64 = AtomicU64::new(0);
        let mut dir = std::env::temp_dir();
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let n = N.fetch_add(1, Ordering::Relaxed);
        dir.push(format!("t-money-test-{}-{}-{}-{}", tag, std::process::id(), nanos, n));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let pool = pool::init_pool(&dir.join("test.db"), "test-key").expect("init_pool");
        TestDb { dir, pool, inconsistent: Cell::new(None) }
    }

    pub fn conn(&self) -> queries::Conn {
        self.pool.get().expect("pooled connection")
    }

    /// This test builds a file `verify_file` should object to — raw SQL that
    /// breaks a balance or a link, to prove something notices. Skips the
    /// check at the end. The reason is required and is the review: an
    /// opt-out on a test that should be consistent hides a bug.
    pub fn expect_inconsistent(&self, why: &'static str) {
        assert!(!why.trim().is_empty(), "say why this file is inconsistent on purpose");
        self.inconsistent.set(Some(why));
    }
}

impl Drop for TestDb {
    fn drop(&mut self) {
        // The check first and the cleanup after, whatever the check says: a
        // panic inside `drop` would otherwise leave the temp dir behind.
        let report = if std::thread::panicking() || self.inconsistent.get().is_some() {
            None
        } else {
            check(&self.pool)
        };
        let _ = std::fs::remove_dir_all(&self.dir);
        if let Some(report) = report {
            panic!("§182: the test left the file inconsistent:\n{report}");
        }
    }
}

/// A `TestDb` less the standard chart `init_pool` seeds into an empty file,
/// for tests that control their own categories. Everything else, the check
/// at the end included, is the `TestDb` it derefs to.
pub struct EmptyChartDb(TestDb);

impl EmptyChartDb {
    pub fn new(tag: &str) -> Self {
        let db = TestDb::new(tag);
        // Children FIRST: `parent_id` is ON DELETE SET NULL, so deleting a
        // parent promotes its children mid-statement, and two promoted
        // children can then collide on the top-level unique index. This
        // exact failure is how the delete_category collision bug was found.
        let c = db.conn();
        c.execute("DELETE FROM categories WHERE parent_id IS NOT NULL", []).expect("clear subcategories");
        c.execute("DELETE FROM categories", []).expect("clear categories");
        drop(c);
        EmptyChartDb(db)
    }
}

impl std::ops::Deref for EmptyChartDb {
    type Target = TestDb;
    fn deref(&self) -> &TestDb {
        &self.0
    }
}

/// What is wrong with the file behind `pool`, or `None` when nothing is.
fn check(pool: &pool::DbPool) -> Option<String> {
    let conn = match pool.get() {
        Ok(c) => c,
        Err(e) => return Some(format!("  the file did not open for the check: {e}")),
    };
    match queries::verify_file(&conn, false) {
        Ok(v) => problems(&v),
        Err(e) => Some(format!("  verify_file failed: {e}")),
    }
}

/// The same check for a file no `TestDb` owns — a pool a test built itself,
/// or an in-memory migration fixture. Panics with the report.
pub fn assert_consistent(conn: &rusqlite::Connection) {
    let v = queries::verify_file(conn, false).expect("verify_file");
    if let Some(report) = problems(&v) {
        panic!("§182: the file is inconsistent:\n{report}");
    }
}

fn problems(v: &crate::models::FileCheck) -> Option<String> {
    let mut out = String::new();
    let mut section = |name: &str, lines: Vec<String>| {
        if !lines.is_empty() {
            out.push_str(&format!("  {name}:\n"));
            for l in lines {
                out.push_str(&format!("    {l}\n"));
            }
        }
    };
    section("integrity", v.integrity.clone());
    section("foreign_keys", v.foreign_keys.clone());
    section(
        "drift",
        v.drift
            .iter()
            .map(|d| format!("{}: stored {}, rows sum to {}", d.account_name, d.stored_cents, d.computed_cents))
            .collect(),
    );
    section("half_transfers", v.half_transfers.clone());
    section("split_mismatch", v.split_mismatch.clone());
    section("split_transfers", v.split_transfers.clone());
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}
