// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
//
// `queries` owns every balance calculation in the app and had **no tests**
// until 2026-09-01. Three data bugs in a row were found
// by a user walkthrough rather than by the suite, all of them in this layer.
//
// The bias here is deliberate: these test **money moving**, not CRUD. The
// question each one answers is "did the balance end up right, and is the file
// still internally consistent?" — because a wrong balance in a personal
// finance file is silent, cumulative, and the worst failure this app has.
//
// Each test gets a real SQLCipher database in a temp dir, migrated by the same
// `init_pool` the app uses, so migrations and schema are exercised too.

use crate::models::{
    NewCommonTransaction, NewInvestmentTransaction, NewRecurrence, NewSplit, RegisterRow,
};
use chrono::NaiveDate;
use rusqlite::{params, OptionalExtension};
use super::*;

// A throwaway encrypted database, checked whole and deleted when the
// test ends. These tests control their own categories, so they
// start from an empty chart.
pub(super) use crate::db::test_db::EmptyChartDb as TestDb;

pub(super) fn balance(conn: &Conn, id: &str) -> i64 {
    get_account(conn, id).expect("account").balance_cents
}

/// Every account balance summed — a transfer must never change this.
pub(super) fn total_of_all_accounts(conn: &Conn) -> i64 {
    get_all_accounts(conn)
        .expect("accounts")
        .iter()
        .map(|a| a.balance_cents)
        .sum()
}

/// The register minus the "Opening Balance" row `create_account` writes
/// for a non-zero opening amount — for tests that count what THEY wrote.
pub(super) fn entered(conn: &Conn, account_id: &str) -> Vec<RegisterRow> {
    get_register(conn, account_id)
        .expect("register")
        .into_iter()
        .filter(|r| r.payee != "Opening Balance")
        .collect()
}

pub(super) fn account(conn: &Conn, name: &str, opening: i64) -> String {
    create_account(conn, name, "checking", opening, Some("2026-01-01"))
        .expect("create_account")
        .id
}

pub(super) fn inv_account(conn: &Conn, name: &str, kind: &str) -> String {
    create_account(conn, name, kind, 0, Some("2025-01-01")).expect("create_account").id
}

pub(super) fn inv(account: &str, date: &str, activity: &str, sec: &str, shares_micro: i64, gross: i64) -> NewInvestmentTransaction {
    NewInvestmentTransaction {
        account_id: account.to_string(),
        date: date.to_string(),
        activity: activity.to_string(),
        security_id: sec.to_string(),
        shares_micro,
        price_micro: None,
        gross_cents: gross,
        commission_cents: 0,
        category_id: None,
        notes: None,
        funding_account_id: None,
        lot_allocations: vec![],
    }
}

// A mortgage payment out of checking: interest, principal to the
// loan, escrow to the escrow account. Returns (payment, principal row,
// escrow row).
pub(super) fn split_payment(c: &Conn, chk: &str, loan: &str, escrow: &str, date: &str) -> (String, String, String) {
    let pay = create_transaction(c, chk, date, "Summit Home Loans", None, -150_000, None, None).unwrap();
    let line = |amount, to: Option<&str>| NewSplit {
        classes: Vec::new(),
        category_id: None,
        description: None,
        amount_cents: amount,
        transfer_account_id: to.map(str::to_string),
    };
    set_splits(c, &pay.id, &[line(-50_000, None), line(-80_000, Some(loan)), line(-20_000, Some(escrow))]).unwrap();
    let far = |acct: &str| -> String {
        c.query_row(
            "SELECT s.transfer_txn_id FROM splits s WHERE s.transaction_id = ?1 AND s.transfer_account_id = ?2",
            params![pay.id, acct],
            |r| r.get(0),
        )
        .unwrap()
    };
    (pay.id.clone(), far(loan), far(escrow))
}

/// The file agrees with itself: balances, split lines, and every
/// split transfer line with its row in the other account.
pub(super) fn assert_consistent(c: &Conn) {
    let v = verify_file(c, false).unwrap();
    assert!(v.drift.is_empty(), "{:?}", v.drift);
    assert!(v.split_transfers.is_empty(), "{:?}", v.split_transfers);
    assert!(v.split_mismatch.is_empty(), "{:?}", v.split_mismatch);
    assert!(v.foreign_keys.is_empty(), "{:?}", v.foreign_keys);
}

pub(super) fn plain_line(amount: i64, to: Option<&str>) -> NewSplit {
    NewSplit { classes: Vec::new(), category_id: None, description: None, amount_cents: amount, transfer_account_id: to.map(str::to_string) }
}

pub(super) fn template(name: &str) -> NewCommonTransaction {
    NewCommonTransaction {
        name: name.to_string(),
        payee: "Anytown Properties".to_string(),
        category_id: None,
        amount_cents: Some(-145_000),
        check_number: None,
        notes: None,
        splits: Vec::new(),
    }
}

pub(super) fn nd(s: &str) -> NaiveDate {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").expect("date")
}

pub(super) fn bill(account_id: &str, payee: &str, cents: i64, start: &str) -> NewRecurrence {
    NewRecurrence {
        payee: payee.to_string(),
        amount_cents: cents,
        account_id: Some(account_id.to_string()),
        category_id: None,
        freq: "monthly".to_string(),
        interval_n: 1,
        start_date: start.to_string(),
        end_date: None,
        second_day: None,
        weekend_rule: "none".to_string(),
        notes: None, transfer_account_id: None, goal_id: None,
    }
}

pub(super) fn plan_row(c: &Conn, category_id: &str, year: i32) -> Option<(i64, String, String, Option<i64>)> {
    c.query_row(
        "SELECT annual_cents, months, spread, asked_for_cents FROM budget_plans WHERE category_id = ?1 AND year = ?2",
        params![category_id, year],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )
    .optional()
    .unwrap()
}

pub(super) fn budget_of(c: &Conn, category_id: &str, month: &str) -> Option<i64> {
    list_budgets(c, month).unwrap().into_iter().find(|b| b.category_id == category_id).map(|b| b.target_cents)
}

pub(super) fn close(c: &Conn, id: &str) {
    c.execute("UPDATE accounts SET is_closed = 1 WHERE id = ?1", params![id]).unwrap();
}

pub(super) fn transfer_line(amount: i64, to: Option<&str>) -> NewSplit {
    NewSplit { classes: Vec::new(), category_id: None, description: None, amount_cents: amount, transfer_account_id: to.map(str::to_string) }
}
