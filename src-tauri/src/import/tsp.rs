//! §103 — the TSP importer, brought in from the script.
//!
//! A command-line script did this first and did it correctly; everything
//! below is a port of its rules.
//! What changes here is not the arithmetic — it is who supplies the one thing
//! the CSV cannot know.
//!
//! ## What the file is
//!
//! Nine columns: VALUATION DATE, POSTING DATE, ACTIVITY TYPE, PLAN, ACCOUNT,
//! FUND, AMOUNT, FUND NAV/PRICE, FUND UNITS.
//!
//! `ACCOUNT` is **not** an account. It is the money SOURCE — Traditional,
//! Match, Auto 1% - 3 Years, Roth, Roth Agency — and every transaction is
//! split across the sources it touched. One reallocation on one day is five
//! rows. Collapsing the sources (same date + activity + fund + NAV) turns a
//! thousand rows into a few hundred real transactions, and makes an
//! intra-plan Roth conversion vanish, which is right: nothing moved, it was
//! reclassified.
//!
//! ## What is missing from it, and how it comes back
//!
//! The export starts partway through the account's life, so the position held
//! before the first row is absent. It is not estimated. Every unit change in
//! the file is known and the ending position is known, so the opening
//! position is arithmetic: whatever the file's own changes would drive
//! negative must have been there beforehand.
//!
//! ## What the CSV cannot know: tax
//!
//! The plan says what it SOLD. It does not say what reached the bank. A
//! $1,000 distribution with tax withheld is $1,000 out of the funds and less
//! than that into checking, and importing the gross as a transfer puts money
//! in checking that never arrived, which is the mistake this guards against.
//!
//! In the script that difference lived in a hand-edited `PAYMENTS` table. Here
//! it is `PaymentSplit`, supplied per payment by the user through the import
//! dialog, and `plan()` hands the UI the list of payments to be asked about.
//! Same arithmetic, same refusals — the numbers just come from someone who
//! can see their bank register instead of from a table in a source file.
//!
//! **A payment with no split keeps the old behavior** — the whole gross goes
//! to the bank on the plan's own date — and `Payment::needs_split` says so, so
//! the dialog can insist rather than let it through silently.
//!
//! ## Money
//!
//! `Decimal` here is for reading the plan's own file, which states units to
//! six places and NAVs to four. Everything that reaches the ledger goes
//! through the QIF this builds and is parsed to `i64` cents by the importer,
//! as everywhere else. No `f64` at any point.

use crate::import::csv::parse_records;
use chrono::NaiveDate;
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::str::FromStr;

/// Activity types that are a payroll or agency contribution: a Buy, with the
/// deposit that funds it written by §90's dialog.
///
/// The memo wording is load-bearing. `plan::guess` reads it to propose a
/// treatment, so a contribution's memo must contain "contribution" or
/// "payroll" and a reallocation's must not.
fn contribution_memo(activity: &str) -> Option<&'static str> {
    match activity {
        "Traditional" => Some("TSP Traditional payroll deferral"),
        "Match" => Some("TSP Agency Match employer contribution"),
        "Auto 1% - 3 Years" => Some("TSP Agency Automatic 1% employer contribution"),
        _ => None,
    }
}

/// Money leaving the plan. Deliberately needle-free: `plan::guess` turns a
/// SELL whose memo says "withdraw", "distribution" or "loan" into its
/// Withdrawal treatment, which writes a cash row of its own — and the cash is
/// already written, once per day, by the transfer below. Trip that guess and
/// the money leaves the plan twice.
fn cash_out_memo(activity: &str) -> Option<&'static str> {
    match activity {
        "Withdrawals" => Some("TSP shares sold for a payment to the bank"),
        "New Loans" => Some("TSP shares sold for a plan borrowing"),
        _ => None,
    }
}

/// Money arriving from pay, never touching a bank account. Same shape as a
/// contribution: a Buy, with the dialog writing the deposit that funds it.
///
/// Loan repayments come out of an agency paycheck, so there is no bank row
/// to transfer from — treating these as a transfer in from checking would
/// put money that never existed into the register.
const PAYROLL_MEMO: &str = "TSP loan repayment withheld from payroll";

fn payroll_in_memo(activity: &str) -> Option<&'static str> {
    // The TSP's own export labels a payroll loan repayment
    // "C-Pyrl Ln Rpmt Loan<N>-<servicer>"; any loan number and any servicer
    // is the same thing.
    if activity == "Loan Repayments" || activity.starts_with("C-Pyrl Ln Rpmt") {
        Some(PAYROLL_MEMO)
    } else {
        None
    }
}

/// §172 — what this importer's own contribution memos mean, handed to the
/// QIF path as §90 memo rules so every contribution Buy is written WITH its
/// cash side. The memos are this file's constants, so the rules cannot
/// drift from the rows they describe.
pub fn contribution_rules() -> Vec<crate::import::plan::MemoRule> {
    ["Traditional", "Match", "Auto 1% - 3 Years"]
        .iter()
        .filter_map(|a| contribution_memo(a))
        .chain(std::iter::once(PAYROLL_MEMO))
        .map(|memo| crate::import::plan::MemoRule {
            memo: memo.to_string(),
            activity: "buy".to_string(),
            treatment: crate::import::plan::Treatment::Contribution,
            category: None,
        })
        .collect()
}

/// §167 — a reallocation's two memos are load-bearing twice over: `plan::guess`
/// must not read them as a withdrawal, and the importer links the day's rows
/// to each other BY them once written (`queries::link_same_day_exchanges`),
/// which is what makes the lot engine carry basis across the funds.
pub const REALLOC_IN: &str = "TSP reallocation into fund";
pub const REALLOC_OUT: &str = "TSP reallocation out of fund";
const MOVE_OUT: &str = "TSP money out to the bank";
const OPENING_MEMO: &str = "Opening position (held before this export begins)";

/// A conversion between money sources. With the sources collapsed nothing
/// moved, so both halves are dropped rather than written as a same-day
/// sell-and-buy of the same units at the same price.
fn is_dropped(activity: &str) -> bool {
    activity == "Roth Conversion Out" || activity == "Roth Conversion In"
}

/// One line of the file, before the money sources are collapsed.
#[derive(Debug, Clone)]
pub struct Row {
    pub date: NaiveDate,
    pub activity: String,
    pub fund: String,
    pub amount: Decimal,
    pub nav: Decimal,
    pub units: Decimal,
}

/// One real transaction: a day, an activity and a fund, with every money
/// source folded together.
#[derive(Debug, Clone)]
pub struct Txn {
    pub date: NaiveDate,
    pub activity: String,
    pub fund: String,
    pub nav: Decimal,
    pub amount: Decimal,
    pub units: Decimal,
}

/// A day on which money left the plan — the thing the CSV cannot finish
/// describing on its own.
#[derive(Debug, Clone, Serialize)]
pub struct Payment {
    /// The plan's own date, `YYYY-MM-DD`. The key a split is given under.
    pub date: String,
    /// What the plan sold, gross, in cents.
    pub gross_cents: i64,
    /// A borrowing rather than a distribution — different tax treatment, and
    /// worth saying on screen so the fee is not mistaken for withholding.
    pub is_loan: bool,
    /// Always true today; here so the dialog can say WHY it is asking rather
    /// than presenting an unexplained form.
    pub needs_split: bool,
}

/// Where one payment actually went. Supplied per payment by the user.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct PaymentSplit {
    /// The plan's payment date, `YYYY-MM-DD` — matches `Payment::date`.
    pub date: String,
    /// What the bank actually received, and when. A list because one payment
    /// can arrive as more than one deposit: a $460.00 payment can land as
    /// $400.00 and $60.00, and the importer matches a deposit by its exact
    /// amount, so one combined row would match neither.
    pub deposits: Vec<Deposit>,
    /// What was kept back, one line per reason.
    pub lines: Vec<KeptLine>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Deposit {
    /// The date the bank posted it, `YYYY-MM-DD`.
    pub on: String,
    pub amount_cents: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct KeptLine {
    /// A category name as the register spells it, e.g.
    /// `Taxes:TSP Federal Withholding`.
    ///
    /// NOT `Taxes:Federal Income Tax` — that is the standard category and it
    /// carries the W-2 tax line. This withholding comes on a 1099-R, a
    /// different line on the return, so it wants its own category.
    pub category: String,
    /// `None` on exactly one line means "whatever is left", so the arithmetic
    /// can never be off by a cent.
    pub amount_cents: Option<i64>,
    pub memo: String,
}

/// Everything the CSV alone can determine.
#[derive(Debug, Clone, Serialize)]
pub struct Plan {
    /// Rows in, transactions out — the collapse is worth showing, because a
    /// user who sees "1,000 → 500" understands what happened to their file.
    pub rows: usize,
    pub transactions: usize,
    /// The position held the day before the export begins, per fund.
    pub opening: Vec<OpeningPosition>,
    /// `YYYY-MM-DD`, the day before the first row.
    pub open_date: String,
    /// Days money left the plan, each needing a split.
    pub payments: Vec<Payment>,
    /// Anything impossible found by walking the file day by day. Never
    /// swallowed: a plan that cannot be described is not imported.
    pub problems: Vec<String>,
    /// The funds the file touches, for the summary.
    pub funds: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OpeningPosition {
    pub fund: String,
    /// Units, as text at six places — the precision the plan states.
    pub units: String,
    pub nav: String,
    pub value_cents: i64,
    /// Millionths added to cover the plan's own per-source rounding. Shown
    /// rather than hidden: it is a real, if tiny, invention.
    pub rounding_sliver: Option<String>,
    /// §155 — of `units`, what the chosen account ALREADY holds on the open
    /// date, and what will actually be written. Both "0.000000" until an
    /// account is chosen, because the register cannot be asked before then.
    pub already_held: String,
    pub to_add: String,
}

// ---------------------------------------------------------------------------
// Reading

fn dec(s: &str) -> Result<Decimal, String> {
    let cleaned: String = s.trim().replace(['$', ',', '"'], "");
    if cleaned.is_empty() {
        return Ok(Decimal::ZERO);
    }
    Decimal::from_str(&cleaned).map_err(|_| format!("{s:?} is not a number"))
}

/// `MM-DD-YYYY`, as the TSP writes it. Slashes accepted because a spreadsheet
/// round-trip turns one into the other and the file is otherwise identical.
fn tsp_date(s: &str) -> Result<NaiveDate, String> {
    let t = s.trim();
    for fmt in ["%m-%d-%Y", "%m/%d/%Y", "%Y-%m-%d"] {
        if let Ok(d) = NaiveDate::parse_from_str(t, fmt) {
            return Ok(d);
        }
    }
    Err(format!("{t:?} is not a date this file should contain"))
}

/// Header name to column index, case- and space-insensitive.
/// §132 — is this a tsp.gov Investment Activity Detail?
///
/// Asked by the GENERIC csv importer, which is the door a `.csv` sends you to
/// and which knows nothing about funds, units or prices. A TSP export read
/// there brings the amounts in and the balance out right, but every row is a
/// bare "Thrift Savings Plan" with no quantity and no price — because that is
/// faithfully what a flat CSV import does. The file is fine; the wrong reader
/// read it.
///
/// Two of the nine headers are enough: no ordinary bank export has a column
/// called FUND UNITS.
pub fn looks_like_tsp(headers: &[String]) -> bool {
    let has = |want: &str| header_index(headers, want).is_some();
    has("FUND UNITS") && has("FUND NAV/PRICE") && has("ACTIVITY TYPE")
}

fn header_index(header: &[String], want: &str) -> Option<usize> {
    let norm = |s: &str| s.trim().trim_start_matches('\u{feff}').to_lowercase().replace(' ', "");
    let w = norm(want);
    header.iter().position(|h| norm(h) == w)
}

/// Parse the export. Rejects a file that is not one, by name — a user who
/// picked the wrong CSV should be told which column is missing, not handed a
/// zero-row import that looks like it worked.
pub fn read(text: &str) -> Result<Vec<Row>, String> {
    let records = parse_records(text, ',');
    let header = records
        .iter()
        .find(|r| r.iter().any(|c| !c.trim().is_empty()))
        .ok_or_else(|| "that file is empty".to_string())?
        .clone();

    let want = |name: &str| {
        header_index(&header, name).ok_or_else(|| {
            format!(
                "this does not look like a TSP activity export — it has no {name} column. \
                 Download \"Investment Activity Detail\" from tsp.gov as a CSV."
            )
        })
    };
    let (i_date, i_act, i_fund, i_amt, i_nav, i_units) = (
        want("VALUATION DATE")?,
        want("ACTIVITY TYPE")?,
        want("FUND")?,
        want("AMOUNT")?,
        want("FUND NAV/PRICE")?,
        want("FUND UNITS")?,
    );

    let mut out = Vec::new();
    for (n, r) in records.iter().enumerate() {
        if n == 0 || r.len() <= i_units {
            continue;
        }
        if r[i_date].trim().is_empty() {
            continue;
        }
        let where_ = |e: String| format!("line {}: {e}", n + 1);
        out.push(Row {
            date: tsp_date(&r[i_date]).map_err(where_)?,
            activity: r[i_act].trim().to_string(),
            fund: r[i_fund].trim().to_string(),
            amount: dec(&r[i_amt]).map_err(|e| format!("line {}: amount {e}", n + 1))?,
            nav: dec(&r[i_nav]).map_err(|e| format!("line {}: NAV {e}", n + 1))?,
            units: dec(&r[i_units]).map_err(|e| format!("line {}: units {e}", n + 1))?,
        });
    }
    if out.is_empty() {
        return Err("that file has the right columns but no activity rows in it".to_string());
    }
    Ok(out)
}

/// The five money sources into one transaction each.
pub fn collapse(rows: &[Row]) -> Vec<Txn> {
    let mut groups: BTreeMap<(NaiveDate, String, String, String), Txn> = BTreeMap::new();
    for r in rows {
        if is_dropped(&r.activity) {
            continue;
        }
        let key = (r.date, r.activity.clone(), r.fund.clone(), r.nav.to_string());
        let e = groups.entry(key).or_insert_with(|| Txn {
            date: r.date,
            activity: r.activity.clone(),
            fund: r.fund.clone(),
            nav: r.nav,
            amount: Decimal::ZERO,
            units: Decimal::ZERO,
        });
        e.amount += r.amount;
        e.units += r.units;
    }
    let mut out: Vec<Txn> = groups
        .into_values()
        .filter(|t| t.amount != Decimal::ZERO || t.units != Decimal::ZERO)
        .collect();
    // Within a day, everything that ADDS shares goes before everything that
    // removes them. On the day a fund is emptied, that day's payroll
    // contribution into it lands too, and the TSP lists it after the sale;
    // in that order the sale is short by exactly the contribution, the lot
    // engine clamps it, and the residue cascades. Adding first can never
    // create a shortfall, and the day-end balance is the same either way.
    out.sort_by(|a, b| {
        a.date
            .cmp(&b.date)
            .then((a.units <= Decimal::ZERO).cmp(&(b.units <= Decimal::ZERO)))
            .then(a.fund.cmp(&b.fund))
    });
    out
}

/// What must have been held before the file starts, and the slivers added to
/// cover the plan's own rounding.
///
/// Every unit change is known and the ending position is known, so anything
/// the file's own changes leave negative was there beforehand. Then a second
/// pass, because the TSP's arithmetic is not quite closed: each row's units
/// are rounded to six places PER MONEY SOURCE, so five rounded numbers summed
/// can exceed the true total by a few millionths and a sale can ask for a
/// sliver more than every prior row put in. Where that happens the opening is
/// raised to cover it — the net says "exactly this much was held", the
/// running balance says "at least this much", and when they disagree by
/// millionths, rounding is the reason.
pub fn opening_positions(txns: &[Txn]) -> (BTreeMap<String, Decimal>, BTreeMap<String, Decimal>) {
    let mut net: BTreeMap<String, Decimal> = BTreeMap::new();
    for t in txns {
        *net.entry(t.fund.clone()).or_default() += t.units;
    }
    let mut opening: BTreeMap<String, Decimal> = net
        .iter()
        .filter(|(_, u)| **u < Decimal::ZERO)
        .map(|(f, u)| (f.clone(), -*u))
        .collect();

    let mut run = opening.clone();
    let mut low: BTreeMap<String, Decimal> = BTreeMap::new();
    for t in txns {
        let r = run.entry(t.fund.clone()).or_default();
        *r += t.units;
        let l = low.entry(t.fund.clone()).or_default();
        if *r < *l {
            *l = *r;
        }
    }
    let slivers: BTreeMap<String, Decimal> = low
        .into_iter()
        .filter(|(_, v)| *v < Decimal::ZERO)
        .map(|(f, v)| (f, -v))
        .collect();
    for (f, v) in &slivers {
        *opening.entry(f.clone()).or_default() += *v;
    }
    (opening, slivers)
}

/// Walk the file day by day and complain about anything impossible.
pub fn check(txns: &[Txn], opening: &BTreeMap<String, Decimal>) -> Vec<String> {
    let mut problems = Vec::new();
    let mut run = opening.clone();
    // A hair under a millionth: the plan rounds per source, so an exact zero
    // is not always reachable and a complaint about 0.0000001 units is noise.
    let floor = Decimal::from_str("-0.0000005").unwrap();
    let mut by_date: BTreeMap<NaiveDate, Vec<&Txn>> = BTreeMap::new();
    for t in txns {
        by_date.entry(t.date).or_default().push(t);
    }
    for (d, day) in &by_date {
        for t in day {
            *run.entry(t.fund.clone()).or_default() += t.units;
        }
        for (f, u) in &run {
            if *u < floor {
                problems.push(format!("{d}: {f} would hold {u} units"));
            }
        }
    }
    // Every fund-move day must cost nothing.
    let mut day_total: BTreeMap<NaiveDate, Decimal> = BTreeMap::new();
    for t in txns {
        let moves_cash = contribution_memo(&t.activity).is_some()
            || cash_out_memo(&t.activity).is_some()
            || payroll_in_memo(&t.activity).is_some();
        if !moves_cash {
            *day_total.entry(t.date).or_default() += t.amount;
        }
    }
    for (d, v) in day_total {
        if v != Decimal::ZERO {
            problems.push(format!("{d}: fund moves net {v}, not zero"));
        }
    }
    problems
}

fn cents(d: Decimal) -> i64 {
    // Two places, half-up, then to an integer. The plan states amounts to the
    // cent already; this is a conversion, not a rounding decision.
    d.round_dp(2)
        .checked_mul(Decimal::from(100))
        .and_then(|v| v.round().to_i64())
        .unwrap_or(0)
}

/// The days money left the plan, with what the plan sold on each.
pub fn payments(txns: &[Txn]) -> Vec<Payment> {
    let mut by_day: BTreeMap<NaiveDate, (Decimal, bool)> = BTreeMap::new();
    for t in txns {
        if cash_out_memo(&t.activity).is_some() {
            let e = by_day.entry(t.date).or_insert((Decimal::ZERO, false));
            e.0 += t.amount.abs();
            if t.activity == "New Loans" {
                e.1 = true;
            }
        }
    }
    by_day
        .into_iter()
        .map(|(d, (gross, is_loan))| Payment {
            date: d.to_string(),
            gross_cents: cents(gross),
            is_loan,
            needs_split: true,
        })
        .collect()
}

/// Everything the CSV alone can determine, for the dialog to show and ask about.
/// `held` — §155 — is what the chosen account already holds of each fund on
/// the open date (empty until an account is chosen). The opening the FILE
/// implies is still shown in full; what is WRITTEN is the shortfall.
pub fn plan(text: &str, held: &BTreeMap<String, Decimal>) -> Result<Plan, String> {
    let rows = read(text)?;
    let txns = collapse(&rows);
    let (opening, slivers) = opening_positions(&txns);
    let problems = check(&txns, &opening);
    let first = txns.iter().map(|t| t.date).min().ok_or("no transactions")?;
    let open_date = first.pred_opt().unwrap_or(first);
    let open_nav = opening_navs(&txns, &opening);
    let to_write = net_of_held(&opening, held);

    let funds: BTreeSet<String> = txns.iter().map(|t| t.fund.clone()).collect();
    Ok(Plan {
        rows: rows.len(),
        transactions: txns.len(),
        opening: opening
            .iter()
            .map(|(f, u)| {
                let nav = open_nav.get(f).copied().unwrap_or(Decimal::ZERO);
                let have = held.get(f).copied().unwrap_or(Decimal::ZERO).min(*u);
                OpeningPosition {
                    fund: f.clone(),
                    units: format!("{:.6}", u),
                    nav: format!("{:.4}", nav),
                    value_cents: cents(*u * nav),
                    rounding_sliver: slivers.get(f).map(|s| format!("{s}")),
                    already_held: format!("{:.6}", have),
                    to_add: format!("{:.6}", to_write.get(f).copied().unwrap_or(Decimal::ZERO)),
                }
            })
            .collect(),
        open_date: open_date.to_string(),
        payments: payments(&txns),
        problems,
        funds: funds.into_iter().collect(),
    })
}

/// §155 — the opening position the file implies, LESS what the account
/// already holds on that date. Only a shortfall is written; a fund the
/// register already covers, or over-covers, gets nothing.
///
/// Report T2: the export began with a sale of 1,000 G Fund shares, so the
/// importer worked out that they must have been held the day before and
/// wrote them in — on top of the same shares, bought earlier and already in
/// the register. Holdings doubled. The file cannot know what the register
/// holds; the register can.
pub fn net_of_held(
    opening: &BTreeMap<String, Decimal>,
    held: &BTreeMap<String, Decimal>,
) -> BTreeMap<String, Decimal> {
    opening
        .iter()
        .filter_map(|(f, u)| {
            let short = *u - held.get(f).copied().unwrap_or(Decimal::ZERO);
            (short > Decimal::ZERO).then(|| (f.clone(), short))
        })
        .collect()
}

/// The earliest NAV the file states for each fund that needs an opening
/// position. The day before is not in the file; the nearest real number is
/// honest, and a plan account's cost basis is not a tax figure.
fn opening_navs(txns: &[Txn], opening: &BTreeMap<String, Decimal>) -> BTreeMap<String, Decimal> {
    let mut out = BTreeMap::new();
    for fund in opening.keys() {
        if let Some(t) = txns
            .iter()
            .filter(|t| &t.fund == fund)
            .min_by_key(|t| t.date)
        {
            out.insert(fund.clone(), t.nav);
        }
    }
    out
}

// ---------------------------------------------------------------------------
// The payment split — the part the CSV cannot know

/// `(deposits, net, kept-back lines)` for one cash-out day.
///
/// Every refusal here guards against a way the split can go wrong:
/// deposits totaling more than the plan sold, two lines both claiming the
/// remainder, a set of lines that does not add up. None of them are worth
/// importing "approximately".
pub fn split_payment(
    day: &str,
    gross_cents: i64,
    spec: Option<&PaymentSplit>,
) -> Result<(Vec<Deposit>, i64, Vec<(String, i64, String)>), String> {
    let Some(spec) = spec else {
        // No split: the whole gross goes to the bank on the plan's own date.
        // This is the shape that was wrong, so the caller is expected to have
        // asked first — `Payment::needs_split` says as much.
        return Ok((
            vec![Deposit { on: day.to_string(), amount_cents: gross_cents }],
            gross_cents,
            Vec::new(),
        ));
    };
    if spec.deposits.is_empty() {
        return Err(format!("{day}: say what reached the bank, even if it was nothing"));
    }
    let net: i64 = spec.deposits.iter().map(|d| d.amount_cents).sum();
    if net > gross_cents {
        return Err(format!(
            "{day}: the deposits total {} but the plan only sold {}",
            money(net),
            money(gross_cents)
        ));
    }
    if spec.deposits.iter().any(|d| d.amount_cents < 0) {
        return Err(format!("{day}: a deposit cannot be negative"));
    }
    let blanks = spec.lines.iter().filter(|l| l.amount_cents.is_none()).count();
    if blanks > 1 {
        return Err(format!("{day}: only one line may be left to take the remainder"));
    }
    let named: i64 = spec.lines.iter().filter_map(|l| l.amount_cents).sum();
    let remainder = gross_cents - net - named;
    let mut lines: Vec<(String, i64, String)> = Vec::new();
    for l in &spec.lines {
        let amount = l.amount_cents.unwrap_or(remainder);
        if amount < 0 {
            return Err(format!(
                "{day}: that leaves {} kept back, which is less than nothing — check the deposits",
                money(amount)
            ));
        }
        if l.category.trim().is_empty() {
            return Err(format!("{day}: {} needs a category", money(amount)));
        }
        lines.push((l.category.trim().to_string(), amount, l.memo.clone()));
    }
    let total: i64 = lines.iter().map(|(_, a, _)| *a).sum();
    if net + total != gross_cents {
        return Err(format!(
            "{day}: {} to the bank plus {} kept back does not make the {} the plan sold",
            money(net),
            money(total),
            money(gross_cents)
        ));
    }
    Ok((
        spec.deposits.clone(),
        net,
        lines.into_iter().filter(|(_, a, _)| *a != 0).collect(),
    ))
}

fn money(c: i64) -> String {
    format!("{}{}.{:02}", if c < 0 { "-" } else { "" }, c.abs() / 100, c.abs() % 100)
}

// ---------------------------------------------------------------------------
// Writing

fn qif_date(d: NaiveDate) -> String {
    d.format("%m/%d/%Y").to_string()
}

/// The security name T-Money will create. No symbol: the TSP funds have no
/// ticker, and a made-up one would send the price refresh looking for a quote
/// that does not exist. Prices come from the file instead.
pub fn security(fund: &str) -> String {
    format!("TSP {fund}")
}

fn record(fields: &[(&str, String)]) -> String {
    let mut s = String::new();
    for (k, v) in fields {
        s.push_str(k);
        s.push_str(v);
        s.push('\n');
    }
    s.push_str("^\n");
    s
}

/// The investment QIF: the opening position, every transaction, and one
/// transfer per payment.
pub fn build_qif(
    txns: &[Txn],
    opening: &BTreeMap<String, Decimal>,
    open_date: NaiveDate,
    // §154 — `None` when the file paid nothing out. A payment with no account
    // to land in is refused here, before a line of QIF reaches the importer.
    cash_account: Option<&str>,
    splits: &[PaymentSplit],
) -> Result<String, String> {
    let open_nav = opening_navs(txns, opening);
    let mut out = String::from("!Type:Invst\n");

    // The position held before the file starts. ShrsIn moves no cash, which
    // is exactly what an opening position is: shares that were already there.
    for (fund, units) in opening {
        let nav = open_nav.get(fund).copied().unwrap_or(Decimal::ZERO);
        out.push_str(&record(&[
            ("D", qif_date(open_date)),
            ("N", "ShrsIn".into()),
            ("Y", security(fund)),
            ("I", format!("{nav:.4}")),
            ("Q", format!("{units:.6}")),
            ("T", format!("{:.2}", *units * nav)),
            ("M", OPENING_MEMO.into()),
        ]));
    }

    for t in txns {
        let amt = t.amount.abs();
        let units = t.units.abs();
        let mut fields: Vec<(&str, String)> = vec![
            ("D", qif_date(t.date)),
            ("N", String::new()),
            ("Y", security(&t.fund)),
            ("I", format!("{:.4}", t.nav)),
            ("Q", format!("{units:.6}")),
            ("T", format!("{amt:.2}")),
            ("M", String::new()),
        ];
        let (action, memo) = if let Some(m) = contribution_memo(&t.activity) {
            ("Buy", m.to_string())
        } else if let Some(m) = payroll_in_memo(&t.activity) {
            ("Buy", m.to_string())
        } else if let Some(m) = cash_out_memo(&t.activity) {
            ("Sell", m.to_string())
        } else if t.units > Decimal::ZERO {
            // §167 — a reallocation is an EXCHANGE, not a sale and a purchase:
            // Shares In / Shares Out move no cash, and once the importer has
            // linked the day's rows the lot engine carries the basis and the
            // dates across the funds. As a Buy and a Sell it booked a realized
            // gain inside a tax-deferred plan and reset the basis to that
            // day's price.
            ("ShrsIn", REALLOC_IN.to_string())
        } else {
            ("ShrsOut", REALLOC_OUT.to_string())
        };
        fields[1].1 = action.to_string();
        fields[6].1 = memo;
        out.push_str(&record(&fields));
    }

    // One transfer per payment, after the sells that funded it — a day's
    // payment can come out of two funds and the bank saw one deposit.
    //
    // The transfer is the NET, on the day the bank posted it, so the importer
    // can match it to the deposit already in the register instead of writing
    // a second copy. What was kept back becomes its own categorized row on
    // the plan's own date, so plan cash still nets to zero and nothing
    // arrives in checking that did not arrive in checking.
    for p in payments(txns) {
        let spec = splits.iter().find(|s| s.date == p.date);
        let (deposits, _net, lines) = split_payment(&p.date, p.gross_cents, spec)?;
        for (category, kept, memo) in lines {
            out.push_str(&record(&[
                ("D", qif_date(parse_iso(&p.date)?)),
                ("N", "MiscExp".into()),
                ("T", money(kept)),
                ("L", category),
                ("M", memo),
            ]));
        }
        for d in deposits {
            if d.amount_cents == 0 {
                continue;
            }
            let Some(cash_account) = cash_account else {
                return Err(format!(
                    "{}: the plan paid {} out, but no bank account was chosen for it to go to",
                    p.date,
                    money(d.amount_cents)
                ));
            };
            out.push_str(&record(&[
                ("D", qif_date(parse_iso(&d.on)?)),
                ("N", "XOut".into()),
                ("T", money(d.amount_cents)),
                ("$", money(d.amount_cents)),
                ("L", format!("[{cash_account}]")),
                ("M", MOVE_OUT.into()),
            ]));
        }
    }
    Ok(out)
}

fn parse_iso(s: &str) -> Result<NaiveDate, String> {
    NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d").map_err(|_| format!("{s:?} is not a date"))
}

/// Every NAV the file states, once per (fund, date) — the plan's own number
/// on the day, so the account's value on any past date is theirs rather than
/// interpolated.
pub fn build_prices(rows: &[Row]) -> String {
    let mut seen: BTreeMap<(String, NaiveDate), Decimal> = BTreeMap::new();
    for r in rows {
        seen.insert((r.fund.clone(), r.date), r.nav);
    }
    let mut out = String::from("!Type:Prices\n");
    for ((fund, d), nav) in seen {
        out.push_str(&format!("\"{}\",{:.4},\"{}\"\n^\n", security(&fund), nav, qif_date(d)));
    }
    out
}

#[cfg(test)]
mod door_tests {
    use super::*;

    fn cols(line: &str) -> Vec<String> {
        line.split(',').map(|s| s.to_string()).collect()
    }

    /// §132 — the generic CSV importer asks this before offering to read a
    /// file flat. A real TSP export went through that door: right balance,
    /// no fund, no units, no price, every row named after the account.
    #[test]
    fn a_tsp_export_is_recognized_and_a_bank_csv_is_not() {
        assert!(looks_like_tsp(&cols(
            "VALUATION DATE,POSTING DATE,ACTIVITY TYPE,PLAN,ACCOUNT,FUND,AMOUNT,FUND NAV/PRICE,FUND UNITS"
        )));
        // Case and spacing are the servicer's business, not ours.
        assert!(looks_like_tsp(&cols(
            "valuation date, posting date, activity type, plan, account, fund, amount, fund nav/price, fund units"
        )));
        // An ordinary bank export, and a brokerage one with a price column
        // but no units — neither belongs in the TSP importer.
        assert!(!looks_like_tsp(&cols("Date,Description,Withdrawal,Deposit,Balance")));
        assert!(!looks_like_tsp(&cols("Date,Activity Type,Symbol,Amount,Price")));
        assert!(!looks_like_tsp(&[]));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A miniature of the real file: two money sources on one contribution
    /// day, a reallocation that nets to zero, and a withdrawal that sells out
    /// of two funds for one payment.
    const CSV: &str = "\
VALUATION DATE,POSTING DATE,ACTIVITY TYPE,PLAN,ACCOUNT,FUND,AMOUNT,FUND NAV/PRICE,FUND UNITS
01-02-2026,01-02-2026,Traditional,TSP,Traditional,G Fund,600.00,20.0000,30.000000
01-02-2026,01-02-2026,Traditional,TSP,Roth,G Fund,400.00,20.0000,20.000000
02-02-2026,02-02-2026,Fund Transfers,TSP,Traditional,I Fund,500.00,50.0000,10.000000
02-02-2026,02-02-2026,Reallocate,TSP,Traditional,G Fund,-500.00,20.0000,-25.000000
03-02-2026,03-02-2026,Roth Conversion Out,TSP,Traditional,G Fund,-100.00,20.0000,-5.000000
03-02-2026,03-02-2026,Roth Conversion In,TSP,Roth,G Fund,100.00,20.0000,5.000000
04-01-2026,04-01-2026,Withdrawals,TSP,Traditional,G Fund,-300.00,20.0000,-15.000000
04-01-2026,04-01-2026,Withdrawals,TSP,Traditional,I Fund,-200.00,50.0000,-4.000000
";

    fn rows() -> Vec<Row> {
        read(CSV).unwrap()
    }

    #[test]
    fn the_money_sources_collapse_into_one_transaction_each() {
        let txns = collapse(&rows());
        // 8 CSV rows: the two contribution sources fold into one, the Roth
        // conversion pair disappears entirely, and the rest stand.
        let jan: Vec<&Txn> = txns.iter().filter(|t| t.date.to_string() == "2026-01-02").collect();
        assert_eq!(jan.len(), 1, "one contribution, not one per source");
        assert_eq!(jan[0].amount, Decimal::from_str("1000.00").unwrap());
        assert_eq!(jan[0].units, Decimal::from_str("50.000000").unwrap());
        assert!(
            !txns.iter().any(|t| t.activity.starts_with("Roth Conversion")),
            "a conversion between money sources moved nothing and must vanish"
        );
    }

    #[test]
    fn adding_shares_is_ordered_before_removing_them_on_the_same_day() {
        // The lot engine cannot sell shares that arrive later the same day.
        let txns = collapse(&rows());
        let feb: Vec<&Txn> = txns.iter().filter(|t| t.date.to_string() == "2026-02-02").collect();
        assert_eq!(feb.len(), 2);
        assert!(feb[0].units > Decimal::ZERO, "the buy comes first");
        assert!(feb[1].units < Decimal::ZERO);
    }

    #[test]
    fn the_opening_position_is_arithmetic_not_a_guess() {
        let txns = collapse(&rows());
        let (opening, _) = opening_positions(&txns);
        // G Fund: +50 in, −25 reallocated out, −15 withdrawn = +10 net, so
        // nothing was needed beforehand. I Fund: +10 in, −4 out = +6, also
        // fine. Nothing goes negative, so there is no opening position.
        assert!(opening.is_empty(), "this file needs no opening position: {opening:?}");

        // Now a file that does: sell more than was ever bought.
        let short = "\
VALUATION DATE,POSTING DATE,ACTIVITY TYPE,PLAN,ACCOUNT,FUND,AMOUNT,FUND NAV/PRICE,FUND UNITS
01-02-2026,01-02-2026,Withdrawals,TSP,Traditional,S Fund,-1000.00,10.0000,-100.000000
";
        let t2 = collapse(&read(short).unwrap());
        let (o2, _) = opening_positions(&t2);
        assert_eq!(o2.get("S Fund"), Some(&Decimal::from_str("100.000000").unwrap()));
    }

    #[test]
    fn a_file_that_balances_has_nothing_to_complain_about() {
        let txns = collapse(&rows());
        let (opening, _) = opening_positions(&txns);
        assert_eq!(check(&txns, &opening), Vec::<String>::new());
    }

    #[test]
    fn a_fund_move_that_costs_money_is_a_problem() {
        // Every reallocation day must net to zero; one that does not means a
        // row was misread, and importing it would invent cash.
        let bad = "\
VALUATION DATE,POSTING DATE,ACTIVITY TYPE,PLAN,ACCOUNT,FUND,AMOUNT,FUND NAV/PRICE,FUND UNITS
02-02-2026,02-02-2026,Fund Transfers,TSP,Traditional,I Fund,500.00,50.0000,10.000000
02-02-2026,02-02-2026,Reallocate,TSP,Traditional,G Fund,-400.00,20.0000,-20.000000
";
        let txns = collapse(&read(bad).unwrap());
        let (opening, _) = opening_positions(&txns);
        let problems = check(&txns, &opening);
        assert!(problems.iter().any(|p| p.contains("net 100")), "{problems:?}");
    }

    #[test]
    fn the_payments_are_the_days_money_left_the_plan() {
        let txns = collapse(&rows());
        let p = payments(&txns);
        assert_eq!(p.len(), 1, "one payment, though it sold out of two funds");
        assert_eq!(p[0].date, "2026-04-01");
        assert_eq!(p[0].gross_cents, 50_000, "the whole $500, not one fund's share");
        assert!(p[0].needs_split);
    }

    // --- the split: the part that cost a restore when it was missing ------

    fn split(deposits: &[(&str, i64)], lines: &[(&str, Option<i64>)]) -> PaymentSplit {
        PaymentSplit {
            date: "2026-04-01".into(),
            deposits: deposits
                .iter()
                .map(|(on, c)| Deposit { on: (*on).into(), amount_cents: *c })
                .collect(),
            lines: lines
                .iter()
                .map(|(cat, amt)| KeptLine {
                    category: (*cat).into(),
                    amount_cents: *amt,
                    memo: "Tax withheld on TSP distribution".into(),
                })
                .collect(),
        }
    }

    #[test]
    fn the_bank_gets_the_net_and_the_rest_is_categorized() {
        let s = split(&[("2026-04-02", 46_000)], &[("Taxes:TSP Federal Withholding", None)]);
        let (deposits, net, lines) = split_payment("2026-04-01", 50_000, Some(&s)).unwrap();
        assert_eq!(net, 46_000);
        assert_eq!(deposits[0].on, "2026-04-02", "dated when the BANK saw it");
        assert_eq!(lines, vec![("Taxes:TSP Federal Withholding".to_string(), 4_000, "Tax withheld on TSP distribution".to_string())]);
    }

    #[test]
    fn one_payment_can_arrive_as_two_deposits() {
        // One $460.00 payment landed as $400.00 and $60.00. The importer
        // matches a deposit by its exact amount, so one combined row would
        // match neither of them.
        let s = split(
            &[("2026-04-02", 40_000), ("2026-04-02", 6_000)],
            &[("Taxes:TSP Federal Withholding", None)],
        );
        let (deposits, net, lines) = split_payment("2026-04-01", 50_000, Some(&s)).unwrap();
        assert_eq!(deposits.len(), 2);
        assert_eq!(net, 46_000);
        assert_eq!(lines[0].1, 4_000);
    }

    #[test]
    fn a_zero_line_is_dropped_rather_than_written() {
        let s = split(&[("2026-04-02", 50_000)], &[("Taxes:TSP Federal Withholding", None)]);
        let (_, net, lines) = split_payment("2026-04-01", 50_000, Some(&s)).unwrap();
        assert_eq!(net, 50_000);
        assert!(lines.is_empty(), "nothing was kept back, so nothing is written");
    }

    #[test]
    fn deposits_larger_than_the_plan_sold_are_refused() {
        let s = split(&[("2026-04-02", 60_000)], &[]);
        let e = split_payment("2026-04-01", 50_000, Some(&s)).unwrap_err();
        assert!(e.contains("only sold"), "{e}");
    }

    #[test]
    fn two_lines_cannot_both_claim_the_remainder() {
        let s = split(
            &[("2026-04-02", 46_000)],
            &[("Taxes:TSP Federal Withholding", None), ("Bank Charges:Loan fee", None)],
        );
        let e = split_payment("2026-04-01", 50_000, Some(&s)).unwrap_err();
        assert!(e.contains("only one line"), "{e}");
    }

    #[test]
    fn lines_that_do_not_add_up_are_refused() {
        let s = split(
            &[("2026-04-02", 46_000)],
            &[("Taxes:TSP Federal Withholding", Some(1_000))],
        );
        let e = split_payment("2026-04-01", 50_000, Some(&s)).unwrap_err();
        assert!(e.contains("does not make"), "{e}");
    }

    #[test]
    fn a_line_with_no_category_is_refused() {
        let s = split(&[("2026-04-02", 46_000)], &[("  ", None)]);
        let e = split_payment("2026-04-01", 50_000, Some(&s)).unwrap_err();
        assert!(e.contains("needs a category"), "{e}");
    }

    #[test]
    fn with_no_split_the_gross_goes_to_the_bank_on_the_plans_own_date() {
        // The old, wrong shape — kept so an import can still be run without
        // answering, and named `needs_split` so the dialog can insist.
        let (deposits, net, lines) = split_payment("2026-04-01", 50_000, None).unwrap();
        assert_eq!(net, 50_000);
        assert_eq!(deposits[0].on, "2026-04-01");
        assert!(lines.is_empty());
    }

    // --- the QIF -----------------------------------------------------------

    #[test]
    fn the_qif_says_buy_sell_and_one_transfer_for_the_net() {
        let txns = collapse(&rows());
        let (opening, _) = opening_positions(&txns);
        let s = split(&[("2026-04-02", 46_000)], &[("Taxes:TSP Federal Withholding", None)]);
        let qif = build_qif(
            &txns,
            &opening,
            NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(),
            Some("Everyday Checking 1234"),
            &[s],
        )
        .unwrap();

        assert!(qif.starts_with("!Type:Invst\n"));
        assert!(qif.contains("NBuy\nYTSP G Fund\n"), "{qif}");
        assert!(qif.contains("NSell\n"), "{qif}");
        // The transfer is the NET, on the bank's date, into the cash account.
        assert!(qif.contains("D04/02/2026\nNXOut\nT460.00\n$460.00\nL[Everyday Checking 1234]"), "{qif}");
        // What was kept back is its own categorized row on the plan's date.
        assert!(qif.contains("D04/01/2026\nNMiscExp\nT40.00\nLTaxes:TSP Federal Withholding"), "{qif}");
        // And never the gross as a transfer — the bug that put money in
        // checking that never arrived.
        assert!(!qif.contains("T500.00\n$500.00"), "the gross must not reach the bank");
    }

    #[test]
    fn a_contribution_memo_reads_as_a_contribution_and_a_sale_does_not_read_as_a_withdrawal() {
        // §90's `plan::guess` reads these memos to propose a treatment. A
        // reallocation whose memo says "withdraw" books cash that the row
        // does not represent.
        let txns = collapse(&rows());
        let (opening, _) = opening_positions(&txns);
        let qif = build_qif(&txns, &opening, NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(), Some("Checking"), &[]).unwrap();
        for memo in qif.lines().filter(|l| l.starts_with('M')) {
            let m = memo.to_lowercase();
            if m.contains("reallocation") {
                assert!(!m.contains("withdraw") && !m.contains("contrib"), "{memo}");
            }
        }
        assert!(qif.contains("MTSP Traditional payroll deferral"));
        assert!(qif.contains("MTSP reallocation into fund"));
    }

    // §167 — a reallocation is an exchange, not a sale and a purchase.
    #[test]
    fn a_reallocation_is_shares_out_and_shares_in_not_a_sale_and_a_purchase() {
        let txns = collapse(&rows());
        let (opening, _) = opening_positions(&txns);
        let qif = build_qif(&txns, &opening, NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(), Some("Checking"), &[]).unwrap();
        let mut seen = (false, false);
        for rec in qif.split("^\n") {
            if rec.contains(REALLOC_IN) {
                assert!(rec.contains("\nNShrsIn\n"), "{rec}");
                seen.0 = true;
            }
            if rec.contains(REALLOC_OUT) {
                assert!(rec.contains("\nNShrsOut\n"), "{rec}");
                seen.1 = true;
            }
        }
        assert_eq!(seen, (true, true), "the fixture has a reallocation both ways");
        // A withdrawal is still a Sell, and a contribution still a Buy.
        assert!(qif.contains("NSell\n"), "{qif}");
        assert!(qif.contains("NBuy\n"), "{qif}");
    }

    #[test]
    fn the_opening_position_is_written_as_shares_in_which_moves_no_cash() {
        let short = "\
VALUATION DATE,POSTING DATE,ACTIVITY TYPE,PLAN,ACCOUNT,FUND,AMOUNT,FUND NAV/PRICE,FUND UNITS
01-02-2026,01-02-2026,Withdrawals,TSP,Traditional,S Fund,-1000.00,10.0000,-100.000000
";
        let txns = collapse(&read(short).unwrap());
        let (opening, _) = opening_positions(&txns);
        let qif = build_qif(&txns, &opening, NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(), Some("Checking"), &[]).unwrap();
        assert!(qif.contains("NShrsIn\nYTSP S Fund\nI10.0000\nQ100.000000"), "{qif}");
    }

    /// §154 — report W4: a file of contributions and reallocations moves nothing
    /// to a bank, so there is nothing to name. The dialog no longer asks, and
    /// the QIF is built without one.
    #[test]
    fn a_file_that_paid_nothing_out_needs_no_bank_account() {
        let quiet = "\
VALUATION DATE,POSTING DATE,ACTIVITY TYPE,PLAN,ACCOUNT,FUND,AMOUNT,FUND NAV/PRICE,FUND UNITS
01-02-2026,01-02-2026,Traditional,TSP,Traditional,G Fund,600.00,20.0000,30.000000
02-02-2026,02-02-2026,Fund Transfers,TSP,Traditional,I Fund,500.00,50.0000,10.000000
02-02-2026,02-02-2026,Reallocate,TSP,Traditional,G Fund,-500.00,20.0000,-25.000000
";
        let txns = collapse(&read(quiet).unwrap());
        assert!(payments(&txns).is_empty(), "nothing left the plan");
        let (opening, _) = opening_positions(&txns);
        let qif = build_qif(&txns, &opening, NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(), None, &[]).unwrap();
        assert!(qif.contains("NBuy\n"), "{qif}");
        assert!(!qif.contains("NXOut"), "no transfer was written, because none happened: {qif}");
    }

    /// ...and the other half: a file that DID pay out, with no account for
    /// the money to land in, is refused before a line reaches the importer —
    /// not written with the transfer quietly missing.
    #[test]
    fn a_payment_with_no_bank_account_is_refused() {
        let txns = collapse(&rows());
        let (opening, _) = opening_positions(&txns);
        let err = build_qif(&txns, &opening, NaiveDate::from_ymd_opt(2026, 1, 1).unwrap(), None, &[]).unwrap_err();
        assert!(err.contains("2026-04-01") && err.contains("no bank account"), "{err}");
    }

    /// §155 — report T2. The file's first row sold shares it never bought, so
    /// the importer wrote them in as an opening position — on top of the
    /// same shares already in the register. Holdings doubled.
    #[test]
    fn shares_the_register_already_holds_are_not_written_in_again() {
        let sells_first = "\
VALUATION DATE,POSTING DATE,ACTIVITY TYPE,PLAN,ACCOUNT,FUND,AMOUNT,FUND NAV/PRICE,FUND UNITS
09-03-2026,09-03-2026,Interfund Transfer,TSP,Traditional,G Fund,-2000.00,20.0000,-100.000000
09-03-2026,09-03-2026,Interfund Transfer,TSP,Traditional,I Fund,2000.00,50.0000,40.000000
";
        let txns = collapse(&read(sells_first).unwrap());
        let (opening, _) = opening_positions(&txns);
        let g = opening.get("G Fund").copied().expect("the file sells G it never bought");
        assert_eq!(g, Decimal::from(100));

        // All of it already there: nothing to add.
        let mut held = BTreeMap::new();
        held.insert("G Fund".to_string(), g);
        assert!(net_of_held(&opening, &held).is_empty(), "already held, nothing added");
        // More than the file needs: still nothing, never a negative.
        held.insert("G Fund".to_string(), g + Decimal::ONE);
        assert!(net_of_held(&opening, &held).is_empty());
        // Part of it: only the rest.
        held.insert("G Fund".to_string(), Decimal::from(30));
        assert_eq!(net_of_held(&opening, &held).get("G Fund").copied(), Some(Decimal::from(70)));
        // Nothing held (a fresh account): the whole opening, as before.
        assert_eq!(net_of_held(&opening, &BTreeMap::new()).get("G Fund").copied(), Some(g));

        // And the QIF written from the netted opening carries no opening
        // position. (§167: the reallocation's own Shares In is still there.)
        held.insert("G Fund".to_string(), g);
        let write = net_of_held(&opening, &held);
        let qif = build_qif(&txns, &write, NaiveDate::from_ymd_opt(2026, 9, 2).unwrap(), None, &[]).unwrap();
        assert!(!qif.contains(OPENING_MEMO), "{qif}");

        // The preview says so, per fund, so the screen can show it.
        let p = plan(sells_first, &held).unwrap();
        let o = p.opening.iter().find(|o| o.fund == "G Fund").unwrap();
        assert_eq!(o.units, "100.000000", "what the file implies is still shown in full");
        assert_eq!(o.already_held, "100.000000");
        assert_eq!(o.to_add, "0.000000");
        let p = plan(sells_first, &BTreeMap::new()).unwrap();
        let o = p.opening.iter().find(|o| o.fund == "G Fund").unwrap();
        assert_eq!(o.already_held, "0.000000");
        assert_eq!(o.to_add, "100.000000");
    }

    #[test]
    fn the_prices_file_carries_the_plans_own_nav_per_fund_per_day() {
        let p = build_prices(&rows());
        assert!(p.starts_with("!Type:Prices\n"));
        assert!(p.contains("\"TSP G Fund\",20.0000,\"01/02/2026\""), "{p}");
        assert!(p.contains("\"TSP I Fund\",50.0000,\"02/02/2026\""), "{p}");
    }

    #[test]
    fn a_file_that_is_not_a_tsp_export_says_which_column_is_missing() {
        let e = read("Date,Payee,Amount\n01-02-2026,Kroger,-42.50\n").unwrap_err();
        assert!(e.contains("VALUATION DATE"), "{e}");
        assert!(e.contains("tsp.gov"), "and says where to get the right one: {e}");
    }

    #[test]
    fn the_plan_summary_counts_the_collapse_and_lists_what_to_ask_about() {
        let p = plan(CSV, &BTreeMap::new()).unwrap();
        assert_eq!(p.rows, 8);
        assert!(p.transactions < p.rows, "the collapse is the point");
        assert_eq!(p.payments.len(), 1);
        assert!(p.problems.is_empty(), "{:?}", p.problems);
        assert_eq!(p.funds, vec!["G Fund".to_string(), "I Fund".to_string()]);
    }
}
