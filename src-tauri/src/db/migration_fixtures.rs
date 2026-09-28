//! Migrations, tested against POPULATED databases at old versions.
//!
//! Every other test starts from an empty file migrated 0001→latest in one go,
//! which proves the SQL parses and nothing else. The case that matters is a
//! real file — rows in every table, written under an old schema — being
//! carried forward by a migration written months later. 0014 rebuilt the
//! budgets table; 0019 turned every payment into a rule; 0021 writes a row
//! into every account with a gap. A wrong one is silent, total, and found
//! months later.
//!
//! **How the fixtures work.** Rather than binary files checked in as bytes
//! (unreadable in a diff, encrypted, and a maintenance chore), each fixture is
//! built here: migrate an in-memory database to version N, insert rows with
//! the SQL that shape of schema accepted, migrate to the latest, and assert
//! the data survived — the same rows, the same money, the same links. The
//! fixture SQL is deliberately written against the OLD column names, so a
//! change to a historic migration that alters what the schema looked like at
//! that point breaks the fixture rather than silently passing.
//!
//! The one thing bytes would catch that this does not — someone editing the
//! SQL of a migration that has already shipped — is covered by
//! `historic_migration_sql_is_frozen`, which pins a hash of every shipped
//! migration. Adding a migration means adding a hash; changing one means
//! explaining why.
//!
//! **Every future migration gets a fixture at the version before it.**

#![cfg(test)]

use crate::db::migrations::{migrate_with, MIGRATIONS};
use rusqlite::{params, Connection};

/// An in-memory database migrated up to and including `version`.
fn db_at(version: &str) -> Connection {
    let mut conn = Connection::open_in_memory().expect("in-memory db");
    conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
    let upto = MIGRATIONS
        .iter()
        .position(|(v, _, _)| *v == version)
        .unwrap_or_else(|| panic!("no migration {version}"));
    migrate_with(&mut conn, &MIGRATIONS[..=upto]).expect("migrate to fixture version");
    conn
}

/// The rest of the way, plus the invariants every migrated file must meet.
fn migrate_to_latest(conn: &mut Connection) -> usize {
    let n = migrate_with(conn, MIGRATIONS).expect("migrate to latest");
    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .unwrap();
    assert_eq!(integrity, "ok");
    let dangling: i64 = {
        let mut st = conn.prepare("PRAGMA foreign_key_check").unwrap();
        st.query_map([], |_| Ok(())).unwrap().count() as i64
    };
    assert_eq!(dangling, 0, "migration left dangling foreign keys");
    let applied: i64 = count(conn, "schema_migrations");
    assert_eq!(applied as usize, MIGRATIONS.len(), "not every migration is in the ledger");
    // §182 — and the file agrees with itself the way the app checks it:
    // balances, transfer pairs, splits and split transfer rows.
    crate::db::test_db::assert_consistent(conn);
    n
}

fn count(conn: &Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}

fn one<T: rusqlite::types::FromSql>(conn: &Connection, sql: &str, p: &[&dyn rusqlite::ToSql]) -> T {
    conn.query_row(sql, p, |r| r.get(0)).unwrap()
}

/// After 0021 every account's balance equals the sum of its non-void rows.
/// This is the invariant the opening-balance row exists to restore.
fn assert_balances_agree(conn: &Connection) {
    let mut st = conn
        .prepare(
            "SELECT a.name, a.balance_cents,
                    COALESCE((SELECT SUM(t.amount_cents) FROM transactions t
                               WHERE t.account_id = a.id AND t.is_void = 0), 0)
               FROM accounts a",
        )
        .unwrap();
    let rows: Vec<(String, i64, i64)> = st
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    for (name, balance, summed) in rows {
        assert_eq!(balance, summed, "account {name}: balance {balance} vs rows {summed}");
    }
}

// ---------------------------------------------------------------------------
// 0005 — the original five tables: four account types, flat categories,
// budgets keyed by category NAME, one-off payments, investments without prices.
// ---------------------------------------------------------------------------

fn fixture_0005() -> Connection {
    let conn = db_at("0005");
    conn.execute_batch(
        r#"
        INSERT INTO accounts (id, name, type, balance_cents, is_favorite) VALUES
            ('a-chk', 'First National Checking', 'checking', 95750, 1),
            ('a-sav', 'Savings',       'savings',  50000, 0),
            ('a-cc',  'Visa',          'credit',  -12000, 0),
            ('a-cash','Wallet',        'cash',         0, 0);
        INSERT INTO categories (id, name) VALUES
            ('c-groc', 'Groceries'), ('c-fuel', 'Fuel'), ('c-pay', 'Paycheck'),
            ('c-ins',  'Insurance');
        -- checking: opened at 100000 by the wizard (no row), then two rows
        INSERT INTO transactions (id, account_id, date, payee, category_id, amount_cents, is_reconciled, notes) VALUES
            ('t-1', 'a-chk', '2025-11-03', 'Kroger',   'c-groc',  -4250, 1, 'weekly'),
            ('t-2', 'a-chk', '2025-11-05', 'Shell',    'c-fuel',  -3000, 0, NULL),
            ('t-3', 'a-chk', '2025-11-07', 'Acme Corp','c-pay',  300000, 1, NULL),
            ('t-4', 'a-cc',  '2025-11-08', 'Allstate', 'c-ins',  -12000, 0, NULL),
            ('t-5', 'a-chk', '2025-11-09', 'Kroger',   NULL,      -1500, 0, 'uncategorized');
        -- one budget for a category that exists, one that names a category
        -- that does NOT exist: 0014 must create it rather than drop the row
        INSERT INTO budgets (id, category_name, target_cents, month_year) VALUES
            ('b-1', 'Groceries', 60000, '2025-11'),
            ('b-2', 'Dining',    20000, '2025-11');
        INSERT INTO goals (id, name, target_cents, saved_cents, deadline) VALUES
            ('g-1', 'Truck tires', 120000, 40000, '2026-03-01');
        INSERT INTO payments (id, payee, amount_cents, due_date, status, notes) VALUES
            ('p-1', 'City Power & Light', 14200, '2025-11-20', 'due',     NULL),
            ('p-2', 'Comcast',      8999, '2025-11-15', 'paid',    'autopay'),
            ('p-3', 'Old gym',      3500, '2025-11-01', 'skipped', NULL);
        INSERT INTO investments (id, name, symbol, quantity, avg_cost_cents, current_value_cents) VALUES
            ('i-1', 'Vanguard Total', 'VTSAX', '12.5', 150000, 180000);
        "#,
    )
    .unwrap();
    conn
}

#[test]
fn a_0005_file_carries_every_row_to_the_latest_schema() {
    let mut conn = fixture_0005();
    migrate_to_latest(&mut conn);

    // Nothing lost. 0022 turns the one holding into a security, a lot in an
    // account made for it, and a price-history row for nothing (it was never
    // priced) — so 4 accounts become 5.
    assert_eq!(count(&conn, "accounts"), 5);
    assert_eq!(count(&conn, "categories") , 5, "0014 creates 'Dining' for the orphan budget");
    assert_eq!(count(&conn, "goals"), 1);
    assert_eq!(count(&conn, "securities"), 1);
    assert_eq!(count(&conn, "security_prices"), 0);
    let (shares, cost, acct): (i64, i64, String) = conn
        .query_row(
            "SELECT shares_micro, gross_cents, account_id FROM transactions WHERE activity = 'add_shares'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!((shares, cost, acct.as_str()), (12_500_000, 150000, "imported-holdings"));
    let lots = crate::db::lots::replay(&conn, None, None, None).unwrap();
    assert_eq!(lots.lots.len(), 1);
    assert_eq!((lots.lots[0].shares_micro, lots.lots[0].cost_cents), (12_500_000, 150000));

    // Transactions: the five originals, plus 0021's opening rows for the
    // accounts whose stored balance did not equal their rows. Checking:
    // 95750 stored vs 291250 summed → a −195500 opening row... which is the
    // honest arithmetic for a fixture that lied; Savings: 50000 with no rows
    // → +50000; Visa: −12000 with a −12000 row → no gap; Wallet: nothing.
    assert_eq!(count(&conn, "transactions"), 5 + 2 + 1, "plus 0022's Add Shares row");
    assert_balances_agree(&conn);
    let sav_open: i64 = one(
        &conn,
        "SELECT amount_cents FROM transactions WHERE account_id = 'a-sav' AND payee = 'Opening Balance'",
        &[],
    );
    assert_eq!(sav_open, 50000);
    let visa_open: i64 = one(
        &conn,
        "SELECT count(*) FROM transactions WHERE account_id = 'a-cc' AND payee = 'Opening Balance'",
        &[],
    );
    assert_eq!(visa_open, 0, "an account whose rows already explain its balance gets no row");

    // The original rows are intact: same money, same category, same memo.
    let (amt, cat, notes): (i64, String, Option<String>) = conn
        .query_row(
            "SELECT amount_cents, category_id, notes FROM transactions WHERE id = 't-1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!((amt, cat.as_str(), notes.as_deref()), (-4250, "c-groc", Some("weekly")));

    // 0011: is_reconciled became cleared_state, and every payee got a row.
    let cleared: String = one(&conn, "SELECT cleared_state FROM transactions WHERE id = 't-1'", &[]);
    assert_eq!(cleared, "R");
    let cleared: String = one(&conn, "SELECT cleared_state FROM transactions WHERE id = 't-2'", &[]);
    assert_eq!(cleared, "");
    assert_eq!(count(&conn, "payees"), 4, "Kroger, Shell, Acme Corp, Allstate");
    let linked: i64 = one(
        &conn,
        "SELECT count(*) FROM transactions t JOIN payees p ON p.id = t.payee_id WHERE p.name = t.payee AND t.payee <> 'Opening Balance'",
        &[],
    );
    assert_eq!(linked, 5);

    // 0014: budgets re-keyed by id, targets intact, the orphan's category created.
    let (target, cat_name): (i64, String) = conn
        .query_row(
            "SELECT b.target_cents, c.name FROM budgets b JOIN categories c ON c.id = b.category_id WHERE b.id = 'b-2'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!((target, cat_name.as_str()), (20000, "Dining"));
    let groc_target: i64 = one(
        &conn,
        "SELECT target_cents FROM budgets WHERE category_id = 'c-groc' AND month_year = '2025-11'",
        &[],
    );
    assert_eq!(groc_target, 60000);

    // 0014's kind heuristic: Paycheck nets positive → income; the rest expense.
    let kind: String = one(&conn, "SELECT kind FROM categories WHERE id = 'c-pay'", &[]);
    assert_eq!(kind, "income");
    let kind: String = one(&conn, "SELECT kind FROM categories WHERE id = 'c-groc'", &[]);
    assert_eq!(kind, "expense");

    // 0019: payments became 'once' rules with the sign flipped, and the paid
    // and skipped ones kept that fact as exceptions.
    assert_eq!(count(&conn, "recurrences"), 3);
    let (amt, freq, start, active): (i64, String, String, i64) = conn
        .query_row(
            "SELECT amount_cents, freq, start_date, is_active FROM recurrences WHERE id = 'p-1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    assert_eq!((amt, freq.as_str(), start.as_str(), active), (-14200, "once", "2025-11-20", 1));
    let statuses: Vec<(String, String)> = {
        let mut st = conn
            .prepare("SELECT recurrence_id, status FROM recurrence_exceptions ORDER BY recurrence_id")
            .unwrap();
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(|r| r.unwrap()).collect()
    };
    assert_eq!(
        statuses,
        [("p-2".to_string(), "paid".to_string()), ("p-3".to_string(), "skipped".to_string())]
    );
    let inactive: i64 = one(&conn, "SELECT is_active FROM recurrences WHERE id = 'p-3'", &[]);
    assert_eq!(inactive, 0);

    // 0017 added price columns; 0022 moved them to `security_prices`, and
    // a holding never priced has no row there. The security keeps its id.
    let sym: String = one(&conn, "SELECT symbol FROM securities WHERE id = 'i-1'", &[]);
    assert_eq!(sym, "VTSAX");

    // 0009 widened the type CHECK: the old four are still valid AND a new one is accepted.
    conn.execute(
        "INSERT INTO accounts (id, name, type) VALUES ('a-new', 'Roth', 'retirement')",
        [],
    )
    .expect("a post-0009 account type");
}

// ---------------------------------------------------------------------------
// 0013 — splits, transfers, the wider taxonomy, payees, statements and void
// exist; categories are still a flat list with a GLOBAL unique name.
// ---------------------------------------------------------------------------

fn fixture_0013() -> Connection {
    let conn = db_at("0013");
    conn.execute_batch(
        r#"
        INSERT INTO accounts (id, name, type, balance_cents, is_favorite, opened_on) VALUES
            ('a-chk', 'Checking', 'checking', 100000, 1, '2025-01-01'),
            ('a-sav', 'Savings',  'savings',   20000, 0, NULL),
            ('a-401', 'TSP',      'retirement', 0,    0, NULL);
        INSERT INTO categories (id, name) VALUES
            ('c-groc', 'Groceries'), ('c-house', 'Household'), ('c-fee', 'Bank Charges');
        INSERT INTO payees (id, name, last_category_id) VALUES
            ('p-wal', 'Walmart', 'c-groc'), ('p-bank', 'First National', 'c-fee');
        -- a split purchase: parent uncategorized, two lines
        INSERT INTO transactions (id, account_id, date, payee, payee_id, category_id, amount_cents,
                                  is_reconciled, cleared_state, check_number, is_void, notes) VALUES
            ('t-split', 'a-chk', '2025-12-01', 'Walmart', 'p-wal', NULL, -12000, 0, 'C', NULL, 0, 'big shop'),
            ('t-void',  'a-chk', '2025-12-02', 'Fraud',   NULL,    'c-groc', -9900, 0, '', NULL, 1, 'reversed'),
            ('t-fee',   'a-chk', '2025-12-03', 'First National',    'p-bank','c-fee',   -500, 1, 'R', NULL, 0, NULL),
            ('t-chq',   'a-chk', '2025-12-04', 'Landlord',NULL,    NULL,   -80000, 0, '', '1042', 0, NULL);
        INSERT INTO splits (id, transaction_id, category_id, description, amount_cents, sort_order) VALUES
            ('s-1', 't-split', 'c-groc',  'food',  -7000, 0),
            ('s-2', 't-split', 'c-house', 'bins',  -5000, 1);
        -- a transfer: two linked rows
        INSERT INTO transactions (id, account_id, date, payee, amount_cents, is_reconciled, transfer_id) VALUES
            ('t-out', 'a-chk', '2025-12-05', 'Transfer Money', -20000, 0, NULL),
            ('t-in',  'a-sav', '2025-12-05', 'Transfer Money',  20000, 0, 't-out');
        UPDATE transactions SET transfer_id = 't-in' WHERE id = 't-out';
        INSERT INTO statements (id, account_id, statement_date, starting_balance_cents, ending_balance_cents,
                                status, reconciled_on, service_charge_cents, service_charge_category_id) VALUES
            ('st-1', 'a-chk', '2025-11-30', 0, 100000, 'completed', '2025-12-01', 500, 'c-fee'),
            ('st-2', 'a-chk', '2025-12-31', 100000, 0, 'in_progress', NULL, NULL, NULL);
        INSERT INTO budgets (id, category_name, target_cents, month_year) VALUES
            ('b-1', 'Groceries', 50000, '2025-12'),
            ('b-2', 'Groceries', 50000, '2026-01');
        "#,
    )
    .unwrap();
    conn
}

#[test]
fn a_0013_file_keeps_its_splits_transfers_statements_and_void_rows() {
    let mut conn = fixture_0013();
    migrate_to_latest(&mut conn);

    assert_eq!(count(&conn, "splits"), 2);
    let split_sum: i64 = one(&conn, "SELECT SUM(amount_cents) FROM splits WHERE transaction_id = 't-split'", &[]);
    assert_eq!(split_sum, -12000);

    // The transfer pair still points at each other.
    let other: String = one(&conn, "SELECT transfer_id FROM transactions WHERE id = 't-out'", &[]);
    assert_eq!(other, "t-in");
    let other: String = one(&conn, "SELECT transfer_id FROM transactions WHERE id = 't-in'", &[]);
    assert_eq!(other, "t-out");

    // Void, cleared state and check numbers untouched.
    let is_void: i64 = one(&conn, "SELECT is_void FROM transactions WHERE id = 't-void'", &[]);
    assert_eq!(is_void, 1);
    let cs: String = one(&conn, "SELECT cleared_state FROM transactions WHERE id = 't-split'", &[]);
    assert_eq!(cs, "C");
    let num: String = one(&conn, "SELECT check_number FROM transactions WHERE id = 't-chq'", &[]);
    assert_eq!(num, "1042");

    // Both statements, with the in-progress one still resumable.
    assert_eq!(count(&conn, "statements"), 2);
    let status: String = one(&conn, "SELECT status FROM statements WHERE id = 'st-2'", &[]);
    assert_eq!(status, "in_progress");

    // 0014/0015: two budgets for the same category in different months both survive the rebuilds.
    assert_eq!(count(&conn, "budgets"), 2);
    // 0014's heuristic: every category here is expense; a NULL-category void row must not upset it.
    let income: i64 = one(&conn, "SELECT count(*) FROM categories WHERE kind = 'income'", &[]);
    assert_eq!(income, 0);
    // 0016 links the payee rows that 0011's backfill had already made, and adds the missing ones.
    let unlinked: i64 = one(
        &conn,
        "SELECT count(*) FROM transactions WHERE payee_id IS NULL AND trim(payee) <> ''
            AND payee <> 'Opening Balance'",
        &[],
    );
    assert_eq!(unlinked, 0, "0021's opening row is deliberately not a payee; every other row must be linked");
    let payee_names: Vec<String> = {
        let mut st = conn.prepare("SELECT name FROM payees ORDER BY name").unwrap();
        st.query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
    };
    assert_eq!(payee_names, ["First National", "Fraud", "Landlord", "Transfer Money", "Walmart"]);
    let last_cat: String = one(&conn, "SELECT last_category_id FROM payees WHERE name = 'Walmart'", &[]);
    assert_eq!(last_cat, "c-groc", "the payee's remembered category was lost");

    // 0021: checking's opening row is dated at opened_on, which precedes its first row,
    // and sorts before everything on any date because its rowid is below them all.
    // checking balance 100000 vs rows −12000 + (void excluded) −500 −80000 −20000 = −112500 → +212500
    assert_balances_agree(&conn);
    let (date, amt): (String, i64) = conn
        .query_row(
            "SELECT date, amount_cents FROM transactions WHERE account_id = 'a-chk' AND payee = 'Opening Balance'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!((date.as_str(), amt), ("2025-01-01", 212500));
    let first_rowid: i64 = one(&conn, "SELECT MIN(rowid) FROM transactions", &[]);
    let opening_rowid: i64 = one(
        &conn,
        "SELECT rowid FROM transactions WHERE account_id = 'a-chk' AND payee = 'Opening Balance'",
        &[],
    );
    assert_eq!(opening_rowid, first_rowid);
    // Savings: 20000 stored vs +20000 transfer in → no gap, no row.
    let sav_rows: Vec<(String, i64)> = {
        let mut st = conn
            .prepare("SELECT date, amount_cents FROM transactions WHERE account_id = 'a-sav' AND payee = 'Opening Balance'")
            .unwrap();
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(|r| r.unwrap()).collect()
    };
    assert_eq!(sav_rows, Vec::<(String, i64)>::new());
}

// ---------------------------------------------------------------------------
// 0016 — the category tree exists (0014) with per-parent uniqueness (0015):
// the standard chart's `Automobile : Insurance` beside a top-level
// `Insurance` is legal here. Everything after must keep both.
// ---------------------------------------------------------------------------

fn fixture_0016() -> Connection {
    let conn = db_at("0016");
    conn.execute_batch(
        r#"
        INSERT INTO accounts (id, name, type, balance_cents) VALUES ('a-chk', 'Checking', 'checking', 0);
        INSERT INTO categories (id, name, parent_id, kind, tax_line) VALUES
            ('c-auto', 'Automobile', NULL,     'expense', NULL),
            ('c-auto-ins', 'Insurance', 'c-auto', 'expense', NULL),
            ('c-ins',  'Insurance', NULL,      'expense', NULL),
            ('c-wage', 'Wages & Salary', NULL, 'income',  'W-2:Wages'),
            ('c-wage-net', 'Net Pay', 'c-wage','income',  NULL);
        INSERT INTO transactions (id, account_id, date, payee, category_id, amount_cents, is_reconciled) VALUES
            ('t-1', 'a-chk', '2026-01-05', 'Allstate', 'c-auto-ins', -10000, 0),
            ('t-2', 'a-chk', '2026-01-06', 'Aetna',    'c-ins',      -25000, 0),
            ('t-3', 'a-chk', '2026-01-07', 'Employer', 'c-wage-net', 300000, 0);
        UPDATE accounts SET balance_cents = 265000 WHERE id = 'a-chk';
        INSERT INTO budgets (id, category_id, target_cents, month_year) VALUES
            ('b-1', 'c-auto-ins', 10000, '2026-01'),
            ('b-2', 'c-ins',      25000, '2026-01');
        INSERT INTO investments (id, name, symbol, quantity, avg_cost_cents, current_value_cents) VALUES
            ('i-1', 'Apple', 'AAPL', '10', 150000, 200000);
        "#,
    )
    .unwrap();
    conn
}

#[test]
fn a_0016_file_keeps_a_subcategory_and_its_top_level_namesake_apart() {
    let mut conn = fixture_0016();
    migrate_to_latest(&mut conn);

    assert_eq!(count(&conn, "categories"), 5);
    let parent: Option<String> = one(&conn, "SELECT parent_id FROM categories WHERE id = 'c-auto-ins'", &[]);
    assert_eq!(parent.as_deref(), Some("c-auto"));
    let kind: String = one(&conn, "SELECT kind FROM categories WHERE id = 'c-wage-net'", &[]);
    assert_eq!(kind, "income");
    let tax: String = one(&conn, "SELECT tax_line FROM categories WHERE id = 'c-wage'", &[]);
    assert_eq!(tax, "W-2:Wages");
    assert_eq!(count(&conn, "budgets"), 2);
    // Each row still files where it was — the namesakes were not merged.
    let cat: String = one(&conn, "SELECT category_id FROM transactions WHERE id = 't-1'", &[]);
    assert_eq!(cat, "c-auto-ins");
    let cat: String = one(&conn, "SELECT category_id FROM transactions WHERE id = 't-2'", &[]);
    assert_eq!(cat, "c-ins");
    // 0021: balance == rows → no opening row. 0022: the Apple holding
    // becomes an Add Shares row (cash effect zero, so balances still agree).
    assert_eq!(count(&conn, "transactions"), 4);
    assert_balances_agree(&conn);
}

// ---------------------------------------------------------------------------
// 0018 — common transactions exist; bills are still one-off `payments`.
// 0019 is the migration that rewrote them.
// ---------------------------------------------------------------------------

fn fixture_0018() -> Connection {
    let conn = db_at("0018");
    conn.execute_batch(
        r#"
        INSERT INTO accounts (id, name, type, balance_cents) VALUES ('a-chk', 'Checking', 'checking', 0);
        INSERT INTO categories (id, name, kind) VALUES ('c-groc', 'Groceries', 'expense'), ('c-house', 'Household', 'expense');
        INSERT INTO common_transactions (id, name, payee, category_id, amount_cents, check_number, notes, usage_count) VALUES
            ('ct-1', 'Walmart run', 'Walmart', NULL, -12000, NULL, 'weekly', 7),
            ('ct-2', 'Kroger',      'Kroger',  'c-groc', NULL, NULL, NULL, 2);
        INSERT INTO common_transaction_splits (id, common_transaction_id, category_id, description, amount_cents, sort_order) VALUES
            ('cts-1', 'ct-1', 'c-groc',  'food', -7000, 0),
            ('cts-2', 'ct-1', 'c-house', 'bins', -5000, 1);
        INSERT INTO payments (id, payee, amount_cents, due_date, status, notes) VALUES
            ('p-due',  'City Power & Light', 14200, '2026-09-20', 'due',     NULL),
            ('p-paid', 'Comcast',      8999, '2026-08-15', 'paid',    'autopay'),
            ('p-skip', 'Old gym',      3500, '2026-08-01', 'skipped', NULL),
            ('p-neg',  'Refund',      -2500, '2026-08-10', 'due',     'stored negative by mistake');
        "#,
    )
    .unwrap();
    conn
}

#[test]
fn a_0018_file_turns_every_payment_into_a_rule_and_keeps_its_templates() {
    let mut conn = fixture_0018();
    migrate_to_latest(&mut conn);

    // Templates untouched, including their split lines.
    assert_eq!(count(&conn, "common_transactions"), 2);
    assert_eq!(count(&conn, "common_transaction_splits"), 2);
    let uses: i64 = one(&conn, "SELECT usage_count FROM common_transactions WHERE id = 'ct-1'", &[]);
    assert_eq!(uses, 7);
    let amt: Option<i64> = one(&conn, "SELECT amount_cents FROM common_transactions WHERE id = 'ct-2'", &[]);
    assert!(amt.is_none(), "a template with no fixed amount must stay that way");

    // Four payments → four 'once' rules, all negative (a bill is money out,
    // whichever sign the old table held), the paid/skipped ones inactive
    // and recorded as exceptions on their own due date.
    assert_eq!(count(&conn, "recurrences"), 4);
    let positives: i64 = one(&conn, "SELECT count(*) FROM recurrences WHERE amount_cents > 0", &[]);
    assert_eq!(positives, 0);
    let neg: i64 = one(&conn, "SELECT amount_cents FROM recurrences WHERE id = 'p-neg'", &[]);
    assert_eq!(neg, -2500);
    let notes: String = one(&conn, "SELECT notes FROM recurrences WHERE id = 'p-paid'", &[]);
    assert_eq!(notes, "autopay");
    let (due, st): (String, String) = conn
        .query_row(
            "SELECT due_date, status FROM recurrence_exceptions WHERE recurrence_id = 'p-paid'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!((due.as_str(), st.as_str()), ("2026-08-15", "paid"));
    assert_eq!(count(&conn, "recurrence_exceptions"), 2);
    let active: i64 = one(&conn, "SELECT count(*) FROM recurrences WHERE is_active = 1", &[]);
    assert_eq!(active, 2, "the due ones stay active");
}

// ---------------------------------------------------------------------------
// 0020 — the version before the opening-balance rows. This pins exactly what
// 0021 writes, per account shape.
// ---------------------------------------------------------------------------

fn fixture_0020() -> Connection {
    let conn = db_at("0020");
    conn.execute_batch(
        r#"
        INSERT INTO accounts (id, name, type, balance_cents, opened_on) VALUES
            ('a-before', 'opened_on before first row',  'checking', 100000, '2025-06-01'),
            ('a-after',  'opened_on after first row',   'checking',  50000, '2026-03-01'),
            ('a-none',   'no opened_on',                'savings',   70000, NULL),
            ('a-empty',  'no rows at all',              'cash',      12345, NULL),
            ('a-even',   'rows explain the balance',    'checking',  -5000, NULL),
            ('a-void',   'a void row does not count',   'checking',   1000, NULL),
            ('a-zero',   'empty and zero',              'cash',          0, NULL);
        INSERT INTO transactions (id, account_id, date, payee, amount_cents, is_reconciled, is_void) VALUES
            ('t-b1', 'a-before', '2026-01-10', 'x',  -1000, 0, 0),
            ('t-a1', 'a-after',  '2026-01-10', 'x',  -1000, 0, 0),
            ('t-a2', 'a-after',  '2026-01-05', 'x',  -2000, 0, 0),
            ('t-n1', 'a-none',   '2026-02-01', 'x',  -3000, 0, 0),
            ('t-e1', 'a-even',   '2026-02-01', 'x',  -5000, 0, 0),
            ('t-v1', 'a-void',   '2026-02-01', 'x',  -9999, 0, 1),
            ('t-v2', 'a-void',   '2026-02-02', 'x',   1000, 0, 0);
        INSERT INTO app_settings (key, value) VALUES ('backup.folder', 'D:\backups'), ('backup.keep', '10');
        "#,
    )
    .unwrap();
    conn
}

#[test]
fn migration_0021_writes_exactly_the_gap_dated_honestly_and_nothing_where_there_is_none() {
    let mut conn = fixture_0020();
    let before = count(&conn, "transactions");
    migrate_to_latest(&mut conn);
    assert_balances_agree(&conn);

    let opening = |acct: &str| -> Option<(String, i64, String, i64)> {
        conn.query_row(
            "SELECT date, amount_cents, cleared_state, is_reconciled FROM transactions
              WHERE account_id = ?1 AND payee = 'Opening Balance'",
            params![acct],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .ok()
    };
    // opened_on on or before the first row → dated at opened_on.
    assert_eq!(opening("a-before"), Some(("2025-06-01".into(), 101000, "R".into(), 1)));
    // opened_on AFTER the first row → the first row's date, not a date that
    // would put the opening balance in the middle of the register.
    assert_eq!(opening("a-after"), Some(("2026-01-05".into(), 53000, "R".into(), 1)));
    // no opened_on → the first row's date.
    assert_eq!(opening("a-none"), Some(("2026-02-01".into(), 73000, "R".into(), 1)));
    // no rows → today, whatever today is.
    let today = chrono::Local::now().date_naive().to_string();
    assert_eq!(opening("a-empty"), Some((today, 12345, "R".into(), 1)));
    // rows already explain the balance → nothing.
    assert_eq!(opening("a-even"), None);
    assert_eq!(opening("a-zero"), None);
    // the void row is not part of the sum: 1000 stored, +1000 non-void → nothing.
    assert_eq!(opening("a-void"), None);

    assert_eq!(count(&conn, "transactions"), before + 4);
    // Settings rode through.
    let folder: String = one(&conn, "SELECT value FROM app_settings WHERE key = 'backup.folder'", &[]);
    assert_eq!(folder, "D:\\backups");
    // And the new column is there for the importer.
    conn.execute("UPDATE transactions SET fitid = 'X1' WHERE id = 't-b1'", []).unwrap();
}

// ---------------------------------------------------------------------------
// 0035 — the version before extra principal. A file that has been recording
// mortgage payments for months already has a `loan_terms` row; 0036 adds a
// column to it, and the whole risk of that migration is a real row losing a
// rate, an escrow account or a payment day on the way through.
// ---------------------------------------------------------------------------

fn fixture_0035() -> Connection {
    let conn = db_at("0035");
    conn.execute_batch(
        r#"
        INSERT INTO accounts (id, name, type, balance_cents, opened_on) VALUES
            ('a-chk',    'Checking', 'checking',     500000, '2026-01-01'),
            ('a-escrow', 'Escrow',   'asset',        120000, '2026-01-01'),
            ('a-mtg',    'Mortgage', 'mortgage', -15000000, '2026-01-01');
        -- §182: by 0035 every balance is the sum of its rows (0021 made it so,
        -- and the app has written an opening row since), so the fixture has
        -- the rows a real file of this version would.
        INSERT INTO transactions (id, account_id, date, payee, amount_cents) VALUES
            ('t-chk-open',    'a-chk',    '2026-01-01', 'Opening Balance',    500000),
            ('t-escrow-open', 'a-escrow', '2026-01-01', 'Opening Balance',    120000),
            ('t-mtg-open',    'a-mtg',    '2026-01-01', 'Opening Balance', -15000000);
        INSERT INTO categories (id, name, parent_id, kind) VALUES
            ('c-int', 'Interest Paid', NULL, 'expense');
        INSERT INTO loan_terms
            (account_id, apr_micro, payment_cents, escrow_cents, escrow_account_id,
             escrow_category_id, interest_category_id, from_account_id, payment_day,
             first_payment_date, term_months, notes)
        VALUES
            ('a-mtg', 6000000, 100000, 65000, 'a-escrow', NULL, 'c-int', 'a-chk', 1,
             '2026-02-01', 360, 'Maple Street');
        "#,
    )
    .unwrap();
    conn
}

#[test]
fn a_0035_file_keeps_its_loan_terms_and_starts_paying_to_the_schedule() {
    let mut conn = fixture_0035();
    migrate_to_latest(&mut conn);

    // Every term is where it was.
    let (apr, payment, escrow, escrow_acct, int_cat, from, day, first, term, note): (
        i64, i64, i64, String, String, String, i64, String, i64, String,
    ) = conn
        .query_row(
            "SELECT apr_micro, payment_cents, escrow_cents, escrow_account_id, interest_category_id,
                    from_account_id, payment_day, first_payment_date, term_months, notes
               FROM loan_terms WHERE account_id = 'a-mtg'",
            [],
            |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?))
            },
        )
        .unwrap();
    assert_eq!((apr, payment, escrow), (6000000, 100000, 65000));
    assert_eq!((escrow_acct.as_str(), int_cat.as_str(), from.as_str()), ("a-escrow", "c-int", "a-chk"));
    assert_eq!((day, first.as_str(), term, note.as_str()), (1, "2026-02-01", 360, "Maple Street"));

    // And the new column defaults to nothing extra: a loan nobody has told
    // about paying ahead is still paid to its schedule.
    let extra: i64 = one(&conn, "SELECT extra_principal_cents FROM loan_terms WHERE account_id = 'a-mtg'", &[]);
    assert_eq!(extra, 0);
    conn.execute("UPDATE loan_terms SET extra_principal_cents = 15000 WHERE account_id = 'a-mtg'", []).unwrap();
}

// ---------------------------------------------------------------------------
// 0036 — the version before budgets learned about yearly amounts. A file with
// budgets in it must come through reading them as the monthly figures they
// were, or every budget in the file silently becomes a twelfth of itself.
// ---------------------------------------------------------------------------

fn fixture_0036() -> Connection {
    let conn = db_at("0036");
    conn.execute_batch(
        r#"
        INSERT INTO categories (id, name, parent_id, kind) VALUES
            ('c-auto', 'Automobile', NULL, 'expense'),
            ('c-fuel', 'Fuel', 'c-auto', 'expense');
        INSERT INTO budgets (id, category_id, target_cents, month_year) VALUES
            ('b-1', 'c-auto', 60000, '2026-09'),
            ('b-2', 'c-fuel', 20000, '2026-09');
        "#,
    )
    .unwrap();
    conn
}

#[test]
fn a_0036_file_reads_its_budgets_as_the_monthly_figures_they_were() {
    let mut conn = fixture_0036();
    migrate_to_latest(&mut conn);

    let rows: Vec<(String, i64, String)> = {
        let mut st = conn
            .prepare("SELECT category_id, target_cents, period FROM budgets ORDER BY category_id")
            .unwrap();
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    assert_eq!(
        rows,
        vec![
            ("c-auto".to_string(), 60000, "monthly".to_string()),
            ("c-fuel".to_string(), 20000, "monthly".to_string()),
        ],
        "amounts unchanged, and every existing budget is monthly — it is what they were"
    );

    // And the new column will only take the two words it is meant to.
    conn.execute("UPDATE budgets SET period = 'yearly' WHERE id = 'b-2'", []).unwrap();
    assert!(
        conn.execute("UPDATE budgets SET period = 'weekly' WHERE id = 'b-2'", []).is_err(),
        "the CHECK should refuse a period nothing knows how to divide"
    );
}

#[test]
fn running_the_migrations_twice_changes_nothing() {
    // Idempotence on a POPULATED file, not an empty one: a second `migrate`
    // (which every app start performs) must apply zero migrations and leave
    // every row as it was — 0021 in particular must not write a second
    // opening row now that the first one closed the gap.
    let mut conn = fixture_0013();
    migrate_to_latest(&mut conn);
    let rows_before = count(&conn, "transactions");
    let sum_before: i64 = one(&conn, "SELECT SUM(amount_cents) FROM transactions", &[]);
    let n = migrate_with(&mut conn, MIGRATIONS).expect("second run");
    assert_eq!(n, 0);
    assert_eq!(count(&conn, "transactions"), rows_before);
    let sum_after: i64 = one(&conn, "SELECT SUM(amount_cents) FROM transactions", &[]);
    assert_eq!(sum_after, sum_before);
}

// ---------------------------------------------------------------------------
// The freeze: a migration that has shipped is history, not code.
// ---------------------------------------------------------------------------

/// FNV-1a over the migration's SQL with whitespace runs collapsed, so a
/// re-indent does not count as a change but any token does.
fn fingerprint(sql: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    let mut last_space = false;
    for b in sql.bytes() {
        let is_space = b.is_ascii_whitespace();
        if is_space && last_space {
            continue;
        }
        let b = if is_space { b' ' } else { b };
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
        last_space = is_space;
    }
    h
}

/// One line per shipped migration. When you add migration 00NN, add its line
/// here — `cargo test frozen` prints the value. If a line OTHER than the new
/// one changes, you have edited a migration that real files have already
/// run, and the ledger will not run it again for them. Write a new migration
/// instead.
const FROZEN: &[(&str, u64)] = &[
    ("0001", 0x6da44447abdd0e91),
    ("0002", 0xff597af3250b7c75),
    ("0003", 0xc726ab16270d72bc),
    ("0004", 0xa6d7b1b5f02444b0),
    ("0005", 0xfef40edc3172c0ba),
    ("0007", 0x2c106b33dedaae60),
    // CHANGED DELIBERATELY, as 0035 below: a file reference in a `--`
    // comment dropped, and the statements are byte-for-byte what they were.
    // Was 0xd5888ad779d41164.
    ("0008", 0x2c7d610026bae0e2),
    // CHANGED DELIBERATELY, as 0035 below: a file reference in a `--`
    // comment dropped, and the statements are byte-for-byte what they were.
    // Was 0x7af1e8716907a1ca.
    ("0009", 0x2016eeeff7a94b2a),
    ("0010", 0xd5c9f457ef7e17e4),
    ("0011", 0xeb0bdcd3403f081d),
    ("0012", 0xbe03da365415a5e0),
    ("0013", 0x6aaef1480e3b0b23),
    // CHANGED DELIBERATELY, as 0035 below: a file reference in a `--`
    // comment dropped, and the statements are byte-for-byte what they were.
    // Was 0x432dd671e752428e.
    ("0014", 0xebdf750444a9e13e),
    ("0015", 0x1f3d9f25fb75f45e),
    // CHANGED DELIBERATELY, as 0035 below: a file reference in a `--`
    // comment dropped, and the statements are byte-for-byte what they were.
    // Was 0x532c926017c2df62.
    ("0016", 0x4248f4b500b351d8),
    // CHANGED DELIBERATELY, as 0035 below: a file reference in a `--`
    // comment dropped, and the statements are byte-for-byte what they were.
    // Was 0x491eedcee57bfbbb.
    ("0017", 0x0d1ddedccb876b72),
    ("0018", 0x80519c43944a8782),
    ("0019", 0x9f07d26611cc4fd6),
    ("0020", 0x5385851f72f3cffa),
    // CHANGED DELIBERATELY, as 0035 below: a file reference in a `--`
    // comment dropped, and the statements are byte-for-byte what they were.
    // Was 0xa1f4a8bd5f8c6eb3.
    ("0021", 0x7f6fdcd06d5fff3a),
    // CHANGED DELIBERATELY, as 0035 below: a file reference in a `--`
    // comment dropped, and the statements are byte-for-byte what they were.
    // Was 0xc0bede3eafbcb210.
    ("0022", 0xbe2c6be49cf0284c),
    // CHANGED DELIBERATELY, as 0035 below: a file reference in a `--`
    // comment dropped, and the statements are byte-for-byte what they were.
    // Was 0xfef4e8e11bb5bb97.
    ("0023", 0x18b8b5dfe2adf9c0),
    // CHANGED DELIBERATELY, as 0035 below: a file reference in a `--`
    // comment dropped, and the statements are byte-for-byte what they were.
    // Was 0x4c54efc48c57be5e.
    ("0024", 0x74d1e036c7013feb),
    // CHANGED DELIBERATELY, as 0035 below: a file reference in a `--`
    // comment dropped, and the statements are byte-for-byte what they were.
    // Was 0x734b56bd577c8596.
    ("0025", 0x81de1a7da1483dc1),
    // CHANGED DELIBERATELY, as 0035 below: a file reference in a `--`
    // comment dropped, and the statements are byte-for-byte what they were.
    // Was 0x03a337486b4d5ed9.
    ("0026", 0xfbe0adea87e4607c),
    // CHANGED DELIBERATELY, as 0035 below: a file reference in a `--`
    // comment dropped, and the statements are byte-for-byte what they were.
    // Was 0xb902e82b22c81860.
    ("0027", 0xc79abb5e5721addb),
    ("0028", 0x760bc3adcdf203c8),
    ("0029", 0xe85d34b55632a708),
    ("0030", 0xdec772ca545837db),
    ("0031", 0x515118adf0cfd8e5),
    ("0032", 0xe8ca5d1939794436),
    // CHANGED DELIBERATELY, as 0035 below: the example rate in a `--`
    // comment replaced, and the statement is byte-for-byte what it was.
    // Was 0xffc13bb140b9ba45.
    ("0033", 0x7dafa6bc393ec3d7),
    // CHANGED DELIBERATELY, as 0035 below: a British spelling in a `--`
    // comment corrected, and the statement is byte-for-byte what it was.
    // Was 0x38e061cfcec9dee8.
    ("0034", 0x8a4bd3633ee90539),
    // §128.1 — CHANGED DELIBERATELY, and this is the explanation the header
    // asks for. 0035's SQL carried the author's street name in four `--`
    // comments, as the worked example for what a classification is. Migration
    // SQL is a `&'static str`: it is compiled into the binary verbatim,
    // comments and all, and `strings t-money.exe` printed it. The app was
    // about to be handed to strangers.
    //
    // Only comment TEXT changed. Every statement, every column and every
    // index is byte-for-byte what it was, so a file that already ran 0035 is
    // unaffected (the ledger will not run it again) and a new file gets the
    // identical schema. That is why this is a hash to update rather than a
    // migration 0037 — there is nothing for a 0037 to do.
    //
    // Was 0x6f0ee6f974cbebf6.
    ("0035", 0x1c8e53d79c5a39ea),
    // CHANGED DELIBERATELY, for the same reason as 0035 above: 0036's `--`
    // comment quoted real mortgage figures. Only comment text changed; the
    // ALTER TABLE is byte-for-byte what it was. Was 0x91060de19d345907.
    // Changed again, the same way: a British spelling in a comment
    // corrected. Was 0xa4b646a97702d135.
    ("0036", 0x10649dbe808362f9),
    // CHANGED DELIBERATELY, as 0035 above: comment text reworded (a made-up
    // figure, US spelling), and the statement is byte-for-byte what it was.
    // Was 0xcd2f1404fc5f6f91.
    ("0037", 0xe1eefc463dcfd335),
    // §138 — budget_plans: the year plan's own table.
    // CHANGED DELIBERATELY, as 0035 above: comment text reworded, and the
    // statements are byte-for-byte what they were. Was 0x6c4f1d239b82d2a9.
    // Changed again, the same way: a British spelling in a comment
    // corrected. Was 0x7cf44517aa870357.
    // Changed again, the same way: the seasonal example and its figures
    // replaced, and story wording neutralized. Was 0x8af1f5d488297164.
    ("0038", 0xd650ac1790424d4a),
    // §143 — budget_plans.spread: which of the two things a months mask
    // means. An ADD COLUMN with a default, so a file that already ran 0038
    // gains the column reading 'spent' and means exactly what it meant.
    // CHANGED DELIBERATELY, as 0035 above: a British spelling in a comment
    // corrected, and the statement is byte-for-byte what it was.
    // Was 0x595aefe408723761.
    // Changed again, the same way: the seasonal example and its figures
    // replaced. Was 0xbeeb6a10cbf6551c.
    ("0039", 0x4197484cde8e5895),
    // §147 — budgets.auto_envelope / budget_plans.auto_envelope: whether the
    // envelope rule put that figure there or a person did. Two ADD COLUMNs
    // with a default, so an existing file reads every figure as typed and
    // nothing moves under the user on upgrade.
    // CHANGED DELIBERATELY, as 0035 above: comment text reworded, and the
    // statements are byte-for-byte what they were. Was 0x75d8c55b7abb2ff3.
    // Changed again, the same way: the quoted figures replaced with made-up
    // ones. Was 0x2fdf827d80fb7cbc.
    // Changed again, the same way: a quote that carried a figure replaced
    // with a paraphrase. Was 0x78f120cbf7c8138d.
    ("0040", 0x01dd30808963fae5),
    // §150 — asked_for_cents: the figure a person typed, kept underneath
    // whatever the children push the envelope to. Replaces 0040's
    // auto_envelope as the thing the rule reasons about.
    // CHANGED DELIBERATELY, as 0035 above: comment text reworded, and the
    // statements are byte-for-byte what they were. Was 0x75405c52ba2d63d5.
    ("0041", 0xfc44a453db7ec5af),
    // §167 — a TSP reallocation already in the file becomes the exchange it
    // is: Sell/Buy rows carrying the importer's memos turn into Remove/Add
    // Shares, moving no cash, and the day's rows are linked to each other so
    // the lot engine carries basis across the funds.
    ("0042", 0x73b5ae9e99303dc5),
    // §169 — accounts.sort_order: where an account sits in every list. An
    // ADD COLUMN with no default, so a file that never arranged its
    // accounts reads as it did.
    ("0043", 0x099839086c65d72b),
    // §172 — a TSP contribution Buy already in the file gets the cash side
    // §90 gives one, once, by the importer's own memo; the buy points at it
    // as its funding row; the accounts' cash is recomputed. §172.1, before
    // it had run anywhere: only a buy that has NO deposit beside it — ones
    // imported through the dialog have one, and the first draft would have
    // paid each twice.
    // CHANGED DELIBERATELY, as 0035 above: comment text reworded, and the
    // statements are byte-for-byte what they were. Was 0x4c88c55ca8298610.
    // Changed again, the same way: story wording in a comment neutralized.
    // Was 0x8c66064686e7ffe9.
    ("0044", 0x7ef2996cf5a3702e),
    // §170 — attachments: the bytes in their own table, the link row keyed
    // to a transaction or an account and cascading with it.
    ("0045", 0xb83bcc257a4bd69b),
    // §171 — payee rules can look at the amount, the memo and the account;
    // the unique index on the match text goes, since two rules on one text
    // that differ in their conditions are the point.
    ("0046", 0xe645609482f1652a),
];

#[test]
fn historic_migration_sql_is_frozen() {
    let actual: Vec<(&str, u64)> = MIGRATIONS.iter().map(|(v, _, sql)| (*v, fingerprint(sql))).collect();
    let mut report = String::new();
    for (v, f) in &actual {
        report.push_str(&format!("    (\"{v}\", {f:#018x}),\n"));
    }
    assert_eq!(
        actual, FROZEN,
        "a shipped migration's SQL changed, or a new one has no line yet. Current fingerprints:\n{report}"
    );
}
