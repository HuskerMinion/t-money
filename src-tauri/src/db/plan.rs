//! The year plan: one figure per category per year, and twelve columns
//! of what actually happened against it.
//!
//! > *"I'm seeing that I have to budget every single month. Not put a budget
//! >  in and see how it holds up for every month of the year."*
//!
//! HOW THE USER ACTUALLY BUDGETS. A year of a category's spending, divided by
//! twelve, nudged up to a round number. That figure stands for the whole year
//! and the twelve months underneath it are a READING, not a decision. The
//! Budget tab as built asked for the decision twelve times, because `budgets`
//! is keyed on (category, month) and a month with no row has no budget.
//!
//! WHAT IS AUTHORED AND WHAT IS DERIVED. A `budget_plans` row holds two
//! things: `annual_cents` and a twelve-character `months` mask. Everything
//! else on the screen — the monthly figure, the twelve actuals, what should
//! have happened by now, whether it is holding up — is computed from those
//! two plus the register. Nothing else is typed, ever.
//!
//! `budgets` IS NOT REPLACED, IT IS MATERIALIZED. Half a dozen features read
//! `budgets` today: the spending tracker, the reports, autobudget, the
//! envelope rule, the Home tab. Rewriting all of them to read plans would be
//! a rewrite with no upside, and running two sources of budget truth is worse
//! than either. So `set_plan` writes the plan AND rewrites that year's
//! monthly rows from it. Everything downstream keeps reading `budgets` and
//! never learns this table exists.
//!
//! That also settles per-month overrides, which the user was asked about and
//! declined: the materialized rows are always rewritten from the plan, so
//! typing into one month cannot survive. *"That doesn't upend the plan, it
//! just is"* — a heavy month is a fact in the actuals column, not an edit to
//! the budget.
//!
//! DIVIDED BY THE MONTHS THAT ARE SET, NOT BY TWELVE. Heating oil runs November
//! to March. Its $900 is $180 in each of five months and nothing in the
//! other seven — a twelfth would report $75 owed in July and a category
//! permanently ahead of plan. `monthly_of` divides by the mask's count, and
//! `expected_to_date` counts only SET months that have elapsed.
//!
//! EXCEPT WHEN THE MASK MEANS SOMETHING ELSE. The paragraph above
//! assumes the mask says WHEN THIS IS SPENT. For home insurance it does not:
//!
//! > *"I still want that bill's monthly amount in all the other months
//! >  because those are the months where that smaller monthly amount is put
//! >  into a savings account (or should be) but this is just budgeting so it
//! >  doesn't have to correlate exactly with an account."*
//!
//! That money leaves once, in January, and is set aside all year. Heating oil's
//! reading reports the whole bill owed in January and nothing to save in the other
//! eleven months, which is the opposite of useful. So a plan carries a
//! `spread` that says how to read its mask:
//!
//! - `SPENT` — the months it is spent in. Divide by those. The 0038
//!   behavior, and the default, so nothing that already exists moves.
//! - `ASIDE` — the months it is DUE. Divide by twelve: the monthly figure
//!   is what you set aside, and the mask marks where the bill lands.
//!
//! In `ASIDE` the mask carries no arithmetic at all — twelve equal rows are
//! materialized exactly as `every month` would produce — so `budgets` and
//! everything reading it stays unaware of this too. What the mask buys is
//! that the screen can say *"100 a month · 600 due Jan, Jul"* rather than
//! having to choose which half of that sentence to tell.
//!
//! INCOME IS HERE ON THE SAME TERMS. `budgets` has only ever held expense
//! categories. The year plan carries both, so the screen shows income,
//! expenses and a net line the way a spreadsheet does. Only expense
//! plans are materialized into `budgets` — nothing downstream expects an
//! income row there, and putting one in would show up as a phantom category
//! in the spending tracker.

use crate::db::queries::{next_ten_above, Conn, CATEGORY_LINES};
use crate::models::{PlanLine, PlanTotals, PlanWrite, RaisedParent, YearPlan};
use rusqlite::{params, OptionalExtension};
use std::collections::HashMap;
use uuid::Uuid;

pub const EVERY_MONTH: &str = "111111111111";

/// How to read a plan's `months` mask. See the module header.
pub const SPENT: &str = "spent";
pub const ASIDE: &str = "aside";

pub fn valid_spread(spread: &str) -> bool {
    spread == SPENT || spread == ASIDE
}

const MONTH_NAMES: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Run a multi-step write as one SQL transaction.
///
/// A plan write is three writes: the plan row, the envelope rule on its
/// parent, and the year's monthly rows. Each ran on its own, so a failure in
/// the second or third left a plan the budget screen did not agree with — a
/// figure in the year grid and the old one in every report reading
/// `budgets`. Now it lands whole or not at all.
///
/// Inside a caller's transaction (a category merge folds plans and then
/// calls in here) it simply runs: SQLite does not nest `BEGIN`, and the
/// caller's commit or rollback already covers it.
fn atomically<T>(conn: &Conn, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    if !conn.is_autocommit() {
        return f();
    }
    let tx = conn.unchecked_transaction().map_err(err)?;
    let out = f()?;
    tx.commit().map_err(err)?;
    Ok(out)
}

// ---------------------------------------------------------------------------
// The mask
// ---------------------------------------------------------------------------

/// Is month `m` (1-12) set in this mask? A malformed mask reads as every
/// month rather than as no months: a line that shows up everywhere is a
/// visible bug, and one that silently vanishes from the screen is not.
pub fn is_set(months: &str, m: u32) -> bool {
    if !valid_mask(months) {
        return true;
    }
    months.as_bytes()[(m - 1) as usize] == b'1'
}

pub fn valid_mask(months: &str) -> bool {
    months.len() == 12 && months.bytes().all(|b| b == b'0' || b == b'1')
}

pub fn month_count(months: &str) -> i64 {
    if !valid_mask(months) {
        return 12;
    }
    months.bytes().filter(|b| *b == b'1').count() as i64
}

/// How many ways the annual figure is divided to get the monthly
/// one. `SPENT` divides by the months it runs in; `ASIDE` always divides by
/// twelve, because you set money aside every month regardless of when the
/// bill lands.
///
/// An unrecognized spread reads as `SPENT`, for the same reason a malformed
/// mask reads as every month: the wrong answer that is VISIBLE beats the one
/// that quietly halves a figure.
pub fn spread_count(months: &str, spread: &str) -> i64 {
    if spread == ASIDE {
        12
    } else {
        month_count(months)
    }
}

/// The monthly figure, rounded UP to something a person can hold in
/// their head.
///
/// > *"To me that should say $90 (1000 divided by 12 then raised up to the
/// >  next whole $10)."*
///
/// The same instinct as the envelope rule: *"it should always land
/// slightly higher... my preference a whole ten number"*. Rounding UP rather
/// than to nearest is the point — a monthly figure you save to should never
/// be short of the bill it is saving for.
///
/// WHY THIS IS NOT SIMPLY `ceil_ten`. Read against three small yearly
/// subscriptions ($120, $100, $60), a flat round-up to the next ten makes
/// every one of those **$10 a month** — three different bills, one figure,
/// and the small end of the budget stops meaning anything. It is also not a
/// rounding any more: $5 to $10 is not tidying a number, it is doubling it.
///
/// So: the next whole ten when the rounding is INCIDENTAL — within a tenth
/// of the figure, which is what makes it a tidy-up rather than a decision —
/// and the next whole dollar when it is not. $333.33 goes to $340 (+2%);
/// $8.33 goes to $9, not $10.
pub fn round_up_monthly(cents: i64) -> i64 {
    if cents <= 0 {
        return 0;
    }
    let ten = ((cents + 999) / 1_000) * 1_000;
    if ten * 10 <= cents * 11 {
        return ten;
    }
    ((cents + 99) / 100) * 100
}

/// The annual figure over the months it is spread across, rounded up by
/// `round_up_monthly`.
///
/// THE TWO COLUMNS NO LONGER MULTIPLY INTO EACH OTHER, deliberately.
/// $1,000 a year is $90 a month and twelve of those is $1,080. The annual
/// figure is the BILL; the monthly figure is what you put by for it, and
/// putting by slightly more than the bill is the entire point of rounding up.
pub fn monthly_of(annual_cents: i64, months: &str, spread: &str) -> i64 {
    let n = spread_count(months, spread);
    if n <= 0 {
        return 0;
    }
    let neg = annual_cents < 0;
    let a = annual_cents.abs();
    let v = round_up_monthly((a + n / 2) / n);
    if neg {
        -v
    } else {
        v
    }
}

/// What ONE payment of an `ASIDE` line is: the annual figure over
/// the months it is DUE, which is the mask's count. $1,200 due in January is
/// one payment of $1,200; due in Jan and Jul it is two of $600.
///
/// Zero for a `SPENT` line, where the monthly figure already IS the payment
/// and a second number would only invite the reader to add them together.
pub fn payment_of(annual_cents: i64, months: &str, spread: &str) -> i64 {
    if spread != ASIDE {
        return 0;
    }
    let n = month_count(months);
    if n <= 0 {
        return 0;
    }
    let neg = annual_cents < 0;
    let a = annual_cents.abs();
    let v = (a + n / 2) / n;
    if neg {
        -v
    } else {
        v
    }
}

/// "every month", "Nov–Mar", "Jan, Apr, Jul, Oct", "no months".
///
/// A contiguous run is named by its ends, and a run is allowed to WRAP the
/// year end — Nov, Dec, Jan, Feb, Mar is one winter, not two fragments, and
/// listing it as "Jan, Feb, Mar, Nov, Dec" is the sort of thing that makes a
/// person distrust the screen.
pub fn months_label(months: &str) -> String {
    if !valid_mask(months) || month_count(months) == 12 {
        return "every month".into();
    }
    let set: Vec<u32> = (1..=12).filter(|m| is_set(months, *m)).collect();
    if set.is_empty() {
        return "no months".into();
    }
    if set.len() <= 3 {
        return set
            .iter()
            .map(|m| MONTH_NAMES[(*m - 1) as usize])
            .collect::<Vec<_>>()
            .join(", ");
    }
    // Find a start: a set month whose predecessor (wrapping) is not set.
    let prev = |m: u32| if m == 1 { 12 } else { m - 1 };
    let next = |m: u32| if m == 12 { 1 } else { m + 1 };
    let starts: Vec<u32> = set.iter().copied().filter(|m| !is_set(months, prev(*m))).collect();
    if starts.len() == 1 {
        let start = starts[0];
        let mut end = start;
        while is_set(months, next(end)) {
            end = next(end);
        }
        return format!(
            "{}\u{2013}{}",
            MONTH_NAMES[(start - 1) as usize],
            MONTH_NAMES[(end - 1) as usize]
        );
    }
    set.iter()
        .map(|m| MONTH_NAMES[(*m - 1) as usize])
        .collect::<Vec<_>>()
        .join(", ")
}

// ---------------------------------------------------------------------------
// Reading and writing one plan
// ---------------------------------------------------------------------------

struct Plan {
    annual_cents: i64,
    months: String,
    spread: String,
    /// The annual figure a PERSON typed, if one ever did. The
    /// envelope shown is the larger of this and what the children need, so
    /// the typed figure is never overwritten, only outgrown. See migration 0041.
    asked_for: Option<i64>,
}

impl Plan {
    fn monthly(&self) -> i64 {
        monthly_of(self.annual_cents, &self.months, &self.spread)
    }
}

fn plan_of(conn: &Conn, category_id: &str, year: i32) -> Result<Option<Plan>, String> {
    conn.query_row(
        "SELECT annual_cents, months, spread, asked_for_cents FROM budget_plans
          WHERE category_id = ?1 AND year = ?2",
        params![category_id, year],
        |r| {
            Ok(Plan {
                annual_cents: r.get(0)?,
                months: r.get(1)?,
                spread: r.get(2)?,
                asked_for: r.get(3)?,
            })
        },
    )
    .optional()
    .map_err(err)
}

/// The envelope rule, carried onto the year plan: a parent is the envelope for
/// its whole category, and is never below what its children have claimed.
///
/// The comparison is in MONTHLY cents because that is the number the user reasons
/// in, and because two lines can be spread over different months — a parent
/// running all year over a child that runs five is only comparable once both
/// are per-month. The parent is written back in its own spread, so raising it
/// never quietly changes WHEN it applies.
///
/// Nothing claimed, nothing raised: without that guard, clearing the last
/// child's amount would ask for `next_ten_above(0)` and invent a $10 parent.
fn raise_parent(conn: &Conn, child_id: &str, year: i32) -> Result<Option<RaisedParent>, String> {
    let parent: Option<(String, String)> = conn
        .query_row(
            "SELECT p.id, p.name FROM categories c JOIN categories p ON p.id = c.parent_id
              WHERE c.id = ?1",
            params![child_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(err)?;
    let Some((parent_id, parent_name)) = parent else {
        return Ok(None);
    };
    raise_to_cover_children(conn, &parent_id, &parent_name, year)
}

/// The envelope itself, for a parent named directly.
///
/// Split out of `raise_parent` because there are TWO ways the invariant above
/// can stop being true and only one of them was being checked. See
/// `enforce_envelope`.
fn raise_to_cover_children(
    conn: &Conn,
    parent_id: &str,
    parent_name: &str,
    year: i32,
) -> Result<Option<RaisedParent>, String> {
    let parent_id = parent_id.to_string();
    let parent_name = parent_name.to_string();

    // In monthly cents as always, and an ASIDE child claims its
    // TWELFTH, not its payment: $1,200 due each January is $100 a month of
    // the parent's envelope, because that is what is actually being set
    // aside every month. Reading it as $1,200 would size the parent for a
    // bill that arrives once.
    let claims: Vec<i64> = conn
        .prepare(
            "SELECT p.annual_cents, p.months, p.spread FROM budget_plans p
               JOIN categories c ON c.id = p.category_id
              WHERE c.parent_id = ?1 AND p.year = ?2",
        )
        .map_err(err)?
        .query_map(params![parent_id, year], |r| {
            Ok(monthly_of(
                r.get::<_, i64>(0)?,
                &r.get::<_, String>(1)?,
                &r.get::<_, String>(2)?,
            ))
        })
        .map_err(err)?
        .collect::<Result<Vec<i64>, _>>()
        .map_err(err)?;
    // How many children HAVE a plan, apart from what they claim. A
    // child planned at zero claims nothing and still has a plan, and its
    // parent shows that zero rather than nothing (Z1) — the screen reads the
    // same at both levels. Only when no child has a plan at all is there
    // nothing for an unasked-for envelope to stand on.
    let children_planned = claims.len();
    let claimed: i64 = claims.iter().sum();
    let existing = plan_of(conn, &parent_id, year)?;

    // The whole rule: the envelope is the LARGER of the figure the user
    // asked for and the figure its children need. Neither overwrites the
    // other, so a parent grows to cover its children and then settles back
    // onto the user's own figure when they shrink.
    //
    // > *"I like your last example where the original amount comes back, do
    // >  that"*
    //
    // Both sides are in MONTHLY cents, because two lines can be spread over
    // different months and are only comparable per month.
    let floor = if claimed > 0 { next_ten_above(claimed) } else { 0 };
    let asked_monthly = existing.as_ref().and_then(|p| {
        p.asked_for.map(|a| monthly_of(a, &p.months, &p.spread))
    });
    let want = floor.max(asked_monthly.unwrap_or(0));

    match existing {
        None => {
            if want <= 0 && children_planned == 0 {
                return Ok(None);
            }
            // The parent had no envelope and now has one. Every
            // month, because a parent seeded from a seasonal child is still
            // the envelope for the category all year. No `asked_for_cents`:
            // nobody asked for this one, so when the children stop
            // claiming it has nothing to fall back to and goes away.
            let annual = want * 12;
            conn.execute(
                "INSERT INTO budget_plans (id, category_id, year, annual_cents, months)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![Uuid::new_v4().to_string(), parent_id, year, annual, EVERY_MONTH],
            )
            .map_err(err)?;
            // A zero seeded from a child at zero is written silently:
            // nothing was raised, and "set to 0.00 to cover its
            // subcategories" is not a sentence anyone should read.
            if want <= 0 {
                return Ok(None);
            }
            Ok(Some(RaisedParent {
                category_id: parent_id,
                category_name: parent_name,
                target_cents: want,
                created: true,
            }))
        }
        Some(p) => {
            // Nothing wanted and nothing ever asked for: no envelope. The
            // empty-envelope rule, now falling out of the arithmetic rather than being a
            // special case.
            //
            // "nothing asked for" is `asked_for` being NULL, not zero.
            // A zero the user TYPED is `Some(0)`: a plan of nothing, measured
            // against, and it stays. This branch used to fire on it, which is
            // why 0.00 held on a child and on a childless line and vanished
            // from every parent — reported as R3.
            if want <= 0 && asked_monthly.is_none() && children_planned == 0 {
                conn.execute(
                    "DELETE FROM budget_plans WHERE category_id = ?1 AND year = ?2",
                    params![parent_id, year],
                )
                .map_err(err)?;
                conn.execute(
                    "DELETE FROM budgets WHERE category_id = ?1 AND month_year LIKE ?2",
                    params![parent_id, format!("{year:04}-%")],
                )
                .map_err(err)?;
                return Ok(Some(RaisedParent {
                    category_id: parent_id,
                    category_name: parent_name,
                    target_cents: 0,
                    created: false,
                }));
            }
            if p.monthly() == want {
                return Ok(None);
            }
            // Written back in the parent's own spread, so moving it never
            // quietly changes WHEN it applies — or, for an ASIDE parent,
            // turns a set-aside back into a lump. `asked_for_cents` is
            // deliberately not touched: the rule moves the figure on the
            // screen, never the one the user asked for.
            let annual = want * spread_count(&p.months, &p.spread);
            conn.execute(
                "UPDATE budget_plans
                    SET annual_cents = ?3, updated_at = datetime('now')
                  WHERE category_id = ?1 AND year = ?2",
                params![parent_id, year, annual],
            )
            .map_err(err)?;
            // Settling back onto a zero is not a raise either.
            if want <= 0 {
                return Ok(None);
            }
            Ok(Some(RaisedParent {
                category_id: parent_id,
                category_name: parent_name,
                target_cents: want,
                created: false,
            }))
        }
    }
}

/// The envelope rule applied to the line that was actually written,
/// whichever end of the relationship it sits on.
///
/// `raise_parent` raises the parent OF a line, which covers editing a child
/// and nothing else. But a parent row is editable on the same grid —
/// `YearPlanView` draws it through the same `row()` as its children, and
/// budgeting off parents is how the user says they work — so typing a figure
/// straight into a parent that is BELOW what its children have claimed was
/// accepted in silence. The invariant these functions exist to keep held
/// against one of the two ways to break it.
///
/// Both ends are checked rather than assuming the depth: in Money's
/// two-level taxonomy a category is a parent or a child and never both, so at
/// most one branch does anything, but nothing here depends on that staying
/// true.
///
/// Both are ENFORCED even though only one can be REPORTED. The line's own
/// raise is preferred for the message because it is the surprising one: a
/// figure you typed yourself coming back different needs the sentence more
/// than a neighboring row moving does.
fn enforce_envelope(
    conn: &Conn,
    category_id: &str,
    year: i32,
) -> Result<Option<RaisedParent>, String> {
    let own_name: Option<String> = conn
        .query_row(
            "SELECT c.name FROM categories c
              WHERE c.id = ?1
                AND EXISTS (SELECT 1 FROM categories k WHERE k.parent_id = c.id)",
            params![category_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?;
    let mine = match own_name {
        Some(name) => raise_to_cover_children(conn, category_id, &name, year)?,
        None => None,
    };
    let theirs = raise_parent(conn, category_id, year)?;
    Ok(mine.or(theirs))
}

/// Write one line's plan, keep the envelope rule true, and rewrite that
/// year's monthly rows so everything downstream sees the change.
pub fn set_plan(
    conn: &Conn,
    category_id: &str,
    year: i32,
    annual_cents: i64,
    months: &str,
    spread: &str,
) -> Result<PlanWrite, String> {
    if annual_cents < 0 {
        return Err("A plan cannot be negative.".into());
    }
    if !valid_mask(months) {
        return Err(format!("{months:?} is not a twelve-month mask"));
    }
    if !valid_spread(spread) {
        return Err(format!("{spread:?} is not a spread"));
    }
    // True for both readings, and for different reasons: a SPENT
    // line has to be spent somewhere, and an ASIDE line has to be DUE
    // somewhere or nothing on the screen can say when it lands.
    if month_count(months) == 0 {
        return Err("A plan needs at least one month to be spread over.".into());
    }
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM categories WHERE id = ?1)",
            params![category_id],
            |r| r.get(0),
        )
        .map_err(err)?;
    if !exists {
        return Err("category not found".into());
    }

    let raised = atomically(conn, || {
        conn.execute(
            "INSERT INTO budget_plans (id, category_id, year, annual_cents, months, spread, asked_for_cents)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?4)
             ON CONFLICT (category_id, year)
             DO UPDATE SET annual_cents = excluded.annual_cents,
                           months = excluded.months,
                           spread = excluded.spread,
                           asked_for_cents = excluded.annual_cents,
                           updated_at = datetime('now')",
            params![Uuid::new_v4().to_string(), category_id, year, annual_cents, months, spread],
        )
        .map_err(err)?;
        let raised = enforce_envelope(conn, category_id, year)?;
        materialize(conn, year)?;
        Ok(raised)
    })?;
    Ok(PlanWrite {
        line: line_of(conn, category_id, year)?,
        raised,
    })
}

/// Remove a line's plan. Different from a plan of zero, which says "nothing
/// here on purpose" and is measured against.
///
/// The monthly rows are dropped HERE rather than left to `materialize`, and
/// the order matters: `materialize` only touches categories that have a plan,
/// so by the time it runs this category is invisible to it and its twelve
/// rows would survive the clearing that was supposed to remove them. Found by
/// the test, which is the only reason it is not still true.
pub fn clear_plan(conn: &Conn, category_id: &str, year: i32) -> Result<(), String> {
    atomically(conn, || {
        conn.execute(
            "DELETE FROM budget_plans WHERE category_id = ?1 AND year = ?2",
            params![category_id, year],
        )
        .map_err(err)?;
        conn.execute(
            "DELETE FROM budgets WHERE category_id = ?1 AND month_year LIKE ?2",
            params![category_id, format!("{year:04}-%")],
        )
        .map_err(err)?;
        // Z2. Clearing a child ran no envelope check at all, so a parent
        // the child had pushed up stayed there until something else was typed.
        // The parent comes back down to what the user asked for, or goes if they never
        // asked and nothing else is claiming.
        raise_parent(conn, category_id, year)?;
        materialize(conn, year)?;
        Ok(())
    })
}

/// Rewrite `budgets` for one year from the plans.
///
/// Only rows for categories that HAVE a plan are touched: a budget somebody
/// set by hand on a category with no plan is left exactly where it is, so
/// this can go in before every screen has moved over.
///
/// Income plans are deliberately not materialized — see the module header.
pub fn materialize(conn: &Conn, year: i32) -> Result<u32, String> {
    let like = format!("{year:04}-%");
    conn.execute(
        "DELETE FROM budgets
          WHERE month_year LIKE ?1
            AND category_id IN (SELECT category_id FROM budget_plans WHERE year = ?2)",
        params![like, year],
    )
    .map_err(err)?;

    let plans: Vec<(String, i64, String, String, Option<i64>)> = conn
        .prepare(
            "SELECT p.category_id, p.annual_cents, p.months, p.spread, p.asked_for_cents
               FROM budget_plans p
               JOIN categories c ON c.id = p.category_id
              WHERE p.year = ?1 AND c.kind = 'expense'",
        )
        .map_err(err)?
        .query_map(params![year], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
        .map_err(err)?
        .collect::<Result<_, _>>()
        .map_err(err)?;

    let mut written = 0u32;
    for (category_id, annual, months, spread, asked_for) in plans {
        let per = monthly_of(annual, &months, &spread);
        // The month row carries what the PLAN says was asked for, in
        // the month's terms. Written without it, every materialized row read
        // as an envelope nobody asked for, and the month-level rule
        // treated a plan's parent that way: delete a child's budget row for
        // one month and `delete_budget` deleted the parent's row too, though
        // the plan above it said Bills was $1,000 on purpose. A parent the
        // plan itself only seeded (`asked_for_cents` NULL) stays NULL
        // here, so it still goes when nothing claims it.
        let asked = asked_for.map(|a| monthly_of(a, &months, &spread));
        for m in 1..=12u32 {
            // An ASIDE line materializes TWELVE equal rows, because
            // the twelfth is what you set aside each month and the mask is
            // only saying where the bill lands. `budgets` therefore looks
            // exactly as it would for `every month`, which is what keeps the
            // spending tracker, the reports and the month screen from ever
            // needing to know this reading exists.
            if spread != ASIDE && !is_set(&months, m) {
                continue;
            }
            conn.execute(
                "INSERT INTO budgets (id, category_id, target_cents, month_year, period, asked_for_cents)
                 VALUES (?1, ?2, ?3, ?4, 'monthly', ?5)
                 ON CONFLICT (category_id, month_year)
                 DO UPDATE SET target_cents = excluded.target_cents, period = 'monthly',
                               asked_for_cents = excluded.asked_for_cents",
                params![
                    Uuid::new_v4().to_string(),
                    category_id,
                    per,
                    format!("{year:04}-{m:02}"),
                    asked
                ],
            )
            .map_err(err)?;
            written += 1;
        }
    }
    Ok(written)
}

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

/// Every category's own money, by month, for one year: (category, month) ->
/// (money out, money in). Both directions are read once and each line picks
/// the one its kind cares about — an expense category that received a refund
/// should not have that netted against its spending without saying so.
fn month_sums(conn: &Conn, year: i32) -> Result<HashMap<(String, u32), (i64, i64)>, String> {
    crate::db::queries::require_rates(conn)?;
    let sql = format!(
        "{CATEGORY_LINES}
         SELECT category_id,
                CAST(substr(date, 6, 2) AS INTEGER) AS m,
                SUM(CASE WHEN amount_cents < 0 THEN -amount_cents ELSE 0 END),
                SUM(CASE WHEN amount_cents > 0 THEN amount_cents ELSE 0 END)
           FROM lines
          WHERE substr(date, 1, 4) = ?1 AND category_id IS NOT NULL
          GROUP BY category_id, m"
    );
    let mut st = conn.prepare(&sql).map_err(err)?;
    let rows = st
        .query_map(params![format!("{year:04}")], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)? as u32,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
            ))
        })
        .map_err(err)?;
    let mut out = HashMap::new();
    for row in rows {
        let (cat, m, spent, got) = row.map_err(err)?;
        if (1..=12).contains(&m) {
            out.insert((cat, m), (spent, got));
        }
    }
    Ok(out)
}

struct Cat {
    id: String,
    name: String,
    full_name: String,
    parent_id: Option<String>,
    kind: String,
}

fn categories(conn: &Conn) -> Result<Vec<Cat>, String> {
    let mut st = conn
        .prepare(
            "SELECT c.id, c.name,
                    CASE WHEN c.parent_id IS NULL THEN c.name ELSE p.name || ' : ' || c.name END,
                    c.parent_id, c.kind
               FROM categories c
               LEFT JOIN categories p ON p.id = c.parent_id
              ORDER BY COALESCE(p.name, c.name) COLLATE NOCASE,
                       (c.parent_id IS NOT NULL),
                       c.name COLLATE NOCASE",
        )
        .map_err(err)?;
    let rows = st
        .query_map([], |r| {
            Ok(Cat {
                id: r.get(0)?,
                name: r.get(1)?,
                full_name: r.get(2)?,
                parent_id: r.get(3)?,
                kind: r.get(4)?,
            })
        })
        .map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

/// How many of the twelve columns mean anything.
fn elapsed(year: i32, today: &str) -> u32 {
    let this_year: i32 = today.get(0..4).and_then(|s| s.parse().ok()).unwrap_or(year);
    let this_month: u32 = today.get(5..7).and_then(|s| s.parse().ok()).unwrap_or(12);
    if year < this_year {
        12
    } else if year > this_year {
        0
    } else {
        this_month.clamp(0, 12)
    }
}

fn one_line(
    cat: &Cat,
    plan: Option<&Plan>,
    kids: &[&Cat],
    sums: &HashMap<(String, u32), (i64, i64)>,
    months_elapsed: u32,
    parent_planned: bool,
) -> PlanLine {
    let income = cat.kind == "income";
    let months = plan.map(|p| p.months.clone()).unwrap_or_else(|| EVERY_MONTH.to_string());
    let spread = plan.map(|p| p.spread.clone()).unwrap_or_else(|| SPENT.to_string());
    let annual = plan.map(|p| p.annual_cents).unwrap_or(0);
    let per = monthly_of(annual, &months, &spread);
    let aside = spread == ASIDE;

    let mut actual = vec![0i64; 12];
    for m in 1..=12u32 {
        let pick = |c: &String| -> i64 {
            sums.get(&(c.clone(), m))
                .map(|(out, inn)| if income { *inn } else { *out })
                .unwrap_or(0)
        };
        let mut v = pick(&cat.id);
        for k in kids {
            v += pick(&k.id);
        }
        actual[(m - 1) as usize] = v;
    }

    let actual_to_date: i64 = (1..=months_elapsed)
        .map(|m| actual[(m - 1) as usize])
        .sum();
    // An ASIDE line expects its twelfth in EVERY elapsed month:
    // what it is owed by now is what should have been set aside by now, and
    // that accrues whether or not the bill has landed yet. A SPENT line
    // counts only the months it runs in, as it always has.
    let expected_to_date: i64 = (1..=months_elapsed)
        .filter(|m| aside || is_set(&months, *m))
        .map(|_| per)
        .sum();
    let variance = if income {
        actual_to_date - expected_to_date
    } else {
        expected_to_date - actual_to_date
    };

    PlanLine {
        category_id: cat.id.clone(),
        name: cat.name.clone(),
        full_name: cat.full_name.clone(),
        parent_id: cat.parent_id.clone(),
        kind: cat.kind.clone(),
        has_plan: plan.is_some(),
        annual_cents: annual,
        monthly_cents: per,
        months_label: months_label(&months),
        payment_cents: payment_of(annual, &months, &spread),
        spread,
        months,
        actual_cents: actual,
        actual_to_date,
        expected_to_date,
        variance_cents: variance,
        counts_in_total: plan.is_some() && !parent_planned,
    }
}

fn totals(lines: &[PlanLine], income: bool) -> PlanTotals {
    let mut months = vec![0i64; 12];
    let (mut annual, mut monthly, mut got, mut exp) = (0i64, 0i64, 0i64, 0i64);
    for l in lines.iter().filter(|l| l.counts_in_total) {
        annual += l.annual_cents;
        monthly += l.monthly_cents;
        got += l.actual_to_date;
        exp += l.expected_to_date;
        for m in 0..12 {
            months[m] += l.actual_cents[m];
        }
    }
    PlanTotals {
        annual_cents: annual,
        monthly_cents: monthly,
        actual_cents: months,
        actual_to_date: got,
        expected_to_date: exp,
        variance_cents: if income { got - exp } else { exp - got },
    }
}

/// The whole screen in one answer.
///
/// `today` is passed in rather than read from the clock so a test can stand
/// in the middle of a year — the elapsed-month count is what every "so far"
/// figure on the screen is measured against, and a function that reads the
/// clock cannot be tested at all.
pub fn year_plan(conn: &Conn, year: i32, today: &str) -> Result<YearPlan, String> {
    let months_elapsed = elapsed(year, today);
    let sums = month_sums(conn, year)?;
    let cats = categories(conn)?;

    let mut plans: HashMap<String, Plan> = HashMap::new();
    let mut st = conn
        .prepare(
            "SELECT category_id, annual_cents, months, spread, asked_for_cents
               FROM budget_plans WHERE year = ?1",
        )
        .map_err(err)?;
    let rows = st
        .query_map(params![year], |r| {
            Ok((
                r.get::<_, String>(0)?,
                Plan {
                    annual_cents: r.get(1)?,
                    months: r.get(2)?,
                    spread: r.get(3)?,
                    asked_for: r.get(4)?,
                },
            ))
        })
        .map_err(err)?;
    for row in rows {
        let (id, p) = row.map_err(err)?;
        plans.insert(id, p);
    }

    let mut income = Vec::new();
    let mut expenses = Vec::new();
    for cat in &cats {
        let kids: Vec<&Cat> = cats
            .iter()
            .filter(|k| k.parent_id.as_deref() == Some(cat.id.as_str()))
            .collect();
        let parent_planned = cat
            .parent_id
            .as_ref()
            .map(|p| plans.contains_key(p))
            .unwrap_or(false);
        let line = one_line(
            cat,
            plans.get(&cat.id),
            &kids,
            &sums,
            months_elapsed,
            parent_planned,
        );
        if cat.kind == "income" {
            income.push(line);
        } else {
            expenses.push(line);
        }
    }

    let income_total = totals(&income, true);
    let expense_total = totals(&expenses, false);
    let net = PlanTotals {
        annual_cents: income_total.annual_cents - expense_total.annual_cents,
        monthly_cents: income_total.monthly_cents - expense_total.monthly_cents,
        actual_cents: (0..12)
            .map(|m| income_total.actual_cents[m] - expense_total.actual_cents[m])
            .collect(),
        actual_to_date: income_total.actual_to_date - expense_total.actual_to_date,
        expected_to_date: income_total.expected_to_date - expense_total.expected_to_date,
        variance_cents: (income_total.actual_to_date - expense_total.actual_to_date)
            - (income_total.expected_to_date - expense_total.expected_to_date),
    };

    Ok(YearPlan {
        year,
        months_elapsed,
        planned_lines: (income.iter().chain(expenses.iter()))
            .filter(|l| l.has_plan)
            .count() as u32,
        income,
        expenses,
        income_total,
        expense_total,
        net,
    })
}

// ---------------------------------------------------------------------------
// Building next year from what this year did
// ---------------------------------------------------------------------------

/// Up to the next whole ten dollars. Not `next_ten_above`, which is strictly
/// above: a category that spent exactly $600.00 should be proposed at $600,
/// and the envelope rule adds its own headroom later if children need it.
fn ceil_ten(cents: i64) -> i64 {
    if cents <= 0 {
        return 0;
    }
    ((cents + 999) / 1_000) * 1_000
}

/// Down to the whole ten below. Income rounds DOWN and expenses UP, so both
/// err on the side of the plan being survivable: a year that assumes slightly
/// less coming in and slightly more going out is one that holds.
fn floor_ten(cents: i64) -> i64 {
    if cents <= 0 {
        return 0;
    }
    (cents / 1_000) * 1_000
}

/// How many months of `year` have anything to say — twelve for a year that is
/// over, the current month for the one we are in, none for a future one.
fn observed(year: i32, today: &str) -> u32 {
    elapsed(year, today)
}

/// Read one year and propose the next.
///
/// The question: if a job ended partway through the year and the new year is
/// built from history, can that job be marked as gone, and how?
///
/// The answer is that the screen should already know. A line that ran January
/// to October and then went silent is proposed with its tick box OFF and a
/// note saying when it stopped; a twelfth of ten months of pay is a plausible
/// figure for income that will never arrive, and plausible is the dangerous
/// kind of wrong.
///
/// THE TRAP, and the reason this is not just "no money lately". A once-a-year
/// bill looks exactly like an ended job: home insurance paid in January is
/// silent for eleven months. The distinguisher is the line's own spread — a
/// mask that says *January only* means the quiet is expected, so such a line
/// is never flagged as finished. Only a line that ran in most of the months
/// it was SUPPOSED to run and then stopped counts.
///
/// The mirror case is the more dangerous one because nothing about it looks
/// wrong: a job that started in September, divided by twelve, proposes about
/// a third of what it pays. Those are annualized from the months they
/// actually ran, and the row shows both figures rather than asserting one.
///
/// Nothing here writes. `apply_proposals` does that, and only to the lines
/// that come back ticked.
pub fn from_history(
    conn: &Conn,
    from_year: i32,
    to_year: i32,
    today: &str,
) -> Result<Vec<crate::models::PlanProposal>, String> {
    let end = observed(from_year, today);
    if end == 0 {
        return Ok(Vec::new());
    }
    let sums = month_sums(conn, from_year)?;
    let cats = categories(conn)?;

    let mut from_plans: HashMap<String, Plan> = HashMap::new();
    let mut st = conn
        .prepare(
            "SELECT category_id, annual_cents, months, spread, asked_for_cents
               FROM budget_plans WHERE year = ?1",
        )
        .map_err(err)?;
    for row in st
        .query_map(params![from_year], |r| {
            Ok((
                r.get::<_, String>(0)?,
                Plan {
                    annual_cents: r.get(1)?,
                    months: r.get(2)?,
                    spread: r.get(3)?,
                    asked_for: r.get(4)?,
                },
            ))
        })
        .map_err(err)?
    {
        let (id, p) = row.map_err(err)?;
        from_plans.insert(id, p);
    }
    let mut to_plans: HashMap<String, i64> = HashMap::new();
    let mut st = conn
        .prepare("SELECT category_id, annual_cents FROM budget_plans WHERE year = ?1")
        .map_err(err)?;
    for row in st
        .query_map(params![to_year], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(err)?
    {
        let (id, a) = row.map_err(err)?;
        to_plans.insert(id, a);
    }

    let mut out = Vec::new();
    for cat in &cats {
        let income = cat.kind == "income";
        // A parent's own proposal counts only its OWN transactions: its
        // children are proposed in their own right, and the envelope rule
        // lifts the parent afterwards. Rolling children in here would propose
        // the same money twice.
        let mut by_month = [0i64; 12];
        for m in 1..=end {
            by_month[(m - 1) as usize] = sums
                .get(&(cat.id.clone(), m))
                .map(|(out_c, in_c)| if income { *in_c } else { *out_c })
                .unwrap_or(0);
        }
        let total: i64 = by_month.iter().sum();
        if total == 0 {
            continue; // Nothing to go on. A blank row is not a proposal.
        }
        let active: Vec<u32> = (1..=end).filter(|m| by_month[(*m - 1) as usize] != 0).collect();
        let first = *active.first().unwrap();
        let last = *active.last().unwrap();

        let months = from_plans
            .get(&cat.id)
            .map(|p| p.months.clone())
            .unwrap_or_else(|| EVERY_MONTH.to_string());
        // And how the mask reads. Carrying the mask without its
        // spread turned a set-aside line into a spent one: home
        // insurance due in January came back as $1,200 a month, spent in
        // January only. No plan to carry from is SPENT, as ever — a year read
        // from the register is a year of spending.
        let spread = from_plans
            .get(&cat.id)
            .map(|p| p.spread.clone())
            .filter(|s| valid_spread(s))
            .unwrap_or_else(|| SPENT.to_string());
        let divisor = spread_count(&months, &spread);
        let runs_all = month_count(&months) >= 10;

        // The ordinary figure: the year's money over the months observed.
        let plain_monthly = total / end as i64;

        // Enough of the year has to have happened for "it stopped" or "it
        // started" to mean anything at all. In March, everything is ordinary.
        let judgeable = end >= 6;
        let quiet_tail = (last + 1..=end)
            .filter(|m| is_set(&months, *m))
            .count() as u32;

        let (basis, note, monthly, include) = if judgeable
            && runs_all
            && active.len() >= 5
            && quiet_tail >= 2
        {
            (
                "ended",
                format!("nothing since {}", MONTH_NAMES[(last - 1) as usize]),
                plain_monthly,
                false,
            )
        } else if judgeable && runs_all && first >= 7 && last == end && active.len() < 6 {
            // Started in the second half and still running: annualize from the
            // months it actually ran.
            let running = total / active.len() as i64;
            (
                "running",
                format!(
                    "started in {} — this is its rate over {} month{}, not a twelfth of the year",
                    MONTH_NAMES[(first - 1) as usize],
                    active.len(),
                    if active.len() == 1 { "" } else { "s" }
                ),
                running,
                true,
            )
        } else {
            (
                "twelve",
                if end < 12 {
                    format!("{end} months of {from_year} so far")
                } else {
                    format!("all of {from_year}")
                },
                plain_monthly,
                true,
            )
        };

        // A line spread over some months is proposed per RUNNING month, not
        // per calendar month: heating oil's $900 is $180 in each of five, and
        // dividing by twelve here would undo the whole point of spreading it.
        //
        // "running" is the spread's divisor, not the mask's count: an
        // ASIDE line is set aside in all twelve months, so its twelfth
        // is already the figure.
        let per_running = if divisor == 12 { monthly } else { monthly * 12 / divisor };
        let suggested_monthly = if income { floor_ten(per_running) } else { ceil_ten(per_running) };
        let suggested_annual = suggested_monthly * divisor;

        out.push(crate::models::PlanProposal {
            category_id: cat.id.clone(),
            name: cat.name.clone(),
            full_name: cat.full_name.clone(),
            parent_id: cat.parent_id.clone(),
            kind: cat.kind.clone(),
            actual_cents: total,
            active_months: active.len() as u32,
            first_month: first,
            last_month: last,
            basis: basis.to_string(),
            note,
            plain_monthly_cents: plain_monthly,
            suggested_monthly_cents: suggested_monthly,
            suggested_annual_cents: suggested_annual,
            months_label: months_label(&months),
            months,
            spread,
            include,
            existing_annual_cents: to_plans.get(&cat.id).copied(),
        });
    }
    Ok(out)
}

/// Write the accepted proposals, and rebuild the year's monthly rows
/// once at the end rather than once per line.
///
/// The envelope rule runs per line as usual, so a parent still ends up above
/// its children whatever order the lines arrive in.
pub fn apply_proposals(
    conn: &Conn,
    year: i32,
    picks: &[(String, i64, String, String)],
) -> Result<u32, String> {
    // Every pick or none. A refusal on the fifth line used to leave
    // the first four written and the year's monthly rows never rebuilt.
    atomically(conn, || {
        let mut n = 0u32;
        for (category_id, annual_cents, months, spread) in picks {
            if *annual_cents < 0
                || !valid_mask(months)
                || !valid_spread(spread)
                || month_count(months) == 0
            {
                return Err(format!("{category_id:?} cannot be planned that way"));
            }
            // A proposal the user ticked is a figure they asked for.
            conn.execute(
                "INSERT INTO budget_plans (id, category_id, year, annual_cents, months, spread, asked_for_cents)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?4)
                 ON CONFLICT (category_id, year)
                 DO UPDATE SET annual_cents = excluded.annual_cents,
                               months = excluded.months,
                               spread = excluded.spread,
                               asked_for_cents = excluded.annual_cents,
                               updated_at = datetime('now')",
                params![Uuid::new_v4().to_string(), category_id, year, annual_cents, months, spread],
            )
            .map_err(err)?;
            enforce_envelope(conn, category_id, year)?;
            n += 1;
        }
        materialize(conn, year)?;
        Ok(n)
    })
}

/// Fold `from_id`'s year plans into `into_id`'s, for a category merge
/// or a delete that reassigns. Returns the years touched, for
/// `settle_after_fold`.
///
/// `budget_plans` is `UNIQUE (category_id, year)` and `ON DELETE CASCADE`,
/// and neither merge nor delete knew it existed: the source's year plan was
/// cascaded away with the category, and the destination's monthly rows went
/// on reading the destination's old figure. A year only the source planned is
/// re-pointed. A year both planned becomes one line, by this rule:
///
/// - `annual_cents` — the SUM. Both are annual figures whatever their masks
///   or spreads, so adding them is honest in a way adding two monthly figures
///   spread over different months is not.
/// - `months` — the UNION. Money spent (or due) in either line's months is
///   now spent (or due) in this one's; the intersection would squeeze the
///   source's money into months it never ran in.
/// - `spread` — the DESTINATION's. It is the line being kept and its reading
///   is the one the user chose for it; an ASIDE source folded into a SPENT line is
///   read as spent across the union of their months.
/// - `asked_for_cents` — the sum of the figures that were asked for, NULL
///   only when neither was. An envelope nobody asked for plus one the user
///   did is their figure, and the envelope rule then keeps the line at the
///   larger of that and what its children claim.
pub(crate) fn fold_plans(conn: &Conn, from_id: &str, into_id: &str) -> Result<Vec<i32>, String> {
    let rows: Vec<(String, i32, i64, String, Option<i64>)> = conn
        .prepare("SELECT id, year, annual_cents, months, asked_for_cents FROM budget_plans WHERE category_id = ?1 ORDER BY year")
        .map_err(err)?
        .query_map(params![from_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
        .map_err(err)?
        .collect::<Result<_, _>>()
        .map_err(err)?;
    let mut years = Vec::with_capacity(rows.len());
    for (id, year, annual, months, asked) in rows {
        years.push(year);
        let Some(dest) = plan_of(conn, into_id, year)? else {
            conn.execute("UPDATE budget_plans SET category_id = ?2 WHERE id = ?1", params![id, into_id])
                .map_err(err)?;
            continue;
        };
        let union: String = if valid_mask(&months) && valid_mask(&dest.months) {
            months
                .bytes()
                .zip(dest.months.bytes())
                .map(|(a, b)| if a == b'1' || b == b'1' { '1' } else { '0' })
                .collect()
        } else {
            EVERY_MONTH.to_string()
        };
        let asked_for = match (dest.asked_for, asked) {
            (None, None) => None,
            (a, b) => Some(a.unwrap_or(0) + b.unwrap_or(0)),
        };
        conn.execute(
            "UPDATE budget_plans
                SET annual_cents = ?3, months = ?4, asked_for_cents = ?5, updated_at = datetime('now')
              WHERE category_id = ?1 AND year = ?2",
            params![into_id, year, dest.annual_cents + annual, union, asked_for],
        )
        .map_err(err)?;
        conn.execute("DELETE FROM budget_plans WHERE id = ?1", params![id]).map_err(err)?;
    }
    Ok(years)
}

/// After a fold, keep the envelope rule true for the lines it moved
/// money between, and rebuild the year's monthly rows from the plans.
/// `category_ids` that no longer exist are skipped.
pub(crate) fn settle_after_fold(conn: &Conn, category_ids: &[String], year: i32) -> Result<(), String> {
    for id in category_ids {
        let exists: bool = conn
            .query_row("SELECT EXISTS(SELECT 1 FROM categories WHERE id = ?1)", params![id], |r| r.get(0))
            .map_err(err)?;
        if exists {
            enforce_envelope(conn, id, year)?;
        }
    }
    materialize(conn, year)?;
    Ok(())
}

/// One line on its own, for the answer a write hands back.
///
/// Read as if the year were over, so the line that comes back carries the
/// whole year's figures rather than a "so far" that depends on when the
/// button was pressed. The screen reloads the grid after a write anyway; this
/// is for the sentence a write gets to say about itself.
fn line_of(conn: &Conn, category_id: &str, year: i32) -> Result<PlanLine, String> {
    let plan = year_plan(conn, year, &format!("{:04}-12-31", year + 1))?;
    plan.income
        .into_iter()
        .chain(plan.expenses.into_iter())
        .find(|l| l.category_id == category_id)
        .ok_or_else(|| "category not found".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::queries;

    // Checked whole when the test ends.
    use crate::db::test_db::EmptyChartDb as TestDb;

    fn cat(c: &Conn, name: &str, kind: &str, parent: Option<&str>) -> String {
        queries::create_category(c, name, kind, parent, None).unwrap().id
    }

    fn account(c: &Conn, name: &str) -> String {
        queries::create_account(c, name, "checking", 0, Some("2026-01-01"))
            .unwrap()
            .id
    }

    /// A categorized transaction. Negative is money out, positive is money
    /// in, exactly as the register stores it.
    fn spend(c: &Conn, acct: &str, date: &str, category: &str, cents: i64) {
        queries::create_transaction(c, acct, date, "x", Some(category), cents, None, None).unwrap();
    }

    fn line<'a>(p: &'a YearPlan, id: &str) -> &'a PlanLine {
        p.income
            .iter()
            .chain(p.expenses.iter())
            .find(|l| l.category_id == id)
            .expect("line")
    }

    /// The rounding, on its own, against a few bills.
    ///
    /// > *"To me that should say $90 (1000 divided by 12 then raised up to
    /// >  the next whole $10)."*
    #[test]
    fn a_monthly_figure_is_rounded_up_to_something_you_can_hold_in_your_head() {
        // A $1,000 annual bill: $83.33 a month.
        assert_eq!(round_up_monthly(8_333), 9_000, "$83.33 -> $90");
        // And a figure a little further from its ten: $1,000 over three months.
        assert_eq!(round_up_monthly(33_333), 34_000, "$333.33 -> $340");

        // A figure already on a whole ten does not move.
        assert_eq!(round_up_monthly(10_000), 10_000, "$100 stays $100");
        assert_eq!(round_up_monthly(2_000), 2_000, "$20 stays $20");

        // THE REASON THIS IS NOT `ceil_ten`. Three small yearly subscriptions
        // ($120, $100, $60). Rounded flat to the next ten they are ALL $10 a
        // month, which is not a rounding, it is three bills losing their
        // identity.
        assert_eq!(round_up_monthly(1_000), 1_000, "$120/yr = $10");
        assert_eq!(round_up_monthly(833), 900, "$100/yr = $8.33 -> $9, not $10");
        assert_eq!(round_up_monthly(500), 500, "$60/yr = $5, not $10");

        // The boundary: a ten is taken when it costs a tenth or less, and a
        // whole dollar otherwise. Nothing rounds by more than 10%.
        assert_eq!(round_up_monthly(9_100), 10_000, "$91 -> $100 is under a tenth");
        assert_eq!(round_up_monthly(1_210), 1_300, "$12.10 -> $13, because $20 is 65% more");

        // Small and zero are left alone rather than invented.
        assert_eq!(round_up_monthly(500), 500, "$5 stays $5");
        assert_eq!(round_up_monthly(0), 0);
        assert_eq!(round_up_monthly(-1), 0);
    }

    /// The question a user asked: when the real payment hits, the
    /// monthly amount is still being set aside, so how is that accounted
    /// for?
    ///
    /// There is, and it was already there. On a set-aside line
    /// `expected_to_date - actual_to_date` is not a variance at all — it is
    /// **what you have put by and not yet spent**, because the expected side
    /// accrues every elapsed month (including the month a bill lands) and the
    /// actual side is the payments.
    ///
    /// This test exists because the review said the opposite. Asked
    /// whether $90 a month covers $1,000 paid in July and December, it reset
    /// the accrual to zero at each payment, counted Aug-Nov only, and reported
    /// December **$140 short**. Both halves of that were wrong: July keeps
    /// saving, December keeps saving, and the surplus from the first payment
    /// carries. The balance never goes negative. Walked month by month below,
    /// because "it works out" is exactly the sort of claim that should not be
    /// taken on trust twice.
    #[test]
    fn what_is_put_by_survives_the_payment_that_spends_it() {
        let db = TestDb::new("aside-balance");
        let c = db.conn();
        let acct = account(&c, "Checking");
        let ins = cat(&c, "Auto insurance", "expense", None);

        // $1,000 a year, paid in July and December: $90 a month, $500 a
        // payment.
        set_plan(&c, &ins, 2027, 100_000, "000000100001", ASIDE).unwrap();
        let p0 = year_plan(&c, 2027, "2027-01-31").unwrap();
        let l = line(&p0, &ins);
        assert_eq!(l.monthly_cents, 9_000);
        assert_eq!(l.payment_cents, 50_000);

        spend(&c, &acct, "2027-07-14", &ins, -50_000);
        spend(&c, &acct, "2027-12-14", &ins, -50_000);

        // Month by month, `variance_cents` IS the running balance.
        let put_by = |today: &str| {
            let p = year_plan(&c, 2027, today).unwrap();
            line(&p, &ins).variance_cents
        };
        assert_eq!(put_by("2027-01-31"), 9_000, "Jan: one month in");
        assert_eq!(put_by("2027-06-30"), 54_000, "Jun: $540 against a $500 bill");
        // July: the bill takes $500 AND the month still puts $90 by.
        assert_eq!(put_by("2027-07-31"), 13_000, "Jul: 630 saved less 500 paid");
        assert_eq!(put_by("2027-11-30"), 49_000, "Nov: four more months on top");
        // December: the second bill, and the year closes with the rounding
        // surplus -- 12 x 90 is 1,080 against 1,000 of bills.
        assert_eq!(put_by("2027-12-31"), 8_000, "Dec: $80 left, which is the round-up");

        // THE CLAIM THAT MATTERS: it is never short. The review said it would
        // be $140 down in December.
        for (m, day) in [
            (1, "2027-01-31"), (2, "2027-02-28"), (3, "2027-03-31"),
            (4, "2027-04-30"), (5, "2027-05-31"), (6, "2027-06-30"),
            (7, "2027-07-31"), (8, "2027-08-31"), (9, "2027-09-30"),
            (10, "2027-10-31"), (11, "2027-11-30"), (12, "2027-12-31"),
        ] {
            assert!(put_by(day) >= 0, "month {m}: went short by {}", -put_by(day));
        }
    }

    /// The case that IS short, so the figure is not mistaken for a
    /// guarantee: a bill due in January of the first year you plan it has
    /// nothing behind it yet.
    ///
    /// That is true in life, not a fault in the arithmetic — the money would
    /// have been put by during the previous year — but it means a negative
    /// figure here is normal early on and must not read as an error.
    #[test]
    fn a_bill_due_before_anything_was_saved_reads_short_and_should() {
        let db = TestDb::new("aside-short");
        let c = db.conn();
        let acct = account(&c, "Checking");
        let ins = cat(&c, "Home insurance", "expense", None);
        set_plan(&c, &ins, 2027, 120_000, "100000000000", ASIDE).unwrap();
        spend(&c, &acct, "2027-01-09", &ins, -120_000);

        let p1 = year_plan(&c, 2027, "2027-01-31").unwrap();
        let l = line(&p1, &ins);
        assert_eq!(l.monthly_cents, 10_000);
        assert_eq!(l.variance_cents, -110_000, "one month put by against the whole bill");

        // And it climbs back out over the year, to the rounding surplus.
        let p2 = year_plan(&c, 2027, "2027-12-31").unwrap();
        let l = line(&p2, &ins);
        assert_eq!(l.variance_cents, 0, "$1,200 put by, $1,200 paid");
    }

    /// And it reaches the materialized rows, because the monthly
    /// figure is what the user actually puts by. The month screen says $90.
    #[test]
    fn the_rounded_figure_is_what_gets_materialized() {
        let db = TestDb::new("round-materialize");
        let c = db.conn();
        let ins = cat(&c, "Auto insurance", "expense", None);
        // $1,000 a year, paid in two months, set aside monthly.
        set_plan(&c, &ins, 2027, 100_000, "000000100001", ASIDE).unwrap();

        let rows: Vec<i64> = c
            .prepare("SELECT target_cents FROM budgets WHERE category_id = ?1")
            .unwrap()
            .query_map(params![ins], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(rows.len(), 12);
        assert!(rows.iter().all(|c| *c == 9_000), "twelve months of $90");

        // The bill itself is NOT rounded: $1,000 over two payments is $500
        // each, and that is what actually leaves the account.
        let p = year_plan(&c, 2027, "2027-12-31").unwrap();
        let l = line(&p, &ins);
        assert_eq!(l.monthly_cents, 9_000);
        assert_eq!(l.payment_cents, 50_000, "$500 a payment, unrounded");
        assert_eq!(l.annual_cents, 100_000, "and the year is still the bill, not 12 x 90");
    }

    /// The mask is the whole trick, so it gets tested on its own before
    /// anything touches the database.
    #[test]
    fn a_line_is_divided_by_the_months_it_runs_not_by_twelve() {
        assert_eq!(monthly_of(120_000, EVERY_MONTH, SPENT), 10_000);
        // Heating oil: $900 over three months is $300 in each of them.
        assert_eq!(monthly_of(90_000, "100000000011", SPENT), 30_000);
        assert_eq!(month_count("100000000011"), 3);
        assert_eq!(monthly_of(90_000, "111110000000", SPENT), 18_000);
        // Rounded UP to a figure a person can hold in their head.
        // $1,000 over three months is 333.33, which the user would call $340.
        assert_eq!(monthly_of(100_000, "111000000000", SPENT), 34_000);
        assert_eq!(monthly_of(0, EVERY_MONTH, SPENT), 0);

        // A malformed mask reads as every month. A line that appears
        // everywhere is a visible bug; one that vanishes is not.
        assert_eq!(month_count("nonsense"), 12);
        assert!(is_set("nonsense", 7));

        assert_eq!(months_label(EVERY_MONTH), "every month");
        assert_eq!(months_label("111110000000"), "Jan\u{2013}May");
        // A winter that wraps the year end is ONE run, not two fragments.
        assert_eq!(months_label("111000000011"), "Nov\u{2013}Mar");
        assert_eq!(months_label("100100100100"), "Jan, Apr, Jul, Oct");
        assert_eq!(months_label("100000000000"), "Jan");
        assert_eq!(months_label("000000000000"), "no months");
    }

    #[test]
    fn a_year_plan_is_set_once_and_read_twelve_times() {
        let db = TestDb::new("year");
        let c = db.conn();
        let acct = account(&c, "Checking");
        let food = cat(&c, "Food", "expense", None);

        set_plan(&c, &food, 2027, 1_200_000, EVERY_MONTH, SPENT).unwrap();
        spend(&c, &acct, "2027-01-14", &food, -95_000);
        spend(&c, &acct, "2027-02-14", &food, -110_000);

        let p = year_plan(&c, 2027, "2027-03-15").unwrap();
        assert_eq!(p.months_elapsed, 3);
        let f = line(&p, &food);
        assert_eq!((f.annual_cents, f.monthly_cents), (1_200_000, 100_000));
        assert_eq!(f.months_label, "every month");
        assert_eq!(&f.actual_cents[0..3], &[95_000, 110_000, 0]);
        assert_eq!(f.actual_to_date, 205_000);
        assert_eq!(f.expected_to_date, 300_000, "three months of the plan");
        assert_eq!(f.variance_cents, 95_000, "under plan is positive on an expense");

        // A year that has not started has no elapsed months, and one that is
        // over has all twelve — the same plan, read from three vantage points.
        assert_eq!(year_plan(&c, 2027, "2026-06-01").unwrap().months_elapsed, 0);
        assert_eq!(year_plan(&c, 2027, "2028-01-01").unwrap().months_elapsed, 12);
        let done = year_plan(&c, 2027, "2028-01-01").unwrap();
        assert_eq!(line(&done, &food).expected_to_date, 1_200_000);
    }

    #[test]
    fn a_seasonal_line_expects_nothing_in_the_months_it_does_not_run() {
        let db = TestDb::new("seasonal");
        let c = db.conn();
        let acct = account(&c, "Checking");
        let oil = cat(&c, "Heating oil", "expense", None);

        // $900 over November to March: $180 in each of five months.
        set_plan(&c, &oil, 2027, 90_000, "111000000011", SPENT).unwrap();
        let p = year_plan(&c, 2027, "2027-07-15").unwrap();
        let l = line(&p, &oil);
        assert_eq!(l.monthly_cents, 18_000);
        assert_eq!(l.months_label, "Nov\u{2013}Mar");
        // Six months elapsed, but only three of them are heating months.
        assert_eq!(l.expected_to_date, 54_000, "Jan, Feb and Mar only");

        // Spending in a month the line does not run still shows up — it is
        // what happened — and counts against the year.
        spend(&c, &acct, "2027-07-04", &oil, -5_000);
        let p = year_plan(&c, 2027, "2027-07-15").unwrap();
        let l = line(&p, &oil);
        assert_eq!(l.actual_cents[6], 5_000);
        assert_eq!(l.variance_cents, 49_000);
    }

    #[test]
    fn income_and_expenses_meet_in_a_net_line() {
        let db = TestDb::new("net");
        let c = db.conn();
        let acct = account(&c, "Checking");
        let pension = cat(&c, "Pension", "income", None);
        let food = cat(&c, "Food", "expense", None);

        set_plan(&c, &pension, 2027, 3_600_000, EVERY_MONTH, SPENT).unwrap();
        set_plan(&c, &food, 2027, 1_200_000, EVERY_MONTH, SPENT).unwrap();
        spend(&c, &acct, "2027-01-02", &pension, 300_000);
        spend(&c, &acct, "2027-02-02", &pension, 320_000);
        spend(&c, &acct, "2027-01-14", &food, -95_000);
        spend(&c, &acct, "2027-02-14", &food, -110_000);

        let p = year_plan(&c, 2027, "2027-02-28").unwrap();
        assert_eq!(p.income.len(), 1);
        assert_eq!(p.expenses.len(), 1);
        assert_eq!(p.income_total.actual_to_date, 620_000);
        assert_eq!(p.expense_total.actual_to_date, 205_000);
        assert_eq!(p.net.annual_cents, 2_400_000);
        assert_eq!(p.net.monthly_cents, 200_000);
        assert_eq!(p.net.actual_to_date, 415_000);
        assert_eq!(&p.net.actual_cents[0..2], &[205_000, 210_000]);

        // Income above plan is the GOOD direction, and so is expense below
        // it: one sign convention, so the screen has one color rule. Two
        // months of a $1,000 plan is $2,000 and $2,050 went out, so food is
        // $50 over — negative, and the same color a light income month gets.
        assert_eq!(line(&p, &pension).variance_cents, 20_000);
        assert_eq!(line(&p, &food).variance_cents, -5_000);
    }

    /// The invariant above has two ways to stop being true, and only
    /// the child-edited one was ever checked.
    ///
    /// A parent row is editable on the year grid, and budgeting off parents
    /// is how the user says they work. Typing a figure into one that is BELOW what
    /// its children have already claimed used to be written exactly as
    /// typed: the envelope quietly stopped being an envelope, and nothing
    /// on the screen said so.
    /// The case per-month spreading alone could not describe.
    ///
    /// Home insurance: an amount is saved every month, but the bill is paid
    /// once a year, so the plan has to show both what to save monthly and the
    /// month the bill is due.
    ///
    /// Under SPENT, "due in January" means $1,200 expected in January and
    /// nothing the other eleven months — the opposite of what the user needs to
    /// see. Under ASIDE the same mask means $100 a month, all year, with
    /// January marked.
    #[test]
    fn an_aside_line_is_a_twelfth_every_month_and_names_the_month_it_is_due() {
        let db = TestDb::new("aside");
        let c = db.conn();
        let ins = cat(&c, "Home insurance", "expense", None);

        let w = set_plan(&c, &ins, 2027, 120_000, "100000000000", ASIDE).unwrap();
        assert_eq!(w.line.monthly_cents, 10_000, "$1,200 a year is $100 a MONTH, not $1,200 in January");
        assert_eq!(w.line.payment_cents, 120_000, "and the bill itself is $1,200");
        assert_eq!(w.line.months, "100000000000", "the mask still says WHEN it is due");
        assert_eq!(w.line.spread, ASIDE);

        // The same figures spread the SPENT way, for contrast: this is what
        // the user was getting, and why it was no use.
        let spent = cat(&c, "Heating oil", "expense", None);
        let w = set_plan(&c, &spent, 2027, 120_000, "100000000000", SPENT).unwrap();
        assert_eq!(w.line.monthly_cents, 120_000, "spent in one month IS that month's figure");
        assert_eq!(w.line.payment_cents, 0, "and there is no second number to show");
    }

    /// Two payments a year — the user's "Jan and Jul" — is still a twelfth a
    /// month, and each payment is half the year.
    #[test]
    fn an_aside_line_billed_twice_halves_the_payment_not_the_saving() {
        let db = TestDb::new("aside-twice");
        let c = db.conn();
        let ins = cat(&c, "Car insurance", "expense", None);

        let w = set_plan(&c, &ins, 2027, 120_000, "100000100000", ASIDE).unwrap();
        assert_eq!(w.line.monthly_cents, 10_000, "still $100 a month set aside");
        assert_eq!(w.line.payment_cents, 60_000, "but each of the two payments is $600");
    }

    /// The materialized rows are the whole reason this is cheap: an ASIDE
    /// line writes TWELVE equal `budgets` rows, exactly as "every month"
    /// would, so the month screen, the spending tracker and the reports never
    /// learn the reading exists. In March the month screen says "put $100
    /// by", which is the operational answer that was wanted.
    #[test]
    fn an_aside_line_materializes_twelve_rows_like_every_month_does() {
        let db = TestDb::new("aside-materialize");
        let c = db.conn();
        let ins = cat(&c, "Home insurance", "expense", None);
        set_plan(&c, &ins, 2027, 120_000, "100000000000", ASIDE).unwrap();

        let rows: Vec<(String, i64)> = c
            .prepare("SELECT month_year, target_cents FROM budgets WHERE category_id = ?1 ORDER BY month_year")
            .unwrap()
            .query_map(params![ins], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(rows.len(), 12, "twelve rows, not one");
        assert!(rows.iter().all(|(_, cents)| *cents == 10_000), "every one of them a twelfth");
        assert_eq!(rows[2].0, "2027-03", "including March, when nothing is billed");

        // And switching it back to SPENT narrows it to the one month again,
        // so the reading is not a one-way door.
        set_plan(&c, &ins, 2027, 120_000, "100000000000", SPENT).unwrap();
        let n: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM budgets WHERE category_id = ?1",
                params![ins],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "back to January only");
    }

    /// What is owed by now is what should have been SET ASIDE by now, and it
    /// accrues whether or not the bill has landed. The bill arriving in
    /// January is not eleven months of being ahead of plan.
    #[test]
    fn an_aside_line_is_owed_its_accrual_not_its_bill() {
        let db = TestDb::new("aside-expected");
        let c = db.conn();
        let acct = account(&c, "Checking");
        let ins = cat(&c, "Home insurance", "expense", None);
        set_plan(&c, &ins, 2027, 120_000, "100000000000", ASIDE).unwrap();
        spend(&c, &acct, "2027-01-09", &ins, -120_000);

        // End of March: three months' accrual is $300, and $1,200 has gone
        // out. Behind by $900, which is TRUE -- the pool is covering it.
        let p = year_plan(&c, 2027, "2027-03-31").unwrap();
        let l = line(&p, &ins);
        assert_eq!(l.expected_to_date, 30_000, "three months at $100");
        assert_eq!(l.actual_to_date, 120_000);
        assert_eq!(l.variance_cents, -90_000);

        // By December it has caught up exactly. That convergence is the point:
        // the year is right even though no single month was.
        let p = year_plan(&c, 2027, "2027-12-31").unwrap();
        let l = line(&p, &ins);
        assert_eq!(l.expected_to_date, 120_000);
        assert_eq!(l.variance_cents, 0, "a year of saving pays one year of bill");
    }

    /// An ASIDE child claims its TWELFTH of the parent's envelope, not its
    /// payment. Sizing a parent for a bill that arrives once a year would
    /// make the envelope ten times what the category actually needs monthly.
    #[test]
    fn an_aside_child_claims_its_twelfth_of_the_parent() {
        let db = TestDb::new("aside-envelope");
        let c = db.conn();
        let home = cat(&c, "Home", "expense", None);
        let ins = cat(&c, "Insurance", "expense", Some(&home));

        let w = set_plan(&c, &ins, 2027, 120_000, "100000000000", ASIDE).unwrap();
        let raised = w.raised.expect("the parent should have been given one");
        assert_eq!(
            raised.target_cents, 11_000,
            "$100 a month claimed -> a $110 envelope, not $1,210"
        );
    }

    /// A plan still refuses a mask with no months in ASIDE, and for a reason
    /// worth stating separately: without one, nothing on the screen could say
    /// when the bill lands, which is the only thing the mask is there for.
    #[test]
    fn an_aside_plan_still_needs_a_month_to_be_due_in() {
        let db = TestDb::new("aside-refuse");
        let c = db.conn();
        let ins = cat(&c, "Home insurance", "expense", None);
        assert!(set_plan(&c, &ins, 2027, 120_000, "000000000000", ASIDE).is_err());
        assert!(set_plan(&c, &ins, 2027, 120_000, EVERY_MONTH, "sideways").is_err());
    }

    #[test]
    fn typing_into_a_parent_below_its_children_raises_it_back() {
        let db = TestDb::new("envelope-parent");
        let c = db.conn();
        let auto = cat(&c, "Auto", "expense", None);
        let fuel = cat(&c, "Fuel", "expense", Some(&auto));
        let repairs = cat(&c, "Repairs", "expense", Some(&auto));

        // Two children claiming $500 a month between them put the parent at
        // the next whole ten above: $510.
        set_plan(&c, &fuel, 2027, 360_000, EVERY_MONTH, SPENT).unwrap();
        set_plan(&c, &repairs, 2027, 240_000, EVERY_MONTH, SPENT).unwrap();
        assert_eq!(line(&year_plan(&c, 2027, "2027-12-31").unwrap(), &auto).monthly_cents, 51_000);

        // Now type $200 a month straight into the parent. It cannot stand:
        // the children have claimed $500.
        let w = set_plan(&c, &auto, 2027, 240_000, EVERY_MONTH, SPENT).unwrap();
        let raised = w.raised.expect("the parent it just wrote should have been raised");
        assert_eq!(raised.category_id, auto);
        assert!(!raised.created, "it had a plan; it was raised, not created");
        assert_eq!(raised.target_cents, 51_000);
        assert_eq!(w.line.monthly_cents, 51_000, "the line handed back says the truth");

        // And it is the stored figure, not just the one reported.
        let p = year_plan(&c, 2027, "2027-12-31").unwrap();
        assert_eq!(line(&p, &auto).monthly_cents, 51_000);
        assert_eq!(line(&p, &auto).annual_cents, 612_000);
    }

    /// The other half: a parent typed ABOVE its children is left exactly as
    /// typed. The rule is a floor, not a target — raising one to $900 when
    /// the children claim $500 is a deliberate envelope with room in it.
    /// The year plan's twin of
    /// `a_parent_the_rule_raised_comes_back_down_when_its_children_do`.
    #[test]
    fn a_planned_parent_the_rule_raised_follows_its_children_down() {
        let db = TestDb::new("plan-lower");
        let c = db.conn();
        let bills = cat(&c, "Bills", "expense", None);
        let power = cat(&c, "Electricity", "expense", Some(&bills));
        let mtge = cat(&c, "Mortgage", "expense", Some(&bills));

        let monthly = |id: &str| -> i64 {
            let p = year_plan(&c, 2027, "2027-12-31").unwrap();
            line(&p, id).monthly_cents
        };

        set_plan(&c, &power, 2027, 720_000, EVERY_MONTH, SPENT).unwrap();
        assert_eq!(monthly(&power), 60_000);
        assert_eq!(monthly(&bills), 61_000, "$600 claimed -> $610");

        set_plan(&c, &mtge, 2027, 2_160_000, EVERY_MONTH, SPENT).unwrap();
        assert_eq!(monthly(&bills), 241_000, "$600 + $1,800 -> $2,410");

        // The mortgage was a mistake. The envelope must follow it back.
        set_plan(&c, &mtge, 2027, 0, EVERY_MONTH, SPENT).unwrap();
        assert_eq!(monthly(&bills), 61_000, "back to $610, not stuck at $2,410");

        // Electricity planned at ZERO is still a plan, and Bills shows
        // that zero rather than nothing (Z1)...
        set_plan(&c, &power, 2027, 0, EVERY_MONTH, SPENT).unwrap();
        let p = year_plan(&c, 2027, "2027-12-31").unwrap();
        assert!(line(&p, &bills).has_plan, "a child at zero gives its parent a zero");
        assert_eq!(monthly(&bills), 0);

        // ...and with both children CLEARED, an envelope NOBODY ASKED FOR
        // goes. Bills was seeded by the rule here — nobody typed
        // into it — so it has no figure to fall back to.
        clear_plan(&c, &power, 2027).unwrap();
        clear_plan(&c, &mtge, 2027).unwrap();
        let p = year_plan(&c, 2027, "2027-12-31").unwrap();
        assert!(!line(&p, &bills).has_plan, "nothing claimed, nothing asked for");
    }

    /// Z2: a parent the user typed zero into, a child that claims and is
    /// then EMPTIED. Clearing ran no envelope check, so the parent stayed at
    /// the raised figure until something else was typed into the child.
    #[test]
    fn clearing_a_child_brings_its_parent_back_down() {
        let db = TestDb::new("plan-clear-child");
        let c = db.conn();
        let bills = cat(&c, "Bills", "expense", None);
        let power = cat(&c, "Electricity", "expense", Some(&bills));
        let monthly = |id: &str| -> i64 {
            let p = year_plan(&c, 2027, "2027-12-31").unwrap();
            line(&p, id).monthly_cents
        };

        set_plan(&c, &bills, 2027, 0, EVERY_MONTH, SPENT).unwrap();
        set_plan(&c, &power, 2027, 720_000, EVERY_MONTH, SPENT).unwrap();
        assert_eq!(monthly(&bills), 61_000, "$600 claimed -> $610");

        clear_plan(&c, &power, 2027).unwrap();
        let p = year_plan(&c, 2027, "2027-12-31").unwrap();
        assert!(line(&p, &bills).has_plan, "the typed zero is what it settles back onto");
        assert_eq!(monthly(&bills), 0);

        // And a parent nobody typed into, seeded by a child at zero (Z1),
        // goes when that child is cleared.
        let home = cat(&c, "Home", "expense", None);
        let rent = cat(&c, "Rent", "expense", Some(&home));
        set_plan(&c, &rent, 2027, 0, EVERY_MONTH, SPENT).unwrap();
        let p = year_plan(&c, 2027, "2027-12-31").unwrap();
        assert!(line(&p, &home).has_plan, "the child's zero, at the parent too");
        assert_eq!(monthly(&home), 0);
        clear_plan(&c, &rent, 2027).unwrap();
        let p = year_plan(&c, 2027, "2027-12-31").unwrap();
        assert!(!line(&p, &home).has_plan, "cleared, and nobody asked for the parent");
    }

    /// Deliberate headroom on the year plan survives too.
    #[test]
    fn a_planned_parent_he_typed_is_never_pulled_down() {
        let db = TestDb::new("plan-keep");
        let c = db.conn();
        let auto = cat(&c, "Automobile", "expense", None);
        let fuel = cat(&c, "Fuel", "expense", Some(&auto));

        let monthly = |id: &str| -> i64 {
            let p = year_plan(&c, 2027, "2027-12-31").unwrap();
            line(&p, id).monthly_cents
        };

        set_plan(&c, &fuel, 2027, 360_000, EVERY_MONTH, SPENT).unwrap();
        set_plan(&c, &auto, 2027, 1_080_000, EVERY_MONTH, SPENT).unwrap();
        assert_eq!(monthly(&auto), 90_000);

        set_plan(&c, &fuel, 2027, 120_000, EVERY_MONTH, SPENT).unwrap();
        assert_eq!(monthly(&auto), 90_000, "the user's figure, the user's headroom");

        // And when the children outgrow it and then shrink again, it
        // settles back onto its own 900 rather than onto theirs.
        set_plan(&c, &fuel, 2027, 2_400_000, EVERY_MONTH, SPENT).unwrap();
        assert_eq!(monthly(&auto), 201_000, "the children need more than was asked for");
        set_plan(&c, &fuel, 2027, 360_000, EVERY_MONTH, SPENT).unwrap();
        assert_eq!(monthly(&auto), 90_000, "and the typed 900 is still underneath it");
    }

    #[test]
    fn typing_into_a_parent_above_its_children_is_left_alone() {
        let db = TestDb::new("envelope-parent-high");
        let c = db.conn();
        let auto = cat(&c, "Auto", "expense", None);
        let fuel = cat(&c, "Fuel", "expense", Some(&auto));

        set_plan(&c, &fuel, 2027, 360_000, EVERY_MONTH, SPENT).unwrap();
        let w = set_plan(&c, &auto, 2027, 1_080_000, EVERY_MONTH, SPENT).unwrap();
        assert!(w.raised.is_none(), "nothing to raise; $900 already covers $300");
        assert_eq!(w.line.monthly_cents, 90_000);
    }

    /// A parent with no children is nobody's envelope, so the new check has
    /// nothing to say about it — including the empty-envelope trap, where an empty
    /// claim asks for `next_ten_above(0)` and invents $10.
    #[test]
    fn a_childless_category_is_written_exactly_as_typed() {
        let db = TestDb::new("envelope-childless");
        let c = db.conn();
        let books = cat(&c, "Books", "expense", None);

        let w = set_plan(&c, &books, 2027, 60_000, EVERY_MONTH, SPENT).unwrap();
        assert!(w.raised.is_none());
        assert_eq!(w.line.monthly_cents, 5_000);

        // Zero stays zero: "nothing here on purpose" is a plan.
        let w = set_plan(&c, &books, 2027, 0, EVERY_MONTH, SPENT).unwrap();
        assert!(w.raised.is_none());
        assert_eq!(w.line.annual_cents, 0);
    }

    /// R3: *"typing 0.00 in any parent category that has child
    /// categories does not keep 0.00"*, while a child and a childless line
    /// both held it. The envelope rule read "nothing wanted" as "nothing
    /// asked for" and deleted the parent's plan; `asked_for` is `Some(0)`
    /// for a typed zero and NULL for a seeded envelope, and only the second
    /// may go.
    #[test]
    fn a_zero_he_typed_into_a_parent_is_a_plan_of_nothing() {
        let db = TestDb::new("plan-parent-zero");
        let c = db.conn();
        let bills = cat(&c, "Bills", "expense", None);
        let power = cat(&c, "Electricity", "expense", Some(&bills));

        let bills_line = || {
            let p = year_plan(&c, 2027, "2027-12-31").unwrap();
            let l = line(&p, &bills);
            (l.has_plan, l.annual_cents, l.monthly_cents)
        };

        // Children with no plan of their own: the zero must simply hold.
        set_plan(&c, &bills, 2027, 0, EVERY_MONTH, SPENT).unwrap();
        assert_eq!(bills_line(), (true, 0, 0), "typing 0 is a plan, and it was being deleted");

        // A child claims: the envelope rule covers it...
        set_plan(&c, &power, 2027, 720_000, EVERY_MONTH, SPENT).unwrap();
        assert_eq!(bills_line().2, 61_000, "$600 claimed -> $610");

        // ...and when the claim goes, the envelope settles onto its own zero
        // rather than vanishing, because the user asked for it.
        set_plan(&c, &power, 2027, 0, EVERY_MONTH, SPENT).unwrap();
        assert_eq!(bills_line(), (true, 0, 0), "the typed zero is still underneath");
    }

    /// Rolling a year forward writes many lines at once, and the order they arrive in is not
    /// something the caller controls. A parent applied AFTER its children
    /// used to overwrite the envelope they had just raised.
    #[test]
    fn applying_a_parent_after_its_children_still_leaves_an_envelope() {
        let db = TestDb::new("envelope-proposals");
        let c = db.conn();
        let auto = cat(&c, "Auto", "expense", None);
        let fuel = cat(&c, "Fuel", "expense", Some(&auto));

        apply_proposals(
            &c,
            2027,
            &[
                (fuel.clone(), 360_000, EVERY_MONTH.to_string(), SPENT.to_string()),
                (auto.clone(), 120_000, EVERY_MONTH.to_string(), SPENT.to_string()),
            ],
        )
        .unwrap();

        let p = year_plan(&c, 2027, "2027-12-31").unwrap();
        assert_eq!(
            line(&p, &auto).monthly_cents,
            31_000,
            "the parent came last and was $100; the children claim $300"
        );
    }

    #[test]
    fn a_parent_is_still_the_envelope_for_its_children() {
        let db = TestDb::new("envelope");
        let c = db.conn();
        let jordan = cat(&c, "Jordan", "income", None);
        let salary = cat(&c, "Salaried job", "income", Some(&jordan));
        let side_job = cat(&c, "Acme Corp", "income", Some(&jordan));

        // The parent had no plan, so budgeting a child gives it one,
        // on the next whole ten above what the children claim.
        let w = set_plan(&c, &salary, 2027, 3_000_000, EVERY_MONTH, SPENT).unwrap();
        let made = w.raised.expect("the parent should have been given one");
        assert!(made.created);
        assert_eq!(made.target_cents, 251_000, "$2,500 of children -> $2,510");

        // A second child pushes it up again.
        let w = set_plan(&c, &side_job, 2027, 1_200_000, "000000111100", SPENT).unwrap();
        let raised = w.raised.expect("raised");
        assert!(!raised.created);
        assert_eq!(raised.target_cents, 551_000, "2,500 + 3,000 -> 5,510");

        // The child is inside the parent, so the totals count the parent once.
        let p = year_plan(&c, 2027, "2027-12-31").unwrap();
        assert!(!line(&p, &salary).counts_in_total);
        assert!(line(&p, &jordan).counts_in_total);
        assert_eq!(p.income_total.monthly_cents, 551_000);

        // The parent carries its children's actuals whether or not they are
        // themselves budgeted.
        let acct = account(&c, "Checking");
        spend(&c, &acct, "2027-07-05", &salary, 250_000);
        spend(&c, &acct, "2027-07-20", &side_job, 300_000);
        let p = year_plan(&c, 2027, "2027-07-31").unwrap();
        assert_eq!(line(&p, &jordan).actual_cents[6], 550_000);
    }

    #[test]
    fn a_plan_writes_the_twelve_monthly_rows_everything_else_reads() {
        let db = TestDb::new("materialize");
        let c = db.conn();
        let food = cat(&c, "Food", "expense", None);
        let oil = cat(&c, "Heating oil", "expense", None);

        set_plan(&c, &food, 2027, 1_200_000, EVERY_MONTH, SPENT).unwrap();
        set_plan(&c, &oil, 2027, 90_000, "111000000011", SPENT).unwrap();

        let count = |cat: &str| -> i64 {
            c.query_row(
                "SELECT COUNT(*) FROM budgets WHERE category_id = ?1 AND month_year LIKE '2027-%'",
                params![cat],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(count(&food), 12);
        assert_eq!(count(&oil), 5, "only the months it runs");

        let july: Option<i64> = c
            .query_row(
                "SELECT target_cents FROM budgets WHERE category_id = ?1 AND month_year = '2027-07'",
                params![oil],
                |r| r.get(0),
            )
            .optional()
            .unwrap();
        assert_eq!(july, None, "no row at all in a month it does not run");

        let jan: i64 = c
            .query_row(
                "SELECT target_cents FROM budgets WHERE category_id = ?1 AND month_year = '2027-01'",
                params![oil],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(jan, 18_000);

        // The old screen reads `budgets`, so it must now agree with the plan.
        let g = queries::budget_grid(&c, "2027-01").unwrap();
        let l = g.lines.iter().find(|l| l.category_id == oil).unwrap();
        assert_eq!((l.has_budget, l.target_cents), (true, 18_000));

        // Narrowing the spread takes the surplus months away rather than
        // leaving stale rows behind, which is the bug this rewrite exists to
        // avoid: a month nobody plans for must not keep last week's figure.
        set_plan(&c, &oil, 2027, 90_000, "110000000000", SPENT).unwrap();
        assert_eq!(count(&oil), 2);
        assert_eq!(monthly_of(90_000, "110000000000", SPENT), 45_000);

        // Clearing the plan clears the year's rows with it.
        clear_plan(&c, &oil, 2027).unwrap();
        assert_eq!(count(&oil), 0);
        assert_eq!(count(&food), 12, "and leaves everything else alone");
    }

    #[test]
    fn a_budget_set_by_hand_on_an_unplanned_category_is_left_alone() {
        // The plan and the old monthly screen have to coexist while the app
        // moves over. Materializing must only ever touch categories that
        // actually have a plan.
        let db = TestDb::new("coexist");
        let c = db.conn();
        let food = cat(&c, "Food", "expense", None);
        let books = cat(&c, "Books", "expense", None);
        queries::set_budget(&c, &books, 5_000, "2027-03").unwrap();

        set_plan(&c, &food, 2027, 1_200_000, EVERY_MONTH, SPENT).unwrap();

        let kept: i64 = c
            .query_row(
                "SELECT target_cents FROM budgets WHERE category_id = ?1 AND month_year = '2027-03'",
                params![books],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(kept, 5_000);
    }


    /// The question that produced this: if a job ended partway
    /// through the year and the new year is built from history, can that job
    /// be marked as gone? The screen should already know.
    #[test]
    fn a_job_that_stopped_is_flagged_and_a_job_that_started_is_annualized() {
        let db = TestDb::new("history");
        let c = db.conn();
        let acct = account(&c, "Checking");
        let gone = cat(&c, "Old job", "income", None);
        let fresh = cat(&c, "New job", "income", None);
        let steady = cat(&c, "Pension", "income", None);

        for m in 1..=10u32 {
            spend(&c, &acct, &format!("2026-{m:02}-05"), &gone, 300_000);
        }
        for m in 9..=12u32 {
            spend(&c, &acct, &format!("2026-{m:02}-05"), &fresh, 320_000);
        }
        for m in 1..=12u32 {
            spend(&c, &acct, &format!("2026-{m:02}-02"), &steady, 243_500);
        }

        let props = from_history(&c, 2026, 2027, "2027-01-04").unwrap();
        let find = |id: &str| props.iter().find(|p| p.category_id == id).expect("proposal");

        let g = find(&gone);
        assert_eq!(g.basis, "ended");
        assert!(!g.include, "a job that stopped is not proposed for next year");
        assert_eq!(g.note, "nothing since Oct");
        assert_eq!((g.first_month, g.last_month, g.active_months), (1, 10, 10));

        // The dangerous one: a twelfth of four months of pay would propose a
        // third of the job.
        let f = find(&fresh);
        assert_eq!(f.basis, "running");
        assert!(f.include);
        assert_eq!(f.plain_monthly_cents, 106_666, "what a twelfth would have said");
        assert_eq!(f.suggested_monthly_cents, 320_000, "its actual rate");
        assert_eq!(f.suggested_annual_cents, 3_840_000);
        assert!(f.note.starts_with("started in Sep"));

        let s = find(&steady);
        assert_eq!(s.basis, "twelve");
        assert!(s.include);
        assert_eq!(s.suggested_monthly_cents, 243_000, "income rounds DOWN to the ten");
    }

    /// A once-a-year bill is silent for eleven months and is NOT a line that
    /// stopped. The line's own spread is what tells them apart.
    #[test]
    fn a_yearly_bill_is_not_mistaken_for_something_that_ended() {
        let db = TestDb::new("history-yearly");
        let c = db.conn();
        let acct = account(&c, "Checking");
        let ins = cat(&c, "Home insurance", "expense", None);
        set_plan(&c, &ins, 2026, 360_000, "100000000000", SPENT).unwrap();
        spend(&c, &acct, "2026-01-11", &ins, -352_600);

        let props = from_history(&c, 2026, 2027, "2027-01-04").unwrap();
        let p = props.iter().find(|p| p.category_id == ins).expect("proposal");
        assert_eq!(p.basis, "twelve", "quiet on purpose is not quiet because it ended");
        assert!(p.include);
        assert_eq!(p.months, "100000000000", "and it stays a January line");
        // Proposed per RUNNING month: the whole cost lands in January.
        assert_eq!(p.suggested_monthly_cents, 353_000, "expenses round UP to the ten");
        assert_eq!(p.suggested_annual_cents, 353_000);
    }

    #[test]
    fn a_seasonal_line_is_proposed_per_month_it_runs() {
        let db = TestDb::new("history-seasonal");
        let c = db.conn();
        let acct = account(&c, "Checking");
        let oil = cat(&c, "Heating oil", "expense", None);
        set_plan(&c, &oil, 2026, 90_000, "111000000011", SPENT).unwrap();
        for (m, cents) in [(1u32, -19_000i64), (2, -18_000), (3, -15_000), (11, -16_000), (12, -19_000)] {
            spend(&c, &acct, &format!("2026-{m:02}-15"), &oil, cents);
        }

        let props = from_history(&c, 2026, 2027, "2027-01-04").unwrap();
        let p = props.iter().find(|p| p.category_id == oil).expect("proposal");
        assert_eq!(p.months, "111000000011");
        assert_eq!(p.months_label, "Nov\u{2013}Mar");
        // $870 over five cold months, not over twelve.
        assert_eq!(p.actual_cents, 87_000);
        assert_eq!(p.suggested_monthly_cents, 18_000);
        assert_eq!(p.suggested_annual_cents, 90_000);
    }

    #[test]
    fn accepting_proposals_writes_the_year_and_the_monthly_rows_once() {
        let db = TestDb::new("history-apply");
        let c = db.conn();
        let food = cat(&c, "Food", "expense", None);
        let oil = cat(&c, "Heating oil", "expense", None);

        let n = apply_proposals(
            &c,
            2027,
            &[
                (food.clone(), 1_200_000, EVERY_MONTH.to_string(), SPENT.to_string()),
                (oil.clone(), 90_000, "111000000011".to_string(), SPENT.to_string()),
            ],
        )
        .unwrap();
        assert_eq!(n, 2);

        let p = year_plan(&c, 2027, "2027-12-31").unwrap();
        assert_eq!(line(&p, &food).annual_cents, 1_200_000);
        assert_eq!(line(&p, &oil).monthly_cents, 18_000);

        let rows: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM budgets WHERE month_year LIKE '2027-%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rows, 17, "twelve for food and five for heating oil");

        // A line it cannot mean is refused rather than half-written.
        assert!(apply_proposals(&c, 2027, &[(food.clone(), -1, EVERY_MONTH.to_string(), SPENT.to_string())]).is_err());
        assert!(apply_proposals(&c, 2027, &[(food, 1_000, "000000000000".to_string(), SPENT.to_string())]).is_err());
    }

    /// A year with nothing in it proposes nothing, rather than a page of
    /// zeroes with tick boxes.
    #[test]
    fn an_empty_year_proposes_nothing() {
        let db = TestDb::new("history-empty");
        let c = db.conn();
        cat(&c, "Food", "expense", None);
        assert!(from_history(&c, 2026, 2027, "2027-01-04").unwrap().is_empty());
        // And a year that has not started is not a year to read.
        assert!(from_history(&c, 2028, 2029, "2027-01-04").unwrap().is_empty());
    }

    #[test]
    fn a_plan_refuses_what_it_cannot_mean() {
        let db = TestDb::new("refuse");
        let c = db.conn();
        let food = cat(&c, "Food", "expense", None);
        assert!(set_plan(&c, &food, 2027, -1, EVERY_MONTH, SPENT).is_err());
        assert!(set_plan(&c, &food, 2027, 1_000, "000000000000", SPENT).is_err());
        assert!(set_plan(&c, &food, 2027, 1_000, "111", SPENT).is_err());
        assert!(set_plan(&c, "no-such-category", 2027, 1_000, EVERY_MONTH, SPENT).is_err());
        // A plan of zero is a real plan: "nothing here, on purpose".
        let w = set_plan(&c, &food, 2027, 0, EVERY_MONTH, SPENT).unwrap();
        assert!(w.line.has_plan);
        assert_eq!(w.line.monthly_cents, 0);
    }

    /// Build from history carried a line's mask and dropped its
    /// spread: a set-aside bill came back as a spent one, with the whole bill
    /// as its monthly figure.
    #[test]
    fn building_from_a_year_keeps_a_set_aside_line_set_aside() {
        let db = TestDb::new("history-aside");
        let c = db.conn();
        let acct = account(&c, "Checking");
        let ins = cat(&c, "Home insurance", "expense", None);
        let food = cat(&c, "Food", "expense", None);
        set_plan(&c, &ins, 2026, 360_000, "100000000000", ASIDE).unwrap();
        spend(&c, &acct, "2026-01-11", &ins, -352_600);
        for m in 1..=12u32 {
            spend(&c, &acct, &format!("2026-{m:02}-05"), &food, -50_000);
        }

        let props = from_history(&c, 2026, 2027, "2027-01-04").unwrap();
        let p = props.iter().find(|p| p.category_id == ins).expect("proposal");
        assert_eq!((p.months.as_str(), p.spread.as_str()), ("100000000000", ASIDE));
        // A twelfth of the bill, set aside every month — not $3,530 in January.
        assert_eq!(p.suggested_monthly_cents, 30_000);
        assert_eq!(p.suggested_annual_cents, 360_000);
        assert!(p.include);
        // No plan to carry from: spent, as ever.
        let f = props.iter().find(|p| p.category_id == food).expect("proposal");
        assert_eq!(f.spread, SPENT);

        apply_proposals(&c, 2027, &[(ins.clone(), p.suggested_annual_cents, p.months.clone(), p.spread.clone())]).unwrap();
        let y = year_plan(&c, 2027, "2027-12-31").unwrap();
        assert_eq!(line(&y, &ins).monthly_cents, 30_000);
        let rows: i64 = c
            .query_row("SELECT COUNT(*) FROM budgets WHERE category_id = ?1 AND month_year LIKE '2027-%'", params![ins], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 12, "set aside in every month");
    }

    /// A plan write is one SQL transaction: when rebuilding the monthly
    /// rows fails, the plan row it wrote first is not left behind.
    #[test]
    fn a_plan_write_that_fails_part_way_leaves_nothing_written() {
        let db = TestDb::new("plan-atomic");
        let c = db.conn();
        let food = cat(&c, "Food", "expense", None);
        let oil = cat(&c, "Heating oil", "expense", None);
        let plans = |c: &Conn| -> i64 { c.query_row("SELECT COUNT(*) FROM budget_plans", [], |r| r.get(0)).unwrap() };

        c.execute_batch("CREATE TEMP TRIGGER no_budgets BEFORE INSERT ON budgets BEGIN SELECT RAISE(ABORT, 'no budgets'); END;")
            .unwrap();
        let err = set_plan(&c, &food, 2027, 1_200_000, EVERY_MONTH, SPENT).unwrap_err();
        assert!(err.contains("no budgets"), "{err}");
        assert_eq!(plans(&c), 0, "the plan row stayed without its monthly rows");
        assert!(c.is_autocommit(), "the failed write left a transaction open");
        assert!(apply_proposals(&c, 2027, &[(food.clone(), 1_200_000, EVERY_MONTH.to_string(), SPENT.to_string())]).is_err());
        assert_eq!(plans(&c), 0);
        c.execute_batch("DROP TRIGGER no_budgets;").unwrap();

        // A refusal on the second pick takes the first back with it.
        let picks = [
            (food.clone(), 1_200_000, EVERY_MONTH.to_string(), SPENT.to_string()),
            (oil.clone(), 90_000, "not a mask".to_string(), SPENT.to_string()),
        ];
        assert!(apply_proposals(&c, 2027, &picks).is_err());
        assert_eq!(plans(&c), 0, "the first pick was written before the second was refused");

        // Clearing is one write too.
        set_plan(&c, &food, 2027, 1_200_000, EVERY_MONTH, SPENT).unwrap();
        c.execute_batch("CREATE TEMP TRIGGER keep_budgets BEFORE DELETE ON budgets BEGIN SELECT RAISE(ABORT, 'keep budgets'); END;")
            .unwrap();
        assert!(clear_plan(&c, &food, 2027).is_err());
        assert_eq!(plans(&c), 1, "the plan was cleared and its monthly rows were not");
        c.execute_batch("DROP TRIGGER keep_budgets;").unwrap();

        // And the happy path still lands whole.
        clear_plan(&c, &food, 2027).unwrap();
        set_plan(&c, &oil, 2027, 90_000, "111000000011", SPENT).unwrap();
        let rows: i64 = c.query_row("SELECT COUNT(*) FROM budgets WHERE month_year LIKE '2027-%'", [], |r| r.get(0)).unwrap();
        assert_eq!((plans(&c), rows), (1, 5));
    }
}
