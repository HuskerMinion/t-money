// The Budget screen.
//
// The tests worth having here are the three complaints that caused the
// rework: you could not change a number where you were looking at it, you
// could not see a category you had not budgeted, and the rows moved while you
// typed. Plus the tree grouping, which is the thing that keeps the screen
// from being eighty rows long.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

import BudgetView, {
  budgetSource,
  groupIsInteresting,
  groupLines,
  shiftMonth,
} from "./BudgetView";
import { invokeCalls, resetIpc, setIpcHandlers } from "../test/tauriMock";
import type { BudgetLine } from "../lib/types";

function line(over: Partial<BudgetLine> & { category_id: string; name: string }): BudgetLine {
  return {
    full_name: over.name,
    parent_id: null,
    target_cents: 0,
    period: "monthly" as const,
    monthly_cents: over.target_cents ?? 0,
    has_budget: false,
    own_cents: 0,
    rolled_cents: 0,
    children_budgeted_cents: 0,
    counts_in_total: false,
    spent_cents: 0,
    spent_month_cents: 0,
    remaining_cents: 0,
    ...over,
  };
}

const auto = line({ category_id: "c-auto", name: "Automobile", target_cents: 60_000, has_budget: true, counts_in_total: true, own_cents: 2_000, rolled_cents: 5_000, spent_cents: 7_000, remaining_cents: 53_000 });
const fuel = line({ category_id: "c-fuel", name: "Fuel", full_name: "Automobile : Fuel", parent_id: "c-auto", spent_cents: 10_000 });
const travel = line({ category_id: "c-travel", name: "Travel" });

const grid = {
  month: "2026-09",
  lines: [auto, fuel, travel],
  budgeted_cents: 60_000,
  spent_cents: 7_000,
  remaining_cents: 53_000,
  budgeted_lines: 1,
  total_lines: 3,
};

beforeEach(() => {
  resetIpc();
  setIpcHandlers({
    get_budget_grid: () => grid,
    set_budget: () => ({ id: "b-1" }),
    set_budget_line: () => ({ budget: { id: "b-1" }, raised: null }),
    list_budgets: () => [{ id: "b-1", category_id: "c-auto", category_name: "Automobile", target_cents: 60_000, month_year: "2026-09" }],
    delete_budget: () => null,
    get_spending_summary: () => [],
  });
});

describe("Budget helpers", () => {
  it("groups the flat rows into the two-level tree", () => {
    const groups = groupLines([auto, fuel, travel]);
    expect(groups.map((g) => g.parent.name)).toEqual(["Automobile", "Travel"]);
    expect(groups[0].children.map((c) => c.name)).toEqual(["Fuel"]);
    expect(groups[1].children).toEqual([]);
  });

  it("keeps an orphaned child visible rather than dropping it off a screen that claims to show everything", () => {
    const orphan = line({ category_id: "c-x", name: "Odd", parent_id: "c-gone" });
    expect(groupLines([orphan]).map((g) => g.parent.name)).toEqual(["Odd"]);
  });

  it("counts a group as interesting when anything in it is budgeted or spent", () => {
    expect(groupIsInteresting({ parent: auto, children: [fuel] })).toBe(true);
    expect(groupIsInteresting({ parent: travel, children: [] })).toBe(false);
    expect(groupIsInteresting({ parent: travel, children: [fuel] })).toBe(true);
  });

  it("steps months across a year boundary", () => {
    expect(shiftMonth("2026-09", 1)).toBe("2026-10");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
  });
});

describe("<BudgetView />", () => {
  // EIGHT TESTS WERE REMOVED HERE, and what they tested went with
  // them. They drove typing on this screen: editing an amount in the row,
  // the envelope notice that a write produced, the period picker, and
  // revealing a hidden category "and then it is typeable".
  //
  // > "I went to This Month, clicked forward to October, it showed Credit
  // >  Card at 0.00 where I had set it and I changed it to 60. Where does
  // >  that go?"
  //
  // Nowhere. `budgets` is materialized from `budget_plans`, so a figure
  // typed here is invisible to the year plan or wiped by the next
  // materialize. The screen is kept because it is a good reading of one
  // month; the typing is the year plan's job, and the envelope rule is
  // tested where it now runs (queries.rs and plan.rs).

  it("Shows the figure but does not offer to change it", async () => {
    render(<BudgetView />);
    await screen.findByText("Automobile");
    // The amount is drawn, not typed.
    expect(screen.queryByLabelText("Budget for Automobile")).toBeNull();
    expect(screen.queryByLabelText("Period for Automobile")).toBeNull();
  });

  it("Says where the figure comes from, so the dead end is signposted", () => {
    expect(
      budgetSource(line({ category_id: "c-1", name: "Automobile", has_budget: true, target_cents: 60_000 }))
    ).toContain("set on the Year plan");
    expect(budgetSource(line({ category_id: "c-2", name: "Books" }))).toContain("No budget");
  });


  it("says what a parent is carrying for its children, so a bigger number is not a mystery", async () => {
    render(<BudgetView />);
    expect(await screen.findByText(/incl\. 50\.00 below/)).toBeInTheDocument();
  });





  // The other half of that sentence. A parent that had NO budget and
  // now has one is a different event from a parent that went up, and the
  // screen must not report the two the same way: a figure has appeared in a
  // box nobody typed in, which is exactly what the screen refused to do until the user
  // asked for it.



  it("moves between months and asks the backend for the one being shown", async () => {
    render(<BudgetView />);
    // Wait on the row's NAME; the amount is no longer a labeled field.
    await screen.findByText("Automobile");
    const first = invokeCalls.filter((c) => c.cmd === "get_budget_grid").length;

    await userEvent.click(screen.getByRole("button", { name: "Previous month" }));
    await waitFor(() =>
      expect(invokeCalls.filter((c) => c.cmd === "get_budget_grid").length).toBeGreaterThan(first)
    );
    const months = invokeCalls.filter((c) => c.cmd === "get_budget_grid").map((c) => c.args.month);
    expect(months[0]).not.toBe(months[months.length - 1]);
  });

  it("offers to build a budget when the month has none", async () => {
    setIpcHandlers({
      get_budget_grid: () => ({ ...grid, budgeted_lines: 0, budgeted_cents: 0, lines: [travel] }),
      get_spending_summary: () => [],
    });
    render(<BudgetView />);
    expect(await screen.findByText(/Nothing is budgeted/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Start a budget from my spending/ })).toBeInTheDocument();
  });
});

describe("Ctrl+F finds a budget line, not a transaction", () => {
  it("finds a child under a collapsed parent and opens it", async () => {
    const user = userEvent.setup();
    render(<BudgetView />);
    await screen.findByText("Automobile");
    // Fuel is a child of a collapsed group: not on screen until found.
    expect(screen.queryByText("Fuel")).toBeNull();
    await user.type(screen.getByLabelText("Find on this page"), "fuel");
    expect(screen.getByText("Fuel")).toBeInTheDocument();
    expect(screen.getByText("Automobile")).toBeInTheDocument();
    expect(screen.queryByText("Travel")).toBeNull();
  });

  it("finds a category the ordinary view hides as uninteresting", async () => {
    const user = userEvent.setup();
    render(<BudgetView />);
    await screen.findByText("Automobile");
    // Travel has nothing budgeted or spent, so it is hidden by default…
    expect(screen.queryByText("Travel")).toBeNull();
    await user.type(screen.getByLabelText("Find on this page"), "trav");
    // …and a find is the clearest statement that you want to see it.
    expect(screen.getByText("Travel")).toBeInTheDocument();
  });
});

describe("Clear, and the month on screen", () => {
  it("does not offer Clear on a line the Year plan wrote, which the plan would write back", async () => {
    setIpcHandlers({
      get_budget_grid: () => grid,
      get_year_plan: () => ({ expenses: [{ category_id: "c-auto", has_plan: true }], income: [] }),
    });
    render(<BudgetView />);
    await screen.findByText("Automobile");
    await waitFor(() => expect(screen.getByText("Year plan")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Clear the budget for Automobile/ })).toBeNull();
  });

  it("still offers Clear on a hand-set line with no plan behind it", async () => {
    setIpcHandlers({
      get_budget_grid: () => grid,
      get_year_plan: () => ({ expenses: [{ category_id: "c-auto", has_plan: false }], income: [] }),
    });
    render(<BudgetView />);
    expect(await screen.findByRole("button", { name: /Clear the budget for Automobile/ })).toBeInTheDocument();
  });

  it("ignores a slow answer for a month that is no longer on screen", async () => {
    let late!: (g: unknown) => void;
    const first = grid.month;
    setIpcHandlers({
      get_budget_grid: (args) =>
        invokeCalls.filter((c) => c.cmd === "get_budget_grid").length === 1
          ? new Promise((r) => (late = r))
          : { ...grid, month: args.month, lines: [travel, line({ category_id: "c-new", name: "Newer month", has_budget: true, target_cents: 100 })] },
      get_year_plan: () => ({ expenses: [], income: [] }),
    });
    render(<BudgetView />);
    await userEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(await screen.findByText("Newer month")).toBeInTheDocument();
    late({ ...grid, month: first });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText("Automobile")).toBeNull();
    expect(screen.getByText("Newer month")).toBeInTheDocument();
  });
});
