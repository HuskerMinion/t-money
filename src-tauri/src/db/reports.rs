//! Reports — Money's "View a report" gallery, as one engine.
//!
//! Money's Reports tab is a gallery of ~forty named reports in six groups,
//! and every one of them is the same three things: a **date range**, a
//! **scope** (which accounts, which categories) and a **shape** (rows by
//! category / payee / account / month, a transaction list, or a series over
//! time), with a table view and usually a chart view of the same numbers.
//! Rather than forty commands, this module answers one `run_report` with a
//! `Report` that any of them can be rendered from: typed columns, rows with
//! a level (for category / subcategory), a style (header / subtotal / total)
//! and a **key** the viewer can drill through — click a category row in
//! "Spending by category" and you get "Transactions by category" scoped to
//! it, which is exactly how Money's reports link to each other.
//!
//! Rules that hold everywhere here:
//!
//! - **Money is `i64` cents.** Percentages are basis points (`i64`, 10000 =
//!   100%), never `f64`.
//! - **Transfers are not income or spending** — they are excluded from every
//!   category / payee report, and counted only where money moving between
//!   accounts is the point (account transactions, balances, net worth).
//! - **Voided rows count for nothing.**
//! - **Split lines count under their own category**, the parent under none.
//! - **A balance "as of" a date** is the stored balance with every later
//!   row taken back out, so history is exact without a snapshot table.
//! - **Ranges are inclusive** of both ends, `YYYY-MM-DD`.
//!
//! `spending_by_category` etc. are the same names Money uses in the gallery,
//! so the frontend's gallery is a table of `(group, label, kind)`.

use crate::db::queries::Conn;
use crate::db::lots;
use crate::models::{Report, ReportCell, ReportChart, ReportColumn, ReportRequest, ReportLine, ReportSeries};
use chrono::{Datelike, NaiveDate};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use std::collections::BTreeMap;

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/// Every report kind the engine answers, in gallery order. The frontend
/// gallery is generated from this list, so a report exists in exactly one
/// place. `(group, kind, label)`.
pub const GALLERY: &[(&str, &str, &str)] = &[
    ("Income and expenses", "spending_by_category", "Spending by category"),
    ("Income and expenses", "spending_by_payee", "Spending by payee"),
    ("Income and expenses", "monthly_budget", "Monthly budget"),
    ("Income and expenses", "monthly_income_expenses", "Monthly income and expenses"),
    ("Income and expenses", "transactions_by_category", "Transactions by category"),
    ("Income and expenses", "transactions_by_payee", "Transactions by payee"),
    ("Income and expenses", "account_transactions", "Account transactions"),
    ("Income and expenses", "income_and_spending", "Income and spending"),
    ("Income and expenses", "income_spending_over_time", "Income and spending over time"),
    ("Income and expenses", "annual_budget", "Annual budget"),
    ("Income and expenses", "subscriptions", "Subscriptions and recurring charges"),
    ("Assets and liabilities", "net_worth", "Net worth"),
    // The same figures at the other two levels of detail the engine
    // already computed but the gallery never offered, plus the split a user
    // actually asks of a net worth number — what could I get at this month.
    ("Assets and liabilities", "net_worth_by_account", "Net worth by account"),
    ("Assets and liabilities", "assets_vs_liabilities", "Assets vs liabilities"),
    ("Assets and liabilities", "liquid_net_worth", "Liquid, locked up and illiquid"),
    ("Assets and liabilities", "credit_card_debt", "Credit card debt"),
    ("Assets and liabilities", "net_worth_over_time", "Net worth over time"),
    ("Assets and liabilities", "account_balances", "Account balances"),
    ("Assets and liabilities", "account_balance_history", "Account balance history"),
    ("Assets and liabilities", "account_balances_with_details", "Account balances with details"),
    ("Assets and liabilities", "scheduled_bills", "Scheduled bills"),
    ("Assets and liabilities", "upcoming_bills", "Upcoming bills and deposits"),
    ("Investment", "portfolio_value", "Portfolio value"),
    ("Investment", "investment_performance", "Performance by holding"),
    ("Investment", "capital_gains", "Capital gains"),
    ("Investment", "investment_transactions", "Investment transactions"),
    ("Investment", "investment_income", "Investment income"),
    // Every holding's price movement over the range beside one
    // security's, so "did I beat the index" has an answer in the file.
    ("Investment", "benchmark_comparison", "Performance against a benchmark"),
    // What kind of thing the money is in, by account: stocks, funds,
    // bonds, cash. The pie Empower and Quicken lead with.
    ("Investment", "asset_allocation", "Asset allocation"),
    ("Taxes", "tax_related_transactions", "Tax-related transactions"),
    ("Taxes", "tax_summary", "Tax summary by line"),
    // Classifications: what the money was FOR, rather than
    // what kind of money it was. Hidden from the gallery when the file has
    // no classifications, since none of them can say anything yet.
    ("Classifications", "spending_by_classification", "Spending by classification"),
    ("Classifications", "transactions_by_classification", "Transactions by classification"),
    ("Classifications", "classification_by_month", "Classification by month"),
    ("Classifications", "classification_by_category", "Classification by category"),
    ("Classifications", "classification_comparison", "Classification comparison"),
    ("Comparison", "spending_by_category_comparison", "Spending by category comparison"),
    ("Comparison", "spending_by_payee_comparison", "Spending by payee comparison"),
    ("Comparison", "income_spending_comparison", "Income and spending comparison"),
];

/// Answer one report request.
/// Reports whose chart runs along TIME. Their order is the calendar's
/// and is left alone; every other chart is a comparison of named things —
/// categories, payees, accounts, holdings — and reads largest to smallest.
const TIME_ORDERED: &[&str] = &[
    "monthly_budget",
    "monthly_income_expenses",
    "income_spending_over_time",
    "credit_card_debt",
    "net_worth_over_time",
    "account_balance_history",
    "classification_by_month",
];

/// A categorical chart's labels, largest first.
///
/// > *"Reports for Charts should sort largest to smallest"* — most charts
/// came out in the order their rows were built, which for a category
/// report is alphabetical by group and for net worth is the account-type
/// order, so the biggest slice of a pie sat wherever its name fell.
///
/// Single series: by absolute value, ties by label. Several series over the
/// same labels (a comparison, a budget against actuals): by the sum of the
/// absolute values across the series, so the bars stay lined up. A label
/// present in one series and not another is kept and counts as zero there.
pub fn largest_first(chart: &mut ReportChart) {
    if chart.series.is_empty() {
        return;
    }
    let mut labels: Vec<String> = Vec::new();
    for s in &chart.series {
        for (l, _) in &s.points {
            if !labels.contains(l) {
                labels.push(l.clone());
            }
        }
    }
    let weight = |label: &str| -> i64 {
        chart
            .series
            .iter()
            .map(|s| s.points.iter().find(|(l, _)| l == label).map(|(_, v)| v.abs()).unwrap_or(0))
            .sum()
    };
    let mut order: Vec<(i64, String)> = labels.into_iter().map(|l| (weight(&l), l)).collect();
    order.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.to_lowercase().cmp(&b.1.to_lowercase())));
    let rank: std::collections::HashMap<&str, usize> = order.iter().enumerate().map(|(i, (_, l))| (l.as_str(), i)).collect();
    for s in chart.series.iter_mut() {
        s.points.sort_by_key(|(l, _)| rank.get(l.as_str()).copied().unwrap_or(usize::MAX));
    }
}

pub fn run_report(conn: &Conn, req: &ReportRequest) -> Result<Report, String> {
    let from = parse_date(&req.from)?;
    let to = parse_date(&req.to)?;
    if from > to {
        return Err("the date range ends before it starts".to_string());
    }
    let scope = Scope::from_request(conn, req)?;
    let mut report = match req.kind.as_str() {
        "spending_by_category" => spending_by_category(conn, &scope, from, to)?,
        "spending_by_payee" => spending_by_payee(conn, &scope, from, to)?,
        "monthly_budget" => monthly_budget(conn, &scope, from, to)?,
        "annual_budget" => annual_budget(conn, &scope, from, to)?,
        "monthly_income_expenses" => monthly_income_expenses(conn, &scope, from, to)?,
        "transactions_by_category" => transactions_grouped(conn, &scope, from, to, GroupBy::Category)?,
        "transactions_by_payee" => transactions_grouped(conn, &scope, from, to, GroupBy::Payee)?,
        "account_transactions" => transactions_grouped(conn, &scope, from, to, GroupBy::Account)?,
        "income_and_spending" => income_and_spending(conn, &scope, from, to)?,
        "income_spending_over_time" => income_spending_over_time(conn, &scope, from, to)?,
        "net_worth" => net_worth(conn, &scope, to, req.detail.as_deref().unwrap_or("types"))?,
        "net_worth_by_account" => net_worth(conn, &scope, to, "accounts")?,
        "assets_vs_liabilities" => net_worth(conn, &scope, to, "sides")?,
        "liquid_net_worth" => liquid_net_worth(conn, &scope, to)?,
        "credit_card_debt" => credit_card_debt(conn, &scope, from, to)?,
        "net_worth_over_time" => net_worth_over_time(conn, &scope, from, to)?,
        "account_balances" => account_balances(conn, &scope, to, false)?,
        "account_balances_with_details" => account_balances(conn, &scope, to, true)?,
        "account_balance_history" => account_balance_history(conn, &scope, from, to)?,
        "scheduled_bills" => scheduled_bills(conn, from, to, false)?,
        "upcoming_bills" => scheduled_bills(conn, from, to, true)?,
        "portfolio_value" => portfolio_value(conn, &scope, to)?,
        "investment_performance" => investment_performance(conn, &scope, to)?,
        "benchmark_comparison" => benchmark_comparison(conn, &scope, req, from, to)?,
        "asset_allocation" => asset_allocation(conn, &scope, to)?,
        "capital_gains" => capital_gains(conn, &scope, from, to)?,
        "investment_transactions" => investment_transactions(conn, &scope, from, to)?,
        "investment_income" => investment_income(conn, &scope, from, to)?,
        "tax_related_transactions" => tax_related_transactions(conn, &scope, from, to)?,
        "tax_summary" => tax_summary(conn, &scope, from, to)?,
        "spending_by_category_comparison" => comparison(conn, &scope, req, from, to, GroupBy::Category)?,
        "spending_by_payee_comparison" => comparison(conn, &scope, req, from, to, GroupBy::Payee)?,
        "income_spending_comparison" => income_spending_comparison(conn, &scope, req, from, to)?,
        "subscriptions" => subscriptions(conn, &scope, from, to)?,
        // The same engine, grouped on a classification instead of a
        // category. Cheap to add now that classifications are
        // stored and every report is scoped the same way.
        "spending_by_classification" => spending_by_classification(conn, &scope, from, to)?,
        "transactions_by_classification" => transactions_by_classification(conn, &scope, from, to)?,
        "classification_by_month" => classification_by_month(conn, &scope, from, to)?,
        "classification_by_category" => classification_by_category(conn, &scope, from, to)?,
        "classification_comparison" => classification_comparison(conn, &scope, req, from, to)?,
        other => return Err(format!("unknown report: {other}")),
    };
    report.kind = req.kind.clone();
    if let Some(chart) = report.chart.as_mut() {
        if !TIME_ORDERED.contains(&req.kind.as_str()) {
            largest_first(chart);
        }
    }
    if report.subtitle.is_empty() {
        report.subtitle = range_label(from, to);
    }
    // A report that was filtered says so under its title, so a number
    // that looks wrong is explained rather than doubted.
    let note = scope.filter_note();
    if !note.is_empty() {
        report.subtitle = format!("{} — {}", report.subtitle, note);
    }
    Ok(report)
}

// ---------------------------------------------------------------------------
// Scope: which accounts and categories a report covers
// ---------------------------------------------------------------------------

struct Scope {
    /// `None` = every account.
    accounts: Option<Vec<String>>,
    /// `None` = every category. A parent id selects its children too.
    categories: Option<Vec<String>>,
    /// `categories` is a leave-out list.
    exclude_categories: bool,
    /// `None` = every security (investment reports).
    securities: Option<Vec<String>>,
    /// Only accounts with `tax_included`.
    tax_only: bool,
    /// Those accounts, when `tax_only`.
    tax_accounts: Vec<String>,
    /// Spending reports leave income out unless categories were chosen
    ///: expense categories, plus uncategorized money going out.
    expense_only: bool,
    // --- The line filters, honored by every report built on lines ---
    payees: Option<Vec<String>>,
    exclude_payees: bool,
    min_cents: Option<i64>,
    max_cents: Option<i64>,
    /// Subset of "", "C", "R"; `None` = any.
    cleared: Option<Vec<String>>,
    /// Lower-cased, for a LIKE on payee and memo.
    text: Option<String>,
    /// Per axis, the value ids a line must carry one of (children
    /// already expanded), and whether "no value on this axis" also passes.
    classes: Vec<ClassFilter>,
    /// The axis a by-classification report groups on.
    axis: Option<AxisInfo>,
}

struct ClassFilter {
    classification_id: String,
    value_ids: Vec<String>,
    allow_none: bool,
}

#[derive(Clone)]
struct AxisInfo {
    id: String,
    name: String,
}

/// What a fragment needs to know about the rows it filters: the alias, the
/// expression for the transaction id, the memo column, and — when the rows
/// are split lines — the split id, so a line's own classification value can
/// override the transaction's.
struct LineCols<'a> {
    alias: &'a str,
    txn_id: &'a str,
    memo: &'a str,
    split_id: Option<&'a str>,
}

/// The `lines` CTE's columns.
const L: LineCols<'static> = LineCols { alias: "l", txn_id: "l.txn_id", memo: "l.memo", split_id: Some("l.split_id") };
/// A bare `transactions t` row.
const T: LineCols<'static> = LineCols { alias: "t", txn_id: "t.id", memo: "t.notes", split_id: None };

impl Scope {
    fn from_request(conn: &Conn, req: &ReportRequest) -> Result<Self, String> {
        let accounts = req.account_ids.clone().filter(|v| !v.is_empty());
        let categories = match req.category_ids.clone().filter(|v| !v.is_empty()) {
            None => None,
            Some(ids) => {
                // Expand parents to include their children.
                let mut all = ids.clone();
                let mut st = conn
                    .prepare("SELECT id FROM categories WHERE parent_id = ?1")
                    .map_err(|e| e.to_string())?;
                for id in &ids {
                    let kids = st
                        .query_map(params![id], |r| r.get::<_, String>(0))
                        .map_err(|e| e.to_string())?
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(|e| e.to_string())?;
                    all.extend(kids);
                }
                all.sort();
                all.dedup();
                Some(all)
            }
        };
        let exclude_categories = req.exclude_categories.unwrap_or(false) && categories.is_some();
        let securities = req.security_ids.clone().filter(|v| !v.is_empty());
        // The two tax reports are tax reports; anything else is tax-scoped
        // only when asked (the Taxes tab asks).
        let tax_only = req.tax_scope.unwrap_or(false) || matches!(req.kind.as_str(), "tax_related_transactions" | "tax_summary");
        let tax_accounts = if tax_only {
            let mut st = conn.prepare("SELECT id FROM accounts WHERE tax_included = 1").map_err(|e| e.to_string())?;
            let v: Vec<String> = st
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            v
        } else {
            Vec::new()
        };
        // Leaving categories OUT of a spending report still leaves income
        // out: only an include list names what to show.
        let expense_only = (categories.is_none() || exclude_categories)
            && matches!(
                req.kind.as_str(),
                "spending_by_category" | "spending_by_payee" | "spending_by_category_comparison" | "spending_by_payee_comparison" | "spending_by_classification" | "classification_comparison" | "classification_by_month"
            );
        let payees = req.payee_ids.clone().filter(|v| !v.is_empty());
        let exclude_payees = req.exclude_payees.unwrap_or(false) && payees.is_some();
        let cleared = req.cleared.clone().filter(|v| !v.is_empty()).map(|v| {
            v.into_iter().map(|c| c.trim().to_uppercase()).filter(|c| matches!(c.as_str(), "" | "C" | "R")).collect::<Vec<_>>()
        });
        let text = req.text.as_deref().map(str::trim).filter(|t| !t.is_empty()).map(str::to_lowercase);
        let (min_cents, max_cents) = (req.min_cents.map(i64::abs), req.max_cents.map(i64::abs));

        // Group the picked values by axis; expand a parent to its
        // sub-values; `none:<axis>` = lines with nothing on that axis.
        let mut classes: Vec<ClassFilter> = Vec::new();
        if let Some(ids) = req.class_value_ids.as_ref().filter(|v| !v.is_empty()) {
            let mut st = conn
                .prepare("SELECT classification_id FROM classification_values WHERE id = ?1")
                .map_err(|e| e.to_string())?;
            let mut kids = conn
                .prepare("SELECT id FROM classification_values WHERE parent_id = ?1")
                .map_err(|e| e.to_string())?;
            fn filter_for(classes: &mut Vec<ClassFilter>, axis: &str) -> usize {
                if let Some(i) = classes.iter().position(|c| c.classification_id == axis) {
                    i
                } else {
                    classes.push(ClassFilter { classification_id: axis.to_string(), value_ids: Vec::new(), allow_none: false });
                    classes.len() - 1
                }
            }
            for id in ids {
                if let Some(axis) = id.strip_prefix("none:") {
                    let i = filter_for(&mut classes, axis);
                    classes[i].allow_none = true;
                    continue;
                }
                let axis: Option<String> = st.query_row(params![id], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
                let Some(axis) = axis else { continue };
                let i = filter_for(&mut classes, &axis);
                classes[i].value_ids.push(id.clone());
                let sub: Vec<String> = kids
                    .query_map(params![id], |r| r.get::<_, String>(0))
                    .map_err(|e| e.to_string())?
                    .collect::<Result<_, _>>()
                    .map_err(|e| e.to_string())?;
                classes[i].value_ids.extend(sub);
            }
            for c in classes.iter_mut() {
                c.value_ids.sort();
                c.value_ids.dedup();
            }
        }

        // The axis a by-classification report groups on — the one
        // asked for, else the first. Only those reports need one.
        let axis = if req.kind.contains("classification") {
            let row: Option<(String, String)> = match req.classification_id.as_deref().filter(|s| !s.is_empty()) {
                Some(id) => conn
                    .query_row("SELECT id, name FROM classifications WHERE id = ?1", params![id], |r| Ok((r.get(0)?, r.get(1)?)))
                    .optional()
                    .map_err(|e| e.to_string())?,
                None => conn
                    .query_row("SELECT id, name FROM classifications ORDER BY sort_order, name COLLATE NOCASE LIMIT 1", [], |r| Ok((r.get(0)?, r.get(1)?)))
                    .optional()
                    .map_err(|e| e.to_string())?,
            };
            match row {
                Some((id, name)) => Some(AxisInfo { id, name }),
                None => return Err("There are no classifications yet. Add one under Budget → Classifications, then tag some transactions.".to_string()),
            }
        } else {
            None
        };

        Ok(Scope {
            accounts,
            categories,
            exclude_categories,
            securities,
            tax_only,
            tax_accounts,
            expense_only,
            payees,
            exclude_payees,
            min_cents,
            max_cents,
            cleared,
            text,
            classes,
            axis,
        })
    }

    fn wants_account(&self, id: &str) -> bool {
        !self.tax_only || self.tax_accounts.iter().any(|a| a == id)
    }

    fn wants_security(&self, id: &str) -> bool {
        self.securities.as_ref().map_or(true, |v| v.iter().any(|s| s == id))
    }
    fn security_sql(&self, expr: &str, binds: &mut Vec<String>) -> String {
        match &self.securities {
            None => String::new(),
            Some(ids) => {
                let marks = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
                binds.extend(ids.iter().cloned());
                format!(" AND {expr} IN ({marks})")
            }
        }
    }

    /// `AND t.account_id IN (...)` / `AND l.category_id IN (...)` fragments,
    /// with their bound values appended to `binds`. `alias` names the table.
    fn account_sql(&self, alias: &str, binds: &mut Vec<String>) -> String {
        let mut out = match &self.accounts {
            None => String::new(),
            Some(ids) => {
                let marks = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
                binds.extend(ids.iter().cloned());
                format!(" AND {alias}.account_id IN ({marks})")
            }
        };
        if self.tax_only {
            out.push_str(&format!(" AND {alias}.account_id IN (SELECT id FROM accounts WHERE tax_included = 1)"));
        }
        out
    }
    fn category_sql(&self, expr: &str, binds: &mut Vec<String>) -> String {
        let mut out = String::new();
        if self.expense_only {
            let alias = expr.split('.').next().unwrap_or("l");
            out.push_str(&format!(" AND ({expr} IN (SELECT id FROM categories WHERE kind = 'expense') OR ({expr} IS NULL AND {alias}.amount_cents < 0))"));
        }
        if let Some(ids) = &self.categories {
            let marks = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            binds.extend(ids.iter().cloned());
            if self.exclude_categories {
                out.push_str(&format!(" AND ({expr} IS NULL OR {expr} NOT IN ({marks}))"));
            } else {
                out.push_str(&format!(" AND {expr} IN ({marks})"));
            }
        }
        out
    }

    /// Whether a category id passes the include / exclude list — for the
    /// reports that filter in Rust rather than SQL.
    fn wants_category(&self, id: &str) -> bool {
        match &self.categories {
            None => true,
            Some(ids) => ids.iter().any(|c| c == id) != self.exclude_categories,
        }
    }

    /// The effective value of one axis for a line: the split line's own, else
    /// the transaction's. Binds the axis id twice (once per lookup) when the
    /// rows are split lines, once otherwise.
    ///
    /// The placeholders are NUMBERED, not anonymous, because this expression
    /// goes in the SELECT list — ahead of the `?1`/`?2` dates in the WHERE.
    /// SQLite numbers an anonymous `?` as one past the largest index seen SO
    /// FAR IN THE TEXT, so an anonymous placeholder up here would have become
    /// `?1` and quietly stolen the date's parameter.
    fn class_expr(&self, cols: &LineCols, axis: &str, binds: &mut Vec<String>) -> String {
        let bind = |binds: &mut Vec<String>| {
            binds.push(axis.to_string());
            format!("?{}", binds.len())
        };
        match cols.split_id {
            Some(sid) => {
                let own = bind(binds);
                let inherited = bind(binds);
                format!(
                    "COALESCE((SELECT x.value_id FROM transaction_classes x WHERE x.split_id = {sid} AND x.classification_id = {own}), \
                     (SELECT x.value_id FROM transaction_classes x WHERE x.transaction_id = {} AND x.split_id IS NULL AND x.classification_id = {inherited}))",
                    cols.txn_id
                )
            }
            None => {
                let p = bind(binds);
                format!(
                    "(SELECT x.value_id FROM transaction_classes x WHERE x.transaction_id = {} AND x.split_id IS NULL AND x.classification_id = {p})",
                    cols.txn_id
                )
            }
        }
    }

    /// Every line-level filter as one fragment — payees, amount,
    /// cleared state, text, classification values. Append it wherever
    /// `account_sql` / `category_sql` go, in that order.
    fn line_sql(&self, cols: &LineCols, binds: &mut Vec<String>) -> String {
        let a = cols.alias;
        let mut out = String::new();
        if let Some(ids) = &self.payees {
            let marks = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            binds.extend(ids.iter().cloned());
            if self.exclude_payees {
                out.push_str(&format!(" AND ({a}.payee_id IS NULL OR {a}.payee_id NOT IN ({marks}))"));
            } else {
                out.push_str(&format!(" AND {a}.payee_id IN ({marks})"));
            }
        }
        // A bound text compares as TEXT against an INTEGER column and always
        // sorts above it — the CAST is not optional.
        if let Some(min) = self.min_cents {
            binds.push(min.to_string());
            out.push_str(&format!(" AND abs({a}.amount_cents) >= CAST(? AS INTEGER)"));
        }
        if let Some(max) = self.max_cents {
            binds.push(max.to_string());
            out.push_str(&format!(" AND abs({a}.amount_cents) <= CAST(? AS INTEGER)"));
        }
        if let Some(states) = &self.cleared {
            let marks = states.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            binds.extend(states.iter().cloned());
            out.push_str(&format!(" AND {a}.cleared_state IN ({marks})"));
        }
        if let Some(t) = &self.text {
            // The escape character itself has to be escaped, and FIRST:
            // searching for "c:\\users" would otherwise send `\u`, which is
            // not an escape sequence, so the backslash vanished and the
            // filter matched the wrong thing — and a trailing backslash
            // escaped the closing `%` and matched nothing at all.
            let like = format!("%{}%", t.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
            binds.push(like.clone());
            binds.push(like);
            out.push_str(&format!(
                " AND (lower({a}.payee) LIKE ? ESCAPE '\\' OR lower(COALESCE({}, '')) LIKE ? ESCAPE '\\')",
                cols.memo
            ));
        }
        for c in &self.classes {
            let mut parts = Vec::new();
            // Each branch builds its OWN expression, and only when it is
            // actually emitted: `class_expr` pushes binds, so building one
            // and then not using it would leave dead entries in `binds`.
            if !c.value_ids.is_empty() {
                let expr = self.class_expr(cols, &c.classification_id, binds);
                let marks = c.value_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
                binds.extend(c.value_ids.iter().cloned());
                parts.push(format!("{expr} IN ({marks})"));
            }
            if c.allow_none {
                let expr = self.class_expr(cols, &c.classification_id, binds);
                parts.push(format!("{expr} IS NULL"));
            }
            if !parts.is_empty() {
                out.push_str(&format!(" AND ({})", parts.join(" OR ")));
            }
        }
        out
    }

    /// The usual trio for the `lines` CTE: accounts, categories, then the
    /// line filters — in the order the SQL must name them.
    fn lines_where(&self, binds: &mut Vec<String>) -> String {
        let mut out = self.account_sql("l", binds);
        out.push_str(&self.category_sql("l.category_id", binds));
        out.push_str(&self.line_sql(&L, binds));
        out
    }

    /// A short description of the line filters, for a subtitle.
    fn filter_note(&self) -> String {
        let mut parts = Vec::new();
        if self.payees.is_some() {
            parts.push(if self.exclude_payees { "some payees left out" } else { "chosen payees" }.to_string());
        }
        if self.exclude_categories {
            parts.push("some categories left out".to_string());
        }
        match (self.min_cents, self.max_cents) {
            (Some(a), Some(b)) => parts.push(format!("amounts {} to {}", cents_label(a), cents_label(b))),
            (Some(a), None) => parts.push(format!("amounts from {}", cents_label(a))),
            (None, Some(b)) => parts.push(format!("amounts up to {}", cents_label(b))),
            _ => {}
        }
        if let Some(c) = &self.cleared {
            let names: Vec<&str> = c.iter().map(|s| match s.as_str() { "C" => "cleared", "R" => "reconciled", _ => "open" }).collect();
            parts.push(names.join("/"));
        }
        if let Some(t) = &self.text {
            parts.push(format!("containing \"{t}\""));
        }
        if !self.classes.is_empty() {
            parts.push("by classification".to_string());
        }
        parts.join(", ")
    }
}

fn cents_label(c: i64) -> String {
    let neg = c < 0;
    let c = c.abs();
    format!("{}${}.{:02}", if neg { "-" } else { "" }, c / 100, c % 100)
}

// ---------------------------------------------------------------------------
// The lines CTE: one row per categorized line, transfers and voids out
// ---------------------------------------------------------------------------

/// Every non-void, non-transfer transaction expanded into its split lines,
/// carrying what every category/payee report needs. Bound: none.
const LINES: &str = r#"
    WITH lines AS (
        SELECT t.id                                     AS txn_id,
               s.id                                     AS split_id,
               t.cleared_state                          AS cleared_state,
               t.account_id                             AS account_id,
               t.date                                   AS date,
               t.payee                                  AS payee,
               t.payee_id                               AS payee_id,
               t.check_number                           AS check_number,
               COALESCE(s.description, t.notes)         AS memo,
               COALESCE(s.category_id, t.category_id)   AS category_id,
               t.tax_line                               AS tax_override,
               COALESCE(s.amount_cents,
                        CASE WHEN t.activity LIKE 'reinvest_%' THEN t.gross_cents ELSE t.amount_cents END)
                                                        AS amount_cents
          FROM transactions t
          LEFT JOIN splits s ON s.transaction_id = t.id
         WHERE t.is_void = 0 AND t.transfer_id IS NULL
           -- A house is worth $20,000 more than last year. That moves
           -- the balance and belongs in net worth, but it is not income and
           -- not spending, and counting it would swamp every category report
           -- with money nobody can spend. Excluded here, once, for every
           -- report built on `lines`.
           AND t.is_revaluation = 0
           -- A split line that moves money to another account is a
           -- transfer, and so is the row it wrote over there. Neither is
           -- spending — the mortgage payment's interest line is. Two clauses
           -- because a split has many far rows and `transfer_id` names one.
           AND t.is_split_transfer = 0
           AND (s.id IS NULL OR s.transfer_account_id IS NULL)
           -- Investment rows: only the income activities are lines; a
           -- buy or sell exchanges cash for shares and is not spending, and a
           -- reinvested dividend counts for the amount reinvested.
           AND (t.activity IS NULL OR t.activity IN
                ('dividend','interest','ltcg_dist','stcg_dist',
                 'reinvest_dividend','reinvest_interest','reinvest_ltcg','reinvest_stcg'))
    )
"#;

// ---------------------------------------------------------------------------
// Small builders
// ---------------------------------------------------------------------------

fn col(label: &str, kind: &str) -> ReportColumn {
    ReportColumn { label: label.to_string(), kind: kind.to_string() }
}
fn text(s: impl Into<String>) -> ReportCell {
    ReportCell { text: Some(s.into()), cents: None }
}
fn money(c: i64) -> ReportCell {
    ReportCell { text: None, cents: Some(c) }
}
fn blank() -> ReportCell {
    ReportCell { text: None, cents: None }
}
fn row(label: &str, cells: Vec<ReportCell>) -> ReportLine {
    ReportLine {
        key: None,
        key_kind: None,
        label: label.to_string(),
        level: 0,
        style: "normal".to_string(),
        cells,
    }
}
fn keyed(label: &str, kind: &str, key: &str, level: u8, cells: Vec<ReportCell>) -> ReportLine {
    ReportLine {
        key: Some(key.to_string()),
        key_kind: Some(kind.to_string()),
        label: label.to_string(),
        level,
        style: "normal".to_string(),
        cells,
    }
}
fn styled(label: &str, style: &str, cells: Vec<ReportCell>) -> ReportLine {
    ReportLine {
        key: None,
        key_kind: None,
        label: label.to_string(),
        level: 0,
        style: style.to_string(),
        cells,
    }
}
fn header(label: &str, n: usize) -> ReportLine {
    styled(label, "header", (0..n).map(|_| blank()).collect())
}

/// Percent as basis points: `part / whole`, 10000 = 100%. Integer only.
pub fn bps(part: i64, whole: i64) -> i64 {
    if whole == 0 {
        0
    } else {
        // Half away from zero, on integers.
        let num = part.saturating_mul(10_000);
        let q = num / whole;
        let r = num % whole;
        if (r.abs() * 2) >= whole.abs() {
            q + if (num < 0) != (whole < 0) { -1 } else { 1 }
        } else {
            q
        }
    }
}
fn pct(part: i64, whole: i64) -> ReportCell {
    ReportCell { text: None, cents: Some(bps(part, whole)) }
}

fn parse_date(s: &str) -> Result<NaiveDate, String> {
    NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d").map_err(|_| format!("{s:?} is not a date"))
}
fn iso(d: NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}
fn us(d: NaiveDate) -> String {
    format!("{}/{}/{}", d.month(), d.day(), d.year())
}
/// Money's subtitle: `1/1/2025 through 12/31/2025`.
pub fn range_label(from: NaiveDate, to: NaiveDate) -> String {
    format!("{} through {}", us(from), us(to))
}
fn month_label(ym: &str) -> String {
    const M: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let (y, m) = ym.split_at(4);
    let mi: usize = m.trim_start_matches('-').parse().unwrap_or(1);
    format!("{} {}", M[(mi.clamp(1, 12)) - 1], y)
}
/// Money's column header for a month: `8/2026`.
fn money_month_label(ym: &str) -> String {
    let (y, m) = ym.split_at(4);
    let mi: u32 = m.trim_start_matches('-').parse().unwrap_or(1);
    format!("{mi}/{y}")
}
/// `YYYY-MM` for every month touching the range, oldest first.
pub fn months_in(from: NaiveDate, to: NaiveDate) -> Vec<String> {
    let mut out = Vec::new();
    let (mut y, mut m) = (from.year(), from.month());
    loop {
        out.push(format!("{y:04}-{m:02}"));
        if (y, m) >= (to.year(), to.month()) {
            break;
        }
        if m == 12 {
            y += 1;
            m = 1;
        } else {
            m += 1;
        }
    }
    out
}
/// The last day of `YYYY-MM`.
fn month_end(ym: &str) -> NaiveDate {
    let y: i32 = ym[..4].parse().unwrap_or(2000);
    let m: u32 = ym[5..7].parse().unwrap_or(1);
    let next = if m == 12 {
        NaiveDate::from_ymd_opt(y + 1, 1, 1)
    } else {
        NaiveDate::from_ymd_opt(y, m + 1, 1)
    };
    next.and_then(|n| n.pred_opt()).unwrap_or_else(|| NaiveDate::from_ymd_opt(y, m, 28).unwrap())
}

/// Bind a `Vec<String>` behind a prepared statement.
fn query_rows<T>(
    conn: &Connection,
    sql: &str,
    binds: &[String],
    f: impl FnMut(&rusqlite::Row) -> rusqlite::Result<T>,
) -> Result<Vec<T>, String> {
    let mut st = conn.prepare(sql).map_err(|e| e.to_string())?;
    let out = st
        .query_map(params_from_iter(binds.iter()), f)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<T>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(out)
}

// ---------------------------------------------------------------------------
// Category totals — the core of half the gallery
// ---------------------------------------------------------------------------

/// One category's numbers over the range: `values` has one entry per value
/// column (one for a plain total, one per month for the matrix, two for a
/// comparison), already SIGNED FOR DISPLAY — expenses positive, the way
/// Money prints them.
#[derive(Clone)]
struct CatNode {
    id: String,
    name: String,
    parent_id: Option<String>,
    parent_name: Option<String>,
    kind: String,
    values: Vec<i64>,
    count: i64,
}

/// Net cents per category per month bucket over the range, split lines under
/// their own category. `buckets` = the `YYYY-MM` list to spread across, or a
/// single-element list for one total. Uncategorized lines come back as a node
/// with an empty id, split by sign into an income and an expense node.
fn category_nodes(conn: &Conn, scope: &Scope, from: NaiveDate, to: NaiveDate, buckets: &[String]) -> Result<Vec<CatNode>, String> {
    let mut binds = vec![iso(from), iso(to)];
    let scoped = scope.lines_where(&mut binds);
    let by_month = buckets.len() > 1;
    let sql = format!(
        "{LINES}
        SELECT c.id, c.name, c.parent_id, p.name, c.kind,
               substr(l.date, 1, 7), SUM(l.amount_cents), COUNT(*)
          FROM lines l
          LEFT JOIN categories c ON c.id = l.category_id
          LEFT JOIN categories p ON p.id = c.parent_id
         WHERE l.date >= ?1 AND l.date <= ?2{scoped}
         GROUP BY c.id, substr(l.date, 1, 7)"
    );
    let raw = query_rows(conn, &sql, &binds, |r| {
        Ok((
            r.get::<_, Option<String>>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, Option<String>>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, i64>(6)?,
            r.get::<_, i64>(7)?,
        ))
    })?;
    // (id or "" + kind for uncategorized) → node
    let mut nodes: BTreeMap<String, CatNode> = BTreeMap::new();
    let ncols = buckets.len().max(1);
    for (id, name, parent_id, parent_name, kind, ym, cents, count) in raw {
        let (key, kind) = match (&id, &kind) {
            (Some(i), Some(k)) => (i.clone(), k.clone()),
            _ => {
                let k = if cents > 0 { "income" } else { "expense" };
                (format!("uncategorized:{k}"), k.to_string())
            }
        };
        let node = nodes.entry(key.clone()).or_insert_with(|| CatNode {
            id: id.clone().unwrap_or_default(),
            name: name.clone().unwrap_or_else(|| "Uncategorized".to_string()),
            parent_id: parent_id.clone(),
            parent_name: parent_name.clone(),
            kind: kind.clone(),
            values: vec![0; ncols],
            count: 0,
        });
        let col = if by_month { buckets.iter().position(|b| *b == ym).unwrap_or(0) } else { 0 };
        let shown = if kind == "expense" { -cents } else { cents };
        node.values[col] += shown;
        node.count += count;
    }
    Ok(nodes.into_values().collect())
}

fn sum_values(a: &[i64], b: &[i64]) -> Vec<i64> {
    a.iter().zip(b.iter()).map(|(x, y)| x + y).collect()
}

/// Money's report tree, as its Monthly Income and Expenses report lays it
/// out:
///
/// ```text
/// Income                              ← section header, rule beneath
/// Wages & Salary                      ← parent, bold, NO amount
///   Gross Pay              1,000.00   ← subcategory
///   Wages & Salary - Unassigned …     ← the parent's own lines
///     Total Wages & Salary 1,250.00   ← blue
/// Cash                        50.00   ← childless parent: bold WITH amount
/// Total Income             2,000.00   ← blue
/// …
/// Income less Expenses       500.00   ← bold, rule above
/// ```
///
/// `cells(values, count)` renders one node's numbers; `chart` collects one
/// `(parent, first value)` point per top-level group. Every value is already
/// display-signed, so totals just add.
fn tree_rows(nodes: &[CatNode], ncols: usize, cells: &dyn Fn(&[i64], Option<i64>, &str) -> Vec<ReportCell>) -> (Vec<ReportLine>, Vec<(String, i64)>, Vec<i64>, Vec<i64>) {
    let mut rows = Vec::new();
    let mut chart = Vec::new();
    let mut section_totals: Vec<Vec<i64>> = vec![vec![0; ncols], vec![0; ncols]];
    for (si, (kind, title)) in [("income", "Income"), ("expense", "Expenses")].iter().enumerate() {
        let in_section: Vec<&CatNode> = nodes.iter().filter(|n| n.kind == *kind).collect();
        if in_section.is_empty() {
            continue;
        }
        let ncells = cells(&vec![0; ncols], None, kind).len();
        rows.push(header(title, ncells));
        // Groups by top-level name: a parent's own node (if any) plus its children.
        let mut groups: BTreeMap<String, (Option<&CatNode>, Vec<&CatNode>, String)> = BTreeMap::new();
        for n in &in_section {
            if n.id.is_empty() {
                continue;
            }
            match &n.parent_id {
                None => {
                    groups.entry(n.name.to_lowercase()).or_insert((None, Vec::new(), n.id.clone())).0 = Some(n);
                }
                Some(pid) => {
                    let pname = n.parent_name.clone().unwrap_or_default();
                    let e = groups.entry(pname.to_lowercase()).or_insert((None, Vec::new(), pid.clone()));
                    e.1.push(n);
                }
            }
        }
        for (_, (own, kids, pid)) in groups {
            let name = own.map(|o| o.name.clone()).or_else(|| kids.first().and_then(|k| k.parent_name.clone())).unwrap_or_default();
            let mut total = vec![0i64; ncols];
            let mut count = 0i64;
            if let Some(o) = own {
                total = sum_values(&total, &o.values);
                count += o.count;
            }
            for k in &kids {
                total = sum_values(&total, &k.values);
                count += k.count;
            }
            if kids.is_empty() {
                // Childless parent: bold, with its amount on the same line.
                let mut r = keyed(&name, "category", &pid, 0, cells(&total, Some(count), kind));
                r.style = "bold".to_string();
                rows.push(r);
            } else {
                // A group row has as many cells as the others (blank), so the
                // column count stays honest.
                let mut g = keyed(&name, "category", &pid, 0, (0..ncells).map(|_| blank()).collect::<Vec<_>>());
                g.style = "group".to_string();
                rows.push(g);
                let mut kids_sorted = kids.clone();
                kids_sorted.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
                for k in kids_sorted {
                    rows.push(keyed(&k.name, "category", &k.id, 1, cells(&k.values, Some(k.count), kind)));
                }
                if let Some(o) = own {
                    if o.values.iter().any(|v| *v != 0) {
                        rows.push(keyed(&format!("{name} - Unassigned"), "category", &pid, 1, cells(&o.values, Some(o.count), kind)));
                    }
                }
                let mut t = keyed(&format!("Total {name}"), "category", &pid, 1, cells(&total, Some(count), kind));
                t.style = "subtotal".to_string();
                rows.push(t);
            }
            chart.push((name.clone(), total[0]));
            section_totals[si] = sum_values(&section_totals[si], &total);
        }
        if let Some(u) = in_section.iter().find(|n| n.id.is_empty()) {
            let mut r = keyed("Uncategorized", "category", "", 0, cells(&u.values, Some(u.count), kind));
            r.style = "bold".to_string();
            rows.push(r);
            chart.push(("Uncategorized".to_string(), u.values[0]));
            section_totals[si] = sum_values(&section_totals[si], &u.values);
        }
        rows.push(styled(&format!("Total {title}"), "subtotal", cells(&section_totals[si], None, kind)));
    }
    let income = section_totals[0].clone();
    let expenses = section_totals[1].clone();
    (rows, chart, income, expenses)
}

fn spending_by_category(conn: &Conn, scope: &Scope, from: NaiveDate, to: NaiveDate) -> Result<Report, String> {
    let nodes = category_nodes(conn, scope, from, to, &[])?;
    let whole_income: i64 = nodes.iter().filter(|n| n.kind == "income").map(|n| n.values[0]).sum();
    let whole_expense: i64 = nodes.iter().filter(|n| n.kind == "expense").map(|n| n.values[0]).sum();
    let cells = |v: &[i64], count: Option<i64>, kind: &str| -> Vec<ReportCell> {
        let whole = if kind == "income" { whole_income } else { whole_expense };
        vec![money(v[0]), pct(v[0], whole), count.map(|c| text(c.to_string())).unwrap_or_else(blank)]
    };
    let (mut rows, chart, income, expenses) = tree_rows(&nodes, 1, &cells);
    if scope.expense_only {
        rows.push(styled("Total spending", "total", vec![money(expenses[0]), blank(), blank()]));
    } else {
        rows.push(styled("Income less Expenses", "total", vec![money(income[0] - expenses[0]), blank(), blank()]));
    }
    Ok(Report {
        kind: String::new(),
        title: "Spending by category".to_string(),
        subtitle: String::new(),
        columns: vec![col("Subcategory", "text"), col("Total", "money"), col("% of section", "percent"), col("Count", "count")],
        rows,
        chart: Some(ReportChart {
            kind: "bar".to_string(),
            series: vec![ReportSeries { label: "Total".to_string(), points: chart.into_iter().filter(|(_, v)| *v != 0).collect() }],
        }),
    })
}

fn spending_by_payee(conn: &Conn, scope: &Scope, from: NaiveDate, to: NaiveDate) -> Result<Report, String> {
    let mut binds = vec![iso(from), iso(to)];
    let scoped = scope.lines_where(&mut binds);
    let sql = format!(
        "{LINES}
        SELECT COALESCE(NULLIF(l.payee, ''), '(no payee)'), l.payee_id,
               SUM(l.amount_cents), COUNT(DISTINCT l.txn_id)
          FROM lines l
         WHERE l.date >= ?1 AND l.date <= ?2{scoped}
         GROUP BY COALESCE(NULLIF(l.payee, ''), '(no payee)')
         ORDER BY SUM(l.amount_cents) ASC, 1 COLLATE NOCASE"
    );
    let data = query_rows(conn, &sql, &binds, |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?))
    })?;
    let whole: i64 = data.iter().map(|d| d.2).sum();
    let spend_whole: i64 = data.iter().filter(|d| d.2 < 0).map(|d| d.2).sum();
    let mut rows = Vec::new();
    let mut chart = Vec::new();
    for (name, pid, cents, n) in &data {
        rows.push(keyed(name, "payee", pid.as_deref().unwrap_or(""), 0, vec![money(-cents), pct(*cents, if *cents < 0 { spend_whole } else { whole - spend_whole }), text(n.to_string())]));
        if *cents < 0 && chart.len() < 20 {
            chart.push((name.clone(), -cents));
        }
    }
    rows.push(styled("Total", "total", vec![money(-whole), blank(), blank()]));
    Ok(Report {
        kind: String::new(),
        title: "Spending by payee".to_string(),
        subtitle: String::new(),
        columns: vec![col("Payee", "text"), col("Spent", "money"), col("% of spending", "percent"), col("Transactions", "count")],
        rows,
        chart: Some(ReportChart { kind: "bar".to_string(), series: vec![ReportSeries { label: "Spent".to_string(), points: chart }] }),
    })
}

// ---------------------------------------------------------------------------
// Months across
// ---------------------------------------------------------------------------

/// Category × month matrix, Money's "Monthly income and expenses": the same
/// tree, one column per month plus Total; month headers `8/2026`.
fn monthly_income_expenses(conn: &Conn, scope: &Scope, from: NaiveDate, to: NaiveDate) -> Result<Report, String> {
    let months = months_in(from, to);
    let nodes = category_nodes(conn, scope, from, to, &months)?;
    let n = months.len();
    let cells = |v: &[i64], _c: Option<i64>, _k: &str| -> Vec<ReportCell> {
        let mut out: Vec<ReportCell> = v.iter().map(|x| money(*x)).collect();
        out.push(money(v.iter().sum()));
        out
    };
    let (mut rows, _chart, income, expenses) = tree_rows(&nodes, n, &cells);
    let mut net: Vec<ReportCell> = (0..n).map(|i| money(income[i] - expenses[i])).collect();
    net.push(money(income.iter().sum::<i64>() - expenses.iter().sum::<i64>()));
    rows.push(styled("Income less Expenses", "total", net));
    let mut columns = vec![col("Subcategory", "text")];
    for m in &months {
        columns.push(col(&money_month_label(m), "money"));
    }
    columns.push(col("Total", "money"));
    // The over-time chart of the same numbers.
    let mut inc = Vec::new();
    let mut exp = Vec::new();
    for (i, m) in months.iter().enumerate() {
        inc.push((month_label(m), income[i]));
        exp.push((month_label(m), expenses[i]));
    }
    Ok(Report {
        kind: String::new(),
        title: "Monthly income and expenses".to_string(),
        subtitle: String::new(),
        columns,
        rows,
        chart: Some(ReportChart { kind: "bar".to_string(), series: vec![ReportSeries { label: "Income".to_string(), points: inc }, ReportSeries { label: "Expenses".to_string(), points: exp }] }),
    })
}

/// Income, expense and net per month — the "over time" bar chart.
fn income_spending_over_time(conn: &Conn, scope: &Scope, from: NaiveDate, to: NaiveDate) -> Result<Report, String> {
    let months = months_in(from, to);
    let mut binds = vec![iso(from), iso(to)];
    let scoped = scope.lines_where(&mut binds);
    let sql = format!(
        "{LINES}
        SELECT substr(l.date, 1, 7),
               COALESCE(SUM(CASE WHEN l.amount_cents > 0 THEN l.amount_cents ELSE 0 END), 0),
               COALESCE(SUM(CASE WHEN l.amount_cents < 0 THEN -l.amount_cents ELSE 0 END), 0)
          FROM lines l
         WHERE l.date >= ?1 AND l.date <= ?2{scoped}
         GROUP BY substr(l.date, 1, 7)"
    );
    let data: BTreeMap<String, (i64, i64)> = query_rows(conn, &sql, &binds, |r| Ok((r.get::<_, String>(0)?, (r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))))?.into_iter().collect();
    let mut rows = Vec::new();
    let (mut ti, mut te) = (0i64, 0i64);
    let mut inc = Vec::new();
    let mut exp = Vec::new();
    for m in &months {
        let (i, e) = *data.get(m).unwrap_or(&(0, 0));
        rows.push(keyed(&month_label(m), "month", m, 0, vec![money(i), money(e), money(i - e)]));
        ti += i;
        te += e;
        inc.push((month_label(m), i));
        exp.push((month_label(m), e));
    }
    rows.push(styled("Total", "total", vec![money(ti), money(te), money(ti - te)]));
    let n = months.len().max(1) as i64;
    rows.push(styled("Monthly average", "subtotal", vec![money(ti / n), money(te / n), money((ti - te) / n)]));
    Ok(Report {
        kind: String::new(),
        title: "Income and spending over time".to_string(),
        subtitle: String::new(),
        columns: vec![col("Month", "text"), col("Income", "money"), col("Spending", "money"), col("Net", "money")],
        rows,
        chart: Some(ReportChart {
            kind: "bar".to_string(),
            series: vec![ReportSeries { label: "Income".to_string(), points: inc }, ReportSeries { label: "Spending".to_string(), points: exp }],
        }),
    })
}

/// Totals for the range — Money's one-page "Income and spending": top-level
/// groups only, with their share, and a pie of spending.
fn income_and_spending(conn: &Conn, scope: &Scope, from: NaiveDate, to: NaiveDate) -> Result<Report, String> {
    let nodes = category_nodes(conn, scope, from, to, &[])?;
    let mut by_group: BTreeMap<(u8, String), i64> = BTreeMap::new();
    for n in &nodes {
        let k = if n.kind == "income" { 0 } else { 1 };
        let name = n.parent_name.clone().unwrap_or_else(|| n.name.clone());
        *by_group.entry((k, name)).or_insert(0) += n.values[0];
    }
    let income: i64 = by_group.iter().filter(|((k, _), _)| *k == 0).map(|(_, v)| *v).sum();
    let expense: i64 = by_group.iter().filter(|((k, _), _)| *k == 1).map(|(_, v)| *v).sum();
    let mut rows = Vec::new();
    let mut chart = Vec::new();
    for (k, title, whole) in [(0u8, "Income", income), (1u8, "Expenses", expense)] {
        let entries: Vec<_> = by_group.iter().filter(|((kk, _), _)| *kk == k).collect();
        if entries.is_empty() {
            continue;
        }
        rows.push(header(title, 2));
        for ((_, name), cents) in entries {
            rows.push(row(name, vec![money(*cents), pct(*cents, whole)]));
            if k == 1 {
                chart.push((name.clone(), *cents));
            }
        }
        rows.push(styled(&format!("Total {title}"), "subtotal", vec![money(whole), blank()]));
    }
    rows.push(styled("Income less Expenses", "total", vec![money(income - expense), blank()]));
    chart.sort_by(|a, b| b.1.cmp(&a.1));
    Ok(Report {
        kind: String::new(),
        title: "Income and spending".to_string(),
        subtitle: String::new(),
        columns: vec![col("Category", "text"), col("Amount", "money"), col("% of section", "percent")],
        rows,
        chart: Some(ReportChart { kind: "pie".to_string(), series: vec![ReportSeries { label: "Spending".to_string(), points: chart }] }),
    })
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

fn monthly_budget(conn: &Conn, scope: &Scope, from: NaiveDate, to: NaiveDate) -> Result<Report, String> {
    let months = months_in(from, to);
    let first = months.first().cloned().unwrap_or_default();
    let last = months.last().cloned().unwrap_or_default();
    // The date range is ?1/?2 as everywhere else. The budget months are
    // NUMBERED explicitly and bound LAST, because they appear in the SQL
    // AFTER the scope fragment: an anonymous `?` takes one past the largest
    // index seen so far IN THE TEXT, so a `?3`/`?4` written after the
    // fragment would be the same parameter as the fragment's own first
    // anonymous placeholder — the account id and the month bound to one
    // slot, and rusqlite refusing the call. (Found in review; this is the
    // only report whose binds did not start out as just the two dates.)
    let mut binds = vec![iso(from), iso(to)];
    // Everything is bound in the order its placeholders appear in the SQL
    // below — `{acct}` in the `spent` CTE, then the two month bounds, then
    // `{cat}` in the outer query. Getting that order wrong is invisible
    // until a filter is set, which is what the review found.
    let acct = format!("{}{}", scope.account_sql("l", &mut binds), scope.line_sql(&L, &mut binds));
    binds.push(first.clone());
    let first_at = format!("?{}", binds.len());
    binds.push(last.clone());
    let last_at = format!("?{}", binds.len());
    let cat = scope.category_sql("c.id", &mut binds);
    let sql = format!(
        "{LINES}
        , spent AS (
            SELECT category_id, SUM(-amount_cents) AS cents
              FROM lines l WHERE l.date >= ?1 AND l.date <= ?2 AND l.amount_cents < 0{acct}
             GROUP BY category_id
        ),
        budgeted AS (
            SELECT category_id, SUM(target_cents) AS cents
              FROM budgets WHERE month_year >= {first_at} AND month_year <= {last_at}
             GROUP BY category_id
        )
        SELECT c.id,
               CASE WHEN p.name IS NULL THEN c.name ELSE p.name || ' : ' || c.name END,
               COALESCE(b.cents, 0), COALESCE(s.cents, 0)
          FROM categories c
          LEFT JOIN categories p ON p.id = c.parent_id
          LEFT JOIN budgeted b ON b.category_id = c.id
          LEFT JOIN spent s ON s.category_id = c.id
         WHERE c.kind = 'expense' AND (b.cents IS NOT NULL OR COALESCE(s.cents, 0) > 0){cat}
         ORDER BY 2 COLLATE NOCASE"
    );
    let data = query_rows(conn, &sql, &binds, |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?)))?;
    let mut rows = Vec::new();
    let (mut tb, mut ts) = (0i64, 0i64);
    let mut chart_b = Vec::new();
    let mut chart_s = Vec::new();
    for (id, label, budget, spent) in &data {
        rows.push(keyed(label, "category", id, if label.contains(" : ") { 1 } else { 0 }, vec![money(*budget), money(*spent), money(budget - spent), pct(*spent, *budget)]));
        tb += budget;
        ts += spent;
        if *budget > 0 {
            chart_b.push((label.clone(), *budget));
            chart_s.push((label.clone(), *spent));
        }
    }
    rows.push(styled("Total", "total", vec![money(tb), money(ts), money(tb - ts), pct(ts, tb)]));
    Ok(Report {
        kind: String::new(),
        title: "Monthly budget".to_string(),
        subtitle: String::new(),
        columns: vec![col("Category", "text"), col("Budgeted", "money"), col("Actual", "money"), col("Remaining", "money"), col("% used", "percent")],
        rows,
        chart: Some(ReportChart { kind: "bar".to_string(), series: vec![ReportSeries { label: "Budgeted".to_string(), points: chart_b }, ReportSeries { label: "Actual".to_string(), points: chart_s }] }),
    })
}

/// Budget vs actual, months across.
fn annual_budget(conn: &Conn, scope: &Scope, from: NaiveDate, to: NaiveDate) -> Result<Report, String> {
    let months = months_in(from, to);
    let mut binds = vec![iso(from), iso(to)];
    let acct = format!("{}{}", scope.account_sql("l", &mut binds), scope.line_sql(&L, &mut binds));
    let sql = format!(
        "{LINES}
        SELECT category_id, substr(date, 1, 7), SUM(-amount_cents)
          FROM lines l WHERE l.date >= ?1 AND l.date <= ?2 AND l.amount_cents < 0 AND category_id IS NOT NULL{acct}
         GROUP BY category_id, substr(date, 1, 7)"
    );
    let spent: BTreeMap<(String, String), i64> = query_rows(conn, &sql, &binds, |r| Ok(((r.get::<_, String>(0)?, r.get::<_, String>(1)?), r.get::<_, i64>(2)?)))?.into_iter().collect();
    let first = months.first().cloned().unwrap_or_default();
    let last = months.last().cloned().unwrap_or_default();
    let budgets: BTreeMap<(String, String), i64> = query_rows(
        conn,
        "SELECT category_id, month_year, target_cents FROM budgets WHERE month_year >= ?1 AND month_year <= ?2",
        &[first, last],
        |r| Ok(((r.get::<_, String>(0)?, r.get::<_, String>(1)?), r.get::<_, i64>(2)?)),
    )?
    .into_iter()
    .collect();
    let mut cat_ids: Vec<String> = budgets.keys().map(|k| k.0.clone()).collect();
    cat_ids.sort();
    cat_ids.dedup();
    // The include list, or the exclude list — the budget rows are
    // filtered in Rust here because they come from `budgets`, not `lines`.
    if scope.categories.is_some() {
        cat_ids.retain(|c| scope.wants_category(c));
    }
    let names: BTreeMap<String, String> = query_rows(
        conn,
        "SELECT c.id, CASE WHEN p.name IS NULL THEN c.name ELSE p.name || ' : ' || c.name END
           FROM categories c LEFT JOIN categories p ON p.id = c.parent_id",
        &[],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
    )?
    .into_iter()
    .collect();
    let mut columns = vec![col("Category", "text")];
    for m in &months {
        columns.push(col(&month_label(m), "money"));
    }
    columns.push(col("Budget", "money"));
    columns.push(col("Actual", "money"));
    columns.push(col("Difference", "money"));
    let mut rows = Vec::new();
    let mut col_b = vec![0i64; months.len()];
    let mut col_s = vec![0i64; months.len()];
    let mut ids_sorted: Vec<(String, String)> = cat_ids.iter().map(|id| (names.get(id).cloned().unwrap_or_default(), id.clone())).collect();
    ids_sorted.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
    for (label, id) in ids_sorted {
        let mut cells = Vec::new();
        let (mut b_sum, mut s_sum) = (0i64, 0i64);
        for (i, m) in months.iter().enumerate() {
            let b = *budgets.get(&(id.clone(), m.clone())).unwrap_or(&0);
            let s = *spent.get(&(id.clone(), m.clone())).unwrap_or(&0);
            // Each month cell is the difference: under budget positive.
            cells.push(money(b - s));
            b_sum += b;
            s_sum += s;
            col_b[i] += b;
            col_s[i] += s;
        }
        cells.push(money(b_sum));
        cells.push(money(s_sum));
        cells.push(money(b_sum - s_sum));
        rows.push(keyed(&label, "category", &id, if label.contains(" : ") { 1 } else { 0 }, cells));
    }
    let mut total: Vec<ReportCell> = (0..months.len()).map(|i| money(col_b[i] - col_s[i])).collect();
    let (tb, ts): (i64, i64) = (col_b.iter().sum(), col_s.iter().sum());
    total.push(money(tb));
    total.push(money(ts));
    total.push(money(tb - ts));
    rows.push(styled("Total", "total", total));
    Ok(Report {
        kind: String::new(),
        title: "Annual budget (budget − actual, by month)".to_string(),
        subtitle: String::new(),
        columns,
        rows,
        chart: None,
    })
}

// ---------------------------------------------------------------------------
// Transaction lists
// ---------------------------------------------------------------------------

/// One transaction line under its category, for the tree layouts.
struct CatTxn {
    kind: String,
    parent_id: String,
    parent_name: String,
    /// `None` for a top-level category's own lines.
    child_id: Option<String>,
    child_name: Option<String>,
    txn_id: String,
    date: String,
    cells: Vec<ReportCell>,
    cents: i64,
    /// Which cell index holds the amount, for subtotal rows.
    amount_at: usize,
}

/// Money's grouped transaction list (its Tax-Related Transactions report):
/// section, parent (bold, rule), subcategory, its transactions, a subtotal,
/// then "Total Parent". `data` must arrive sorted
/// by kind (income first), parent, child, date.
fn category_txn_tree(data: Vec<CatTxn>, ncells: usize, from: NaiveDate) -> Vec<ReportLine> {
    let mut rows = Vec::new();
    let amount_at = data.first().map(|d| d.amount_at).unwrap_or(ncells - 1);
    let amount_row = |label: &str, style: &str, level: u8, cents: i64| {
        let mut cells: Vec<ReportCell> = (0..ncells).map(|_| blank()).collect();
        cells[amount_at] = money(cents);
        let mut r = styled(label, style, cells);
        r.level = level;
        r
    };
    let mut kind: Option<String> = None;
    let mut parent: Option<(String, String)> = None;
    let mut child: Option<(Option<String>, Option<String>)> = None;
    let (mut parent_sum, mut child_sum, mut grand) = (0i64, 0i64, 0i64);
    let mut count = 0usize;
    // A subcategory closes with its own subtotal; a childless parent's lines
    // go straight to "Total Parent" rather than printing the sum twice.
    let close_child = |rows: &mut Vec<ReportLine>, child: &Option<(Option<String>, Option<String>)>, sum: i64| {
        if matches!(child, Some((Some(_), _))) {
            rows.push(amount_row("", "subtotal", 2, sum));
        }
    };
    let close_parent = |rows: &mut Vec<ReportLine>, parent: &Option<(String, String)>, sum: i64| {
        if let Some((pid, pname)) = parent {
            let mut t = amount_row(&format!("Total {pname}"), "subtotal", 0, sum);
            t.key = Some(pid.clone());
            t.key_kind = Some("category".to_string());
            rows.push(t);
        }
    };
    for d in data {
        if kind.as_deref() != Some(d.kind.as_str()) {
            close_child(&mut rows, &child, child_sum);
            close_parent(&mut rows, &parent, parent_sum);
            child = None;
            parent = None;
            rows.push(header(if d.kind == "income" { "Income Categories" } else { "Expense Categories" }, ncells));
            kind = Some(d.kind.clone());
        }
        if parent.as_ref().map(|(id, _)| id != &d.parent_id).unwrap_or(true) {
            close_child(&mut rows, &child, child_sum);
            close_parent(&mut rows, &parent, parent_sum);
            child = None;
            parent_sum = 0;
            let mut g = keyed(&d.parent_name, "category", &d.parent_id, 0, (0..ncells).map(|_| blank()).collect());
            g.style = "group".to_string();
            rows.push(g);
            parent = Some((d.parent_id.clone(), d.parent_name.clone()));
        }
        let this_child = (d.child_id.clone(), d.child_name.clone());
        if child.as_ref() != Some(&this_child) {
            close_child(&mut rows, &child, child_sum);
            child_sum = 0;
            if let (Some(cid), Some(cname)) = (&d.child_id, &d.child_name) {
                let mut c = keyed(cname, "category", cid, 1, (0..ncells).map(|_| blank()).collect());
                c.style = "normal".to_string();
                rows.push(c);
            }
            child = Some(this_child);
        }
        let level = if d.child_id.is_some() { 2 } else { 1 };
        let mut r = keyed(&us(parse_date(&d.date).unwrap_or(from)), "transaction", &d.txn_id, level, d.cells);
        r.style = "normal".to_string();
        rows.push(r);
        child_sum += d.cents;
        parent_sum += d.cents;
        grand += d.cents;
        count += 1;
    }
    close_child(&mut rows, &child, child_sum);
    close_parent(&mut rows, &parent, parent_sum);
    rows.push(amount_row(&format!("Grand total ({count} transactions)"), "total", 0, grand));
    rows
}

#[derive(Clone, Copy, PartialEq)]
enum GroupBy {
    Category,
    Payee,
    Account,
}

fn transactions_grouped(conn: &Conn, scope: &Scope, from: NaiveDate, to: NaiveDate, by: GroupBy) -> Result<Report, String> {
    if by == GroupBy::Category {
        return transactions_by_category_tree(conn, scope, from, to);
    }
    let mut binds = vec![iso(from), iso(to)];
    let (sql, title) = match by {
        GroupBy::Account => {
            // Everything, transfers included: this is the register, by account.
            // The same line filters as everywhere else, over raw
            // transaction rows rather than the `lines` CTE.
            let scoped = format!(
                "{}{}{}",
                scope.account_sql("t", &mut binds),
                scope.category_sql("t.category_id", &mut binds),
                scope.line_sql(&T, &mut binds)
            );
            (format!(
                "SELECT a.id, a.name, t.id, t.date, t.check_number, t.payee,
                        COALESCE(CASE WHEN p.name IS NULL THEN c.name ELSE p.name || ' : ' || c.name END,
                                 CASE WHEN t.transfer_id IS NOT NULL THEN 'Transfer' END,
                                 CASE WHEN EXISTS (SELECT 1 FROM splits s WHERE s.transaction_id = t.id) THEN 'Split' END, ''),
                        t.notes, t.amount_cents, t.cleared_state
                   FROM transactions t
                   JOIN accounts a ON a.id = t.account_id
                   LEFT JOIN categories c ON c.id = t.category_id
                   LEFT JOIN categories p ON p.id = c.parent_id
                  WHERE t.is_void = 0 AND t.date >= ?1 AND t.date <= ?2{scoped}
                  ORDER BY a.name COLLATE NOCASE, t.date, t.rowid"
            ), "Account transactions")
        }
        GroupBy::Category => {
            let scoped = scope.lines_where(&mut binds);
            (format!(
                "{LINES}
                 SELECT COALESCE(c.id, ''),
                        COALESCE(CASE WHEN p.name IS NULL THEN c.name ELSE p.name || ' : ' || c.name END, 'Uncategorized'),
                        l.txn_id, l.date, l.check_number, l.payee, a.name, l.memo, l.amount_cents, ''
                   FROM lines l
                   JOIN accounts a ON a.id = l.account_id
                   LEFT JOIN categories c ON c.id = l.category_id
                   LEFT JOIN categories p ON p.id = c.parent_id
                  WHERE l.date >= ?1 AND l.date <= ?2{scoped}
                  ORDER BY COALESCE(c.kind, 'expense') DESC, 2 COLLATE NOCASE, l.date, l.txn_id"
            ), "Transactions by category")
        }
        GroupBy::Payee => {
            let scoped = scope.lines_where(&mut binds);
            (format!(
                "{LINES}
                 SELECT COALESCE(l.payee_id, ''), COALESCE(NULLIF(l.payee, ''), '(no payee)'),
                        l.txn_id, l.date, l.check_number, a.name,
                        COALESCE(CASE WHEN p.name IS NULL THEN c.name ELSE p.name || ' : ' || c.name END, ''),
                        l.memo, l.amount_cents, ''

                   FROM lines l
                   JOIN accounts a ON a.id = l.account_id
                   LEFT JOIN categories c ON c.id = l.category_id
                   LEFT JOIN categories p ON p.id = c.parent_id
                  WHERE l.date >= ?1 AND l.date <= ?2{scoped}
                  ORDER BY 2 COLLATE NOCASE, l.date, l.txn_id"
            ), "Transactions by payee")
        }
    };
    let data = query_rows(conn, &sql, &binds, |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, Option<String>>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, String>(6)?,
            r.get::<_, Option<String>>(7)?,
            r.get::<_, i64>(8)?,
            r.get::<_, String>(9)?,
        ))
    })?;
    let key_kind = match by {
        GroupBy::Account => "account",
        GroupBy::Category => "category",
        GroupBy::Payee => "payee",
    };
    // Money's column sets: the grouping column drops out, the other two stay.
    let (col_a, col_b) = match by {
        GroupBy::Account => ("Payee", "Category"),
        GroupBy::Category => ("Payee", "Account"),
        GroupBy::Payee => ("Account", "Category"),
    };
    let columns = vec![
        col("Date", "date"),
        col("Num", "text"),
        col(col_a, "text"),
        col(col_b, "text"),
        col("Memo", "text"),
        col("Amount", "money"),
        col("C", "text"),
    ];
    let mut rows = Vec::new();
    let mut current: Option<(String, String)> = None;
    let mut sub = 0i64;
    let mut grand = 0i64;
    let mut count = 0usize;
    let flush = |rows: &mut Vec<ReportLine>, current: &Option<(String, String)>, sub: i64| {
        if let Some((_, name)) = current {
            rows.push(styled(&format!("Total {name}"), "subtotal", vec![blank(), blank(), blank(), blank(), money(sub), blank()]));
        }
    };
    for (gid, gname, txn_id, date, num, a, b, memo, cents, cleared) in data {
        if current.as_ref().map(|(id, name)| id != &gid || name != &gname).unwrap_or(true) {
            flush(&mut rows, &current, sub);
            sub = 0;
            let mut h = header(&gname, 6);
            h.key = Some(gid.clone());
            h.key_kind = Some(key_kind.to_string());
            rows.push(h);
            current = Some((gid.clone(), gname.clone()));
        }
        let r = keyed(&us(parse_date(&date).unwrap_or(from)), "transaction", &txn_id, 1, vec![
            text(num.unwrap_or_default()),
            text(a),
            text(b),
            text(memo.unwrap_or_default()),
            money(cents),
            text(cleared),
        ]);
        rows.push(r);
        sub += cents;
        grand += cents;
        count += 1;
    }
    flush(&mut rows, &current, sub);
    rows.push(styled(&format!("Grand total ({count} transactions)"), "total", vec![blank(), blank(), blank(), blank(), money(grand), blank()]));
    Ok(Report { kind: String::new(), title: title.to_string(), subtitle: String::new(), columns, rows, chart: None })
}

// ---------------------------------------------------------------------------
// Balances, net worth
// ---------------------------------------------------------------------------

struct AcctBal {
    id: String,
    name: String,
    kind: String,
    is_closed: bool,
    cents: i64,
}

/// Every account's balance as of the end of `asof`.
fn balances_asof(conn: &Conn, scope: &Scope, asof: NaiveDate) -> Result<Vec<AcctBal>, String> {
    let mut binds = vec![iso(asof)];
    let acct = scope.account_sql("a", &mut binds).replace("a.account_id", "a.id");
    let sql = format!(
        "SELECT a.id, a.name, a.type, a.is_closed,
                a.balance_cents - COALESCE((SELECT SUM(t.amount_cents) FROM transactions t
                                             WHERE t.account_id = a.id AND t.is_void = 0 AND t.date > ?1), 0)
           FROM accounts a
          WHERE 1 = 1{acct}
          ORDER BY a.name COLLATE NOCASE"
    );
    let mut bals = query_rows(conn, &sql, &binds, |r| {
        Ok(AcctBal { id: r.get(0)?, name: r.get(1)?, kind: r.get(2)?, is_closed: r.get::<_, i64>(3)? != 0, cents: r.get(4)? })
    })?;
    // An investment account is worth its cash plus what it holds, at the
    // prices of the day. Lots are replayed to the date, so a share
    // bought later is not counted earlier.
    if bals.iter().any(|b| matches!(b.kind.as_str(), "investment" | "retirement")) {
        let held = lots::holdings_by_account(conn, &iso(asof))?;
        for b in bals.iter_mut() {
            if let Some(v) = held.get(&b.id) {
                b.cents += v;
            }
        }
    }
    Ok(bals)
}

/// Money's grouping of the account taxonomy for net worth.
fn asset_group(kind: &str) -> (&'static str, &'static str) {
    match kind {
        "bank" | "checking" | "savings" | "cash" => ("asset", "Bank and cash"),
        "investment" | "retirement" | "employee_stock_option" | "watch" => ("asset", "Investments"),
        "asset" | "vehicle" | "home" => ("asset", "Property and other assets"),
        "credit" | "line_of_credit" => ("liability", "Credit cards and lines of credit"),
        "loan" | "mortgage" | "home_equity_line_of_credit" | "liability" => ("liability", "Loans and mortgages"),
        _ => ("asset", "Other"),
    }
}

/// Net worth as of a date, at one of Money's three levels of detail
/// (as its Net Worth report shows them). Liabilities print POSITIVE, as Money
/// does, and Net Worth = Assets − Liabilities.
fn net_worth(conn: &Conn, scope: &Scope, asof: NaiveDate, detail: &str) -> Result<Report, String> {
    let bals = balances_asof(conn, scope, asof)?;
    let mut rows = Vec::new();
    let (mut assets, mut liabilities) = (0i64, 0i64);
    let mut chart = Vec::new();
    for (side, title) in [("asset", "Assets"), ("liability", "Liabilities")] {
        let sign = if side == "asset" { 1 } else { -1 };
        let mut groups: BTreeMap<&str, Vec<&AcctBal>> = BTreeMap::new();
        for b in bals.iter().filter(|b| !b.is_closed || b.cents != 0) {
            let (s, g) = asset_group(&b.kind);
            if s == side {
                groups.entry(g).or_default().push(b);
            }
        }
        if groups.is_empty() {
            continue;
        }
        rows.push(header(title, 1));
        let mut side_total = 0i64;
        for (g, accts) in groups {
            let gsum: i64 = accts.iter().map(|a| a.cents).sum::<i64>() * sign;
            match detail {
                "sides" => {}
                "accounts" => {
                    let mut gr = styled(g, "group", vec![blank()]);
                    gr.level = 0;
                    rows.push(gr);
                    for a in accts {
                        if a.id.is_empty() {
                            let mut r = row(&a.name, vec![money(a.cents * sign)]);
                            r.level = 1;
                            rows.push(r);
                        } else {
                            rows.push(keyed(&a.name, "account", &a.id, 1, vec![money(a.cents * sign)]));
                        }
                    }
                    let mut t = styled(&format!("Total {g}"), "subtotal", vec![money(gsum)]);
                    t.level = 1;
                    rows.push(t);
                }
                _ => rows.push(row(g, vec![money(gsum)])),
            }
            side_total += gsum;
            chart.push((g.to_string(), gsum));
        }
        rows.push(styled(&format!("Total {title}"), "subtotal", vec![money(side_total)]));
        if side == "asset" {
            assets = side_total;
        } else {
            liabilities = side_total;
        }
    }
    rows.push(styled("Net Worth", "total", vec![money(assets - liabilities)]));
    Ok(Report {
        kind: String::new(),
        title: "Net worth".to_string(),
        subtitle: format!("As of {}", us(asof)),
        columns: vec![col("Account", "text"), col("Total", "money")],
        rows,
        chart: Some(ReportChart { kind: "pie".to_string(), series: vec![ReportSeries { label: "Balance".to_string(), points: chart }] }),
    })
}

fn account_balances(conn: &Conn, scope: &Scope, asof: NaiveDate, details: bool) -> Result<Report, String> {
    let bals = balances_asof(conn, scope, asof)?;
    let detail: BTreeMap<String, (Option<String>, Option<String>, Option<String>, Option<i64>)> = if details {
        query_rows(conn, "SELECT id, institution, account_number, opened_on, credit_limit_cents FROM accounts", &[], |r| {
            Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
        })?
        .into_iter()
        .collect()
    } else {
        BTreeMap::new()
    };
    let mut columns = vec![col("Account", "text"), col("Balance", "money")];
    if details {
        columns.extend([col("Type", "text"), col("Institution", "text"), col("Number", "text"), col("Opened", "text"), col("Credit limit", "money")]);
    }
    let mut rows = Vec::new();
    let mut total = 0i64;
    let mut groups: BTreeMap<&str, Vec<&AcctBal>> = BTreeMap::new();
    for b in &bals {
        groups.entry(asset_group(&b.kind).1).or_default().push(b);
    }
    for (g, accts) in groups {
        rows.push(header(g, columns.len() - 1));
        let mut gsum = 0i64;
        for a in accts {
            let mut cells = vec![money(a.cents)];
            if details {
                let d = detail.get(&a.id).cloned().unwrap_or((None, None, None, None));
                cells.push(text(a.kind.replace('_', " ")));
                cells.push(text(d.0.unwrap_or_default()));
                // Masked, like the details dialog: only the last four.
                cells.push(text(d.1.map(|n| {
                    let tail: String = n.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
                    if n.len() > 4 { format!("…{tail}") } else { n }
                }).unwrap_or_default()));
                cells.push(text(d.2.map(|o| parse_date(&o).map(us).unwrap_or(o)).unwrap_or_default()));
                cells.push(d.3.map(money).unwrap_or_else(blank));
            }
            let mut r = keyed(&a.name, "account", &a.id, 1, cells);
            if a.is_closed {
                r.label = format!("{} (closed)", a.name);
            }
            rows.push(r);
            gsum += a.cents;
        }
        let mut sub = vec![money(gsum)];
        sub.extend((1..columns.len() - 1).map(|_| blank()));
        rows.push(styled(&format!("Total {g}"), "subtotal", sub));
        total += gsum;
    }
    let mut t = vec![money(total)];
    t.extend((1..columns.len() - 1).map(|_| blank()));
    rows.push(styled("Net Worth", "total", t));
    Ok(Report {
        kind: String::new(),
        title: if details { "Account balances with details" } else { "Account balances" }.to_string(),
        subtitle: format!("As of {}", us(asof)),
        columns,
        rows,
        chart: None,
    })
}

/// Month-end balance per account, months across.
fn account_balance_history(conn: &Conn, scope: &Scope, from: NaiveDate, to: NaiveDate) -> Result<Report, String> {
    let months = months_in(from, to);
    let mut per_month: Vec<Vec<AcctBal>> = Vec::new();
    for m in &months {
        per_month.push(balances_asof(conn, scope, month_end(m).min(to))?);
    }
    let mut columns = vec![col("Account", "text")];
    for m in &months {
        columns.push(col(&month_label(m), "money"));
    }
    let mut rows = Vec::new();
    let names: Vec<(String, String)> = per_month.first().map(|v| v.iter().map(|a| (a.id.clone(), a.name.clone())).collect()).unwrap_or_default();
    let mut totals = vec![0i64; months.len()];
    let mut series: Vec<ReportSeries> = Vec::new();
    for (id, name) in names {
        let mut cells = Vec::new();
        let mut points = Vec::new();
        for (i, pm) in per_month.iter().enumerate() {
            let v = pm.iter().find(|a| a.id == id).map(|a| a.cents).unwrap_or(0);
            cells.push(money(v));
            totals[i] += v;
            points.push((month_label(&months[i]), v));
        }
        rows.push(keyed(&name, "account", &id, 0, cells));
        series.push(ReportSeries { label: name, points });
    }
    rows.push(styled("Net Worth", "total", totals.iter().map(|v| money(*v)).collect()));
    Ok(Report {
        kind: String::new(),
        title: "Account balance history".to_string(),
        subtitle: String::new(),
        columns,
        rows,
        chart: Some(ReportChart { kind: "line".to_string(), series }),
    })
}

/// Net worth split by how quickly it can be reached, not by account
/// type. A net worth number hides the question people actually ask of it —
/// how much of that could I spend this month? Cash and bank balances can be
/// spent today. A taxable brokerage can be sold in a week. A 401(k) or an IRA
/// cannot be touched without a tax bill. A house cannot be touched at all
/// without selling it.
///
/// Debts are subtracted whole, at the bottom, rather than netted against a
/// tier: a mortgage is not "less house", it is money owed, and pretending
/// otherwise is how people talk themselves into thinking they are liquid.
/// "Asset allocation": what kind of thing the money is in, on a date.
/// One section per account (cash included as its own line), a pie of the
/// whole by kind. The kind is the security's type under Securities…; an
/// imported security starts as Other, and the report says so rather than
/// guessing.
fn asset_allocation(conn: &Conn, scope: &Scope, asof: NaiveDate) -> Result<Report, String> {
    fn label(kind: &str) -> &'static str {
        match kind {
            "stock" => "Stocks",
            "etf" => "Exchange-traded funds",
            "mutual_fund" => "Mutual funds",
            "bond" => "Bonds",
            "cd" => "CDs",
            "money_market" => "Money market",
            "cash" => "Cash",
            _ => "Other",
        }
    }
    const ORDER: &[&str] = &["stock", "etf", "mutual_fund", "bond", "cd", "money_market", "cash", "other"];
    let day = iso(asof);
    // One portfolio per account in scope, or the whole file's.
    let accounts: Vec<Option<String>> = match &scope.accounts {
        Some(ids) => ids.iter().map(|a| Some(a.clone())).collect(),
        None => vec![None],
    };
    let mut by_account: BTreeMap<String, (String, BTreeMap<&'static str, i64>)> = BTreeMap::new();
    let mut whole: BTreeMap<&'static str, i64> = BTreeMap::new();
    let mut untyped = 0usize;
    for a in &accounts {
        let p = lots::portfolio(conn, a.as_deref(), &day)?;
        for pos in p.positions.iter().filter(|x| scope.wants_security(&x.security_id)) {
            let k = if ORDER.contains(&pos.security_kind.as_str()) { pos.security_kind.as_str() } else { "other" };
            let k: &'static str = ORDER.iter().copied().find(|o| *o == k).unwrap_or("other");
            if k == "other" {
                untyped += 1;
            }
            let e = by_account.entry(pos.account_name.clone()).or_insert_with(|| (pos.account_id.clone(), BTreeMap::new()));
            *e.1.entry(k).or_insert(0) += pos.value_cents;
            *whole.entry(k).or_insert(0) += pos.value_cents;
        }
        // Cash: the file's investment accounts as one line when unscoped,
        // else this account's.
        if p.cash_cents > 0 {
            let name = match a {
                Some(id) => crate::db::queries::get_account(conn, id).map(|x| x.name).unwrap_or_else(|_| "Cash".to_string()),
                None => "Cash in investment accounts".to_string(),
            };
            let e = by_account.entry(name).or_insert_with(|| (a.clone().unwrap_or_default(), BTreeMap::new()));
            *e.1.entry("cash").or_insert(0) += p.cash_cents;
            *whole.entry("cash").or_insert(0) += p.cash_cents;
        }
    }
    let total: i64 = whole.values().sum();
    let mut rows = Vec::new();
    let mut chart = Vec::new();
    for (name, (id, kinds)) in &by_account {
        let sum: i64 = kinds.values().sum();
        if sum == 0 {
            continue;
        }
        // A header has a cell per column too — `header(name, 0)` gave
        // the CSV a one-field line under a three-field heading.
        rows.push(if id.is_empty() { header(name, 2) } else { keyed(name, "account", id, 0, vec![money(sum), pct(sum, total)]) });
        for k in ORDER {
            if let Some(v) = kinds.get(k) {
                if *v != 0 {
                    let mut r = row(label(k), vec![money(*v), pct(*v, sum)]);
                    r.level = 1;
                    rows.push(r);
                }
            }
        }
    }
    for k in ORDER {
        if let Some(v) = whole.get(k) {
            if *v != 0 {
                chart.push((label(k).to_string(), *v));
            }
        }
    }
    rows.push(styled("Total", "total", vec![money(total), pct(total, total)]));
    if untyped > 0 {
        rows.push(styled(
            &format!("{untyped} holding{} counted as Other: set the type under Investing → Securities…", if untyped == 1 { "" } else { "s" }),
            "normal",
            vec![blank(), blank()],
        ));
    }
    Ok(Report {
        kind: String::new(),
        title: "Asset allocation".to_string(),
        subtitle: format!("As of {}", us(asof)),
        columns: vec![col("Kind", "text"), col("Value", "money"), col("Share", "percent")],
        rows,
        chart: Some(ReportChart { kind: "pie".to_string(), series: vec![ReportSeries { label: "Value".to_string(), points: chart }] }),
    })
}

fn liquid_net_worth(conn: &Conn, scope: &Scope, asof: NaiveDate) -> Result<Report, String> {
    /// Which tier an account kind falls into, and how it is described.
    fn tier(kind: &str) -> Option<(u8, &'static str)> {
        match kind {
            "bank" | "checking" | "savings" | "cash" => Some((0, "Liquid — spendable now")),
            "investment" | "employee_stock_option" | "watch" => Some((1, "Investments — days to reach")),
            "retirement" => Some((2, "Retirement — locked up until drawn")),
            "asset" | "vehicle" | "home" => Some((3, "Property — only by selling")),
            _ => None,
        }
    }

    let bals = balances_asof(conn, scope, asof)?;
    let live: Vec<&AcctBal> = bals.iter().filter(|b| !b.is_closed || b.cents != 0).collect();

    let mut rows = Vec::new();
    let mut chart = Vec::new();
    let mut assets = 0i64;
    for want in 0u8..4 {
        let mut label = "";
        let mut accts: Vec<&&AcctBal> = Vec::new();
        for b in &live {
            if let Some((t, l)) = tier(&b.kind) {
                if t == want {
                    label = l;
                    accts.push(b);
                }
            }
        }
        if accts.is_empty() {
            continue;
        }
        let sum: i64 = accts.iter().map(|a| a.cents).sum();
        rows.push(header(label, 1));
        for a in accts {
            if a.id.is_empty() {
                let mut r = row(&a.name, vec![money(a.cents)]);
                r.level = 1;
                rows.push(r);
            } else {
                rows.push(keyed(&a.name, "account", &a.id, 1, vec![money(a.cents)]));
            }
        }
        rows.push(styled(&format!("Total {label}"), "subtotal", vec![money(sum)]));
        chart.push((label.to_string(), sum));
        assets += sum;
    }

    // Anything an account kind the tiers do not name — never silently dropped
    // from a total that claims to be net worth.
    let other: Vec<&&AcctBal> = live.iter().filter(|b| tier(&b.kind).is_none() && asset_group(&b.kind).0 == "asset").collect();
    if !other.is_empty() {
        let sum: i64 = other.iter().map(|a| a.cents).sum();
        rows.push(header("Other assets", 1));
        for a in other {
            rows.push(keyed(&a.name, "account", &a.id, 1, vec![money(a.cents)]));
        }
        rows.push(styled("Total Other assets", "subtotal", vec![money(sum)]));
        chart.push(("Other assets".to_string(), sum));
        assets += sum;
    }

    rows.push(styled("Total assets", "bold", vec![money(assets)]));

    let debts: Vec<&&AcctBal> = live.iter().filter(|b| asset_group(&b.kind).0 == "liability").collect();
    let owed: i64 = -debts.iter().map(|a| a.cents).sum::<i64>();
    if !debts.is_empty() {
        rows.push(header("Owed", 1));
        for a in debts {
            rows.push(keyed(&a.name, "account", &a.id, 1, vec![money(-a.cents)]));
        }
        rows.push(styled("Total owed", "subtotal", vec![money(owed)]));
    }
    rows.push(styled("Net Worth", "total", vec![money(assets - owed)]));

    Ok(Report {
        kind: String::new(),
        title: "Liquid, locked up and illiquid".to_string(),
        subtitle: format!("As of {}", us(asof)),
        columns: vec![col("Account", "text"), col("Total", "money")],
        rows,
        chart: Some(ReportChart {
            kind: "pie".to_string(),
            series: vec![ReportSeries { label: "Assets".to_string(), points: chart }],
        }),
    })
}

fn net_worth_over_time(conn: &Conn, scope: &Scope, from: NaiveDate, to: NaiveDate) -> Result<Report, String> {
    let months = months_in(from, to);
    let mut rows = Vec::new();
    let mut s_assets = Vec::new();
    let mut s_liab = Vec::new();
    let mut s_net = Vec::new();
    let mut prev: Option<i64> = None;
    for m in &months {
        let bals = balances_asof(conn, scope, month_end(m).min(to))?;
        let assets: i64 = bals.iter().filter(|b| asset_group(&b.kind).0 == "asset").map(|b| b.cents).sum::<i64>();
        let liab: i64 = -bals.iter().filter(|b| asset_group(&b.kind).0 == "liability").map(|b| b.cents).sum::<i64>();
        let net = assets - liab;
        let change = prev.map(|p| net - p).unwrap_or(0);
        rows.push(keyed(&month_label(m), "month", m, 0, vec![money(assets), money(liab), money(net), money(change)]));
        s_assets.push((month_label(m), assets));
        s_liab.push((month_label(m), liab));
        s_net.push((month_label(m), net));
        prev = Some(net);
    }
    Ok(Report {
        kind: String::new(),
        title: "Net worth over time".to_string(),
        subtitle: String::new(),
        columns: vec![col("Month", "text"), col("Assets", "money"), col("Liabilities", "money"), col("Net worth", "money"), col("Change", "money")],
        rows,
        chart: Some(ReportChart {
            kind: "line".to_string(),
            series: vec![ReportSeries { label: "Net worth".to_string(), points: s_net }, ReportSeries { label: "Assets".to_string(), points: s_assets }, ReportSeries { label: "Liabilities".to_string(), points: s_liab }],
        }),
    })
}

fn credit_card_debt(conn: &Conn, scope: &Scope, from: NaiveDate, to: NaiveDate) -> Result<Report, String> {
    let months = months_in(from, to);
    let mut columns = vec![col("Card", "text")];
    for m in &months {
        columns.push(col(&month_label(m), "money"));
    }
    let mut per_month: Vec<Vec<AcctBal>> = Vec::new();
    for m in &months {
        let mut b = balances_asof(conn, scope, month_end(m).min(to))?;
        b.retain(|a| matches!(a.kind.as_str(), "credit" | "line_of_credit"));
        per_month.push(b);
    }
    let cards: Vec<(String, String)> = per_month.first().map(|v| v.iter().map(|a| (a.id.clone(), a.name.clone())).collect()).unwrap_or_default();
    let mut rows = Vec::new();
    let mut totals = vec![0i64; months.len()];
    let mut series = Vec::new();
    for (id, name) in cards {
        let mut cells = Vec::new();
        let mut points = Vec::new();
        for (i, pm) in per_month.iter().enumerate() {
            // Debt shown positive.
            let v = -pm.iter().find(|a| a.id == id).map(|a| a.cents).unwrap_or(0);
            cells.push(money(v));
            totals[i] += v;
            points.push((month_label(&months[i]), v));
        }
        rows.push(keyed(&name, "account", &id, 0, cells));
        series.push(ReportSeries { label: name, points });
    }
    rows.push(styled("Total debt", "total", totals.iter().map(|v| money(*v)).collect()));
    Ok(Report {
        kind: String::new(),
        title: "Credit card debt".to_string(),
        subtitle: String::new(),
        columns,
        rows,
        chart: Some(ReportChart { kind: "line".to_string(), series }),
    })
}

// ---------------------------------------------------------------------------
// Bills, investments, taxes
// ---------------------------------------------------------------------------

fn scheduled_bills(conn: &Conn, from: NaiveDate, to: NaiveDate, upcoming_only: bool) -> Result<Report, String> {
    let today = chrono::Local::now().date_naive();
    let occ = crate::db::queries::occurrences_between(conn, from, to, today)?;
    let names: BTreeMap<String, String> = query_rows(conn, "SELECT id, name FROM accounts", &[], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?.into_iter().collect();
    let mut rows = Vec::new();
    let (mut t_in, mut t_out) = (0i64, 0i64);
    for o in occ.iter().filter(|o| !upcoming_only || o.status == "due" || o.status == "overdue") {
        let acct = o.account_id.as_ref().and_then(|a| names.get(a)).cloned().unwrap_or_default();
        rows.push(keyed(&parse_date(&o.due_date).map(us).unwrap_or_else(|_| o.due_date.clone()), "recurrence", &o.recurrence_id, 0, vec![
            text(o.payee.clone()),
            text(acct),
            money(o.amount_cents),
            text(o.status.clone()),
        ]));
        if o.amount_cents > 0 { t_in += o.amount_cents } else { t_out += o.amount_cents }
    }
    rows.push(styled("Deposits", "subtotal", vec![blank(), blank(), money(t_in), blank()]));
    rows.push(styled("Bills", "subtotal", vec![blank(), blank(), money(t_out), blank()]));
    rows.push(styled("Net", "total", vec![blank(), blank(), money(t_in + t_out), blank()]));
    Ok(Report {
        kind: String::new(),
        title: if upcoming_only { "Upcoming bills and deposits" } else { "Scheduled bills" }.to_string(),
        subtitle: String::new(),
        columns: vec![col("Due", "date"), col("Payee", "text"), col("Account", "text"), col("Amount", "money"), col("Status", "text")],
        rows,
        chart: None,
    })
}

fn shares_cell(micro: i64) -> ReportCell {
    text(lots::fmt_shares(micro))
}
fn price_cell(micro: Option<i64>) -> ReportCell {
    match micro {
        // Prices print to two places, or as many as they have up to six
        // — the same rule as the register's `formatPrice`.
        Some(p) => {
            let dollars = p / 1_000_000;
            let frac = format!("{:06}", p.abs() % 1_000_000);
            let mut frac = frac.trim_end_matches('0').to_string();
            while frac.len() < 2 {
                frac.push('0');
            }
            text(format!("{dollars}.{frac}"))
        }
        None => blank(),
    }
}

/// Every holding as of the date, grouped by account. Value at the
/// latest price on or before the date; cost from the lots.
fn portfolio_value(conn: &Conn, scope: &Scope, asof: NaiveDate) -> Result<Report, String> {
    // The number of CELLS a row carries — eight columns less the label.
    // Headers and problem lines took `ncol - 1`, as though it counted the
    // label, and came out one short of every holding row.
    let ncol = 7;
    let mut rows = Vec::new();
    let mut chart = Vec::new();
    let mut total_value = 0i64;
    let mut total_cost = 0i64;
    let accounts: Vec<Option<String>> = match &scope.accounts {
        None => vec![None],
        Some(ids) => ids.iter().cloned().map(Some).collect(),
    };
    let mut positions = Vec::new();
    let mut problems = Vec::new();
    for a in accounts {
        let p = lots::portfolio(conn, a.as_deref(), &iso(asof))?;
        positions.extend(p.positions.into_iter().filter(|x| scope.wants_security(&x.security_id)));
        problems.extend(p.problems);
    }
    let grand: i64 = positions.iter().map(|p| p.value_cents).sum();
    let mut current: Option<String> = None;
    let (mut acct_value, mut acct_cost) = (0i64, 0i64);
    let flush = |rows: &mut Vec<ReportLine>, name: &Option<String>, v: i64, c: i64| {
        if let Some(n) = name {
            rows.push(styled(&format!("Total {n}"), "subtotal", vec![blank(), blank(), blank(), money(c), money(v), money(v - c), pct(v, grand)]));
        }
    };
    for p in &positions {
        if current.as_deref() != Some(p.account_name.as_str()) {
            flush(&mut rows, &current, acct_value, acct_cost);
            current = Some(p.account_name.clone());
            acct_value = 0;
            acct_cost = 0;
            rows.push(header(&p.account_name, ncol));
        }
        rows.push(keyed(&p.security_name, "security", &p.security_id, 1, vec![
            text(p.symbol.clone()),
            shares_cell(p.shares_micro),
            price_cell(p.price_micro),
            money(p.cost_cents),
            money(p.value_cents),
            money(p.gain_cents),
            pct(p.value_cents, grand),
        ]));
        acct_value += p.value_cents;
        acct_cost += p.cost_cents;
        total_value += p.value_cents;
        total_cost += p.cost_cents;
        let label = if positions.iter().filter(|q| q.security_id == p.security_id).count() > 1 {
            format!("{} ({})", p.security_name, p.account_name)
        } else {
            p.security_name.clone()
        };
        chart.push((label, p.value_cents));
    }
    flush(&mut rows, &current, acct_value, acct_cost);
    rows.push(styled("Total", "total", vec![blank(), blank(), blank(), money(total_cost), money(total_value), money(total_value - total_cost), pct(total_value, grand)]));
    for pr in problems {
        rows.push(styled(&pr, "normal", (0..ncol).map(|_| blank()).collect()));
    }
    Ok(Report {
        kind: String::new(),
        title: "Portfolio value".to_string(),
        subtitle: format!("As of {}", us(asof)),
        columns: vec![col("Holding", "text"), col("Symbol", "text"), col("Shares", "number"), col("Price", "number"), col("Cost basis", "money"), col("Market value", "money"), col("Gain/loss", "money"), col("% of portfolio", "percent")],
        rows,
        chart: Some(ReportChart { kind: "pie".to_string(), series: vec![ReportSeries { label: "Value".to_string(), points: chart }] }),
    })
}

/// One line per security across every account in scope: cost, value, the
/// unrealized gain, and what has been realized on it to date.
fn investment_performance(conn: &Conn, scope: &Scope, asof: NaiveDate) -> Result<Report, String> {
    let accounts: Vec<Option<String>> = match &scope.accounts {
        None => vec![None],
        Some(ids) => ids.iter().cloned().map(Some).collect(),
    };
    let mut by_sec: BTreeMap<String, (String, String, i64, i64, i64, i64)> = BTreeMap::new();
    for a in accounts {
        let p = lots::portfolio(conn, a.as_deref(), &iso(asof))?;
        for pos in p.positions.into_iter().filter(|x| scope.wants_security(&x.security_id)) {
            let e = by_sec.entry(pos.security_name.clone()).or_insert((pos.security_id.clone(), pos.symbol.clone(), 0, 0, 0, 0));
            e.2 += pos.shares_micro;
            e.3 += pos.cost_cents;
            e.4 += pos.value_cents;
        }
        for d in lots::realized(conn, a.as_deref(), "0000-01-01", &iso(asof))?.into_iter().filter(|d| scope.wants_security(&d.security_id)) {
            let name: String = conn
                .query_row("SELECT name FROM securities WHERE id = ?1", [&d.security_id], |r| r.get(0))
                .unwrap_or_else(|_| d.security_id.clone());
            let sym: String = conn
                .query_row("SELECT symbol FROM securities WHERE id = ?1", [&d.security_id], |r| r.get(0))
                .unwrap_or_default();
            let e = by_sec.entry(name).or_insert((d.security_id.clone(), sym, 0, 0, 0, 0));
            e.5 += d.gain_cents;
        }
    }
    let (mut tc, mut tv, mut tr) = (0i64, 0i64, 0i64);
    let mut rows = Vec::new();
    let mut chart = Vec::new();
    for (name, (id, sym, shares, cost, value, realized)) in &by_sec {
        let gain = value - cost;
        rows.push(keyed(name, "security", id, 0, vec![
            text(sym.clone()),
            shares_cell(*shares),
            money(*cost),
            money(*value),
            money(gain),
            pct(gain, *cost),
            money(*realized),
        ]));
        tc += cost;
        tv += value;
        tr += realized;
        chart.push((name.clone(), gain));
    }
    rows.push(styled("Total", "total", vec![blank(), blank(), money(tc), money(tv), money(tv - tc), pct(tv - tc, tc), money(tr)]));
    Ok(Report {
        kind: String::new(),
        title: "Performance by holding".to_string(),
        subtitle: format!("As of {}", us(asof)),
        columns: vec![col("Holding", "text"), col("Symbol", "text"), col("Shares", "number"), col("Cost basis", "money"), col("Market value", "money"), col("Unrealized gain", "money"), col("Return", "percent"), col("Realized to date", "money")],
        rows,
        chart: Some(ReportChart { kind: "bar".to_string(), series: vec![ReportSeries { label: "Unrealized gain".to_string(), points: chart }] }),
    })
}

/// Realized gains in the range, short-term then long-term, one line per lot
/// sold — the shape of Schedule D.
fn capital_gains(conn: &Conn, scope: &Scope, from: NaiveDate, to: NaiveDate) -> Result<Report, String> {
    let accounts: Vec<Option<String>> = match &scope.accounts {
        None => vec![None],
        Some(ids) => ids.iter().cloned().map(Some).collect(),
    };
    let mut disposals = Vec::new();
    for a in accounts {
        disposals.extend(lots::realized(conn, a.as_deref(), &iso(from), &iso(to))?.into_iter().filter(|d| scope.wants_security(&d.security_id) && scope.wants_account(&d.account_id)));
    }
    disposals.sort_by(|x, y| x.sold_on.cmp(&y.sold_on).then(x.acquired_on.cmp(&y.acquired_on)));
    let name_of = |id: &str| -> (String, String) {
        conn.query_row("SELECT name, symbol FROM securities WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap_or_else(|_| (id.to_string(), String::new()))
    };
    // Cells per row, as in `portfolio_value` (the header was once one short).
    let ncol = 7;
    let mut rows = Vec::new();
    let (mut ts, mut tl) = ((0i64, 0i64, 0i64), (0i64, 0i64, 0i64));
    for (long, title) in [(false, "Short-term (held one year or less)"), (true, "Long-term (held more than one year)")] {
        let part: Vec<&crate::models::Disposal> = disposals.iter().filter(|d| d.long_term == long).collect();
        if part.is_empty() {
            continue;
        }
        rows.push(header(title, ncol));
        let (mut p, mut c, mut g) = (0i64, 0i64, 0i64);
        for d in part {
            let (name, _sym) = name_of(&d.security_id);
            let acct: String = conn
                .query_row("SELECT name FROM accounts WHERE id = ?1", [&d.account_id], |r| r.get(0))
                .unwrap_or_default();
            rows.push(keyed(&name, "transaction", &d.sell_id, 1, vec![
                text(acct),
                shares_cell(d.shares_micro),
                text(us(parse_date(&d.acquired_on).unwrap_or(from))),
                text(us(parse_date(&d.sold_on).unwrap_or(to))),
                money(d.proceeds_cents),
                money(d.cost_cents),
                money(d.gain_cents),
            ]));
            p += d.proceeds_cents;
            c += d.cost_cents;
            g += d.gain_cents;
        }
        rows.push(styled(if long { "Total long-term" } else { "Total short-term" }, "subtotal", vec![blank(), blank(), blank(), blank(), money(p), money(c), money(g)]));
        if long { tl = (p, c, g) } else { ts = (p, c, g) }
    }
    if rows.is_empty() {
        rows.push(row("No sales in this period.", (0..ncol).map(|_| blank()).collect()));
    }
    rows.push(styled("Net gain/loss", "total", vec![blank(), blank(), blank(), blank(), money(ts.0 + tl.0), money(ts.1 + tl.1), money(ts.2 + tl.2)]));
    Ok(Report {
        kind: String::new(),
        title: "Capital gains".to_string(),
        subtitle: String::new(),
        columns: vec![col("Security", "text"), col("Account", "text"), col("Shares", "number"), col("Acquired", "date"), col("Sold", "date"), col("Proceeds", "money"), col("Cost basis", "money"), col("Gain/loss", "money")],
        rows,
        chart: Some(ReportChart { kind: "bar".to_string(), series: vec![ReportSeries { label: "Gain/loss".to_string(), points: vec![("Short-term".to_string(), ts.2), ("Long-term".to_string(), tl.2)] }] }),
    })
}

/// Every investment row in the range, by account: the register, on paper.
fn investment_transactions(conn: &Conn, scope: &Scope, from: NaiveDate, to: NaiveDate) -> Result<Report, String> {
    let mut binds = vec![iso(from), iso(to)];
    let acct = scope.account_sql("t", &mut binds);
    let sec = format!("{}{}", scope.security_sql("t.security_id", &mut binds), scope.line_sql(&T, &mut binds));
    let sql = format!(
        "SELECT a.name, t.id, t.date, t.activity, s.name, t.shares_micro, t.price_micro,
                t.commission_cents, t.amount_cents, t.gross_cents, t.cleared_state
           FROM transactions t
           JOIN accounts a ON a.id = t.account_id
           JOIN securities s ON s.id = t.security_id
          WHERE t.is_void = 0 AND t.activity IS NOT NULL
            AND t.date >= ?1 AND t.date <= ?2{acct}{sec}
          ORDER BY a.name COLLATE NOCASE, t.date, t.rowid"
    );
    struct R { acct: String, id: String, date: String, activity: String, sec: String, shares: Option<i64>, price: Option<i64>, comm: i64, amount: i64, gross: i64, cleared: String }
    let data = query_rows(conn, &sql, &binds, |r| Ok(R {
        acct: r.get(0)?, id: r.get(1)?, date: r.get(2)?, activity: r.get(3)?, sec: r.get(4)?,
        shares: r.get(5)?, price: r.get(6)?, comm: r.get(7)?, amount: r.get(8)?, gross: r.get::<_, Option<i64>>(9)?.unwrap_or(0), cleared: r.get(10)?,
    }))?;
    // Columns, label included — unlike `portfolio_value`'s count of cells.
    let ncol = 8;
    let mut rows = Vec::new();
    let mut current: Option<String> = None;
    let mut sub = 0i64;
    let mut total = 0i64;
    // The subtotal is CASH, like "Net cash effect" below it, and is
    // named for it. A reinvestment shows its gross in the Total column (the
    // income it was) but moves no cash, so a subtotal labeled "Total Brokerage"
    // did not add up to the column above it. Summing the displayed values
    // instead would make the subtotals disagree with the grand total.
    let subtotal = |c: &str, sub: i64| {
        styled(&format!("Cash effect {c}"), "subtotal", vec![blank(), blank(), blank(), blank(), blank(), blank(), money(sub)])
    };
    for r in &data {
        if current.as_deref() != Some(r.acct.as_str()) {
            if let Some(c) = &current {
                rows.push(subtotal(c, sub));
            }
            current = Some(r.acct.clone());
            sub = 0;
            rows.push(header(&r.acct, ncol - 1));
        }
        let d = parse_date(&r.date).map(us).unwrap_or_else(|_| r.date.clone());
        let shares = if r.activity == "split" { text(format!("{} for 1", lots::fmt_shares(r.shares.unwrap_or(0)))) } else { r.shares.map(shares_cell).unwrap_or_else(blank) };
        rows.push(keyed(&d, "transaction", &r.id, 1, vec![
            text(lots::activity_label(&r.activity)),
            text(r.sec.clone()),
            shares,
            price_cell(r.price),
            if r.comm != 0 { money(r.comm) } else { blank() },
            text(r.cleared.clone()),
            money(if r.activity.starts_with("reinvest_") { r.gross } else { r.amount }),
        ]));
        sub += r.amount;
        total += r.amount;
    }
    if let Some(c) = &current {
        rows.push(subtotal(c, sub));
    }
    if data.is_empty() {
        rows.push(row("No investment transactions in this period.", (0..ncol - 1).map(|_| blank()).collect()));
    }
    rows.push(styled("Net cash effect", "total", vec![blank(), blank(), blank(), blank(), blank(), blank(), money(total)]));
    Ok(Report {
        kind: String::new(),
        title: "Investment transactions".to_string(),
        subtitle: String::new(),
        columns: vec![col("Date", "date"), col("Activity", "text"), col("Security", "text"), col("Shares", "number"), col("Price", "number"), col("Commission", "money"), col("C", "text"), col("Total", "money")],
        rows,
        chart: None,
    })
}

/// Dividends, interest and distributions by security — reinvested ones
/// included, because they are income whether or not they became shares.
fn investment_income(conn: &Conn, scope: &Scope, from: NaiveDate, to: NaiveDate) -> Result<Report, String> {
    let mut binds = vec![iso(from), iso(to)];
    let acct = scope.account_sql("t", &mut binds);
    let sec = format!("{}{}", scope.security_sql("t.security_id", &mut binds), scope.line_sql(&T, &mut binds));
    let sql = format!(
        "SELECT s.id, s.name,
                SUM(CASE WHEN t.activity IN ('dividend','reinvest_dividend') THEN t.gross_cents ELSE 0 END),
                SUM(CASE WHEN t.activity IN ('interest','reinvest_interest') THEN t.gross_cents ELSE 0 END),
                SUM(CASE WHEN t.activity IN ('ltcg_dist','stcg_dist','reinvest_ltcg','reinvest_stcg') THEN t.gross_cents ELSE 0 END),
                SUM(CASE WHEN t.activity LIKE 'reinvest_%' THEN t.gross_cents ELSE 0 END)
           FROM transactions t
           JOIN securities s ON s.id = t.security_id
          WHERE t.is_void = 0 AND t.activity IN ('dividend','interest','ltcg_dist','stcg_dist',
                    'reinvest_dividend','reinvest_interest','reinvest_ltcg','reinvest_stcg')
            AND t.date >= ?1 AND t.date <= ?2{acct}{sec}
          GROUP BY s.id, s.name
          ORDER BY s.name COLLATE NOCASE"
    );
    let data = query_rows(conn, &sql, &binds, |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?, r.get::<_, i64>(4)?, r.get::<_, i64>(5)?)))?;
    let mut rows = Vec::new();
    let mut chart = Vec::new();
    let mut t = [0i64; 4];
    for (id, name, div, int, cg, re) in &data {
        let all = div + int + cg;
        rows.push(keyed(name, "security", id, 0, vec![money(*div), money(*int), money(*cg), money(all), money(*re)]));
        t[0] += div; t[1] += int; t[2] += cg; t[3] += re;
        chart.push((name.clone(), all));
    }
    if data.is_empty() {
        rows.push(row("No investment income in this period.", (0..5).map(|_| blank()).collect()));
    }
    rows.push(styled("Total", "total", vec![money(t[0]), money(t[1]), money(t[2]), money(t[0] + t[1] + t[2]), money(t[3])]));
    Ok(Report {
        kind: String::new(),
        title: "Investment income".to_string(),
        subtitle: String::new(),
        columns: vec![col("Security", "text"), col("Dividends", "money"), col("Interest", "money"), col("Cap. gain dist.", "money"), col("Total", "money"), col("of which reinvested", "money")],
        rows,
        chart: Some(ReportChart { kind: "bar".to_string(), series: vec![ReportSeries { label: "Income".to_string(), points: chart }] }),
    })
}

/// Each holding's price movement over the range, beside a chosen
/// security's, and the difference.
///
/// **This is a PRICE return, and says so.** It compares the price on the
/// range's last day with the price on its first, for the shares held at the
/// start — money paid in or taken out during the range does not move it, and
/// dividends are not in it. That is what makes it comparable with an index:
/// a money-weighted return measures the timing of contributions as much as
/// the investment, which is exactly what a benchmark comparison must not do.
/// `investment_performance` is still the report for what the money did.
///
/// A benchmark with no price on or before either end cannot be compared, and
/// the report says so rather than printing a zero.
fn benchmark_comparison(conn: &Conn, scope: &Scope, req: &ReportRequest, from: NaiveDate, to: NaiveDate) -> Result<Report, String> {
    let columns = |a: &str, b: &str| {
        vec![col("Holding", "text"), col("Symbol", "text"), col(a, "text"), col(b, "text"), col("Return", "percent"), col("vs benchmark", "percent")]
    };
    // Nothing may fail by showing nothing. With no benchmark chosen
    // yet the report opens and says where to choose one, rather than
    // refusing to draw; Customize is one click away on the rail.
    let Some(bench_id) = req.benchmark_security_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(Report {
            kind: String::new(),
            title: "Performance against a benchmark".to_string(),
            subtitle: range_label(from, to),
            columns: columns(&format!("Price {}", us(from)), &format!("Price {}", us(to))),
            rows: vec![row(
                "Choose a benchmark under Customize — the security everything here is measured against.",
                vec![blank(), blank(), blank(), blank(), blank()],
            )],
            chart: None,
        });
    };
    let (bench_name, bench_symbol): (String, String) = conn
        .query_row("SELECT name, symbol FROM securities WHERE id = ?1", params![bench_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or("that benchmark security no longer exists")?;
    let bench_label = if bench_symbol.is_empty() { bench_name.clone() } else { format!("{bench_name} ({bench_symbol})") };
    let start_price = |id: &str| -> Result<Option<i64>, String> {
        // The price on or before the day BEFORE the range starts is last
        // year's price; the range's own first day is what a period return
        // opens at, so the opening price is the one as of `from`.
        Ok(lots::price_asof(conn, id, &iso(from))?.map(|(p, _, _)| p))
    };
    let end_price = |id: &str| -> Result<Option<i64>, String> { Ok(lots::price_asof(conn, id, &iso(to))?.map(|(p, _, _)| p)) };
    let (b0, b1) = (start_price(bench_id)?, end_price(bench_id)?);
    let (Some(b0), Some(b1)) = (b0, b1) else {
        return Err(format!("{bench_label} has no price stored on or before {} — update prices, or import a price history, before comparing against it.", us(from)));
    };
    if b0 == 0 {
        return Err(format!("{bench_label}'s price on {} is zero", us(from)));
    }
    let bench_bps = bps(b1 - b0, b0);

    // The shares held at the START of the range: a benchmark comparison asks
    // what the money already invested did, not what was added later.
    let accounts: Vec<Option<String>> = match &scope.accounts {
        None => vec![None],
        Some(ids) => ids.iter().cloned().map(Some).collect(),
    };
    let mut held: BTreeMap<String, (String, String, i64)> = BTreeMap::new();
    for a in &accounts {
        for pos in lots::portfolio(conn, a.as_deref(), &iso(from))?.positions.into_iter().filter(|x| scope.wants_security(&x.security_id)) {
            let e = held.entry(pos.security_id.clone()).or_insert((pos.security_name.clone(), pos.symbol.clone(), 0));
            e.2 += pos.shares_micro;
        }
    }

    let mut rows = Vec::new();
    let mut chart_me = Vec::new();
    let mut chart_bench = Vec::new();
    let (mut open_total, mut close_total) = (0i64, 0i64);
    let mut unpriced = 0usize;
    let mut items: Vec<(String, String, String, i64, i64, i64)> = Vec::new();
    for (id, (name, symbol, shares)) in held {
        if shares <= 0 {
            continue;
        }
        let (Some(p0), Some(p1)) = (start_price(&id)?, end_price(&id)?) else {
            unpriced += 1;
            continue;
        };
        let open = lots::value_cents(shares, p0);
        let close = lots::value_cents(shares, p1);
        open_total += open;
        close_total += close;
        items.push((id, name, symbol, p0, p1, open));
        let _ = close;
    }
    items.sort_by(|a, b| b.5.cmp(&a.5).then(a.1.to_lowercase().cmp(&b.1.to_lowercase())));
    for (id, name, symbol, p0, p1, _open) in &items {
        let ret = bps(p1 - p0, *p0);
        rows.push(keyed(name, "security", id, 0, vec![
            text(symbol.clone()),
            price_cell(Some(*p0)),
            price_cell(Some(*p1)),
            pct_bps(ret),
            pct_bps(ret - bench_bps),
        ]));
        chart_me.push((name.clone(), ret));
        chart_bench.push((name.clone(), bench_bps));
    }
    if items.is_empty() {
        rows.push(row(
            if unpriced > 0 { "Nothing held here has a price at both ends of this range." } else { "Nothing was held at the start of this range." },
            vec![blank(), blank(), blank(), blank(), blank()],
        ));
    }
    let port_bps = if open_total > 0 { bps(close_total - open_total, open_total) } else { 0 };
    rows.push(styled("These holdings, together", "subtotal", vec![
        blank(),
        text(crate::models::format_cents(open_total)),
        text(crate::models::format_cents(close_total)),
        pct_bps(port_bps),
        pct_bps(port_bps - bench_bps),
    ]));
    rows.push(styled(&format!("Benchmark: {bench_label}"), "total", vec![
        text(bench_symbol.clone()),
        price_cell(Some(b0)),
        price_cell(Some(b1)),
        pct_bps(bench_bps),
        blank(),
    ]));
    if unpriced > 0 {
        rows.push(row(&format!("{unpriced} holding(s) left out — no price at both ends of the range."), vec![blank(), blank(), blank(), blank(), blank()]));
    }
    Ok(Report {
        kind: String::new(),
        title: "Performance against a benchmark".to_string(),
        subtitle: format!("{} — price movement only, on what was held on {}", range_label(from, to), us(from)),
        columns: vec![
            col("Holding", "text"),
            col("Symbol", "text"),
            col(&format!("Price {}", us(from)), "text"),
            col(&format!("Price {}", us(to)), "text"),
            col("Return", "percent"),
            col(&format!("vs {}", if bench_symbol.is_empty() { bench_name.clone() } else { bench_symbol.clone() }), "percent"),
        ],
        rows,
        chart: Some(ReportChart {
            kind: "bar".to_string(),
            series: vec![
                ReportSeries { label: "Return".to_string(), points: chart_me },
                ReportSeries { label: bench_label, points: chart_bench },
            ],
        }),
    })
}

/// Basis points straight through, for a percentage that is already computed.
fn pct_bps(b: i64) -> ReportCell {
    ReportCell { text: None, cents: Some(b) }
}

/// Transactions by category, in Money's tree (see `category_txn_tree`).
fn transactions_by_category_tree(conn: &Conn, scope: &Scope, from: NaiveDate, to: NaiveDate) -> Result<Report, String> {
    let mut binds = vec![iso(from), iso(to)];
    let scoped = scope.lines_where(&mut binds);
    let sql = format!(
        "{LINES}
        SELECT COALESCE(c.kind, CASE WHEN l.amount_cents > 0 THEN 'income' ELSE 'expense' END),
               COALESCE(p.id, c.id, ''), COALESCE(p.name, c.name, 'Uncategorized'),
               CASE WHEN p.id IS NULL THEN NULL ELSE c.id END,
               CASE WHEN p.id IS NULL THEN NULL ELSE c.name END,
               l.txn_id, l.date, l.check_number, l.payee, a.name, l.memo, l.amount_cents,
               (SELECT t.cleared_state FROM transactions t WHERE t.id = l.txn_id)
          FROM lines l
          JOIN accounts a ON a.id = l.account_id
          LEFT JOIN categories c ON c.id = l.category_id
          LEFT JOIN categories p ON p.id = c.parent_id
         WHERE l.date >= ?1 AND l.date <= ?2{scoped}
         ORDER BY 1 DESC, 3 COLLATE NOCASE, 5 IS NOT NULL, 5 COLLATE NOCASE, l.date, l.txn_id"
    );
    let data = query_rows(conn, &sql, &binds, |r| {
        let cents: i64 = r.get(11)?;
        Ok(CatTxn {
            kind: r.get(0)?,
            parent_id: r.get(1)?,
            parent_name: r.get(2)?,
            child_id: r.get(3)?,
            child_name: r.get(4)?,
            txn_id: r.get(5)?,
            date: r.get(6)?,
            cells: vec![
                text(r.get::<_, Option<String>>(7)?.unwrap_or_default()),
                text(r.get::<_, String>(8)?),
                text(r.get::<_, String>(9)?),
                text(r.get::<_, Option<String>>(10)?.unwrap_or_default()),
                money(cents),
                text(r.get::<_, String>(12)?),
            ],
            cents,
            amount_at: 4,
        })
    })?;
    let rows = category_txn_tree(data, 6, from);
    Ok(Report {
        kind: String::new(),
        title: "Transactions by category".to_string(),
        subtitle: String::new(),
        columns: vec![col("Date", "date"), col("Num", "text"), col("Payee", "text"), col("Account", "text"), col("Memo", "text"), col("Amount", "money"), col("C", "text")],
        rows,
        chart: None,
    })
}

/// Tax-related transactions: the same tree, only categories that carry a
/// tax line (their own or their parent's), with the line shown on the
/// parent row.
fn tax_related_transactions(conn: &Conn, scope: &Scope, from: NaiveDate, to: NaiveDate) -> Result<Report, String> {
    let mut binds = vec![iso(from), iso(to)];
    let scoped = scope.lines_where(&mut binds);
    let sql = format!(
        "{LINES}
        SELECT c.kind,
               COALESCE(p.id, c.id), COALESCE(p.name, c.name) || '   [' || {TAX_LINE} || ']',
               CASE WHEN p.id IS NULL THEN NULL ELSE c.id END,
               CASE WHEN p.id IS NULL THEN NULL ELSE c.name END,
               l.txn_id, l.date, l.check_number, l.payee, a.name, l.memo, l.amount_cents
          FROM lines l
          JOIN categories c ON c.id = l.category_id
          LEFT JOIN categories p ON p.id = c.parent_id
          JOIN accounts a ON a.id = l.account_id
         WHERE {TAX_LINE} IS NOT NULL
           AND l.date >= ?1 AND l.date <= ?2{scoped}
         ORDER BY 1 DESC, 3 COLLATE NOCASE, 5 IS NOT NULL, 5 COLLATE NOCASE, l.date, l.txn_id"
    );
    let data = query_rows(conn, &sql, &binds, |r| {
        let cents: i64 = r.get(11)?;
        Ok(CatTxn {
            kind: r.get(0)?,
            parent_id: r.get(1)?,
            parent_name: r.get(2)?,
            child_id: r.get(3)?,
            child_name: r.get(4)?,
            txn_id: r.get(5)?,
            date: r.get(6)?,
            cells: vec![
                text(r.get::<_, Option<String>>(7)?.unwrap_or_default()),
                text(r.get::<_, String>(8)?),
                text(r.get::<_, String>(9)?),
                text(r.get::<_, Option<String>>(10)?.unwrap_or_default()),
                money(cents),
            ],
            cents,
            amount_at: 4,
        })
    })?;
    let rows = category_txn_tree(data, 5, from);
    Ok(Report {
        kind: String::new(),
        title: "Tax-related transactions".to_string(),
        subtitle: String::new(),
        columns: vec![col("Date", "date"), col("Num", "text"), col("Payee", "text"), col("Account", "text"), col("Memo", "text"), col("Amount", "money")],
        rows,
        chart: None,
    })
}

fn tax_summary(conn: &Conn, scope: &Scope, from: NaiveDate, to: NaiveDate) -> Result<Report, String> {
    let mut binds = vec![iso(from), iso(to)];
    let scoped = scope.lines_where(&mut binds);
    let sql = format!(
        "{LINES}
        SELECT {TAX_LINE} AS line, c.id,
               CASE WHEN p.name IS NULL THEN c.name ELSE p.name || ' : ' || c.name END,
               SUM(l.amount_cents), COUNT(*)
          FROM lines l
          JOIN categories c ON c.id = l.category_id
          LEFT JOIN categories p ON p.id = c.parent_id
         WHERE l.date >= ?1 AND l.date <= ?2{scoped}
         GROUP BY line, c.id
         ORDER BY line IS NULL, line, 3 COLLATE NOCASE"
    );
    let data = query_rows(conn, &sql, &binds, |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?, r.get::<_, i64>(4)?)))?;
    let mut rows = Vec::new();
    let mut cur: Option<Option<String>> = None;
    let mut sub = 0i64;
    for (line, id, name, cents, n) in &data {
        if cur.as_ref() != Some(line) {
            if let Some(l) = &cur {
                rows.push(styled(&format!("Total {}", l.as_deref().unwrap_or("(no tax line)")), "subtotal", vec![money(sub), blank()]));
            }
            rows.push(header(line.as_deref().unwrap_or("Categories with spending and NO tax line"), 2));
            cur = Some(line.clone());
            sub = 0;
        }
        rows.push(keyed(name, "category", id, 1, vec![money(*cents), text(n.to_string())]));
        sub += cents;
    }
    if let Some(l) = &cur {
        rows.push(styled(&format!("Total {}", l.as_deref().unwrap_or("(no tax line)")), "subtotal", vec![money(sub), blank()]));
    }
    Ok(Report {
        kind: String::new(),
        title: "Tax summary by line".to_string(),
        subtitle: String::new(),
        columns: vec![col("Category", "text"), col("Amount", "money"), col("Lines", "count")],
        rows,
        chart: None,
    })
}

/// The tax line a line of the LINES CTE lands on: the transaction's own
/// override when it has one ('' means none), else the category's, else
/// its parent's.
const TAX_LINE: &str = "CASE WHEN l.tax_override IS NULL THEN COALESCE(c.tax_line, p.tax_line)
                             WHEN l.tax_override = '' THEN NULL
                             ELSE l.tax_override END";

// ---------------------------------------------------------------------------
// Comparisons: this range against another
// ---------------------------------------------------------------------------

fn compare_range(req: &ReportRequest, from: NaiveDate, to: NaiveDate) -> Result<(NaiveDate, NaiveDate), String> {
    match (&req.compare_from, &req.compare_to) {
        (Some(f), Some(t)) => Ok((parse_date(f)?, parse_date(t)?)),
        _ => {
            // Default: the same length of time immediately before.
            let days = (to - from).num_days() + 1;
            let t = from.pred_opt().unwrap_or(from);
            let f = t - chrono::Duration::days(days - 1);
            Ok((f, t))
        }
    }
}

fn comparison(conn: &Conn, scope: &Scope, req: &ReportRequest, from: NaiveDate, to: NaiveDate, by: GroupBy) -> Result<Report, String> {
    let (cf, ct) = compare_range(req, from, to)?;
    // Money puts the EARLIER period first and Difference = later − earlier
    // (as its Spending by Category comparison report does).
    let (earlier, later) = if cf <= from { ((cf, ct), (from, to)) } else { ((from, to), (cf, ct)) };
    let col_a = format!("{} - {}", us(earlier.0), us(earlier.1));
    let col_b = format!("{} - {}", us(later.0), us(later.1));
    if by == GroupBy::Category {
        let a = category_nodes(conn, scope, earlier.0, earlier.1, &[])?;
        let b = category_nodes(conn, scope, later.0, later.1, &[])?;
        // Merge into nodes with two values.
        let mut merged: BTreeMap<String, CatNode> = BTreeMap::new();
        for (i, set) in [a, b].into_iter().enumerate() {
            for n in set {
                let key = if n.id.is_empty() { format!("uncategorized:{}", n.kind) } else { n.id.clone() };
                let e = merged.entry(key).or_insert_with(|| CatNode { values: vec![0, 0], count: 0, ..n.clone() });
                e.values[i] += n.values[0];
                e.count += n.count;
            }
        }
        let nodes: Vec<CatNode> = merged.into_values().collect();
        let cells = |v: &[i64], _c: Option<i64>, _k: &str| -> Vec<ReportCell> { vec![money(v[0]), money(v[1]), money(v[1] - v[0])] };
        let (mut rows, _chart, income, expenses) = tree_rows(&nodes, 2, &cells);
        if scope.expense_only {
            rows.push(styled("Total spending", "total", vec![money(expenses[0]), money(expenses[1]), money(expenses[1] - expenses[0])]));
        } else {
            rows.push(styled("Income less Expenses", "total", vec![money(income[0] - expenses[0]), money(income[1] - expenses[1]), money((income[1] - expenses[1]) - (income[0] - expenses[0]))]));
        }
        return Ok(Report {
            kind: String::new(),
            title: "Spending by category comparison".to_string(),
            subtitle: format!("{} vs {}", range_label(earlier.0, earlier.1), range_label(later.0, later.1)),
            columns: vec![col("Subcategory", "text"), col(&col_a, "money"), col(&col_b, "money"), col("Difference", "money")],
            rows,
            chart: None,
        });
    }
    let totals = |f: NaiveDate, t: NaiveDate| -> Result<BTreeMap<(String, String), i64>, String> {
        let mut binds = vec![iso(f), iso(t)];
        let scoped = scope.lines_where(&mut binds);
        let sql = format!(
            "{LINES}
            SELECT COALESCE(l.payee_id, ''), COALESCE(NULLIF(l.payee, ''), '(no payee)'), SUM(-l.amount_cents)
              FROM lines l
             WHERE l.date >= ?1 AND l.date <= ?2 AND l.amount_cents < 0{scoped}
             GROUP BY 1, 2"
        );
        Ok(query_rows(conn, &sql, &binds, |r| Ok(((r.get::<_, String>(0)?, r.get::<_, String>(1)?), r.get::<_, i64>(2)?)))?.into_iter().collect())
    };
    let a = totals(earlier.0, earlier.1)?;
    let b = totals(later.0, later.1)?;
    let mut keys: Vec<(String, String)> = a.keys().chain(b.keys()).cloned().collect();
    keys.sort_by(|x, y| x.1.to_lowercase().cmp(&y.1.to_lowercase()));
    keys.dedup();
    let mut rows = Vec::new();
    let (mut ta, mut tb) = (0i64, 0i64);
    for (id, label) in keys {
        let va = *a.get(&(id.clone(), label.clone())).unwrap_or(&0);
        let vb = *b.get(&(id.clone(), label.clone())).unwrap_or(&0);
        rows.push(keyed(&label, "payee", &id, 0, vec![money(va), money(vb), money(vb - va)]));
        ta += va;
        tb += vb;
    }
    rows.push(styled("Total", "total", vec![money(ta), money(tb), money(tb - ta)]));
    Ok(Report {
        kind: String::new(),
        title: "Spending by payee comparison".to_string(),
        subtitle: format!("{} vs {}", range_label(earlier.0, earlier.1), range_label(later.0, later.1)),
        columns: vec![col("Payee", "text"), col(&col_a, "money"), col(&col_b, "money"), col("Difference", "money")],
        rows,
        chart: None,
    })
}

fn income_spending_comparison(conn: &Conn, scope: &Scope, req: &ReportRequest, from: NaiveDate, to: NaiveDate) -> Result<Report, String> {
    let (cf, ct) = compare_range(req, from, to)?;
    let (earlier, later) = if cf <= from { ((cf, ct), (from, to)) } else { ((from, to), (cf, ct)) };
    let tot = |f: NaiveDate, t: NaiveDate| -> Result<(i64, i64), String> {
        let nodes = category_nodes(conn, scope, f, t, &[])?;
        let i: i64 = nodes.iter().filter(|n| n.kind == "income").map(|n| n.values[0]).sum();
        let e: i64 = nodes.iter().filter(|n| n.kind == "expense").map(|n| n.values[0]).sum();
        Ok((i, e))
    };
    let (ia, ea) = tot(earlier.0, earlier.1)?;
    let (ib, eb) = tot(later.0, later.1)?;
    let la = format!("{} - {}", us(earlier.0), us(earlier.1));
    let lb = format!("{} - {}", us(later.0), us(later.1));
    let rows = vec![
        row("Income", vec![money(ia), money(ib), money(ib - ia), pct(ib - ia, ia)]),
        row("Expenses", vec![money(ea), money(eb), money(eb - ea), pct(eb - ea, ea)]),
        styled("Income less Expenses", "total", vec![money(ia - ea), money(ib - eb), money((ib - eb) - (ia - ea)), pct((ib - eb) - (ia - ea), ia - ea)]),
    ];
    Ok(Report {
        kind: String::new(),
        title: "Income and spending comparison".to_string(),
        subtitle: format!("{} vs {}", range_label(earlier.0, earlier.1), range_label(later.0, later.1)),
        columns: vec![col("", "text"), col(&la, "money"), col(&lb, "money"), col("Difference", "money"), col("Change", "percent")],
        rows,
        chart: Some(ReportChart {
            kind: "bar".to_string(),
            series: vec![
                ReportSeries { label: la, points: vec![("Income".into(), ia), ("Expenses".into(), ea)] },
                ReportSeries { label: lb, points: vec![("Income".into(), ib), ("Expenses".into(), eb)] },
            ],
        }),
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Classifications — the same lines, grouped on the other axis
// ---------------------------------------------------------------------------

/// One classification value's numbers over the range. `values` has one entry
/// per bucket, display-signed the way the category tree's are (expenses
/// positive), so totals just add.
struct ClassNode {
    id: String,
    label: String,
    values: Vec<i64>,
    count: i64,
}

/// Net cents per classification value per bucket, using the EFFECTIVE value
/// of each line: a split line's own pick, else its transaction's. Lines with
/// no value on the axis come back as a node with an empty id.
///
/// `buckets` is the `YYYY-MM` list to spread across, or empty for one total.
fn class_nodes(conn: &Conn, scope: &Scope, from: NaiveDate, to: NaiveDate, buckets: &[String]) -> Result<Vec<ClassNode>, String> {
    let axis = scope.axis.as_ref().ok_or("this report needs a classification")?;
    let mut binds = vec![iso(from), iso(to)];
    // The grouping expression binds the axis id, and it must be bound BEFORE
    // the scope's own placeholders because it appears first in the SELECT.
    let value_expr = scope.class_expr(&L, &axis.id, &mut binds);
    let scoped = scope.lines_where(&mut binds);
    let by_month = buckets.len() > 1;
    let sql = format!(
        "{LINES}
        SELECT {value_expr} AS value_id,
               substr(l.date, 1, 7),
               SUM(l.amount_cents),
               COUNT(*)
          FROM lines l
         WHERE l.date >= ?1 AND l.date <= ?2{scoped}
         GROUP BY value_id, substr(l.date, 1, 7)"
    );
    let raw = query_rows(conn, &sql, &binds, |r| {
        Ok((
            r.get::<_, Option<String>>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, i64>(3)?,
        ))
    })?;
    let labels = value_labels(conn, &axis.id)?;
    let ncols = buckets.len().max(1);
    let mut nodes: BTreeMap<String, ClassNode> = BTreeMap::new();
    for (value_id, ym, cents, count) in raw {
        // The unclassified bucket's key is `none:<axis>`, not "": a row that
        // drills through has to say WHICH axis it is the absence of, and the
        // viewer must not have to guess the axis the engine chose (found in
        // review — an empty key made the drill drop the filter entirely and
        // list every transaction under an "unclassified" heading).
        let key = value_id.clone().unwrap_or_else(|| format!("none:{}", axis.id));
        let label = match &value_id {
            Some(v) => labels.get(v).cloned().unwrap_or_else(|| "(unknown)".to_string()),
            None => format!("(no {})", axis.name.to_lowercase()),
        };
        let node = nodes.entry(key.clone()).or_insert_with(|| ClassNode { id: key, label, values: vec![0; ncols], count: 0 });
        let col = if by_month { buckets.iter().position(|b| *b == ym).unwrap_or(0) } else { 0 };
        // Spending positive, as Money prints it; income stays negative here
        // and the caller decides what to show.
        node.values[col] += -cents;
        node.count += count;
    }
    let mut out: Vec<ClassNode> = nodes.into_values().collect();
    // Largest first, unclassified last — the order somebody reading it wants.
    out.sort_by(|a, b| match (a.id.starts_with("none:"), b.id.starts_with("none:")) {
        (true, false) => std::cmp::Ordering::Greater,
        (false, true) => std::cmp::Ordering::Less,
        _ => b.values.iter().sum::<i64>().cmp(&a.values.iter().sum::<i64>()).then(a.label.to_lowercase().cmp(&b.label.to_lowercase())),
    });
    Ok(out)
}

/// Every value of one axis, id → "Parent : Child".
fn value_labels(conn: &Conn, classification_id: &str) -> Result<BTreeMap<String, String>, String> {
    Ok(query_rows(
        conn,
        "SELECT v.id, CASE WHEN p.name IS NULL THEN v.name ELSE p.name || ' : ' || v.name END
           FROM classification_values v
           LEFT JOIN classification_values p ON p.id = v.parent_id
          WHERE v.classification_id = ?",
        &[classification_id.to_string()],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
    )?
    .into_iter()
    .collect())
}

fn axis_name(scope: &Scope) -> String {
    scope.axis.as_ref().map(|a| a.name.clone()).unwrap_or_else(|| "Classification".to_string())
}

/// Money spent per classification value — the report the axis exists for:
/// "what did the Maple Street house cost me last year".
fn spending_by_classification(conn: &Conn, scope: &Scope, from: NaiveDate, to: NaiveDate) -> Result<Report, String> {
    let nodes = class_nodes(conn, scope, from, to, &[])?;
    let whole: i64 = nodes.iter().map(|n| n.values[0]).sum();
    let mut rows = Vec::new();
    let mut chart = Vec::new();
    for n in &nodes {
        rows.push(keyed(&n.label, "class_value", &n.id, 0, vec![money(n.values[0]), pct(n.values[0], whole), text(n.count.to_string())]));
        if n.values[0] > 0 {
            chart.push((n.label.clone(), n.values[0]));
        }
    }
    if nodes.is_empty() {
        rows.push(row("Nothing in this range.", vec![blank(), blank(), blank()]));
    }
    rows.push(styled("Total", "total", vec![money(whole), blank(), blank()]));
    Ok(Report {
        kind: String::new(),
        title: format!("Spending by {}", axis_name(scope).to_lowercase()),
        subtitle: String::new(),
        columns: vec![col(&axis_name(scope), "text"), col("Total", "money"), col("% of total", "percent"), col("Count", "count")],
        rows,
        chart: Some(ReportChart { kind: "pie".to_string(), series: vec![ReportSeries { label: "Spending".to_string(), points: chart }] }),
    })
}

/// Every line under its classification value — the drill-through of the one
/// above, and the report that proves a figure.
fn transactions_by_classification(conn: &Conn, scope: &Scope, from: NaiveDate, to: NaiveDate) -> Result<Report, String> {
    let axis = scope.axis.clone().ok_or("this report needs a classification")?;
    let mut binds = vec![iso(from), iso(to)];
    let value_expr = scope.class_expr(&L, &axis.id, &mut binds);
    // Bound, not interpolated, and numbered for the same reason `class_expr`
    // is: it sits in the SELECT, ahead of the WHERE's ?1/?2.
    binds.push(format!("none:{}", axis.id));
    let none_key = format!("?{}", binds.len());
    let scoped = scope.lines_where(&mut binds);
    let sql = format!(
        "{LINES}
        SELECT COALESCE({value_expr}, {none_key}) AS value_id,
               l.txn_id, l.date, l.check_number, l.payee, a.name,
               COALESCE(CASE WHEN p.name IS NULL THEN c.name ELSE p.name || ' : ' || c.name END, ''),
               l.memo, l.amount_cents
          FROM lines l
          JOIN accounts a ON a.id = l.account_id
          LEFT JOIN categories c ON c.id = l.category_id
          LEFT JOIN categories p ON p.id = c.parent_id
         WHERE l.date >= ?1 AND l.date <= ?2{scoped}
         ORDER BY value_id, l.date, l.txn_id"
    );
    let data = query_rows(conn, &sql, &binds, |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, String>(6)?,
            r.get::<_, Option<String>>(7)?,
            r.get::<_, i64>(8)?,
        ))
    })?;
    let labels = value_labels(conn, &axis.id)?;
    let none_id = format!("none:{}", axis.id);
    let none_label = format!("(no {})", axis.name.to_lowercase());
    let mut rows = Vec::new();
    let mut current: Option<String> = None;
    let (mut sub, mut grand, mut count) = (0i64, 0i64, 0usize);
    let flush = |rows: &mut Vec<ReportLine>, current: &Option<String>, sub: i64| {
        if let Some(v) = current {
            let name = if *v == none_id { none_label.clone() } else { labels.get(v).cloned().unwrap_or_else(|| "(unknown)".into()) };
            rows.push(styled(&format!("Total {name}"), "subtotal", vec![blank(), blank(), blank(), blank(), money(sub)]));
        }
    };
    for (value_id, txn_id, date, num, payee, account, category, memo, cents) in data {
        if current.as_ref() != Some(&value_id) {
            flush(&mut rows, &current, sub);
            sub = 0;
            let name = if value_id == none_id { none_label.clone() } else { labels.get(&value_id).cloned().unwrap_or_else(|| "(unknown)".into()) };
            let mut h = header(&name, 5);
            h.key = Some(value_id.clone());
            h.key_kind = Some("class_value".to_string());
            rows.push(h);
            current = Some(value_id);
        }
        rows.push(keyed(&us(parse_date(&date).unwrap_or(from)), "transaction", &txn_id, 1, vec![
            text(num.unwrap_or_default()),
            text(payee),
            text(account),
            text(if category.is_empty() { memo.unwrap_or_default() } else { category }),
            money(cents),
        ]));
        sub += cents;
        grand += cents;
        count += 1;
    }
    flush(&mut rows, &current, sub);
    rows.push(styled(&format!("Grand total ({count} transactions)"), "total", vec![blank(), blank(), blank(), blank(), money(grand)]));
    Ok(Report {
        kind: String::new(),
        title: format!("Transactions by {}", axis.name.to_lowercase()),
        subtitle: String::new(),
        columns: vec![col("Date", "date"), col("Num", "text"), col("Payee", "text"), col("Account", "text"), col("Category", "text"), col("Amount", "money")],
        rows,
        chart: None,
    })
}

/// Classification × month: what each one costs, month by month.
fn classification_by_month(conn: &Conn, scope: &Scope, from: NaiveDate, to: NaiveDate) -> Result<Report, String> {
    let months = months_in(from, to);
    let nodes = class_nodes(conn, scope, from, to, &months)?;
    let n = months.len();
    let mut rows = Vec::new();
    let mut totals = vec![0i64; n];
    let mut series = Vec::new();
    for node in &nodes {
        let mut cells: Vec<ReportCell> = node.values.iter().map(|v| money(*v)).collect();
        cells.push(money(node.values.iter().sum()));
        rows.push(keyed(&node.label, "class_value", &node.id, 0, cells));
        for (i, v) in node.values.iter().enumerate() {
            totals[i] += v;
        }
        if node.values.iter().sum::<i64>() != 0 && series.len() < 8 {
            series.push(ReportSeries {
                label: node.label.clone(),
                points: months.iter().enumerate().map(|(i, m)| (month_label(m), node.values[i])).collect(),
            });
        }
    }
    let mut tcells: Vec<ReportCell> = totals.iter().map(|v| money(*v)).collect();
    tcells.push(money(totals.iter().sum()));
    rows.push(styled("Total", "total", tcells));
    let mut columns = vec![col(&axis_name(scope), "text")];
    for m in &months {
        columns.push(col(&money_month_label(m), "money"));
    }
    columns.push(col("Total", "money"));
    Ok(Report {
        kind: String::new(),
        title: format!("{} by month", axis_name(scope)),
        subtitle: String::new(),
        columns,
        rows,
        chart: Some(ReportChart { kind: "bar".to_string(), series }),
    })
}

/// Classification × category: the cross-tab that the memo field used to be
/// asked for — which categories the Maple Street house's money went to.
fn classification_by_category(conn: &Conn, scope: &Scope, from: NaiveDate, to: NaiveDate) -> Result<Report, String> {
    let axis = scope.axis.clone().ok_or("this report needs a classification")?;
    let mut binds = vec![iso(from), iso(to)];
    let value_expr = scope.class_expr(&L, &axis.id, &mut binds);
    // Bound, not interpolated, and numbered for the same reason `class_expr`
    // is: it sits in the SELECT, ahead of the WHERE's ?1/?2.
    binds.push(format!("none:{}", axis.id));
    let none_key = format!("?{}", binds.len());
    let scoped = scope.lines_where(&mut binds);
    let sql = format!(
        "{LINES}
        SELECT COALESCE({value_expr}, {none_key}) AS value_id,
               COALESCE(CASE WHEN p.name IS NULL THEN c.name ELSE p.name || ' : ' || c.name END, 'Uncategorized'),
               COALESCE(c.id, ''),
               SUM(-l.amount_cents), COUNT(*)
          FROM lines l
          LEFT JOIN categories c ON c.id = l.category_id
          LEFT JOIN categories p ON p.id = c.parent_id
         WHERE l.date >= ?1 AND l.date <= ?2{scoped}
         GROUP BY value_id, 2
         ORDER BY value_id, 4 DESC, 2 COLLATE NOCASE"
    );
    let data = query_rows(conn, &sql, &binds, |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?, r.get::<_, i64>(4)?))
    })?;
    let labels = value_labels(conn, &axis.id)?;
    let none_id = format!("none:{}", axis.id);
    let none_label = format!("(no {})", axis.name.to_lowercase());
    let mut rows = Vec::new();
    let mut current: Option<String> = None;
    let (mut sub, mut grand) = (0i64, 0i64);
    let flush = |rows: &mut Vec<ReportLine>, current: &Option<String>, sub: i64| {
        if let Some(v) = current {
            let name = if *v == none_id { none_label.clone() } else { labels.get(v).cloned().unwrap_or_else(|| "(unknown)".into()) };
            rows.push(styled(&format!("Total {name}"), "subtotal", vec![money(sub), blank()]));
        }
    };
    for (value_id, category, category_id, cents, count) in data {
        if current.as_ref() != Some(&value_id) {
            flush(&mut rows, &current, sub);
            sub = 0;
            let name = if value_id == none_id { none_label.clone() } else { labels.get(&value_id).cloned().unwrap_or_else(|| "(unknown)".into()) };
            let mut h = header(&name, 2);
            h.key = Some(value_id.clone());
            h.key_kind = Some("class_value".to_string());
            rows.push(h);
            current = Some(value_id);
        }
        rows.push(keyed(&category, "category", &category_id, 1, vec![money(cents), text(count.to_string())]));
        sub += cents;
        grand += cents;
    }
    flush(&mut rows, &current, sub);
    rows.push(styled("Total", "total", vec![money(grand), blank()]));
    Ok(Report {
        kind: String::new(),
        title: format!("{} by category", axis.name),
        subtitle: String::new(),
        columns: vec![col(&format!("{} / category", axis.name), "text"), col("Total", "money"), col("Count", "count")],
        rows,
        chart: None,
    })
}

/// Two periods side by side, per classification value — "is the Pickup
/// costing me more this year than last".
fn classification_comparison(conn: &Conn, scope: &Scope, req: &ReportRequest, from: NaiveDate, to: NaiveDate) -> Result<Report, String> {
    let (cf, ct) = compare_range(req, from, to)?;
    let (earlier, later) = if cf <= from { ((cf, ct), (from, to)) } else { ((from, to), (cf, ct)) };
    let a = class_nodes(conn, scope, earlier.0, earlier.1, &[])?;
    let b = class_nodes(conn, scope, later.0, later.1, &[])?;
    let mut merged: BTreeMap<String, (String, i64, i64)> = BTreeMap::new();
    for n in a {
        let e = merged.entry(n.id.clone()).or_insert((n.label.clone(), 0, 0));
        e.1 += n.values[0];
    }
    for n in b {
        let e = merged.entry(n.id.clone()).or_insert((n.label.clone(), 0, 0));
        e.2 += n.values[0];
    }
    let mut items: Vec<(String, String, i64, i64)> = merged.into_iter().map(|(id, (label, x, y))| (id, label, x, y)).collect();
    items.sort_by(|p, q| (q.3 + q.2).cmp(&(p.3 + p.2)).then(p.1.to_lowercase().cmp(&q.1.to_lowercase())));
    let mut rows = Vec::new();
    let (mut ta, mut tb) = (0i64, 0i64);
    for (id, label, x, y) in &items {
        rows.push(keyed(label, "class_value", id, 0, vec![money(*x), money(*y), money(y - x)]));
        ta += x;
        tb += y;
    }
    rows.push(styled("Total", "total", vec![money(ta), money(tb), money(tb - ta)]));
    Ok(Report {
        kind: String::new(),
        title: format!("{} comparison", axis_name(scope)),
        subtitle: format!("{} vs {}", range_label(earlier.0, earlier.1), range_label(later.0, later.1)),
        columns: vec![
            col(&axis_name(scope), "text"),
            col(&format!("{} - {}", us(earlier.0), us(earlier.1)), "money"),
            col(&format!("{} - {}", us(later.0), us(later.1)), "money"),
            col("Difference", "money"),
        ],
        rows,
        chart: None,
    })
}

// ---------------------------------------------------------------------------
// Subscriptions: the charges that come back on a schedule
// ---------------------------------------------------------------------------

/// How often a charge repeats. `days` is the nominal gap, `tol` how far a
/// gap may stray and still count, `per_year` how many times it bills.
struct Cadence {
    label: &'static str,
    days: i64,
    tol: i64,
    per_year: i64,
    /// Charges needed before it counts: a yearly one cannot show three
    /// times inside the two-year default range.
    min_charges: usize,
}

const CADENCES: &[Cadence] = &[
    Cadence { label: "week", days: 7, tol: 2, per_year: 52, min_charges: 4 },
    Cadence { label: "2 weeks", days: 14, tol: 3, per_year: 26, min_charges: 4 },
    Cadence { label: "month", days: 30, tol: 6, per_year: 12, min_charges: 3 },
    Cadence { label: "2 months", days: 61, tol: 8, per_year: 6, min_charges: 3 },
    Cadence { label: "quarter", days: 91, tol: 10, per_year: 4, min_charges: 3 },
    Cadence { label: "6 months", days: 182, tol: 15, per_year: 2, min_charges: 2 },
    Cadence { label: "year", days: 365, tol: 20, per_year: 1, min_charges: 2 },
];

/// What the detector found for one payee.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Subscription {
    pub cadence: &'static str,
    pub days: i64,
    /// The typical charge, positive.
    pub amount_cents: i64,
    pub per_year_cents: i64,
    pub charges: usize,
    pub first: NaiveDate,
    pub last: NaiveDate,
    pub next: NaiveDate,
    /// Still being charged as of the date asked: the last charge is no
    /// older than one cadence and a half.
    pub active: bool,
    /// On the schedule but not at a steady amount (a utility, the
    /// weekly grocery run). Only `detect_recurring` with `allow_varying`
    /// returns one of these; `amount_cents` is then the median of the last
    /// three charges.
    pub varies: bool,
}

/// Does this list of (date, positive amount) charges, oldest first, look
/// like something billed on a schedule? Regular gaps (two thirds of them
/// within the cadence's tolerance) and a steady amount (two thirds within
/// 20% of the median) — so a streaming service that raised its price
/// still counts, and a grocery store that is visited most weeks does not.
pub fn detect_subscription(charges: &[(NaiveDate, i64)], asof: NaiveDate) -> Option<Subscription> {
    detect_recurring(charges, asof, false)
}

/// The same detector, with the amount test optional: for the cash forecast
/// a charge that comes on a schedule at a different amount each
/// time — the power bill, the weekly groceries — is still money that is
/// going to leave, and the median of the last three is a better guess than
/// nothing. The Subscriptions card keeps the strict form.
///
/// Two charges on one day (a retry, two purchases at one merchant)
/// are that day's charge, not a reason to give up on the payee. The first
/// version returned None on any such pair, and one such day in two years
/// hid the whole payee from the Subscriptions card and from the forecast,
/// which is most of why a file with two years of bills projected one.
pub fn detect_recurring(charges: &[(NaiveDate, i64)], asof: NaiveDate, allow_varying: bool) -> Option<Subscription> {
    let mut days: Vec<(NaiveDate, i64)> = Vec::new();
    for &(d, a) in charges {
        match days.last_mut() {
            Some(last) if last.0 == d => last.1 += a,
            _ => days.push((d, a)),
        }
    }
    let charges = &days[..];
    if charges.len() < 2 {
        return None;
    }
    let mut gaps: Vec<i64> = charges.windows(2).map(|w| (w[1].0 - w[0].0).num_days()).collect();
    if gaps.iter().any(|g| *g <= 0) {
        // Out of date order: the callers sort, so this is a bug, not a cadence.
        return None;
    }
    gaps.sort_unstable();
    let median_gap = gaps[gaps.len() / 2];
    let cadence = CADENCES.iter().find(|c| (median_gap - c.days).abs() <= c.tol)?;
    if charges.len() < cadence.min_charges {
        return None;
    }
    // A skipped bill is still on the cadence: a gap of two or
    // three cadences (within the tolerance, scaled) counts as regular. A
    // water bill that comes every two months once went four.
    let regular = gaps
        .iter()
        .filter(|g| {
            let g = **g;
            if (g - cadence.days).abs() <= cadence.tol {
                return true;
            }
            let k = (g + cadence.days / 2) / cadence.days;
            k >= 2 && (g - k * cadence.days).abs() <= cadence.tol * k
        })
        .count();
    if regular * 3 < gaps.len() * 2 {
        return None;
    }
    let mut amounts: Vec<i64> = charges.iter().map(|c| c.1).collect();
    amounts.sort_unstable();
    let median_amt = amounts[amounts.len() / 2];
    if median_amt <= 0 {
        return None;
    }
    let steady = amounts.iter().filter(|a| (*a - median_amt).abs() * 5 <= median_amt).count();
    let varies = steady * 3 < amounts.len() * 2;
    if varies && !allow_varying {
        return None;
    }
    // The amount to expect next: the latest charge, when it is one of the
    // steady ones (a price rise), else the median — and for a varying one,
    // the median of the last three, which follows the season.
    let latest = charges[charges.len() - 1].1;
    // A monthly payee billed more than once in a month (a power
    // bill for two properties, two bills since June) is one bill a month to the
    // forecast: the amount is then the median of the last three calendar
    // months' TOTALS. When each of those months had one charge the older
    // rule stands, so a price rise is still the latest charge.
    let month_totals: Vec<i64> = if cadence.days == 30 {
        let mut months: Vec<((i32, u32), i64, usize)> = Vec::new();
        for (d, a) in charges {
            let k = (d.year(), d.month());
            match months.last_mut() {
                Some(m) if m.0 == k => {
                    m.1 += a;
                    m.2 += 1;
                }
                _ => months.push((k, *a, 1)),
            }
        }
        let recent: Vec<&((i32, u32), i64, usize)> = months.iter().rev().take(3).collect();
        if recent.iter().any(|m| m.2 > 1) {
            recent.iter().map(|m| m.1).collect()
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };
    let amount = if !month_totals.is_empty() {
        let mut t = month_totals;
        t.sort_unstable();
        t[t.len() / 2]
    } else if varies {
        let mut recent: Vec<i64> = charges.iter().rev().take(3).map(|c| c.1).collect();
        recent.sort_unstable();
        recent[recent.len() / 2]
    } else if (latest - median_amt).abs() * 5 <= median_amt {
        latest
    } else {
        median_amt
    };
    let last = charges[charges.len() - 1].0;
    let next = last + chrono::Duration::days(cadence.days);
    let active = (asof - last).num_days() <= cadence.days + cadence.days / 2 + cadence.tol;
    Some(Subscription {
        cadence: cadence.label,
        days: cadence.days,
        amount_cents: amount,
        per_year_cents: amount * cadence.per_year,
        charges: charges.len(),
        first: charges[0].0,
        last,
        next,
        active,
        varies,
    })
}

/// "Subscriptions and recurring charges": every payee in the watched
/// accounts whose withdrawals come back on a schedule at a steady amount.
/// Without an account scope it watches the spending accounts — checking,
/// savings, cash and cards — since a 401(k) has no subscriptions in it.
/// Active ones first (largest yearly cost at the top), then the ones that
/// look to have stopped, so a canceled service can be checked off.
fn subscriptions(conn: &Conn, scope: &Scope, from: NaiveDate, to: NaiveDate) -> Result<Report, String> {
    let mut binds = vec![iso(from), iso(to)];
    let mut acct = scope.account_sql("t", &mut binds);
    if scope.accounts.is_none() {
        acct.push_str(" AND t.account_id IN (SELECT id FROM accounts WHERE type IN ('checking','savings','cash','credit'))");
    }
    acct.push_str(&scope.line_sql(&T, &mut binds));
    let sql = format!(
        "SELECT lower(trim(t.payee)), t.payee, t.payee_id, t.date, -t.amount_cents
           FROM transactions t
          WHERE t.is_void = 0 AND t.transfer_id IS NULL AND t.activity IS NULL
            AND t.is_revaluation = 0 AND t.is_split_transfer = 0
            AND t.amount_cents < 0 AND trim(t.payee) <> ''
            AND t.date >= ?1 AND t.date <= ?2{acct}
          ORDER BY 1, t.date"
    );
    let data = query_rows(conn, &sql, &binds, |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, String>(3)?, r.get::<_, i64>(4)?))
    })?;
    // Group by the normalized payee, keeping the display name and id of the latest row.
    let mut groups: Vec<(String, Option<String>, Vec<(NaiveDate, i64)>)> = Vec::new();
    let mut key = String::new();
    for (k, name, pid, date, amt) in data {
        let d = parse_date(&date)?;
        if k != key || groups.is_empty() {
            groups.push((name.clone(), pid.clone(), Vec::new()));
            key = k;
        }
        let g = groups.last_mut().unwrap();
        g.0 = name;
        g.1 = pid;
        g.2.push((d, amt));
    }
    let mut found: Vec<(String, Option<String>, Subscription)> = groups
        .into_iter()
        .filter_map(|(name, pid, charges)| detect_subscription(&charges, to).map(|s| (name, pid, s)))
        .collect();
    found.sort_by(|a, b| b.2.active.cmp(&a.2.active).then(b.2.per_year_cents.cmp(&a.2.per_year_cents)).then(a.0.to_lowercase().cmp(&b.0.to_lowercase())));

    let ncols = 6;
    let line = |name: &str, pid: &Option<String>, s: &Subscription| -> ReportLine {
        keyed(
            name,
            "payee",
            pid.as_deref().unwrap_or(""),
            1,
            vec![text(format!("Every {}", s.cadence)), money(s.amount_cents), text(us(s.last)), text(us(s.next)), text(s.charges.to_string()), money(s.per_year_cents)],
        )
    };
    let mut rows = Vec::new();
    let mut chart = Vec::new();
    let active: Vec<_> = found.iter().filter(|f| f.2.active).collect();
    let stopped: Vec<_> = found.iter().filter(|f| !f.2.active).collect();
    rows.push(header("Active", ncols));
    let mut per_year = 0i64;
    for (name, pid, s) in &active {
        rows.push(line(name, pid, s));
        per_year += s.per_year_cents;
        if chart.len() < 20 {
            chart.push((name.clone(), s.per_year_cents));
        }
    }
    if active.is_empty() {
        rows.push(row("(nothing that repeats on a schedule)", (0..ncols).map(|_| blank()).collect()));
    }
    rows.push(styled("Active per month", "subtotal", vec![blank(), money(per_year / 12), blank(), blank(), blank(), blank()]));
    rows.push(styled("Active per year", "total", vec![blank(), blank(), blank(), blank(), blank(), money(per_year)]));
    if !stopped.is_empty() {
        rows.push(header("May have stopped", ncols));
        for (name, pid, s) in &stopped {
            rows.push(line(name, pid, s));
        }
    }
    Ok(Report {
        kind: String::new(),
        title: "Subscriptions and recurring charges".to_string(),
        subtitle: String::new(),
        columns: vec![col("Payee", "text"), col("Billed", "text"), col("Amount", "money"), col("Last charged", "date"), col("Next expected", "date"), col("Charges", "count"), col("Per year", "money")],
        rows,
        chart: Some(ReportChart { kind: "bar".to_string(), series: vec![ReportSeries { label: "Per year".to_string(), points: chart }] }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::queries;

    // Checked whole when the test ends.
    use crate::db::test_db::TestDb;

    fn req(kind: &str, from: &str, to: &str) -> ReportRequest {
        ReportRequest { kind: kind.into(), from: from.into(), to: to.into(), account_ids: None, category_ids: None, compare_from: None, compare_to: None, detail: None, security_ids: None, tax_scope: None , ..Default::default()}
    }
    fn cat(c: &Conn, name: &str) -> String {
        queries::list_categories(c).unwrap().into_iter().find(|x| x.name == name).map(|x| x.id).unwrap_or_else(|| panic!("no category {name}"))
    }
    fn cell_money(r: &ReportLine, i: usize) -> i64 {
        r.cells[i].cents.expect("money cell")
    }
    fn find<'a>(rep: &'a Report, label: &str) -> &'a ReportLine {
        rep.rows.iter().find(|r| r.label == label).unwrap_or_else(|| panic!("no row {label:?} in {:?}", rep.rows.iter().map(|r| &r.label).collect::<Vec<_>>()))
    }

    /// A small world: two bank accounts, a card, a loan; wages, groceries
    /// (one split), a transfer, a void, a tax-lined expense.
    fn world(c: &Conn) -> (String, String, String, String) {
        let chk = queries::create_account(c, "Checking", "checking", 100_000, Some("2026-01-01")).unwrap().id;
        let sav = queries::create_account(c, "Savings", "savings", 500_000, Some("2026-01-01")).unwrap().id;
        let visa = queries::create_account(c, "Visa", "credit", 0, Some("2026-01-01")).unwrap().id;
        let loan = queries::create_account(c, "Truck Loan", "loan", -1_000_000, Some("2026-01-01")).unwrap().id;
        let wages = cat(c, "Wages & Salary");
        let groc = cat(c, "Groceries");
        let fuel = cat(c, "Fuel");
        let dentist = cat(c, "Dentist");
        queries::create_transaction(c, &chk, "2026-08-01", "Employer", Some(&wages), 300_000, None, None).unwrap();
        queries::create_transaction(c, &chk, "2026-08-03", "Kroger", Some(&groc), -10_000, None, None).unwrap();
        queries::create_transaction(c, &visa, "2026-08-04", "Shell", Some(&fuel), -4_000, None, None).unwrap();
        queries::create_transaction(c, &chk, "2026-08-05", "Dr. Reyes", Some(&dentist), -12_000, None, None).unwrap();
        let w = queries::create_transaction(c, &visa, "2026-08-06", "Walmart", None, -9_000, None, None).unwrap();
        queries::set_splits(c, &w.id, &[
            crate::models::NewSplit { classes: Vec::new(), category_id: Some(groc.clone()), description: Some("food".into()), amount_cents: -6_000, transfer_account_id: None },
            crate::models::NewSplit { classes: Vec::new(), category_id: Some(fuel.clone()), description: None, amount_cents: -3_000, transfer_account_id: None },
        ]).unwrap();
        queries::create_transfer(c, &chk, &sav, "2026-08-10", 50_000, None).unwrap();
        let bad = queries::create_transaction(c, &chk, "2026-08-11", "Fraud", Some(&groc), -99_000, None, None).unwrap();
        queries::set_void(c, &bad.id, true).unwrap();
        // September, for month-across reports.
        queries::create_transaction(c, &chk, "2026-09-01", "Employer", Some(&wages), 300_000, None, None).unwrap();
        queries::create_transaction(c, &chk, "2026-09-02", "Kroger", Some(&groc), -8_000, None, None).unwrap();
        queries::set_budget(c, &groc, 20_000, "2026-08").unwrap();
        queries::set_budget(c, &groc, 20_000, "2026-09").unwrap();
        (chk, sav, visa, loan)
    }

    /// A Property axis with two houses, one whole transaction
    /// tagged and one SPLIT with a different house per line — the case that
    /// makes the axis worth having and the one clones get wrong.
    fn classify(c: &Conn) -> (String, String, String) {
        use crate::db::classes;
        let axis = classes::create_classification(c, "Property").unwrap();
        let maple = classes::create_classification_value(c, &axis.id, "Maple", None).unwrap();
        let birch = classes::create_classification_value(c, &axis.id, "Birch Lane", None).unwrap();
        let pick = |v: &str| crate::models::ClassPick { classification_id: axis.id.clone(), value_id: v.to_string(), label: String::new() };
        // The dentist bill is Maple's; the Walmart split is one line each.
        let ids: Vec<(String, String, i64)> = query_rows(
            c,
            "SELECT id, payee, amount_cents FROM transactions ORDER BY date",
            &[],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
        let dentist = ids.iter().find(|x| x.1 == "Dr. Reyes").unwrap().0.clone();
        classes::set_transaction_classes(c, &dentist, &[pick(&maple.id)]).unwrap();
        let walmart = ids.iter().find(|x| x.1 == "Walmart").unwrap().0.clone();
        let groc = cat(c, "Groceries");
        let fuel = cat(c, "Fuel");
        queries::set_splits(
            c,
            &walmart,
            &[
                crate::models::NewSplit { classes: vec![pick(&maple.id)], category_id: Some(groc), description: Some("food".into()), amount_cents: -6_000, transfer_account_id: None },
                crate::models::NewSplit { classes: vec![pick(&birch.id)], category_id: Some(fuel), description: None, amount_cents: -3_000, transfer_account_id: None },
            ],
        )
        .unwrap();
        (axis.id, maple.id, birch.id)
    }

    #[test]
    fn every_gallery_entry_runs_on_an_empty_file_and_a_populated_one() {
        let db = TestDb::new("all");
        let c = db.conn();
        for (group, kind, _) in GALLERY {
            let r = run_report(&c, &req(kind, "2026-01-01", "2026-12-31"));
            if *group == "Classifications" {
                // A file with no classifications cannot answer these, and
                // says so rather than drawing an empty table; `list_reports`
                // leaves the whole group out until there is one.
                assert!(r.unwrap_err().contains("no classifications"), "{kind} should say why it cannot run");
            } else {
                r.unwrap_or_else(|e| panic!("{kind} on empty: {e}"));
            }
        }
        world(&c);
        classify(&c);
        for (_, kind, _) in GALLERY {
            let r = run_report(&c, &req(kind, "2026-08-01", "2026-09-30")).unwrap_or_else(|e| panic!("{kind}: {e}"));
            assert_eq!(&r.kind, kind);
            assert!(!r.columns.is_empty());
            for row in &r.rows {
                assert_eq!(row.cells.len(), r.columns.len() - 1, "{kind}: row {:?} has {} cells for {} columns", row.label, row.cells.len(), r.columns.len());
            }
        }
    }

    /// The same width check with an investment account in the file.
    /// `world` has none, so every investment report above ran with no rows
    /// but its total, and the short header and problem lines never appeared.
    #[test]
    fn investment_reports_give_every_row_a_cell_per_column_and_a_subtotal_that_adds_up() {
        use crate::models::NewInvestmentTransaction;
        let db = TestDb::new("inv-widths");
        let c = db.conn();
        world(&c);
        let brk = queries::create_account(&c, "Brokerage", "investment", 1_000_000, Some("2026-01-01")).unwrap().id;
        // Type "other": Asset allocation's untyped note, and — unscoped — its
        // "Cash in investment accounts" header, which had no cells at all.
        let sec = queries::create_security(&c, "Widget Fund", "WID", "other", None).unwrap();
        let tx = |date: &str, activity: &str, shares: i64, gross: i64| {
            queries::create_investment_transaction(&c, &NewInvestmentTransaction {
                account_id: brk.clone(), date: date.into(), activity: activity.into(), security_id: sec.id.clone(),
                shares_micro: shares * lots::MICRO, price_micro: None, gross_cents: gross, commission_cents: 0,
                category_id: None, notes: None, funding_account_id: None, lot_allocations: vec![],
            }).unwrap()
        };
        tx("2026-02-02", "buy", 100, 100_000);
        tx("2026-08-15", "reinvest_dividend", 1, 1_000);
        tx("2026-09-01", "sell", 10, 12_000);
        // More back than the basis left: a portfolio problem line.
        tx("2026-09-05", "return_of_capital", 0, 500_000);
        queries::set_security_price(&c, &sec.id, "2026-09-01", 12 * lots::MICRO, "manual").unwrap();

        for (group, kind, _) in GALLERY {
            if *group == "Classifications" {
                continue;
            }
            let r = run_report(&c, &req(kind, "2026-08-01", "2026-09-30")).unwrap_or_else(|e| panic!("{kind}: {e}"));
            for row in &r.rows {
                assert_eq!(row.cells.len(), r.columns.len() - 1, "{kind}: row {:?} has {} cells for {} columns", row.label, row.cells.len(), r.columns.len());
            }
        }
        let pv = run_report(&c, &req("portfolio_value", "2026-09-30", "2026-09-30")).unwrap();
        assert!(pv.rows.iter().any(|r| r.style == "header" && r.label == "Brokerage"), "{:?}", pv.rows.iter().map(|r| &r.label).collect::<Vec<_>>());
        assert!(pv.rows.iter().any(|r| r.label.starts_with("Return of Capital")), "no problem line: {:?}", pv.rows.iter().map(|r| &r.label).collect::<Vec<_>>());
        let cg = run_report(&c, &req("capital_gains", "2026-08-01", "2026-09-30")).unwrap();
        assert!(cg.rows.iter().any(|r| r.style == "header"), "{:?}", cg.rows.iter().map(|r| &r.label).collect::<Vec<_>>());
        let aa = run_report(&c, &req("asset_allocation", "2026-09-30", "2026-09-30")).unwrap();
        assert!(aa.rows.iter().any(|r| r.style == "header" && r.label == "Cash in investment accounts"), "{:?}", aa.rows.iter().map(|r| &r.label).collect::<Vec<_>>());

        // The reinvestment shows its 10.00 gross; the subtotal is the cash,
        // named so, and equal to "Net cash effect" with one account.
        let it = run_report(&c, &req("investment_transactions", "2026-08-01", "2026-09-30")).unwrap();
        let reinvest = it.rows.iter().find(|r| r.cells[0].text.as_deref() == Some(lots::activity_label("reinvest_dividend"))).expect("reinvest row");
        assert_eq!(cell_money(reinvest, 6), 1_000);
        let sub = cell_money(find(&it, "Cash effect Brokerage"), 6);
        assert_eq!(sub, cell_money(find(&it, "Net cash effect"), 6));
        assert!(!it.rows.iter().any(|r| r.label == "Total Brokerage"));
        let shown: i64 = it.rows.iter().filter(|r| r.key_kind.as_deref() == Some("transaction")).map(|r| cell_money(r, 6)).sum();
        assert_eq!(shown - sub, 1_000, "the column and the cash differ by exactly the reinvested gross");
    }

    #[test]
    fn spending_by_category_counts_split_lines_and_ignores_transfers_and_voids() {
        let db = TestDb::new("sbc");
        let c = db.conn();
        world(&c);
        let r = run_report(&c, &req("spending_by_category", "2026-08-01", "2026-08-31")).unwrap();
        assert_eq!(r.subtitle, "8/1/2026 through 8/31/2026");
        // Groceries: 10,000 + 6,000 (split line); the voided 99,000 is out.
        // A childless parent is one bold row with its amount.
        let g = find(&r, "Groceries");
        assert_eq!(cell_money(g, 0), 16_000);
        assert_eq!(g.style, "bold");
        // Automobile is a group: a bold name-only row, Fuel beneath it, then
        // the blue "Total Automobile" = 4,000 + 3,000.
        assert_eq!(find(&r, "Automobile").style, "group");
        assert!(find(&r, "Automobile").cells.iter().all(|c| c.cents.is_none()));
        assert_eq!(cell_money(find(&r, "Fuel"), 0), 7_000);
        assert_eq!(find(&r, "Fuel").level, 1);
        assert_eq!(cell_money(find(&r, "Total Automobile"), 0), 7_000);
        assert_eq!(find(&r, "Total Automobile").style, "subtotal");
        // A spending report leaves income out unless categories are chosen.
        assert!(r.rows.iter().all(|x| x.label != "Total Income" && x.label != "Income"), "income rows on a spending report");
        assert_eq!(cell_money(find(&r, "Total Expenses"), 0), 16_000 + 7_000 + 12_000);
        assert_eq!(cell_money(find(&r, "Total spending"), 0), 35_000);
        // Asking for the income category by hand brings it back, with Money's net line.
        let mut q = req("spending_by_category", "2026-08-01", "2026-08-31");
        q.category_ids = Some(vec![cat(&c, "Wages & Salary"), cat(&c, "Groceries")]);
        let r2 = run_report(&c, &q).unwrap();
        assert_eq!(cell_money(find(&r2, "Total Income"), 0), 300_000);
        assert_eq!(cell_money(find(&r2, "Income less Expenses"), 0), 300_000 - 16_000);
        // The transfer is nowhere.
        assert!(!r.rows.iter().any(|x| x.label.contains("Transfer")));
        // Percent of section is basis points.
        assert_eq!(cell_money(find(&r, "Groceries"), 1), bps(16_000, 35_000));
    }

    #[test]
    fn scope_narrows_by_account_and_category() {
        let db = TestDb::new("scope");
        let c = db.conn();
        let (_, _, visa, _) = world(&c);
        let mut q = req("spending_by_category", "2026-08-01", "2026-08-31");
        q.account_ids = Some(vec![visa.clone()]);
        let r = run_report(&c, &q).unwrap();
        assert_eq!(cell_money(find(&r, "Groceries"), 0), 6_000, "only the Visa's split line");
        assert!(r.rows.iter().all(|x| x.label != "Healthcare" && x.label != "Total Healthcare"));
        let mut q = req("transactions_by_category", "2026-08-01", "2026-08-31");
        q.category_ids = Some(vec![cat(&c, "Automobile")]);
        let r = run_report(&c, &q).unwrap();
        let txns = r.rows.iter().filter(|x| x.key_kind.as_deref() == Some("transaction")).count();
        assert_eq!(txns, 2, "a parent selects its children's lines");
    }

    #[test]
    fn the_line_filters_apply_to_every_report_that_reads_lines() {
        // Money's customizer could filter one report and not the next.
        // Here the same scope goes through `lines_where`, so a filter means
        // the same thing everywhere it is applied.
        let db = TestDb::new("filters");
        let c = db.conn();
        world(&c);

        // Amount range: the $120 dentist and the $100 groceries are out,
        // the $40 fuel and the two split lines stay.
        let mut q = req("spending_by_category", "2026-08-01", "2026-08-31");
        q.max_cents = Some(9_900);
        let r = run_report(&c, &q).unwrap();
        assert_eq!(cell_money(find(&r, "Total spending"), 0), 4_000 + 6_000 + 3_000);
        assert!(r.subtitle.contains("amounts up to $99.00"), "the subtitle says what was filtered: {:?}", r.subtitle);

        // The same filter, through a different report, means the same thing.
        let mut q = req("transactions_by_payee", "2026-08-01", "2026-08-31");
        q.max_cents = Some(9_900);
        let r = run_report(&c, &q).unwrap();
        let n = r.rows.iter().filter(|x| x.key_kind.as_deref() == Some("transaction")).count();
        assert_eq!(n, 3, "Shell plus the two Walmart lines");

        // Categories can be left OUT, not only picked.
        let mut q = req("spending_by_category", "2026-08-01", "2026-08-31");
        q.category_ids = Some(vec![cat(&c, "Groceries")]);
        q.exclude_categories = Some(true);
        let r = run_report(&c, &q).unwrap();
        assert!(r.rows.iter().all(|x| x.label != "Groceries"), "groceries left out");
        assert_eq!(cell_money(find(&r, "Total spending"), 0), 4_000 + 12_000 + 3_000);

        // Payees, both ways.
        let kroger: String = c
            .query_row("SELECT id FROM payees WHERE name = 'Kroger'", [], |r| r.get(0))
            .unwrap();
        let mut q = req("spending_by_category", "2026-08-01", "2026-08-31");
        q.payee_ids = Some(vec![kroger.clone()]);
        let r = run_report(&c, &q).unwrap();
        assert_eq!(cell_money(find(&r, "Total spending"), 0), 10_000);
        q.exclude_payees = Some(true);
        let r = run_report(&c, &q).unwrap();
        assert_eq!(cell_money(find(&r, "Total spending"), 0), 4_000 + 12_000 + 9_000);

        // Text, over payee and memo — "food" is a split line's description.
        let mut q = req("spending_by_category", "2026-08-01", "2026-08-31");
        q.text = Some("food".into());
        let r = run_report(&c, &q).unwrap();
        assert_eq!(cell_money(find(&r, "Total spending"), 0), 6_000);
        let mut q = req("spending_by_category", "2026-08-01", "2026-08-31");
        q.text = Some("kro".into());
        let r = run_report(&c, &q).unwrap();
        assert_eq!(cell_money(find(&r, "Total spending"), 0), 10_000, "case-insensitive, on the payee");

        // Cleared state. Everything in `world` is open; clearing one row
        // makes the filter say something.
        let dentist: String = c.query_row("SELECT id FROM transactions WHERE payee = 'Dr. Reyes'", [], |r| r.get(0)).unwrap();
        queries::set_cleared(&c, &dentist, "C").unwrap();
        let mut q = req("spending_by_category", "2026-08-01", "2026-08-31");
        q.cleared = Some(vec!["C".into()]);
        let r = run_report(&c, &q).unwrap();
        assert_eq!(cell_money(find(&r, "Total spending"), 0), 12_000);
        let mut q = req("spending_by_category", "2026-08-01", "2026-08-31");
        q.cleared = Some(vec!["".into()]);
        let r = run_report(&c, &q).unwrap();
        assert_eq!(cell_money(find(&r, "Total spending"), 0), 10_000 + 4_000 + 9_000);

        // And the register-shaped report, which reads `transactions` rather
        // than the lines CTE — the one most likely to be left behind.
        let mut q = req("account_transactions", "2026-08-01", "2026-08-31");
        q.cleared = Some(vec!["C".into()]);
        let r = run_report(&c, &q).unwrap();
        let n = r.rows.iter().filter(|x| x.key_kind.as_deref() == Some("transaction")).count();
        assert_eq!(n, 1);
    }

    #[test]
    fn a_classification_report_reads_the_split_line_before_the_transaction() {
        // The whole point of the axis is the split case — one
        // Walmart trip, six thousand of it Maple's and three Birch Lane's.
        let db = TestDb::new("class");
        let c = db.conn();
        world(&c);
        let (axis, maple, birch) = classify(&c);

        let mut q = req("spending_by_classification", "2026-08-01", "2026-08-31");
        q.classification_id = Some(axis.clone());
        let r = run_report(&c, &q).unwrap();
        assert_eq!(r.title, "Spending by property");
        assert_eq!(cell_money(find(&r, "Maple"), 0), 12_000 + 6_000, "the dentist bill and one split line");
        assert_eq!(cell_money(find(&r, "Birch Lane"), 0), 3_000);
        // A spending report leaves income out, so the untagged bucket
        // is the groceries and the fuel, not the paycheck.
        assert_eq!(cell_money(find(&r, "(no property)"), 0), 10_000 + 4_000);

        // Scoping BY a value filters every other report the same way.
        let mut q = req("spending_by_category", "2026-08-01", "2026-08-31");
        q.class_value_ids = Some(vec![maple.clone()]);
        let r = run_report(&c, &q).unwrap();
        assert_eq!(cell_money(find(&r, "Total spending"), 0), 18_000);
        assert_eq!(cell_money(find(&r, "Groceries"), 0), 6_000, "the Maple half of the split only");

        // "No value on this axis" is a choice too.
        let mut q = req("spending_by_category", "2026-08-01", "2026-08-31");
        q.class_value_ids = Some(vec![format!("none:{axis}")]);
        let r = run_report(&c, &q).unwrap();
        assert_eq!(cell_money(find(&r, "Total spending"), 0), 10_000 + 4_000);

        // The cross-tab, and the transaction list under each value.
        let mut q = req("classification_by_category", "2026-08-01", "2026-08-31");
        q.classification_id = Some(axis.clone());
        let r = run_report(&c, &q).unwrap();
        let maple_at = r.rows.iter().position(|x| x.label == "Maple").unwrap();
        let total_at = r.rows.iter().position(|x| x.label == "Total Maple").unwrap();
        let labels: Vec<&str> = r.rows[maple_at + 1..total_at].iter().map(|x| x.label.as_str()).collect();
        assert!(labels.contains(&"Groceries") && labels.iter().any(|l| l.contains("Dentist")), "{labels:?}");

        let mut q = req("transactions_by_classification", "2026-08-01", "2026-08-31");
        q.classification_id = Some(axis.clone());
        let r = run_report(&c, &q).unwrap();
        let n = r.rows.iter().filter(|x| x.key_kind.as_deref() == Some("transaction")).count();
        // Six: the paycheck too — a transaction list is not a spending
        // report, so income is in it.
        assert_eq!(n, 6, "every line, under the value it carries");

        // A sub-value is selected by its parent.
        use crate::db::classes;
        let roof = classes::create_classification_value(&c, &axis, "Roof", Some(&maple)).unwrap();
        let bill = queries::create_transaction(&c, &queries::get_all_accounts(&c).unwrap()[0].id.clone(), "2026-08-20", "Roofer", None, -80_000, None, None).unwrap();
        classes::set_transaction_classes(&c, &bill.id, &[crate::models::ClassPick { classification_id: axis.clone(), value_id: roof.id.clone(), label: String::new() }]).unwrap();
        let mut q = req("spending_by_category", "2026-08-01", "2026-08-31");
        q.class_value_ids = Some(vec![maple.clone()]);
        let r = run_report(&c, &q).unwrap();
        assert_eq!(cell_money(find(&r, "Total spending"), 0), 18_000 + 80_000, "a parent value takes its sub-values");

        // Two axes AND together; two values of one axis OR.
        let person = classes::create_classification(&c, "Person").unwrap();
        let sam = classes::create_classification_value(&c, &person.id, "Sam", None).unwrap();
        classes::set_transaction_classes(&c, &bill.id, &[crate::models::ClassPick { classification_id: person.id.clone(), value_id: sam.id.clone(), label: String::new() }]).unwrap();
        let mut q = req("spending_by_category", "2026-08-01", "2026-08-31");
        q.class_value_ids = Some(vec![maple.clone(), sam.id.clone()]);
        let r = run_report(&c, &q).unwrap();
        assert_eq!(cell_money(find(&r, "Total spending"), 0), 80_000, "Maple AND Sam");
        let mut q = req("spending_by_category", "2026-08-01", "2026-08-31");
        q.class_value_ids = Some(vec![maple, birch]);
        let r = run_report(&c, &q).unwrap();
        assert_eq!(cell_money(find(&r, "Total spending"), 0), 18_000 + 80_000 + 3_000, "either house");
    }

    #[test]
    fn every_report_still_runs_with_every_filter_set_at_once() {
        // A REVIEW FINDING, kept as a test. `monthly_budget` was the one
        // report whose binds did not start as just the two dates: its month
        // bounds were written `?3`/`?4` AFTER the scope fragment, and an
        // anonymous `?` takes one past the largest index seen so far IN THE
        // TEXT — so the fragment's first placeholder became `?3` too, the
        // account id and the month shared a slot, and rusqlite refused the
        // call. It only showed up with a filter set, which is exactly the
        // case nothing exercised.
        let db = TestDb::new("allfilters");
        let c = db.conn();
        let (chk, ..) = world(&c);
        let (axis, maple, _) = classify(&c);
        let kroger: String = c.query_row("SELECT id FROM payees WHERE name = 'Kroger'", [], |r| r.get(0)).unwrap();
        for (_, kind, _) in GALLERY {
            let mut q = req(kind, "2026-08-01", "2026-09-30");
            q.account_ids = Some(vec![chk.clone()]);
            q.category_ids = Some(vec![cat(&c, "Groceries")]);
            q.exclude_categories = Some(true);
            q.payee_ids = Some(vec![kroger.clone()]);
            q.exclude_payees = Some(true);
            q.min_cents = Some(100);
            q.max_cents = Some(9_000_000);
            q.cleared = Some(vec!["".into(), "C".into()]);
            q.text = Some("o".into());
            q.class_value_ids = Some(vec![maple.clone(), format!("none:{axis}")]);
            q.classification_id = Some(axis.clone());
            q.compare_from = Some("2026-07-01".into());
            q.compare_to = Some("2026-07-31".into());
            run_report(&c, &q).unwrap_or_else(|e| panic!("{kind} with every filter set: {e}"));
        }
    }

    #[test]
    fn a_text_filter_survives_a_backslash_and_a_wildcard() {
        // Also a review finding: `%` and `_` were escaped and the escape
        // character itself was not, so "c:\\users" sent `\u` — not an escape
        // sequence, so the backslash vanished — and a trailing backslash
        // escaped the closing wildcard and matched nothing at all.
        let db = TestDb::new("like");
        let c = db.conn();
        let chk = queries::create_account(&c, "Checking", "checking", 0, Some("2026-01-01")).unwrap().id;
        queries::create_transaction(&c, &chk, "2026-08-01", "Backup", None, -1_000, Some(r"c:\users share"), None).unwrap();
        queries::create_transaction(&c, &chk, "2026-08-02", "Other", None, -2_000, Some("c:users share"), None).unwrap();
        queries::create_transaction(&c, &chk, "2026-08-03", "Percent", None, -4_000, Some("50% off"), None).unwrap();
        queries::create_transaction(&c, &chk, "2026-08-04", "Under", None, -8_000, Some("a_b"), None).unwrap();
        queries::create_transaction(&c, &chk, "2026-08-05", "Anything", None, -16_000, Some("axb"), None).unwrap();
        let spent = |text: &str| -> i64 {
            let mut q = req("spending_by_category", "2026-08-01", "2026-08-31");
            q.text = Some(text.to_string());
            let r = run_report(&c, &q).unwrap();
            cell_money(find(&r, "Total spending"), 0)
        };
        assert_eq!(spent(r"c:\users"), 1_000, "the backslash is literal, and matches only the row that has one");
        assert_eq!(spent("%"), 4_000, "a percent sign is a percent sign, not every row");
        assert_eq!(spent("a_b"), 8_000, "an underscore is an underscore, not any character");
        assert_eq!(spent(r"pay\"), 0, "a trailing backslash finds nothing rather than eating the wildcard");
    }

    #[test]
    fn the_unclassified_row_carries_the_axis_it_is_the_absence_of() {
        // A review finding: the bucket's key was "", so a drill through it
        // could not say WHICH axis had no value and dropped the filter
        // entirely — the "(no Property)" row opened a list of every
        // transaction in the range. The key is now a scope value in its own
        // right, and round-trips.
        let db = TestDb::new("nonekey");
        let c = db.conn();
        world(&c);
        let (axis, ..) = classify(&c);
        let mut q = req("spending_by_classification", "2026-08-01", "2026-08-31");
        q.classification_id = Some(axis.clone());
        let r = run_report(&c, &q).unwrap();
        let none = find(&r, "(no property)");
        assert_eq!(none.key.as_deref(), Some(format!("none:{axis}").as_str()));
        // …and feeding that key straight back scopes to exactly those lines.
        let mut q = req("spending_by_category", "2026-08-01", "2026-08-31");
        q.class_value_ids = Some(vec![none.key.clone().unwrap()]);
        let r2 = run_report(&c, &q).unwrap();
        assert_eq!(cell_money(find(&r2, "Total spending"), 0), cell_money(none, 0));
    }

    #[test]
    fn a_benchmark_compares_price_movement_and_says_when_it_cannot() {
        // Two holdings and an index fund. One beat it, one did not,
        // and the arithmetic is prices only — a contribution part-way
        // through must not show up as performance.
        use crate::models::NewInvestmentTransaction;
        let db = TestDb::new("bench");
        let c = db.conn();
        let acct = queries::create_account(&c, "Brokerage", "investment", 1_000_000, Some("2025-12-01")).unwrap().id;
        let mk = |name: &str, sym: &str| queries::create_security(&c, name, sym, "stock", None).unwrap();
        let winner = mk("Winner Corp", "WIN");
        let laggard = mk("Laggard Inc", "LAG");
        let index = mk("Index Fund", "IDX");
        let buy = |sec: &str, date: &str, shares: i64, cents: i64| {
            queries::create_investment_transaction(&c, &NewInvestmentTransaction {
                account_id: acct.clone(), date: date.to_string(), activity: "buy".into(), security_id: sec.to_string(),
                shares_micro: shares * lots::MICRO, price_micro: None, gross_cents: cents, commission_cents: 0,
                category_id: None, notes: None, funding_account_id: None, lot_allocations: vec![],
            }).unwrap()
        };
        buy(&winner.id, "2025-12-15", 100, 100_000);
        buy(&laggard.id, "2025-12-15", 100, 100_000);
        let price = |sec: &str, date: &str, dollars: i64| queries::set_security_price(&c, sec, date, dollars * lots::MICRO, "manual").unwrap();
        price(&winner.id, "2026-01-01", 10);
        price(&winner.id, "2026-12-31", 15); // +50%
        price(&laggard.id, "2026-01-01", 10);
        price(&laggard.id, "2026-12-31", 9); // −10%
        price(&index.id, "2026-01-01", 100);
        price(&index.id, "2026-12-31", 120); // +20%

        let mut q = req("benchmark_comparison", "2026-01-01", "2026-12-31");
        // Without a benchmark it opens and says what to do, rather than
        // refusing to draw.
        let empty = run_report(&c, &q).unwrap();
        assert!(empty.rows[0].label.contains("Choose a benchmark"), "{:?}", empty.rows[0].label);
        q.benchmark_security_id = Some(index.id.clone());
        let r = run_report(&c, &q).unwrap();
        assert_eq!(cell_money(find(&r, "Winner Corp"), 3), 5_000, "+50% in basis points");
        assert_eq!(cell_money(find(&r, "Winner Corp"), 4), 3_000, "30 points ahead of the index");
        assert_eq!(cell_money(find(&r, "Laggard Inc"), 3), -1_000);
        assert_eq!(cell_money(find(&r, "Laggard Inc"), 4), -3_000);
        // Equal money in each at the start, so together they are +20% — the
        // same as the index, and the difference is zero.
        assert_eq!(cell_money(find(&r, "These holdings, together"), 3), 2_000);
        assert_eq!(cell_money(find(&r, "These holdings, together"), 4), 0);
        assert_eq!(cell_money(find(&r, "Benchmark: Index Fund (IDX)"), 3), 2_000);

        // Money added DURING the range does not move a price return: the
        // report values the shares that were there on the first day.
        buy(&winner.id, "2026-06-30", 900, 1_080_000);
        let after = run_report(&c, &q).unwrap();
        assert_eq!(cell_money(find(&after, "These holdings, together"), 3), 2_000, "a later purchase is not performance");

        // A benchmark with no price at the start of the range says so.
        let unpriced = mk("Never Priced", "NONE");
        let mut q2 = req("benchmark_comparison", "2026-01-01", "2026-12-31");
        q2.benchmark_security_id = Some(unpriced.id);
        assert!(run_report(&c, &q2).unwrap_err().contains("no price stored"));
    }

    #[test]
    fn balances_as_of_a_date_unwind_later_rows() {
        let db = TestDb::new("asof");
        let c = db.conn();
        let (chk, ..) = world(&c);
        let r = run_report(&c, &req("account_balances", "2026-08-01", "2026-08-31")).unwrap();
        // Checking on 8/31: 100,000 + 300,000 − 10,000 − 12,000 − 50,000 = 328,000
        // (the void and September are out).
        assert_eq!(cell_money(find(&r, "Checking"), 0), 328_000);
        let r = run_report(&c, &req("net_worth", "2026-01-01", "2026-08-31")).unwrap();
        assert_eq!(r.subtitle, "As of 8/31/2026");
        let nw = cell_money(find(&r, "Net Worth"), 0);
        // 328,000 + 550,000 − 13,000 − 1,000,000
        assert_eq!(nw, 328_000 + 550_000 - 13_000 - 1_000_000);
        assert_eq!(cell_money(find(&r, "Total Liabilities"), 0), 1_013_000, "liabilities print positive, as Money does");
        // Level of detail: accounts lists each one under its type.
        let mut q = req("net_worth", "2026-01-01", "2026-08-31");
        q.detail = Some("accounts".into());
        let d = run_report(&c, &q).unwrap();
        assert_eq!(cell_money(find(&d, "Truck Loan"), 0), 1_000_000);
        assert_eq!(find(&d, "Truck Loan").level, 1);
        q.detail = Some("sides".into());
        let d = run_report(&c, &q).unwrap();
        assert!(d.rows.iter().all(|x| x.key_kind.is_none()), "sides shows no accounts or types");
        assert_eq!(cell_money(find(&d, "Net Worth"), 0), nw);
        let _ = chk;
        let r = run_report(&c, &req("net_worth_over_time", "2026-07-01", "2026-09-30")).unwrap();
        assert_eq!(r.rows.len(), 3);
        assert_eq!(cell_money(find(&r, "Jul 2026"), 2), 100_000 + 500_000 - 1_000_000, "July is before every row but the openings");
        assert_eq!(cell_money(find(&r, "Aug 2026"), 2), nw);
    }

    #[test]
    fn monthly_matrix_has_a_column_per_month_and_a_total() {
        let db = TestDb::new("matrix");
        let c = db.conn();
        world(&c);
        let r = run_report(&c, &req("monthly_income_expenses", "2026-08-01", "2026-09-30")).unwrap();
        assert_eq!(r.columns.iter().map(|x| x.label.as_str()).collect::<Vec<_>>(), ["Subcategory", "8/2026", "9/2026", "Total"]);
        let g = find(&r, "Groceries");
        assert_eq!((cell_money(g, 0), cell_money(g, 1), cell_money(g, 2)), (16_000, 8_000, 24_000));
        // Automobile: group row, Fuel under it, Total Automobile.
        let f = find(&r, "Fuel");
        assert_eq!((cell_money(f, 0), cell_money(f, 1), cell_money(f, 2)), (7_000, 0, 7_000));
        let net = find(&r, "Income less Expenses");
        assert_eq!(cell_money(net, 2), 600_000 - 35_000 - 8_000);
    }

    #[test]
    fn budget_report_pairs_budget_with_actual() {
        let db = TestDb::new("budget");
        let c = db.conn();
        world(&c);
        let r = run_report(&c, &req("monthly_budget", "2026-08-01", "2026-08-31")).unwrap();
        let g = find(&r, "Groceries");
        assert_eq!((cell_money(g, 0), cell_money(g, 1), cell_money(g, 2)), (20_000, 16_000, 4_000));
        assert_eq!(cell_money(g, 3), 8_000, "80% used, as basis points");
        let r = run_report(&c, &req("annual_budget", "2026-08-01", "2026-09-30")).unwrap();
        let g = find(&r, "Groceries");
        assert_eq!((cell_money(g, 0), cell_money(g, 1)), (4_000, 12_000));
    }

    #[test]
    fn transactions_by_payee_groups_and_subtotals() {
        let db = TestDb::new("tbp");
        let c = db.conn();
        world(&c);
        let r = run_report(&c, &req("transactions_by_payee", "2026-08-01", "2026-09-30")).unwrap();
        assert_eq!(cell_money(find(&r, "Total Kroger"), 4), -18_000);
        assert_eq!(cell_money(find(&r, "Total Employer"), 4), 600_000);
        let txn = r.rows.iter().find(|x| x.key_kind.as_deref() == Some("transaction")).unwrap();
        assert_eq!(txn.label, "8/5/2026", "Dr. Reyes sorts first; the label is the date");
        assert_eq!(txn.cells[1].text.as_deref(), Some("Checking"), "{:?}", txn.cells);
        assert_eq!(txn.cells[2].text.as_deref(), Some("Healthcare : Dentist"));
        let header = r.rows.iter().find(|x| x.style == "header" && x.label == "Kroger").unwrap();
        assert_eq!(header.key_kind.as_deref(), Some("payee"));
    }

    #[test]
    fn tax_reports_use_the_category_tax_line() {
        let db = TestDb::new("tax");
        let c = db.conn();
        world(&c);
        let r = run_report(&c, &req("tax_related_transactions", "2026-08-01", "2026-08-31")).unwrap();
        // Parents carry their tax line; the dentist visit sits under Healthcare.
        assert!(r.rows.iter().any(|x| x.style == "group" && x.label.starts_with("Healthcare") && x.label.contains("Medical and dental")));
        assert!(r.rows.iter().any(|x| x.style == "group" && x.label.starts_with("Wages & Salary") && x.label.contains("Wages")));
        assert_eq!(find(&r, "Dentist").level, 1);
        let visit = r.rows.iter().find(|x| x.key_kind.as_deref() == Some("transaction") && x.cells[1].text.as_deref() == Some("Dr. Reyes")).unwrap();
        assert_eq!(visit.level, 2);
        assert_eq!(cell_money(r.rows.iter().find(|x| x.label.starts_with("Grand total")).unwrap(), 4), 300_000 - 12_000);
        let s = run_report(&c, &req("tax_summary", "2026-08-01", "2026-08-31")).unwrap();
        assert!(s.rows.iter().any(|x| x.label.starts_with("Categories with spending and NO tax line")));
    }

    #[test]
    fn a_transaction_can_override_its_category_tax_line() {
        let db = TestDb::new("tax-override");
        let c = db.conn();
        world(&c);
        let find_txn = |r: &Report, payee: &str| r.rows.iter().any(|x| x.key_kind.as_deref() == Some("transaction") && x.cells[1].text.as_deref() == Some(payee));
        let visit = c.query_row("SELECT id FROM transactions WHERE payee = 'Dr. Reyes'", [], |r| r.get::<_, String>(0)).unwrap();
        let kroger = c.query_row("SELECT id FROM transactions WHERE payee = 'Kroger'", [], |r| r.get::<_, String>(0)).unwrap();

        // Take the dentist visit OUT (a reimbursed one), put a grocery run IN
        // (medical supplies rung up at the grocer).
        queries::set_transaction_tax_line(&c, &visit, Some("")).unwrap();
        queries::set_transaction_tax_line(&c, &kroger, Some("Schedule A: Medical and dental expenses")).unwrap();
        let r = run_report(&c, &req("tax_related_transactions", "2026-08-01", "2026-08-31")).unwrap();
        assert!(!find_txn(&r, "Dr. Reyes"));
        assert!(find_txn(&r, "Kroger"));
        assert_eq!(cell_money(r.rows.iter().find(|x| x.label.starts_with("Grand total")).unwrap(), 4), 300_000 - 10_000);
        let s = run_report(&c, &req("tax_summary", "2026-08-01", "2026-08-31")).unwrap();
        // Groceries now appears twice: once on the medical line, once with no line.
        let groc: Vec<usize> = s.rows.iter().enumerate().filter(|(_, x)| x.label == "Groceries").map(|(i, _)| i).collect();
        assert_eq!(groc.len(), 2, "{:?}", s.rows.iter().map(|x| &x.label).collect::<Vec<_>>());
        let medical = s.rows.iter().position(|x| x.style == "header" && x.label.contains("Medical")).unwrap();
        assert_eq!(cell_money(&s.rows[medical + 1], 0), -10_000);
        assert_eq!(s.rows[medical + 1].label, "Groceries");
        // The register shows the override; clearing it restores the category's line.
        let chk: String = c.query_row("SELECT account_id FROM transactions WHERE id = ?1", [&kroger], |r| r.get(0)).unwrap();
        assert_eq!(queries::get_register(&c, &chk).unwrap().iter().find(|x| x.id == kroger).unwrap().tax_line.as_deref(), Some("Schedule A: Medical and dental expenses"));
        queries::set_transaction_tax_line(&c, &visit, None).unwrap();
        let r = run_report(&c, &req("tax_related_transactions", "2026-08-01", "2026-08-31")).unwrap();
        assert!(find_txn(&r, "Dr. Reyes"));
        assert!(queries::set_transaction_tax_line(&c, "nope", None).is_err());
    }

    #[test]
    fn comparison_defaults_to_the_period_before() {
        let db = TestDb::new("cmp");
        let c = db.conn();
        world(&c);
        let r = run_report(&c, &req("spending_by_category_comparison", "2026-09-01", "2026-09-30")).unwrap();
        // Earlier period first, as Money lays it out; Difference = later − earlier.
        assert!(r.subtitle.starts_with("8/2/2026 through 8/31/2026 vs"), "{}", r.subtitle);
        assert_eq!(r.columns[1].label, "8/2/2026 - 8/31/2026");
        let g = find(&r, "Groceries");
        assert_eq!((cell_money(g, 0), cell_money(g, 1), cell_money(g, 2)), (16_000, 8_000, -8_000));
        // A spending comparison leaves income out too.
        assert!(r.rows.iter().all(|x| x.label != "Total Income"));
    }

    #[test]
    fn basis_points_round_half_away_from_zero() {
        assert_eq!(bps(1, 3), 3_333);
        assert_eq!(bps(2, 3), 6_667);
        assert_eq!(bps(-1, 3), -3_333);
        assert_eq!(bps(1, 0), 0);
        assert_eq!(bps(5, 10), 5_000);
        assert_eq!(bps(-16_000, -35_000), 4_571);
    }

    #[test]
    fn months_and_ranges_are_inclusive() {
        let d = |s: &str| NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap();
        assert_eq!(months_in(d("2025-11-15"), d("2026-02-01")), ["2025-11", "2025-12", "2026-01", "2026-02"]);
        assert_eq!(month_end("2026-02"), d("2026-02-28"));
        assert_eq!(month_end("2026-12"), d("2026-12-31"));
        assert_eq!(range_label(d("2025-01-01"), d("2025-12-31")), "1/1/2025 through 12/31/2025");
        assert!(run_report(&TestDb::new("bad").conn(), &req("net_worth", "2026-02-01", "2026-01-01")).is_err());
        assert!(run_report(&TestDb::new("unk").conn(), &req("nope", "2026-01-01", "2026-01-31")).is_err());
    }

    /// Not a test: a fixture dump for the rendering harness. Seeds a
    /// demo file and writes every gallery report as JSON to
    /// `$TM_REPORT_DUMP/<kind>.json`, so the viewer can be rendered in
    /// Chromium against real numbers and looked at.
    // Subscriptions: the detector on its own, then the report.
    fn d(s: &str) -> NaiveDate {
        parse_date(s).unwrap()
    }

    #[test]
    fn detects_a_monthly_charge_and_not_the_grocery_store() {
        let asof = d("2026-09-06");
        let netflix: Vec<(NaiveDate, i64)> = ["2026-03-14", "2026-04-14", "2026-05-14", "2026-06-15", "2026-07-14", "2026-08-14"].iter().map(|x| (d(x), 1_549)).collect();
        let s = detect_subscription(&netflix, asof).expect("monthly");
        assert_eq!((s.cadence, s.amount_cents, s.per_year_cents, s.charges, s.active), ("month", 1_549, 18_588, 6, true));
        assert_eq!(s.next, d("2026-09-13"));
        // A price rise part-way: the latest amount is what to expect.
        let mut raised = netflix.clone();
        raised[4].1 = 1_699;
        raised[5].1 = 1_699;
        assert_eq!(detect_subscription(&raised, asof).unwrap().amount_cents, 1_699);
        // Groceries most weeks at whatever it came to: the gaps are weekly but the amounts are not steady.
        let kroger: Vec<(NaiveDate, i64)> = [("2026-07-04", 8_812), ("2026-07-11", 12_305), ("2026-07-19", 6_120), ("2026-07-25", 15_040), ("2026-08-01", 9_900), ("2026-08-08", 4_310)].iter().map(|(x, a)| (d(x), *a)).collect();
        assert!(detect_subscription(&kroger, asof).is_none());
        // Two charges a month apart are not enough to call it monthly…
        assert!(detect_subscription(&netflix[..2], asof).is_none());
        // …but two a year apart are a yearly one.
        let prime = [(d("2025-02-03"), 13_900), (d("2026-02-03"), 13_900)];
        let y = detect_subscription(&prime, asof).unwrap();
        assert_eq!((y.cadence, y.per_year_cents, y.active), ("year", 13_900, true));
        // Irregular dates: three charges but the gaps are all over the place.
        let odd = [(d("2026-01-02"), 1_000), (d("2026-01-20"), 1_000), (d("2026-04-01"), 1_000), (d("2026-04-09"), 1_000)];
        assert!(detect_subscription(&odd, asof).is_none());
        // Stopped: monthly until May, nothing since.
        let gym: Vec<(NaiveDate, i64)> = ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01"].iter().map(|x| (d(x), 4_500)).collect();
        let g = detect_subscription(&gym, asof).unwrap();
        assert!(!g.active);
        // Same day twice is a retry: one day's charge, and two days are not a cadence.
        assert!(detect_subscription(&[(d("2026-01-01"), 100), (d("2026-01-01"), 100), (d("2026-02-01"), 100)], asof).is_none());
        // A retry on one day inside a run is that day's charge, not the end of the payee.
        let mut retried = netflix.clone();
        retried.insert(3, (d("2026-06-15"), 1_549));
        let r = detect_subscription(&retried, asof).expect("still monthly");
        assert_eq!((r.charges, r.amount_cents, r.varies), (6, 1_549, false));
        // A utility: on the schedule, never the same amount. Not a
        // subscription — but the forecast may still project it, at the
        // median of the last three.
        let power: Vec<(NaiveDate, i64)> = [("2026-03-20", 9_800), ("2026-04-20", 12_400), ("2026-05-20", 15_900), ("2026-06-20", 21_300), ("2026-07-20", 24_100), ("2026-08-20", 22_700)].iter().map(|(x, a)| (d(x), *a)).collect();
        assert!(detect_subscription(&power, asof).is_none());
        let p = detect_recurring(&power, asof, true).expect("regular, varying");
        assert_eq!((p.cadence, p.varies, p.amount_cents, p.active), ("month", true, 22_700, true));
        // The weekly grocery run, the same way: weekly, varying, projected at a typical week.
        let k = detect_recurring(&kroger, asof, true).expect("weekly, varying");
        assert_eq!((k.cadence, k.varies), ("week", true));
        // The steady ones read the same through either door.
        assert_eq!(detect_recurring(&netflix, asof, true), detect_subscription(&netflix, asof));
        // A water bill: every two months, one bill
        // skipped (a four-month gap), two gaps a little off. On the cadence.
        let asof2 = d("2026-09-14");
        let water: Vec<(NaiveDate, i64)> = [("2025-04-17", 10_000), ("2025-06-20", 11_000), ("2025-08-20", 30_000), ("2025-12-19", 10_500), ("2026-03-01", 11_500), ("2026-04-20", 12_000), ("2026-06-19", 20_000)].iter().map(|(x, a)| (d(x), *a)).collect();
        let w = detect_recurring(&water, asof2, true).expect("every two months, one skipped");
        assert_eq!((w.cadence, w.charges, w.active), ("2 months", 7, true));
        // A power bill: one bill a month on the 5th, then from
        // September a second on the 1st. To the forecast that is one monthly
        // charge at a typical recent MONTH'S total, not the latest bill.
        let mut electric: Vec<(NaiveDate, i64)> = (1..=11).map(|m| (NaiveDate::from_ymd_opt(2026, m, 5).unwrap(), 50_000)).collect();
        electric.push((d("2026-09-01"), 20_000));
        electric.push((d("2026-10-01"), 21_000));
        electric.push((d("2026-11-01"), 20_500));
        electric.sort();
        let x = detect_recurring(&electric, d("2026-11-20"), true).expect("monthly");
        assert_eq!((x.cadence, x.amount_cents), ("month", 70_500), "the median of the last three months' totals");
        // …and a plain monthly one with a price rise is still the latest charge.
        assert_eq!(detect_recurring(&raised, asof, true).unwrap().amount_cents, 1_699);
    }

    #[test]
    fn the_subscriptions_report_watches_the_spending_accounts_and_splits_active_from_stopped() {
        let db = TestDb::new("subs");
        let c = db.conn();
        let chk = queries::create_account(&c, "Checking", "checking", 100_000, Some("2025-01-01")).unwrap().id;
        let visa = queries::create_account(&c, "Visa", "credit", 0, Some("2025-01-01")).unwrap().id;
        let k401 = queries::create_account(&c, "401(k)", "retirement", 0, Some("2025-01-01")).unwrap().id;
        for m in 3..=8 {
            queries::create_transaction(&c, &visa, &format!("2026-{m:02}-14"), "Netflix", None, -1_549, None, None).unwrap();
        }
        for m in 1..=5 {
            queries::create_transaction(&c, &chk, &format!("2026-{m:02}-01"), "Anytime Fitness", None, -4_500, None, None).unwrap();
        }
        for (dt, a) in [("2026-07-04", 8_812), ("2026-07-11", 12_305), ("2026-07-19", 6_120), ("2026-07-25", 15_040), ("2026-08-01", 9_900), ("2026-08-08", 4_310)] {
            queries::create_transaction(&c, &chk, dt, "Kroger", None, -a, None, None).unwrap();
        }
        // A "fee" in the 401(k) every month would look like one — but it is not a spending account.
        for m in 1..=8 {
            queries::create_transaction(&c, &k401, &format!("2026-{m:02}-28"), "Plan fee", None, -500, None, None).unwrap();
        }
        // Voided rows count for nothing.
        let v = queries::create_transaction(&c, &visa, "2026-09-14", "Netflix", None, -1_549, None, None).unwrap();
        queries::set_void(&c, &v.id, true).unwrap();

        let rep = run_report(&c, &req("subscriptions", "2024-09-01", "2026-09-06")).unwrap();
        let labels: Vec<&str> = rep.rows.iter().map(|r| r.label.as_str()).collect();
        assert_eq!(labels, vec!["Active", "Netflix", "Active per month", "Active per year", "May have stopped", "Anytime Fitness"]);
        let nf = find(&rep, "Netflix");
        assert_eq!(nf.key_kind.as_deref(), Some("payee"));
        assert_eq!(nf.cells[0].text.as_deref(), Some("Every month"));
        assert_eq!(cell_money(nf, 1), 1_549);
        assert_eq!(nf.cells[2].text.as_deref(), Some("8/14/2026"));
        assert_eq!(nf.cells[3].text.as_deref(), Some("9/13/2026"));
        assert_eq!(cell_money(nf, 5), 18_588);
        assert_eq!(cell_money(find(&rep, "Active per month"), 1), 1_549);
        assert_eq!(cell_money(find(&rep, "Active per year"), 5), 18_588);
        assert_eq!(rep.chart.as_ref().unwrap().series[0].points, vec![("Netflix".to_string(), 18_588)]);

        // Asked to watch the 401(k) too, the fee shows up.
        let mut r2 = req("subscriptions", "2024-09-01", "2026-09-06");
        r2.account_ids = Some(vec![visa.clone(), k401.clone()]);
        let rep2 = run_report(&c, &r2).unwrap();
        let labels2: Vec<&str> = rep2.rows.iter().map(|r| r.label.as_str()).collect();
        assert!(labels2.contains(&"Plan fee") && labels2.contains(&"Netflix") && !labels2.contains(&"Anytime Fitness"), "{labels2:?}");
    }

    // The only test that touches `db::demo`, which is compiled out when
    // `debug_assertions` is off — so this one test, and only this one, has to
    // be gated the same way or `cargo check --release --all-targets` fails on
    // a test nobody runs. (`cargo check --release --lib`, which run-tests.bat
    // uses to catch that class of break, does not compile tests at all.)
    #[cfg(debug_assertions)]
    #[test]
    #[ignore]
    fn dump_report_fixtures() {
        let Ok(dir) = std::env::var("TM_REPORT_DUMP") else { return };
        std::fs::create_dir_all(&dir).unwrap();
        let db = TestDb::new("dump");
        let c = db.conn();
        crate::db::demo::seed(&c).expect("seed");
        let today = chrono::Local::now().date_naive();
        let from = today.with_day(1).unwrap();
        let from = NaiveDate::from_ymd_opt(from.year() - 1, from.month(), 1).unwrap();
        let mut all = serde_json::Map::new();
        for (_, kind, _) in GALLERY {
            let r = run_report(&c, &req(kind, &iso(from), &iso(today))).unwrap();
            all.insert(kind.to_string(), serde_json::to_value(&r).unwrap());
        }
        let gallery: Vec<serde_json::Value> = GALLERY.iter().map(|(g, k, l)| serde_json::json!({"group": g, "kind": k, "label": l})).collect();
        all.insert("__gallery".into(), serde_json::Value::Array(gallery));
        let accounts = queries::get_all_accounts(&c).unwrap();
        all.insert("__accounts".into(), serde_json::to_value(&accounts).unwrap());
        let cats = queries::list_categories(&c).unwrap();
        all.insert("__categories".into(), serde_json::to_value(&cats).unwrap());
        // The investment screens too — the 401(k) register, the portfolio, the securities.
        let mut registers = serde_json::Map::new();
        for a in &accounts {
            registers.insert(a.id.clone(), serde_json::to_value(queries::get_register(&c, &a.id).unwrap()).unwrap());
        }
        all.insert("__registers".into(), serde_json::Value::Object(registers));
        all.insert("__portfolio".into(), serde_json::to_value(lots::portfolio(&c, None, &iso(today)).unwrap()).unwrap());
        all.insert("__roi".into(), serde_json::to_value(lots::roi(&c, None, &iso(today)).unwrap()).unwrap());
        all.insert("__securities".into(), serde_json::to_value(queries::list_securities(&c).unwrap()).unwrap());
        std::fs::write(format!("{dir}/reports.json"), serde_json::to_string(&all).unwrap()).unwrap();
    }
}

#[cfg(test)]
mod asset_tests {
    use super::*;
    use crate::db::queries;

    // Checked whole when the test ends.
    use crate::db::test_db::TestDb;

    fn report(c: &Conn, kind: &str, from: &str, to: &str) -> Report {
        run_report(
            c,
            &ReportRequest {
                kind: kind.into(),
                from: from.into(),
                to: to.into(),
                account_ids: None,
                category_ids: None,
                compare_from: None,
                compare_to: None,
                detail: Some("accounts".into()),
                security_ids: None,
                tax_scope: None, ..Default::default()
            },
        )
        .expect("report")
    }

    fn total_of(r: &Report, label: &str) -> i64 {
        r.rows
            .iter()
            .find(|x| x.label == label)
            .unwrap_or_else(|| panic!("no row {label:?} in {:?}", r.rows.iter().map(|x| &x.label).collect::<Vec<_>>()))
            .cells[0]
            .cents
            .expect("money")
    }

    /// A house going up in value is not income and a car losing value is
    /// not spending — but both move net worth. That is the whole point of a
    /// revaluation being its own kind of row.
    #[test]
    fn a_revaluation_moves_net_worth_and_appears_in_no_spending_report() {
        let db = TestDb::new("reval");
        let c = db.conn();
        let house = queries::create_account(&c, "House", "home", 35_000_000, Some("2026-01-01")).unwrap().id;
        let truck = queries::create_account(&c, "Pickup", "vehicle", 1_100_000, Some("2026-01-01")).unwrap().id;

        queries::set_account_value(&c, &house, "2026-06-30", 37_000_000, Some("Zillow")).expect("house up");
        queries::set_account_value(&c, &truck, "2026-06-30", 900_000, None).expect("truck down");

        assert_eq!(queries::get_account(&c, &house).unwrap().balance_cents, 37_000_000);
        assert_eq!(queries::get_account(&c, &truck).unwrap().balance_cents, 900_000);

        // Net worth sees the new values.
        let nw = report(&c, "net_worth", "2026-01-01", "2026-12-31");
        assert_eq!(total_of(&nw, "House"), 37_000_000);
        assert_eq!(total_of(&nw, "Pickup"), 900_000);

        // Spending and income do not see them at all.
        for kind in ["spending_by_category", "income_and_spending", "spending_by_payee"] {
            let r = report(&c, kind, "2026-01-01", "2026-12-31");
            let money: i64 = r.rows.iter().flat_map(|x| x.cells.iter()).filter_map(|c| c.cents).map(i64::abs).sum();
            assert_eq!(money, 0, "{kind} counted a revaluation: {:?}", r.rows.iter().map(|x| (&x.label, &x.cells)).collect::<Vec<_>>());
        }
    }

    /// Three net worth reports over one file: the same total, told three
    /// ways. The tiered one is the point — a net worth of $600k made of a
    /// house is a different life from one made of cash, and the number alone
    /// cannot tell them apart.
    #[test]
    fn the_net_worth_reports_agree_on_the_total_and_split_it_by_how_reachable_it_is() {
        let db = TestDb::new("nw-variants");
        let c = db.conn();
        queries::create_account(&c, "Checking", "checking", 1_200_000, Some("2026-01-01")).unwrap();
        queries::create_account(&c, "Savings", "savings", 3_000_000, Some("2026-01-01")).unwrap();
        queries::create_account(&c, "Brokerage", "investment", 5_000_000, Some("2026-01-01")).unwrap();
        queries::create_account(&c, "TSP", "retirement", 50_000_000, Some("2026-01-01")).unwrap();
        queries::create_account(&c, "House", "home", 35_000_000, Some("2026-01-01")).unwrap();
        queries::create_account(&c, "Mortgage", "mortgage", -15_000_000, Some("2026-01-01")).unwrap();
        queries::create_account(&c, "Visa", "credit", -250_000, Some("2026-01-01")).unwrap();

        let expected = 1_200_000 + 3_000_000 + 5_000_000 + 50_000_000 + 35_000_000 - 15_000_000 - 250_000;

        // Every one of them lands on the same bottom line, whatever it groups by.
        for kind in ["net_worth", "net_worth_by_account", "assets_vs_liabilities", "liquid_net_worth"] {
            let r = report(&c, kind, "2026-01-01", "2026-12-31");
            assert_eq!(total_of(&r, "Net Worth"), expected, "{kind} disagrees about net worth");
        }

        let tiered = report(&c, "liquid_net_worth", "2026-01-01", "2026-12-31");
        assert_eq!(total_of(&tiered, "Total Liquid — spendable now"), 4_200_000, "cash and bank only");
        assert_eq!(total_of(&tiered, "Total Investments — days to reach"), 5_000_000, "the taxable brokerage, not the TSP");
        assert_eq!(total_of(&tiered, "Total Retirement — locked up until drawn"), 50_000_000);
        assert_eq!(total_of(&tiered, "Total Property — only by selling"), 35_000_000);
        // Debts come off whole, at the bottom. A mortgage is money owed, not
        // "less house" — netting it against the property tier would let the
        // report say the house is worth $200k of reachable value, which is the
        // exact confusion this split exists to prevent.
        assert_eq!(total_of(&tiered, "Total owed"), 15_250_000);
        assert_eq!(total_of(&tiered, "Total assets"), 94_200_000);

        // By-account names every account; the summary names neither them nor
        // their groups.
        let by_acct = report(&c, "net_worth_by_account", "2026-01-01", "2026-12-31");
        assert_eq!(total_of(&by_acct, "TSP"), 50_000_000);
        assert_eq!(total_of(&by_acct, "Mortgage"), 15_000_000, "liabilities print positive, as Money does");
        let sides = report(&c, "assets_vs_liabilities", "2026-01-01", "2026-12-31");
        assert!(!sides.rows.iter().any(|r| r.label == "TSP"), "the summary must not list accounts");
        assert_eq!(total_of(&sides, "Total Assets"), 94_200_000);
        assert_eq!(total_of(&sides, "Total Liabilities"), 15_250_000);
    }

    #[test]
    fn a_revaluation_is_a_difference_not_a_replacement_and_an_old_date_is_not_thrown_off_by_a_newer_row() {
        let db = TestDb::new("reval-order");
        let c = db.conn();
        let house = queries::create_account(&c, "House", "home", 40_000_000, Some("2026-01-01")).unwrap().id;

        queries::set_account_value(&c, &house, "2026-12-31", 44_000_000, None).unwrap();
        // Now fill in a value for the middle of the year. It must be worked
        // out against what the account was worth THEN — not against today,
        // which would write a bogus -$400 and leave December wrong.
        queries::set_account_value(&c, &house, "2026-06-30", 42_000_000, None).unwrap();

        let mid = report(&c, "net_worth", "2026-01-01", "2026-06-30");
        assert_eq!(total_of(&mid, "House"), 42_000_000, "the June value");
        let end = report(&c, "net_worth", "2026-01-01", "2026-12-31");
        assert_eq!(total_of(&end, "House"), 44_000_000, "December must still stand");

        // Saying it is worth what it is already worth writes nothing.
        assert!(queries::set_account_value(&c, &house, "2026-12-31", 44_000_000, None).unwrap().is_none());
    }

    #[test]
    fn only_an_asset_can_be_revalued_and_only_a_debt_can_be_secured() {
        let db = TestDb::new("reval-guard");
        let c = db.conn();
        let checking = queries::create_account(&c, "Checking", "checking", 100_000, Some("2026-01-01")).unwrap().id;
        let house = queries::create_account(&c, "House", "home", 35_000_000, Some("2026-01-01")).unwrap().id;
        let mortgage = queries::create_account(&c, "Mortgage", "mortgage", -15_000_000, Some("2026-01-01")).unwrap().id;

        let err = queries::set_account_value(&c, &checking, "2026-06-30", 1, None).expect_err("refused");
        assert!(err.contains("sum of its transactions"), "{err}");

        queries::set_account_security(&c, &mortgage, Some(&house)).expect("mortgage on house");
        assert_eq!(queries::get_account(&c, &mortgage).unwrap().secured_by_account_id.as_deref(), Some(house.as_str()));

        assert!(queries::set_account_security(&c, &house, Some(&mortgage)).is_err(), "a house is not a debt");
        assert!(queries::set_account_security(&c, &mortgage, Some(&checking)).is_err(), "a debt is not secured on a checking account");
        assert!(queries::set_account_security(&c, &mortgage, Some(&mortgage)).is_err(), "nor on itself");

        queries::set_account_security(&c, &mortgage, None).expect("unlink");
        assert!(queries::get_account(&c, &mortgage).unwrap().secured_by_account_id.is_none());
    }

    #[test]
    fn equity_is_the_asset_less_every_debt_secured_on_it() {
        let db = TestDb::new("equity");
        let c = db.conn();
        let house = queries::create_account(&c, "House", "home", 35_000_000, Some("2026-01-01")).unwrap().id;
        let mortgage = queries::create_account(&c, "Mortgage", "mortgage", -15_000_000, Some("2026-01-01")).unwrap().id;
        let heloc = queries::create_account(&c, "HELOC", "home_equity_line_of_credit", -2_500_000, Some("2026-01-01")).unwrap().id;
        let truck = queries::create_account(&c, "Pickup", "vehicle", 900_000, Some("2026-01-01")).unwrap().id;

        queries::set_account_security(&c, &mortgage, Some(&house)).unwrap();
        queries::set_account_security(&c, &heloc, Some(&house)).unwrap();

        let owed = queries::debts_by_asset(&c).unwrap();
        assert_eq!(owed.get(&house).copied(), Some(17_500_000), "both debts count against the house");
        assert_eq!(owed.get(&truck), None, "an asset with no debt is not in the map");

        // And net worth is unchanged by the link: it already counted both
        // sides, which is exactly why equity is a display, not an adjustment.
        let nw = report(&c, "net_worth", "2026-01-01", "2026-12-31");
        let net = nw.rows.iter().find(|r| r.label.starts_with("Net Worth")).map(|r| r.cells[0].cents.unwrap());
        assert_eq!(net, Some(35_000_000 + 900_000 - 17_500_000));
    }

    // A categorical chart reads largest to smallest; a time chart
    // keeps the calendar's order.
    #[test]
    fn categorical_charts_are_largest_first_and_time_charts_are_not() {
        let mut chart = ReportChart {
            kind: "bar".to_string(),
            series: vec![ReportSeries {
                label: "Total".to_string(),
                points: vec![("Automobile".into(), -12_000), ("Bills".into(), -90_000), ("Charity".into(), -12_000), ("Dining".into(), 30_000)],
            }],
        };
        largest_first(&mut chart);
        let labels: Vec<&str> = chart.series[0].points.iter().map(|(l, _)| l.as_str()).collect();
        // By magnitude, sign ignored; a tie falls back to the name.
        assert_eq!(labels, vec!["Bills", "Dining", "Automobile", "Charity"]);

        // Several series over the same labels stay lined up, ordered by the
        // sum across them; a label missing from one series counts as zero.
        let mut two = ReportChart {
            kind: "bar".to_string(),
            series: vec![
                ReportSeries { label: "This year".to_string(), points: vec![("A".into(), 100), ("B".into(), 500)] },
                ReportSeries { label: "Last year".to_string(), points: vec![("B".into(), 100), ("A".into(), 700), ("C".into(), 650)] },
            ],
        };
        largest_first(&mut two);
        for s in &two.series {
            let labels: Vec<&str> = s.points.iter().map(|(l, _)| l.as_str()).collect();
            let expected: Vec<&str> = ["A", "C", "B"].iter().copied().filter(|l| labels.contains(l)).collect();
            assert_eq!(labels, expected, "{}", s.label);
        }

        // The whole engine: a category report's chart comes out largest first,
        // and a month-by-month one comes out in month order.
        let db = TestDb::new("chartorder");
        let c = db.conn();
        let chk = queries::create_account(&c, "Checking", "checking", 100_000, Some("2026-01-01")).unwrap().id;
        let small = queries::ensure_category(&c, "Aardvark Food").unwrap();
        let big = queries::ensure_category(&c, "Zoo").unwrap();
        queries::create_transaction(&c, &chk, "2026-01-05", "A", Some(&small), -1_000, None, None).unwrap();
        queries::create_transaction(&c, &chk, "2026-02-05", "Z", Some(&big), -9_000, None, None).unwrap();
        let rep = report(&c, "spending_by_category", "2026-01-01", "2026-12-31");
        let pts = &rep.chart.as_ref().unwrap().series[0].points;
        let zoo = pts.iter().position(|(l, _)| l == "Zoo").unwrap();
        let aard = pts.iter().position(|(l, _)| l == "Aardvark Food").unwrap();
        assert!(zoo < aard, "the larger category charts first: {pts:?}");
        let months = report(&c, "monthly_income_expenses", "2026-01-01", "2026-03-31");
        // January (the small month) still comes before February (the large
        // one): largest-first would have swapped them.
        for s in &months.chart.as_ref().unwrap().series {
            let pts = &s.points;
            if pts.len() >= 2 && (pts[0].1 != 0 || pts[1].1 != 0) {
                assert!(pts[0].1.abs() <= pts[1].1.abs(), "{}: months stay in calendar order: {pts:?}", s.label);
            }
        }
    }
}
