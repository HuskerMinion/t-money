// The register's View (§40). Money drives the register
// from a saved view that sets three things at once: which rows (Show), which
// dates, and the sort — and prints them as one sentence above the grid:
// "Unreconciled transactions covering this month, Sorted by Date (increasing)".
//
// Pure functions over the rows the backend already returns; nothing here
// asks the database for anything.
//
// The one rule that matters (§10.2 item 4): the Balance column is a RUNNING
// balance, which only means something in date order. Any other sort blanks
// it rather than showing a number that is a lie.
import { resolveRange } from "./reportRanges";
import type { RegisterRow } from "./types";

export type RegisterShow =
  | "all"
  | "unreconciled-grouped"
  | "unreconciled"
  | "uncleared"
  | "uncategorized"
  | "transfers"
  | "voided";

export type RegisterDates =
  | "all_dates"
  | "this_month"
  | "last_month"
  | "this_quarter"
  | "year_to_date"
  | "previous_year"
  | "last_12_months"
  | "last_30_days"
  | "last_90_days";

export type RegisterSort =
  | "date_asc"
  | "date_desc"
  | "payee"
  | "payee_desc"
  | "amount"
  | "amount_desc"
  | "num"
  | "num_desc"
  | "entry";

/** The register's columns that can be sorted by clicking their header (§96).
 *  "date" covers both grids; "payee" is the Investment column in an
 *  investment register and "amount" its Total. */
export type SortColumn = "num" | "date" | "payee" | "amount";

export interface RegisterViewOptions {
  show: RegisterShow;
  dates: RegisterDates;
  sort: RegisterSort;
}

export const DEFAULT_VIEW: RegisterViewOptions = { show: "all", dates: "all_dates", sort: "date_asc" };

export const SHOW_OPTIONS: [RegisterShow, string][] = [
  ["all", "All transactions"],
  ["unreconciled-grouped", "Unreconciled transactions, grouped by Deposits and Withdrawals"],
  ["unreconciled", "Unreconciled transactions"],
  ["uncleared", "Uncleared transactions"],
  ["uncategorized", "Uncategorized transactions"],
  ["transfers", "Transfers only"],
  ["voided", "Voided transactions"],
];

export const DATES_OPTIONS: [RegisterDates, string][] = [
  ["all_dates", "all dates"],
  ["this_month", "this month"],
  ["last_month", "last month"],
  ["this_quarter", "this quarter"],
  ["year_to_date", "this year"],
  ["previous_year", "last year"],
  ["last_12_months", "the last 12 months"],
  ["last_30_days", "the last 30 days"],
  ["last_90_days", "the last 90 days"],
];

export const SORT_OPTIONS: [RegisterSort, string][] = [
  ["date_asc", "Date (increasing)"],
  ["date_desc", "Date (decreasing)"],
  ["payee", "Payee (A–Z)"],
  ["payee_desc", "Payee (Z–A)"],
  ["amount", "Amount (increasing)"],
  ["amount_desc", "Amount (decreasing)"],
  ["num", "Num (increasing)"],
  ["num_desc", "Num (decreasing)"],
  ["entry", "Entry order"],
];

/** Which column a sort belongs to, for drawing the marker in its header. */
export function sortColumn(sort: RegisterSort): SortColumn | null {
  switch (sort) {
    case "date_asc":
    case "date_desc":
      return "date";
    case "payee":
    case "payee_desc":
      return "payee";
    case "amount":
    case "amount_desc":
      return "amount";
    case "num":
    case "num_desc":
      return "num";
    case "entry":
      return null;
  }
}

export function sortAscending(sort: RegisterSort): boolean {
  return !sort.endsWith("_desc");
}

/** Clicking a column header: a new column sorts ascending, the column already
 *  sorted flips. Money sorts by clicking too, and this is the behavior every
 *  grid has — the first click should never be a surprise. */
export function nextSort(column: SortColumn, current: RegisterSort): RegisterSort {
  const asc: Record<SortColumn, RegisterSort> = { num: "num", date: "date_asc", payee: "payee", amount: "amount" };
  const desc: Record<SortColumn, RegisterSort> = {
    num: "num_desc",
    date: "date_desc",
    payee: "payee_desc",
    amount: "amount_desc",
  };
  if (sortColumn(current) !== column) return asc[column];
  return sortAscending(current) ? desc[column] : asc[column];
}

/** Money's one-line description of the view. */
export function describeView(v: RegisterViewOptions): string {
  const show = SHOW_OPTIONS.find(([k]) => k === v.show)?.[1] ?? "All transactions";
  const dates = DATES_OPTIONS.find(([k]) => k === v.dates)?.[1] ?? "all dates";
  const sort = SORT_OPTIONS.find(([k]) => k === v.sort)?.[1] ?? "Date (increasing)";
  const showText = v.show === "unreconciled-grouped" ? "Unreconciled transactions" : show;
  const tail = v.show === "unreconciled-grouped" ? "Grouped by Deposits and Withdrawals" : `Sorted by ${sort}`;
  return `${showText} covering ${dates}, ${tail}`;
}

function matchesShow(r: RegisterRow, show: RegisterShow): boolean {
  switch (show) {
    case "all":
      return true;
    case "unreconciled":
    case "unreconciled-grouped":
      return r.cleared_state !== "R";
    case "uncleared":
      return r.cleared_state === "";
    case "uncategorized":
      // A buy or a sell has no category by design (§41); only cash rows count.
      return r.category_id === null && r.transfer_account_id === null && !r.is_void && r.activity === null;
    case "transfers":
      return r.transfer_account_id !== null;
    case "voided":
      return r.is_void;
  }
}

/** Filter and sort. `entryOrder` is the backend's order (date, rowid), which
 *  is the order the rows arrive in. */
export function applyRegisterView(rows: readonly RegisterRow[], v: RegisterViewOptions, today: string): RegisterRow[] {
  let out = rows.filter((r) => matchesShow(r, v.show));
  if (v.dates !== "all_dates") {
    const { from, to } = resolveRange(v.dates, today);
    out = out.filter((r) => r.date >= from && r.date <= to);
  }
  // Stable: ties keep the backend's order, so same-day rows never reshuffle.
  const indexed = out.map((r, i) => ({ r, i }));
  const by = (f: (a: RegisterRow, b: RegisterRow) => number) =>
    indexed.sort((x, y) => f(x.r, y.r) || x.i - y.i).map((x) => x.r);
  // §96: every column can now be clicked twice, so each sort has a reverse.
  // Reversing the SORTED array rather than negating the comparator would undo
  // the tie-break too, reshuffling same-day rows; negating keeps ties in the
  // backend's order in both directions.
  const dir = sortAscending(v.sort) ? 1 : -1;
  switch (v.sort) {
    case "date_asc":
    case "entry":
      return out;
    case "date_desc":
      // Newest first, and the newest entry of a day first: the exact
      // reverse of the register's own order.
      return [...out].reverse();
    case "payee":
    case "payee_desc":
      return by((a, b) => dir * a.payee.localeCompare(b.payee, undefined, { sensitivity: "base" }));
    case "amount":
    case "amount_desc":
      return by((a, b) => dir * (a.amount_cents - b.amount_cents));
    case "num":
    case "num_desc": {
      // Numeric checks in order, then the markers (ATM, EFT…) alphabetically, then blanks.
      const key = (r: RegisterRow): [number, number, string] => {
        const n = (r.check_number ?? "").trim();
        if (n === "") return [2, 0, ""];
        if (/^\d+$/.test(n)) return [0, Number(n), ""];
        return [1, 0, n.toLowerCase()];
      };
      return by((a, b) => {
        const [ka, na, sa] = key(a);
        const [kb, nb, sb] = key(b);
        return dir * (ka - kb || na - nb || sa.localeCompare(sb));
      });
    }
  }
}

/** The running balance only reads in date order (§10.2 item 4). */
export function balanceIsMeaningful(v: RegisterViewOptions): boolean {
  return v.sort === "date_asc" || v.sort === "entry";
}
