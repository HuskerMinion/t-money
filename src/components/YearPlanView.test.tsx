// §139 — the year plan.
//
// The tests worth having are the ones that would let the screen quietly lie:
// a monthly figure that does not convert to the right annual one for a line
// that runs five months of the year, an income month painted red, a spread
// change that silently alters what the year costs, and the two columns
// disagreeing about which one was typed.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { runCommand } from "../lib/commands";
import { beforeEach, describe, expect, it } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

import YearPlanView, {
  annualFromMonthly,
  groupIsInteresting,
  groupPlan,
  isDueMonth,
  monthCount,
  monthsPhrase,
  projectedCents,
  raiseNotice,
  spreadLabel,
  varianceNote,
} from "./YearPlanView";
import { invokeCalls, resetIpc, setIpcHandlers } from "../test/tauriMock";
import type { PlanLine, PlanTotals, YearPlan } from "../lib/types";

function line(over: Partial<PlanLine> & { category_id: string; name: string }): PlanLine {
  const months = over.months ?? "111111111111";
  const actual = over.actual_cents ?? new Array(12).fill(0);
  return {
    full_name: over.name,
    parent_id: null,
    kind: "expense",
    has_plan: true,
    annual_cents: 0,
    monthly_cents: 0,
    months_label: "every month",
    spread: "spent",
    payment_cents: 0,
    actual_to_date: actual.reduce((a: number, b: number) => a + b, 0),
    expected_to_date: 0,
    variance_cents: 0,
    counts_in_total: true,
    ...over,
    months,
    actual_cents: actual,
  };
}

function totals(over: Partial<PlanTotals> = {}): PlanTotals {
  return {
    annual_cents: 0,
    monthly_cents: 0,
    actual_cents: new Array(12).fill(0),
    actual_to_date: 0,
    expected_to_date: 0,
    variance_cents: 0,
    ...over,
  };
}

const FOOD = line({
  category_id: "c-food",
  name: "Food",
  annual_cents: 1_200_000,
  monthly_cents: 100_000,
  actual_cents: [99_500, 110_000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  expected_to_date: 200_000,
  variance_cents: -9_500,
});

const OIL = line({
  category_id: "c-oil",
  name: "Heating oil",
  annual_cents: 90_000,
  monthly_cents: 18_000,
  months: "111000000011",
  months_label: "Nov–Mar",
  actual_cents: [18_000, 18_000, 18_000, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  expected_to_date: 54_000,
  variance_cents: 0,
});

const PENSION = line({
  category_id: "c-pension",
  name: "Pension",
  kind: "income",
  annual_cents: 3_600_000,
  monthly_cents: 300_000,
  actual_cents: [900_000, 300_000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  expected_to_date: 600_000,
  variance_cents: 600_000,
});

const PLAN: YearPlan = {
  year: 2027,
  months_elapsed: 2,
  income: [PENSION],
  expenses: [FOOD, OIL],
  income_total: totals({ annual_cents: 3_600_000, monthly_cents: 300_000, actual_to_date: 1_200_000, variance_cents: 600_000 }),
  expense_total: totals({ annual_cents: 1_290_000, monthly_cents: 118_000, actual_to_date: 263_500, variance_cents: -9_500 }),
  net: totals({ annual_cents: 2_310_000, monthly_cents: 182_000, actual_to_date: 936_500 }),
  planned_lines: 3,
};

function stub(overrides: Record<string, () => unknown> = {}) {
  setIpcHandlers({
    get_year_plan: () => PLAN,
    set_budget_plan: () => ({ line: FOOD, raised: null }),
    clear_budget_plan: () => null,
    ...overrides,
  });
}

beforeEach(() => {
  resetIpc();
  stub();
});

describe("the arithmetic behind the two amount columns", () => {
  it("converts a monthly figure over the months the line actually runs", () => {
    expect(monthCount("111111111111")).toBe(12);
    expect(monthCount("111000000011")).toBe(5);
    // A malformed mask reads as every month, the same way Rust reads it.
    expect(monthCount("oops")).toBe(12);
    expect(monthCount("000000000000")).toBe(12);

    expect(annualFromMonthly(100_000, "111111111111")).toBe(1_200_000);
    // $180 a month of heating oil over five cold months is $900 a year, not
    // $2,160. Dividing by twelve is what made the old screen lie about
    // seasonal costs, and multiplying by twelve here would be the same bug
    // walking backwards.
    expect(annualFromMonthly(18_000, "111000000011")).toBe(90_000);
  });

  it("groups children under parents and knows which groups are worth showing", () => {
    const parent = line({ category_id: "p", name: "Automobile", has_plan: false });
    const kid = line({ category_id: "k", name: "Fuel", parent_id: "p", has_plan: false });
    const groups = groupPlan([parent, kid]);
    expect(groups).toHaveLength(1);
    expect(groups[0].children.map((c) => c.category_id)).toEqual(["k"]);

    // Nothing planned and nothing spent: not worth a row on the short list.
    expect(groupIsInteresting(groups[0])).toBe(false);
    const spent = line({ category_id: "k", name: "Fuel", parent_id: "p", has_plan: false, actual_cents: [0, 500, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
    expect(groupIsInteresting(groupPlan([parent, spent])[0])).toBe(true);
  });

  it("says a parent had none when the write created its plan", () => {
    expect(raiseNotice(null)).toBeNull();
    expect(raiseNotice({ category_name: "Jordan", target_cents: 750_000, created: true })).toMatch(
      /Jordan had no plan, so it was set to 7,500.00 a month/
    );
    expect(raiseNotice({ category_name: "Jordan", target_cents: 750_000, created: false })).toMatch(
      /Jordan raised to 7,500.00 a month/
    );
  });
});

describe("the grid", () => {
  it("draws income, expenses and the net line, and asks for the year once", async () => {
    render(<YearPlanView />);
    await screen.findByLabelText("Annual plan for Food");
    expect(screen.getByText("Income")).toBeInTheDocument();
    expect(screen.getByText("Expenses")).toBeInTheDocument();
    expect(screen.getByText("Total income")).toBeInTheDocument();
    expect(screen.getByText("Net")).toBeInTheDocument();
    const asked = invokeCalls.filter((c) => c.cmd === "get_year_plan");
    expect(asked).toHaveLength(1);
    expect(asked[0].args).toEqual({ year: new Date().getFullYear() });
  });

  it("writes an annual figure without touching when the line runs", async () => {
    render(<YearPlanView />);
    const box = await screen.findByLabelText("Annual plan for Heating oil");
    await userEvent.clear(box);
    await userEvent.type(box, "1500");
    await userEvent.tab();

    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "set_budget_plan")).toBe(true));
    const call = invokeCalls.find((c) => c.cmd === "set_budget_plan")!;
    expect(call.args).toEqual({
      categoryId: "c-oil",
      year: new Date().getFullYear(),
      annualCents: 150_000,
      months: "111000000011",
      // §143 — the line's own reading travels with the write, so editing a
      // figure never quietly changes what its mask MEANS.
      spread: "spent",
    });
  });

  it("turns a monthly figure into the year over the months that line runs", async () => {
    render(<YearPlanView />);
    const box = await screen.findByLabelText("Monthly plan for Heating oil");
    await userEvent.clear(box);
    await userEvent.type(box, "300");
    await userEvent.tab();

    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "set_budget_plan")).toBe(true));
    // $300 a month over five months is $1,500 a year.
    expect(invokeCalls.find((c) => c.cmd === "set_budget_plan")!.args.annualCents).toBe(150_000);
  });

  it("writes nothing when the amount has not changed", async () => {
    render(<YearPlanView />);
    const box = await screen.findByLabelText("Annual plan for Food");
    await userEvent.click(box);
    await userEvent.tab();
    expect(invokeCalls.some((c) => c.cmd === "set_budget_plan")).toBe(false);
  });

  it("never paints an income month red, however far off the plan it is", async () => {
    render(<YearPlanView />);
    await screen.findByLabelText("Annual plan for Food");
    const rowOf = (id: string) => document.querySelector(`tr[data-category-id="${id}"]`)!;

    // Pension's January is three times its monthly share — a lump sum, and
    // not a fault. February's food is over its share and IS red.
    const pension = within(rowOf("c-pension") as HTMLElement).getByText("9,000.00");
    expect(pension).not.toHaveClass("money-neg");
    const food = within(rowOf("c-food") as HTMLElement).getByText("1,100.00");
    expect(food).toHaveClass("money-neg");
  });

  it("a month a line does not run reads as a dash, not as nothing spent", async () => {
    render(<YearPlanView />);
    await screen.findByLabelText("Annual plan for Heating oil");
    const row = document.querySelector('tr[data-category-id="c-oil"]') as HTMLElement;
    // July: heating oil does not run, so it is a dash rather than 0.00.
    expect(within(row).getAllByText("—").length).toBeGreaterThan(0);
  });

  it("changing the months keeps the year's cost and moves the monthly figure", async () => {
    render(<YearPlanView />);
    await userEvent.click(await screen.findByLabelText("When Heating oil runs"));
    const dlg = await screen.findByRole("dialog", { name: "When does this run" });
    // Two of the five are dropped; what it costs for the year must not move.
    await userEvent.click(within(dlg).getByLabelText("Nov"));
    await userEvent.click(within(dlg).getByLabelText("Dec"));
    // §152 — an EXPENSE that stops running all year is assumed to be saved
    // for, so this now reads as a set-aside: $900 over twelve months with
    // three due months, not $300 in each of three.
    expect(within(dlg).getByLabelText("What this means")).toHaveTextContent(
      "set aside every month, all twelve"
    );
    await userEvent.click(within(dlg).getByRole("button", { name: "OK" }));

    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "set_budget_plan")).toBe(true));
    const call = invokeCalls.find((c) => c.cmd === "set_budget_plan")!;
    expect(call.args.months).toBe("111000000000");
    expect(call.args.annualCents).toBe(90_000);
    expect(call.args.spread).toBe("aside");
  });

  /// §152 — spent-only is still there, one click away, for an expense that
  /// really is seasonal rather than saved for.
  it("still lets an expense be spent-only when that is what is meant", async () => {
    render(<YearPlanView />);
    await userEvent.click(await screen.findByLabelText("When Heating oil runs"));
    const dlg = await screen.findByRole("dialog", { name: "When does this run" });
    await userEvent.click(within(dlg).getByLabelText("Nov"));
    await userEvent.click(within(dlg).getByRole("radio", { name: /Spent only in these months/ }));
    expect(within(dlg).getByLabelText("What this means")).toHaveTextContent(
      "expected in each of 4 months"
    );
    await userEvent.click(within(dlg).getByRole("button", { name: "OK" }));

    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "set_budget_plan")).toBe(true));
    expect(invokeCalls.find((c) => c.cmd === "set_budget_plan")!.args.spread).toBe("spent");
  });

  /// §152 — and INCOME is left alone. Acme Corp over July to October is
  /// money that ARRIVES then; a twelfth of it would claim $1,500 landing in
  /// January when nothing does.
  it("does not assume income is saved for", async () => {
    render(<YearPlanView />);
    await userEvent.click(await screen.findByLabelText("When Pension runs"));
    const dlg = await screen.findByRole("dialog", { name: "When does this run" });
    await userEvent.click(within(dlg).getByLabelText("Jul"));
    await userEvent.click(within(dlg).getByRole("button", { name: "OK" }));

    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "set_budget_plan")).toBe(true));
    expect(invokeCalls.find((c) => c.cmd === "set_budget_plan")!.args.spread).toBe("spent");
  });

  it("refuses a spread with no months in it", async () => {
    render(<YearPlanView />);
    await userEvent.click(await screen.findByLabelText("When Heating oil runs"));
    const dlg = await screen.findByRole("dialog", { name: "When does this run" });
    for (const m of ["Jan", "Feb", "Mar", "Nov", "Dec"]) {
      await userEvent.click(within(dlg).getByLabelText(m));
    }
    // §152 — unticking made this a set-aside line (it is an expense), so the
    // empty-mask message is the set-aside one: the mask's whole job there is
    // to say when the bill lands.
    expect(within(dlg).getByLabelText("What this means")).toHaveTextContent(
      "Pick the month the bill is paid in"
    );
    expect(within(dlg).getByRole("button", { name: "OK" })).toBeDisabled();
  });

  it("clears a plan, and says so to the backend rather than writing a zero", async () => {
    render(<YearPlanView />);
    await userEvent.click(await screen.findByLabelText("Clear the plan for Food"));
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "clear_budget_plan")).toBe(true));
    expect(invokeCalls.find((c) => c.cmd === "clear_budget_plan")!.args).toEqual({
      categoryId: "c-food",
      year: new Date().getFullYear(),
    });
    expect(invokeCalls.some((c) => c.cmd === "set_budget_plan")).toBe(false);
  });

  it("says so when a parent had to be moved to cover its children", async () => {
    stub({
      set_budget_plan: () => ({
        line: FOOD,
        raised: { category_id: "c-auto", category_name: "Automobile", target_cents: 66_000, created: false },
      }),
    });
    render(<YearPlanView />);
    const box = await screen.findByLabelText("Annual plan for Food");
    await userEvent.clear(box);
    await userEvent.type(box, "13000");
    await userEvent.tab();
    expect(await screen.findByText(/Automobile raised to 660.00 a month/)).toBeInTheDocument();
  });

  // A screen whose every figure comes off the totals must not render a blank
  // app when the totals are missing. Found by App.nav.test, which stubs every
  // command with [].
  it("says so rather than going blank when the answer is not a plan", async () => {
    stub({ get_year_plan: () => [] });
    render(<YearPlanView />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/shape this screen cannot read/);
  });

  // §140 — a nineteen-column grid needs an anchor in both directions.
  it("shades alternate rows and marks the month in progress", async () => {
    render(<YearPlanView />);
    await screen.findByLabelText("Annual plan for Food");
    const rowOf = (id: string) => document.querySelector(`tr[data-category-id="${id}"]`) as HTMLElement;

    // Food is the first expense row and Heating oil the second, so exactly one of
    // them carries the shading.
    expect(rowOf("c-food").className).not.toMatch(/tm-plan-alt/);
    expect(rowOf("c-oil").className).toMatch(/tm-plan-alt/);

    // The current month is tinted only in the current year, and the header
    // and the body agree about which column that is.
    const month = new Date().getMonth() + 1;
    const marked = rowOf("c-food").querySelectorAll("td.tm-plan-now");
    expect(marked).toHaveLength(1);
    const cells = [...rowOf("c-food").querySelectorAll("td.tm-plan-month")];
    expect(cells.indexOf(marked[0] as HTMLTableCellElement)).toBe(month - 1);
    expect(document.querySelectorAll("th.tm-plan-now")).toHaveLength(1);
  });

  it("marks no month at all in a year that is not this one", async () => {
    render(<YearPlanView />);
    await screen.findByLabelText("Annual plan for Food");
    await userEvent.click(screen.getByRole("button", { name: "Previous year" }));
    await waitFor(() =>
      expect(invokeCalls.filter((c) => c.cmd === "get_year_plan")).toHaveLength(2)
    );
    // Tinting January of a year you are not in would be a lie about which
    // figures are real.
    await waitFor(() => expect(document.querySelectorAll("td.tm-plan-now")).toHaveLength(0));
  });

  it("moves between years and asks the backend for the one on screen", async () => {
    render(<YearPlanView />);
    await screen.findByLabelText("Annual plan for Food");
    await userEvent.click(screen.getByRole("button", { name: "Previous year" }));
    await waitFor(() =>
      expect(invokeCalls.filter((c) => c.cmd === "get_year_plan")).toHaveLength(2)
    );
    const last = invokeCalls.filter((c) => c.cmd === "get_year_plan").pop()!;
    expect(last.args).toEqual({ year: new Date().getFullYear() - 1 });
  });
});

describe("§143 — set aside monthly, paid in these months", () => {
  // > "I still want that bill's monthly amount in all the other months
  // >  because those are the months where that smaller monthly amount is put
  // >  into a savings account"
  const birchLane = () =>
    line({
      category_id: "c-ins",
      name: "Home insurance",
      annual_cents: 120_000,
      monthly_cents: 10_000,
      payment_cents: 120_000,
      spread: "aside",
      months: "100000000000",
      months_label: "Jan",
    });

  it("says both numbers in the Spread over column, not one of them", () => {
    // The monthly figure is what you SAVE; the payment is what LEAVES. A
    // label that gave only one would be the bug this section exists to fix.
    expect(spreadLabel(birchLane())).toBe("100.00 a month \u00b7 1,200.00 due Jan");
  });

  it("leaves a spent line saying exactly what it always said", () => {
    const oil = line({
      category_id: "c-oil",
      name: "Heating oil",
      months: "111000000011",
      months_label: "Nov\u2013Mar",
    });
    expect(spreadLabel(oil)).toBe("Nov\u2013Mar");
  });

  it("marks only the months an aside bill is due", () => {
    const l = birchLane();
    expect(isDueMonth(l, 0)).toBe(true);
    expect(isDueMonth(l, 6)).toBe(false);
  });

  it("marks nothing on a spent line, because every month it runs carries its own figure", () => {
    const oil = line({ category_id: "c-p", name: "Heating oil", months: "111000000011" });
    expect([...Array(12).keys()].some((i) => isDueMonth(oil, i))).toBe(false);
  });

  it("reads the due months as a sentence", () => {
    expect(monthsPhrase("100000000000")).toBe("Jan");
    expect(monthsPhrase("100000100000")).toBe("Jan and Jul");
    expect(monthsPhrase("100100100000")).toBe("Jan, Apr and Jul");
    expect(monthsPhrase("000000000000")).toBe("no month");
  });

  it("never paints the due month red \u2014 the bill landing is what the saving was for", async () => {
    // A $1,200 bill in January against a $100 monthly figure would be eleven
    // times over its share. Judged per month it would be red every year, for
    // doing exactly what was planned.
    setIpcHandlers({
      get_year_plan: () => ({
        year: 2026,
        months_elapsed: 12,
        income: [],
        expenses: [
          {
            ...birchLane(),
            actual_cents: [120_000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            actual_to_date: 120_000,
            expected_to_date: 120_000,
            variance_cents: 0,
          },
        ],
        income_total: totals(),
        expense_total: totals(),
        net: totals(),
      }),
    });
    render(<YearPlanView />);
    const cell = await screen.findByTitle("Home insurance is due in Jan");
    expect(cell.className).not.toContain("money-neg");
    expect(cell.className).toContain("tm-plan-due");
  });
});

describe("§144 — a month with nothing in it shows what it is planned to be", () => {
  // > "it should have the monthly amount until an actual categorized item is
  // >  entered... the amount for the spread over payment should land in the
  // >  month(s) selected replacing the lower monthly amount."
  const autoIns = () =>
    line({
      category_id: "c-auto",
      name: "Auto insurance",
      annual_cents: 400_000,
      monthly_cents: 34_000,
      payment_cents: 200_000,
      spread: "aside",
      months: "000000100001",
      months_label: "Jul, Dec",
    });

  it("projects the payment into the months it is due and the saving into the rest", () => {
    const l = autoIns();
    // Standing in January, so every due month is still ahead.
    expect(projectedCents(l, 6, 1)).toBe(200_000); // July: the bill
    expect(projectedCents(l, 11, 1)).toBe(200_000); // December: the bill
    expect(projectedCents(l, 7, 1)).toBe(34_000); // August: what you set aside
    expect(projectedCents(l, 0, 1)).toBe(34_000); // January: likewise
  });

  /// §151 — insurance due Jan and Jul, paid in June, and January
  /// still promising a 2,000 payment nine months after it did not happen.
  it("does not promise a payment in a due month that has already gone by", () => {
    const l = autoIns();
    // Standing in September. January is over and nothing was paid in it.
    expect(projectedCents(l, 0, 9)).toBe(34_000);
    // July is over too.
    expect(projectedCents(l, 6, 9)).toBe(34_000);
    // December has not happened, so that bill is still to come.
    expect(projectedCents(l, 11, 9)).toBe(200_000);
  });

  it("projects nothing into a month a seasonal line does not run", () => {
    const oil = line({
      category_id: "c-p",
      name: "Heating oil",
      monthly_cents: 18_000,
      months: "111000000011",
    });
    expect(projectedCents(oil, 0)).toBe(18_000); // January: it runs
    expect(projectedCents(oil, 6)).toBe(null); // July: it does not
  });

  it("projects nothing for a line with no plan — there is no figure to project", () => {
    const none = line({ category_id: "c-x", name: "Sundries", has_plan: false });
    expect(projectedCents(none, 3)).toBe(null);
  });

  it("draws a projection as an estimate, never as a fact", async () => {
    // "There's never live data in there until it's actually been paid from an
    // account." A projected figure and a recorded one must not read alike.
    setIpcHandlers({
      get_year_plan: () => ({
        year: 2026,
        months_elapsed: 7,
        income: [],
        expenses: [{ ...autoIns(), actual_cents: new Array(12).fill(0) }],
        income_total: totals(),
        expense_total: totals(),
        net: totals(),
      }),
    });
    render(<YearPlanView />);
    const aug = await screen.findByTitle(
      "Auto insurance: 340.00 planned for Aug, nothing recorded yet"
    );
    expect(aug.className).toContain("tm-plan-projected");
    const jul = screen.getByTitle(
      "Auto insurance: 2,000.00 due in Jul — planned, not yet paid"
    );
    expect(jul.className).toContain("tm-plan-projected");
  });

  it("a real figure replaces the projection and stops looking like an estimate", async () => {
    const actual = new Array(12).fill(0);
    actual[6] = 205_000; // the July bill came in at 2,050
    setIpcHandlers({
      get_year_plan: () => ({
        year: 2026,
        months_elapsed: 7,
        income: [],
        expenses: [{ ...autoIns(), actual_cents: actual, actual_to_date: 205_000 }],
        income_total: totals(),
        expense_total: totals(),
        net: totals(),
      }),
    });
    render(<YearPlanView />);
    // July is now a fact: the due marker stays, the estimate wording and
    // styling go. (Queried by title, because "So far" carries the same
    // figure and matching on text alone would find both.)
    const jul = await screen.findByTitle("Auto insurance is due in Jul");
    expect(jul.textContent).toBe("2,050.00");
    expect(jul.className).not.toContain("tm-plan-projected");
    expect(jul.className).toContain("tm-plan-due");
    expect(
      screen.queryByTitle("Auto insurance: 2,000.00 due in Jul — planned, not yet paid")
    ).toBeNull();
    // ...and August, still unpaid, is still an estimate.
    expect(
      screen.getByTitle("Auto insurance: 340.00 planned for Aug, nothing recorded yet").className
    ).toContain("tm-plan-projected");
  });

  it("multiplies a set-aside monthly figure by twelve, not by its due months", () => {
    // §143 — the mask names when the bill lands, not when it is funded. Over
    // its two due months, $340 would read as a $680 year.
    expect(annualFromMonthly(34_000, "000000100001", "aside")).toBe(408_000);
    expect(annualFromMonthly(34_000, "000000100001", "spent")).toBe(68_000);
  });
});

describe("§145 — what is put by, and what it is called", () => {
  it("calls a set-aside line's last column a balance, not a variance", () => {
    // expected_to_date accrues every elapsed month INCLUDING the month a bill
    // lands, so this figure is what is still sitting there after the payment.
    const covered = line({
      category_id: "c-auto",
      name: "Auto insurance",
      spread: "aside",
      months: "000000100001",
      variance_cents: 38_000,
    });
    expect(varianceNote(covered)).toBe("Auto insurance: 380.00 saved so far, not yet spent");
  });

  it("names a shortfall as the bill arriving first, which is what it is", () => {
    const short = line({
      category_id: "c-ins",
      name: "Home insurance",
      spread: "aside",
      months: "100000000000",
      variance_cents: -110_000,
    });
    expect(varianceNote(short)).toBe(
      "Home insurance: short by 1,100.00 — the bill came before the saving did"
    );
  });

  it("still reads as a variance on an ordinary line", () => {
    const food = line({ category_id: "c-food", name: "Food", variance_cents: -5_000 });
    expect(varianceNote(food)).toBe("Food: 50.00 over plan, so far");
    const pay = line({ category_id: "c-pay", name: "Pension", kind: "income", variance_cents: 20_000 });
    expect(varianceNote(pay)).toBe("Pension: 200.00 more than planned, so far");
  });

  it("does not put a plus sign on a balance", async () => {
    setIpcHandlers({
      get_year_plan: () => ({
        year: 2026,
        months_elapsed: 7,
        income: [],
        expenses: [
          line({
            category_id: "c-auto",
            name: "Auto insurance",
            spread: "aside",
            months: "000000100001",
            monthly_cents: 34_000,
            payment_cents: 200_000,
            variance_cents: 38_000,
          }),
        ],
        income_total: totals(),
        expense_total: totals(),
        net: totals(),
      }),
    });
    render(<YearPlanView />);
    const cell = await screen.findByTitle("Auto insurance: 380.00 saved so far, not yet spent");
    // No plus sign — and, since §154, the word "saved" beside the figure.
    expect(cell.textContent).toBe("380.00saved");
    expect(cell.textContent).not.toContain("+");
  });
});

describe("\u00a7151 \u2014 emptying an amount box", () => {
  // > "when I put an amount in a child category and then delete it it goes to
  // >  zero and doesn't clear that field... Otherwise it shows up on the
  // >  following month page budget only because it has a 0.00 in it."
  it("clears the line rather than writing a zero into it", async () => {
    render(<YearPlanView />);
    const box = await screen.findByLabelText("Annual plan for Heating oil");
    await userEvent.clear(box);
    await userEvent.tab();

    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "clear_budget_plan")).toBe(true));
    // Rubbing the figure out is not the same act as typing 0, and no longer
    // leaves a 0.00 behind to show up on next month's screen.
    expect(invokeCalls.some((c) => c.cmd === "set_budget_plan")).toBe(false);
  });

  /// §151 — and the one that was actively creating plans nobody asked for.
  ///
  /// > "if I click in to the Monthly box and tab out it puts 0.00 in both
  /// >  monthly and annual and that's bad - it needs to stay blank unless an
  /// >  actual amount is entered"
  it("does nothing at all when an empty box on an unplanned line is tabbed through", async () => {
    // A line with money through it but NO plan, so both boxes are empty and
    // the row is still drawn.
    setIpcHandlers({
      get_year_plan: () => ({
        year: 2026,
        months_elapsed: 9,
        income: [],
        expenses: [
          line({
            category_id: "c-books",
            name: "Books",
            has_plan: false,
            annual_cents: 0,
            monthly_cents: 0,
            actual_cents: [0, 0, 4_000, 0, 0, 0, 0, 0, 0, 0, 0, 0],
          }),
        ],
        income_total: totals(),
        expense_total: totals(),
        net: totals(),
      }),
    });
    render(<YearPlanView />);
    const box = await screen.findByLabelText("Monthly plan for Books");
    await userEvent.click(box);
    await userEvent.tab();

    await waitFor(() => expect(screen.getByLabelText("Monthly plan for Books")).toBeInTheDocument());
    expect(invokeCalls.some((c) => c.cmd === "set_budget_plan")).toBe(false);
    expect(invokeCalls.some((c) => c.cmd === "clear_budget_plan")).toBe(false);
  });

  it("still refuses to guess at something that is not a number", async () => {
    render(<YearPlanView />);
    const box = await screen.findByLabelText("Annual plan for Heating oil");
    await userEvent.clear(box);
    await userEvent.type(box, "abc");
    await userEvent.tab();
    await waitFor(() => expect(screen.getByLabelText("Annual plan for Heating oil")).toBeInTheDocument());
    expect(invokeCalls.some((c) => c.cmd === "set_budget_plan")).toBe(false);
  });
});

describe("§154 — the set-aside balance says what it is, on the screen", () => {
  // §151 put "saved so far, not yet spent" in the cell's TITLE, and the user never
  // saw it: nobody hovers a number. One word beside the figure; the sentence
  // stays as the title.
  const autoIns = (variance: number) =>
    line({
      category_id: "c-auto",
      name: "Auto insurance",
      annual_cents: 400_000,
      monthly_cents: 34_000,
      payment_cents: 200_000,
      spread: "aside",
      months: "000000100001",
      months_label: "Jul, Dec",
      expected_to_date: 38_000,
      actual_to_date: 38_000 - variance,
      variance_cents: variance,
    });
  const year = (l: PlanLine) => ({
    year: 2026,
    months_elapsed: 1,
    income: [],
    expenses: [l],
    income_total: totals(),
    expense_total: totals(),
    net: totals(),
  });

  it("writes 'saved' beside the figure, not only in the hover note", async () => {
    setIpcHandlers({ get_year_plan: () => year(autoIns(38_000)) });
    render(<YearPlanView />);
    const cell = await screen.findByTitle("Auto insurance: 380.00 saved so far, not yet spent");
    expect(cell.textContent).toBe("380.00saved");
    expect(cell.querySelector(".tm-plan-word")?.textContent).toBe("saved");
  });

  it("writes 'short' when the bill came before the saving did", async () => {
    setIpcHandlers({ get_year_plan: () => year(autoIns(-12_000)) });
    render(<YearPlanView />);
    const cell = await screen.findByTitle(
      "Auto insurance: short by 120.00 — the bill came before the saving did"
    );
    expect(cell.textContent).toBe("−120.00short");
  });

  it("leaves an ordinary line's variance alone", async () => {
    setIpcHandlers({
      get_year_plan: () =>
        year(line({ category_id: "c-food", name: "Food", annual_cents: 120_000, monthly_cents: 10_000, variance_cents: -5_000 })),
    });
    render(<YearPlanView />);
    const cell = await screen.findByTitle("Food: 50.00 over plan, so far");
    expect(cell.textContent).toBe("−50.00");
  });
});

describe("§156 — Ctrl+F finds a budget line, not a transaction", () => {
  it("narrows the page to the categories that match, planned or not", async () => {
    const user = userEvent.setup();
    render(<YearPlanView />);
    await screen.findByText("Food");
    expect(screen.getByText("Heating oil")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Find on this page"), "heat");
    expect(screen.getByText("Heating oil")).toBeInTheDocument();
    expect(screen.queryByText("Food")).toBeNull();

    await user.clear(screen.getByLabelText("Find on this page"));
    expect(await screen.findByText("Food")).toBeInTheDocument();
  });

  it("says so when nothing on the page matches", async () => {
    const user = userEvent.setup();
    render(<YearPlanView />);
    await screen.findByText("Food");
    await user.type(screen.getByLabelText("Find on this page"), "mortgage");
    expect(screen.getByRole("status")).toHaveTextContent("No category on this page matches “mortgage”");
  });

  it("takes Ctrl+F while it is on screen, and Escape clears it", async () => {
    const user = userEvent.setup();
    render(<YearPlanView />);
    await screen.findByText("Food");
    expect(runCommand("edit.find")).toBe(true);
    const box = screen.getByLabelText("Find on this page");
    expect(box).toHaveFocus();
    await user.type(box, "heat");
    expect(screen.queryByText("Food")).toBeNull();
    await user.keyboard("{Escape}");
    expect(box).toHaveValue("");
    expect(await screen.findByText("Food")).toBeInTheDocument();
  });
});

describe("§183 — a year's figures stay under that year", () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }
  const THIS_YEAR = new Date().getFullYear();
  const named = (n: string): YearPlan => ({ ...PLAN, expenses: [line({ category_id: "c-food", name: n, annual_cents: 1_200_000, monthly_cents: 100_000 })] });

  it("keeps the year buttons still while a typed figure is being saved", async () => {
    const saving = deferred<unknown>();
    stub({ set_budget_plan: () => saving.promise });
    render(<YearPlanView />);
    const box = await screen.findByLabelText("Annual plan for Heating oil");
    await userEvent.clear(box);
    await userEvent.type(box, "1500");
    // Clicking › is what blurs the box: the save starts, and the button it
    // was pressed on is already held.
    await userEvent.click(screen.getByRole("button", { name: "Next year" }));
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "set_budget_plan")).toBe(true));
    expect(screen.getByRole("button", { name: "Next year" })).toBeDisabled();
    expect(invokeCalls.filter((c) => c.cmd === "get_year_plan").map((c) => c.args.year)).toEqual([THIS_YEAR]);
    expect(invokeCalls.find((c) => c.cmd === "set_budget_plan")!.args.year).toBe(THIS_YEAR);

    saving.resolve({ line: OIL, raised: null });
    await waitFor(() => expect(screen.getByRole("button", { name: "Next year" })).toBeEnabled());
  });

  it("never puts a slow answer for the old year under the new year's heading", async () => {
    const slow = deferred<YearPlan>();
    stub({
      get_year_plan: (args?: unknown) => {
        const y = (args as { year: number }).year;
        return y === THIS_YEAR ? slow.promise : named(`Food of ${y}`);
      },
    } as Record<string, () => unknown>);
    render(<YearPlanView />);
    await userEvent.click(screen.getByRole("button", { name: "Next year" }));
    expect(await screen.findByText(`Food of ${THIS_YEAR + 1}`)).toBeInTheDocument();

    slow.resolve(named(`Food of ${THIS_YEAR}`));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(`Food of ${THIS_YEAR}`)).toBeNull();
    expect(screen.getByText(`Food of ${THIS_YEAR + 1}`)).toBeInTheDocument();
    expect(screen.getByText(`${THIS_YEAR + 1} budget`)).toBeInTheDocument();
  });

  it("says so when a typed amount cannot be read, rather than dropping it", async () => {
    render(<YearPlanView />);
    const box = await screen.findByLabelText("Annual plan for Heating oil");
    await userEvent.clear(box);
    await userEvent.type(box, "abc");
    await userEvent.tab();
    expect(await screen.findByRole("alert")).toHaveTextContent('"abc" is not an amount');
    expect(invokeCalls.some((c) => c.cmd === "set_budget_plan")).toBe(false);
  });
});
