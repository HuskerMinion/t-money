//! §94 — loans: their terms, their amortization, and recording a payment.
//!
//! A mortgage payment is one transaction with three parts that go three
//! different places: interest to a category (it is spending), escrow to an
//! account (it is money you still have, held by the bank), and principal to
//! the loan itself (it is debt repaid, not spending). Splits could only hold
//! categories until migration 0033 gave them a transfer, which is what makes
//! that single transaction possible.
//!
//! **The schedule is a starting point, never the truth.** Banks round
//! differently, change escrow mid-year, apply a payment a day late and charge
//! an extra day of interest. Every part of every payment can be typed over,
//! and the loan's balance is whatever the payments actually applied — not what
//! this file thinks it should be.

use crate::db::queries::Conn;
use crate::models::{LoanPeriod, LoanTerms, NewSplit};
use chrono::{Datelike, NaiveDate};
use rusqlite::{params, OptionalExtension};

/// Rounding to the cent, half away from zero — the same rule as
/// `lots::mul_div`, so interest here and value there round alike.
fn round_div(n: i128, d: i128) -> i64 {
    let q = n / d;
    let r = n % d;
    let adj = if (r.abs() * 2) >= d.abs() {
        if (n < 0) != (d < 0) {
            -1
        } else {
            1
        }
    } else {
        0
    };
    (q + adj) as i64
}

/// One month's interest on `balance_cents` at `apr_micro`.
///
/// `balance × apr / 12`, in integers throughout: a rate of 6.0% is
/// 6_000_000 millionths, so the divisor is 100 × 1_000_000 × 12.
pub fn monthly_interest(balance_cents: i64, apr_micro: i64) -> i64 {
    if balance_cents <= 0 || apr_micro <= 0 {
        return 0;
    }
    round_div(balance_cents as i128 * apr_micro as i128, 100i128 * 1_000_000i128 * 12i128)
}

/// What is owed on a loan, positive. A liability's register balance is
/// negative; this is the number people say out loud.
pub fn owed(conn: &Conn, account_id: &str) -> Result<i64, String> {
    let b: i64 = conn
        .query_row("SELECT balance_cents FROM accounts WHERE id = ?1", params![account_id], |r| r.get(0))
        .map_err(|_| format!("account {account_id} not found"))?;
    Ok(-b)
}

pub fn get_terms(conn: &Conn, account_id: &str) -> Result<Option<LoanTerms>, String> {
    conn.query_row(
        "SELECT account_id, apr_micro, payment_cents, escrow_cents, escrow_account_id,
                escrow_category_id, interest_category_id, from_account_id, payment_day,
                first_payment_date, term_months, notes, extra_principal_cents
           FROM loan_terms WHERE account_id = ?1",
        params![account_id],
        |r| {
            Ok(LoanTerms {
                account_id: r.get(0)?,
                apr_micro: r.get(1)?,
                payment_cents: r.get(2)?,
                escrow_cents: r.get(3)?,
                escrow_account_id: r.get(4)?,
                escrow_category_id: r.get(5)?,
                interest_category_id: r.get(6)?,
                from_account_id: r.get(7)?,
                payment_day: r.get(8)?,
                first_payment_date: r.get(9)?,
                term_months: r.get(10)?,
                notes: r.get(11)?,
                extra_principal_cents: r.get(12)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

pub fn set_terms(conn: &Conn, t: &LoanTerms) -> Result<(), String> {
    let kind: String = conn
        .query_row("SELECT type FROM accounts WHERE id = ?1", params![t.account_id], |r| r.get(0))
        .map_err(|_| format!("account {} not found", t.account_id))?;
    if !matches!(kind.as_str(), "loan" | "mortgage" | "home_equity_line_of_credit" | "liability" | "line_of_credit") {
        return Err(format!("a {kind} account is not a loan"));
    }
    if t.apr_micro < 0 || t.payment_cents < 0 || t.escrow_cents < 0 {
        return Err("a rate, a payment and an escrow amount cannot be negative".to_string());
    }
    if t.extra_principal_cents < 0 {
        // Paying LESS than the schedule is not an extra payment, it is a
        // short one, and it is recorded by typing over the payment itself.
        return Err("extra principal is zero or more".to_string());
    }
    if t.escrow_cents > 0 && t.escrow_account_id.is_none() && t.escrow_category_id.is_none() {
        return Err("say where the escrow part goes — an escrow account, or a category".to_string());
    }
    if let Some(d) = t.first_payment_date.as_deref() {
        NaiveDate::parse_from_str(d, "%Y-%m-%d").map_err(|_| format!("{d:?} is not a date"))?;
    }
    // §178: a day of the month is 1 to 31. A 0 used to be saved, and the
    // schedule then asked chrono for the 0th of every month, got nothing, and
    // printed the same date for every payment.
    if let Some(day) = t.payment_day {
        if !(1..=31).contains(&day) {
            return Err(format!("the payment day is a day of the month, 1 to 31 — not {day}"));
        }
    }
    conn.execute(
        "INSERT INTO loan_terms
           (account_id, apr_micro, payment_cents, escrow_cents, escrow_account_id,
            escrow_category_id, interest_category_id, from_account_id, payment_day,
            first_payment_date, term_months, notes, extra_principal_cents, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, datetime('now'))
         ON CONFLICT(account_id) DO UPDATE SET
            apr_micro = excluded.apr_micro,
            payment_cents = excluded.payment_cents,
            escrow_cents = excluded.escrow_cents,
            escrow_account_id = excluded.escrow_account_id,
            escrow_category_id = excluded.escrow_category_id,
            interest_category_id = excluded.interest_category_id,
            from_account_id = excluded.from_account_id,
            payment_day = excluded.payment_day,
            first_payment_date = excluded.first_payment_date,
            term_months = excluded.term_months,
            notes = excluded.notes,
            extra_principal_cents = excluded.extra_principal_cents,
            updated_at = datetime('now')",
        params![
            t.account_id,
            t.apr_micro,
            t.payment_cents,
            t.escrow_cents,
            t.escrow_account_id,
            t.escrow_category_id,
            t.interest_category_id,
            t.from_account_id,
            t.payment_day,
            t.first_payment_date,
            t.term_months,
            t.notes,
            t.extra_principal_cents
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn clear_terms(conn: &Conn, account_id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM loan_terms WHERE account_id = ?1", params![account_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// The same day next month, clamped to the month's length: the 31st becomes
/// the 30th in April and the 28th in February, which is what a lender does.
fn add_month(d: NaiveDate, day_of_month: u32) -> NaiveDate {
    let (y, m) = if d.month() == 12 { (d.year() + 1, 1) } else { (d.year(), d.month() + 1) };
    let last = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ => {
            if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 {
                29
            } else {
                28
            }
        }
    };
    NaiveDate::from_ymd_opt(y, m, day_of_month.min(last)).unwrap_or(d)
}

/// What the next payment would be, from what is owed today.
///
/// Interest first, principal is the rest of the payment, and a final payment
/// never takes more principal than is left — the last one is smaller, as it
/// is in life.
pub fn next_payment(conn: &Conn, account_id: &str, date: &str) -> Result<LoanPeriod, String> {
    let terms = get_terms(conn, account_id)?.ok_or("this loan has no terms set yet")?;
    let opening = owed(conn, account_id)?;
    Ok(period(&terms, opening, date))
}

fn period(terms: &LoanTerms, opening: i64, date: &str) -> LoanPeriod {
    let interest = monthly_interest(opening, terms.apr_micro);
    let mut principal = terms.payment_cents - interest;
    if principal < 0 {
        // The payment does not even cover the interest: nothing comes off.
        principal = 0;
    }
    // §178: never more than is left, and nothing is left on a loan that is
    // paid off or overpaid. Clamping to a negative opening balance proposed a
    // negative principal — a payment that ADDED to the debt.
    let left = opening.max(0);
    if principal > left {
        principal = left;
    }
    // §121: extra principal is paid ON TOP of the scheduled payment, so it
    // comes off after the scheduled principal and never takes more than is
    // left. Interest is charged on the opening balance either way — paying
    // ahead does not earn a discount this month, it shrinks next month's.
    let extra = terms.extra_principal_cents.min(left - principal).max(0);
    LoanPeriod {
        date: date.to_string(),
        payment_cents: interest + principal,
        interest_cents: interest,
        principal_cents: principal,
        escrow_cents: terms.escrow_cents,
        extra_principal_cents: extra,
        opening_cents: opening,
        closing_cents: opening - principal - extra,
    }
}

/// The schedule from today forward, at most `count` payments and stopping
/// when the loan is paid off. Nothing is written.
pub fn schedule(conn: &Conn, account_id: &str, from: &str, count: usize) -> Result<Vec<LoanPeriod>, String> {
    let terms = get_terms(conn, account_id)?.ok_or("this loan has no terms set yet")?;
    let opening = owed(conn, account_id)?;
    schedule_with(&terms, opening, from, count)
}

/// `schedule`, over terms that have not been saved — what the Loan terms
/// dialog previews while a rate or a payment is being typed. Nothing is read
/// and nothing is written; the balance is passed in.
pub fn schedule_with(terms: &LoanTerms, opening: i64, from: &str, count: usize) -> Result<Vec<LoanPeriod>, String> {
    let mut balance = opening;
    let mut date = NaiveDate::parse_from_str(from, "%Y-%m-%d").map_err(|_| format!("{from:?} is not a date"))?;
    // §178: a day outside 1..=31 — a 0 saved before `set_terms` checked — is
    // read as no day at all, which follows the start date.
    let day = terms
        .payment_day
        .filter(|d| (1..=31).contains(d))
        .map(|d| d as u32)
        .unwrap_or_else(|| date.day());
    let mut out = Vec::new();
    for i in 0..count {
        if balance <= 0 {
            break;
        }
        if i > 0 {
            date = add_month(date, day);
        }
        let p = period(terms, balance, &date.format("%Y-%m-%d").to_string());
        if p.principal_cents == 0 && p.extra_principal_cents == 0 && p.interest_cents >= terms.payment_cents {
            // The payment never reduces the balance: say so once rather than
            // printing a schedule that runs forever.
            out.push(p);
            break;
        }
        balance = p.closing_cents;
        out.push(p);
    }
    Ok(out)
}

/// Record a payment as ONE transaction in the funding account, split up to
/// four ways. Every amount is the caller's — the schedule only proposed them.
///
/// §121: extra principal is its own line rather than more principal, because
/// it is its own decision — the point of paying it is being able to see, a
/// year later, which months carried it. It transfers to the same loan, so the
/// loan register gets two decrease rows for a month paid ahead, which is how
/// a servicer reports it too.
///
/// Returns the id of the transaction written.
#[allow(clippy::too_many_arguments)]
pub fn record_payment(
    conn: &Conn,
    account_id: &str,
    from_account_id: &str,
    date: &str,
    interest_cents: i64,
    principal_cents: i64,
    escrow_cents: i64,
    extra_principal_cents: i64,
    payee: &str,
    check_number: Option<&str>,
    notes: Option<&str>,
) -> Result<String, String> {
    if interest_cents < 0 || principal_cents < 0 || escrow_cents < 0 || extra_principal_cents < 0 {
        return Err("interest, principal, escrow and extra principal are each zero or more".to_string());
    }
    let total = interest_cents + principal_cents + escrow_cents + extra_principal_cents;
    if total <= 0 {
        return Err("a payment of nothing is not a payment".to_string());
    }
    let terms = get_terms(conn, account_id)?.ok_or("this loan has no terms set yet")?;
    if from_account_id == account_id {
        return Err("a loan cannot pay itself".to_string());
    }

    let mut splits: Vec<NewSplit> = Vec::new();
    if interest_cents > 0 {
        splits.push(NewSplit { classes: Vec::new(),
            category_id: terms.interest_category_id.clone(),
            description: Some("Interest".to_string()),
            amount_cents: -interest_cents,
            transfer_account_id: None,
        });
    }
    if principal_cents > 0 {
        splits.push(NewSplit { classes: Vec::new(),
            category_id: None,
            description: Some("Principal".to_string()),
            amount_cents: -principal_cents,
            transfer_account_id: Some(account_id.to_string()),
        });
    }
    if extra_principal_cents > 0 {
        // §121: the same destination as the principal line and deliberately
        // NOT merged into it. One transaction still leaves the checking
        // account, so the register matches the statement's single amount.
        splits.push(NewSplit { classes: Vec::new(),
            category_id: None,
            description: Some("Extra principal".to_string()),
            amount_cents: -extra_principal_cents,
            transfer_account_id: Some(account_id.to_string()),
        });
    }
    if escrow_cents > 0 {
        // §178: terms saved with no escrow amount say nothing about where
        // escrow goes, and an escrow typed into the payment then became a
        // line with neither a category nor an account — money out of checking
        // filed nowhere. Refused before anything is written.
        if terms.escrow_account_id.is_none() && terms.escrow_category_id.is_none() {
            return Err(
                "The loan terms don't say where escrow goes — set an escrow account or category in the loan terms first."
                    .to_string(),
            );
        }
        // An escrow account is money you still have, held by the bank; a
        // category spends it now. The terms say which, and the account wins
        // when both are set.
        match terms.escrow_account_id.as_deref() {
            Some(a) => splits.push(NewSplit { classes: Vec::new(),
                category_id: None,
                description: Some("Escrow".to_string()),
                amount_cents: -escrow_cents,
                transfer_account_id: Some(a.to_string()),
            }),
            None => splits.push(NewSplit { classes: Vec::new(),
                category_id: terms.escrow_category_id.clone(),
                description: Some("Escrow".to_string()),
                amount_cents: -escrow_cents,
                transfer_account_id: None,
            }),
        }
    }

    // §178: the row and its lines in one SQL transaction. They were two, and
    // lines refused after the row was committed left the whole payment in
    // checking as one unsplit, uncategorized row, with the loan never paid
    // down.
    let txn = crate::db::queries::create_transaction_with_splits(
        conn,
        &crate::models::NewTransaction {
            account_id: from_account_id.to_string(),
            date: date.to_string(),
            payee: payee.to_string(),
            category_id: None,
            amount_cents: -total,
            notes: notes.map(str::to_string),
            check_number: check_number.map(str::to_string),
            splits: Some(splits),
        },
    )?;
    Ok(txn.id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interest_is_the_balance_times_the_rate_over_twelve_in_whole_cents() {
        // $150,000 at 6.0%: 150000 * 0.06 / 12 = 750.00
        assert_eq!(monthly_interest(15_000_000, 6_000_000), 75_000);
        // A month later: 149,850.67 * 0.06 / 12 = 749.25335…
        assert_eq!(monthly_interest(14_985_067, 6_000_000), 74_925);
        // Half a cent rounds away from zero, as everywhere else in the file.
        assert_eq!(monthly_interest(20_000, 6_000_000), 100);
        assert_eq!(monthly_interest(0, 6_000_000), 0);
        assert_eq!(monthly_interest(15_000_000, 0), 0, "an interest-free loan");
    }

    #[test]
    fn a_payment_day_lands_on_a_short_month() {
        let d = NaiveDate::from_ymd_opt(2026, 1, 31).unwrap();
        assert_eq!(add_month(d, 31), NaiveDate::from_ymd_opt(2026, 2, 28).unwrap());
        assert_eq!(add_month(NaiveDate::from_ymd_opt(2028, 1, 31).unwrap(), 31), NaiveDate::from_ymd_opt(2028, 2, 29).unwrap());
        assert_eq!(add_month(NaiveDate::from_ymd_opt(2026, 3, 31).unwrap(), 31), NaiveDate::from_ymd_opt(2026, 4, 30).unwrap());
        assert_eq!(add_month(NaiveDate::from_ymd_opt(2026, 12, 15).unwrap(), 15), NaiveDate::from_ymd_opt(2027, 1, 15).unwrap());
    }
}

#[cfg(test)]
mod payment_tests {
    use super::*;
    use crate::db::queries;

    // §182 — checked whole when the test ends.
    use crate::db::test_db::TestDb;

    /// §119: what an account says it is worth, and how many rows it has —
    /// the two things an undo has to put back exactly.
    fn balance(c: &Conn, id: &str) -> i64 {
        c.query_row("SELECT balance_cents FROM accounts WHERE id = ?1", params![id], |r| r.get(0)).unwrap()
    }
    fn count(c: &Conn, id: &str) -> i64 {
        c.query_row("SELECT COUNT(*) FROM transactions WHERE account_id = ?1", params![id], |r| r.get(0)).unwrap()
    }

    struct Setup {
        chk: String,
        house: String,
        mortgage: String,
        escrow: String,
        interest_cat: String,
    }

    fn setup(c: &Conn) -> Setup {
        let chk = queries::create_account(c, "Checking", "checking", 500_000, Some("2026-01-01")).unwrap().id;
        let house = queries::create_account(c, "House", "home", 35_000_000, Some("2026-01-01")).unwrap().id;
        let mortgage = queries::create_account(c, "Mortgage", "mortgage", -15_000_000, Some("2026-01-01")).unwrap().id;
        let escrow = queries::create_account(c, "Escrow", "asset", 120_000, Some("2026-01-01")).unwrap().id;
        let interest_cat = queries::list_categories(c)
            .unwrap()
            .into_iter()
            .find(|x| x.name == "Interest Paid")
            .map(|x| x.id)
            .expect("Interest Paid category");
        queries::set_account_security(c, &mortgage, Some(&house)).unwrap();
        set_terms(
            c,
            &LoanTerms {
                account_id: mortgage.clone(),
                apr_micro: 6_000_000, // 6.0%
                // P&I on $150,000 over 360 months at 0.5% a month:
                // 150000 * 0.005 / (1 - 1.005^-360) = 899.33
                payment_cents: 89_933,
                escrow_cents: 45_000,
                escrow_account_id: Some(escrow.clone()),
                escrow_category_id: None,
                interest_category_id: Some(interest_cat.clone()),
                from_account_id: Some(chk.clone()),
                payment_day: Some(1),
                first_payment_date: Some("2026-02-01".into()),
                term_months: Some(360),
                notes: None,
                extra_principal_cents: 0,
            },
        )
        .unwrap();
        Setup { chk, house, mortgage, escrow, interest_cat }
    }

    /// §94. The thing that was asked for: one payment out of checking, and the
    /// mortgage goes down by the principal part of it.
    #[test]
    fn one_payment_splits_three_ways_and_the_mortgage_balance_falls() {
        let db = TestDb::new("pay");
        let c = db.conn();
        let s = setup(&c);

        let next = next_payment(&c, &s.mortgage, "2026-02-01").unwrap();
        assert_eq!(next.opening_cents, 15_000_000);
        assert_eq!(next.interest_cents, 75_000, "150,000 at 6.0% for a month");
        assert_eq!(next.principal_cents, 89_933 - 75_000);
        assert_eq!(next.escrow_cents, 45_000);
        assert_eq!(next.closing_cents, 15_000_000 - (89_933 - 75_000));

        let id = record_payment(
            &c,
            &s.mortgage,
            &s.chk,
            "2026-02-01",
            next.interest_cents,
            next.principal_cents,
            next.escrow_cents,
            0,
            "Summit Home Loans",
            None,
            None,
        )
        .unwrap();

        let total = next.interest_cents + next.principal_cents + next.escrow_cents;
        assert_eq!(queries::get_account(&c, &s.chk).unwrap().balance_cents, 500_000 - total);
        // The whole point.
        assert_eq!(owed(&c, &s.mortgage).unwrap(), 15_000_000 - next.principal_cents);
        assert_eq!(queries::get_account(&c, &s.escrow).unwrap().balance_cents, 120_000 + 45_000);
        // The house is untouched: paying a mortgage does not change what the
        // house is worth, it changes what you own of it.
        assert_eq!(queries::get_account(&c, &s.house).unwrap().balance_cents, 35_000_000);
        assert_eq!(queries::debts_by_asset(&c).unwrap().get(&s.house).copied(), Some(15_000_000 - next.principal_cents));

        // One transaction in checking, three lines (nothing paid ahead), and
        // only the interest line carries a category.
        let splits = queries::list_splits(&c, &id).unwrap();
        assert_eq!(splits.len(), 3);
        assert_eq!(splits[0].category_id.as_deref(), Some(s.interest_cat.as_str()));
        assert_eq!(splits[0].transfer_account_id, None);
        assert_eq!(splits[1].description.as_deref(), Some("Principal"));
        assert_eq!(splits[1].transfer_account_id.as_deref(), Some(s.mortgage.as_str()));
        assert_eq!(splits[1].transfer_account_name.as_deref(), Some("Mortgage"));
        assert_eq!(splits[2].transfer_account_id.as_deref(), Some(s.escrow.as_str()));
    }

    /// The bank's arithmetic wins: whatever is typed is what is recorded.
    #[test]
    fn the_numbers_can_be_typed_over_and_the_balance_follows_what_was_applied() {
        let db = TestDb::new("pay-override");
        let c = db.conn();
        let s = setup(&c);

        // The statement says the interest was a dollar more and escrow went
        // up — the schedule does not get a vote.
        record_payment(&c, &s.mortgage, &s.chk, "2026-02-01", 76_000, 13_933, 48_000, 0, "Mortgage", None, Some("per statement")).unwrap();

        assert_eq!(owed(&c, &s.mortgage).unwrap(), 15_000_000 - 13_933);
        assert_eq!(queries::get_account(&c, &s.escrow).unwrap().balance_cents, 120_000 + 48_000);
        assert_eq!(queries::get_account(&c, &s.chk).unwrap().balance_cents, 500_000 - (76_000 + 13_933 + 48_000));

        // And the next schedule is computed from where the loan actually is.
        let next = next_payment(&c, &s.mortgage, "2026-03-01").unwrap();
        assert_eq!(next.opening_cents, 15_000_000 - 13_933);
    }

    #[test]
    fn deleting_a_payment_puts_the_principal_back_on_the_loan() {
        let db = TestDb::new("pay-delete");
        let c = db.conn();
        let s = setup(&c);
        let id = record_payment(&c, &s.mortgage, &s.chk, "2026-02-01", 75_000, 14_933, 45_000, 0, "Mortgage", None, None).unwrap();
        assert_eq!(owed(&c, &s.mortgage).unwrap(), 15_000_000 - 14_933);

        queries::delete_transaction(&c, &id).unwrap();

        assert_eq!(owed(&c, &s.mortgage).unwrap(), 15_000_000, "the loan is back where it was");
        assert_eq!(queries::get_account(&c, &s.escrow).unwrap().balance_cents, 120_000);
        assert_eq!(queries::get_account(&c, &s.chk).unwrap().balance_cents, 500_000);
    }

    /// A transfer is not spending. The interest is.
    #[test]
    fn only_the_interest_reaches_the_spending_reports() {
        use crate::db::reports::run_report;
        use crate::models::ReportRequest;
        let db = TestDb::new("pay-reports");
        let c = db.conn();
        let s = setup(&c);
        record_payment(&c, &s.mortgage, &s.chk, "2026-02-01", 75_000, 14_933, 45_000, 0, "Mortgage", None, None).unwrap();

        let r = run_report(
            &c,
            &ReportRequest {
                kind: "spending_by_category".into(),
                from: "2026-01-01".into(),
                to: "2026-12-31".into(),
                account_ids: None,
                category_ids: None,
                compare_from: None,
                compare_to: None,
                detail: None,
                security_ids: None,
                tax_scope: None, ..Default::default()
            },
        )
        .unwrap();
        let dump = || r.rows.iter().map(|x| (x.label.clone(), x.cells.clone())).collect::<Vec<_>>();
        let amount = |label: &str| r.rows.iter().find(|x| x.label == label).and_then(|x| x.cells.first()).and_then(|c| c.cents);

        // The interest is spending, and it is the ONLY part of the payment
        // that is. The principal went to the loan and the escrow to the
        // escrow account; both are transfers, so neither appears here — not
        // as a line of its own and not swept into Uncategorized. Nor does the
        // mortgage's $150,000 opening balance, which is debt that already
        // existed, not money spent in February.
        assert_eq!(amount("Interest Paid"), Some(75_000), "{:?}", dump());
        assert_eq!(amount("Total spending"), Some(75_000), "{:?}", dump());
        assert!(
            r.rows.iter().all(|x| x.label != "Uncategorized"),
            "half a mortgage payment leaked into spending: {:?}",
            dump()
        );
    }

    #[test]
    fn the_schedule_pays_the_loan_off_and_the_last_payment_is_the_stub() {
        let db = TestDb::new("sched");
        let c = db.conn();
        let chk = queries::create_account(&c, "Checking", "checking", 100_000, Some("2026-01-01")).unwrap().id;
        let loan = queries::create_account(&c, "Small loan", "loan", -100_000, Some("2026-01-01")).unwrap().id;
        set_terms(
            &c,
            &LoanTerms {
                account_id: loan.clone(),
                apr_micro: 12_000_000, // 1% a month, easy to check by hand
                payment_cents: 30_000,
                escrow_cents: 0,
                escrow_account_id: None,
                escrow_category_id: None,
                interest_category_id: None,
                from_account_id: Some(chk),
                payment_day: Some(1),
                first_payment_date: Some("2026-02-01".into()),
                term_months: Some(4),
                notes: None,
                extra_principal_cents: 0,
            },
        )
        .unwrap();

        let s = schedule(&c, &loan, "2026-02-01", 24).unwrap();
        assert_eq!(s[0].interest_cents, 1_000, "1% of $1,000");
        assert_eq!(s[0].principal_cents, 29_000);
        assert!(s.len() <= 5, "a $1,000 loan at $300 a month does not take {} payments", s.len());
        assert_eq!(s.last().unwrap().closing_cents, 0, "it pays off");
        assert!(
            s.last().unwrap().payment_cents < 30_000,
            "the last payment is the stub that is left, not a full one"
        );
        // Every period hands its closing balance to the next one's opening.
        for w in s.windows(2) {
            assert_eq!(w[0].closing_cents, w[1].opening_cents);
        }
    }

    #[test]
    fn a_payment_that_does_not_cover_the_interest_is_said_once_rather_than_forever() {
        let db = TestDb::new("sched-neg");
        let c = db.conn();
        let loan = queries::create_account(&c, "Bad loan", "loan", -10_000_000, Some("2026-01-01")).unwrap().id;
        set_terms(
            &c,
            &LoanTerms {
                account_id: loan.clone(),
                apr_micro: 24_000_000,
                payment_cents: 1_000,
                escrow_cents: 0,
                escrow_account_id: None,
                escrow_category_id: None,
                interest_category_id: None,
                from_account_id: None,
                payment_day: Some(1),
                first_payment_date: None,
                term_months: None,
                notes: None,
                extra_principal_cents: 0,
            },
        )
        .unwrap();
        let s = schedule(&c, &loan, "2026-02-01", 500).unwrap();
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].principal_cents, 0);
    }

    /// §119 — Ctrl+Z after Record payment.
    ///
    /// It was not undoable, and this is the write that most needed it: one row
    /// in the checking register, three split lines, and transfer rows in the
    /// loan and the escrow account. Putting a mistake back by hand meant
    /// finding all of them. This runs exactly what `record_loan_payment` runs.
    #[test]
    fn recording_a_payment_can_be_undone_in_one_step() {
        use crate::db::undo;
        let db = TestDb::new("undo-pay");
        let c = db.conn();
        let s = setup(&c);
        let owed_before = balance(&c, &s.mortgage);
        let cash_before = balance(&c, &s.chk);
        let escrow_before = balance(&c, &s.escrow);
        let rows_before = count(&c, &s.chk);

        let next = next_payment(&c, &s.mortgage, "2026-02-01").unwrap();
        let (id, step) = undo::recording(&c, "record a loan payment", &[], || {
            record_payment(
                &c,
                &s.mortgage,
                &s.chk,
                "2026-02-01",
                next.interest_cents,
                next.principal_cents,
                next.escrow_cents,
                0,
                "Summit Home Loans",
                None,
                None,
            )
        })
        .unwrap();
        let step = undo::creation_step(&c, step, &id, &[]).unwrap();

        // It landed everywhere it should have.
        assert_eq!(balance(&c, &s.mortgage), owed_before + next.principal_cents);
        assert_eq!(balance(&c, &s.chk), cash_before - (next.interest_cents + next.principal_cents + next.escrow_cents));
        assert_eq!(balance(&c, &s.escrow), escrow_before + next.escrow_cents);
        assert_eq!(queries::list_splits(&c, &id).unwrap().len(), 3);

        // Undo takes all four rows back, and the balances are RECOMPUTED from
        // what is left rather than adjusted by a remembered delta.
        undo::restore(&c, &step.before, &step.after.accounts).unwrap();
        assert_eq!(balance(&c, &s.mortgage), owed_before, "the loan is owed again");
        assert_eq!(balance(&c, &s.chk), cash_before);
        assert_eq!(balance(&c, &s.escrow), escrow_before);
        assert_eq!(count(&c, &s.chk), rows_before, "no orphan row left in the register");
        let splits: i64 = c
            .query_row("SELECT COUNT(*) FROM splits WHERE transaction_id = ?1", params![id], |r| r.get(0))
            .unwrap();
        assert_eq!(splits, 0, "the three lines went with it");

        // And redo puts the whole payment back.
        undo::restore(&c, &step.after, &step.before.accounts).unwrap();
        assert_eq!(balance(&c, &s.mortgage), owed_before + next.principal_cents);
        assert_eq!(queries::list_splits(&c, &id).unwrap().len(), 3);
    }

    /// §121 — the reason this exists.
    ///
    /// The bank shows ONE debit of $1,800.00. Before extra principal had a
    /// line of its own, recording the $150.00 meant a second Record payment,
    /// and then the checking register held two rows against a statement that
    /// holds one — the register stopped reconciling, which is the one thing it
    /// may never do. One transaction, four lines.
    #[test]
    fn a_payment_paid_ahead_is_still_one_transaction_for_the_whole_amount() {
        let db = TestDb::new("pay-extra");
        let c = db.conn();
        let s = setup(&c);
        let rows_before = count(&c, &s.chk);

        // A payment with extra principal, broken down the way a statement shows it.
        let (interest, principal, escrow, extra) = (75_000, 25_000, 65_000, 15_000);
        let id = record_payment(
            &c,
            &s.mortgage,
            &s.chk,
            "2026-02-01",
            interest,
            principal,
            escrow,
            extra,
            "Mortgage",
            None,
            None,
        )
        .unwrap();

        let amount: i64 = c
            .query_row("SELECT amount_cents FROM transactions WHERE id = ?1", params![id], |r| r.get(0))
            .unwrap();
        assert_eq!(amount, -180_000, "one debit of $1,800.00, exactly what the bank shows");
        assert_eq!(count(&c, &s.chk), rows_before + 1, "ONE row in the register, not two");

        // Four lines, and the two principal lines stay apart on purpose: the
        // point of paying ahead is being able to see which months carried it.
        let splits = queries::list_splits(&c, &id).unwrap();
        assert_eq!(splits.len(), 4);
        assert_eq!(splits[1].description.as_deref(), Some("Principal"));
        assert_eq!(splits[2].description.as_deref(), Some("Extra principal"));
        assert_eq!(splits[2].transfer_account_id.as_deref(), Some(s.mortgage.as_str()));
        assert_eq!(splits[2].category_id, None, "principal is not spending, extra or not");
        assert_eq!(splits[3].description.as_deref(), Some("Escrow"));
        assert_eq!(splits.iter().map(|x| x.amount_cents).sum::<i64>(), -180_000);

        // Both principal lines come off the loan; the escrow line does not.
        assert_eq!(owed(&c, &s.mortgage).unwrap(), 15_000_000 - principal - extra);
        assert_eq!(queries::get_account(&c, &s.escrow).unwrap().balance_cents, 120_000 + escrow);
        assert_eq!(queries::get_account(&c, &s.chk).unwrap().balance_cents, 500_000 - 180_000);
    }

    /// Deleting it takes the extra line with it — the loan cannot be left
    /// paid down by a payment that is no longer there.
    #[test]
    fn deleting_a_payment_paid_ahead_puts_both_principal_lines_back() {
        let db = TestDb::new("pay-extra-del");
        let c = db.conn();
        let s = setup(&c);
        let id = record_payment(&c, &s.mortgage, &s.chk, "2026-02-01", 75_000, 25_000, 65_000, 15_000, "Mortgage", None, None)
            .unwrap();
        assert_eq!(owed(&c, &s.mortgage).unwrap(), 15_000_000 - 25_000 - 15_000);

        queries::delete_transaction(&c, &id).unwrap();

        assert_eq!(owed(&c, &s.mortgage).unwrap(), 15_000_000);
        assert_eq!(queries::get_account(&c, &s.chk).unwrap().balance_cents, 500_000);
        assert_eq!(queries::get_account(&c, &s.escrow).unwrap().balance_cents, 120_000);
    }

    /// §178 — terms with no escrow amount say nothing about where escrow
    /// goes, so an escrow typed into the payment has nowhere to be filed.
    /// Refused, and nothing is written.
    #[test]
    fn escrow_with_nowhere_to_go_is_refused_and_writes_nothing() {
        let db = TestDb::new("escrow-nowhere");
        let c = db.conn();
        let s = setup(&c);
        let mut t = get_terms(&c, &s.mortgage).unwrap().unwrap();
        t.escrow_cents = 0;
        t.escrow_account_id = None;
        t.escrow_category_id = None;
        set_terms(&c, &t).unwrap();
        let rows = count(&c, &s.chk);

        let e = record_payment(&c, &s.mortgage, &s.chk, "2026-02-01", 75_000, 14_933, 45_000, 0, "Mortgage", None, None).unwrap_err();
        assert_eq!(e, "The loan terms don't say where escrow goes — set an escrow account or category in the loan terms first.");
        assert_eq!(count(&c, &s.chk), rows);
        assert_eq!(balance(&c, &s.chk), 500_000);

        // Without escrow the same terms are fine.
        record_payment(&c, &s.mortgage, &s.chk, "2026-02-01", 75_000, 14_933, 0, 0, "Mortgage", None, None).unwrap();
    }

    /// §178 — the row and its lines are one write. Lines refused after the
    /// row was committed (here: paying from the escrow account, so the escrow
    /// line would transfer to its own account) used to leave the whole
    /// payment behind as one unsplit row.
    #[test]
    fn a_payment_whose_lines_are_refused_leaves_no_row() {
        let db = TestDb::new("pay-atomic");
        let c = db.conn();
        let s = setup(&c);
        let rows = count(&c, &s.escrow);
        let e = record_payment(&c, &s.mortgage, &s.escrow, "2026-02-01", 75_000, 14_933, 45_000, 0, "Mortgage", None, None).unwrap_err();
        assert!(e.contains("its own account"), "{e}");
        assert_eq!(count(&c, &s.escrow), rows, "no payment row was left");
        assert_eq!(balance(&c, &s.escrow), 120_000);
        assert_eq!(owed(&c, &s.mortgage).unwrap(), 15_000_000);
        let v = queries::verify_file(&c, false).unwrap();
        assert!(v.drift.is_empty() && v.split_transfers.is_empty(), "{v:?}");
    }

    /// §178 — a day of the month is 1 to 31; a 0 already in a file is read
    /// as no day, so the schedule still moves forward a month at a time.
    #[test]
    fn a_payment_day_outside_the_month_is_refused_and_a_saved_zero_is_ignored() {
        let db = TestDb::new("pay-day");
        let c = db.conn();
        let s = setup(&c);
        let mut t = get_terms(&c, &s.mortgage).unwrap().unwrap();
        for bad in [0, 32, -1] {
            t.payment_day = Some(bad);
            assert!(set_terms(&c, &t).unwrap_err().contains("1 to 31"), "{bad}");
        }
        t.payment_day = Some(31);
        set_terms(&c, &t).unwrap();

        // A 0 written before the check existed.
        c.execute("UPDATE loan_terms SET payment_day = 0 WHERE account_id = ?1", params![s.mortgage]).unwrap();
        let sched = schedule(&c, &s.mortgage, "2026-02-15", 3).unwrap();
        let dates: Vec<&str> = sched.iter().map(|p| p.date.as_str()).collect();
        assert_eq!(dates, vec!["2026-02-15", "2026-03-15", "2026-04-15"]);
    }

    /// §178 — a loan paid past zero owes nothing, and the next payment
    /// proposes no principal. It proposed a negative one: a "payment" that
    /// added the overpayment back onto the debt.
    #[test]
    fn an_overpaid_loan_proposes_no_principal() {
        let terms = LoanTerms {
            account_id: "x".into(),
            apr_micro: 6_000_000,
            payment_cents: 50_000,
            escrow_cents: 0,
            escrow_account_id: None,
            escrow_category_id: None,
            interest_category_id: None,
            from_account_id: None,
            payment_day: Some(1),
            first_payment_date: None,
            term_months: None,
            notes: None,
            extra_principal_cents: 10_000,
        };
        for opening in [0, -2_500] {
            let p = period(&terms, opening, "2026-02-01");
            assert_eq!((p.principal_cents, p.extra_principal_cents, p.interest_cents, p.payment_cents), (0, 0, 0, 0), "{opening}");
            assert_eq!(p.closing_cents, opening);
        }
        assert!(schedule_with(&terms, -2_500, "2026-02-01", 12).unwrap().is_empty());
    }

    /// A standing extra payment is not decoration: it is what the payoff date
    /// actually is. The schedule has to apply it or it describes a loan the user is
    /// not paying.
    #[test]
    fn extra_principal_shortens_the_schedule_and_never_overshoots_zero() {
        let db = TestDb::new("sched-extra");
        let c = db.conn();
        let loan = queries::create_account(&c, "Small loan", "loan", -100_000, Some("2026-01-01")).unwrap().id;
        let mut terms = LoanTerms {
            account_id: loan.clone(),
            apr_micro: 12_000_000, // 1% a month
            payment_cents: 30_000,
            escrow_cents: 0,
            escrow_account_id: None,
            escrow_category_id: None,
            interest_category_id: None,
            from_account_id: None,
            payment_day: Some(1),
            first_payment_date: Some("2026-02-01".into()),
            term_months: Some(4),
            notes: None,
            extra_principal_cents: 0,
        };
        let to_the_schedule = schedule_with(&terms, 100_000, "2026-02-01", 24).unwrap().len();

        terms.extra_principal_cents = 20_000;
        let ahead = schedule_with(&terms, 100_000, "2026-02-01", 24).unwrap();
        assert!(
            ahead.len() < to_the_schedule,
            "$200 a month extra did not shorten a {to_the_schedule}-payment loan"
        );

        // Interest is still charged on the opening balance — paying ahead
        // shrinks NEXT month's interest, not this one's.
        assert_eq!(ahead[0].interest_cents, 1_000);
        assert_eq!(ahead[0].principal_cents, 29_000);
        assert_eq!(ahead[0].extra_principal_cents, 20_000);
        assert_eq!(ahead[0].closing_cents, 100_000 - 49_000);

        // The last one takes what is left and not a cent more.
        let last = ahead.last().unwrap();
        assert_eq!(last.closing_cents, 0);
        assert!(last.principal_cents + last.extra_principal_cents <= last.opening_cents);
        for w in ahead.windows(2) {
            assert_eq!(w[0].closing_cents, w[1].opening_cents);
        }
    }

    /// It is a standing decision, so it lives in the terms and is proposed on
    /// every payment rather than being retyped every month.
    #[test]
    fn extra_principal_is_proposed_on_the_next_payment_and_saved_with_the_terms() {
        let db = TestDb::new("terms-extra");
        let c = db.conn();
        let s = setup(&c);
        let mut t = get_terms(&c, &s.mortgage).unwrap().unwrap();
        assert_eq!(t.extra_principal_cents, 0, "an existing loan is paid to its schedule until it is told otherwise");

        t.extra_principal_cents = 15_000;
        set_terms(&c, &t).unwrap();
        assert_eq!(get_terms(&c, &s.mortgage).unwrap().unwrap().extra_principal_cents, 15_000);

        // Which is what the Record payment dialog fills in.
        let next = next_payment(&c, &s.mortgage, "2026-02-01").unwrap();
        assert_eq!(next.extra_principal_cents, 15_000);
        assert_eq!(next.closing_cents, 15_000_000 - next.principal_cents - 15_000);

        t.extra_principal_cents = -1;
        assert!(set_terms(&c, &t).is_err(), "paying less than the schedule is a short payment, not a negative extra");
    }
}
