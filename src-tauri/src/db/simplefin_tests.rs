//! SimpleFIN in the file: which accounts may be linked, what a fetch writes,
//! that fetching the same days again writes nothing, and the daily budget.
//! No network here — the replies are built by hand.

#![cfg(test)]

use crate::db::queries::{self, Conn};
use crate::db::test_db::TestDb;
use crate::simplefin::{apply_fetch, AccountSet, SfAccount, SfTxn, DAILY_REQUESTS};

fn txn(id: &str, date: &str, cents: i64, payee: &str) -> SfTxn {
    SfTxn { id: id.into(), date: date.into(), amount_cents: cents, payee: payee.into(), memo: None }
}

fn acct(id: &str, name: &str, currency: &str, transactions: Vec<SfTxn>) -> SfAccount {
    SfAccount {
        id: id.into(),
        name: name.into(),
        org: Some("Example Bank".into()),
        currency: Some(currency.into()),
        balance_cents: Some(98_765),
        balance_date: Some("2026-10-02".into()),
        transactions,
    }
}

fn set(accounts: Vec<SfAccount>) -> AccountSet {
    AccountSet { accounts, messages: Vec::new() }
}

fn linked(c: &Conn, sf_id: &str) -> (Option<String>, Option<String>) {
    let a = queries::list_simplefin_accounts(c).unwrap().into_iter().find(|a| a.sf_id == sf_id).unwrap();
    (a.account_id, a.synced_through)
}

#[test]
fn only_a_same_currency_cash_account_not_already_fed_can_be_linked() {
    let db = TestDb::new("sf-link");
    let c = db.conn();
    queries::set_rate(&c, "EUR", "2026-01-01", 1_100_000, "manual").unwrap();
    let checking = queries::create_account(&c, "Checking", "checking", 0, None).unwrap().id;
    let brokerage = queries::create_account(&c, "Brokerage", "investment", 0, None).unwrap().id;
    let euro = queries::create_account_in(&c, "Euro", "checking", 0, None, "EUR").unwrap().id;
    queries::upsert_simplefin_accounts(&c, &set(vec![acct("A", "Everyday", "USD", vec![]), acct("B", "Second", "USD", vec![])])).unwrap();

    assert!(queries::link_simplefin_account(&c, "nope", Some(&checking)).unwrap_err().contains("not known"));
    assert!(queries::link_simplefin_account(&c, "A", Some("nope")).unwrap_err().contains("not in the file"));
    assert!(queries::link_simplefin_account(&c, "A", Some(&brokerage)).unwrap_err().contains("investment account"));
    let e = queries::link_simplefin_account(&c, "A", Some(&euro)).unwrap_err();
    assert!(e.contains("is in USD") && e.contains("kept in EUR"), "{e}");

    queries::link_simplefin_account(&c, "A", Some(&checking)).unwrap();
    assert_eq!(linked(&c, "A").0.as_deref(), Some(checking.as_str()));
    // Two feeds into one register would write everything twice.
    assert!(queries::link_simplefin_account(&c, "B", Some(&checking)).unwrap_err().contains("already filled from Everyday"));

    // Relinking the same account keeps its place; unlinking forgets it.
    queries::set_simplefin_synced(&c, "A", "2026-10-01").unwrap();
    queries::link_simplefin_account(&c, "A", Some(&checking)).unwrap();
    assert_eq!(linked(&c, "A").1.as_deref(), Some("2026-10-01"));
    queries::link_simplefin_account(&c, "A", None).unwrap();
    assert_eq!(linked(&c, "A"), (None, None));

    // A refresh keeps links, and deleting the account just unlinks it.
    queries::link_simplefin_account(&c, "B", Some(&checking)).unwrap();
    queries::upsert_simplefin_accounts(&c, &set(vec![acct("B", "Renamed", "USD", vec![])])).unwrap();
    let b = queries::list_simplefin_accounts(&c).unwrap().into_iter().find(|a| a.sf_id == "B").unwrap();
    assert_eq!((b.name.as_str(), b.account_name.as_deref()), ("Renamed", Some("Checking")));
    queries::delete_account(&c, &checking).unwrap();
    assert_eq!(linked(&c, "B").0, None);
}

#[test]
fn a_fetch_imports_once_and_a_repeat_adds_nothing() {
    let db = TestDb::new("sf-fetch");
    let c = db.conn();
    let checking = queries::create_account(&c, "Checking", "checking", 10_000, Some("2026-09-01")).unwrap().id;
    let reply = set(vec![
        acct("A", "Everyday", "USD", vec![txn("T1", "2026-09-30", -4_250, "Kroger"), txn("T2", "2026-10-01", 150_000, "Payroll")]),
        acct("B", "Not linked", "USD", vec![txn("T9", "2026-09-30", -100, "Elsewhere")]),
    ]);
    queries::upsert_simplefin_accounts(&c, &reply).unwrap();
    queries::link_simplefin_account(&c, "A", Some(&checking)).unwrap();

    let mut heard = Vec::new();
    let out = apply_fetch(&db.pool, &reply, "2026-10-03", "2026-07-07", &mut |done, total, name| heard.push((done, total, name.to_string()))).unwrap();
    assert_eq!(heard, vec![(0, 1, "Checking".to_string())], "one linked account, announced before it imports");
    assert_eq!(out.unlinked, 1);
    assert_eq!(out.lines.len(), 1);
    let l = &out.lines[0];
    assert_eq!((l.imported, l.duplicates, l.error.as_deref()), (2, 0, None));
    assert_eq!((l.bank_balance_cents, l.balance_cents), (Some(98_765), 10_000 - 4_250 + 150_000));
    assert_eq!(linked(&c, "A").1.as_deref(), Some("2026-10-03"));
    let fitid: String = c
        .query_row("SELECT fitid FROM transactions WHERE account_id = ?1 AND amount_cents = -4250", [&checking], |r| r.get(0))
        .unwrap();
    assert_eq!(fitid, "sfin:T1");

    // The next fetch overlaps the last one: the same rows are skipped, a new
    // one comes in.
    let again = set(vec![acct(
        "A",
        "Everyday",
        "USD",
        vec![txn("T1", "2026-09-30", -4_250, "Kroger"), txn("T2", "2026-10-01", 150_000, "Payroll"), txn("T3", "2026-10-03", -1_000, "Cafe")],
    )]);
    let out = apply_fetch(&db.pool, &again, "2026-10-04", "2026-09-28", &mut |_, _, _| {}).unwrap();
    let l = &out.lines[0];
    assert_eq!((l.imported, l.duplicates), (1, 2));
    assert_eq!(queries::get_account(&c, &checking).unwrap().balance_cents, 10_000 - 4_250 + 150_000 - 1_000);
    // B was not in this reply, and it is not linked, so it is not counted.
    assert_eq!(out.unlinked, 0);
}

#[test]
fn a_bank_row_for_one_typed_ahead_is_matched_not_written_twice() {
    let db = TestDb::new("sf-typed");
    let c = db.conn();
    let checking = queries::create_account(&c, "Checking", "checking", 0, None).unwrap().id;
    // Typed in on the day, before the bank posted it a day later as its own
    // spelling. A different shop for the same amount is not touched.
    let typed = queries::create_transaction(&c, &checking, "2026-09-29", "Kroger", None, -4_250, None, None).unwrap().id;
    queries::upsert_simplefin_accounts(&c, &set(vec![acct("A", "Everyday", "USD", vec![])])).unwrap();
    queries::link_simplefin_account(&c, "A", Some(&checking)).unwrap();
    let reply = set(vec![acct(
        "A",
        "Everyday",
        "USD",
        vec![txn("T1", "2026-09-30", -4_250, "KROGER #123"), txn("T2", "2026-09-30", -4_250, "Shell Oil")],
    )]);
    let out = apply_fetch(&db.pool, &reply, "2026-10-03", "2026-07-07", &mut |_, _, _| {}).unwrap();
    let l = &out.lines[0];
    assert_eq!((l.imported, l.matched, l.duplicates), (1, 1, 0));
    assert_eq!(l.balance_cents, -8_500);
    let (payee, fitid, cleared): (String, Option<String>, String) = c
        .query_row("SELECT payee, fitid, cleared_state FROM transactions WHERE id = ?1", [&typed], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap();
    assert_eq!((payee.as_str(), fitid.as_deref(), cleared.as_str()), ("Kroger", Some("sfin:T1"), "C"));
    // And the next fetch knows it by the bank's id.
    let again = apply_fetch(&db.pool, &reply, "2026-10-04", "2026-09-28", &mut |_, _, _| {}).unwrap();
    assert_eq!((again.lines[0].imported, again.lines[0].matched, again.lines[0].duplicates), (0, 0, 2));
}

#[test]
fn a_changed_currency_or_a_missing_account_is_reported_not_imported() {
    let db = TestDb::new("sf-mismatch");
    let c = db.conn();
    let checking = queries::create_account(&c, "Checking", "checking", 0, None).unwrap().id;
    let savings = queries::create_account(&c, "Savings", "savings", 0, None).unwrap().id;
    queries::upsert_simplefin_accounts(&c, &set(vec![acct("A", "Everyday", "USD", vec![]), acct("B", "Saver", "USD", vec![])])).unwrap();
    queries::link_simplefin_account(&c, "A", Some(&checking)).unwrap();
    queries::link_simplefin_account(&c, "B", Some(&savings)).unwrap();

    let mut reply = set(vec![acct("A", "Everyday", "CAD", vec![txn("T1", "2026-09-30", -100, "Shop")])]);
    reply.messages.push("Example Bank needs you to sign in again.".into());
    let out = apply_fetch(&db.pool, &reply, "2026-10-03", "2026-07-07", &mut |_, _, _| {}).unwrap();
    assert_eq!(out.messages, vec!["Example Bank needs you to sign in again.".to_string()]);
    let a = out.lines.iter().find(|l| l.account_id == checking).unwrap();
    assert_eq!(a.imported, 0);
    assert!(a.error.as_deref().unwrap().contains("is in CAD"), "{:?}", a.error);
    let b = out.lines.iter().find(|l| l.account_id == savings).unwrap();
    assert!(b.error.as_deref().unwrap().contains("did not report"), "{:?}", b.error);
    // Neither moved forward, so the next fetch asks for the same days again.
    assert_eq!(linked(&c, "A").1, None);
    assert_eq!(linked(&c, "B").1, None);
    assert_eq!(queries::get_account(&c, &checking).unwrap().balance_cents, 0);
}

#[test]
fn the_budget_is_twenty_in_any_24_hours() {
    let db = TestDb::new("sf-budget");
    let c = db.conn();
    // Twenty in the hour before midnight...
    let eve = 1_790_895_600; // 2026-10-02 23:00 UTC
    assert_eq!(queries::simplefin_requests_today(&c, eve).unwrap(), 0);
    for i in 0..DAILY_REQUESTS as i64 {
        queries::take_simplefin_request(&c, eve + i * 60).unwrap();
    }
    let now = eve + 3_600;
    assert_eq!(queries::simplefin_requests_today(&c, now).unwrap(), DAILY_REQUESTS);
    // ...leave none for the hour after it: the day is a rolling one.
    let e = queries::take_simplefin_request(&c, now).unwrap_err();
    assert!(e.contains("in about 23 hours"), "{e}");
    // A day after the first, one is free again; the others still count.
    let later = eve + 86_400;
    assert_eq!(queries::simplefin_requests_today(&c, later).unwrap(), DAILY_REQUESTS - 1);
    queries::take_simplefin_request(&c, later).unwrap();
    assert!(queries::take_simplefin_request(&c, later).is_err());
    let next_day = eve + 2 * 86_400;
    assert_eq!(queries::simplefin_requests_today(&c, next_day).unwrap(), 0);

    // A clock set back an hour does not hand out a fresh budget.
    assert_eq!(queries::simplefin_requests_today(&c, later - 7_200).unwrap(), DAILY_REQUESTS);

    // Disconnecting forgets the accounts and the connection, not the count:
    // SimpleFIN is still counting.
    queries::upsert_simplefin_accounts(&c, &set(vec![acct("A", "Everyday", "USD", vec![])])).unwrap();
    let id = queries::new_simplefin_connection_id(&c).unwrap();
    assert_eq!(queries::simplefin_connection_id(&c).unwrap(), Some(id.clone()));
    assert_ne!(queries::new_simplefin_connection_id(&c).unwrap(), id, "a fresh id each time");
    queries::clear_simplefin(&c).unwrap();
    assert!(queries::list_simplefin_accounts(&c).unwrap().is_empty());
    assert_eq!(queries::simplefin_connection_id(&c).unwrap(), None);
    assert_eq!(queries::simplefin_requests_today(&c, later).unwrap(), DAILY_REQUESTS);

    // Several at once go all together or not at all.
    let fresh = eve + 10 * 86_400;
    for _ in 0..DAILY_REQUESTS - 1 {
        queries::take_simplefin_request(&c, fresh).unwrap();
    }
    assert!(queries::take_simplefin_requests(&c, fresh, 2).is_err());
    assert_eq!(queries::simplefin_requests_today(&c, fresh).unwrap(), DAILY_REQUESTS - 1, "a refused pair takes nothing");
    queries::take_simplefin_requests(&c, fresh, 1).unwrap();
}

#[test]
fn a_second_identical_charge_fetched_later_is_its_own_transaction() {
    let db = TestDb::new("sf-coffee");
    let c = db.conn();
    let checking = queries::create_account(&c, "Checking", "checking", 0, None).unwrap().id;
    queries::upsert_simplefin_accounts(&c, &set(vec![acct("A", "Everyday", "USD", vec![])])).unwrap();
    queries::link_simplefin_account(&c, "A", Some(&checking)).unwrap();
    // Two coffees on one day; the second posts after a midday fetch.
    let morning = set(vec![acct("A", "Everyday", "USD", vec![txn("C1", "2026-10-02", -450, "Coffee")])]);
    apply_fetch(&db.pool, &morning, "2026-10-02", "2026-07-06", &mut |_, _, _| {}).unwrap();
    let evening = set(vec![acct("A", "Everyday", "USD", vec![txn("C1", "2026-10-02", -450, "Coffee"), txn("C2", "2026-10-02", -450, "Coffee")])]);
    let out = apply_fetch(&db.pool, &evening, "2026-10-03", "2026-09-27", &mut |_, _, _| {}).unwrap();
    let l = &out.lines[0];
    assert_eq!((l.imported, l.matched, l.duplicates), (1, 0, 1));
    assert_eq!(l.balance_cents, -900);
    // What the bank posted lands cleared.
    let cleared: i64 = c
        .query_row("SELECT count(*) FROM transactions WHERE account_id = ?1 AND cleared_state = 'C'", [&checking], |r| r.get(0))
        .unwrap();
    assert_eq!(cleared, 2);
}

#[test]
fn where_to_start_comes_from_the_register_so_an_undone_fetch_is_fetched_again() {
    let db = TestDb::new("sf-undo");
    let c = db.conn();
    let checking = queries::create_account(&c, "Checking", "checking", 0, None).unwrap().id;
    assert_eq!(queries::latest_feed_date(&c, &checking).unwrap(), None);
    // A row typed by hand, with no bank id, is not a fetched one.
    queries::create_transaction(&c, &checking, "2026-10-01", "Typed", None, -100, None, None).unwrap();
    queries::upsert_simplefin_accounts(&c, &set(vec![acct("A", "Everyday", "USD", vec![])])).unwrap();
    queries::link_simplefin_account(&c, "A", Some(&checking)).unwrap();
    assert_eq!(queries::latest_feed_date(&c, &checking).unwrap(), None);
    let reply = set(vec![acct("A", "Everyday", "USD", vec![txn("T1", "2026-08-01", -100, "Old"), txn("T2", "2026-09-20", -200, "Newer")])]);
    apply_fetch(&db.pool, &reply, "2026-10-03", "2026-07-07", &mut |_, _, _| {}).unwrap();
    assert_eq!(queries::latest_feed_date(&c, &checking).unwrap().as_deref(), Some("2026-09-20"));
    // Undo takes the fetched rows away; the start goes back with them.
    let fetched: Vec<String> = c
        .prepare("SELECT id FROM transactions WHERE fitid LIKE 'sfin:%'")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    for id in fetched {
        queries::delete_transaction(&c, &id).unwrap();
    }
    assert_eq!(queries::latest_feed_date(&c, &checking).unwrap(), None);
}

#[test]
fn a_closed_account_cannot_be_linked() {
    let db = TestDb::new("sf-closed");
    let c = db.conn();
    let old = queries::create_account(&c, "Old", "checking", 0, None).unwrap().id;
    c.execute("UPDATE accounts SET is_closed = 1 WHERE id = ?1", [&old]).unwrap();
    queries::upsert_simplefin_accounts(&c, &set(vec![acct("A", "Everyday", "USD", vec![])])).unwrap();
    assert!(queries::link_simplefin_account(&c, "A", Some(&old)).unwrap_err().contains("is closed"));
}

#[test]
fn days_beyond_the_90_day_reach_are_named() {
    let db = TestDb::new("sf-gap");
    let c = db.conn();
    let checking = queries::create_account(&c, "Checking", "checking", 0, None).unwrap().id;
    queries::upsert_simplefin_accounts(&c, &set(vec![acct("A", "Everyday", "USD", vec![])])).unwrap();
    queries::link_simplefin_account(&c, "A", Some(&checking)).unwrap();
    queries::set_simplefin_synced(&c, "A", "2026-03-01").unwrap();
    let reply = set(vec![acct("A", "Everyday", "USD", vec![])]);
    let out = apply_fetch(&db.pool, &reply, "2026-10-03", "2026-07-07", &mut |_, _, _| {}).unwrap();
    let note = out.lines[0].note.as_deref().unwrap();
    assert!(note.contains("reaches back only 90 days"), "{note}");
    // Fetched recently: nothing to say.
    let out = apply_fetch(&db.pool, &reply, "2026-10-04", "2026-09-28", &mut |_, _, _| {}).unwrap();
    assert_eq!(out.lines[0].note, None);
}
