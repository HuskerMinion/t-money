//! Data models shared between the Rust backend and the TypeScript frontend.
//!
//! All money values are integer cents (i64) — never floats. Field names are
//! kept in snake_case to match the TypeScript mirrors in `src/lib/types.ts`
//! exactly (Tauri auto-converts camelCase *invoke arguments* to snake_case,
//! but serialized struct fields pass through verbatim).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    pub id: String,
    pub name: String,
    /// One of the 17 types in migration 0009. The Account List groups
    /// these into Bank / Credit / Investment / Other.
    pub r#type: String,
    /// The register balance: for an investment account, its CASH.
    pub balance_cents: i64,
    /// Market value of the account's holdings at the latest prices; zero for
    /// anything but investment and retirement accounts. The account's
    /// worth is `balance_cents + holdings_value_cents`.
    #[serde(default)]
    pub holdings_value_cents: i64,
    /// Counted in tax reports. Retirement accounts start excluded.
    #[serde(default = "default_true")]
    pub tax_included: bool,
    /// How this account's holdings round to the cent — "nearest" |
    /// "down" — or None to follow the file's setting.
    #[serde(default)]
    pub value_rounding: Option<String>,
    /// For a liability, the asset it is borrowed against — the mortgage
    /// names the house. Equity is the asset's worth less the debts secured on
    /// it, and one asset can carry several (a mortgage and a HELOC).
    #[serde(default)]
    pub secured_by_account_id: Option<String>,
    /// Where this account sits in every list of accounts — the account
    /// bar, the Home page's favorites, the Favorites menu, the Account List.
    /// None = never placed; those sort after the placed ones, by name.
    #[serde(default)]
    pub sort_order: Option<i64>,
    pub is_favorite: bool,
    pub is_closed: bool,
    pub updated_at: String,
    // --- institution + contact details (migration 0010) ---
    pub institution: Option<String>,
    /// Sensitive. Encrypted at rest; mask it in the UI and never print it in
    /// full in an export or report.
    pub account_number: Option<String>,
    /// Sensitive — see `account_number`.
    pub routing_number: Option<String>,
    pub opened_on: Option<String>,
    /// Credit limit, for credit and line-of-credit accounts.
    pub credit_limit_cents: Option<i64>,
    pub contact_phone: Option<String>,
    pub contact_email: Option<String>,
    pub website: Option<String>,
    pub address: Option<String>,
    pub account_notes: Option<String>,
    /// The currency the account is kept in (ISO code). Its amounts are
    /// hundredths of THIS currency; totals across accounts are in dollars.
    #[serde(default = "default_home")]
    pub currency: String,
    /// Dollars per unit of `currency` today, in millionths — 1,000,000 for
    /// dollars, 0 when the currency has no rate. Lets the frontend total
    /// accounts in dollars with the same arithmetic as the backend.
    #[serde(default)]
    pub home_rate_micro: i64,
}

fn default_home() -> String {
    crate::currency::DEFAULT_HOME.to_string()
}

/// A SimpleFIN account this file knows about, and the T-Money account it
/// fills, if any.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SimplefinAccount {
    pub sf_id: String,
    pub name: String,
    /// The bank, when SimpleFIN says.
    pub org: Option<String>,
    pub currency: Option<String>,
    /// What the bank says the balance is, as of `balance_date`.
    pub balance_cents: Option<i64>,
    pub balance_date: Option<String>,
    pub account_id: Option<String>,
    pub account_name: Option<String>,
    /// The last day fetched for this account.
    pub synced_through: Option<String>,
}

/// Whether the open file is connected to SimpleFIN, and to what.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SimplefinStatus {
    pub connected: bool,
    /// The server's name, e.g. bridge.simplefin.org — never the credential.
    pub server: Option<String>,
    pub accounts: Vec<SimplefinAccount>,
    /// Requests in the last 24 hours (a rolling day, not a calendar one).
    pub requests_today: u32,
    pub daily_limit: u32,
    /// SimpleFIN's own messages from the request just made (a bank to sign
    /// in to again, a quota warning). Empty when nothing was asked.
    pub messages: Vec<String>,
}

/// What one fetch did to one linked account.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SimplefinSyncLine {
    pub sf_name: String,
    pub account_id: String,
    pub account_name: String,
    pub imported: u32,
    /// Paired with a transaction already typed in, which is kept.
    pub matched: u32,
    pub duplicates: u32,
    /// The bank's balance and the register's, side by side, so a gap shows.
    pub bank_balance_cents: Option<i64>,
    pub balance_cents: i64,
    pub error: Option<String>,
    /// Something to know that is not an error: days SimpleFIN could not
    /// reach back to.
    pub note: Option<String>,
}

/// What a fetch did: per linked account, SimpleFIN's own messages (a bank
/// to sign in to again), and how many accounts are not linked yet.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SimplefinSync {
    pub lines: Vec<SimplefinSyncLine>,
    pub messages: Vec<String>,
    pub unlinked: u32,
    /// The days asked for, YYYY-MM-DD.
    pub from: String,
    pub to: String,
}

/// How a file writes money and dates: its home currency and its region
/// (a tag from `region::REGIONS`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FileFormat {
    pub home_currency: String,
    pub region: String,
}

/// One exchange rate: home-currency units per unit of `currency` from
/// `date` on.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExchangeRate {
    pub currency: String,
    pub date: String,
    pub rate_micro: i64,
    /// "manual" or "fetched".
    pub source: String,
}

/// What a loan costs and how its payment divides. Every field is a
/// starting point the user can type over when the payment is recorded: the
/// bank's arithmetic wins.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoanTerms {
    pub account_id: String,
    /// Annual rate in millionths: 6.0% is 6_000_000.
    pub apr_micro: i64,
    /// The regular payment, principal and interest only.
    pub payment_cents: i64,
    pub escrow_cents: i64,
    /// Principal paid ahead on top of the scheduled payment, every
    /// month, by choice. Proposed on every payment and applied by the
    /// schedule; zero for a loan paid to its terms.
    pub extra_principal_cents: i64,
    pub escrow_account_id: Option<String>,
    pub escrow_category_id: Option<String>,
    pub interest_category_id: Option<String>,
    pub from_account_id: Option<String>,
    pub payment_day: Option<i64>,
    pub first_payment_date: Option<String>,
    pub term_months: Option<i64>,
    pub notes: Option<String>,
}

/// One row of an amortization schedule, or of a payment as it will be
/// recorded. Balances are the loan's, as a positive amount owed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoanPeriod {
    pub date: String,
    pub payment_cents: i64,
    pub interest_cents: i64,
    pub principal_cents: i64,
    pub escrow_cents: i64,
    /// Principal ahead of schedule, on top of `principal_cents`. The
    /// last payment takes less than the standing amount, or none of it.
    pub extra_principal_cents: i64,
    /// Owed before this payment, and after it.
    pub opening_cents: i64,
    pub closing_cents: i64,
}

/// A category in Money's two-level tree (migration 0014).
///
/// `kind` is load-bearing: every category picker filters on it, and a
/// subcategory always shares its parent's kind. `full_name` is the display
/// idiom Money uses everywhere — "Auto : Fuel" — and is computed in SQL so the
/// frontend never has to join the tree back together itself.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Category {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    /// "income" | "expense".
    pub kind: String,
    /// Tax form line this category rolls up to, e.g. "Schedule A: Charity".
    pub tax_line: Option<String>,
    /// "Parent : Child" for a subcategory, the bare name for a top-level one.
    pub full_name: String,
    /// Transaction + split lines currently filed under this category. Drives
    /// the "this will orphan N transactions" warning on delete.
    pub usage_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transaction {
    pub id: String,
    pub account_id: String,
    pub date: String,
    pub payee: String,
    pub category_id: Option<String>,
    pub amount_cents: i64,
    pub is_reconciled: bool,
    pub notes: Option<String>,
}

fn default_true() -> bool {
    true
}

/// A register row: a transaction plus the account balance *after* it,
// ---------------------------------------------------------------------------
// Reports — one request shape, one result shape, for the whole gallery
// ---------------------------------------------------------------------------

/// What the frontend asks for: which report, over which dates, scoped how.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ReportRequest {
    pub kind: String,
    /// Inclusive, `YYYY-MM-DD`.
    pub from: String,
    pub to: String,
    /// `None` / empty = every account.
    #[serde(default)]
    pub account_ids: Option<Vec<String>>,
    /// `None` / empty = every category. A parent selects its children.
    #[serde(default)]
    pub category_ids: Option<Vec<String>>,
    /// Comparison reports only: the other range. Defaults to the same
    /// length of time immediately before `from`.
    #[serde(default)]
    pub compare_from: Option<String>,
    #[serde(default)]
    pub compare_to: Option<String>,
    /// Net worth / balances: Money's "Level of detail" — `accounts` (every
    /// account), `types` (account types, the default) or `sides` (just
    /// assets and liabilities).
    #[serde(default)]
    pub detail: Option<String>,
    /// Investment reports only: `None` / empty = every security.
    #[serde(default)]
    pub security_ids: Option<Vec<String>>,
    /// Count only accounts with `tax_included`. The two tax reports
    /// always do; the Taxes tab asks it of capital gains and investment
    /// income too.
    #[serde(default)]
    pub tax_scope: Option<bool>,
    // --- The scope every report honors, not just the ones that
    // happened to support it. All optional; absent = no filter. ---
    /// `None` / empty = every payee. Ids from `payees`.
    #[serde(default)]
    pub payee_ids: Option<Vec<String>>,
    /// Turn `category_ids` into a leave-OUT list.
    #[serde(default)]
    pub exclude_categories: Option<bool>,
    /// Turn `payee_ids` into a leave-OUT list.
    #[serde(default)]
    pub exclude_payees: Option<bool>,
    /// Only lines whose absolute amount is at least / at most this.
    #[serde(default)]
    pub min_cents: Option<i64>,
    #[serde(default)]
    pub max_cents: Option<i64>,
    /// Only rows in these cleared states: any of `""` (open), `"C"`, `"R"`.
    /// `None` / empty = every state.
    #[serde(default)]
    pub cleared: Option<Vec<String>>,
    /// Only lines whose payee or memo contains this (case-insensitive).
    #[serde(default)]
    pub text: Option<String>,
    /// Only lines carrying these classification values. A parent value
    /// selects its sub-values; `none:<classification id>` selects lines with
    /// NO value on that axis. Values on different axes AND together, values
    /// on the same axis OR — "Maple, either person" is one pick per axis.
    #[serde(default)]
    pub class_value_ids: Option<Vec<String>>,
    /// Which axis a by-classification report groups on. Absent = the
    /// first one.
    #[serde(default)]
    pub classification_id: Option<String>,
    /// The security a performance report measures against.
    #[serde(default)]
    pub benchmark_security_id: Option<String>,
}

/// A column: `kind` is `text` | `money` | `percent` (basis points) |
/// `count` | `date`. The first column is always the row label.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportColumn {
    pub label: String,
    pub kind: String,
}

/// One cell: text, or an integer (cents, basis points, or a count — the
/// column says which). Never both, never a float.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportCell {
    pub text: Option<String>,
    pub cents: Option<i64>,
}

/// One row. `cells` has one entry per column AFTER the label column.
/// `style` is `normal` | `header` | `subtotal` | `total`; `level` indents
/// (0 = top, 1 = subcategory / transaction under its group). `key` +
/// `key_kind` (`category` | `payee` | `account` | `transaction` | `month` |
/// `recurrence` | `investment`) let the viewer drill through.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportLine {
    pub key: Option<String>,
    pub key_kind: Option<String>,
    pub label: String,
    pub level: u8,
    pub style: String,
    pub cells: Vec<ReportCell>,
}

/// A series for the chart view: `(label, cents)` points.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportSeries {
    pub label: String,
    pub points: Vec<(String, i64)>,
}

/// `kind` is `bar` | `pie` | `line`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportChart {
    pub kind: String,
    pub series: Vec<ReportSeries>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Report {
    pub kind: String,
    pub title: String,
    /// Money's date-range line: `1/1/2025 through 12/31/2025`.
    pub subtitle: String,
    pub columns: Vec<ReportColumn>,
    pub rows: Vec<ReportLine>,
    pub chart: Option<ReportChart>,
}

/// A saved, named report — Money's "Add to my favorite reports" after
/// Customize: the kind plus the scope and range it was customized with, so
/// "Spending by category — Jordan" is exactly the accounts they use.
/// Stored as JSON in `app_settings` under `reports.saved`, inside the
/// encrypted file, so it travels with a backup.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SavedReport {
    pub id: String,
    pub name: String,
    pub kind: String,
    /// A range id from the viewer's list (`this_month`…) or `custom`.
    pub range_id: String,
    pub from: String,
    pub to: String,
    #[serde(default)]
    pub account_ids: Vec<String>,
    #[serde(default)]
    pub category_ids: Vec<String>,
    #[serde(default)]
    pub compare_from: Option<String>,
    #[serde(default)]
    pub compare_to: Option<String>,
    #[serde(default)]
    pub detail: Option<String>,
    /// The viewer's presentation choices (sort, combine-under, chart kind,
    /// securities) — stored as the viewer sends them.
    #[serde(default)]
    pub options: Option<serde_json::Value>,
    // --- The rest of the scope, so a favorite report is the whole
    // customization and not just its date range and accounts. Every field
    // defaults, so a report saved before this still loads. ---
    #[serde(default)]
    pub payee_ids: Vec<String>,
    #[serde(default)]
    pub exclude_categories: bool,
    #[serde(default)]
    pub exclude_payees: bool,
    #[serde(default)]
    pub min_cents: Option<i64>,
    #[serde(default)]
    pub max_cents: Option<i64>,
    #[serde(default)]
    pub cleared: Vec<String>,
    #[serde(default)]
    pub text: Option<String>,
    /// Chosen classification values (`none:<axis>` for "no value").
    #[serde(default)]
    pub class_value_ids: Vec<String>,
    /// The axis a by-classification report groups on.
    #[serde(default)]
    pub classification_id: Option<String>,
    /// The benchmark a performance report is measured against.
    #[serde(default)]
    pub benchmark_security_id: Option<String>,
}

/// One entry of the report gallery.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportGalleryEntry {
    pub group: String,
    pub kind: String,
    pub label: String,
}

/// One hit from the header's Search box: enough to show a
/// result line and to open the row in its register.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
    pub id: String,
    pub account_id: String,
    pub account_name: String,
    pub date: String,
    pub payee: String,
    pub category_name: Option<String>,
    pub amount_cents: i64,
    pub check_number: Option<String>,
    pub notes: Option<String>,
    pub is_void: bool,
}

/// computed with a SQL window function. This is what the MS Money-style
/// register displays in its Balance column.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterRow {
    pub id: String,
    pub date: String,
    pub payee: String,
    pub category_name: Option<String>,
    /// The category's id, so re-opening a transaction can preselect it. Without
    /// this the edit form could only ever show "(none)" — and, worse, saving
    /// an edit wrote that "(none)" back, silently wiping the category.
    pub category_id: Option<String>,
    /// The OTHER account's id for a transfer. Same reason as `category_id`:
    /// the edit form cannot preselect "Transfer : <Account>" from a name.
    pub transfer_account_id: Option<String>,
    pub amount_cents: i64,
    pub running_balance_cents: i64,
    /// Derived from `cleared_state == "R"`. The stored `is_reconciled` column
    /// is vestigial after migration 0011 — never read it directly.
    pub is_reconciled: bool,
    /// "" | "C" | "R" — Money's three-state C column.
    pub cleared_state: String,
    pub check_number: Option<String>,
    /// Voided: kept in the register, excluded from every balance.
    pub is_void: bool,
    pub notes: Option<String>,
    /// For a transfer, the OTHER account's name. Money displays this in the
    /// category column as "Transfer : <Account>". None for ordinary rows.
    pub transfer_account_name: Option<String>,
    // --- investment rows (migration 0022); all None for a cash row ---
    pub activity: Option<String>,
    pub security_id: Option<String>,
    pub security_name: Option<String>,
    pub shares_micro: Option<i64>,
    pub price_micro: Option<i64>,
    pub gross_cents: Option<i64>,
    pub commission_cents: i64,
    /// A sale that named its lots (`lot_allocations`), rather than FIFO.
    pub lot_specified: bool,
    /// The savings goal this row counts toward.
    pub goal_id: Option<String>,
    /// Per-transaction tax line: None = the category's, Some("") =
    /// not tax-related, Some(line) = that line.
    #[serde(default)]
    pub tax_line: Option<String>,
    pub goal_name: Option<String>,
    /// The transaction's own classification values, one per axis.
    #[serde(default)]
    pub classes: Vec<ClassPick>,
    /// What the SPLIT LINES say, on the axes the transaction itself
    /// says nothing about — the one value they agree on, or "N values" with
    /// an empty `value_id` when they differ. A mortgage split three ways and
    /// tagged line by line showed nothing at all on its row before this.
    #[serde(default)]
    pub line_classes: Vec<ClassPick>,
    /// The account a buy was paid from / a sell deposited to, through its
    /// funding pair. None for everything else.
    #[serde(default)]
    pub funding_account_id: Option<String>,
    /// This row is a revaluation — what the thing was appraised at on
    /// its date, not money that moved. The register marks these so an
    /// asset account reads as a history of values rather than as a checking
    /// account whose "deposits" nobody can explain.
    #[serde(default)]
    pub is_revaluation: bool,
    /// This row is half of an exchange WITHIN its account — a TSP
    /// reallocation's Shares Out or Shares In, linked to a row in the same
    /// account rather than to another account. The register says "Exchange"
    /// rather than "Transfer Shares", because nothing left the plan.
    #[serde(default)]
    pub is_exchange: bool,
    /// How many files are attached to this row, for the 📎 in the
    /// register.
    #[serde(default)]
    pub attachment_count: i64,
    /// Written by a split line in another account — its amount,
    /// date and category are the line's, so the form shows them read-only.
    #[serde(default)]
    pub is_split_transfer: bool,
    /// The account of the payment whose line wrote this row; None when
    /// the row is not a far row, or no line points at it any more.
    #[serde(default)]
    pub split_payment_account_name: Option<String>,
    /// For a transfer, the OTHER row's amount, in that account's
    /// currency — what an edit across two currencies starts from.
    #[serde(default)]
    pub transfer_amount_cents: Option<i64>,
}

/// A file attached to a transaction or an account: what it is, not
/// its bytes. The bytes come through `attachment_bytes` when they are
/// opened or saved, never with a list.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Attachment {
    pub id: String,
    pub transaction_id: Option<String>,
    pub account_id: Option<String>,
    pub name: String,
    pub mime: String,
    pub size_bytes: i64,
    pub added_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewTransaction {
    pub account_id: String,
    pub date: String,
    pub payee: String,
    pub category_id: Option<String>,
    pub amount_cents: i64,
    pub notes: Option<String>,
    /// Money's Num column. Optional so an older payload still deserializes.
    #[serde(default)]
    pub check_number: Option<String>,
    /// The split lines, written in the SAME undo step as the row.
    /// Absent (or empty) means no split; an older payload still deserializes.
    #[serde(default)]
    pub splits: Option<Vec<NewSplit>>,
}

/// Payload for editing an existing transaction. All fields are present so the
/// update is a full replace; the account balance is adjusted by the delta.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateTransaction {
    pub id: String,
    pub date: String,
    pub payee: String,
    pub category_id: Option<String>,
    pub amount_cents: i64,
    pub notes: Option<String>,
    #[serde(default)]
    pub check_number: Option<String>,
    /// The split lines, replaced in the SAME undo step as the edit:
    /// None = leave them alone, Some(empty) = clear them, Some(rows) = these.
    #[serde(default)]
    pub splits: Option<Vec<NewSplit>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Budget {
    pub id: String,
    /// Migration 0014 re-keyed budgets from the category NAME to its id, so a
    /// rename no longer orphans the budget. `category_name` is still returned
    /// (resolved by join) because that is what the UI displays.
    pub category_id: String,
    pub category_name: String,
    pub target_cents: i64,
    pub month_year: String,
}

/// Money's Autobudget: one proposed line per expense category.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AutobudgetLine {
    pub category_id: String,
    pub category_name: String,
    /// Average monthly spending over the months looked at that had any.
    pub average_cents: i64,
    /// How many of those months had spending in this category.
    pub months_with_spending: u32,
    /// Monthly equivalent of the active scheduled bills in this category.
    pub scheduled_cents: i64,
    /// The proposal: the larger of the two, rounded up to the dollar.
    pub suggested_cents: i64,
    /// What the month already budgets, if anything.
    pub current_cents: Option<i64>,
}

/// One row of the Budget screen.
///
/// The screen shows every expense category, budgeted or not, so that setting
/// a budget is typing a number into a row you can already see rather than
/// hunting the category in a dropdown at the bottom of the page.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BudgetLine {
    pub category_id: String,
    /// The leaf name — "Fuel". The screen indents under the parent rather
    /// than repeating it on every row.
    pub name: String,
    /// "Automobile : Fuel", for anything that needs the row named on its own.
    pub full_name: String,
    pub parent_id: Option<String>,
    /// The amount AS TYPED, in the line's own period. A yearly line keeps the
    /// $100 its owner thinks in rather than the $8.33 nobody recognizes.
    pub target_cents: i64,
    /// "monthly" or "yearly". How to read `target_cents`.
    pub period: String,
    /// `target_cents` as a monthly figure: itself, or a twelfth. This
    /// is what the envelope arithmetic and the screen's totals use, because
    /// those are monthly questions.
    pub monthly_cents: i64,
    /// A budget of zero is a decision ("spend nothing here"); no budget at all
    /// is not. The screen has to tell them apart, so the flag is separate from
    /// the amount.
    pub has_budget: bool,
    /// Spending booked directly to this category.
    pub own_cents: i64,
    /// Spending from EVERY child, whether or not the child carries a
    /// budget of its own. A parent is the envelope for the whole category;
    /// a child's own amount is an allocation inside it, not an escape from it.
    pub rolled_cents: i64,
    /// What this line's children have allocated between them. The
    /// parent's amount is kept strictly above it (`next_ten_above`), so a
    /// category always covers what its parts claim.
    pub children_budgeted_cents: i64,
    /// Whether this line's target belongs in the screen's totals.
    ///
    /// A budgeted child sitting under a budgeted parent does NOT: its amount
    /// is already inside the parent's envelope, and adding both is how a
    /// household gets reported as budgeting twice what it did. Each branch is
    /// counted once, at its top.
    pub counts_in_total: bool,
    /// What the target is measured against, **over the line's own
    /// period**: this month for a monthly line, this calendar year for a
    /// yearly one. A $100 registration paid in March is not March overspending
    /// by $91.67; it is the year's budget, spent.
    pub spent_cents: i64,
    /// Always this MONTH's spending, whatever the period. The screen's totals
    /// are a monthly view and need a monthly number from every row.
    pub spent_month_cents: i64,
    /// `target_cents - spent_cents`, so it reads in the line's own period.
    pub remaining_cents: i64,
}

/// The whole screen in one answer, totals included.
///
/// The totals are computed HERE rather than summed in the frontend, because
/// the carve-out makes summing them wrong in a way that looks right: add the
/// parent's spend to its children's and a household that budgets both levels
/// is reported as spending twice what it did. Only budgeted lines count, and
/// each budget row counts once.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BudgetGrid {
    pub month: String,
    pub lines: Vec<BudgetLine>,
    pub budgeted_cents: i64,
    pub spent_cents: i64,
    pub remaining_cents: i64,
    /// How many lines carry a budget — "12 of 84 categories budgeted".
    pub budgeted_lines: u32,
    pub total_lines: u32,
}

/// One row of the YEAR plan: what you decided once, and the twelve
/// months of what actually happened against it.
///
/// The plan is `annual_cents` plus `months`, and NOTHING else on this struct
/// is authored — `monthly_cents` is derived, the twelve `actual_cents` are
/// read out of the register, and `expected_to_date` is arithmetic. That is
/// the whole point of the screen: two numbers a year, everything else
/// computed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanLine {
    pub category_id: String,
    pub name: String,
    /// "Parent : Child" for a subcategory, as everywhere else.
    pub full_name: String,
    pub parent_id: Option<String>,
    /// "income" or "expense" — which block of the grid this belongs in.
    pub kind: String,
    pub has_plan: bool,
    pub annual_cents: i64,
    /// `annual_cents` divided by how many months are SET, not by twelve. A
    /// line that runs five months of the year is not a twelfth of anything.
    pub monthly_cents: i64,
    /// Twelve characters, January first, '1' where the line applies.
    pub months: String,
    /// "every month", "Nov–Mar", "Jan, Apr, Jul, Oct" — built here so the
    /// screen and any report say it the same way.
    pub months_label: String,
    /// How to read `months`: "spent" (the months it runs in, which
    /// is what divides the annual figure) or "aside" (the months it is DUE,
    /// with the annual figure divided by twelve because the monthly number is
    /// what you set aside).
    pub spread: String,
    /// What ONE payment of an "aside" line is: $1,200 due each
    /// January is one payment of $1,200; due in Jan and Jul, two of $600.
    /// Zero for a "spent" line, where `monthly_cents` already IS the payment.
    pub payment_cents: i64,
    /// Twelve figures from the register: index 0 is January. A month that has
    /// not happened yet is still 0 — `months_elapsed` on the grid says how
    /// many of them mean anything.
    pub actual_cents: Vec<i64>,
    /// This line's own transactions, and its children's, for the elapsed part
    /// of the year.
    pub actual_to_date: i64,
    /// What the plan says should have happened by now: the monthly figure
    /// times the number of SET months that have elapsed.
    pub expected_to_date: i64,
    /// Income: actual minus expected — over is good. Expense: expected minus
    /// actual — under is good. Positive is the good direction either way, so
    /// one color rule serves both blocks.
    pub variance_cents: i64,
    /// A budgeted child inside a budgeted parent is already in the parent's
    /// envelope and must not be added to the totals again.
    pub counts_in_total: bool,
}

/// A totals line: income, expenses, or the net between them.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanTotals {
    pub annual_cents: i64,
    pub monthly_cents: i64,
    /// Twelve months of actuals, summed over the lines that count.
    pub actual_cents: Vec<i64>,
    pub actual_to_date: i64,
    pub expected_to_date: i64,
    pub variance_cents: i64,
}

/// The whole year in one answer: both blocks, their totals, and net.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YearPlan {
    pub year: i32,
    /// How many of the twelve columns are real. 12 for a year that is over,
    /// 0 for one that has not started, the current month for this year.
    pub months_elapsed: u32,
    pub income: Vec<PlanLine>,
    pub expenses: Vec<PlanLine>,
    pub income_total: PlanTotals,
    pub expense_total: PlanTotals,
    /// Income minus expenses, month by month — the line the user's spreadsheet ends
    /// on.
    pub net: PlanTotals,
    pub planned_lines: u32,
}

/// One line of "build next year from what this year did".
///
/// The proposal is a READING of a year, not a decision: nothing is written
/// until the user accepts it. `basis` says which arithmetic was used and
/// `note` says why, because a figure a person did not compute themselves has
/// to explain itself before they will trust it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanProposal {
    pub category_id: String,
    pub name: String,
    pub full_name: String,
    pub parent_id: Option<String>,
    pub kind: String,
    /// What actually went through this line in the year being read.
    pub actual_cents: i64,
    /// How many months of that year saw any money at all.
    pub active_months: u32,
    pub first_month: u32,
    pub last_month: u32,
    /// "twelve" — the year's total over the months observed, the ordinary
    /// case. "running" — a line that STARTED mid-year, annualized from the
    /// months it actually ran, because a twelfth of four months of pay
    /// proposes a third of what the job really pays. "ended" — a line that
    /// ran most of the year and then stopped; the figure is the ordinary one
    /// but `include` is false, because proposing a smaller version of a job
    /// that no longer exists is worse than proposing nothing.
    pub basis: String,
    pub note: String,
    /// What the twelfth would have been, so a "running" row can show the
    /// difference rather than assert a number.
    pub plain_monthly_cents: i64,
    pub suggested_monthly_cents: i64,
    pub suggested_annual_cents: i64,
    /// The spread it would be written with — carried from the source year's
    /// plan when there is one, so a seasonal line stays seasonal.
    pub months: String,
    pub months_label: String,
    /// How `months` reads: "spent" or "aside", carried from the
    /// source year's plan with the mask, "spent" when there was none. The
    /// monthly and annual figures above are already worked out in it.
    pub spread: String,
    /// Whether this row starts ticked.
    pub include: bool,
    /// What this line is planned at in the target year already, if anything —
    /// so accepting a proposal over the top of a figure is a visible act.
    pub existing_annual_cents: Option<i64>,
}

/// One accepted proposal on its way back in. Deliberately not the
/// whole `PlanProposal`: what gets written is the category, the figure and
/// the spread, and sending the rest back would invite the two sides to
/// disagree about which of them was authoritative.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanPick {
    pub category_id: String,
    pub annual_cents: i64,
    pub months: String,
    /// "spent" or "aside". Absent means "spent": Build from history
    /// reads what a year DID, and what a year did is spending.
    #[serde(default)]
    pub spread: Option<String>,
}

/// What one plan write did: the row, and the parent it moved.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanWrite {
    pub line: PlanLine,
    pub raised: Option<RaisedParent>,
}

/// A parent raised to cover its children, so the screen can say so.
/// Nothing changes a figure the user typed without telling them.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RaisedParent {
    pub category_id: String,
    pub category_name: String,
    pub target_cents: i64,
    /// True when the parent had no budget and this write gave it one;
    /// false when an existing amount was pushed up. The screen says different
    /// words for the two: a number appearing where there was none needs more
    /// explaining than one that moved.
    pub created: bool,
}

/// What one budget write did: the row, and the parent it pushed up.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BudgetWrite {
    pub budget: Budget,
    pub raised: Option<RaisedParent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CategoryBudget {
    pub category_id: String,
    /// Display name — "Parent : Child" for a subcategory.
    pub category_name: String,
    pub target_cents: i64,
    pub spent_cents: i64,
    pub remaining_cents: i64,
    pub month_year: String,
}

/// One line of a brokerage / 401(k) statement: what the statement
/// says is held. Give shares, or a value (with a price, or at the price
/// already known); `update_holdings` works out the change.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatementHolding {
    pub security_id: String,
    pub shares_micro: Option<i64>,
    pub price_micro: Option<i64>,
    pub value_cents: Option<i64>,
}

/// What `update_holdings` wrote (or, dry run, would write) for one line.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HoldingChange {
    pub security_id: String,
    pub security_name: String,
    pub symbol: String,
    pub held_micro: i64,
    pub statement_micro: i64,
    /// statement − held: an Add Shares row when positive, Remove Shares when negative.
    pub delta_micro: i64,
    pub price_micro: i64,
    /// Basis of the added shares (delta x price), or the value removed.
    pub gross_cents: i64,
    /// The row written; None on a dry run or when nothing changed.
    pub transaction_id: Option<String>,
    /// Why nothing could be done for this line, if so.
    pub problem: Option<String>,
}

/// A payee rename rule.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PayeeRule {
    pub id: String,
    pub match_text: String,
    pub payee_name: String,
    pub category_id: Option<String>,
    pub category_name: Option<String>,
    pub created_at: String,
    /// The conditions beyond the payee text. All optional; None is
    /// "any", so a rule from before these conditions existed means what it meant.
    /// Absolute amount at least this (cents).
    #[serde(default)]
    pub min_cents: Option<i64>,
    /// Absolute amount at most this (cents).
    #[serde(default)]
    pub max_cents: Option<i64>,
    /// The memo contains this, case-insensitively.
    #[serde(default)]
    pub memo_contains: Option<String>,
    /// Only rows in this account.
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub account_name: Option<String>,
}

/// What a rule looks at besides the payee text, when it is made.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RuleConditions {
    #[serde(default)]
    pub min_cents: Option<i64>,
    #[serde(default)]
    pub max_cents: Option<i64>,
    #[serde(default)]
    pub memo_contains: Option<String>,
    #[serde(default)]
    pub account_id: Option<String>,
}

impl RuleConditions {
    /// How many of the four are set — a rule with more conditions is more
    /// specific, and wins over one with fewer when both match.
    pub fn count(&self) -> usize {
        self.min_cents.is_some() as usize
            + self.max_cents.is_some() as usize
            + self.memo_contains.as_deref().map_or(false, |m| !m.trim().is_empty()) as usize
            + self.account_id.as_deref().map_or(false, |a| !a.trim().is_empty()) as usize
    }
}

/// One row a payee rule would change, for the preview.
///
/// Both halves of every change are carried — what it says now and what it
/// would say — because a preview that shows only the destination asks the
/// user to remember what they are agreeing to lose.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PayeeRuleChange {
    pub transaction_id: String,
    pub account_name: String,
    /// The account's currency, which `amount_cents` is in.
    #[serde(default = "default_home")]
    pub currency: String,
    pub date: String,
    pub amount_cents: i64,
    pub payee: String,
    pub new_payee: String,
    pub category_name: Option<String>,
    pub new_category_name: Option<String>,
    /// Set only when the rule is FILLING IN an empty category; never an
    /// overwrite of one the user chose.
    pub new_category_id: Option<String>,
    /// Which rule matched, and on what text — so a surprising row can be
    /// traced back to the rule that claimed it.
    pub rule_id: String,
    pub match_text: String,
}

/// A set of rows that look like the same transaction entered twice.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DuplicateGroup {
    pub date: String,
    pub payee: String,
    pub amount_cents: i64,
    /// The register rows, oldest entered first; each carries its own id,
    /// cleared state, notes, category and FITID so the user can pick.
    pub rows: Vec<DuplicateRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DuplicateRow {
    pub id: String,
    pub date: String,
    pub cleared_state: String,
    pub category_name: Option<String>,
    pub notes: Option<String>,
    pub fitid: Option<String>,
    pub check_number: Option<String>,
    pub is_transfer: bool,
}

/// One account whose stored balance disagrees with its rows.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BalanceDrift {
    pub account_id: String,
    pub account_name: String,
    pub stored_cents: i64,
    pub computed_cents: i64,
}

/// What "Verify this file" found. Everything is reported; `repaired`
/// says what was put right when asked to.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct FileCheck {
    /// `PRAGMA integrity_check` lines other than "ok" (empty = sound).
    pub integrity: Vec<String>,
    /// `PRAGMA foreign_key_check` violations, as "table: rowid → parent".
    pub foreign_keys: Vec<String>,
    /// Accounts whose `balance_cents` is not the sum of their non-void rows.
    pub drift: Vec<BalanceDrift>,
    /// Transfer halves whose partner row is gone: "date payee amount (account)".
    pub half_transfers: Vec<String>,
    /// Split transactions whose lines do not add up to the row's amount.
    pub split_mismatch: Vec<String>,
    /// Split transfer lines whose row in the other account is missing,
    /// orphaned, or disagrees with the line (amount, date, account, void).
    #[serde(default)]
    pub split_transfers: Vec<String>,
    pub accounts: u32,
    pub transactions: u32,
    /// What was fixed: balances recomputed, half transfers unlinked.
    pub repaired: Vec<String>,
}

/// What `merge_accounts` did, or (dry run) would do.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct MergeSummary {
    /// Rows moved from the duplicate into the surviving account.
    pub moved: u32,
    /// Rows of the duplicate left behind because the survivor already has
    /// the same one (date, amount, payee, and the investment fields).
    pub duplicates: u32,
    /// Rows left behind because they fell on or before the survivor's last
    /// date (only with `after_last`), or were the duplicate's own opening
    /// balance.
    pub left_behind: u32,
    /// Transfers between the two accounts: both sides deleted, since money
    /// moved from an account to itself.
    pub self_transfers: u32,
    pub statements: u32,
    pub recurrences: u32,
    pub goals: u32,
    /// The survivor's balance after the merge.
    pub balance_cents: i64,
    /// What the merge decided that the counts cannot say: loan terms
    /// kept from the survivor when both had them, scheduled transfers between
    /// the two removed. Plain sentences, for the dialog to list.
    #[serde(default)]
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportSummary {
    pub account_id: String,
    pub account_name: String,
    pub imported: u32,
    pub skipped: u32,
    /// Rows skipped because an identical transaction (same account, date,
    /// amount, payee) already exists in the account.
    pub duplicates: u32,
    pub balance_delta_cents: i64,
    /// Investment rows written: buys, sells, income, reinvestments…
    #[serde(default)]
    pub investments: u32,
    /// Securities the file named that the app had not seen before.
    #[serde(default)]
    pub securities_created: u32,
    /// QIF `[Account]` rows written or matched as linked transfers.
    #[serde(default)]
    pub transfers_linked: u32,
    /// Rows the user paired with a transaction already in the register.
    /// Those were marked cleared rather than written again, so they move no
    /// balance.
    #[serde(default)]
    pub matched: u32,
    /// Rows the user chose to leave out in the review dialog.
    #[serde(default)]
    pub user_skipped: u32,
    /// What was left out and why. Shown to the user verbatim.
    #[serde(default)]
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyStatus {
    pub has_key: bool,
    pub db_path: String,
    /// A keyring is running to keep the key. False on a Linux system with
    /// none, where a typed key lasts only until T-Money closes.
    pub keyring: bool,
}

// ---------------------------------------------------------------------------
// Goals (Planning tab)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Goal {
    pub id: String,
    pub name: String,
    pub target_cents: i64,
    /// Progress: `starting_cents` plus every tagged row in the linked
    /// account. For an unlinked goal it is simply the typed amount.
    pub saved_cents: i64,
    pub deadline: Option<String>,
    pub notes: Option<String>,
    pub updated_at: String,
    /// The account this goal watches, if any.
    pub account_id: Option<String>,
    pub account_name: Option<String>,
    /// The typed amount (what `saved_cents` used to be).
    pub starting_cents: i64,
    /// Sum of the rows tagged with this goal; zero when unlinked.
    pub linked_cents: i64,
    pub linked_count: i64,
}

// ---------------------------------------------------------------------------
// Payments / bills to pay (Bills tab)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Payment {
    pub id: String,
    pub payee: String,
    pub amount_cents: i64,
    pub due_date: String,
    pub status: String, // 'due' | 'paid' | 'skipped'
    pub notes: Option<String>,
    pub updated_at: String,
}

// ---------------------------------------------------------------------------
// Investments (Investing tab)
// ---------------------------------------------------------------------------

/// Something you can hold: a fund, a stock, a bond (migration 0022).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Security {
    pub id: String,
    pub name: String,
    pub symbol: String,
    /// stock | mutual_fund | etf | bond | cd | money_market | other
    pub kind: String,
    pub notes: Option<String>,
    pub updated_at: String,
    /// Latest price on file, dollars x 1,000,000. `None` = no price yet.
    pub last_price_micro: Option<i64>,
    /// The date of that price.
    pub price_date: Option<String>,
    /// fetched | manual | transaction — where the latest price came from.
    pub price_source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecurityPrice {
    pub security_id: String,
    pub date: String,
    pub price_micro: i64,
    pub source: String,
}

/// An investment transaction as the entry form sends it. The cash effect
/// (`amount_cents`) is NOT here — the backend derives it from the activity,
/// so a buy can never be entered as a deposit (`db/queries/investments.rs`
/// `investment_cash_effect`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewInvestmentTransaction {
    pub account_id: String,
    pub date: String,
    pub activity: String,
    pub security_id: String,
    /// Shares moved (x 1,000,000). For a split: the new-per-old ratio x 1,000,000.
    pub shares_micro: i64,
    /// Dollars x 1,000,000; `None` = derive from gross / shares.
    pub price_micro: Option<i64>,
    /// Value of the shares before commission; a dividend's amount; an Add
    /// Shares row's cost basis. Zero for a split.
    pub gross_cents: i64,
    #[serde(default)]
    pub commission_cents: i64,
    /// Income category for dividends/interest/distributions (and their
    /// reinvested forms). Ignored for buys, sells and share moves.
    pub category_id: Option<String>,
    pub notes: Option<String>,
    /// Buys and sells only: a bank account the money comes from / goes to.
    /// Creates the paired transfer row in one go (Money's "Transfer from").
    pub funding_account_id: Option<String>,
    /// Sells and Remove Shares only: which lots, when not FIFO.
    #[serde(default)]
    pub lot_allocations: Vec<LotAllocation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LotAllocation {
    /// The id of the transaction that opened the lot.
    pub lot_id: String,
    pub shares_micro: i64,
}

/// An open (or partly open) lot, as of a date. Derived by replaying the
/// account's investment rows — see `db/lots.rs`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Lot {
    /// The transaction that opened it.
    pub id: String,
    pub account_id: String,
    pub security_id: String,
    pub acquired_on: String,
    /// Remaining shares (x 1,000,000), after splits and partial sales.
    pub shares_micro: i64,
    /// Remaining cost basis for those shares.
    pub cost_cents: i64,
    pub original_shares_micro: i64,
    pub original_cost_cents: i64,
}

/// One lot's part of one sale: the realized gain lives here.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Disposal {
    pub sell_id: String,
    pub lot_id: String,
    pub account_id: String,
    pub security_id: String,
    pub acquired_on: String,
    pub sold_on: String,
    pub shares_micro: i64,
    pub proceeds_cents: i64,
    pub cost_cents: i64,
    pub gain_cents: i64,
    /// Held more than one year.
    pub long_term: bool,
    /// False for Remove Shares: the lot closed but nothing was realized.
    pub realized: bool,
}

/// A holding: one security in one account, as of a date.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    pub account_id: String,
    pub account_name: String,
    /// How this position's value was rounded: the account's own
    /// choice, else the file's. The lot rows on screen round the same way.
    #[serde(default = "default_rounding")]
    pub rounding: String,
    pub security_id: String,
    pub security_name: String,
    pub symbol: String,
    pub security_kind: String,
    pub shares_micro: i64,
    pub cost_cents: i64,
    /// Latest price on or before the as-of date. `None` = never priced; the
    /// value then falls back to cost so nothing is silently worth zero.
    pub price_micro: Option<i64>,
    pub price_date: Option<String>,
    pub value_cents: i64,
    pub gain_cents: i64,
    pub lots: Vec<Lot>,
}

/// The Portfolio page in one call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Portfolio {
    pub as_of: String,
    pub positions: Vec<Position>,
    pub total_cost_cents: i64,
    pub total_value_cents: i64,
    /// Cash sitting in investment accounts (their register balances).
    pub cash_cents: i64,
    /// Rows the replay could not make sense of (a sale of more shares than
    /// were held). Shown, never hidden.
    pub problems: Vec<String>,
    /// How values were rounded to the cent: "nearest" | "down", so the
    /// lot rows on screen round the same way.
    #[serde(default = "default_rounding")]
    pub rounding: String,
}

fn default_rounding() -> String {
    "nearest".to_string()
}

/// Money's dated return on investment: one row per period.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RoiPeriod {
    pub label: String,
    pub from: String,
    pub to: String,
    /// Holdings value at the start of the period (after `from`'s rows).
    pub start_value_cents: i64,
    pub end_value_cents: i64,
    /// Change in unrealized gain over the period — price movement on what
    /// was held, with money added or removed taken out.
    pub unrealized_change_cents: i64,
    pub realized_cents: i64,
    pub income_cents: i64,
    /// unrealized change + realized + income.
    pub return_cents: i64,
    /// return / start value, in basis points; None when nothing was held at the start.
    pub return_bps: Option<i64>,
}

/// One period of the Investing tab's performance table: the value at
/// each end, what crossed the account's edge between, and the two returns.
/// Every money field is cents; every return is basis points (10000 = 100%).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Performance {
    pub label: String,
    pub from: String,
    pub to: String,
    /// Holdings plus cash at the close of `from`.
    pub start_value_cents: i64,
    pub end_value_cents: i64,
    /// Money that came in from outside during the period.
    pub flows_in_cents: i64,
    /// Money that left to outside, as a positive amount.
    pub flows_out_cents: i64,
    /// end − start − (in − out): what the investments earned, in dollars.
    pub gain_cents: i64,
    /// Time-weighted return over the whole period; None when nothing was
    /// held long enough to measure.
    pub twr_bps: Option<i64>,
    /// The same, as a yearly rate; None for a period under a month.
    pub twr_annual_bps: Option<i64>,
    /// Money-weighted (internal) rate of return, yearly; None for a period
    /// under a month or one no rate in range explains.
    pub mwr_annual_bps: Option<i64>,
    /// How many days money crossed the edge, for the footnote.
    pub flow_days: usize,
}

/// The outcome of one "Refresh prices" run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PriceRefreshSummary {
    pub updated: u32,
    /// Holdings with no symbol to look up.
    pub skipped: u32,
    /// Symbol → why it could not be priced. Shown to the user verbatim.
    pub failures: Vec<PriceFailure>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PriceFailure {
    pub symbol: String,
    pub reason: String,
}

/// How old the prices are. The app fetches only when told to (see
/// `prices.rs`), so the honest thing to show beside a portfolio value is the
/// date it was priced on, not a number that looks live.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PriceStatus {
    /// Securities that carry a symbol, so a fetch could price them.
    pub with_symbol: i64,
    /// The newest stored price date, across every security.
    pub newest_date: Option<String>,
    /// The OLDEST of each priced security's newest price — how stale the
    /// worst-served holding is, which is the number that matters.
    pub oldest_date: Option<String>,
    /// Securities with a symbol and no price at all.
    pub never_priced: i64,
    /// When an automatic refresh last ran (RFC3339, local), if ever.
    pub last_auto: Option<String>,
    /// "off" | "daily" | "weekly" — what the user asked for.
    pub interval: String,
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Backup / restore
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbInfo {
    pub db_path: String,
    pub size_bytes: u64,
    pub has_key: bool,
    /// The scratch data directory the app is running against, if any.
    /// `None` means the real database.
    pub scratch_dir: Option<String>,
}

// ---------------------------------------------------------------------------
// Splits — one transaction itemized across several categories
// ---------------------------------------------------------------------------

/// A single line of a split transaction. `description` is per-line and is NOT
/// the parent transaction's `notes` (Money's Memo) — the split grid has its own
/// Description column.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Split {
    pub id: String,
    pub transaction_id: String,
    pub category_id: Option<String>,
    pub description: Option<String>,
    pub amount_cents: i64,
    pub sort_order: i64,
    /// This line moves money to another account rather than to a
    /// category — the principal part of a mortgage payment, the escrow part.
    #[serde(default)]
    pub transfer_account_id: Option<String>,
    #[serde(default)]
    pub transfer_account_name: Option<String>,
    /// The values this line carries on its own (not inherited).
    #[serde(default)]
    pub classes: Vec<ClassPick>,
}

/// An incoming split line. Order in the slice becomes `sort_order`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewSplit {
    pub category_id: Option<String>,
    pub description: Option<String>,
    pub amount_cents: i64,
    /// Set instead of `category_id` to make this line a transfer.
    #[serde(default)]
    pub transfer_account_id: Option<String>,
    /// This line's own classification values, one per axis at most.
    /// Empty = the line inherits the transaction's. Sent back on `Split`
    /// resolved, so re-opening a split shows what each line carries.
    #[serde(default)]
    pub classes: Vec<ClassPick>,
}

// ---------------------------------------------------------------------------
// Classifications (migration 0035)
// ---------------------------------------------------------------------------

/// One tagging axis: "Property", "Person", "Project". Its values come with
/// it, so one call fills every picker.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Classification {
    pub id: String,
    pub name: String,
    pub sort_order: i64,
    /// Transaction and split lines carrying any value of this axis.
    pub usage_count: i64,
    pub values: Vec<ClassificationValue>,
}

/// One value of an axis, one level of sub-value deep.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClassificationValue {
    pub id: String,
    pub classification_id: String,
    pub parent_id: Option<String>,
    pub name: String,
    /// "Parent : Child" for a sub-value, the bare name otherwise.
    pub full_name: String,
    /// Lines carrying this value (a parent counts its children's too).
    pub usage_count: i64,
}

/// A row's value on one axis — what the register shows and the edit form
/// seeds. `value_id` empty in a write = clear that axis.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ClassPick {
    pub classification_id: String,
    pub value_id: String,
    /// The value's `full_name`, filled on the way out; ignored on the way in.
    #[serde(default)]
    pub label: String,
}

// ---------------------------------------------------------------------------
// Payees (migration 0011)
// ---------------------------------------------------------------------------

/// A piece of text and how often it has been used: a split line's
/// description, offered as completion the way payees are.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsedText {
    pub name: String,
    pub usage_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Payee {
    pub id: String,
    pub name: String,
    /// The category this payee was last filed under — Money offers it on
    /// re-entry.
    pub last_category_id: Option<String>,
    /// Resolved name of `last_category_id`, so the payee list can show the
    /// default category without a second round-trip.
    pub last_category_name: Option<String>,
    /// Transactions currently pointing at this payee. A merge shows it, and a
    /// delete refuses when it is non-zero.
    pub usage_count: i64,
    pub updated_at: String,
    /// The amount of this payee's most recent non-void transaction, offered on
    /// re-entry the way `last_category_id` is. Derived in SQL, never
    /// stored — see `PAYEE_SELECT`.
    pub last_amount_cents: Option<i64>,
}

// ---------------------------------------------------------------------------
// Statements — reconcile (migration 0012)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Statement {
    pub id: String,
    pub account_id: String,
    pub statement_date: String,
    pub starting_balance_cents: i64,
    pub ending_balance_cents: i64,
    /// "in_progress" (Postpone leaves it here) | "completed".
    pub status: String,
    pub reconciled_on: Option<String>,
    pub service_charge_cents: Option<i64>,
    pub service_charge_category_id: Option<String>,
    pub interest_cents: Option<i64>,
    pub interest_category_id: Option<String>,
    pub adjustment_cents: Option<i64>,
    pub adjustment_category_id: Option<String>,
}

/// What a demo-data seed run produced, for the UI to report.
///
/// Declared here rather than in `db::demo` because that module is
/// `#[cfg(debug_assertions)]` — the command's *signature* has to exist in a
/// release build (it stays registered and returns an error there), while the
/// seeding data and logic do not.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeedSummary {
    pub accounts: u32,
    pub transactions: u32,
    pub transfers: u32,
    pub splits: u32,
    pub budgets: u32,
    pub statements: u32,
    /// Names of the accounts created, so the UI can say where to look.
    pub account_names: Vec<String>,
}

// ---------------------------------------------------------------------------
// Common Transactions (migration 0018)
// ---------------------------------------------------------------------------

/// A named entry-form template — Money's "Common Transactions".
///
/// Not a transaction: no account, no date, no cleared state. Those belong to
/// the moment you enter it, not to the pattern.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommonTransaction {
    pub id: String,
    pub name: String,
    pub payee: String,
    pub category_id: Option<String>,
    /// Resolved "Parent : Child" name, so the menu can show it without a
    /// second round-trip.
    pub category_name: Option<String>,
    /// `None` = "no fixed amount": a real case ("Kroger, Groceries, whatever it
    /// came to"), and forcing a number would make the user clear one each time.
    pub amount_cents: Option<i64>,
    pub check_number: Option<String>,
    pub notes: Option<String>,
    /// How many times it has been used, so the menu can lead with the ones
    /// that earn their place.
    pub usage_count: i64,
    pub updated_at: String,
    /// Split lines, in order. Empty for an unsplit template.
    pub splits: Vec<NewSplit>,
}

/// A template about to be created. `splits` may be empty.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewCommonTransaction {
    pub name: String,
    pub payee: String,
    pub category_id: Option<String>,
    pub amount_cents: Option<i64>,
    pub check_number: Option<String>,
    pub notes: Option<String>,
    #[serde(default)]
    pub splits: Vec<NewSplit>,
}

// ---------------------------------------------------------------------------
// Scheduled bills and income (migration 0019)
// ---------------------------------------------------------------------------

/// A recurrence rule. Occurrences are computed from it, never stored.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Recurrence {
    pub id: String,
    pub payee: String,
    /// Negative for a bill, positive for income — the transaction convention.
    pub amount_cents: i64,
    pub account_id: Option<String>,
    pub account_name: Option<String>,
    pub category_id: Option<String>,
    pub category_name: Option<String>,
    pub freq: String,
    pub interval_n: i64,
    pub start_date: String,
    pub end_date: Option<String>,
    pub second_day: Option<i64>,
    pub weekend_rule: String,
    pub notes: Option<String>,
    pub is_active: bool,
    pub updated_at: String,
    /// A scheduled transfer: the account the money lands in.
    #[serde(default)]
    pub transfer_account_id: Option<String>,
    #[serde(default)]
    pub transfer_account_name: Option<String>,
    /// The savings goal the receiving half is tagged for.
    #[serde(default)]
    pub goal_id: Option<String>,
    #[serde(default)]
    pub goal_name: Option<String>,
}

/// One computed instance of a rule, resolved against what actually happened.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Occurrence {
    pub recurrence_id: String,
    pub payee: String,
    pub amount_cents: i64,
    pub account_id: Option<String>,
    pub account_name: Option<String>,
    pub category_id: Option<String>,
    pub category_name: Option<String>,
    /// The date the rule generated, after any weekend shift.
    pub due_date: String,
    /// "due" | "overdue" | "paid" | "skipped" | "matched".
    ///
    /// `paid` and `skipped` are explicit user actions. `matched` means a real
    /// transaction in the register satisfies it — so a bill paid by hand stops
    /// nagging, and the forecast never counts it twice.
    pub status: String,
    /// The transaction behind a `paid` or `matched` occurrence.
    pub transaction_id: Option<String>,
    /// What actually left the account, when it is known — a variable bill
    /// rarely matches its rule's amount.
    pub actual_amount_cents: Option<i64>,
    /// A scheduled transfer's receiving account.
    #[serde(default)]
    pub transfer_account_id: Option<String>,
    #[serde(default)]
    pub transfer_account_name: Option<String>,
}

/// One day on the projected balance line.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForecastPoint {
    pub date: String,
    /// Everything expected to move that day.
    pub delta_cents: i64,
    /// The projected balance at the end of that day.
    pub balance_cents: i64,
}

/// A cash-flow projection for one account.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CashForecast {
    pub account_id: String,
    pub account_name: String,
    /// The balance as of `from` — today's real balance, with any
    /// future-dated register rows taken back out so they are not counted
    /// twice when the walk re-applies them.
    pub starting_balance_cents: i64,
    pub points: Vec<ForecastPoint>,
    /// The whole point of a forecast: the worst it gets, and when.
    pub low_balance_cents: i64,
    pub low_date: String,
    pub ending_balance_cents: i64,
    /// Occurrences that fall in the window and are still expected to happen.
    pub upcoming: Vec<Occurrence>,
    /// Recurring charges the detector found in this account and the
    /// forecast projected, with the dates it put them on. Empty when the
    /// caller asked for scheduled items only.
    #[serde(default)]
    pub detected: Vec<DetectedCharge>,
    /// Payees the detector found on a schedule but left to their
    /// scheduled bills in this account (the bill projects them).
    pub covered_by_bills: Vec<String>,
}

/// One recurring charge the subscription detector found in the
/// account being projected: what it costs, how often, and the days inside
/// the window the forecast expects it on.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedCharge {
    pub payee: String,
    /// Negative: money leaving the account each time.
    pub amount_cents: i64,
    /// "month", "2 weeks", "year" — the detector's word for it.
    pub cadence: String,
    /// The last time it was charged.
    pub last: String,
    /// How many charges the detector saw.
    pub charges: usize,
    /// The days in the window it is projected on, in order.
    pub dates: Vec<String>,
    /// The amount differs charge to charge (a utility); what is
    /// projected is the median of the last three.
    pub varies: bool,
    /// On the Home card's ignore list; projected all the same.
    pub ignored_on_home: bool,
}

/// Payload for creating or updating a rule.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewRecurrence {
    pub payee: String,
    pub amount_cents: i64,
    pub account_id: Option<String>,
    pub category_id: Option<String>,
    pub freq: String,
    pub interval_n: i64,
    pub start_date: String,
    pub end_date: Option<String>,
    pub second_day: Option<i64>,
    pub weekend_rule: String,
    pub notes: Option<String>,
    /// The receiving account of a scheduled transfer; amount must be negative.
    #[serde(default)]
    pub transfer_account_id: Option<String>,
    /// Tag the receiving half for this goal (must watch the receiving account).
    #[serde(default)]
    pub goal_id: Option<String>,
}

/// How automatic backups are configured.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupConfig {
    pub enabled: bool,
    /// Also take one when the app closes, or a file is closed. Its own
    /// switch: "once a day when I start" and "whenever I leave" are different
    /// habits, and the second should not require the first.
    pub on_exit: bool,
    pub folder: Option<String>,
    /// How many of our own backups to keep. Never fewer than one.
    pub keep: u32,
    /// When the last automatic backup ran, RFC-3339.
    pub last_at: Option<String>,
    /// Backups already sitting in the folder, newest first.
    pub existing: Vec<String>,
}

/// Cents as a dollars string for error messages: `-1234567` → `-$12,345.67`.
///
/// Integer arithmetic only. This exists so a refusal can name the amount it
/// is refusing over without any caller reaching for `f64`.
pub fn format_cents(cents: i64) -> String {
    // In the open file's home currency and region; "$1,234.56" outside one.
    crate::region::money(cents)
}

/// `format_cents` for an amount in an account kept in `currency`: behind
/// that currency's symbol, so a euro amount never reads as dollars.
pub fn format_cents_in(cents: i64, currency: &str) -> String {
    crate::region::money_of(cents, currency)
}

#[cfg(test)]
mod format_tests {
    use super::{format_cents, format_cents_in};

    #[test]
    fn an_amount_in_another_currency_carries_its_symbol() {
        assert_eq!(format_cents_in(-123_456, "EUR"), "-€1,234.56");
        assert_eq!(format_cents_in(500, "CAD"), "CA$5.00");
        assert_eq!(format_cents_in(500, "USD"), "$5.00");
    }

    #[test]
    fn cents_format_as_grouped_dollars() {
        assert_eq!(format_cents(0), "$0.00");
        assert_eq!(format_cents(5), "$0.05");
        assert_eq!(format_cents(-1234567), "-$12,345.67");
        assert_eq!(format_cents(100000), "$1,000.00");
        assert_eq!(format_cents(99999), "$999.99");
    }
}
