// TypeScript mirrors of the Rust models (src-tauri/src/models.rs).
// Money is always integer cents (number) — never floats.

/** Money's account taxonomy. Kept in sync with the CHECK constraint in
 *  migration 0009. "Bill payment service provider" is deliberately excluded. */
export type ClearedState = "" | "C" | "R";

export type AccountType =
  | "bank"
  | "checking"
  | "savings"
  | "credit"
  | "line_of_credit"
  | "employee_stock_option"
  | "investment"
  | "retirement"
  | "watch"
  | "asset"
  | "vehicle"
  | "cash"
  | "home"
  | "home_equity_line_of_credit"
  | "liability"
  | "loan"
  | "mortgage"
  | "other";

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  /** The register balance — for an investment account, its cash. */
  balance_cents: number;
  /** Market value of holdings at the latest prices; zero unless investment
   *  or retirement. Worth = balance + holdings. */
  holdings_value_cents: number;
  /** Counted in tax reports and the Taxes tab. Off by default for
   *  retirement accounts, whose dividends and sales are not taxable events. */
  tax_included: boolean;
  /** "nearest" | "down", or null to follow the file's setting. */
  value_rounding?: HoldingRounding | null;
  /** For a debt, the asset it is borrowed against. */
  secured_by_account_id?: string | null;
  /** Where this account sits in every list of accounts; null = never placed. */
  sort_order?: number | null;
  is_favorite: boolean;
  is_closed: boolean;
  updated_at: string;
  // --- institution + contact details (migration 0010) ---
  institution: string | null;
  /** Sensitive. Encrypted at rest, but mask it in the UI and never print it in
   *  full in an export or report. */
  account_number: string | null;
  /** Sensitive — see `account_number`. */
  routing_number: string | null;
  opened_on: string | null;
  credit_limit_cents: number | null;
  contact_phone: string | null;
  contact_email: string | null;
  website: string | null;
  address: string | null;
  account_notes: string | null;
  /** The currency the account is kept in (ISO code). Its amounts are
   *  hundredths of THIS currency; totals across accounts are in dollars.
   *  The backend always sends it; absent (as in a test's hand-built account)
   *  reads as dollars — see `lib/currency.ts`. */
  currency?: string;
  /** Dollars per unit of `currency` today, in millionths: 1,000,000 for
   *  dollars, 0 when the currency has no rate. Absent reads as dollars. */
  home_rate_micro?: number;
}

/** A currency an account can be kept in. */
export interface Currency {
  code: string;
  name: string;
  /** The symbol that cannot be mistaken for another: "US$", "CA$", "€". */
  symbol: string;
  /** The symbol used at home: "$" for the Canadian dollar in Canada. */
  local_symbol?: string;
  decimals: number;
}

/** The open file's home currency (ISO code) and region (a `REGIONS` tag). */
export interface FileFormat {
  home_currency: string;
  region: string;
}

/** Home-currency units per one unit of `currency`, in millionths, from
 *  `date` on. */
export interface ExchangeRate {
  currency: string;
  date: string;
  rate_micro: number;
  source: "manual" | "fetched";
}

/** Asset id to what is owed against it, positive. Named rather than
 *  written inline as Record<string, number>: ipc.test's coverage check reads
 *  the wrappers with a regex that cannot see through a nested generic, so a
 *  command declared that way reads as an unwrapped one. */
export type AssetDebts = Record<string, number>;

/** A loan's terms. Everything is a starting point for the arithmetic;
 *  the bank's numbers win when a payment is recorded. */
export interface LoanTerms {
  account_id: string;
  /** Annual rate in millionths: 5.875% is 5_875_000. */
  apr_micro: number;
  /** The regular payment, principal and interest only. */
  payment_cents: number;
  escrow_cents: number;
  /** Principal paid ahead on top of the scheduled payment, every month,
   *  by choice. Proposed on every payment and applied by the schedule. */
  extra_principal_cents: number;
  escrow_account_id: string | null;
  escrow_category_id: string | null;
  interest_category_id: string | null;
  from_account_id: string | null;
  payment_day: number | null;
  first_payment_date: string | null;
  term_months: number | null;
  notes: string | null;
}

/** One row of an amortization schedule. Balances are what is owed,
 *  positive. */
export interface LoanPeriod {
  date: string;
  payment_cents: number;
  interest_cents: number;
  principal_cents: number;
  escrow_cents: number;
  /** Principal ahead of schedule, on top of `principal_cents`. */
  extra_principal_cents: number;
  opening_cents: number;
  closing_cents: number;
}

/** The editable half of an account — everything except the derived balance. */
export interface AccountDetails {
  id: string;
  name: string;
  account_type: AccountType;
  is_closed: boolean;
  institution: string | null;
  account_number: string | null;
  routing_number: string | null;
  opened_on: string | null;
  credit_limit_cents: number | null;
  contact_phone: string | null;
  contact_email: string | null;
  website: string | null;
  address: string | null;
  account_notes: string | null;
}

/** Money's category tree is two levels deep: a category and its
 *  subcategories (migration 0014). `kind` filters every picker;
 *  `full_name` is Money's display idiom, "Auto : Fuel". */
export type CategoryKind = "income" | "expense";

export interface Category {
  id: string;
  name: string;
  parent_id: string | null;
  kind: CategoryKind;
  /** Tax form line this category rolls up to — the seed for Taxes. */
  tax_line: string | null;
  /** "Parent : Child" for a subcategory, the bare name for a top-level one. */
  full_name: string;
  /** Transaction + split lines filed under this category. */
  usage_count: number;
}

export interface Transaction {
  id: string;
  account_id: string;
  date: string;
  payee: string;
  category_id: string | null;
  amount_cents: number;
  is_reconciled: boolean;
  notes: string | null;
}

export interface NewTransaction {
  account_id: string;
  date: string;
  payee: string;
  category_id: string | null;
  amount_cents: number;
  notes: string | null;
  /** Money's Num column — a check number, or a marker like ATM / EFT / DEP.
   *  Free text. Blank is stored as NULL, not "". */
  check_number: string | null;
  /** The split lines, written in the same undo step as the row. */
  splits?: NewSplit[];
}

export interface UpdateTransaction {
  id: string;
  date: string;
  payee: string;
  category_id: string | null;
  amount_cents: number;
  notes: string | null;
  check_number: string | null;
  /** The split lines, replaced in the same undo step as the edit:
   *  absent = leave them alone, [] = clear them, rows = these. */
  splits?: NewSplit[];
}

/** A register row: a transaction plus the account balance *after* it
 *  (running_balance_cents), computed in SQL. This is what the MS Money-style
 *  register displays in its Balance column. */
// ── Reports ────────────────────────────────────────────────────────
export interface ReportRequest {
  kind: string;
  /** Inclusive, YYYY-MM-DD. */
  from: string;
  to: string;
  account_ids?: string[] | null;
  category_ids?: string[] | null;
  compare_from?: string | null;
  compare_to?: string | null;
  /** Net worth: "accounts" | "types" | "sides" (Money's Level of detail). */
  detail?: string | null;
  /** Investment reports: which securities. null = all. */
  security_ids?: string[] | null;
  /** Leave out accounts with tax_included = 0, as the Taxes tab does.
   *  Tax-related transactions and Tax summary always do. */
  tax_scope?: boolean;
  // --- The scope every report honors. All optional; absent = no
  // filter, which is what every existing caller sends. ---
  payee_ids?: string[] | null;
  /** Turn `category_ids` / `payee_ids` into leave-OUT lists. */
  exclude_categories?: boolean | null;
  exclude_payees?: boolean | null;
  /** Absolute amounts, in cents. */
  min_cents?: number | null;
  max_cents?: number | null;
  /** Any of "" (open), "C", "R"; empty = every state. */
  cleared?: string[] | null;
  /** Payee or memo contains this, case-insensitively. */
  text?: string | null;
  /** Values a line must carry. `none:<axis id>` = nothing on that axis.
   *  Values on different axes AND; values on one axis OR. */
  class_value_ids?: string[] | null;
  /** The axis a by-classification report groups on. */
  classification_id?: string | null;
  /** The security a benchmark report measures against. */
  benchmark_security_id?: string | null;
}
export type ReportColumnKind = "text" | "money" | "percent" | "count" | "date" | "number";
export interface ReportColumn {
  label: string;
  kind: ReportColumnKind;
}
/** Text, or an integer (cents, basis points, or a count — the column says). */
export interface ReportCell {
  text: string | null;
  cents: number | null;
}
/** header = section band with a rule; group = bold parent name, no
 *  amounts; bold = childless parent with amounts; subtotal = blue "Total X";
 *  total = bold with a rule above. */
export type ReportLineStyle = "normal" | "header" | "group" | "bold" | "subtotal" | "total";
export interface ReportLine {
  key: string | null;
  key_kind: "category" | "payee" | "account" | "transaction" | "month" | "recurrence" | "investment" | "class_value" | "security" | null;
  label: string;
  level: number;
  style: ReportLineStyle;
  /** One per column after the label column. */
  cells: ReportCell[];
}
export interface ReportSeries {
  label: string;
  points: [string, number][];
}
export interface ReportChart {
  kind: "bar" | "pie" | "line";
  series: ReportSeries[];
}
export interface Report {
  kind: string;
  title: string;
  subtitle: string;
  columns: ReportColumn[];
  rows: ReportLine[];
  chart: ReportChart | null;
}
/** A saved, named report — the kind plus the scope it was customized with.
 * Lives in the encrypted file. */
export interface SavedReport {
  id: string;
  name: string;
  kind: string;
  range_id: string;
  from: string;
  to: string;
  account_ids: string[];
  category_ids: string[];
  compare_from: string | null;
  compare_to: string | null;
  detail?: string | null;
  /** Customize's Rows / Chart / Securities choices; shape in reportShape.ts. */
  options?: Record<string, unknown> | null;
  // The rest of the scope travels with a favorite report.
  // Every field defaults in Rust, so a report saved before this still loads.
  payee_ids?: string[];
  exclude_categories?: boolean;
  exclude_payees?: boolean;
  min_cents?: number | null;
  max_cents?: number | null;
  cleared?: string[];
  text?: string | null;
  class_value_ids?: string[];
  classification_id?: string | null;
  benchmark_security_id?: string | null;
}
export interface ReportGalleryEntry {
  group: string;
  kind: string;
  label: string;
}

/** One hit from the header's Search box. */
export interface SearchHit {
  id: string;
  account_id: string;
  account_name: string;
  date: string;
  payee: string;
  category_name: string | null;
  amount_cents: number;
  check_number: string | null;
  notes: string | null;
  is_void: boolean;
}

/** A file attached to a transaction or an account: what it is, not
 *  its bytes. */
export interface Attachment {
  id: string;
  transaction_id: string | null;
  account_id: string | null;
  name: string;
  mime: string;
  size_bytes: number;
  added_at: string;
}

export interface RegisterRow {
  id: string;
  date: string;
  payee: string;
  category_name: string | null;
  /** The category's id, so the edit form can preselect it. */
  category_id: string | null;
  /** For a transfer, the OTHER account's id — needed to preselect it. */
  transfer_account_id: string | null;
  amount_cents: number;
  running_balance_cents: number;
  /** Derived from `cleared_state === "R"`. */
  is_reconciled: boolean;
  /** "" | "C" | "R" — Money's three-state C column. */
  cleared_state: ClearedState;
  check_number: string | null;
  /** Voided: still in the register, excluded from every balance. */
  is_void: boolean;
  notes: string | null;
  /** For a transfer, the OTHER account's name — rendered as
   *  "Transfer : <Account>", the way Money shows it. */
  transfer_account_name: string | null;
  // --- investment rows; all null for a cash row ---
  activity: InvestmentActivity | null;
  security_id: string | null;
  security_name: string | null;
  shares_micro: number | null;
  price_micro: number | null;
  gross_cents: number | null;
  commission_cents: number;
  /** A sale that named its lots rather than taking the oldest first. */
  lot_specified: boolean;
  /** The savings goal this row counts toward. */
  goal_id: string | null;
  goal_name: string | null;
  /** Per-transaction tax line: null = the category's; "" = not
   *  tax-related; a line = on that line whatever the category says. */
  tax_line?: string | null;
  /** The account a buy was paid from / a sell deposited to. */
  funding_account_id?: string | null;
  /** A revaluation — what the thing was appraised at on its date,
   *  not money that moved. */
  is_revaluation?: boolean;
  /** Half of an exchange within this account — a TSP reallocation's
   *  Shares Out or Shares In, linked to a row in the same account. Shown as
   *  "Exchange", not "Transfer Shares": nothing left the plan. */
  is_exchange?: boolean;
  /** How many files are attached, for the 📎. */
  attachment_count?: number;
  /** This row was written by a split line in another account —
   *  a loan's principal row. Its amount, date and category are the line's,
   *  so the edit form shows them read-only. */
  is_split_transfer?: boolean;
  /** The account holding the payment whose line wrote this row, for
   *  the form to name ("belong to the payment in Demo Checking"). Null when
   *  no line points at it any more. */
  split_payment_account_name?: string | null;
  /** The transaction's own classification values, one per axis. */
  classes?: ClassPick[];
  /** What the SPLIT LINES say, on the axes the transaction itself is
   *  silent about — the value they agree on, or "N values" with an empty
   *  `value_id` when they differ. */
  line_classes?: ClassPick[];
  /** For a transfer, the OTHER row's amount, in that account's currency —
   *  what an edit across two currencies starts from. */
  transfer_amount_cents?: number | null;
}

export interface Budget {
  id: string;
  /** Budgets are keyed by category id since 0014 — a rename no longer
   *  orphans them. `category_name` is the resolved display name. */
  category_id: string;
  category_name: string;
  target_cents: number;
  month_year: string;
}

/** Money's Autobudget: one proposal per expense category. */
export interface AutobudgetLine {
  category_id: string;
  category_name: string;
  average_cents: number;
  months_with_spending: number;
  scheduled_cents: number;
  suggested_cents: number;
  current_cents: number | null;
}

/** One row of the Budget screen. Every expense category is a row,
 *  budgeted or not, so setting a budget is typing into a row you can see. */
export interface BudgetLine {
  category_id: string;
  /** The leaf name — "Fuel". Children are indented under the parent. */
  name: string;
  /** "Automobile : Fuel". */
  full_name: string;
  parent_id: string | null;
  /** The amount AS TYPED, in the line's own period. */
  target_cents: number;
  /** How to read `target_cents`. */
  period: "monthly" | "yearly";
  /** `target_cents` as a monthly figure: itself, or a twelfth. What
   *  the envelope arithmetic and the screen's totals use. */
  monthly_cents: number;
  /** A budget of zero is a decision; no budget is not. Kept apart from the
   *  amount so the screen can tell them apart. */
  has_budget: boolean;
  /** Spending booked directly to this category. */
  own_cents: number;
  /** Spending from EVERY child, budgeted or not. A parent is the
   *  envelope for the whole category. */
  rolled_cents: number;
  /** What this line's children have allocated between them. */
  children_budgeted_cents: number;
  /** Whether this line's target belongs in the screen's totals. A
   *  budgeted child under a budgeted parent does not: it is already inside
   *  that envelope. Each branch counts once, at its top. */
  counts_in_total: boolean;
  /** Measured over the line's OWN period: this month for a monthly
   *  line, this calendar year for a yearly one. */
  spent_cents: number;
  /** Always this month's spending, whatever the period — the totals strip is
   *  a monthly view and needs a monthly number from every row. */
  spent_month_cents: number;
  /** `target_cents - spent_cents`, in the line's own period. */
  remaining_cents: number;
}

/** The Budget screen in one answer. Totals come from Rust: the
 *  parent/child carve-out makes summing them here wrong in a way that looks
 *  right. */
export interface BudgetGrid {
  month: string;
  lines: BudgetLine[];
  budgeted_cents: number;
  spent_cents: number;
  remaining_cents: number;
  budgeted_lines: number;
  total_lines: number;
}

/** One row of the year plan. `annual_cents` and `months` are the only
 *  authored values; everything else is derived from them and the register. */
/** The two readings of a plan's months mask. */
export type PlanSpread = "spent" | "aside";

export interface PlanLine {
  category_id: string;
  name: string;
  full_name: string;
  parent_id: string | null;
  kind: "income" | "expense";
  has_plan: boolean;
  annual_cents: number;
  /** What this costs a month: the annual figure over the months it actually
   *  runs (spread "spent"), or over twelve (spread "aside", where it is what
   *  you set ASIDE each month rather than what you spend). */
  monthly_cents: number;
  /** Twelve characters, January first, '1' where the line applies. */
  months: string;
  months_label: string;
  /** How to read `months`. "spent": the months it runs in, and what
   *  divides the annual figure. "aside": the months it is DUE, with the
   *  annual figure divided by twelve because you save for it all year. */
  spread: PlanSpread;
  /** What ONE payment of an "aside" line is. Zero when "spent",
   *  where `monthly_cents` already is the payment. */
  payment_cents: number;
  /** Twelve figures, index 0 is January. */
  actual_cents: number[];
  actual_to_date: number;
  expected_to_date: number;
  /** Positive is the good direction in both blocks — income above plan,
   *  expense below it — so one color rule serves the whole grid. */
  variance_cents: number;
  counts_in_total: boolean;
}

export interface PlanTotals {
  annual_cents: number;
  monthly_cents: number;
  actual_cents: number[];
  actual_to_date: number;
  expected_to_date: number;
  variance_cents: number;
}

/** The year: both blocks, their totals, and the net between them. */
export interface YearPlan {
  year: number;
  /** How many of the twelve columns mean anything yet. */
  months_elapsed: number;
  income: PlanLine[];
  expenses: PlanLine[];
  income_total: PlanTotals;
  expense_total: PlanTotals;
  net: PlanTotals;
  planned_lines: number;
}

/** One line of "build next year from what this year did". A reading
 *  of a year, not a decision: nothing is written until it comes back ticked. */
export interface PlanProposal {
  category_id: string;
  name: string;
  full_name: string;
  parent_id: string | null;
  kind: "income" | "expense";
  actual_cents: number;
  active_months: number;
  first_month: number;
  last_month: number;
  /** "twelve" — the ordinary case. "running" — started mid-year, annualized
   *  from the months it ran. "ended" — ran and then stopped; not ticked. */
  basis: "twelve" | "running" | "ended";
  note: string;
  plain_monthly_cents: number;
  suggested_monthly_cents: number;
  suggested_annual_cents: number;
  months: string;
  months_label: string;
  /** How `months` reads, carried from the source year's plan with the
   *  mask; "spent" when there was none. */
  spread: PlanSpread;
  include: boolean;
  existing_annual_cents: number | null;
}

/** One accepted proposal on its way back. */
export interface PlanPick {
  category_id: string;
  annual_cents: number;
  months: string;
  /** Absent means "spent" — Build from history reads what a year DID. */
  spread?: PlanSpread;
}

/** What one plan write did. */
export interface PlanWrite {
  line: PlanLine;
  raised: RaisedParent | null;
}

/** A parent pushed up to cover its children, so the screen can say so. */
export interface RaisedParent {
  category_id: string;
  category_name: string;
  target_cents: number;
  /** The parent had no budget and this write gave it one. */
  created: boolean;
}

/** What one budget write did. */
export interface BudgetWrite {
  budget: Budget;
  raised: RaisedParent | null;
}

export interface CategoryBudget {
  category_id: string;
  category_name: string;
  target_cents: number;
  spent_cents: number;
  remaining_cents: number;
  month_year: string;
}

/** Money's dated return on investment. */
/** One period of the performance table. Money in cents, returns in
 *  basis points (10000 = 100%). */
export interface Performance {
  label: string;
  from: string;
  to: string;
  /** Holdings plus cash at the close of `from`. */
  start_value_cents: number;
  end_value_cents: number;
  flows_in_cents: number;
  flows_out_cents: number;
  /** end − start − (in − out). */
  gain_cents: number;
  twr_bps: number | null;
  twr_annual_bps: number | null;
  mwr_annual_bps: number | null;
  flow_days: number;
}

export interface RoiPeriod {
  label: string;
  from: string;
  to: string;
  start_value_cents: number;
  end_value_cents: number;
  unrealized_change_cents: number;
  realized_cents: number;
  income_cents: number;
  return_cents: number;
  return_bps: number | null;
}

/** One line of a statement for `updateHoldings`: shares, or a value
 *  (with a price, or at the price already known). */
export interface StatementHolding {
  security_id: string;
  shares_micro: number | null;
  price_micro: number | null;
  value_cents: number | null;
}

export interface HoldingChange {
  security_id: string;
  security_name: string;
  symbol: string;
  held_micro: number;
  statement_micro: number;
  delta_micro: number;
  price_micro: number;
  gross_cents: number;
  transaction_id: string | null;
  problem: string | null;
}

/** What merging one account into another did, or would do. */
export interface MergeSummary {
  moved: number;
  duplicates: number;
  left_behind: number;
  self_transfers: number;
  statements: number;
  recurrences: number;
  goals: number;
  balance_cents: number;
  /** What the merge decided that the counts cannot say (loan terms
   *  kept from the survivor, scheduled transfers between the two removed). */
  notes?: string[];
}

export interface ImportSummary {
  account_id: string;
  account_name: string;
  imported: number;
  skipped: number;
  duplicates: number;
  balance_delta_cents: number;
  /** Investment rows written from a brokerage statement. */
  investments: number;
  securities_created: number;
  /** QIF [Account] rows written or matched as linked transfers. */
  transfers_linked?: number;
  /** Rows paired with a transaction already in the register: marked
   *  cleared rather than written again, so they move no balance. */
  matched?: number;
  /** Rows the user left out in the review dialog. */
  user_skipped?: number;
  /** What was left out and why. */
  notes: string[];
}

/** A transaction already in the register, offered as a match. */
export interface MatchExistingRow {
  id: string;
  date: string;
  payee: string;
  amount_cents: number;
  category_name: string | null;
  notes: string | null;
  check_number: string | null;
  cleared_state: string;
  has_fitid: boolean;
  is_transfer: boolean;
}
export interface MatchCandidate {
  existing: MatchExistingRow;
  /** 0 to 1. At or above 0.70 the dialog ticks it by default. */
  score: number;
  /** Negative when the register row is earlier than the file's row. */
  day_gap: number;
  why: string;
}
export interface IncomingRow {
  /** Position in the parsed file — the key a decision comes back under. */
  index: number;
  date: string;
  payee: string;
  amount_cents: number;
  check_number: string | null;
  candidates: MatchCandidate[];
  likely: boolean;
}
/** A new row the file did not categorize and no payee rule caught. */
export interface UncategorizedRow {
  index: number;
  date: string;
  payee: string;
  amount_cents: number;
}
export interface ImportMatchPreview {
  account_id: string;
  account_name: string;
  total_rows: number;
  duplicates: number;
  unreadable: number;
  new_rows: number;
  rows: IncomingRow[];
  /** A subset of `new_rows`: the ones with nothing to file them under. */
  uncategorized: UncategorizedRow[];
  window_days: number;
  /** The distinct memos on a plan statement's investment rows. */
  memo_groups: MemoGroup[];
}

/** What a plan statement's memo means. */
export type Treatment = "as_is" | "contribution" | "reinvest" | "fee" | "withdrawal";
export interface MemoGroup {
  memo: string;
  /** The file's own word: Buy, ShrsOut, Sell. */
  action: string;
  activity: string;
  count: number;
  gross_cents: number;
  shares_micro: number;
  guess: Treatment;
  allowed: Treatment[];
  default_category: string | null;
}
export interface MemoRule {
  memo: string;
  activity: string;
  treatment: Treatment;
  /** A category path ("Parent : Child"); null takes the treatment's default. */
  category?: string | null;
}
/** `action` is "new", "skip" or "match"; a match carries the register row. */
export interface RowDecision {
  index: number;
  action: "new" | "skip" | "match";
  existingId?: string | null;
  /** A category chosen in the review for a row that had none. */
  categoryId?: string | null;
}

export interface KeyStatus {
  has_key: boolean;
  db_path: string;
  /** A keyring is running to keep the key. False on a Linux system with
   *  none, where a typed key lasts only until T-Money closes. */
  keyring: boolean;
}

export interface Goal {
  id: string;
  name: string;
  target_cents: number;
  /** Progress: starting amount plus every row tagged for the goal in its
   *  linked account. For an unlinked goal, just the typed amount. */
  saved_cents: number;
  deadline: string | null;
  notes: string | null;
  updated_at: string;
  account_id: string | null;
  account_name: string | null;
  starting_cents: number;
  linked_cents: number;
  linked_count: number;
}

export interface Payment {
  id: string;
  payee: string;
  amount_cents: number;
  due_date: string;
  status: string; // 'due' | 'paid' | 'skipped'
  notes: string | null;
  updated_at: string;
}

export interface PriceFailure {
  symbol: string;
  reason: string;
}

/** The outcome of one "Refresh prices" run. */
export interface PriceRefreshSummary {
  updated: number;
  /** Holdings with no symbol to look up. */
  skipped: number;
  failures: PriceFailure[];
}

/** How old the stored prices are, and what the timer is set to. */
export interface PriceStatus {
  with_symbol: number;
  newest_date: string | null;
  /** The oldest of each priced security's newest price — the worst case. */
  oldest_date: string | null;
  never_priced: number;
  last_auto: string | null;
  interval: PriceInterval;
}

export type PriceInterval = "off" | "daily" | "weekly";

/** Something you can hold. Prices are dollars x 1,000,000. */
export interface Security {
  id: string;
  name: string;
  symbol: string;
  kind: SecurityKind;
  notes: string | null;
  updated_at: string;
  last_price_micro: number | null;
  price_date: string | null;
  price_source: "fetched" | "manual" | "transaction" | null;
}

export type SecurityKind = "stock" | "mutual_fund" | "etf" | "bond" | "cd" | "money_market" | "other";

export interface SecurityPrice {
  security_id: string;
  date: string;
  price_micro: number;
  source: "fetched" | "manual" | "transaction";
}

export type InvestmentActivity =
  | "buy"
  | "sell"
  | "dividend"
  | "interest"
  | "ltcg_dist"
  | "stcg_dist"
  | "reinvest_dividend"
  | "reinvest_interest"
  | "reinvest_ltcg"
  | "reinvest_stcg"
  | "add_shares"
  | "remove_shares"
  | "return_of_capital"
  | "split";

export interface LotAllocation {
  lot_id: string;
  shares_micro: number;
}

/** What the entry form sends. The cash effect is the backend's to derive. */
export interface NewInvestmentTransaction {
  account_id: string;
  date: string;
  activity: InvestmentActivity;
  security_id: string;
  /** Shares x 1,000,000; for a split, the new-per-old ratio x 1,000,000. */
  shares_micro: number;
  price_micro: number | null;
  /** Value of the shares before commission; a dividend's amount; an Add
   *  Shares row's cost basis. Zero for a split. */
  gross_cents: number;
  commission_cents: number;
  category_id: string | null;
  notes: string | null;
  funding_account_id: string | null;
  lot_allocations: LotAllocation[];
}

export interface Lot {
  id: string;
  account_id: string;
  security_id: string;
  acquired_on: string;
  shares_micro: number;
  cost_cents: number;
  original_shares_micro: number;
  original_cost_cents: number;
}

export interface Disposal {
  sell_id: string;
  lot_id: string;
  account_id: string;
  security_id: string;
  acquired_on: string;
  sold_on: string;
  shares_micro: number;
  proceeds_cents: number;
  cost_cents: number;
  gain_cents: number;
  long_term: boolean;
  realized: boolean;
}

export interface Position {
  account_id: string;
  account_name: string;
  /** How this position was rounded to the cent. */
  rounding?: HoldingRounding;
  security_id: string;
  security_name: string;
  symbol: string;
  security_kind: SecurityKind;
  shares_micro: number;
  cost_cents: number;
  price_micro: number | null;
  price_date: string | null;
  value_cents: number;
  gain_cents: number;
  lots: Lot[];
}

export interface Portfolio {
  as_of: string;
  positions: Position[];
  total_cost_cents: number;
  total_value_cents: number;
  cash_cents: number;
  problems: string[];
  /** How values were rounded to the cent: "nearest" | "down". */
  rounding: HoldingRounding;
}

export type HoldingRounding = "nearest" | "down";

/** CSV import: which column holds what. */
export interface CsvMapping {
  date: number | null;
  payee: number | null;
  amount: number | null;
  debit: number | null;
  credit: number | null;
  memo: number | null;
  check_number: number | null;
  category: number | null;
  date_order: "auto" | "mdy" | "dmy" | "ymd";
  negate: boolean;
  has_header: boolean;
}
export interface CsvPreviewRow {
  date: string | null;
  payee: string | null;
  amount_cents: number | null;
  error: string | null;
  /** The rest of what the mapping writes. */
  memo?: string | null;
  check_number?: string | null;
  category?: string | null;
}
export interface CsvPreview {
  delimiter: string;
  headers: string[];
  rows: string[][];
  total_rows: number;
  mapping: CsvMapping;
  parsed: CsvPreviewRow[];
  /** A tsp.gov activity detail, which this importer cannot read
   *  properly. The dialog says so instead of importing it flat. */
  looks_like_tsp: boolean;
  /** A brokerage or plan history (Symbol and Quantity columns); the
   *  dialog shuts the door the way it does for a TSP file. */
  looks_like_brokerage: boolean;
}

/** A payee rename rule. */
/** What a rule looks at besides the payee text. */
export interface RuleConditions {
  min_cents?: number | null;
  max_cents?: number | null;
  memo_contains?: string | null;
  account_id?: string | null;
}

export interface PayeeRule {
  id: string;
  match_text: string;
  payee_name: string;
  category_id: string | null;
  category_name: string | null;
  created_at: string;
  /** Conditions beyond the text; null is "any". */
  min_cents?: number | null;
  max_cents?: number | null;
  memo_contains?: string | null;
  account_id?: string | null;
  account_name?: string | null;
}
export interface DuplicateRow {
  id: string;
  date: string;
  cleared_state: string;
  category_name: string | null;
  notes: string | null;
  fitid: string | null;
  check_number: string | null;
  is_transfer: boolean;
}
export interface DuplicateGroup {
  date: string;
  payee: string;
  amount_cents: number;
  rows: DuplicateRow[];
}

/** What Verify this file found. */
export interface BalanceDrift {
  account_id: string;
  account_name: string;
  stored_cents: number;
  computed_cents: number;
}
export interface FileCheck {
  integrity: string[];
  foreign_keys: string[];
  drift: BalanceDrift[];
  half_transfers: string[];
  split_mismatch: string[];
  /** Split transfer lines whose row in the other account is missing,
   *  orphaned, or disagrees with the line. */
  split_transfers: string[];
  accounts: number;
  transactions: number;
  repaired: string[];
}

export interface DbInfo {
  db_path: string;
  size_bytes: number;
  has_key: boolean;
  /** The scratch data directory the app was started against, or null for
   *  the real database. */
  scratch_dir: string | null;
}

/** One line of a split transaction. `description` is per-line and is
 *  distinct from the parent transaction's `notes` (Money's Memo). */
export interface Split {
  id: string;
  transaction_id: string;
  category_id: string | null;
  description: string | null;
  amount_cents: number;
  sort_order: number;
  transfer_account_id?: string | null;
  transfer_account_name?: string | null;
  /** This line's own classification values, one per axis. Empty means
   *  the line inherits the transaction's. */
  classes?: ClassPick[];
}

// ---------------------------------------------------------------------------
// Classifications — the axis that says what money was FOR
// ---------------------------------------------------------------------------

/** One tagging axis ("Property", "Person"), with its values. */
export interface Classification {
  id: string;
  name: string;
  sort_order: number;
  /** Transaction and split lines carrying any value of this axis. */
  usage_count: number;
  values: ClassificationValue[];
}

export interface ClassificationValue {
  id: string;
  classification_id: string;
  parent_id: string | null;
  name: string;
  /** "Parent : Child" for a sub-value, the bare name otherwise. */
  full_name: string;
  usage_count: number;
}

/** A line's value on one axis. An empty `value_id` in a write clears it. */
export interface ClassPick {
  classification_id: string;
  value_id: string;
  /** Filled by the backend on the way out; ignored on the way in. */
  label?: string;
}

/** An incoming split line. Array order becomes `sort_order`. */
export interface NewSplit {
  category_id: string | null;
  description: string | null;
  amount_cents: number;
  /** In Rust, and now here too: set INSTEAD of `category_id` to make this line a
   *  transfer, and the backend writes the far row in that account. The field
   *  existed on the Rust `NewSplit` from the start and was missing from this
   *  one, which is why no UI could ever produce a split transfer. Optional so
   *  every existing caller still compiles; the backend defaults it to null. */
  transfer_account_id?: string | null;
  /** This line's own classification values. Omit to leave the line
   *  inheriting the transaction's. */
  classes?: ClassPick[];
}

/** A payee (migration 0011). Money offers the last category on re-entry. */
/** A piece of text and how often it has been used. */
export interface UsedText {
  name: string;
  usage_count: number;
}

export interface Payee {
  id: string;
  name: string;
  last_category_id: string | null;
  /** Resolved display name of `last_category_id`. */
  last_category_name: string | null;
  /** Transactions currently filed under this payee. */
  usage_count: number;
  updated_at: string;
  /** The amount of this payee's most recent non-void transaction. Money offers
   *  it on re-entry alongside the category. Derived in SQL. */
  last_amount_cents: number | null;
}

/** One bank statement's reconcile record. */
export interface Statement {
  id: string;
  account_id: string;
  statement_date: string;
  starting_balance_cents: number;
  ending_balance_cents: number;
  /** "in_progress" (Postpone leaves it here) | "completed". */
  status: "in_progress" | "completed";
  reconciled_on: string | null;
  service_charge_cents: number | null;
  service_charge_category_id: string | null;
  interest_cents: number | null;
  interest_category_id: string | null;
  adjustment_cents: number | null;
  adjustment_category_id: string | null;
}

/** What a demo-data seed run produced (development builds only). */
export interface SeedSummary {
  accounts: number;
  transactions: number;
  transfers: number;
  splits: number;
  budgets: number;
  statements: number;
  /** Names of the accounts created, so the UI can say where to look. */
  account_names: string[];
}

/** A saved entry-form template — Money's "Common Transactions".
 *  Not a transaction: no account, no date, no cleared state. */
export interface CommonTransaction {
  id: string;
  name: string;
  payee: string;
  category_id: string | null;
  /** Resolved "Parent : Child" name, for the menu. */
  category_name: string | null;
  /** null = no fixed amount ("Kroger, Groceries, whatever it came to"). */
  amount_cents: number | null;
  check_number: string | null;
  notes: string | null;
  usage_count: number;
  updated_at: string;
  splits: NewSplit[];
}

export interface NewCommonTransaction {
  name: string;
  payee: string;
  category_id: string | null;
  amount_cents: number | null;
  check_number: string | null;
  notes: string | null;
  splits: NewSplit[];
}

/** A scheduled bill or income rule. Occurrences are computed from it. */
export interface Recurrence {
  id: string;
  payee: string;
  /** Negative for a bill, positive for income. */
  amount_cents: number;
  account_id: string | null;
  account_name: string | null;
  category_id: string | null;
  category_name: string | null;
  freq: "once" | "weekly" | "semi_monthly" | "monthly" | "yearly";
  interval_n: number;
  start_date: string;
  end_date: string | null;
  second_day: number | null;
  weekend_rule: "none" | "before" | "after";
  notes: string | null;
  is_active: boolean;
  updated_at: string;
  /** A scheduled transfer: where the money lands; the goal its receiving half is tagged for. */
  transfer_account_id?: string | null;
  transfer_account_name?: string | null;
  goal_id?: string | null;
  goal_name?: string | null;
}

export type OccurrenceStatus = "due" | "overdue" | "paid" | "skipped" | "matched";

/** One computed instance, resolved against what actually happened. */
export interface Occurrence {
  recurrence_id: string;
  payee: string;
  amount_cents: number;
  account_id: string | null;
  account_name: string | null;
  category_id: string | null;
  category_name: string | null;
  due_date: string;
  /** `matched` = a real transaction in the register satisfies it, so a bill
   *  paid by hand stops nagging and is never counted twice. */
  status: OccurrenceStatus;
  transaction_id: string | null;
  /** What actually left the account, when known — variable bills rarely match
   *  their rule's amount. */
  actual_amount_cents: number | null;
  /** A scheduled transfer's receiving account. */
  transfer_account_id?: string | null;
  transfer_account_name?: string | null;
}

export interface ForecastPoint {
  date: string;
  delta_cents: number;
  balance_cents: number;
}

export interface CashForecast {
  account_id: string;
  account_name: string;
  starting_balance_cents: number;
  points: ForecastPoint[];
  /** The number a forecast exists for: the worst it gets, and when. */
  low_balance_cents: number;
  low_date: string;
  ending_balance_cents: number;
  upcoming: Occurrence[];
  /** Recurring charges the detector found in this account and the
   *  forecast projected; empty when scheduled items only were asked for. */
  detected: DetectedCharge[];
  /** On a schedule, but projected by their scheduled bills instead. */
  covered_by_bills: string[];
}

/** One detected recurring charge, as the forecast projects it. */
export interface DetectedCharge {
  payee: string;
  /** Negative: money leaving each time. */
  amount_cents: number;
  /** "month", "2 weeks", "year". */
  cadence: string;
  last: string;
  charges: number;
  /** The days in the window it is projected on. */
  dates: string[];
  /** The amount differs each time; the median of the last three is projected. */
  varies: boolean;
  /** On the Home page's Subscriptions ignore list; projected all the same. */
  ignored_on_home: boolean;
}

export interface NewRecurrence {
  payee: string;
  amount_cents: number;
  account_id: string | null;
  category_id: string | null;
  freq: Recurrence["freq"];
  interval_n: number;
  start_date: string;
  end_date: string | null;
  second_day: number | null;
  weekend_rule: Recurrence["weekend_rule"];
  notes: string | null;
  /** A scheduled transfer's receiving account (amount must be money out) and the goal to tag. */
  transfer_account_id?: string | null;
  goal_id?: string | null;
}

/** How automatic backups are configured. */
export interface BackupConfig {
  enabled: boolean;
  /** Also take one when the app closes, or a file is closed. Its own
   *  switch: "once a day when I start" and "whenever I leave" are different
   *  habits, and the second should not require the first. */
  on_exit: boolean;
  folder: string | null;
  /** How many of our own backups to keep. Never fewer than one. */
  keep: number;
  last_at: string | null;
  /** Backups already in the folder, newest first. */
  existing: string[];
}

/** One row a payee rule would change.
 *
 *  Both halves of every change are carried — what it says now and what it
 *  would say — because a preview that shows only the destination asks you to
 *  remember what you are agreeing to lose. */
export interface PayeeRuleChange {
  transaction_id: string;
  account_name: string;
  /** The account's currency, which `amount_cents` is in; absent = dollars. */
  currency?: string;
  date: string;
  amount_cents: number;
  payee: string;
  new_payee: string;
  category_name: string | null;
  new_category_name: string | null;
  /** Set only when the rule is FILLING IN an empty category, never an
   *  overwrite of one you chose. */
  new_category_id: string | null;
  rule_id: string;
  match_text: string;
}

// ── TSP import ────────────────────────────────────────────────────

/** One fund's position on the day before the export begins — worked out from
 *  the file, never estimated. */
export interface TspOpeningPosition {
  fund: string;
  /** Six places, the precision the plan states. */
  units: string;
  nav: string;
  value_cents: number;
  /** Millionths added to cover the plan's own per-source rounding, if any. */
  rounding_sliver: string | null;
  /** Of `units`, what the chosen account already holds on the open
   *  date, and what will actually be written. "0.000000" until an account
   *  is chosen. */
  already_held: string;
  to_add: string;
}

/** A day money left the plan. The CSV knows what was SOLD; only the user
 *  knows what reached the bank, which is the whole reason for the dialog. */
export interface TspPayment {
  date: string;
  gross_cents: number;
  /** A borrowing rather than a distribution — a fee, not withholding. */
  is_loan: boolean;
  needs_split: boolean;
}

export interface TspPlan {
  rows: number;
  transactions: number;
  opening: TspOpeningPosition[];
  open_date: string;
  payments: TspPayment[];
  /** Anything impossible. A plan with problems is never imported. */
  problems: string[];
  funds: string[];
}

export interface TspDeposit {
  /** The date the BANK posted it. */
  on: string;
  amount_cents: number;
}

export interface TspKeptLine {
  category: string;
  /** null on exactly one line means "whatever is left". */
  amount_cents: number | null;
  memo: string;
}

export interface TspPaymentSplit {
  date: string;
  deposits: TspDeposit[];
  lines: TspKeptLine[];
}

/** What undo would do next, in the words the menu uses.
 *
 *  `null` means there is nothing on that side of the stack, which is how the
 *  menu decides to gray the item out. The label is the operation's own
 *  description ("delete a transaction"), so the menu can say exactly what it
 *  is about to undo rather than a bare "Undo" that could mean anything. */
export interface UndoStatus {
  undo: string | null;
  redo: string | null;
}

/** The T-Money file that is open. */
export interface OpenFile {
  path: string;
  name: string;
  /** The app's own database rather than one the user chose. */
  isDefault: boolean;
  scratch: boolean;
  /** False after File → Close: no file is open at all, and the app
   *  shows its start screen. `path`/`name` are then the file that WAS open,
   *  so the start screen can offer it back. */
  isOpen: boolean;
}

/** One of the last few files opened. `exists` false means the path is
 *  no longer there; the entry is kept and marked, because a database that has
 *  gone missing is the most useful thing this list can say. */
export interface RecentFile {
  path: string;
  name: string;
  last_opened: string;
  exists: boolean;
  /** True when this computer holds no key that opens this file, so the
   *  start screen can say so before you click rather than after. */
  needs_key: boolean;
}

/** What merging one category into another would do, counted first.
 *
 *  The dialog asks for this each time the destination changes, so the
 *  sentence it shows names both sides and real numbers, and a merge the
 *  backend would refuse says so before the button is pressed rather than
 *  after. */
export interface MergePreview {
  transactions: number;
  splits: number;
  /** Budget months that move across, folded or otherwise. */
  budgets: number;
  /** Months where both sides already have an amount and the two get added. */
  budgetsFolded: number;
  payeeRules: number;
  recurrences: number;
  children: number;
  /** Payees, statements, common transactions and loan terms, added up. */
  otherLinks: number;
  /** Why this merge cannot happen — null when it can. */
  blocked: string | null;
}

/** A SimpleFIN account the open file knows about, and the T-Money account
 *  it fills, if any. Amounts are in cents of `currency`. */
export interface SimplefinAccount {
  sf_id: string;
  name: string;
  org: string | null;
  currency: string | null;
  balance_cents: number | null;
  balance_date: string | null;
  account_id: string | null;
  account_name: string | null;
  synced_through: string | null;
}

/** Whether the open file is connected to SimpleFIN. `server` is the host's
 *  name only; the credential never leaves the backend. */
export interface SimplefinStatus {
  connected: boolean;
  server: string | null;
  accounts: SimplefinAccount[];
  /** Requests in the last 24 hours (a rolling day). */
  requests_today: number;
  daily_limit: number;
  /** SimpleFIN's own messages from the step just taken. */
  messages: string[];
}

export interface SimplefinSyncLine {
  sf_name: string;
  account_id: string;
  account_name: string;
  imported: number;
  /** Paired with a transaction already typed in, which is kept. */
  matched: number;
  duplicates: number;
  bank_balance_cents: number | null;
  balance_cents: number;
  error: string | null;
  /** Not an error: days SimpleFIN could not reach back to. */
  note: string | null;
}

/** What one "Get bank transactions" did. */
export interface SimplefinSync {
  lines: SimplefinSyncLine[];
  /** SimpleFIN's own messages, such as a bank to sign in to again. */
  messages: string[];
  unlinked: number;
  from: string;
  to: string;
}
