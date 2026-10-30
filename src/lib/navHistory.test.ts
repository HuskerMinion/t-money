// Back and Forward: what is a step, and what only updates the step you are on.
import { describe, expect, it } from "vitest";
import { canGoBack, canGoForward, EMPTY_HISTORY, MAX_ENTRIES, record, step, type Place } from "./navHistory";
import type { ReportSpec } from "../components/ReportViewer";

const at = (over: Partial<Place>): Place => ({
  tab: "Home",
  side: "accounts",
  bankingScreen: "list",
  budgetScreen: "budget",
  accountId: null,
  report: null,
  helpTopic: null,
  searchQuery: null,
  ...over,
});

const spending: ReportSpec = {
  kind: "spending_by_category",
  rangeId: "year_to_date",
  range: { from: "2026-01-01", to: "2026-10-30" },
  accountIds: [],
  categoryIds: [],
  compare: null,
};

describe("navigation history", () => {
  it("pushes each new screen and walks back and forward", () => {
    let h = record(EMPTY_HISTORY, at({ tab: "Home" }));
    h = record(h, at({ tab: "Banking", bankingScreen: "register", accountId: "a1" }));
    h = record(h, at({ tab: "Bills" }));
    expect(h.entries).toHaveLength(3);
    expect(canGoBack(h)).toBe(true);
    expect(canGoForward(h)).toBe(false);
    h = step(h, -1);
    expect(h.entries[h.index].accountId).toBe("a1");
    expect(canGoForward(h)).toBe(true);
    h = step(h, 1);
    expect(h.entries[h.index].tab).toBe("Bills");
    // At the end, Forward does nothing.
    expect(step(h, 1)).toBe(h);
  });

  it("another account's register is a step; the rail highlight alone is not", () => {
    let h = record(EMPTY_HISTORY, at({ tab: "Banking", bankingScreen: "register", accountId: "a1" }));
    h = record(h, at({ tab: "Banking", bankingScreen: "register", accountId: "a2" }));
    h = record(h, at({ tab: "Banking", bankingScreen: "register", accountId: "a2", side: "transactions" }));
    expect(h.entries).toHaveLength(2);
    expect(h.entries[1].side).toBe("transactions");
  });

  it("a report re-run for another range updates its step; a drill-down is a new one", () => {
    let h = record(EMPTY_HISTORY, at({ tab: "Reports" }));
    h = record(h, at({ tab: "Reports", report: spending }));
    const lastMonth = { ...spending, rangeId: "last_month", range: { from: "2026-09-01", to: "2026-09-30" } };
    h = record(h, at({ tab: "Reports", report: lastMonth }));
    expect(h.entries).toHaveLength(2);
    expect(h.entries[1].report?.rangeId).toBe("last_month");
    h = record(h, at({ tab: "Reports", report: { ...lastMonth, kind: "transactions_by_category", categoryIds: ["c-groc"] } }));
    expect(h.entries).toHaveLength(3);
    // Back from the drill-down is the report, at the range it was left on.
    h = step(h, -1);
    expect(h.entries[h.index].report?.rangeId).toBe("last_month");
  });

  it("going somewhere new from the middle drops what was ahead", () => {
    let h = record(EMPTY_HISTORY, at({ tab: "Home" }));
    h = record(h, at({ tab: "Bills" }));
    h = record(h, at({ tab: "Taxes" }));
    h = step(step(h, -1), -1);
    h = record(h, at({ tab: "Planning" }));
    expect(h.entries.map((e) => e.tab)).toEqual(["Home", "Planning"]);
    expect(canGoForward(h)).toBe(false);
  });

  it("keeps the last fifty", () => {
    let h = EMPTY_HISTORY;
    for (let i = 0; i < MAX_ENTRIES + 10; i++) h = record(h, at({ tab: "Search", searchQuery: `q${i}` }));
    expect(h.entries).toHaveLength(MAX_ENTRIES);
    expect(h.entries[0].searchQuery).toBe("q10");
    expect(h.index).toBe(MAX_ENTRIES - 1);
  });
});
