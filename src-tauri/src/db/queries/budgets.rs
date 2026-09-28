//! Budgets and spending: the budget grid, the starter, the parent envelope rule
//! and autobudget.

use crate::models::{AutobudgetLine, Budget, CategoryBudget};
use rusqlite::{params, OptionalExtension, Row};
use uuid::Uuid;
use super::*;

// ---------------------------------------------------------------------------
// Budgets & spending
// ---------------------------------------------------------------------------

pub fn get_spending_summary(conn: &Conn, month: &str) -> Result<Vec<CategoryBudget>, String> {
    // month is "YYYY-MM". Spending comes from CATEGORY_LINES so a split
    // transaction is counted against each of its categories (§6.1e).
    //
    // Budgets are keyed by category_id since migration 0014, so a renamed
    // category keeps its budget instead of silently orphaning it.
    let sql = format!("{CATEGORY_LINES}{}", r#"
        , month_lines AS (
            SELECT category_id,
                   SUM(CASE WHEN amount_cents < 0 THEN -amount_cents ELSE 0 END) AS spent_cents
              FROM lines
             WHERE substr(date, 1, 7) = ?1
               AND category_id IS NOT NULL
             GROUP BY category_id
        )
        SELECT c.id,
               CASE WHEN c.parent_id IS NULL THEN c.name
                    ELSE p.name || ' : ' || c.name END AS category_name,
               COALESCE(b.target_cents, 0)             AS target_cents,
               COALESCE(m.spent_cents, 0)              AS spent_cents,
               ?1                                      AS month_year
          FROM categories c
          LEFT JOIN categories  p ON p.id = c.parent_id
          LEFT JOIN budgets     b ON b.category_id = c.id AND b.month_year = ?1
          LEFT JOIN month_lines m ON m.category_id = c.id
         WHERE b.id IS NOT NULL OR COALESCE(m.spent_cents, 0) > 0
         ORDER BY spent_cents DESC, category_name COLLATE NOCASE
    "#);
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let out = stmt
        .query_map(params![month], |r| {
            let target: i64 = r.get(2)?;
            let spent: i64 = r.get(3)?;
            Ok(CategoryBudget {
                category_id: r.get(0)?,
                category_name: r.get(1)?,
                target_cents: target,
                spent_cents: spent,
                remaining_cents: target - spent,
                month_year: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(out)
}

/// §129 — the Budget screen, in one answer.
///
/// # A parent is the envelope for the whole category (§130)
///
/// > *"adding all the childs into the main category makes more sense … to
/// > ensure the whole category is accounted for"*
///
/// Budget `Automobile` at $600 and fuel, repairs and the car wash all come
/// out of it. A child's own amount is an **allocation inside** that envelope,
/// not an escape from it: budget `Automobile : Fuel` at $200 and the fuel
/// still counts against Automobile — the child line just says how much of the
/// $600 is meant for fuel.
///
/// §129 shipped the opposite rule for a day (a budgeted child *carved itself
/// out* of its parent) because that is what was asked for then. It is a
/// defensible model and it is not this one; the difference is whether a
/// parent means "everything under here" or "everything under here that I have
/// not itemized". The user looked at it running and chose the first.
///
/// **The double-count moved rather than disappeared.** Under the old rule the
/// danger was in the SPEND; here it is in the TARGETS, because a parent's
/// $600 already contains its children's $200. `counts_in_total` is the
/// answer: each branch is counted once, at its top.
///
/// `get_spending_summary` above deliberately still matches exactly. It answers
/// "what was spent per category", where rolling a parent's children into it
/// would hide where the money actually went. Two questions, two queries.
///
/// # Every category, not just the interesting ones
///
/// It returns all expense categories, budgeted or not, so the screen can show
/// a row to type into. The old screen listed only categories already budgeted
/// or already spent in, which is why setting a new budget meant finding the
/// category in a dropdown at the bottom of the page.
///
/// The category tree is two levels (migration 0014), so "children" is one
/// join and not a recursive CTE. If it ever grows a third level this is the
/// function that has to learn about it.
pub fn budget_grid(conn: &Conn, month: &str) -> Result<crate::models::BudgetGrid, String> {
    parse_month(month)?;
    let sql = format!("{CATEGORY_LINES}{}", r#"
        , month_lines AS (
            SELECT category_id,
                   SUM(CASE WHEN amount_cents < 0 THEN -amount_cents ELSE 0 END) AS spent
              FROM lines
             WHERE substr(date, 1, 7) = ?1 AND category_id IS NOT NULL
             GROUP BY category_id
        ), year_lines AS (
            -- §131: a yearly line is measured against the calendar year, so
            -- the same spending is needed on a second basis.
            SELECT category_id,
                   SUM(CASE WHEN amount_cents < 0 THEN -amount_cents ELSE 0 END) AS spent
              FROM lines
             WHERE substr(date, 1, 4) = substr(?1, 1, 4) AND category_id IS NOT NULL
             GROUP BY category_id
        ), bud AS (
            SELECT category_id, target_cents, period FROM budgets WHERE month_year = ?1
        )
        SELECT c.id,
               c.name,
               CASE WHEN c.parent_id IS NULL THEN c.name
                    ELSE p.name || ' : ' || c.name END AS full_name,
               c.parent_id,
               b.target_cents,
               b.period,
               COALESCE(m.spent, 0) AS own_cents,
               -- §130: EVERY child rolls up, budgeted or not. The parent is
               -- the whole category. A leaf has no children and gets 0.
               COALESCE((
                   SELECT SUM(COALESCE(cm.spent, 0))
                     FROM categories ch
                     LEFT JOIN month_lines cm ON cm.category_id = ch.id
                    WHERE ch.parent_id = c.id
               ), 0) AS rolled_cents,
               -- What this line's children have claimed between them.
               COALESCE((
                   SELECT SUM(cb.target_cents)
                     FROM categories ch
                     JOIN bud cb ON cb.category_id = ch.id
                    WHERE ch.parent_id = c.id
               ), 0) AS children_budgeted_cents,
               -- Does the PARENT carry a budget? A child under a budgeted
               -- parent is inside that envelope and must not be added again.
               (c.parent_id IS NOT NULL
                AND EXISTS(SELECT 1 FROM bud pb WHERE pb.category_id = c.parent_id)) AS parent_budgeted,
               -- §131: the same two spends again, over the calendar year.
               COALESCE(y.spent, 0) AS own_year_cents,
               COALESCE((
                   SELECT SUM(COALESCE(cy.spent, 0))
                     FROM categories ch
                     LEFT JOIN year_lines cy ON cy.category_id = ch.id
                    WHERE ch.parent_id = c.id
               ), 0) AS rolled_year_cents
          FROM categories c
          LEFT JOIN categories p ON p.id = c.parent_id
          LEFT JOIN bud         b ON b.category_id = c.id
          LEFT JOIN month_lines m ON m.category_id = c.id
          LEFT JOIN year_lines  y ON y.category_id = c.id
         WHERE c.kind = 'expense'
         -- Tree order, and STABLE: by the parent's name, the parent's own row
         -- first, then its children alphabetically. The old screen ordered by
         -- amount spent, so rows moved under the cursor while you typed.
         ORDER BY COALESCE(p.name, c.name) COLLATE NOCASE,
                  (c.parent_id IS NOT NULL),
                  c.name COLLATE NOCASE
    "#);
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let lines: Vec<crate::models::BudgetLine> = stmt
        .query_map(params![month], |r| {
            let target: Option<i64> = r.get(4)?;
            let period: Option<String> = r.get(5)?;
            let own: i64 = r.get(6)?;
            let rolled: i64 = r.get(7)?;
            let children_budgeted: i64 = r.get(8)?;
            let parent_budgeted: bool = r.get(9)?;
            let own_year: i64 = r.get(10)?;
            let rolled_year: i64 = r.get(11)?;
            let period = period.unwrap_or_else(|| "monthly".to_string());
            let yearly = period == "yearly";
            let target = target.unwrap_or(0);
            let spent_month = own + rolled;
            // §131: measured over its own period. A yearly line spent in one
            // month has not overspent that month; it has spent its year.
            let spent = if yearly { own_year + rolled_year } else { spent_month };
            Ok(crate::models::BudgetLine {
                category_id: r.get(0)?,
                name: r.get(1)?,
                full_name: r.get(2)?,
                parent_id: r.get(3)?,
                target_cents: target,
                monthly_cents: monthly_equivalent(target, &period),
                period,
                has_budget: r.get::<_, Option<i64>>(4)?.is_some(),
                own_cents: own,
                rolled_cents: rolled,
                children_budgeted_cents: children_budgeted,
                counts_in_total: r.get::<_, Option<i64>>(4)?.is_some() && !parent_budgeted,
                spent_cents: spent,
                spent_month_cents: spent_month,
                remaining_cents: target - spent,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;

    // §130 — each BRANCH counted once, at its top. A budgeted child under a
    // budgeted parent is already inside that parent's envelope, in both the
    // target and the spend; adding it again reports a household budgeting and
    // spending twice what it did.
    // §131 — the strip is a MONTHLY view, so every row contributes its
    // monthly equivalent and this month's spending, whatever period it is
    // kept in. A yearly line adds a twelfth, not the whole thing.
    let budgeted: i64 = lines.iter().filter(|l| l.counts_in_total).map(|l| l.monthly_cents).sum();
    let spent: i64 = lines.iter().filter(|l| l.counts_in_total).map(|l| l.spent_month_cents).sum();
    Ok(crate::models::BudgetGrid {
        month: month.to_string(),
        budgeted_lines: lines.iter().filter(|l| l.has_budget).count() as u32,
        total_lines: lines.len() as u32,
        budgeted_cents: budgeted,
        spent_cents: spent,
        remaining_cents: budgeted - spent,
        lines,
    })
}

/// §129 — a budget to start from, built out of what this household actually
/// spends.
///
/// > *"maybe there needs to be kind of a default categories and maybe if
/// > there's existing data it tries to match to those defaults"*
///
/// The defaults ARE the top-level categories: the standard chart ships
/// nineteen of them (Automobile, Groceries, Home, Insurance…), every category
/// hangs off one, and a household that budgets those has budgeted everything
/// without naming eighty things. So this proposes parents, ranked by what
/// they cost, and stops at `limit` of them — the ones worth thinking about.
/// No invented bucket names, and no guessing which of the user's categories
/// belongs in which bucket: the tree already said.
///
/// # Why the median and not the average
///
/// `autobudget` (§51) proposes the mean of the months that had spending, which
/// is Money's rule and is badly thrown by one bad month: a $3,000 transmission
/// makes a $4,800 Automobile budget out of a household that normally spends
/// $380. The median ignores it. The mean is still the right answer when there
/// are only one or two months to look at — there is no middle to take — so
/// below three months this falls back to it.
///
/// Scheduled bills still win when they are larger, for the same reason §51
/// gave: an annual insurance premium paid once is not spread by history, and
/// the schedule is the only place that knows it is coming.
pub fn budget_starter(
    conn: &Conn,
    month: &str,
    lookback: u32,
    limit: u32,
) -> Result<Vec<crate::models::AutobudgetLine>, String> {
    let (y, m) = parse_month(month)?;
    let lookback = lookback.clamp(1, 60) as i64;
    let (fy, fm) = crate::schedule::add_months(y, m, -lookback);
    let from = format!("{fy:04}-{fm:02}");

    // Per top-level parent, per month: everything spent anywhere beneath it.
    let sql = format!("{CATEGORY_LINES}{}", r#"
        SELECT COALESCE(c.parent_id, c.id) AS top_id,
               substr(l.date, 1, 7)        AS ym,
               SUM(CASE WHEN l.amount_cents < 0 THEN -l.amount_cents ELSE 0 END) AS spent
          FROM lines l
          JOIN categories c ON c.id = l.category_id
         WHERE l.category_id IS NOT NULL
           AND c.kind = 'expense'
           AND substr(l.date, 1, 7) >= ?1 AND substr(l.date, 1, 7) < ?2
         GROUP BY top_id, ym
        HAVING spent > 0
    "#);
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows: Vec<(String, i64)> = stmt
        .query_map(params![from, month], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(2)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;

    let mut by_cat: std::collections::HashMap<String, Vec<i64>> = std::collections::HashMap::new();
    for (id, spent) in rows {
        by_cat.entry(id).or_default().push(spent);
    }

    // Scheduled bills, rolled to the top-level parent the same way.
    let mut sched_stmt = conn
        .prepare(
            r#"
            SELECT COALESCE(c.parent_id, c.id) AS top_id,
                   SUM(CASE r.freq
                         WHEN 'weekly'       THEN -r.amount_cents * 52 / (12 * r.interval_n)
                         WHEN 'semi_monthly' THEN -r.amount_cents * 2
                         WHEN 'monthly'      THEN -r.amount_cents / r.interval_n
                         WHEN 'yearly'       THEN -r.amount_cents / (12 * r.interval_n)
                         ELSE 0 END) AS monthly
              FROM recurrences r
              JOIN categories c ON c.id = r.category_id
             WHERE r.is_active = 1 AND r.amount_cents < 0 AND c.kind = 'expense'
               AND (r.end_date IS NULL OR r.end_date >= ?1 || '-01')
             GROUP BY top_id
        "#,
        )
        .map_err(|e| e.to_string())?;
    let sched: std::collections::HashMap<String, i64> = sched_stmt
        .query_map(params![month], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;

    let mut names = conn
        .prepare("SELECT id, name FROM categories WHERE parent_id IS NULL AND kind = 'expense'")
        .map_err(|e| e.to_string())?;
    let name_of: std::collections::HashMap<String, String> = names
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;

    let existing: std::collections::HashMap<String, i64> = conn
        .prepare("SELECT category_id, target_cents FROM budgets WHERE month_year = ?1")
        .map_err(|e| e.to_string())?
        .query_map(params![month], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;

    let mut out: Vec<crate::models::AutobudgetLine> = Vec::new();
    let mut ids: Vec<String> = name_of.keys().cloned().collect();
    ids.sort();
    for id in ids {
        let months = by_cat.get(&id).cloned().unwrap_or_default();
        let scheduled = *sched.get(&id).unwrap_or(&0);
        if months.is_empty() && scheduled == 0 {
            continue;
        }
        let typical = middle(&months);
        let suggested = round_up_to(typical.max(scheduled), 500);
        if suggested == 0 {
            continue;
        }
        out.push(crate::models::AutobudgetLine {
            category_id: id.clone(),
            category_name: name_of.get(&id).cloned().unwrap_or_default(),
            average_cents: typical,
            months_with_spending: months.len() as u32,
            scheduled_cents: scheduled,
            suggested_cents: suggested,
            current_cents: existing.get(&id).copied(),
        });
    }
    // The ones worth thinking about first, and only as many as asked for.
    out.sort_by(|a, b| b.suggested_cents.cmp(&a.suggested_cents).then(a.category_name.cmp(&b.category_name)));
    out.truncate(limit.clamp(1, 60) as usize);
    // Then back into tree order, so the list reads like the screen behind it.
    out.sort_by(|a, b| a.category_name.to_lowercase().cmp(&b.category_name.to_lowercase()));
    Ok(out)
}

/// The typical month: the median once there is enough to have a middle, the
/// mean below that. See `budget_starter` for why.
fn middle(months: &[i64]) -> i64 {
    if months.is_empty() {
        return 0;
    }
    if months.len() < 3 {
        return months.iter().sum::<i64>() / months.len() as i64;
    }
    let mut v = months.to_vec();
    v.sort_unstable();
    let mid = v.len() / 2;
    if v.len() % 2 == 1 {
        v[mid]
    } else {
        (v[mid - 1] + v[mid]) / 2
    }
}

/// §131 — `cents` as a monthly figure. A yearly budget is a twelfth, rounded
/// to the nearest cent: $100 a year is $8.33 a month. Twelve of those do not
/// come back to exactly $100, which is fine — a budget is a intention, not a
/// schedule of payments.
pub fn monthly_equivalent(cents: i64, period: &str) -> i64 {
    if period == "yearly" {
        (cents + 6) / 12
    } else {
        cents
    }
}

/// §130 — the next whole ten STRICTLY above `cents`.
///
/// > *"increase it to a whole ten above the total since its a budget amount
/// > it should always land slightly higher (my preference a whole ten number)
/// > than the actual amount"*
///
/// Strictly above, so $610.00 of children gives a $620.00 parent and not
/// $610.00. A parent merely equal to the sum of its parts leaves nothing for
/// the things nobody itemized, which is the whole reason the parent exists.
///
/// §146 — BUT NEVER BY MORE THAN A TENTH, which is the same correction
/// §144 had to make to the monthly figure.
///
/// Found by walking B4b: *"I gave the child Interest a 60 annual amount and
/// the parent changed to 120, that's not correct it should have been 70 at
/// most right?"* That is right. $60 a year is $5 a month; the next whole ten
/// above $5 is $10, which written back as a yearly parent is **$120** — a
/// parent at double its only child, from a rule whose entire purpose is to
/// land *slightly* higher.
///
/// At $600 a month, rounding to $610 is a rounding. At $5 a month, rounding
/// to $10 is a decision, and not one anybody made. So: the next whole ten
/// when that costs a tenth or less, the next whole DOLLAR otherwise — still
/// strictly above, because §130's headroom is the point and $5 must not
/// stay $5.
pub fn next_ten_above(cents: i64) -> i64 {
    if cents < 0 {
        return 0;
    }
    let ten = (cents / 1_000 + 1) * 1_000;
    if ten * 10 <= cents * 11 {
        return ten;
    }
    // Strictly above, to the next whole dollar. $5.00 gives $6.00; $5.40
    // gives $6.00 as well, because "above" is the part that cannot bend.
    (cents / 100 + 1) * 100
}

/// §130 — keep one parent's budget above what its children have claimed.
///
/// Called after any write that could have pushed a category's children past
/// it.
///
/// §137 — and it now CREATES the envelope when the parent has none. §130
/// deliberately did not: "inventing one because a child was budgeted would
/// put a number on the screen that nobody typed." Driving it settled the
/// argument the other way. The user's words: *"my goal here is to mainly budget off
/// of parent categories but be able to see the child categories as well"* —
/// and under that, an empty parent with budgeted children below it is the
/// hole in the screen, not the tidy option. The category has no envelope, and
/// the top totals are quietly made up of child rows.
///
/// A created envelope lands on the same floor a raised one would: the next
/// whole ten above what the children claim. It is an ordinary budget row —
/// typed over, or cleared, like any other. Clearing it and then editing a
/// child seeds it again, which is the price of the rule being automatic.
///
/// Returns the parent it raised or created, so the caller can say so.
fn raise_parent_to_cover_children(
    conn: &Conn,
    child_id: &str,
    month: &str,
) -> Result<Option<crate::models::RaisedParent>, String> {
    let parent: Option<(String, String)> = conn
        .query_row(
            "SELECT p.id, p.name FROM categories c JOIN categories p ON p.id = c.parent_id
              WHERE c.id = ?1",
            params![child_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((parent_id, parent_name)) = parent else {
        return Ok(None);
    };
    raise_budget_to_cover_children(conn, &parent_id, &parent_name, month)
}

/// §142 — the envelope itself, for a parent named directly.
///
/// Split out of `raise_parent_to_cover_children` because the invariant has
/// two ways to stop being true and only one was checked. See
/// `enforce_budget_envelope`.
fn raise_budget_to_cover_children(
    conn: &Conn,
    parent_id: &str,
    parent_name: &str,
    month: &str,
) -> Result<Option<crate::models::RaisedParent>, String> {
    let parent_id = parent_id.to_string();
    let parent_name = parent_name.to_string();
    // §131 — in MONTHLY cents, so a yearly child counts as its twelfth
    // rather than swamping a monthly parent with an annual figure.
    let claims: Vec<i64> = conn
        .prepare(
            "SELECT b.target_cents, b.period FROM budgets b
               JOIN categories c ON c.id = b.category_id
              WHERE c.parent_id = ?1 AND b.month_year = ?2",
        )
        .map_err(|e| e.to_string())?
        .query_map(params![parent_id, month], |r| {
            Ok(monthly_equivalent(r.get::<_, i64>(0)?, &r.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<i64>, _>>()
        .map_err(|e| e.to_string())?;
    // §155 — how many children HAVE a budget, apart from what they claim. A
    // child at zero claims nothing and still has one, and its parent shows
    // that zero rather than nothing (Z1).
    let children_budgeted = claims.len();
    let claimed: i64 = claims.iter().sum();

    // §150 — what the user asked for, if they ever asked for anything.
    let existing: Option<(i64, String, Option<i64>)> = conn
        .query_row(
            "SELECT target_cents, period, asked_for_cents FROM budgets
              WHERE category_id = ?1 AND month_year = ?2",
            params![parent_id, month],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    // §150 — the whole rule, in one line: the envelope is the LARGER of the
    // figure the user asked for and the figure its children need.
    //
    // §131's floor is what the children need; `asked_for` is the user's own. Neither
    // overwrites the other, so a parent grows to cover its children and then
    // settles back onto the user's figure when they shrink — which is what was chosen
    // when shown the two designs:
    //
    // > *"I like your last example where the original amount comes back, do
    // >  that"*
    let floor = if claimed > 0 { next_ten_above(claimed) } else { 0 };
    // In MONTHLY cents on both sides. `asked_for_cents` is stored in the
    // row's own period, so a yearly parent's $600 is $50 a month and must be
    // converted before it is compared with a monthly floor -- otherwise a
    // yearly figure wins every comparison by a factor of twelve.
    let asked = existing
        .as_ref()
        .and_then(|(_, period, a)| a.map(|a| monthly_equivalent(a, period)));
    let want = floor.max(asked.unwrap_or(0));

    // Nothing wanted and nothing asked for: no envelope. §137's rule, now
    // falling out of the arithmetic rather than being a special case.
    let Some((current, parent_period, _)) = existing else {
        if want <= 0 && children_budgeted == 0 {
            return Ok(None);
        }
        conn.execute(
            "INSERT INTO budgets (id, category_id, target_cents, month_year, period)
             VALUES (?1, ?2, ?3, ?4, 'monthly')",
            params![Uuid::new_v4().to_string(), parent_id, want, month],
        )
        .map_err(|e| e.to_string())?;
        // §155 — a zero seeded from a child at zero is written silently.
        if want <= 0 {
            return Ok(None);
        }
        return Ok(Some(crate::models::RaisedParent {
            category_id: parent_id,
            category_name: parent_name,
            target_cents: want,
            created: true,
        }));
    };

    // §154 — `asked` is `Some(0)` for a zero the user TYPED, and that is a budget
    // of nothing rather than no budget: it stays. Only an envelope nobody
    // asked for (`None`) goes when the children stop claiming.
    if want <= 0 && asked.is_none() && children_budgeted == 0 {
        // Nobody asked for one and the children have stopped claiming.
        conn.execute(
            "DELETE FROM budgets WHERE category_id = ?1 AND month_year = ?2",
            params![parent_id, month],
        )
        .map_err(|e| e.to_string())?;
        return Ok(Some(crate::models::RaisedParent {
            category_id: parent_id,
            category_name: parent_name,
            target_cents: 0,
            created: false,
        }));
    }

    if monthly_equivalent(current, &parent_period) == want {
        return Ok(None);
    }

    // Written back in the PARENT's own period: a yearly parent stays yearly.
    // `asked_for_cents` is deliberately NOT touched — the rule moves the
    // figure on the screen, never the one the user asked for.
    let raised = if parent_period == "yearly" { want * 12 } else { want };
    conn.execute(
        "UPDATE budgets SET target_cents = ?3 WHERE category_id = ?1 AND month_year = ?2",
        params![parent_id, month, raised],
    )
    .map_err(|e| e.to_string())?;
    // §155 — settling back onto a zero is not a raise either.
    if want <= 0 {
        return Ok(None);
    }
    Ok(Some(crate::models::RaisedParent {
        category_id: parent_id,
        category_name: parent_name,
        target_cents: raised,
        created: false,
    }))
}

/// §142 — the envelope rule applied to the line that was actually written,
/// whichever end of the relationship it sits on. The monthly twin of
/// `plan::enforce_envelope`; the reasoning is written out there.
///
/// Short version: `raise_parent_to_cover_children` raises the parent OF a
/// line, so it only ever fired when a CHILD was written. The Budget grid lets
/// a parent row be typed into as well, and a parent typed below its children
/// was accepted in silence.
fn enforce_budget_envelope(
    conn: &Conn,
    category_id: &str,
    month: &str,
) -> Result<Option<crate::models::RaisedParent>, String> {
    let own_name: Option<String> = conn
        .query_row(
            "SELECT c.name FROM categories c
              WHERE c.id = ?1
                AND EXISTS (SELECT 1 FROM categories k WHERE k.parent_id = c.id)",
            params![category_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let mine = match own_name {
        Some(name) => raise_budget_to_cover_children(conn, category_id, &name, month)?,
        None => None,
    };
    let theirs = raise_parent_to_cover_children(conn, category_id, month)?;
    Ok(mine.or(theirs))
}

/// §130 — every parent in a month, brought back above its children.
///
/// For the writes that set many lines at once (`apply_autobudget`), where
/// enforcing per row would raise the same parent repeatedly on the way to the
/// same answer. Returns how many parents moved.
pub fn raise_all_parents(conn: &Conn, month: &str) -> Result<u32, String> {
    // §142 — the parent's own name comes back with it, so this no longer has
    // to find "any one child" purely to name the parent to the old helper.
    let parents: Vec<(String, String)> = conn
        .prepare(
            "SELECT DISTINCT c.id, c.name FROM categories c
               JOIN categories ch ON ch.parent_id = c.id
               JOIN budgets b ON b.category_id = ch.id AND b.month_year = ?1",
        )
        .map_err(|e| e.to_string())?
        .query_map(params![month], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    let mut n = 0;
    for (parent_id, parent_name) in parents {
        if raise_budget_to_cover_children(conn, &parent_id, &parent_name, month)?.is_some() {
            n += 1;
        }
    }
    Ok(n)
}

/// Up to the next `step` cents. A budget of $383.17 helps nobody think.
fn round_up_to(cents: i64, step: i64) -> i64 {
    if cents <= 0 {
        return 0;
    }
    ((cents + step - 1) / step) * step
}

/// Money's Autobudget (§51): "takes up to a year of history plus scheduled
/// bills, proposes an amount per common category, you accept per line".
///
/// For each expense category with spending in the `lookback` months before
/// `month` (or an active scheduled bill): the average of the months that
/// had spending (an annual bill paid once is not spread — Money's rule,
/// which is why the scheduled amount is also there), the monthly
/// equivalent of its active recurrences, and the larger of the two rounded
/// up to the dollar as the proposal. Lines with a proposal of zero are
/// left out. Nothing is written; `apply_autobudget` does that.
pub fn autobudget(conn: &Conn, month: &str, lookback: u32) -> Result<Vec<AutobudgetLine>, String> {
    let (y, m) = parse_month(month)?;
    let lookback = lookback.clamp(1, 60) as i64;
    let (fy, fm) = crate::schedule::add_months(y, m, -lookback);
    let from = format!("{fy:04}-{fm:02}");
    let sql = format!("{CATEGORY_LINES}{}", r#"
        , by_month AS (
            SELECT category_id, substr(date, 1, 7) AS ym,
                   SUM(CASE WHEN amount_cents < 0 THEN -amount_cents ELSE 0 END) AS spent
              FROM lines
             WHERE category_id IS NOT NULL
               AND substr(date, 1, 7) >= ?1 AND substr(date, 1, 7) < ?2
             GROUP BY category_id, ym
            HAVING spent > 0
        ), hist AS (
            SELECT category_id, SUM(spent) AS total, COUNT(*) AS months FROM by_month GROUP BY category_id
        ), sched AS (
            SELECT category_id,
                   SUM(CASE freq
                         WHEN 'weekly'       THEN -amount_cents * 52 / (12 * interval_n)
                         WHEN 'semi_monthly' THEN -amount_cents * 2
                         WHEN 'monthly'      THEN -amount_cents / interval_n
                         WHEN 'yearly'       THEN -amount_cents / (12 * interval_n)
                         ELSE 0 END) AS monthly
              FROM recurrences
             WHERE is_active = 1 AND amount_cents < 0 AND category_id IS NOT NULL
               AND (end_date IS NULL OR end_date >= ?2 || '-01')
             GROUP BY category_id
        )
        SELECT c.id,
               CASE WHEN c.parent_id IS NULL THEN c.name ELSE p.name || ' : ' || c.name END,
               COALESCE(h.total, 0), COALESCE(h.months, 0), COALESCE(s.monthly, 0),
               b.target_cents
          FROM categories c
          LEFT JOIN categories p ON p.id = c.parent_id
          LEFT JOIN hist h ON h.category_id = c.id
          LEFT JOIN sched s ON s.category_id = c.id
          LEFT JOIN budgets b ON b.category_id = c.id AND b.month_year = ?2
         WHERE c.kind = 'expense' AND (h.total > 0 OR s.monthly > 0)
         ORDER BY 2 COLLATE NOCASE
    "#);
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![from, month], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, Option<i64>>(5)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(rows.len());
    for (category_id, category_name, total, months, scheduled, current) in rows {
        let average = if months > 0 { (total + months / 2) / months } else { 0 };
        let raw = average.max(scheduled);
        let suggested = (raw + 99) / 100 * 100;
        if suggested <= 0 {
            continue;
        }
        out.push(AutobudgetLine {
            category_id,
            category_name,
            average_cents: average,
            months_with_spending: months as u32,
            scheduled_cents: scheduled,
            suggested_cents: suggested,
            current_cents: current,
        });
    }
    Ok(out)
}

/// Write the accepted Autobudget lines for `month` and the `months - 1`
/// months after it (budgets are stored per month). Returns how many budget
/// rows were set.
pub fn apply_autobudget(
    conn: &Conn,
    month: &str,
    months: u32,
    lines: &[(String, i64)],
) -> Result<u32, String> {
    let (y, m) = parse_month(month)?;
    let months = months.clamp(1, 24);
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut n = 0;
    for k in 0..months as i64 {
        let (yy, mm) = crate::schedule::add_months(y, m, k);
        let ym = format!("{yy:04}-{mm:02}");
        for (category_id, cents) in lines {
            if *cents < 0 {
                return Err("a budget cannot be negative".into());
            }
            // §179 — a line the user accepted is a figure they ASKED FOR (§150), the
            // same as one they typed. Written without `asked_for_cents`, the
            // parent rule below read it as an envelope nobody asked for:
            // accept Automobile at $600 and Gasoline at $200 in Budget
            // starter, and `raise_all_parents` settled Automobile down to
            // the $210 its child needed.
            tx.execute(
                "INSERT INTO budgets (id, category_id, target_cents, month_year, asked_for_cents)
                 VALUES (?1, ?2, ?3, ?4, ?3)
                 ON CONFLICT (category_id, month_year)
                 DO UPDATE SET target_cents = excluded.target_cents,
                               asked_for_cents = excluded.target_cents",
                params![Uuid::new_v4().to_string(), category_id, cents, ym],
            )
            .map_err(|e| e.to_string())?;
            n += 1;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    // §130 — a run that budgeted children may have pushed them past their
    // parents. Reconciled once at the end rather than per row, which would
    // raise the same parent repeatedly on the way to the same answer.
    for k in 0..months as i64 {
        let (yy, mm) = crate::schedule::add_months(y, m, k);
        raise_all_parents(conn, &format!("{yy:04}-{mm:02}"))?;
    }
    Ok(n)
}

fn parse_month(month: &str) -> Result<(i32, u32), String> {
    let ok = month.len() == 7 && &month[4..5] == "-";
    let y = ok.then(|| month[..4].parse::<i32>().ok()).flatten();
    let m = ok.then(|| month[5..].parse::<u32>().ok()).flatten();
    match (y, m) {
        (Some(y), Some(m)) if (1..=12).contains(&m) => Ok((y, m)),
        _ => Err(format!("not a month: {month:?} (want YYYY-MM)")),
    }
}

/// The `SELECT` behind every Budget the API returns — the join that turns the
/// stored `category_id` back into the display name.
const BUDGET_SELECT: &str = r#"
    SELECT b.id,
           b.category_id,
           CASE WHEN c.parent_id IS NULL THEN c.name
                ELSE p.name || ' : ' || c.name END AS category_name,
           b.target_cents,
           b.month_year
      FROM budgets b
      JOIN categories c ON c.id = b.category_id
      LEFT JOIN categories p ON p.id = c.parent_id
"#;

fn map_budget(row: &Row) -> rusqlite::Result<Budget> {
    Ok(Budget {
        id: row.get(0)?,
        category_id: row.get(1)?,
        category_name: row.get(2)?,
        target_cents: row.get(3)?,
        month_year: row.get(4)?,
    })
}

/// Set (or update) the budget for a category in a month.
///
/// Takes a category **id**, not a name: the old name-keyed version happily
/// created a junk category from whatever was typed, and a later rename
/// orphaned the budget.
/// §130 — `set_budget`, then keep the parent above its children.
///
/// The Budget screen writes through this rather than `set_budget` so the rule
/// holds wherever a person types, and so the screen can say what it did. The
/// bare `set_budget` stays for callers that set a whole month at once and
/// reconcile afterwards (`apply_autobudget`).
pub fn set_budget_line(
    conn: &Conn,
    category_id: &str,
    target_cents: i64,
    month_year: &str,
    period: &str,
) -> Result<crate::models::BudgetWrite, String> {
    if !matches!(period, "monthly" | "yearly") {
        return Err(format!("{period:?} is not a budget period (want monthly or yearly)"));
    }
    let budget = set_budget(conn, category_id, target_cents, month_year)?;
    conn.execute(
        "UPDATE budgets SET period = ?3 WHERE category_id = ?1 AND month_year = ?2",
        params![category_id, month_year, period],
    )
    .map_err(|e| e.to_string())?;
    let raised = enforce_budget_envelope(conn, category_id, month_year)?;
    Ok(crate::models::BudgetWrite { budget, raised })
}

pub fn set_budget(
    conn: &Conn,
    category_id: &str,
    target_cents: i64,
    month_year: &str,
) -> Result<Budget, String> {
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM categories WHERE id = ?1)",
            params![category_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        return Err("category not found".into());
    }
    let id = Uuid::new_v4().to_string();
    // §150 — a figure written HERE is what the user ASKED FOR, and it is kept even
    // while the children push the envelope above it. It is the floor the
    // parent returns to when they stop claiming.
    conn.execute(
        "INSERT INTO budgets (id, category_id, target_cents, month_year, asked_for_cents)
         VALUES (?1, ?2, ?3, ?4, ?3)
         ON CONFLICT (category_id, month_year)
         DO UPDATE SET target_cents = excluded.target_cents,
                       asked_for_cents = excluded.target_cents",
        params![id, category_id, target_cents, month_year],
    )
    .map_err(|e| e.to_string())?;

    let sql = format!("{BUDGET_SELECT} WHERE b.category_id = ?1 AND b.month_year = ?2");
    conn.query_row(&sql, params![category_id, month_year], map_budget)
        .map_err(|e| e.to_string())
}

/// All budgets for a month, ordered by display name.
pub fn list_budgets(conn: &Conn, month_year: &str) -> Result<Vec<Budget>, String> {
    let sql = format!(
        "{BUDGET_SELECT} WHERE b.month_year = ?1 ORDER BY category_name COLLATE NOCASE"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let out = stmt
        .query_map(params![month_year], map_budget)
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    Ok(out)
}

/// Delete a single budget entry.
pub fn delete_budget(conn: &Conn, id: &str) -> Result<(), String> {
    // §155 — Z2. The row's parent is re-checked after it goes: an envelope
    // this child alone was holding up comes back down to what the user asked for,
    // or goes if they never asked and nothing else is claiming.
    let owner: Option<(String, String)> = conn
        .query_row(
            "SELECT category_id, month_year FROM budgets WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM budgets WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    if let Some((category_id, month)) = owner {
        raise_parent_to_cover_children(conn, &category_id, &month)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::models::NewRecurrence;
    use rusqlite::params;
    use super::*;
    use crate::db::queries::test_support::*;

    #[test]
    fn autobudget_proposes_from_history_and_scheduled_bills_and_applies_per_month() {
        let db = TestDb::new("autobudget");
        let c = db.conn();
        let chk = account(&c, "Checking", 1_000_000);
        let groc = create_category(&c, "Groceries", "expense", None, None).unwrap().id;
        let elec = create_category(&c, "Electric", "expense", None, None).unwrap().id;
        let gift = create_category(&c, "Gifts", "expense", None, None).unwrap().id;
        let pay = create_category(&c, "Salary", "income", None, None).unwrap().id;
        // Groceries: three months of history, uneven.
        create_transaction(&c, &chk, "2026-06-05", "Store", Some(&groc), -40_000, None, None).unwrap();
        create_transaction(&c, &chk, "2026-06-20", "Store", Some(&groc), -20_010, None, None).unwrap();
        create_transaction(&c, &chk, "2026-07-05", "Store", Some(&groc), -50_000, None, None).unwrap();
        create_transaction(&c, &chk, "2026-08-05", "Store", Some(&groc), -30_000, None, None).unwrap();
        // Electric: history says 90, the scheduled bill says 120 — the bill wins.
        create_transaction(&c, &chk, "2026-08-10", "Power", Some(&elec), -9_000, None, None).unwrap();
        create_recurrence(&c, &NewRecurrence { payee: "Power".into(), amount_cents: -12_000, account_id: Some(chk.clone()), category_id: Some(elec.clone()), freq: "monthly".into(), interval_n: 1, start_date: "2026-01-10".into(), end_date: None, second_day: None, weekend_rule: "none".into(), notes: None , transfer_account_id: None, goal_id: None,}).unwrap();
        // Gifts: a single annual bill, 600/yr → 50/month, no history.
        create_recurrence(&c, &NewRecurrence { payee: "Birthday".into(), amount_cents: -60_000, account_id: Some(chk.clone()), category_id: Some(gift.clone()), freq: "yearly".into(), interval_n: 1, start_date: "2026-12-01".into(), end_date: None, second_day: None, weekend_rule: "none".into(), notes: None , transfer_account_id: None, goal_id: None,}).unwrap();
        // Income and old history are not in it.
        create_transaction(&c, &chk, "2026-08-01", "Employer", Some(&pay), 300_000, None, None).unwrap();
        create_transaction(&c, &chk, "2024-08-01", "Store", Some(&groc), -999_900, None, None).unwrap();
        set_budget(&c, &groc, 25_000, "2026-09").unwrap();

        let lines = autobudget(&c, "2026-09", 12).unwrap();
        let names: Vec<&str> = lines.iter().map(|l| l.category_name.as_str()).collect();
        assert_eq!(names, vec!["Electric", "Gifts", "Groceries"]);
        let g = &lines[2];
        // (60,010 + 50,000 + 30,000) / 3 = 46,670 → rounded up to 46,700.
        assert_eq!((g.average_cents, g.months_with_spending, g.scheduled_cents, g.suggested_cents, g.current_cents), (46_670, 3, 0, 46_700, Some(25_000)));
        assert_eq!((lines[0].average_cents, lines[0].scheduled_cents, lines[0].suggested_cents), (9_000, 12_000, 12_000));
        assert_eq!((lines[1].months_with_spending, lines[1].suggested_cents), (0, 5_000));
        // A short lookback leaves June out.
        let l2 = autobudget(&c, "2026-09", 2).unwrap();
        assert_eq!(l2.iter().find(|l| l.category_id == groc).unwrap().average_cents, 40_000);

        // Accept two lines for three months.
        let n = apply_autobudget(&c, "2026-09", 3, &[(groc.clone(), 46_700), (elec.clone(), 12_000)]).unwrap();
        assert_eq!(n, 6);
        for ym in ["2026-09", "2026-10", "2026-11"] {
            let b = list_budgets(&c, ym).unwrap();
            let got: Vec<(String, i64)> = b.iter().map(|x| (x.category_name.clone(), x.target_cents)).collect();
            assert_eq!(got, vec![("Electric".to_string(), 12_000), ("Groceries".to_string(), 46_700)], "{ym}");
        }
        assert!(list_budgets(&c, "2026-12").unwrap().is_empty());
        assert!(autobudget(&c, "2026-9", 12).is_err());
    }

    /// §129 — every expense category is a row, budgeted or not, because
    /// setting a budget has to be typing into a row you can already see.
    ///
    /// (The rollup rule this test used to pin was §129's carve-out. §130
    /// replaced it; `a_parent_carries_all_of_its_childrens_spending_even_when_they_budget`
    /// is where that behavior is asserted now.)
    #[test]
    fn every_expense_category_is_a_row_whether_or_not_it_is_budgeted() {
        let db = TestDb::new("budget-rows");
        let c = db.conn();
        let auto = create_category(&c, "Automobile", "expense", None, None).unwrap().id;
        let fuel = create_category(&c, "Fuel", "expense", Some(&auto), None).unwrap().id;
        let income = create_category(&c, "Bonus", "income", None, None).unwrap().id;
        set_budget(&c, &auto, 60_000, "2026-09").unwrap();

        let g = budget_grid(&c, "2026-09").unwrap();
        let f = g.lines.iter().find(|l| l.category_id == fuel).expect("an untouched child is still a row");
        assert!(!f.has_budget && f.target_cents == 0 && f.spent_cents == 0);
        assert_eq!(f.full_name, "Automobile : Fuel");
        assert_eq!(f.parent_id.as_deref(), Some(auto.as_str()));
        assert!(
            g.lines.iter().all(|l| l.category_id != income),
            "income is not spending and has no place on a spending budget"
        );
        assert!(g.total_lines >= 2);
    }

    /// §130 — a parent is the envelope for the WHOLE category, and its
    /// children are allocations inside it rather than escapes from it.
    ///
    /// This reverses §129's carve-out, which shipped for a day. Both are
    /// defensible; the user looked at it running and chose this one.
    #[test]
    fn a_parent_carries_all_of_its_childrens_spending_even_when_they_budget() {
        let db = TestDb::new("budget-envelope");
        let c = db.conn();
        let acct = account(&c, "Checking", 1_000_000);
        let auto = create_category(&c, "Automobile", "expense", None, None).unwrap().id;
        let fuel = create_category(&c, "Fuel", "expense", Some(&auto), None).unwrap().id;
        let repairs = create_category(&c, "Repairs", "expense", Some(&auto), None).unwrap().id;
        for (cat, cents) in [(&auto, -2_000i64), (&fuel, -10_000), (&repairs, -5_000)] {
            let t = create_transaction(&c, &acct, "2026-09-05", "Shop", None, cents, None, None).unwrap();
            update_transaction(&c, &t.id, "2026-09-05", "Shop", Some(cat.as_str()), cents, None, None).unwrap();
        }
        let line = |g: &crate::models::BudgetGrid, id: &str| -> crate::models::BudgetLine {
            g.lines.iter().find(|l| l.category_id == id).cloned().expect("line")
        };

        set_budget(&c, &auto, 60_000, "2026-09").unwrap();
        set_budget_line(&c, &fuel, 20_000, "2026-09", "monthly").unwrap();
        let g = budget_grid(&c, "2026-09").unwrap();

        // The parent still carries the fuel — that is the whole change.
        let a = line(&g, &auto);
        assert_eq!((a.own_cents, a.rolled_cents, a.spent_cents), (2_000, 15_000, 17_000));
        assert_eq!(a.children_budgeted_cents, 20_000, "fuel's allocation, shown on the parent");
        assert!(a.counts_in_total);

        // The child is an allocation INSIDE the parent, so it must not be
        // added to the totals again — the double count moved from the spend
        // to the target when the rule flipped.
        let f = line(&g, &fuel);
        assert!(f.has_budget && !f.counts_in_total);
        assert_eq!(g.budgeted_cents, 60_000, "not 80,000 — the child is inside the parent");
        assert_eq!(g.spent_cents, 17_000, "and the same money is still counted once");

        // §137 — a budgeted child under an UNBUDGETED parent no longer counts
        // on its own: the write gives the parent an envelope ($30 of children
        // -> $40), and the child is inside it like any other. §130 left the
        // parent empty and let the child stand alone; the user drove it and asked
        // for the envelope, because "mainly budget off of parent categories"
        // does not work when a parent's box is blank and the top total is
        // made of its children.
        let solo = create_category(&c, "Books", "expense", None, None).unwrap().id;
        let novels = create_category(&c, "Novels", "expense", Some(&solo), None).unwrap().id;
        let w = set_budget_line(&c, &novels, 3_000, "2026-09", "monthly").unwrap();
        let made = w.raised.expect("the parent should have been given an envelope");
        assert!(made.created, "created, not raised");
        // §146 — $31, not $40. A $30 child does not justify a $40 envelope.
        assert_eq!(made.target_cents, 3_100);
        let g = budget_grid(&c, "2026-09").unwrap();
        assert!(!line(&g, &novels).counts_in_total, "it is inside Books now");
        assert!(line(&g, &solo).counts_in_total);
        assert_eq!(g.budgeted_cents, 63_100, "$600 of Automobile plus $31 of Books");
    }

    /// §147 — the Bills sequence from walkthrough B4.
    ///
    /// The Bills parent was set to 200, then Cellular 100 and Electricity 150
    /// raised it, then a larger Mortgage raised it again. Setting Mortgage
    /// back to 0 (there was no way to delete it) left Bills at the raised
    /// figure: once a mistake was made, the parent never corrected.
    #[test]
    fn a_parent_the_rule_raised_comes_back_down_when_its_children_do() {
        let db = TestDb::new("envelope-lower");
        let c = db.conn();
        let bills = create_category(&c, "Bills", "expense", None, None).unwrap().id;
        let cell = create_category(&c, "Cellular", "expense", Some(&bills), None).unwrap().id;
        let power = create_category(&c, "Electricity", "expense", Some(&bills), None).unwrap().id;
        let mtge = create_category(&c, "Mortgage", "expense", Some(&bills), None).unwrap().id;

        let at = |id: &str| -> i64 {
            budget_grid(&c, "2026-09")
                .unwrap()
                .lines
                .iter()
                .find(|l| l.category_id == id)
                .map(|l| l.target_cents)
                .unwrap_or(0)
        };

        // The user typed 200 into the parent directly.
        set_budget_line(&c, &bills, 20_000, "2026-09", "monthly").unwrap();
        assert_eq!(at(&bills), 20_000);

        // Two children, 100 and 150: 250 claimed, so the envelope is pushed
        // to 260 and the rule now owns the figure.
        set_budget_line(&c, &cell, 10_000, "2026-09", "monthly").unwrap();
        set_budget_line(&c, &power, 15_000, "2026-09", "monthly").unwrap();
        assert_eq!(at(&bills), 26_000, "$250 claimed -> $260");

        // Mortgage 1,200: 1,450 claimed -> 1,460.
        set_budget_line(&c, &mtge, 120_000, "2026-09", "monthly").unwrap();
        assert_eq!(at(&bills), 146_000);

        // THE BUG. Mortgage back to 0 -- the claim drops to 250, and the
        // envelope must follow it down.
        let w = set_budget_line(&c, &mtge, 0, "2026-09", "monthly").unwrap();
        assert_eq!(at(&bills), 26_000, "the parent corrects; it used to stay at 1,460");
        assert!(w.raised.is_some(), "and it says so");

        // §150 — every child back to nothing, and the typed 200 COMES BACK.
        // It was never overwritten, only outgrown:
        //
        // The better behavior: the original amount comes back.
        //
        // §147 threw the 200 away the moment the children outgrew it, so
        // this used to leave Bills with no envelope at all.
        set_budget_line(&c, &cell, 0, "2026-09", "monthly").unwrap();
        set_budget_line(&c, &power, 0, "2026-09", "monthly").unwrap();
        assert_eq!(at(&bills), 20_000, "back to the 200 typed in the first place");
    }

    /// §150 — and a parent nobody ever typed still disappears, because there
    /// is no figure to fall back to. §137's rule, falling out of the
    /// arithmetic rather than being a special case.
    #[test]
    fn an_envelope_nobody_asked_for_goes_when_its_children_stop_claiming() {
        let db = TestDb::new("envelope-unasked");
        let c = db.conn();
        let home = create_category(&c, "Home", "expense", None, None).unwrap().id;
        let rent = create_category(&c, "Rent", "expense", Some(&home), None).unwrap().id;

        // Home has never been typed into. Budgeting Rent seeds it (§137).
        set_budget_line(&c, &rent, 150_000, "2026-09", "monthly").unwrap();
        let g = budget_grid(&c, "2026-09").unwrap();
        assert!(g.lines.iter().find(|l| l.category_id == home).unwrap().has_budget);

        // §155 — Rent at ZERO is still a budget, and Home shows that zero (Z1).
        let w = set_budget_line(&c, &rent, 0, "2026-09", "monthly").unwrap();
        let g = budget_grid(&c, "2026-09").unwrap();
        let home_line = g.lines.iter().find(|l| l.category_id == home).unwrap();
        assert!(home_line.has_budget, "a child at zero gives its parent a zero");
        assert_eq!(home_line.target_cents, 0);

        // Rent CLEARED, and the seeded envelope goes with it (Z2).
        delete_budget(&c, &w.budget.id).unwrap();
        let g = budget_grid(&c, "2026-09").unwrap();
        assert!(
            !g.lines.iter().find(|l| l.category_id == home).unwrap().has_budget,
            "nothing claimed and nothing asked for, so no envelope"
        );
    }

    /// §154 — a zero someone typed into a parent is a budget of nothing, not no
    /// budget. The branch above used to delete it too, reading "nothing
    /// wanted" as "nothing asked for"; only a NULL `asked_for` is that.
    #[test]
    fn a_zero_he_typed_into_a_parent_stays() {
        let db = TestDb::new("envelope-typed-zero");
        let c = db.conn();
        let home = create_category(&c, "Home", "expense", None, None).unwrap().id;
        let rent = create_category(&c, "Rent", "expense", Some(&home), None).unwrap().id;
        let home_line = || {
            let g = budget_grid(&c, "2026-09").unwrap();
            let l = g.lines.iter().find(|l| l.category_id == home).unwrap().clone();
            (l.has_budget, l.target_cents)
        };

        set_budget_line(&c, &home, 0, "2026-09", "monthly").unwrap();
        assert_eq!(home_line(), (true, 0), "typing 0 into a parent is a budget of nothing, and it must stay");

        // Its child claims and then stops: the typed zero is what it settles onto.
        set_budget_line(&c, &rent, 150_000, "2026-09", "monthly").unwrap();
        assert_eq!(home_line().1, 151_000, "$1,500 claimed -> $1,510");
        set_budget_line(&c, &rent, 0, "2026-09", "monthly").unwrap();
        assert_eq!(home_line(), (true, 0), "the typed zero is still underneath");

        // §155 — Z2: cleared rather than zeroed, and it is still the typed zero.
        let w = set_budget_line(&c, &rent, 150_000, "2026-09", "monthly").unwrap();
        assert_eq!(home_line().1, 151_000);
        delete_budget(&c, &w.budget.id).unwrap();
        assert_eq!(home_line(), (true, 0), "clearing the child ran no envelope check before");
    }

    /// §147 — and the other half, which is why this could not simply be
    /// "the parent always equals its children": deliberate headroom survives.
    ///
    /// §130's whole point is that a parent covers the things nobody
    /// itemized. A figure someone typed is raised when the children outgrow it and
    /// is never reduced.
    #[test]
    fn a_parent_he_typed_is_never_pulled_down() {
        let db = TestDb::new("envelope-keep");
        let c = db.conn();
        let auto = create_category(&c, "Automobile", "expense", None, None).unwrap().id;
        let fuel = create_category(&c, "Fuel", "expense", Some(&auto), None).unwrap().id;

        let at = |id: &str| -> i64 {
            budget_grid(&c, "2026-09")
                .unwrap()
                .lines
                .iter()
                .find(|l| l.category_id == id)
                .map(|l| l.target_cents)
                .unwrap_or(0)
        };

        // $900 of deliberate envelope over a $300 child.
        set_budget_line(&c, &fuel, 30_000, "2026-09", "monthly").unwrap();
        set_budget_line(&c, &auto, 90_000, "2026-09", "monthly").unwrap();
        assert_eq!(at(&auto), 90_000);

        // The child shrinks. The envelope is the user's and stays put.
        set_budget_line(&c, &fuel, 10_000, "2026-09", "monthly").unwrap();
        assert_eq!(at(&auto), 90_000, "the user's headroom is not the rule's to spend");

        // Even to nothing: a deliberate $900 for a category whose children
        // are all blank is a perfectly good budget.
        set_budget_line(&c, &fuel, 0, "2026-09", "monthly").unwrap();
        assert_eq!(at(&auto), 90_000);

        // It still gives way when the children outgrow it — but §150 keeps
        // the typed 900 underneath, so when they shrink it settles back onto THAT
        // figure rather than onto theirs. §147 returned 310 here, having
        // discarded the 900 on the way up.
        set_budget_line(&c, &fuel, 200_000, "2026-09", "monthly").unwrap();
        assert_eq!(at(&auto), 201_000, "the children need more than was asked for");
        set_budget_line(&c, &fuel, 30_000, "2026-09", "monthly").unwrap();
        assert_eq!(at(&auto), 90_000, "and the typed 900 is still underneath it");
    }

    /// §130 — the user's rule: the parent lands on a whole ten STRICTLY above what
    /// its children claim, so there is always something left for the things
    /// nobody itemized.
    #[test]
    fn a_parent_is_raised_to_the_next_whole_ten_above_its_children() {
        assert_eq!(next_ten_above(61_234), 62_000, "$612.34 of children -> $620.00");
        assert_eq!(next_ten_above(61_000), 62_000, "exactly $610.00 still goes up");

        // §146 — and never by more than a tenth. Walking B4b: a $60-a-year
        // child is $5 a month, and the next whole ten above $5 is $10 — a
        // parent at DOUBLE its only child, which is not what "land slightly
        // higher" means. Above it still goes; by a whole dollar, not a whole
        // ten.
        assert_eq!(next_ten_above(500), 600, "$5 -> $6, not $10");
        assert_eq!(next_ten_above(833), 900, "$8.33 -> $9, not $10");
        assert_eq!(next_ten_above(9_100), 10_000, "$91 -> $100 costs under a tenth, so the ten stands");
        assert_eq!(next_ten_above(0), 100);

        let db = TestDb::new("budget-raise");
        let c = db.conn();
        let auto = create_category(&c, "Automobile", "expense", None, None).unwrap().id;
        let fuel = create_category(&c, "Fuel", "expense", Some(&auto), None).unwrap().id;
        let repairs = create_category(&c, "Repairs", "expense", Some(&auto), None).unwrap().id;
        set_budget(&c, &auto, 60_000, "2026-09").unwrap();

        // Well under the parent: nothing moves, and nothing is reported.
        let w = set_budget_line(&c, &fuel, 20_000, "2026-09", "monthly").unwrap();
        assert!(w.raised.is_none(), "$200 of a $600 envelope needs no help");

        // §131 — the parent must be at least the next whole ten ABOVE what
        // its children claim, not merely more than the bare total. $650.00 of
        // children makes the parent $660.00 even from $655.00, which §130
        // would have left alone because 655 > 650.
        set_budget(&c, &auto, 65_500, "2026-09").unwrap();
        let w = set_budget_line(&c, &repairs, 45_000, "2026-09", "monthly").unwrap();
        let raised = w.raised.expect("the parent should have been raised");
        assert_eq!(raised.category_name, "Automobile");
        assert_eq!(raised.target_cents, 66_000, "$650.00 claimed -> $660.00");

        // And a parent already above the floor is left exactly as it is.
        set_budget(&c, &auto, 70_000, "2026-09").unwrap();
        let w = set_budget_line(&c, &repairs, 45_000, "2026-09", "monthly").unwrap();
        assert!(w.raised.is_none(), "$700 already clears the $660 floor");
        set_budget(&c, &auto, 66_000, "2026-09").unwrap();
        let g = budget_grid(&c, "2026-09").unwrap();
        assert_eq!(g.lines.iter().find(|l| l.category_id == auto).unwrap().target_cents, 66_000);
        assert_eq!(g.budgeted_cents, 66_000, "the envelope, not the envelope plus its parts");

        // §137 — a parent with NO budget is given one, on the same floor a
        // raise would land on. This reverses §130's refusal to invent a
        // number; see the note on `raise_parent_to_cover_children`.
        let home = create_category(&c, "Home", "expense", None, None).unwrap().id;
        let rent = create_category(&c, "Rent", "expense", Some(&home), None).unwrap().id;
        let w = set_budget_line(&c, &rent, 150_000, "2026-09", "monthly").unwrap();
        let made = w.raised.expect("Home should have been given an envelope");
        assert!(made.created);
        assert_eq!((made.category_name.as_str(), made.target_cents), ("Home", 151_000));
        let g = budget_grid(&c, "2026-09").unwrap();
        let h = g.lines.iter().find(|l| l.category_id == home).unwrap();
        assert!(h.has_budget && h.period == "monthly", "monthly: the floor is a monthly figure");
        assert_eq!(h.target_cents, 151_000);

        // And a second write to the same child does not create it twice — it
        // is now an ordinary budget row taking the ordinary path.
        let w = set_budget_line(&c, &rent, 150_000, "2026-09", "monthly").unwrap();
        assert!(w.raised.is_none(), "$1,510 already clears the floor");

        // §137 — nothing claimed, nothing to cover: a child at zero must not
        // leave a $10 envelope behind, and must not push a deliberate $0
        // parent up to $10 either. §155 (Z1) — it DOES give its parent a
        // zero, silently, so the two rows read the same; only clearing the
        // child takes that away.
        let empty = create_category(&c, "Gifts", "expense", None, None).unwrap().id;
        let birthdays = create_category(&c, "Birthdays", "expense", Some(&empty), None).unwrap().id;
        let w = set_budget_line(&c, &birthdays, 0, "2026-09", "monthly").unwrap();
        assert!(w.raised.is_none(), "a zero is not a raise, and nothing is announced");
        let g = budget_grid(&c, "2026-09").unwrap();
        let gifts = g.lines.iter().find(|l| l.category_id == empty).unwrap();
        assert!(gifts.has_budget, "the child's zero, at the parent too (Z1)");
        assert_eq!(gifts.target_cents, 0, "zero, not next_ten_above(0)'s $10");
        delete_budget(&c, &w.budget.id).unwrap();
        let g = budget_grid(&c, "2026-09").unwrap();
        assert!(!g.lines.iter().find(|l| l.category_id == empty).unwrap().has_budget, "cleared: gone");
    }

    /// §142 — the monthly twin of `plan::typing_into_a_parent_below_its_
    /// children_raises_it_back`: the rule above fired when a CHILD was
    /// written and never when the parent itself was.
    ///
    /// Both grids let a parent row be typed into, and the user has said budgeting
    /// off parents is how they work, so this is the likelier of the two edits
    /// and it was the unguarded one.
    #[test]
    fn typing_into_a_parent_below_its_children_raises_it_back() {
        let db = TestDb::new("budget-raise-parent");
        let c = db.conn();
        let auto = create_category(&c, "Automobile", "expense", None, None).unwrap().id;
        let fuel = create_category(&c, "Fuel", "expense", Some(&auto), None).unwrap().id;
        let repairs = create_category(&c, "Repairs", "expense", Some(&auto), None).unwrap().id;

        set_budget_line(&c, &fuel, 30_000, "2026-09", "monthly").unwrap();
        set_budget_line(&c, &repairs, 20_000, "2026-09", "monthly").unwrap();

        // $500 of children, so the envelope stands at $510.
        let g = budget_grid(&c, "2026-09").unwrap();
        assert_eq!(g.lines.iter().find(|l| l.category_id == auto).unwrap().target_cents, 51_000);

        // Type $200 straight into the parent. It cannot stand.
        let w = set_budget_line(&c, &auto, 20_000, "2026-09", "monthly").unwrap();
        let raised = w.raised.expect("the row just written should have been raised");
        assert_eq!(raised.category_id, auto);
        assert!(!raised.created);
        assert_eq!(raised.target_cents, 51_000, "$500 claimed -> $510");

        let g = budget_grid(&c, "2026-09").unwrap();
        assert_eq!(g.lines.iter().find(|l| l.category_id == auto).unwrap().target_cents, 51_000);

        // Above the floor is left alone: the rule is a floor, not a target.
        let w = set_budget_line(&c, &auto, 90_000, "2026-09", "monthly").unwrap();
        assert!(w.raised.is_none(), "$900 already clears the $510 floor");
        let g = budget_grid(&c, "2026-09").unwrap();
        assert_eq!(g.lines.iter().find(|l| l.category_id == auto).unwrap().target_cents, 90_000);
    }

    /// §142 — a yearly parent typed too low is raised IN ITS OWN PERIOD, so
    /// correcting the figure never quietly converts it to a monthly one
    /// (§131). The stored number is annual; the floor it has to clear is
    /// monthly.
    #[test]
    fn a_yearly_parent_raised_to_cover_its_children_stays_yearly() {
        let db = TestDb::new("budget-raise-parent-yearly");
        let c = db.conn();
        let auto = create_category(&c, "Automobile", "expense", None, None).unwrap().id;
        let reg = create_category(&c, "Registration", "expense", Some(&auto), None).unwrap().id;

        // $1,200 a year of children is $100 a month, so the floor is $110.
        set_budget_line(&c, &reg, 120_000, "2026-09", "yearly").unwrap();
        // Type $600 a year into the parent: $50 a month, under the floor.
        let w = set_budget_line(&c, &auto, 60_000, "2026-09", "yearly").unwrap();
        let raised = w.raised.expect("raised");
        assert_eq!(raised.target_cents, 132_000, "$110 a month, written back as a year");

        let g = budget_grid(&c, "2026-09").unwrap();
        let p = g.lines.iter().find(|l| l.category_id == auto).unwrap();
        assert_eq!(p.period, "yearly", "raising it must not demote it to monthly");
        assert_eq!(p.target_cents, 132_000);
    }

    /// §142 — `set_budget`, the pre-§130 command, wrote the row and ran no
    /// envelope rule at all. Two registered commands writing the same table
    /// with different rules is the kind of thing that is only ever found by
    /// whichever caller picked the wrong one.
    #[test]
    fn the_older_single_budget_write_keeps_the_envelope_too() {
        let db = TestDb::new("budget-legacy-write");
        let c = db.conn();
        let auto = create_category(&c, "Automobile", "expense", None, None).unwrap().id;
        let fuel = create_category(&c, "Fuel", "expense", Some(&auto), None).unwrap().id;

        set_budget_line(&c, &fuel, 30_000, "2026-09", "monthly").unwrap();

        // What `commands::set_budget` now does: read the period, write
        // through the guarded path.
        set_budget_line(&c, &auto, 5_000, "2026-09", "monthly").unwrap();
        let g = budget_grid(&c, "2026-09").unwrap();
        assert_eq!(
            g.lines.iter().find(|l| l.category_id == auto).unwrap().target_cents,
            31_000,
            "$50 typed over $300 of children is not an envelope"
        );
    }

    /// §131 — a cost you only ever know annually.
    ///
    /// > *"I know tracking under Automobile is about 100 per year but that
    /// > ends up in the monthly budget and is wrong"*
    #[test]
    fn a_yearly_budget_keeps_its_figure_and_is_measured_against_the_year() {
        assert_eq!(monthly_equivalent(10_000, "yearly"), 833, "$100 a year is $8.33 a month");
        assert_eq!(monthly_equivalent(10_000, "monthly"), 10_000);
        assert_eq!(monthly_equivalent(0, "yearly"), 0);

        let db = TestDb::new("budget-yearly");
        let c = db.conn();
        let acct = account(&c, "Checking", 1_000_000);
        let auto = create_category(&c, "Automobile", "expense", None, None).unwrap().id;
        let reg = create_category(&c, "Registration", "expense", Some(&auto), None).unwrap().id;

        // The whole year's registration, paid in March.
        let t = create_transaction(&c, &acct, "2026-03-11", "DMV", None, -10_000, None, None).unwrap();
        update_transaction(&c, &t.id, "2026-03-11", "DMV", Some(&reg), -10_000, None, None).unwrap();

        set_budget_line(&c, &reg, 10_000, "2026-09", "yearly").unwrap();
        let g = budget_grid(&c, "2026-09").unwrap();
        let r = g.lines.iter().find(|l| l.category_id == reg).unwrap();

        // The amount is the one the user thinks in; the twelfth is derived.
        assert_eq!(r.target_cents, 10_000);
        assert_eq!(r.period, "yearly");
        assert_eq!(r.monthly_cents, 833);

        // Measured against the YEAR: paid in March, so in September it is
        // fully spent and exactly on budget — NOT $91.67 overspent.
        assert_eq!(r.spent_cents, 10_000, "the year's spending");
        assert_eq!(r.spent_month_cents, 0, "and nothing in September");
        assert_eq!(r.remaining_cents, 0);

        // The strip is monthly, so nothing here counts $100 of budget in a
        // month that saw none of it. §137: Automobile had no envelope and now
        // has one — the next whole ten above the child's $8.33 twelfth — so
        // the strip reads $9.00 of Automobile rather than the bare $8.33 of
        // Registration.
        //
        // §146 — this used to read $20.00, and the comment here used to argue
        // that the overshoot was "the direction the user wants budgets to err in".
        // The user drove it (B4b) and said otherwise: *"that's not correct, it
        // should have been 70 at most right?"* A rule that lands slightly
        // higher must not land at double. It now rounds up by a whole dollar
        // when a whole ten would cost more than a tenth.
        let a = g.lines.iter().find(|l| l.category_id == auto).unwrap();
        assert!(a.has_budget && a.period == "monthly");
        assert_eq!(a.target_cents, 900);
        assert_eq!(g.budgeted_cents, 900);
        assert_eq!(g.spent_cents, 0);

        // In March itself the month's spending is real, but the line still
        // reads against the year rather than shouting.
        let g = budget_grid(&c, "2026-03").unwrap();
        let r = g.lines.iter().find(|l| l.category_id == reg).unwrap();
        assert!(!r.has_budget, "budgets are per month; September's is September's");
        assert_eq!(r.spent_month_cents, 10_000);
    }

    /// §131 — a yearly child counts as a twelfth when its parent's envelope is
    /// checked, or one annual figure would swamp a monthly parent.
    #[test]
    fn a_yearly_child_claims_only_a_twelfth_of_its_parents_envelope() {
        let db = TestDb::new("budget-yearly-envelope");
        let c = db.conn();
        let auto = create_category(&c, "Automobile", "expense", None, None).unwrap().id;
        let reg = create_category(&c, "Registration", "expense", Some(&auto), None).unwrap().id;
        set_budget(&c, &auto, 60_000, "2026-09").unwrap();

        // $100 a YEAR — $8.33 a month — must not raise a $600 parent.
        let w = set_budget_line(&c, &reg, 10_000, "2026-09", "yearly").unwrap();
        assert!(w.raised.is_none(), "a twelfth of $100 does not trouble $600");
        let g = budget_grid(&c, "2026-09").unwrap();
        let a = g.lines.iter().find(|l| l.category_id == auto).unwrap();
        assert_eq!(a.target_cents, 60_000);
        assert_eq!(a.children_budgeted_cents, 10_000, "shown as typed");

        // The same number as a MONTHLY child does trouble it.
        set_budget_line(&c, &reg, 10_000, "2026-09", "monthly").unwrap();
        let w = set_budget_line(&c, &reg, 100_000, "2026-09", "monthly").unwrap();
        let raised = w.raised.expect("$1,000 a month is more than a $600 envelope");
        assert_eq!(raised.target_cents, 101_000);
    }

    /// A budget of zero says "spend nothing here". No budget says nothing at
    /// all. The screen draws them differently, so they cannot share a field.
    #[test]
    fn a_zero_budget_is_not_the_same_as_no_budget() {
        let db = TestDb::new("budget-zero");
        let c = db.conn();
        let dining = create_category(&c, "Dining Out", "expense", None, None).unwrap().id;
        let travel = create_category(&c, "Travel", "expense", None, None).unwrap().id;
        set_budget(&c, &dining, 0, "2026-09").unwrap();

        let g = budget_grid(&c, "2026-09").unwrap();
        let d = g.lines.iter().find(|l| l.category_id == dining).unwrap();
        let t = g.lines.iter().find(|l| l.category_id == travel).unwrap();
        assert!(d.has_budget && d.target_cents == 0);
        assert!(!t.has_budget && t.target_cents == 0);
        assert_eq!(g.budgeted_lines, 1, "the zero counts as budgeted; the empty one does not");
    }

    /// §129 — the starter proposes TOP-LEVEL categories from real spending,
    /// and uses the middle month rather than the average so one bad month
    /// does not set the figure for the year.
    #[test]
    fn the_starter_proposes_parents_from_a_typical_month_not_an_average() {
        let db = TestDb::new("budget-starter");
        let c = db.conn();
        let acct = account(&c, "Checking", 10_000_000);
        let auto = create_category(&c, "Automobile", "expense", None, None).unwrap().id;
        let fuel = create_category(&c, "Fuel", "expense", Some(&auto), None).unwrap().id;

        // Four months of fuel at about $200 — and one $3,000 transmission.
        // The mean of those is $760; the middle month is $200.
        for (date, cents) in [
            ("2026-05-04", -20_000i64),
            ("2026-06-04", -20_000),
            ("2026-07-04", -20_000),
            ("2026-08-04", -300_000),
        ] {
            let t = create_transaction(&c, &acct, date, "Fuel", None, cents, None, None).unwrap();
            update_transaction(&c, &t.id, date, "Fuel", Some(&fuel), cents, None, None).unwrap();
        }

        let lines = budget_starter(&c, "2026-09", 12, 12).unwrap();
        let a = lines.iter().find(|l| l.category_id == auto).expect("Automobile proposed");
        assert_eq!(a.category_name, "Automobile", "the PARENT is proposed, not the child");
        assert_eq!(a.months_with_spending, 4);
        assert_eq!(a.average_cents, 20_000, "the middle month, not the $760 average");
        assert_eq!(a.suggested_cents, 20_000, "already a round $200");
        assert!(
            lines.iter().all(|l| l.category_id != fuel),
            "a child must not appear beside its parent — that is the double count again"
        );
    }

    #[test]
    fn the_starter_rounds_up_and_falls_back_to_the_mean_when_there_is_no_middle() {
        // Under three months there is no middle to take, so it averages —
        // and either way the proposal is a number somebody can think in.
        assert_eq!(middle(&[]), 0);
        assert_eq!(middle(&[31_700]), 31_700);
        assert_eq!(middle(&[10_000, 20_000]), 15_000);
        assert_eq!(middle(&[10_000, 20_000, 300_000]), 20_000);
        assert_eq!(middle(&[10_000, 20_000, 30_000, 40_000]), 25_000);
        assert_eq!(round_up_to(38_317, 500), 38_500);
        assert_eq!(round_up_to(38_500, 500), 38_500);
        assert_eq!(round_up_to(0, 500), 0);
    }

    // ── §179 ─────────────────────────────────────────────────────────────

    /// §179 — a line accepted in Budget starter is a figure asked for.
    #[test]
    fn an_accepted_starter_line_is_asked_for_and_the_parent_rule_keeps_it() {
        let db = TestDb::new("autobudget-asked");
        let c = db.conn();
        let auto = create_category(&c, "Automobile", "expense", None, None).unwrap().id;
        let gas = create_category(&c, "Gasoline", "expense", Some(&auto), None).unwrap().id;
        apply_autobudget(&c, "2026-10", 1, &[(auto.clone(), 60_000), (gas.clone(), 20_000)]).unwrap();
        assert_eq!(budget_of(&c, &auto, "2026-10"), Some(60_000), "the parent rule cut Automobile to what Gasoline needed");
        let gas_row = list_budgets(&c, "2026-10").unwrap().into_iter().find(|b| b.category_id == gas).unwrap();
        delete_budget(&c, &gas_row.id).unwrap();
        assert_eq!(budget_of(&c, &auto, "2026-10"), Some(60_000));
    }

    /// §179 — a plan's month rows carry what the plan asked for, so the month
    /// rule does not delete a parent the plan says is there on purpose.
    #[test]
    fn a_planned_parents_month_survives_a_childs_month_being_deleted() {
        use crate::db::plan::{self, EVERY_MONTH, SPENT};
        let db = TestDb::new("materialize-asked");
        let c = db.conn();
        let bills = create_category(&c, "Bills", "expense", None, None).unwrap().id;
        let mortgage = create_category(&c, "Mortgage", "expense", Some(&bills), None).unwrap().id;
        plan::set_plan(&c, &bills, 2027, 4_176_000, EVERY_MONTH, SPENT).unwrap();
        plan::set_plan(&c, &mortgage, 2027, 2_400_000, EVERY_MONTH, SPENT).unwrap();
        assert_eq!(budget_of(&c, &bills, "2027-03"), Some(348_000));
        let row = list_budgets(&c, "2027-03").unwrap().into_iter().find(|b| b.category_id == mortgage).unwrap();
        delete_budget(&c, &row.id).unwrap();
        assert_eq!(budget_of(&c, &bills, "2027-03"), Some(348_000), "the plan's parent row went with its child");
        let asked: Option<i64> = c
            .query_row("SELECT asked_for_cents FROM budgets WHERE category_id = ?1 AND month_year = '2027-04'", params![bills], |r| r.get(0))
            .unwrap();
        assert_eq!(asked, Some(348_000));
    }
}
