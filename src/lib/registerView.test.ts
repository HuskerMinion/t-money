import { describe, expect, it } from "vitest";
import {
  applyRegisterView,
  balanceIsMeaningful,
  describeView,
  DEFAULT_VIEW,
  nextSort,
  sortAscending,
  sortColumn,
} from "./registerView";
import type { RegisterRow } from "./types";

function row(p: Partial<RegisterRow> & { id: string; date: string }): RegisterRow {
  return {
    payee: "Payee",
    category_name: null,
    category_id: "c-1",
    transfer_account_id: null,
    amount_cents: -1000,
    running_balance_cents: 0,
    is_reconciled: false,
    cleared_state: "",
    check_number: null,
    is_void: false,
    notes: null,
    transfer_account_name: null,
    activity: null,
    security_id: null,
    security_name: null,
    shares_micro: null,
    price_micro: null,
    gross_cents: null,
    commission_cents: 0,
    lot_specified: false,
    goal_id: null,
    goal_name: null,
    ...p,
  };
}

const rows: RegisterRow[] = [
  row({ id: "a", date: "2026-07-03", payee: "Kroger", amount_cents: -4250, cleared_state: "R", check_number: "1042" }),
  row({ id: "b", date: "2026-08-01", payee: "Employer", amount_cents: 300000, cleared_state: "C" }),
  row({ id: "c", date: "2026-08-15", payee: "ATM", amount_cents: -8000, check_number: "ATM", category_id: null }),
  row({ id: "d", date: "2026-08-15", payee: "Transfer Money", amount_cents: -40000, transfer_account_id: "sav", category_id: null }),
  row({ id: "e", date: "2026-09-02", payee: "fraud", amount_cents: -9900, is_void: true, category_id: null }),
  row({ id: "f", date: "2026-09-04", payee: "Shell", amount_cents: -3000, check_number: "1043" }),
];
const today = "2026-09-05";
const ids = (r: RegisterRow[]) => r.map((x) => x.id);

describe("applyRegisterView", () => {
  it("shows everything, in the register's own order, by default", () => {
    expect(ids(applyRegisterView(rows, DEFAULT_VIEW, today))).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(balanceIsMeaningful(DEFAULT_VIEW)).toBe(true);
  });

  it("Show narrows by state — and uncategorized means neither a transfer nor a void", () => {
    expect(ids(applyRegisterView(rows, { ...DEFAULT_VIEW, show: "unreconciled" }, today))).toEqual(["b", "c", "d", "e", "f"]);
    expect(ids(applyRegisterView(rows, { ...DEFAULT_VIEW, show: "uncleared" }, today))).toEqual(["c", "d", "e", "f"]);
    expect(ids(applyRegisterView(rows, { ...DEFAULT_VIEW, show: "uncategorized" }, today))).toEqual(["c"]);
    expect(ids(applyRegisterView(rows, { ...DEFAULT_VIEW, show: "transfers" }, today))).toEqual(["d"]);
    expect(ids(applyRegisterView(rows, { ...DEFAULT_VIEW, show: "voided" }, today))).toEqual(["e"]);
  });

  it("Dates use the same ranges as the reports", () => {
    expect(ids(applyRegisterView(rows, { ...DEFAULT_VIEW, dates: "this_month" }, today))).toEqual(["e", "f"]);
    expect(ids(applyRegisterView(rows, { ...DEFAULT_VIEW, dates: "last_month" }, today))).toEqual(["b", "c", "d"]);
    expect(ids(applyRegisterView(rows, { ...DEFAULT_VIEW, dates: "last_30_days" }, today))).toEqual(["c", "d", "e", "f"]);
  });

  it("sorts are stable, and only date order keeps the running balance", () => {
    expect(ids(applyRegisterView(rows, { ...DEFAULT_VIEW, sort: "date_desc" }, today))).toEqual(["f", "e", "d", "c", "b", "a"]);
    expect(ids(applyRegisterView(rows, { ...DEFAULT_VIEW, sort: "payee" }, today))).toEqual(["c", "b", "e", "a", "f", "d"]);
    expect(ids(applyRegisterView(rows, { ...DEFAULT_VIEW, sort: "amount" }, today))).toEqual(["d", "e", "c", "a", "f", "b"]);
    // Numeric checks first in order, then markers, then blanks.
    expect(ids(applyRegisterView(rows, { ...DEFAULT_VIEW, sort: "num" }, today))).toEqual(["a", "f", "c", "b", "d", "e"]);
    for (const sort of ["date_desc", "payee", "amount", "num"] as const) {
      expect(balanceIsMeaningful({ ...DEFAULT_VIEW, sort })).toBe(false);
    }
  });

  it("describes itself the way Money does", () => {
    expect(describeView(DEFAULT_VIEW)).toBe("All transactions covering all dates, Sorted by Date (increasing)");
    expect(describeView({ show: "unreconciled", dates: "this_month", sort: "payee" })).toBe(
      "Unreconciled transactions covering this month, Sorted by Payee (A–Z)"
    );
    expect(describeView({ show: "unreconciled-grouped", dates: "all_dates", sort: "date_asc" })).toBe(
      "Unreconciled transactions covering all dates, Grouped by Deposits and Withdrawals"
    );
  });
});

describe("sorting by a clicked column header", () => {
  const rows = [
    row({ id: "a", date: "2026-03-01", payee: "Costco", amount_cents: -5000, check_number: "1002" }),
    row({ id: "b", date: "2026-03-02", payee: "aldi", amount_cents: -1500, check_number: "9" }),
    row({ id: "c", date: "2026-03-03", payee: "Shell", amount_cents: 20000, check_number: null }),
  ];
  const ids = (sort: Parameters<typeof describeView>[0]["sort"]) =>
    applyRegisterView(rows, { ...DEFAULT_VIEW, sort }, "2026-03-31").map((r) => r.id);

  it("reverses each column rather than only date", () => {
    expect(ids("payee")).toEqual(["b", "a", "c"]);
    expect(ids("payee_desc")).toEqual(["c", "a", "b"]);
    expect(ids("amount")).toEqual(["a", "b", "c"]);
    expect(ids("amount_desc")).toEqual(["c", "b", "a"]);
    // Numeric checks, then markers, then blanks — and the blank stays last
    // going up, first coming down.
    expect(ids("num")).toEqual(["b", "a", "c"]);
    expect(ids("num_desc")).toEqual(["c", "a", "b"]);
  });

  it("keeps ties in the backend's order in both directions", () => {
    // Two rows the sort cannot separate: whichever way it runs, the pair must
    // not reshuffle. Negating the comparator does this; reversing the sorted
    // array would not.
    const tied = [
      row({ id: "first", date: "2026-03-01", payee: "Same", amount_cents: -100 }),
      row({ id: "second", date: "2026-03-02", payee: "Same", amount_cents: -100 }),
    ];
    const order = (sort: "payee" | "payee_desc") =>
      applyRegisterView(tied, { ...DEFAULT_VIEW, sort }, "2026-03-31").map((r) => r.id);
    expect(order("payee")).toEqual(["first", "second"]);
    expect(order("payee_desc")).toEqual(["first", "second"]);
  });

  it("a new column sorts ascending and the sorted column flips", () => {
    expect(nextSort("payee", DEFAULT_VIEW.sort)).toBe("payee");
    expect(nextSort("payee", "payee")).toBe("payee_desc");
    expect(nextSort("payee", "payee_desc")).toBe("payee");
    // Moving to a different column always starts over, never inherits the
    // direction the previous column happened to be in.
    expect(nextSort("amount", "payee_desc")).toBe("amount");
    expect(nextSort("date", "amount_desc")).toBe("date_asc");
  });

  it("knows which header wears the marker, and which way it points", () => {
    expect(sortColumn("amount_desc")).toBe("amount");
    expect(sortColumn("entry")).toBeNull();
    expect(sortAscending("num")).toBe(true);
    expect(sortAscending("num_desc")).toBe(false);
  });

  it("still blanks the running balance for every sort but date order", () => {
    for (const sort of ["payee_desc", "amount_desc", "num_desc"] as const) {
      expect(balanceIsMeaningful({ ...DEFAULT_VIEW, sort })).toBe(false);
    }
  });
});
