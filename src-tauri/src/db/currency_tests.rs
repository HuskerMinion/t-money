//! Accounts kept in other currencies: what is refused, what a transfer
//! between two currencies writes, and that every total converts to dollars
//! at the rate on the day. Each test's file is checked whole when it ends.

#![cfg(test)]

use crate::db::queries::{self, Conn};
use crate::db::reports::run_report;
use crate::db::test_db::TestDb;
use crate::models::{NewRecurrence, NewSplit, ReportRequest};

fn req(kind: &str, from: &str, to: &str) -> ReportRequest {
    ReportRequest { kind: kind.into(), from: from.into(), to: to.into(), ..Default::default() }
}

fn cat(c: &Conn, name: &str) -> String {
    queries::list_categories(c).unwrap().into_iter().find(|x| x.name == name).map(|x| x.id).unwrap()
}

/// Dollar checking, euro checking (EUR at 1.10 from Feb 1, 1.20 from Mar 1).
fn world(c: &Conn) -> (String, String) {
    queries::set_rate(c, "EUR", "2026-02-01", 1_100_000, "manual").unwrap();
    queries::set_rate(c, "EUR", "2026-03-01", 1_200_000, "manual").unwrap();
    let usd = queries::create_account(c, "Checking", "checking", 100_000, Some("2026-01-01")).unwrap().id;
    let eur = queries::create_account_in(c, "Euro Checking", "checking", 50_000, Some("2026-01-01"), "EUR").unwrap().id;
    (usd, eur)
}

#[test]
fn a_foreign_account_needs_a_rate_and_a_type_that_allows_it() {
    let db = TestDb::new("cur-create");
    let c = db.conn();
    let e = queries::create_account_in(&c, "Euro", "checking", 0, None, "EUR").unwrap_err();
    assert!(e.contains("no exchange rate for EUR"), "{e}");
    queries::set_rate(&c, "EUR", "2026-01-01", 1_100_000, "manual").unwrap();
    assert!(queries::create_account_in(&c, "Euro Brokerage", "investment", 0, None, "EUR").is_err());
    assert!(queries::create_account_in(&c, "Yen", "checking", 0, None, "JPY").is_err());
    let a = queries::create_account_in(&c, "Euro", "checking", 0, None, "eur").unwrap();
    assert_eq!(a.currency, "EUR");
    assert_eq!(a.home_rate_micro, 1_100_000);
    // Turning it into an investment account would put it in a type kept in
    // the home currency.
    let err = queries::update_account(&c, &a.id, "Euro", "investment", false, None, None, None, None, None, None, None, None, None, None).unwrap_err();
    assert!(err.contains("home currency (USD)"), "{err}");
    // Dollar accounts carry a rate of one.
    let d = queries::create_account(&c, "Dollars", "checking", 0, None).unwrap();
    assert_eq!((d.currency.as_str(), d.home_rate_micro), ("USD", 1_000_000));
}

#[test]
fn a_transfer_between_currencies_moves_each_side_by_its_own_amount() {
    let db = TestDb::new("cur-transfer");
    let c = db.conn();
    let (usd, eur) = world(&c);
    // One amount for both sides is refused across currencies...
    let e = queries::create_transfer(&c, &usd, &eur, "2026-03-05", 11_000, None).unwrap_err();
    assert!(e.contains("between two currencies"), "{e}");
    // ...and two amounts write two amounts.
    let t = queries::create_transfer_between(&c, &usd, &eur, "2026-03-05", 12_000, 10_000, Some("to Europe")).unwrap();
    assert_eq!(t.amount_cents, -12_000);
    assert_eq!(queries::get_account(&c, &usd).unwrap().balance_cents, 100_000 - 12_000);
    assert_eq!(queries::get_account(&c, &eur).unwrap().balance_cents, 50_000 + 10_000);

    // Editing from the euro side: 9,000 EUR arrived for 10,500 USD.
    let partner: String = c.query_row("SELECT transfer_id FROM transactions WHERE id = ?1", [&t.id], |r| r.get(0)).unwrap();
    let e = queries::update_transfer_amounts(&c, &partner, "2026-03-06", &usd, 9_000, None, None).unwrap_err();
    assert!(e.contains("Enter the amount in USD"), "{e}");
    queries::update_transfer_amounts(&c, &partner, "2026-03-06", &usd, 9_000, Some(10_500), None).unwrap();
    assert_eq!(queries::get_account(&c, &usd).unwrap().balance_cents, 100_000 - 10_500);
    assert_eq!(queries::get_account(&c, &eur).unwrap().balance_cents, 50_000 + 9_000);

    // In one currency the two amounts must agree.
    let usd2 = queries::create_account(&c, "Savings", "savings", 0, None).unwrap().id;
    assert!(queries::create_transfer_between(&c, &usd, &usd2, "2026-03-07", 1_000, 999, None).is_err());
    queries::create_transfer_between(&c, &usd, &usd2, "2026-03-07", 1_000, 1_000, None).unwrap();
    // Moving the far side of the cross-currency transfer onto a dollar
    // account makes it a one-currency transfer again: the negation.
    queries::update_transfer_amounts(&c, &t.id, "2026-03-06", &usd2, -10_500, Some(10_499), None).unwrap_err();
    queries::update_transfer_amounts(&c, &t.id, "2026-03-06", &usd2, -10_500, None, None).unwrap();
    assert_eq!(queries::get_account(&c, &eur).unwrap().balance_cents, 50_000);
    assert_eq!(queries::get_account(&c, &usd2).unwrap().balance_cents, 1_000 + 10_500);
}

#[test]
fn links_that_move_one_amount_are_refused_across_currencies() {
    let db = TestDb::new("cur-refuse");
    let c = db.conn();
    let (usd, eur) = world(&c);
    // A split line that moves money.
    let p = queries::create_transaction(&c, &usd, "2026-03-02", "Payment", None, -5_000, None, None).unwrap();
    let e = queries::set_splits(&c, &p.id, &[NewSplit { classes: Vec::new(), category_id: None, description: None, amount_cents: -5_000, transfer_account_id: Some(eur.clone()) }]).unwrap_err();
    assert!(e.contains("between two currencies"), "{e}");
    // Turning an entry into a transfer.
    assert!(queries::convert_to_transfer(&c, &p.id, &eur).is_err());
    // A scheduled transfer.
    let r = NewRecurrence {
        payee: "Monthly euros".into(), amount_cents: -5_000, account_id: Some(usd.clone()), category_id: None, freq: "monthly".into(),
        interval_n: 1, start_date: "2026-03-15".into(), end_date: None, second_day: None, weekend_rule: "none".into(), notes: None,
        transfer_account_id: Some(eur.clone()), goal_id: None,
    };
    assert!(queries::create_recurrence(&c, &r).is_err());
    // Merging.
    assert!(queries::merge_accounts(&c, &usd, &eur, false, true).is_err());
}

#[test]
fn an_accounts_currency_changes_only_when_no_transfer_would_change_meaning() {
    let db = TestDb::new("cur-change");
    let c = db.conn();
    let (usd, eur) = world(&c);
    queries::set_rate(&c, "GBP", "2026-01-01", 1_300_000, "manual").unwrap();
    // No links: free to relabel, amounts untouched.
    let a = queries::set_account_currency(&c, &eur, "GBP").unwrap();
    assert_eq!((a.currency.as_str(), a.balance_cents), ("GBP", 50_000));
    queries::set_account_currency(&c, &eur, "EUR").unwrap();
    // A rate is still needed.
    assert!(queries::set_account_currency(&c, &eur, "CAD").is_err());
    // Linked to a dollar account: it can become dollars, nothing else.
    let usd2 = queries::create_account(&c, "Savings", "savings", 0, None).unwrap().id;
    queries::create_transfer(&c, &usd, &usd2, "2026-03-07", 1_000, None).unwrap();
    assert!(queries::set_account_currency(&c, &usd2, "GBP").unwrap_err().contains("kept in USD"));
    // A transfer with two different amounts pins both accounts.
    queries::create_transfer_between(&c, &usd, &eur, "2026-03-05", 12_000, 10_000, None).unwrap();
    assert!(queries::set_account_currency(&c, &eur, "USD").is_err());
    assert!(queries::set_account_currency(&c, &eur, "GBP").is_err());
}

#[test]
fn reports_and_budgets_count_foreign_money_in_dollars_at_the_rate_on_the_day() {
    let db = TestDb::new("cur-reports");
    let c = db.conn();
    let (usd, eur) = world(&c);
    let groc = cat(&c, "Groceries");
    queries::create_transaction(&c, &usd, "2026-02-10", "Kroger", Some(&groc), -10_000, None, None).unwrap();
    // 100 EUR at 1.10 and 100 EUR at 1.20.
    queries::create_transaction(&c, &eur, "2026-02-20", "Lidl", Some(&groc), -10_000, None, None).unwrap();
    queries::create_transaction(&c, &eur, "2026-03-20", "Lidl", Some(&groc), -10_000, None, None).unwrap();

    let r = run_report(&c, &req("spending_by_category", "2026-02-01", "2026-03-31")).unwrap();
    let g = r.rows.iter().find(|l| l.label.contains("Groceries")).expect("groceries row");
    let total = g.cells[0].cents.unwrap();
    assert_eq!(total.abs(), 10_000 + 11_000 + 12_000, "{:?}", g.cells);

    // An amount filter is typed in dollars: 110 USD and up keeps both euro lines.
    let mut filtered = req("account_transactions", "2026-02-01", "2026-03-31");
    filtered.min_cents = Some(10_500);
    let rows = run_report(&c, &filtered).unwrap().rows;
    assert!(rows.iter().any(|l| l.cells.iter().any(|x| x.cents == Some(-11_000))));
    assert!(rows.iter().any(|l| l.cells.iter().any(|x| x.cents == Some(-12_000))));
    assert!(!rows.iter().any(|l| l.cells.iter().any(|x| x.cents == Some(-10_000))));

    // Net worth on Feb 28: 1,000 − 100 USD and 500 − 100 EUR at 1.10.
    let nw = run_report(&c, &req("net_worth", "2026-02-28", "2026-02-28")).unwrap();
    let total = nw.rows.iter().find(|l| l.label == "Net Worth").unwrap().cells[0].cents.unwrap();
    assert_eq!(total, 90_000 + 44_000);

    // The month's budget summary is in dollars too.
    let s = queries::get_spending_summary(&c, "2026-03").unwrap();
    let line = s.iter().find(|b| b.category_id == groc).expect("groceries");
    assert_eq!(line.spent_cents, 12_000);
}

#[test]
fn a_report_refuses_rather_than_drop_a_currency_with_no_rate() {
    let db = TestDb::new("cur-missing");
    let c = db.conn();
    let (_usd, _eur) = world(&c);
    // Only raw SQL can get here; the app refuses to delete the last rate.
    c.execute("DELETE FROM exchange_rates", []).unwrap();
    let e = run_report(&c, &req("net_worth", "2026-03-31", "2026-03-31")).unwrap_err();
    assert!(e.contains("no exchange rate for EUR"), "{e}");
    assert_eq!(queries::missing_rates(&c).unwrap(), vec!["EUR".to_string()]);
}

#[test]
fn debts_against_an_asset_are_counted_in_dollars() {
    let db = TestDb::new("cur-equity");
    let c = db.conn();
    queries::set_rate(&c, "EUR", "2020-01-01", 1_100_000, "manual").unwrap();
    let home = queries::create_account(&c, "House", "home", 30_000_000, None).unwrap().id;
    let loan = queries::create_account_in(&c, "Euro Loan", "loan", -1_000_000, None, "EUR").unwrap().id;
    c.execute("UPDATE accounts SET secured_by_account_id = ?1 WHERE id = ?2", [&home, &loan]).unwrap();
    let debts = queries::debts_by_asset(&c).unwrap();
    assert_eq!(debts.get(&home).copied(), Some(1_100_000));
}

#[test]
fn an_ofx_statement_in_another_currency_is_refused() {
    let db = TestDb::new("cur-ofx");
    let c = db.conn();
    let (usd, _eur) = world(&c);
    let ofx = "<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>EUR<BANKTRANLIST>
<STMTTRN><TRNAMT>-42.50</TRNAMT><DTPOSTED>20260801</DTPOSTED><NAME>Lidl</NAME></STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>";
    let path = db.dir.join("s.ofx");
    std::fs::write(&path, ofx).unwrap();
    let e = crate::import::import_file(&db.pool, path.to_str().unwrap(), &usd).unwrap_err();
    assert!(e.contains("This statement is in EUR"), "{e}");
    assert_eq!(queries::get_account(&c, &usd).unwrap().balance_cents, 100_000, "nothing written");
}

#[test]
fn every_statement_in_an_ofx_file_must_be_in_the_accounts_currency() {
    let db = TestDb::new("cur-ofx-multi");
    let c = db.conn();
    let (usd, _eur) = world(&c);
    let ofx = "<OFX><BANKMSGSRSV1>
<STMTTRNRS><STMTRS><CURDEF>USD<BANKTRANLIST>
<STMTTRN><TRNAMT>-10.00</TRNAMT><DTPOSTED>20260801</DTPOSTED><NAME>Kroger</NAME></STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS>
<STMTTRNRS><STMTRS><CURDEF>EUR<BANKTRANLIST>
<STMTTRN><TRNAMT>-42.50</TRNAMT><DTPOSTED>20260801</DTPOSTED><NAME>Lidl</NAME></STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>";
    let path = db.dir.join("two.ofx");
    std::fs::write(&path, ofx).unwrap();
    let e = crate::import::import_file(&db.pool, path.to_str().unwrap(), &usd).unwrap_err();
    assert!(e.contains("This statement is in EUR"), "{e}");
    assert_eq!(crate::import::ofx_currencies_for_tests(ofx), vec!["USD".to_string(), "EUR".to_string()]);
}

#[test]
fn a_foreign_cards_credit_limit_is_shown_in_dollars_beside_its_balance() {
    let db = TestDb::new("cur-limit");
    let c = db.conn();
    queries::set_rate(&c, "EUR", "2026-01-01", 1_200_000, "manual").unwrap();
    let card = queries::create_account_in(&c, "Euro Card", "credit", 0, Some("2026-01-01"), "EUR").unwrap().id;
    queries::update_account(&c, &card, "Euro Card", "credit", false, None, None, None, None, Some(500_000), None, None, None, None, None).unwrap();
    let r = run_report(&c, &req("account_balances_with_details", "2026-03-31", "2026-03-31")).unwrap();
    let line = r.rows.iter().find(|l| l.label == "Euro Card").unwrap();
    assert_eq!(line.cells.last().unwrap().cents, Some(600_000));
}

#[test]
fn budgets_refuse_rather_than_drop_a_currency_with_no_rate() {
    let db = TestDb::new("cur-budget-missing");
    let c = db.conn();
    let _ = world(&c);
    c.execute("DELETE FROM exchange_rates", []).unwrap();
    assert!(queries::get_spending_summary(&c, "2026-03").unwrap_err().contains("no exchange rate for EUR"));
    assert!(queries::budget_grid(&c, "2026-03").is_err());
    assert!(queries::autobudget(&c, "2026-03", 6).is_err());
}

#[test]
fn equity_leaves_out_only_the_asset_whose_debt_cannot_be_converted() {
    let db = TestDb::new("cur-equity-missing");
    let c = db.conn();
    queries::set_rate(&c, "EUR", "2020-01-01", 1_100_000, "manual").unwrap();
    let house = queries::create_account(&c, "House", "home", 30_000_000, None).unwrap().id;
    let cabin = queries::create_account(&c, "Cabin", "home", 10_000_000, None).unwrap().id;
    let euro_loan = queries::create_account_in(&c, "Euro Loan", "loan", -1_000_000, None, "EUR").unwrap().id;
    let usd_loan = queries::create_account(&c, "Loan", "loan", -500_000, None).unwrap().id;
    c.execute("UPDATE accounts SET secured_by_account_id = ?1 WHERE id = ?2", [&house, &euro_loan]).unwrap();
    c.execute("UPDATE accounts SET secured_by_account_id = ?1 WHERE id = ?2", [&cabin, &usd_loan]).unwrap();
    c.execute("DELETE FROM exchange_rates", []).unwrap();
    let debts = queries::debts_by_asset(&c).unwrap();
    assert_eq!(debts.get(&cabin).copied(), Some(500_000));
    assert_eq!(debts.get(&house), None);
}

#[test]
fn transfer_amounts_are_bounded() {
    let db = TestDb::new("cur-bounds");
    let c = db.conn();
    let (usd, eur) = world(&c);
    assert!(queries::create_transfer_between(&c, &usd, &eur, "2026-03-05", i64::MIN, 10_000, None).is_err());
    assert!(queries::create_transfer_between(&c, &usd, &eur, "2026-03-05", 10_000, queries::MAX_CENTS + 1, None).is_err());
    assert!(queries::create_transfer(&c, &usd, &eur, "2026-03-05", 0, None).is_err());
}

/// A file kept in euros: a dollar account converts at a rate quoted in euros.
fn euro_world(c: &Conn) -> (String, String) {
    queries::set_home_currency(c, "EUR", true).unwrap();
    queries::set_rate(c, "USD", "2026-01-01", 900_000, "manual").unwrap();
    let eur = queries::create_account(c, "Girokonto", "checking", 100_000, Some("2026-01-01")).unwrap().id;
    let usd = queries::create_account_in(c, "US Checking", "checking", 50_000, Some("2026-01-01"), "USD").unwrap().id;
    (eur, usd)
}

#[test]
fn a_file_kept_in_euros_reports_in_euros() {
    let db = TestDb::new("home-eur");
    let c = db.conn();
    let (eur, usd) = euro_world(&c);
    assert_eq!(queries::home_currency(&c).unwrap(), "EUR");
    // New accounts default to the home currency; the home one needs no rate.
    assert_eq!(queries::get_account(&c, &eur).unwrap().currency, "EUR");
    assert_eq!(queries::get_account(&c, &eur).unwrap().home_rate_micro, 1_000_000);
    assert_eq!(queries::get_account(&c, &usd).unwrap().home_rate_micro, 900_000);
    // Net worth: 1,000 EUR + 500 USD at 0.90.
    let nw = run_report(&c, &req("net_worth", "2026-03-31", "2026-03-31")).unwrap();
    assert_eq!(nw.rows.iter().find(|l| l.label == "Net Worth").unwrap().cells[0].cents, Some(100_000 + 45_000));
    // Spending in dollars counts in euros.
    let groc = cat(&c, "Groceries");
    queries::create_transaction(&c, &usd, "2026-02-10", "Walmart", Some(&groc), -10_000, None, None).unwrap();
    let s = queries::get_spending_summary(&c, "2026-02").unwrap();
    assert_eq!(s.iter().find(|b| b.category_id == groc).unwrap().spent_cents, 9_000);
    // An investment account is kept in euros; one in dollars is refused.
    assert!(queries::create_account_in(&c, "Depot", "investment", 0, None, "USD").is_err());
    assert_eq!(queries::create_account(&c, "Depot", "investment", 0, None).unwrap().currency, "EUR");
    // The home currency has no rate of its own.
    assert!(queries::set_rate(&c, "EUR", "2026-01-01", 1_000_000, "manual").is_err());
}

#[test]
fn rates_count_only_in_the_home_currency_they_were_quoted_in() {
    let db = TestDb::new("home-quote");
    let c = db.conn();
    let (_usd, _eur) = world(&c);
    // EUR rates were quoted in dollars. Make GBP the home currency without
    // relabeling: the dollar and euro accounts are now foreign and have no
    // rate in pounds, so totals refuse until they get one.
    queries::set_home_currency(&c, "GBP", false).unwrap();
    assert_eq!(queries::missing_rates(&c).unwrap(), vec!["EUR".to_string(), "USD".to_string()]);
    assert!(run_report(&c, &req("net_worth", "2026-03-31", "2026-03-31")).is_err());
    assert!(queries::list_rates(&c).unwrap().is_empty(), "the dollar-quoted rates are not offered");
    queries::set_rate(&c, "USD", "2026-01-01", 800_000, "manual").unwrap();
    queries::set_rate(&c, "EUR", "2026-01-01", 850_000, "manual").unwrap();
    // 1,000 USD at 0.80 + 500 EUR at 0.85.
    let nw = run_report(&c, &req("net_worth", "2026-03-31", "2026-03-31")).unwrap();
    assert_eq!(nw.rows.iter().find(|l| l.label == "Net Worth").unwrap().cells[0].cents, Some(80_000 + 42_500));
    // And back: the dollar rates are still there for dollars.
    queries::set_home_currency(&c, "USD", false).unwrap();
    assert!(queries::missing_rates(&c).unwrap().is_empty());
}

#[test]
fn changing_the_home_currency_relabels_only_when_that_cannot_break_a_transfer() {
    let db = TestDb::new("home-relabel");
    let c = db.conn();
    let usd = queries::create_account(&c, "Checking", "checking", 100_000, Some("2026-01-01")).unwrap().id;
    let brokerage = queries::create_account(&c, "Brokerage", "investment", 0, Some("2026-01-01")).unwrap().id;
    let savings = queries::create_account(&c, "Savings", "savings", 0, Some("2026-01-01")).unwrap().id;
    queries::create_transfer(&c, &usd, &savings, "2026-02-01", 10_000, None).unwrap();
    // Without relabeling, the dollar investment account would be foreign.
    assert!(queries::set_home_currency(&c, "EUR", false).unwrap_err().contains("investment"));
    // Relabeling: the file was in euros all along.
    queries::set_home_currency(&c, "EUR", true).unwrap();
    assert_eq!(queries::get_account(&c, &usd).unwrap().currency, "EUR");
    assert_eq!(queries::get_account(&c, &brokerage).unwrap().currency, "EUR");
    assert_eq!(queries::get_account(&c, &usd).unwrap().balance_cents, 100_000 - 10_000, "amounts untouched");
    // Both sides of the transfer moved together: still one currency, still equal.
    assert_eq!(queries::get_account(&c, &savings).unwrap().currency, "EUR");
    // An account already in the new currency blocks relabeling into it.
    queries::set_rate(&c, "GBP", "2026-01-01", 1_150_000, "manual").unwrap();
    queries::create_account_in(&c, "Pounds", "savings", 0, None, "GBP").unwrap();
    assert!(queries::set_home_currency(&c, "GBP", true).unwrap_err().contains("already kept in GBP"));
    assert!(queries::set_home_currency(&c, "JPY", true).is_err());
}

#[test]
fn the_files_region_is_stored_and_checked() {
    let db = TestDb::new("home-region");
    let c = db.conn();
    let f = queries::file_format(&c).unwrap();
    assert_eq!((f.home_currency.as_str(), f.region.as_str()), ("USD", "en-US"));
    queries::set_region(&c, "de-DE").unwrap();
    assert_eq!(queries::file_format(&c).unwrap().region, "de-DE");
    assert!(queries::set_region(&c, "xx-XX").is_err());
}

#[test]
fn a_quote_in_another_currency_than_the_homes_is_refused() {
    let body = r#"{"chart":{"result":[{"meta":{"currency":"EUR","regularMarketPrice":12.5}}],"error":null}}"#;
    let today = chrono::NaiveDate::from_ymd_opt(2026, 10, 1).unwrap();
    assert!(crate::prices::parse_quote_json(body, today).is_err(), "a dollar file refuses a euro price");
    assert!(crate::prices::parse_quote_json_in(body, today, "EUR").is_ok(), "a euro file takes it");
}

#[test]
fn a_rate_fetched_before_the_home_currency_changed_is_not_stored() {
    let db = TestDb::new("home-race");
    let c = db.conn();
    let (_usd, _eur) = world(&c);
    // A fetch began in a dollar file; the home currency is pounds by the
    // time it writes.
    queries::set_home_currency(&c, "GBP", false).unwrap();
    let e = queries::set_rate_quoted(&c, "EUR", "USD", "2026-03-10", 1_080_000, "fetched").unwrap_err();
    assert!(e.contains("changed from USD to GBP"), "{e}");
    assert!(queries::list_rates(&c).unwrap().is_empty());
}

#[test]
fn a_stored_home_currency_that_is_not_a_code_reads_as_dollars_everywhere() {
    let db = TestDb::new("home-corrupt");
    let c = db.conn();
    let (_usd, _eur) = world(&c);
    queries::set_setting(&c, crate::currency::HOME_KEY, "usd").unwrap();
    assert_eq!(queries::home_currency(&c).unwrap(), "USD");
    // SQL agrees with Rust: dollars are home, euros convert, reports run.
    assert_eq!(queries::currencies_in_use(&c).unwrap(), vec!["EUR".to_string()]);
    assert!(run_report(&c, &req("net_worth", "2026-03-31", "2026-03-31")).is_ok());
    // Choosing dollars writes the value over.
    queries::set_home_currency(&c, "USD", false).unwrap();
    assert_eq!(queries::get_setting(&c, crate::currency::HOME_KEY).unwrap().as_deref(), Some("USD"));
}
