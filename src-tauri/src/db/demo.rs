//! Demo data — a realistic file to click around in.
//!
//! # Why this exists, and why it is shaped this way
//!
//! Every screen in this app is hard to judge against an empty database. The
//! register's running balance, payee and amount recall (§23.2), the reconcile
//! flow, budgets, reports — none of them show their real behavior until
//! there are months of transactions behind them.
//!
//! Three rules this module follows:
//!
//! 1. **Never into a real file.** The generator ships in every build,
//!    because `commands::create_sample_file` uses it to make a NEW sample
//!    file (§128). Seeding the file that is already open,
//!    `commands::seed_demo_data`, is behind `#[cfg(debug_assertions)]` and
//!    refuses in a release build. A personal-finance app must never have a
//!    "fill my file with fake transactions" button in the shipped product.
//! 2. **Additive, never destructive.** It creates its own accounts and leaves
//!    everything already in the file alone. There is no wipe. Seeding twice
//!    gives two sets of demo accounts, which is untidy but never lossy — and
//!    "untidy" is a much better failure than "deleted the wrong file".
//! 3. **Deterministic.** No `rand`. The amounts jitter through a small LCG
//!    with a fixed seed, so two runs of the same code produce the same file
//!    and a bug found here can be reproduced.
//!
//! It writes through `queries::*` rather than raw SQL wherever a function
//! exists, so the seeded file is one a real user could have produced — and so
//! a balance bug in a write path shows up here too.

use crate::db::lots;
use crate::db::queries::{self, Conn};
use crate::models::SeedSummary;
use chrono::{Datelike, Duration, NaiveDate, Utc};

/// A deterministic little PRNG. Not for anything that matters — just enough
/// jitter that every grocery run is not the same number. Seeded by a constant
/// so the file is reproducible.
struct Jitter(u64);

impl Jitter {
    fn new() -> Self {
        Jitter(0x5EED_1234_ABCD_0001)
    }
    fn next(&mut self) -> u64 {
        // Numerical Recipes LCG.
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    /// A value in `[lo, hi]`, inclusive.
    fn between(&mut self, lo: i64, hi: i64) -> i64 {
        if hi <= lo {
            return lo;
        }
        lo + (self.next() % ((hi - lo + 1) as u64)) as i64
    }
}

/// A recurring monthly charge — the case payee/amount recall exists for.
struct Recurring {
    payee: &'static str,
    category: &'static str,
    /// Negative for a payment, positive for a deposit.
    cents: i64,
    /// Day of the month it lands on.
    day: u32,
    /// Cents of jitter either side; 0 for a fixed subscription.
    vary: i64,
    /// Seasonal: `Some(peak)` multiplies the amount up to `peak`/100 in
    /// mid-summer and mid-winter (electric, gas), so a year of history has a
    /// shape rather than a flat line.
    seasonal: Option<i64>,
    /// Written as a scheduled-bill RULE as well as history (§32), so the
    /// Bills screen and the forecast have something to project.
    rule: bool,
}

const fn rec(payee: &'static str, category: &'static str, cents: i64, day: u32, vary: i64) -> Recurring {
    Recurring { payee, category, cents, day, vary, seasonal: None, rule: true }
}

const RECURRING: &[Recurring] = &[
    rec("Employer Payroll", "Gross Pay", 312_500, 1, 0),
    rec("Employer Payroll", "Gross Pay", 312_500, 15, 0),
    // The mortgage is TWO things a month: interest (a real expense, tax
    // line and all) here, and principal as a transfer to the loan below.
    rec("Example Bank", "Mortgage Interest", -118_400, 1, 0),
    // §174 — no scheduled rule for these two: the Subscriptions card and
    // the forecast's detector are what find them.
    Recurring { payee: "Netflix", category: "Subscriptions", cents: -1_899, day: 4, vary: 0, seasonal: None, rule: false },
    Recurring { payee: "Spotify", category: "Subscriptions", cents: -1_199, day: 9, vary: 0, seasonal: None, rule: false },
    Recurring { payee: "City Power & Light", category: "Electric", cents: -9_800, day: 12, vary: 1_200, seasonal: Some(165), rule: true },
    Recurring { payee: "City Power & Light", category: "Natural Gas", cents: -4_100, day: 12, vary: 700, seasonal: Some(240), rule: true },
    rec("City Water", "Water & Sewer", -5_200, 12, 900),
    rec("Waste Management", "Trash", -2_850, 12, 0),
    rec("Comcast", "Internet", -7_999, 18, 0),
    rec("Verizon Wireless", "Mobile Phone", -8_500, 20, 600),
    rec("State Farm", "Automobile", -11_200, 22, 0),
    rec("Ally Auto", "Car Payment", -6_100, 8, 0),
    rec("Public Radio", "Cash Contributions", -5_000, 27, 0),
    rec("Costco Wholesale", "Groceries", -21_500, 16, 6_000),
];

/// Everyday spending, sprinkled through each month.
struct Everyday {
    payee: &'static str,
    category: &'static str,
    lo: i64,
    hi: i64,
    /// Roughly how many times a month.
    per_month: u32,
    /// Which register it lands in.
    on: Card,
}

#[derive(Clone, Copy, PartialEq)]
enum Card {
    Checking,
    Visa,
    Mastercard,
    Cash,
}

const fn ev(payee: &'static str, category: &'static str, lo: i64, hi: i64, per_month: u32, on: Card) -> Everyday {
    Everyday { payee, category, lo, hi, per_month, on }
}

const EVERYDAY: &[Everyday] = &[
    ev("Fresh Market", "Groceries", -12_500, -3_200, 5, Card::Visa),
    ev("Shell", "Fuel", -6_800, -3_100, 3, Card::Visa),
    ev("Starbucks", "Dining Out", -1_200, -450, 4, Card::Cash),
    ev("Chipotle", "Dining Out", -2_400, -1_100, 2, Card::Mastercard),
    ev("Olive Garden", "Dining Out", -6_800, -3_900, 1, Card::Mastercard),
    ev("Amazon", "Miscellaneous", -8_900, -1_400, 3, Card::Mastercard),
    ev("Walgreens", "Pharmacy", -4_500, -900, 1, Card::Visa),
    ev("Home Depot", "Home Improvement", -9_800, -1_900, 1, Card::Visa),
    ev("Discount Tire", "Repairs & Maintenance", -14_500, -4_500, 0, Card::Checking),
    ev("Great Clips", "Hair Care", -2_800, -2_200, 1, Card::Cash),
    ev("Chewy", "Pet Food", -6_400, -4_900, 1, Card::Mastercard),
    ev("Target", "Clothing", -9_500, -2_100, 1, Card::Visa),
    ev("AMC Theatres", "Movies & DVDs", -3_200, -1_400, 1, Card::Mastercard),
];

/// Checks, so the Num column and the reconcile "Checks" group have content.
const CHECKS: &[(&str, &str, i64)] = &[
    ("Anytown Lawn Care", "Lawn & Garden", -6_500),
    ("Dr. Reyes DDS", "Dentist", -12_000),
    ("Riverside HOA", "HOA Dues", -22_500),
    ("Parkside Vet", "Veterinary", -18_400),
    ("Dr. Patel", "Doctor", -4_000),
];

/// Once-a-year and once-in-a-while items, keyed by calendar month, so the
/// year has a shape and the tax report has lines on it.
const ANNUAL: &[(u32, u32, &str, &str, i64, Card)] = &[
    // (month, day, payee, category, cents, register)
    (1, 15, "State DMV", "Registration", -38_600, Card::Checking),
    (3, 10, "US Treasury", "Tax Refund", 184_200, Card::Checking),
    (4, 30, "County Treasurer", "Property Tax", -212_500, Card::Checking),
    (6, 5, "United Airlines", "Airfare", -68_400, Card::Mastercard),
    (6, 12, "Marriott", "Lodging", -94_300, Card::Mastercard),
    (6, 12, "Hertz", "Rental Car", -31_200, Card::Mastercard),
    (8, 20, "Allstate", "Home Insurance", -196_000, Card::Checking),
    (10, 31, "County Treasurer", "Property Tax", -212_500, Card::Checking),
    (12, 10, "Employer Payroll", "Bonus", 250_000, Card::Checking),
    (12, 18, "Amazon", "Gifts Given", -42_600, Card::Mastercard),
    (12, 20, "Best Buy", "Gifts Given", -58_900, Card::Visa),
];

/// How many months of history to write. Thirty-seven: three full years plus
/// the current month (§128). It was thirteen, which gave year-over-year
/// exactly one prior year to compare against and left the demo mortgage
/// almost where it started. Three years is what makes the reports worth
/// looking at when somebody is judging the app on a first sitting — a price
/// history with shape in it, a loan that has visibly paid down, and a
/// spending trend that is a trend rather than two points.
///
/// It is also the number to turn down first if seeding ever feels slow: it is
/// linear in this constant and nothing else depends on its value.
///
/// The original note, still true of the shape:
/// a full year plus the
/// current month, so "last 12 months" and year-over-year reports have both
/// ends.
const MONTHS: i64 = 37;

/// Seed a demo file. Additive: nothing already in the database is read,
/// changed or removed.
pub fn seed(conn: &Conn) -> Result<SeedSummary, String> {
    let mut j = Jitter::new();
    let today = Utc::now().date_naive();

    // Money's standard chart is seeded on a new file, but a file whose
    // categories were cleared would otherwise fail every lookup below.
    queries::seed_standard_categories(conn)?;

    // Every demo account opens at zero and gets an explicit "Opening Balance"
    // transaction below, which is what Money does — the money in an account
    // came from somewhere, and the register should say so. It also keeps a
    // property the tests lean on: for these accounts, the rows sum to the
    // balance. (`create_account` writes the same row itself since §38, but
    // dated at `opened_on`; the seeder wants its own date, one day before
    // the history window.)
    let checking = unique_account(conn, "Demo Checking", "checking", 0)?;
    let savings = unique_account(conn, "Demo Savings", "savings", 0)?;
    let visa = unique_account(conn, "Demo Visa", "credit", 0)?;
    let mastercard = unique_account(conn, "Demo Mastercard", "credit", 0)?;
    let cash = unique_account(conn, "Demo Cash", "cash", 0)?;
    let brokerage = unique_account(conn, "Demo Brokerage", "investment", 0)?;
    let retirement = unique_account(conn, "Demo 401(k)", "retirement", 0)?;
    let truck_loan = unique_account(conn, "Demo Truck Loan", "loan", 0)?;
    let home = unique_account(conn, "Demo Home", "home", 0)?;
    let mortgage = unique_account(conn, "Demo Mortgage", "mortgage", 0)?;
    let all_accounts = [
        &checking, &savings, &visa, &mastercard, &cash, &brokerage, &retirement,
        &truck_loan, &home, &mortgage,
    ];
    let mut account_names = Vec::new();
    for a in all_accounts {
        account_names.push(name_of(conn, a)?);
    }
    let card_account = |c: Card| match c {
        Card::Checking => &checking,
        Card::Visa => &visa,
        Card::Mastercard => &mastercard,
        Card::Cash => &cash,
    };

    // Dated one day before the history window, so it sorts first in every
    // register and the running balance starts from it.
    let opened = iso(months_back(today, MONTHS).pred_opt().unwrap_or(today));
    let mut n_txn = 0u32;
    for (account, amount) in [
        (&checking, 412_000i64),
        (&savings, 1_850_000),
        (&cash, 12_000),
        (&brokerage, 240_000),          // the cash sweep; the holdings are lots (§41)
        (&truck_loan, -2_215_000),      // a liability opens negative
        (&home, 46_500_000),
        (&mortgage, -28_740_000),
    ] {
        queries::create_transaction(
            conn, account, &opened, "Opening Balance", None, amount, None, None,
        )?;
        n_txn += 1;
    }

    let mut n_transfer = 0u32;
    let mut n_split = 0u32;
    let mut check_no = 1001i64;

    // ── securities, with a price history, and the lots held at the start ──
    // Prices walk month by month from a starting NAV, so net worth over time
    // moves because the market moved and a sale shows a real gain (§41).
    let mut secs: Vec<DemoSecurity> = Vec::new();
    for (name, symbol, kind, start_micro) in [
        ("Vanguard Total Stock Market", "VTSAX", "mutual_fund", 118_420_000i64),
        ("Vanguard Total Bond Market", "VBTLX", "mutual_fund", 9_710_000),
        ("Apple Inc.", "AAPL", "stock", 189_250_000),
        ("Microsoft Corp.", "MSFT", "stock", 412_800_000),
        ("Schwab US Dividend Equity", "SCHD", "etf", 78_150_000),
    ] {
        let id = match queries::list_securities(conn)?.into_iter().find(|s| s.name == name) {
            Some(s) => s.id,
            None => queries::create_security(conn, name, symbol, kind, None)?.id,
        };
        let mut price = start_micro;
        for back in (0..MONTHS).rev() {
            let d = months_back(today, back).with_day(1).unwrap();
            // Bonds barely move; equities drift up with the odd bad month.
            let (lo, hi) = if kind == "mutual_fund" && symbol == "VBTLX" { (-80, 120) } else { (-450, 700) };
            price += price / 10_000 * j.between(lo, hi);
            queries::set_security_price(conn, &id, &iso(d), price, "manual")?;
        }
        if today.day() != 1 {
            price += price / 10_000 * j.between(-150, 200);
            queries::set_security_price(conn, &id, &iso(today), price, "fetched")?;
        }
        secs.push(DemoSecurity { id, symbol: symbol.to_string() });
    }
    let sec = |symbol: &str| -> String { secs.iter().find(|s| s.symbol == symbol).map(|s| s.id.clone()).unwrap_or_default() };

    // What was already held when the history starts: Add Shares rows with the
    // cost that was paid, dated the day before the window like the opening
    // balances. Everything after this is bought in the register.
    for (account, symbol, shares_micro, cost) in [
        (&brokerage, "AAPL", 25 * lots::MICRO, 472_500i64),
        (&brokerage, "MSFT", 12 * lots::MICRO, 384_000),
        (&brokerage, "SCHD", 180 * lots::MICRO, 1_296_000),
        (&brokerage, "VBTLX", 310_500_000, 336_800),
        (&retirement, "VTSAX", 620_500_000, 6_420_000),
        (&retirement, "VBTLX", 1_850 * lots::MICRO, 1_850_000),
    ] {
        inv(conn, account, &opened, "add_shares", &sec(symbol), shares_micro, cost)?;
        n_txn += 1;
    }

    // ── months of history, oldest first ──────────────────────────────────
    for back in (0..MONTHS).rev() {
        let month_start = months_back(today, back).with_day(1).unwrap();
        let cal_month = month_start.month();

        for r in RECURRING {
            let Some(date) = month_start.with_day(r.day) else { continue };
            if date > today {
                continue;
            }
            let mut amount = if r.vary == 0 {
                r.cents
            } else {
                r.cents + j.between(-r.vary, r.vary)
            };
            if let Some(peak) = r.seasonal {
                amount = amount * seasonal_pct(cal_month, peak) / 100;
            }
            let cat = category_id(conn, r.category)?;
            queries::create_transaction(
                conn, &checking, &iso(date), r.payee, cat.as_deref(), amount, None, None,
            )?;
            n_txn += 1;
        }

        for e in EVERYDAY {
            for k in 0..e.per_month {
                let day = 2 + (k as i64 * 6) + j.between(0, 3);
                let Some(date) = month_start.with_day(day.min(28) as u32) else { continue };
                if date > today {
                    continue;
                }
                let cat = category_id(conn, e.category)?;
                queries::create_transaction(
                    conn,
                    card_account(e.on),
                    &iso(date),
                    e.payee,
                    cat.as_deref(),
                    j.between(e.lo, e.hi),
                    None,
                    None,
                )?;
                n_txn += 1;
            }
        }

        // Tires twice a year, whatever the month.
        if cal_month == 4 || cal_month == 10 {
            if let Some(date) = month_start.with_day(19) {
                if date <= today {
                    let cat = category_id(conn, "Repairs & Maintenance")?;
                    queries::create_transaction(
                        conn, &checking, &iso(date), "Discount Tire", cat.as_deref(),
                        j.between(-14_500, -4_500), None, None,
                    )?;
                    n_txn += 1;
                }
            }
        }

        for (m, d, payee, category, cents, on) in ANNUAL {
            if *m != cal_month {
                continue;
            }
            let Some(date) = month_start.with_day(*d) else { continue };
            if date > today {
                continue;
            }
            let cat = category_id(conn, category)?;
            queries::create_transaction(
                conn, card_account(*on), &iso(date), payee, cat.as_deref(), *cents, None, None,
            )?;
            n_txn += 1;
        }

        // One check a month, so the Num column is populated (§23.1) and its
        // values look like Money's: a running check number, plus the odd
        // marker.
        let check = &CHECKS[(back as usize) % CHECKS.len()];
        if let Some(date) = month_start.with_day(14) {
            if date <= today {
                let cat = category_id(conn, check.1)?;
                // `Some(&check_no.to_string())` would be Option<&String>, and
                // the parameter is Option<&str> — Rust deref-coerces
                // &String -> &str at a plain argument but not through Option
                // (§21.3). Bind it, then borrow as &str.
                let num = check_no.to_string();
                queries::create_transaction(
                    conn,
                    &checking,
                    &iso(date),
                    check.0,
                    cat.as_deref(),
                    check.2,
                    None,
                    Some(num.as_str()),
                )?;
                check_no += 1;
                n_txn += 1;
            }
        }

        // An ATM withdrawal, to show a non-numeric Num — and the cash it
        // became, as a transfer into the wallet.
        if let Some(date) = month_start.with_day(7) {
            if date <= today {
                queries::create_transfer(conn, &checking, &cash, &iso(date), 8_000, Some("ATM"))?;
                n_transfer += 1;
                let cat = category_id(conn, "ATM Fee")?;
                queries::create_transaction(
                    conn, &checking, &iso(date), "ATM Withdrawal", cat.as_deref(), -300, None, Some("ATM"),
                )?;
                n_txn += 1;
            }
        }

        // Interest on savings and dividends in the brokerage: income that is
        // not a paycheck, so the income report has more than one line.
        if let Some(date) = month_start.with_day(28) {
            if date <= today {
                let cat = category_id(conn, "Interest Income")?;
                queries::create_transaction(
                    conn, &savings, &iso(date), "Interest", cat.as_deref(),
                    j.between(5_100, 6_900), None, None,
                )?;
                n_txn += 1;
                if cal_month % 3 == 0 {
                    let cat = category_id(conn, "Dividend Income")?;
                    queries::create_transaction(
                        conn, &brokerage, &iso(date), "Dividend", cat.as_deref(),
                        j.between(18_000, 26_000), None, None,
                    )?;
                    n_txn += 1;
                }
            }
        }

        // The monthly moves: savings, brokerage, 401(k), and the principal on
        // the two loans — real transfers, so both halves and both balances
        // are exercised (§10.2 item 5), and net worth moves for a reason.
        for (day, to, amount) in [
            (2u32, &savings, 40_000i64),
            (2, &brokerage, 25_000),
            (15, &retirement, 62_500),
            (1, &mortgage, 71_600),
            (8, &truck_loan, 39_400),
        ] {
            if let Some(date) = month_start.with_day(day) {
                if date <= today {
                    queries::create_transfer(conn, &checking, to, &iso(date), amount, None)?;
                    n_transfer += 1;
                }
            }
        }

        // The money that moved in goes to work: the brokerage buys SCHD with
        // its $250, the 401(k) buys VTSAX with its $625, each at that month's
        // price — so the lots are real and cost basis is derived, not typed.
        for (day, account, symbol, cents) in [
            (3u32, &brokerage, "SCHD", 25_000i64),
            (16, &retirement, "VTSAX", 62_500),
        ] {
            if let Some(date) = month_start.with_day(day) {
                if date <= today {
                    let price = lots::price_asof(conn, &sec(symbol), &iso(date))?.map(|p| p.0).unwrap_or(lots::MICRO);
                    let shares = lots::mul_div(cents, 10_000_000_000, price);
                    inv(conn, account, &iso(date), "buy", &sec(symbol), shares, cents)?;
                    n_txn += 1;
                }
            }
        }
        // Bond interest every month in the 401(k), reinvested.
        if let Some(date) = month_start.with_day(28) {
            if date <= today {
                let price = lots::price_asof(conn, &sec("VBTLX"), &iso(date))?.map(|p| p.0).unwrap_or(lots::MICRO);
                let gross = j.between(5_200, 5_900);
                inv(conn, &retirement, &iso(date), "reinvest_interest", &sec("VBTLX"), lots::mul_div(gross, 10_000_000_000, price), gross)?;
                n_txn += 1;
            }
        }
        // Quarterly dividends: SCHD and VTSAX reinvest; Apple pays to cash.
        if matches!(cal_month, 3 | 6 | 9 | 12) {
            if let Some(date) = month_start.with_day(24) {
                if date <= today {
                    for (account, symbol, lo, hi) in [
                        (&brokerage, "SCHD", 9_500i64, 14_500i64),
                        (&retirement, "VTSAX", 28_000, 44_000),
                    ] {
                        let price = lots::price_asof(conn, &sec(symbol), &iso(date))?.map(|p| p.0).unwrap_or(lots::MICRO);
                        let gross = j.between(lo, hi);
                        inv(conn, account, &iso(date), "reinvest_dividend", &sec(symbol), lots::mul_div(gross, 10_000_000_000, price), gross)?;
                        n_txn += 1;
                    }
                    inv(conn, &brokerage, &iso(date), "dividend", &sec("AAPL"), 0, 625)?;
                    n_txn += 1;
                }
            }
        }

        // A split: the Walmart trip §10.1 uses as the motivating example.
        if let Some(date) = month_start.with_day(21) {
            if date <= today {
                let total = j.between(-14_500, -7_500);
                let txn = queries::create_transaction(
                    conn, &visa, &iso(date), "Walmart", None, total, None, None,
                )?;
                let groceries = required_category(conn, "Groceries")?;
                let household = required_category(conn, "Miscellaneous")?;
                let pharmacy = required_category(conn, "Pharmacy")?;
                let a = total / 2;
                let b = total / 4;
                // Exact, not rounded: set_splits validates that the lines sum
                // to the parent amount.
                let rest = total - a - b;
                queries::set_splits(
                    conn,
                    &txn.id,
                    &[
                        new_split(&groceries, "Food", a),
                        new_split(&household, "Household", b),
                        new_split(&pharmacy, "Prescription", rest),
                    ],
                )?;
                n_split += 3;
            }
        }

        // Both cards paid in full on the 25th — a transfer of whatever the
        // card owes, so the card registers show a real cycle of charges and
        // payments and the checking register shows where the money went.
        if let Some(date) = month_start.with_day(25) {
            if date <= today {
                for card in [&visa, &mastercard] {
                    let owed = -queries::get_account(conn, card)?.balance_cents;
                    if owed > 0 {
                        queries::create_transfer(conn, &checking, card, &iso(date), owed, None)?;
                        n_transfer += 1;
                    }
                }
            }
        }
    }

    // ── a position opened inside the last year (§128) ────────────────────
    //
    // Every opening lot is dated the day before the window, so at MONTHS = 37
    // a FIFO sale of anything held from the start is long-term BY
    // DEFINITION — and until §128 widened the window, the Apple sale below
    // was the short-term one. A capital-gains report with nothing on the
    // short side of the one-year line demonstrates half of what it is for.
    //
    // So: a security this account did not already hold, bought two hundred
    // days ago, with part of it sold below. FIFO then has only the recent lot
    // to take, and the disposal is short-term whatever the window is.
    let short_buy = today - Duration::days(200);
    if let Some(price) = lots::price_asof(conn, &sec("VTSAX"), &iso(short_buy))?.map(|p| p.0) {
        let cents = 180_000i64;
        inv(conn, &brokerage, &iso(short_buy), "buy", &sec("VTSAX"), lots::mul_div(cents, 10_000_000_000, price), cents)?;
        n_txn += 1;
    }

    // ── three sales, one short-term and two long (§41, §128) ─────────────
    // The VTSAX bought two hundred days ago, sold ten weeks in: short-term.
    // Apple and Microsoft come out of the opening lots and are long-term.
    // All three sweep to checking, so the transfer that Money's "Transfer to"
    // writes is exercised as well.
    for (symbol, shares_micro, when) in [
        ("VTSAX", 3 * lots::MICRO, today - Duration::days(70)),
        ("AAPL", 5 * lots::MICRO, today - Duration::days(70)),
        ("MSFT", 4 * lots::MICRO, today - Duration::days(6)),
    ] {
        let date = iso(when);
        let price = lots::price_asof(conn, &sec(symbol), &date)?.map(|p| p.0).unwrap_or(lots::MICRO);
        let gross = lots::value_cents(shares_micro, price);
        queries::create_investment_transaction(
            conn,
            &crate::models::NewInvestmentTransaction {
                account_id: brokerage.clone(),
                date,
                activity: "sell".to_string(),
                security_id: sec(symbol),
                shares_micro,
                price_micro: Some(price),
                gross_cents: gross,
                commission_cents: 495,
                category_id: None,
                notes: None,
                funding_account_id: Some(checking.clone()),
                lot_allocations: vec![],
            },
        )?;
        n_txn += 1;
        n_transfer += 1;
    }

    // ── a voided transaction, so that path has an example (§6.1h) ────────
    let void_date = iso(today - Duration::days(9));
    let bad = queries::create_transaction(
        conn,
        &checking,
        &void_date,
        "Duplicate Charge",
        None,
        -4_999,
        Some("Charged twice — voided, not deleted, so the row stays visible."),
        None,
    )?;
    queries::set_void(conn, &bad.id, true)?;
    n_txn += 1;

    // ── a statement per month on the bank accounts and cards ─────────────
    // Everything through last month's close is reconciled, month by month,
    // which is what a real file looks like: a statement history to browse,
    // recent rows uncleared, older ones 'R'. Each statement starts where the
    // previous one ended.
    let mut n_statement = 0u32;
    for account in [&checking, &savings, &visa, &mastercard] {
        let mut prev_end = 0i64;
        for back in (1..=MONTHS).rev() {
            let close = month_end(months_back(today, back));
            if close >= today {
                break;
            }
            let cutoff = iso(close);
            let rows = queries::get_register(conn, account)?;
            let mut cleared_total = 0i64;
            let mut cleared_rows = 0u32;
            for r in rows.iter().filter(|r| r.date <= cutoff && !r.is_void && r.cleared_state.is_empty()) {
                queries::set_cleared(conn, &r.id, "C")?;
                cleared_total += r.amount_cents;
                cleared_rows += 1;
            }
            // A card paid to zero nets to nothing for the month, and is still
            // a statement. Only a month with no rows at all is skipped.
            if cleared_rows == 0 {
                continue;
            }
            let ending = prev_end + cleared_total;
            let stmt = queries::start_statement(
                conn, account, &cutoff, prev_end, ending, None, None, None, None,
            )?;
            queries::finish_statement(conn, &stmt.id, None, None)?;
            prev_end = ending;
            n_statement += 1;
        }
    }
    // A couple of recent rows left merely cleared, not reconciled — the
    // everyday Ctrl+M state, and what the next reconcile will pick up.
    for r in queries::get_register(conn, &checking)?
        .iter()
        .rev()
        .filter(|r| !r.is_void && r.cleared_state.is_empty())
        .take(3)
    {
        queries::set_cleared(conn, &r.id, "C")?;
    }

    // ── budgets for the last twelve months and this one ──────────────────
    //
    // Twelve, not `MONTHS`: §128 widened the transaction history to three
    // years, and budgets deliberately did not follow. A budget is a thing you
    // set for the year you are in; three years of them would say that this
    // household has been budgeting since 2023, which is a claim the rest of
    // the file does not support, and budget-vs-actual needs one year to have
    // something to say.
    // Targets sit a little above typical spending, and drift up over the
    // year, so budget-vs-actual has both over and under lines.
    let budgets: &[(&str, i64)] = &[
        ("Groceries", 62_000),
        ("Dining Out", 16_000),
        ("Fuel", 18_000),
        ("Subscriptions", 3_200),
        ("Electric", 11_000),
        ("Natural Gas", 6_500),
        ("Miscellaneous", 24_000),
        ("Clothing", 8_000),
        ("Pet Food", 6_000),
        ("Home Improvement", 7_500),
        ("Cash Contributions", 5_000),
        ("Mobile Phone", 9_000),
    ];
    let mut n_budget = 0u32;
    for back in (0..12).rev() {
        let m = months_back(today, back);
        let month_year = format!("{:04}-{:02}", m.year(), m.month());
        for (name, target) in budgets {
            if let Some(id) = category_id(conn, name)? {
                // ~2% a year, in whole dollars.
                let bump = target * (11 - back) / 600;
                queries::set_budget(conn, &id, (target + bump) / 100 * 100, &month_year)?;
                n_budget += 1;
            }
        }
    }

    // ── scheduled bills and income (§32) — the rules behind the history ───
    // Each starts on its next due date; the matcher then pairs past
    // occurrences in the window with the rows above.
    let mut n_rule = 0u32;
    for r in RECURRING.iter().filter(|r| r.rule) {
        let start = next_month_day(today, r.day);
        let start = if let Some(d) = today.with_day(r.day) { if d > today { d } else { start } } else { start };
        let cat = category_id(conn, r.category)?;
        queries::create_recurrence(
            conn,
            &crate::models::NewRecurrence {
                payee: r.payee.to_string(),
                amount_cents: r.cents,
                account_id: Some(checking.clone()),
                category_id: cat,
                freq: "monthly".to_string(),
                interval_n: 1,
                start_date: iso(start),
                end_date: None,
                second_day: None,
                weekend_rule: "before".to_string(),
                notes: None, transfer_account_id: None, goal_id: None,
            },
        )?;
        n_rule += 1;
    }
    // Twice-yearly and one-off items.
    for (payee, category, cents, start, freq, interval) in [
        ("County Treasurer", "Property Tax", -212_500, next_of(today, 4, 30, 10, 31), "monthly", 6),
        ("Allstate", "Home Insurance", -196_000, next_of(today, 8, 20, 8, 20), "yearly", 1),
        ("State DMV", "Registration", -38_600, next_of(today, 1, 15, 1, 15), "yearly", 1),
        ("Riverside HOA", "HOA Dues", -22_500, next_month_day(today, 14), "monthly", 3),
        ("Dr. Reyes DDS", "Dentist", -12_000, next_month_day(today, 14), "once", 1),
    ] {
        let cat = category_id(conn, category)?;
        queries::create_recurrence(
            conn,
            &crate::models::NewRecurrence {
                payee: payee.to_string(),
                amount_cents: cents,
                account_id: Some(checking.clone()),
                category_id: cat,
                freq: freq.to_string(),
                interval_n: interval,
                start_date: iso(start),
                end_date: None,
                second_day: None,
                weekend_rule: "none".to_string(),
                notes: None, transfer_account_id: None, goal_id: None,
            },
        )?;
        n_rule += 1;
    }
    let _ = n_rule;

    // ── goals, holdings and templates, so those views are not empty ──────
    // Emergency Fund watches savings (§46): it started at $18,500 and every
    // monthly savings transfer is tagged for it, so its progress is derived.
    let emergency = queries::create_goal(
        conn, "Emergency Fund", 3_000_000, 1_850_000, Some("2027-06-30"), None, Some(&savings),
    )?;
    conn.execute(
        "UPDATE transactions SET goal_id = ?1
          WHERE account_id = ?2 AND transfer_id IS NOT NULL AND amount_cents = 40_000",
        rusqlite::params![emergency.id, savings],
    )
    .map_err(|e| e.to_string())?;
    let _ = queries::create_goal(
        conn, "New Roof", 1_800_000, 640_000, Some("2027-03-01"), None, None,
    );
    let _ = queries::create_goal(
        conn, "Alaska cruise", 900_000, 215_000, Some("2027-08-01"), Some("Two cabins, inside passage"), None,
    );
    let _ = queries::create_common_transaction(
        conn,
        &crate::models::NewCommonTransaction {
            name: "Costco run".to_string(),
            payee: "Costco Wholesale".to_string(),
            category_id: category_id(conn, "Groceries")?,
            amount_cents: None,
            check_number: None,
            notes: None,
            splits: vec![],
        },
    );
    let _ = queries::create_common_transaction(
        conn,
        &crate::models::NewCommonTransaction {
            name: "Fill up".to_string(),
            payee: "Shell".to_string(),
            category_id: category_id(conn, "Fuel")?,
            amount_cents: Some(-5_500),
            check_number: None,
            notes: None,
            splits: vec![],
        },
    );


    // ── §174: what the walks of §158–§173 need a demo file to have ────────
    // Somebody judging the app on a first sitting should be able to walk
    // every feature without typing their own life in first: a HELOC paid
    // as one split, a closed account, an employer match arriving as money
    // that never touched a bank, a rebalance inside the plan, rename rules
    // (one with a condition), raw bank-text rows with no category, a
    // stopped subscription, a bill every two months, a doubled day,
    // attachments on a row and on an account, a classification, account
    // details, favorites in an order.

    // (a) A HELOC, paid on the 9th as ONE split from checking: the principal
    //     as a transfer line, the interest as an expense line.
    let heloc = unique_account(conn, "Demo HELOC", "home_equity_line_of_credit", 0)?;
    queries::create_transaction(conn, &heloc, &opened, "Opening Balance", None, -1_200_000, None, None)?;
    n_txn += 1;
    let interest_paid = required_category(conn, "Interest Paid")?;
    let mut heloc_owed = 1_200_000i64;
    for back in (0..MONTHS).rev() {
        let Some(date) = months_back(today, back).with_day(9) else { continue };
        if date > today || heloc_owed <= 0 {
            continue;
        }
        let interest = heloc_owed * 725 / 100_000; // about 8.7% a year
        let principal = 30_000i64.min(heloc_owed);
        queries::create_transaction_with_splits(
            conn,
            &crate::models::NewTransaction {
                account_id: checking.clone(),
                date: iso(date),
                payee: "Example Bank HELOC".to_string(),
                category_id: None,
                amount_cents: -(principal + interest),
                notes: Some("Home equity line — principal and interest".to_string()),
                check_number: None,
                splits: Some(vec![
                    crate::models::NewSplit {
                        classes: Vec::new(),
                        category_id: None,
                        description: Some("Principal".to_string()),
                        amount_cents: -principal,
                        transfer_account_id: Some(heloc.clone()),
                    },
                    new_split(&interest_paid, "Interest", -interest),
                ]),
            },
        )?;
        heloc_owed -= principal;
        n_txn += 1;
    }

    // (b) The account they had before, closed after its money moved over.
    let old = unique_account(conn, "Demo Old Checking", "checking", 0)?;
    queries::create_transaction(conn, &old, &opened, "Opening Balance", None, 96_000, None, None)?;
    n_txn += 1;
    let mut old_left = 96_000i64;
    for (back, payee, cat, cents) in [(MONTHS - 1, "Safeway", "Groceries", -6_240i64), (MONTHS - 2, "Shell", "Fuel", -4_110), (MONTHS - 3, "Safeway", "Groceries", -7_015)] {
        let d = months_back(today, back).with_day(6).unwrap();
        queries::create_transaction(conn, &old, &iso(d), payee, category_id(conn, cat)?.as_deref(), cents, None, None)?;
        old_left += cents;
        n_txn += 1;
    }
    let d = months_back(today, MONTHS - 4).with_day(10).unwrap();
    queries::create_transfer(conn, &old, &checking, &iso(d), old_left, Some("Closing the old account"))?;
    n_transfer += 1;
    let old_acct = queries::get_account(conn, &old)?;
    queries::update_account(conn, &old, &old_acct.name, "checking", true, Some("Example Credit Union"), None, None, None, None, None, None, None, None, Some("Closed after switching to Example Bank"))?;

    // (c) The employer's match: money that never touched a bank, arriving
    //     in the 401(k) as a deposit (Retirement Contributions) and bought
    //     the same day — §172's shape, and a flow the performance card sees.
    let contributions = queries::ensure_category(conn, "Retirement Contributions")?;
    conn.execute("UPDATE categories SET kind = 'income' WHERE id = ?1", rusqlite::params![contributions]).map_err(|e| e.to_string())?;
    for back in (0..MONTHS).rev() {
        let Some(date) = months_back(today, back).with_day(16) else { continue };
        if date > today {
            continue;
        }
        queries::create_transaction(conn, &retirement, &iso(date), "Employer match", Some(&contributions), 25_000, Some("Contribution — employer match"), None)?;
        let price = lots::price_asof(conn, &sec("VTSAX"), &iso(date))?.map(|p| p.0).unwrap_or(lots::MICRO);
        inv(conn, &retirement, &iso(date), "buy", &sec("VTSAX"), lots::mul_div(25_000, 10_000_000_000, price), 25_000)?;
        n_txn += 2;
    }

    // (d) A rebalance inside the plan ten months ago: bonds out, stocks in,
    //     linked as an exchange so the lot engine carries the basis (§167).
    {
        let d = iso(months_back(today, 10).with_day(20).unwrap());
        let bond_price = lots::price_asof(conn, &sec("VBTLX"), &d)?.map(|p| p.0).unwrap_or(lots::MICRO);
        let stock_price = lots::price_asof(conn, &sec("VTSAX"), &d)?.map(|p| p.0).unwrap_or(lots::MICRO);
        let out_shares = 900 * lots::MICRO;
        let value = lots::value_cents(out_shares, bond_price);
        inv_memo(conn, &retirement, &d, "remove_shares", &sec("VBTLX"), out_shares, value, "Rebalance out of bonds")?;
        inv_memo(conn, &retirement, &d, "add_shares", &sec("VTSAX"), lots::mul_div(value, 10_000_000_000, stock_price), value, "Rebalance into stocks")?;
        queries::link_same_day_exchanges(conn, &retirement, "Rebalance out of bonds", "Rebalance into stocks")?;
        n_txn += 2;
    }

    // (e) Rename rules, one of them with a condition (§171).
    let groceries = required_category(conn, "Groceries")?;
    let subscriptions = required_category(conn, "Subscriptions")?;
    let misc = required_category(conn, "Miscellaneous")?;
    let _ = queries::create_payee_rule(conn, "FRESH MARKET", "Fresh Market", Some(&groceries), &Default::default());
    let _ = queries::create_payee_rule(conn, "AMZN", "Amazon", Some(&misc), &Default::default());
    let _ = queries::create_payee_rule(conn, "AMZN", "Amazon Prime", Some(&subscriptions), &crate::models::RuleConditions { memo_contains: Some("prime".to_string()), ..Default::default() });

    // (f) Three rows the way a bank download leaves them — raw text, no
    //     category — so the Remember offer (§171) and the import review
    //     (§159) have something to work on.
    for (days_ago, payee, memo, cents) in [
        (3i64, "SQ *BLUE BOTTLE COFFEE", "SQ *BLUE BOTTLE COFFEE ANYTOWN US", -1_275i64),
        (9, "AMZN Mktp US*1A2B3C", "AMZN Mktp US*1A2B3C Amzn.com/bill WA", -3_418),
        (14, "PAYPAL *STEAMGAMES", "PAYPAL *STEAMGAMES 402-935-7733 CA", -1_999),
    ] {
        let d = today - chrono::Duration::days(days_ago);
        queries::create_transaction(conn, &checking, &iso(d), payee, None, cents, Some(memo), None)?;
        n_txn += 1;
    }

    // (g) For the detector (§60, §173): a subscription that stopped, a water
    //     bill every two months, and one doubled day (a retry).
    for back in (16..MONTHS).rev() {
        let Some(date) = months_back(today, back).with_day(6) else { continue };
        queries::create_transaction(conn, &visa, &iso(date), "Hulu", Some(&subscriptions), -1_799, None, None)?;
        n_txn += 1;
    }
    let water = required_category(conn, "Water & Sewer")?;
    for back in (0..MONTHS).rev().filter(|b| b % 2 == 1) {
        let Some(date) = months_back(today, back).with_day(12) else { continue };
        if date > today {
            continue;
        }
        queries::create_transaction(conn, &checking, &iso(date), "Metro Water", Some(&water), -4_800 + j.between(-1_500, 1_500), None, None)?;
        n_txn += 1;
    }
    if let Some(date) = months_back(today, 5).with_day(4) {
        queries::create_transaction(conn, &checking, &iso(date), "Netflix", Some(&subscriptions), -1_899, Some("retried — the first attempt bounced"), None)?;
        n_txn += 1;
    }

    // (h) Attachments (§170): a statement on the account, a receipt on a row.
    let statement = tiny_pdf(&[
        "Example Bank",
        "Demo Checking — statement",
        "This is a demo attachment. A real one would be the bank's PDF.",
        "It is kept inside the encrypted file and goes with every backup.",
    ]);
    let _ = queries::add_attachment(conn, None, Some(&checking), "statement.pdf", "application/pdf", &statement);
    if let Some(row) = queries::get_register(conn, &visa)?.iter().rev().find(|r| r.payee == "Home Depot") {
        let receipt = format!("HOME DEPOT #0001\n{}\n\nTotal {}\n\nThank you for shopping at The Home Depot.\n", row.date, lots::fmt_cents_public(-row.amount_cents));
        let _ = queries::add_attachment(conn, Some(&row.id), None, "receipt.txt", "text/plain", receipt.as_bytes());
    }

    // (i) A classification: which property a cost belongs to.
    if let Ok(property) = crate::db::classes::create_classification(conn, "Property") {
        let house = crate::db::classes::create_classification_value(conn, &property.id, "Riverside house", None)?;
        let _ = crate::db::classes::create_classification_value(conn, &property.id, "Cabin", None);
        for r in queries::get_register(conn, &checking)?.iter().filter(|r| r.payee == "Riverside HOA" || r.payee == "County Treasurer") {
            let _ = crate::db::classes::set_transaction_classes(conn, &r.id, &[crate::models::ClassPick { classification_id: property.id.clone(), value_id: house.id.clone(), label: String::new() }]);
        }
    }

    // (j) Details on the main account, favorites, and the order of the rail.
    let ck = queries::get_account(conn, &checking)?;
    let _ = queries::update_account(conn, &checking, &ck.name, "checking", false, Some("Example Bank"), Some("000123456789"), Some("123456780"), Some(opened.as_str()), None, Some("800-555-0142"), None, Some("https://www.example-bank.example"), Some("1 Main St, Anytown US 12345"), None);
    for a in [&checking, &visa, &brokerage] {
        let _ = queries::set_favorite(conn, a, true);
    }
    let _ = queries::set_account_order(conn, &[checking.clone(), savings.clone(), visa.clone(), mastercard.clone(), cash.clone(), heloc.clone(), truck_loan.clone(), mortgage.clone(), brokerage.clone(), retirement.clone(), home.clone(), old.clone()]);
    account_names.push(name_of(conn, &heloc)?);
    account_names.push(name_of(conn, &old)?);

    Ok(SeedSummary {
        accounts: account_names.len() as u32,
        transactions: n_txn,
        transfers: n_transfer,
        splits: n_split,
        budgets: n_budget,
        statements: n_statement,
        account_names,
    })
}

// ── helpers ─────────────────────────────────────────────────────────────

struct DemoSecurity {
    id: String,
    symbol: String,
}

/// An investment row with no funding account and the price derived from the
/// total — the plain case.
fn inv(
    conn: &Conn,
    account: &str,
    date: &str,
    activity: &str,
    security_id: &str,
    shares_micro: i64,
    gross_cents: i64,
) -> Result<String, String> {
    queries::create_investment_transaction(
        conn,
        &crate::models::NewInvestmentTransaction {
            account_id: account.to_string(),
            date: date.to_string(),
            activity: activity.to_string(),
            security_id: security_id.to_string(),
            shares_micro,
            price_micro: None,
            gross_cents,
            commission_cents: 0,
            category_id: None,
            notes: None,
            funding_account_id: None,
            lot_allocations: vec![],
        },
    )
}

/// §174 — an investment row with a memo, for the rebalance the lot engine
/// links by memo.
fn inv_memo(
    conn: &Conn,
    account: &str,
    date: &str,
    activity: &str,
    security_id: &str,
    shares_micro: i64,
    gross_cents: i64,
    memo: &str,
) -> Result<String, String> {
    queries::create_investment_transaction(
        conn,
        &crate::models::NewInvestmentTransaction {
            account_id: account.to_string(),
            date: date.to_string(),
            activity: activity.to_string(),
            security_id: security_id.to_string(),
            shares_micro,
            price_micro: None,
            gross_cents,
            commission_cents: 0,
            category_id: None,
            notes: Some(memo.to_string()),
            funding_account_id: None,
            lot_allocations: vec![],
        },
    )
}

/// §174 — a one-page PDF, built by hand: enough for "Open" to hand Windows
/// a real file and for the size column to say something. Text only.
fn tiny_pdf(lines: &[&str]) -> Vec<u8> {
    let mut content = String::from("BT /F1 12 Tf 72 720 Td 16 TL\n");
    for l in lines {
        let esc: String = l.chars().flat_map(|c| match c {
            '(' | ')' | '\\' => vec!['\\', c],
            c if c.is_ascii() => vec![c],
            _ => vec!['?'],
        }).collect();
        content.push_str(&format!("({esc}) Tj T*\n"));
    }
    content.push_str("ET\n");
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>".to_string(),
        format!("<< /Length {} >>\nstream\n{content}endstream", content.len()),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
    ];
    let mut out = String::from("%PDF-1.4\n");
    let mut offsets = Vec::new();
    for (i, o) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.push_str(&format!("{} 0 obj\n{o}\nendobj\n", i + 1));
    }
    let xref = out.len();
    out.push_str(&format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1));
    for off in offsets {
        out.push_str(&format!("{off:010} 00000 n \n"));
    }
    out.push_str(&format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1));
    out.into_bytes()
}

fn new_split(category_id: &str, description: &str, amount_cents: i64) -> crate::models::NewSplit {
    crate::models::NewSplit { classes: Vec::new(),
        category_id: Some(category_id.to_string()),
        description: Some(description.to_string()),
        amount_cents,
        transfer_account_id: None,
    }
}

fn iso(d: NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}

/// A seasonal bill's size in `cal_month` as a percent of its usual amount:
/// `peak` in January and July, 100 in April and October, a straight line
/// between.
///
/// §180: the phase was `(month + 5) % 6 - 3`, which is 0 in April and
/// October — the peaks landed in spring and fall and both comments beside it
/// were wrong about the code. `+ 2` puts 0 at January (3 % 6 − 3) and July
/// (9 % 6 − 3), and ±3 at April (6 % 6 − 3) and October (12 % 6 − 3).
fn seasonal_pct(cal_month: u32, peak: i64) -> i64 {
    let phase = ((cal_month as i64 + 2) % 6 - 3).abs(); // 0 at Jan/Jul, 3 at Apr/Oct
    100 + (peak - 100) * (3 - phase) / 3
}

/// `n` whole months before `from`, clamped to the 1st (callers pick the day).
fn months_back(from: NaiveDate, n: i64) -> NaiveDate {
    let mut y = from.year();
    let mut m = from.month() as i64 - n;
    while m <= 0 {
        m += 12;
        y -= 1;
    }
    NaiveDate::from_ymd_opt(y, m as u32, 1).unwrap_or(from)
}

/// The last day of the month `d` is in.
fn month_end(d: NaiveDate) -> NaiveDate {
    let next = if d.month() == 12 {
        NaiveDate::from_ymd_opt(d.year() + 1, 1, 1)
    } else {
        NaiveDate::from_ymd_opt(d.year(), d.month() + 1, 1)
    };
    next.and_then(|n| n.pred_opt()).unwrap_or(d)
}

/// The next occurrence, strictly after today, of two fixed calendar dates
/// (m1/d1 and m2/d2) — for the twice-a-year items.
fn next_of(today: NaiveDate, m1: u32, d1: u32, m2: u32, d2: u32) -> NaiveDate {
    let mut candidates = Vec::new();
    for y in [today.year(), today.year() + 1] {
        for (m, d) in [(m1, d1), (m2, d2)] {
            if let Some(x) = NaiveDate::from_ymd_opt(y, m, d) {
                if x > today {
                    candidates.push(x);
                }
            }
        }
    }
    candidates.into_iter().min().unwrap_or(today)
}

fn next_month_day(from: NaiveDate, day: u32) -> NaiveDate {
    let (y, m) = if from.month() == 12 {
        (from.year() + 1, 1)
    } else {
        (from.year(), from.month() + 1)
    };
    NaiveDate::from_ymd_opt(y, m, day).unwrap_or(from)
}

/// The id of a category by name, or None if this file does not have it.
/// Seeding must not invent categories outside the standard chart.
fn category_id(conn: &Conn, name: &str) -> Result<Option<String>, String> {
    Ok(queries::list_categories(conn)?
        .into_iter()
        .find(|c| c.name == name)
        .map(|c| c.id))
}

fn required_category(conn: &Conn, name: &str) -> Result<String, String> {
    category_id(conn, name)?.ok_or_else(|| format!("standard category {name:?} is missing"))
}

fn name_of(conn: &Conn, account_id: &str) -> Result<String, String> {
    Ok(queries::get_account(conn, account_id)?.name)
}

/// Create an account under `base`, or `base (2)`, `base (3)`… if that name is
/// taken. Seeding twice must never merge into or disturb the previous run's
/// accounts.
fn unique_account(
    conn: &Conn,
    base: &str,
    kind: &str,
    opening_cents: i64,
) -> Result<String, String> {
    let existing = queries::get_all_accounts(conn)?;
    let taken = |n: &str| existing.iter().any(|a| a.name == n);
    let mut name = base.to_string();
    let mut i = 2;
    while taken(&name) {
        name = format!("{base} ({i})");
        i += 1;
        if i > 50 {
            return Err(format!("too many demo accounts named {base:?}"));
        }
    }
    Ok(queries::create_account(conn, &name, kind, opening_cents, None)?.id)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
//
// The seeder writes through `queries::*`, so these are really an end-to-end
// exercise of the write paths: if a balance rule is wrong, six months of
// transactions will expose it. The assertions that matter are the two
// promises this module makes — **additive** and **internally consistent**.
#[cfg(test)]
mod tests {
    use super::*;

    // §182 — checked whole when the test ends.
    use crate::db::test_db::TestDb;

    /// Every account's stored balance, recomputed from its own transactions.
    ///
    /// This only holds because the seeder opens its accounts at zero and
    /// writes an explicit "Opening Balance" row: `create_account`'s opening
    /// argument sets `balance_cents` directly without a row, so an account
    /// opened that way is legitimately out of step with `SUM(amount_cents)`.
    /// That mismatch is what this assertion caught on its first run.
    /// `accounts.balance_cents` is maintained incrementally by every write
    /// path, so this is the check that matters: after hundreds of writes, does
    /// the running total still agree with the rows?
    fn balances_agree(conn: &Conn) -> Result<(), String> {
        for a in queries::get_all_accounts(conn)? {
            let summed: i64 = conn
                .query_row(
                    "SELECT COALESCE(SUM(amount_cents), 0) FROM transactions
                      WHERE account_id = ?1 AND is_void = 0",
                    rusqlite::params![a.id],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            if summed != a.balance_cents {
                return Err(format!(
                    "{}: stored {} but rows sum to {}",
                    a.name, a.balance_cents, summed
                ));
            }
        }
        Ok(())
    }

    /// §180 — the peak is where the comments say it is.
    #[test]
    fn a_seasonal_bill_peaks_in_january_and_july() {
        assert_eq!(seasonal_pct(1, 165), 165);
        assert_eq!(seasonal_pct(7, 165), 165);
        assert_eq!(seasonal_pct(4, 165), 100);
        assert_eq!(seasonal_pct(10, 165), 100);
        // Symmetric either side of the peak, and never outside [100, peak].
        assert_eq!(seasonal_pct(12, 240), seasonal_pct(2, 240));
        assert_eq!(seasonal_pct(6, 240), seasonal_pct(8, 240));
        for m in 1..=12 {
            let p = seasonal_pct(m, 240);
            assert!((100..=240).contains(&p), "month {m}: {p}");
        }
    }

    #[test]
    fn seeding_produces_a_consistent_file() {
        let db = TestDb::new("consistent");
        let c = db.conn();

        let s = seed(&c).expect("seed");

        assert_eq!(s.accounts, 12);
        assert!(s.transactions > 100, "only {} transactions", s.transactions);
        assert!(s.transfers > 0);
        assert_eq!(s.splits, s.splits / 3 * 3, "splits come in threes");
        assert!(s.budgets > 0);

        // The one that would catch a balance bug in any write path.
        balances_agree(&c).expect("balances");
    }

    #[test]
    fn seeding_is_additive_and_leaves_existing_data_alone() {
        // The promise this module makes. A seeder that quietly renamed or
        // re-filed a real account would be the worst kind of dev convenience.
        let db = TestDb::new("additive");
        let c = db.conn();

        let mine = queries::create_account(&c, "My Real Checking", "checking", 500_000, None)
            .expect("account");
        let txn = queries::create_transaction(
            &c, &mine.id, "2026-08-01", "Kroger", None, -4_250, None, Some("777"),
        )
        .expect("txn");

        seed(&c).expect("seed");

        let after = queries::get_account(&c, &mine.id).expect("account still there");
        assert_eq!(after.name, "My Real Checking");
        assert_eq!(after.balance_cents, 495_750, "the seeder moved my balance");

        let row = queries::get_register(&c, &mine.id)
            .expect("register")
            .into_iter()
            .find(|r| r.id == txn.id)
            .expect("my transaction survived");
        assert_eq!(row.payee, "Kroger");
        assert_eq!(row.check_number.as_deref(), Some("777"));
        assert_eq!(row.cleared_state, "", "the seeder reconciled my transaction");
    }

    #[test]
    fn seeding_twice_does_not_collide_or_merge() {
        // Re-running is untidy but must never be lossy: the second run gets
        // its own accounts rather than pouring more rows into the first set.
        let db = TestDb::new("twice");
        let c = db.conn();

        let first = seed(&c).expect("first");
        let second = seed(&c).expect("second");

        assert!(first.account_names.contains(&"Demo Checking".to_string()));
        assert!(second.account_names.contains(&"Demo Checking (2)".to_string()));
        for n in &first.account_names {
            assert!(!second.account_names.contains(n), "{n} was reused");
        }
        assert_eq!(queries::get_all_accounts(&c).expect("accounts").len(), 24);
        balances_agree(&c).expect("balances");
    }

    #[test]
    fn the_seeded_file_exercises_the_features_it_is_meant_to_demonstrate() {
        // If any of these is empty, a screen the seeder exists to populate is
        // still blank — which is the whole failure mode worth catching.
        let db = TestDb::new("features");
        let c = db.conn();
        seed(&c).expect("seed");

        let checking = queries::get_all_accounts(&c)
            .expect("accounts")
            .into_iter()
            .find(|a| a.name == "Demo Checking")
            .expect("Demo Checking");
        let rows = queries::get_register(&c, &checking.id).expect("register");

        // The money has to come from somewhere, and the register should say
        // so — this is also what makes rows-sum-to-balance true above.
        let opening = rows.iter().find(|r| r.payee == "Opening Balance").expect("no opening row");
        assert_eq!(opening.amount_cents, 412_000);
        assert_eq!(rows[0].payee, "Opening Balance", "the opening row must sort first");

        assert!(rows.iter().any(|r| r.check_number.is_some()), "no Num values");
        assert!(
            rows.iter().any(|r| r.check_number.as_deref() == Some("ATM")),
            "no non-numeric Num"
        );
        assert!(rows.iter().any(|r| r.transfer_account_id.is_some()), "no transfers");
        assert!(rows.iter().any(|r| r.is_void), "no voided row");
        assert!(rows.iter().any(|r| r.cleared_state == "R"), "nothing reconciled");
        assert!(rows.iter().any(|r| r.cleared_state == "C"), "nothing merely cleared");
        assert!(rows.iter().any(|r| r.cleared_state.is_empty()), "everything is marked");

        // A completed statement, so reconcile has history to resume from.
        assert!(
            queries::get_last_statement(&c, &checking.id).expect("stmt").is_some(),
            "no completed statement"
        );
        assert!(
            queries::get_open_statement(&c, &checking.id).expect("stmt").is_none(),
            "left a statement half-open"
        );
    }

    // §174 — the things the walks of §158–§173 needed, all present in one
    // seeding, so a first sitting can try each without typing anything in.
    #[test]
    fn the_seeded_file_has_what_the_later_walks_need() {
        let db = TestDb::new("walks");
        let c = db.conn();
        seed(&c).expect("seed");
        let accounts = queries::get_all_accounts(&c).unwrap();
        let by = |n: &str| accounts.iter().find(|a| a.name == n).unwrap_or_else(|| panic!("no account {n}")).clone();
        let checking = by("Demo Checking");
        let heloc = by("Demo HELOC");
        let old = by("Demo Old Checking");
        let plan = by("Demo 401(k)");
        let visa = by("Demo Visa");
        assert!(old.is_closed, "the old account is closed");
        assert!(heloc.balance_cents < 0 && heloc.balance_cents > -1_200_000, "the HELOC has been paid down: {}", heloc.balance_cents);
        assert!(checking.is_favorite && checking.sort_order == Some(0) && checking.institution.as_deref() == Some("Example Bank"));

        let reg = queries::get_register(&c, &checking.id).unwrap();
        let heloc_row = reg.iter().find(|r| r.payee == "Example Bank HELOC").expect("a HELOC payment");
        let lines = queries::list_splits(&c, &heloc_row.id).unwrap();
        assert_eq!(lines.len(), 2);
        assert!(lines.iter().any(|l| l.transfer_account_id.as_deref() == Some(heloc.id.as_str())), "one line is the transfer to the HELOC");
        assert!(reg.iter().any(|r| r.payee == "SQ *BLUE BOTTLE COFFEE" && r.category_id.is_none()), "a raw, uncategorized row");
        assert!(reg.iter().any(|r| r.payee == "Metro Water"), "the every-two-months bill");
        assert_eq!(reg.iter().filter(|r| r.payee == "Netflix" && r.notes.as_deref().map_or(false, |n| n.contains("retried"))).count(), 1);
        assert!(reg.iter().any(|r| r.attachment_count == 0), "sanity");

        // The plan: matches arrive as a deposit and a buy; the rebalance is an exchange.
        let plan_reg = queries::get_register(&c, &plan.id).unwrap();
        assert!(plan_reg.iter().any(|r| r.payee == "Employer match" && r.category_name.as_deref() == Some("Retirement Contributions")));
        assert_eq!(plan_reg.iter().filter(|r| r.is_exchange).count(), 2, "the rebalance's two halves are an exchange");
        let f = crate::db::lots::performance(&c, Some(&plan.id), None, &plan_reg.last().unwrap().date).unwrap();
        assert!(f.iter().any(|p| p.flows_in_cents > 0), "the matches are flows the performance card sees");

        // Rules, one with a condition; attachments on the account and a row.
        let rules = queries::list_payee_rules(&c).unwrap();
        assert!(rules.iter().any(|r| r.match_text == "AMZN" && r.memo_contains.as_deref() == Some("prime")));
        assert!(rules.iter().any(|r| r.match_text == "FRESH MARKET"));
        assert_eq!(queries::list_attachments(&c, None, Some(&checking.id)).unwrap().len(), 1);
        let receipt = queries::get_register(&c, &visa.id).unwrap().into_iter().find(|r| r.attachment_count > 0).expect("a row with a receipt");
        assert_eq!(receipt.payee, "Home Depot");
        let (a, bytes) = queries::attachment_bytes(&c, &queries::list_attachments(&c, None, Some(&checking.id)).unwrap()[0].id).unwrap();
        assert!(a.name == "statement.pdf" && bytes.starts_with(b"%PDF-1.4") && bytes.ends_with(b"%%EOF\n"));

        // The detector finds the two subscriptions with no rule, and the forecast projects them.
        let today = chrono::Utc::now().date_naive();
        let fc = queries::cash_forecast_with(&c, &checking.id, today, 90, true).unwrap();
        let names: Vec<&str> = fc.detected.iter().map(|d| d.payee.as_str()).collect();
        assert!(names.contains(&"Netflix") && names.contains(&"Spotify") && names.contains(&"Metro Water"), "{names:?}");
        assert!(fc.covered_by_bills.iter().any(|p| p == "Comcast"), "Comcast has a rule: {:?}", fc.covered_by_bills);
        let hulu: Vec<(chrono::NaiveDate, i64)> = queries::get_register(&c, &visa.id).unwrap().iter().filter(|r| r.payee == "Hulu").map(|r| (chrono::NaiveDate::parse_from_str(&r.date, "%Y-%m-%d").unwrap(), -r.amount_cents)).collect();
        let h = crate::db::reports::detect_subscription(&hulu, today).expect("Hulu was a subscription");
        assert!(!h.active, "…that stopped");
    }

    #[test]
    fn three_years_of_history_reaches_every_report() {
        // What the seeder is FOR now (§39, widened in §128): three years and
        // the current month, every account type, income that is not a
        // paycheck, transfers between assets and liabilities, statements
        // month by month, a year of budgets, rules behind the bills. If any
        // of these is thin, a report is blank — and a blank report is what a
        // reviewer seeing this app for the first time would judge it on.
        let db = TestDb::new("year");
        let c = db.conn();
        let s = seed(&c).expect("seed");
        assert_eq!(s.accounts, 12);
        assert!(s.transactions > 500, "only {} transactions", s.transactions);
        assert!(s.statements >= 12 * 3, "only {} statements", s.statements);
        assert_eq!(s.budgets, 12 * 12);

        let months: i64 = c
            .query_row("SELECT count(DISTINCT substr(date, 1, 7)) FROM transactions", [], |r| r.get(0))
            .expect("months");
        assert!(months >= MONTHS, "only {months} distinct months, wanted {MONTHS}");
        assert!(MONTHS >= 37, "§128: three years and the current month");

        // Year-over-year needs more than one prior year to compare against,
        // which is the whole reason this went from 13 to 37.
        let years: i64 = c
            .query_row("SELECT count(DISTINCT substr(date, 1, 4)) FROM transactions", [], |r| r.get(0))
            .expect("years");
        assert!(years >= 4, "only {years} calendar years touched");

        // The demo mortgage has to have visibly paid down, or the loan
        // screens demonstrate nothing.
        let mortgage_rows: i64 = c
            .query_row(
                "SELECT count(*) FROM transactions t JOIN accounts a ON a.id = t.account_id
                  WHERE a.type = 'mortgage'",
                [],
                |r| r.get(0),
            )
            .expect("mortgage rows");
        assert!(mortgage_rows >= 36, "only {mortgage_rows} rows against the mortgage");

        let kinds: Vec<String> = {
            let mut st = c.prepare("SELECT DISTINCT type FROM accounts ORDER BY type").unwrap();
            st.query_map([], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
        };
        for k in ["checking", "savings", "credit", "cash", "investment", "retirement", "loan", "home", "mortgage"] {
            assert!(kinds.iter().any(|x| x == k), "no {k} account");
        }
        let rules: i64 = c.query_row("SELECT count(*) FROM recurrences", [], |r| r.get(0)).unwrap();
        assert!(rules >= 15, "only {rules} rules");
        let securities: i64 = c.query_row("SELECT count(*) FROM securities", [], |r| r.get(0)).unwrap();
        assert_eq!(securities, 5);
        // The lots are real: every position is priced, a sale realized a
        // gain on both sides of the one-year line, and nothing was oversold.
        let today = iso(chrono::Local::now().date_naive());
        let p = lots::portfolio(&c, None, &today).unwrap();
        assert!(p.problems.is_empty(), "{:?}", p.problems);
        assert!(p.positions.len() >= 5, "{} positions", p.positions.len());
        assert!(p.positions.iter().all(|x| x.price_micro.is_some()));
        assert!(p.total_value_cents > p.total_cost_cents, "the market should have gone up in the demo");
        let realized = lots::realized(&c, None, "0000-01-01", &today).unwrap();
        assert!(realized.iter().any(|d| d.long_term) && realized.iter().any(|d| !d.long_term), "{realized:?}");
        // Income lines beyond wages, so an income report has shape.
        let income_cats: i64 = c
            .query_row(
                "SELECT count(DISTINCT t.category_id) FROM transactions t
                   JOIN categories c ON c.id = t.category_id
                  WHERE c.kind = 'income' AND t.transfer_id IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(income_cats >= 5, "only {income_cats} income categories used");
        // Net worth is the sum of everything, liabilities negative.
        let net: i64 = c.query_row("SELECT SUM(balance_cents) FROM accounts", [], |r| r.get(0)).unwrap();
        assert!(net > 0);
        let liabilities: i64 = c
            .query_row("SELECT count(*) FROM accounts WHERE balance_cents < 0", [], |r| r.get(0))
            .unwrap();
        assert!(liabilities >= 2, "loans should carry negative balances");
        balances_agree(&c).expect("balances");
    }

    #[test]
    fn recurring_payees_give_amount_recall_something_to_offer() {
        // §23.2 exists to be seen. Netflix at a fixed 18.99 every month is the
        // case that demonstrates it.
        let db = TestDb::new("recall");
        let c = db.conn();
        seed(&c).expect("seed");

        let netflix = queries::list_payees(&c)
            .expect("payees")
            .into_iter()
            .find(|p| p.name == "Netflix")
            .expect("Netflix");
        assert!(netflix.usage_count > 1, "Netflix should recur");
        assert_eq!(netflix.last_amount_cents, Some(-1_899));
        assert!(netflix.last_category_id.is_some(), "no category to recall");
    }

    #[test]
    fn the_generator_is_deterministic() {
        // Fixed-seed jitter, so a bug found in a seeded file can be reproduced.
        let a = TestDb::new("det-a");
        let b = TestDb::new("det-b");
        let (ca, cb) = (a.conn(), b.conn());
        let sa = seed(&ca).expect("a");
        let sb = seed(&cb).expect("b");
        assert_eq!(sa.transactions, sb.transactions);

        let sum = |c: &Conn| -> i64 {
            c.query_row(
                "SELECT COALESCE(SUM(amount_cents), 0) FROM transactions",
                [],
                |r| r.get(0),
            )
            .expect("sum")
        };
        assert_eq!(sum(&ca), sum(&cb), "two runs produced different amounts");
    }
}
