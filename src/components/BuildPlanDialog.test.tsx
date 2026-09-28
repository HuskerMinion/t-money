// §141 — build next year from what this year did.
//
// The whole value of this screen is in what it decides FOR you, so that is
// what is tested: a job that stopped arrives unticked, a job that started
// arrives at its running rate rather than a twelfth of it, and what gets
// written is the monthly figure over the months the line runs — never over
// twelve, which would turn a five-month line into a twelve-month one on its
// way through the dialog.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

import BuildPlanDialog, { picksFrom, rowsFrom, summaryOf } from "./BuildPlanDialog";
import { invokeCalls, resetIpc, setIpcHandlers } from "../test/tauriMock";
import type { PlanProposal } from "../lib/types";

function proposal(over: Partial<PlanProposal> & { category_id: string; name: string }): PlanProposal {
  return {
    full_name: over.name,
    parent_id: null,
    kind: "expense",
    actual_cents: 0,
    active_months: 12,
    first_month: 1,
    last_month: 12,
    basis: "twelve",
    note: "all of 2026",
    plain_monthly_cents: 0,
    suggested_monthly_cents: 0,
    suggested_annual_cents: 0,
    months: "111111111111",
    months_label: "every month",
    spread: "spent",
    include: true,
    existing_annual_cents: null,
    ...over,
  };
}

const GONE = proposal({
  category_id: "c-gone",
  name: "Old job",
  kind: "income",
  actual_cents: 3_000_000,
  active_months: 10,
  last_month: 10,
  basis: "ended",
  note: "nothing since Oct",
  plain_monthly_cents: 250_000,
  suggested_monthly_cents: 250_000,
  suggested_annual_cents: 3_000_000,
  include: false,
});

const FRESH = proposal({
  category_id: "c-fresh",
  name: "New job",
  kind: "income",
  actual_cents: 1_280_000,
  active_months: 4,
  first_month: 9,
  basis: "running",
  note: "started in Sep — this is its rate over 4 months, not a twelfth of the year",
  plain_monthly_cents: 106_666,
  suggested_monthly_cents: 320_000,
  suggested_annual_cents: 3_840_000,
});

const OIL = proposal({
  category_id: "c-oil",
  name: "Heating oil",
  actual_cents: 87_000,
  active_months: 5,
  months: "111000000011",
  months_label: "Nov–Mar",
  plain_monthly_cents: 7_250,
  suggested_monthly_cents: 18_000,
  suggested_annual_cents: 90_000,
});

const INSURANCE = proposal({
  category_id: "c-insurance",
  name: "Home insurance",
  actual_cents: 352_600,
  active_months: 1,
  last_month: 1,
  months: "100000000000",
  months_label: "Jan",
  spread: "aside",
  plain_monthly_cents: 29_383,
  suggested_monthly_cents: 30_000,
  suggested_annual_cents: 360_000,
});

const FOOD = proposal({
  category_id: "c-food",
  name: "Food",
  actual_cents: 1_163_500,
  plain_monthly_cents: 96_958,
  suggested_monthly_cents: 97_000,
  suggested_annual_cents: 1_164_000,
  existing_annual_cents: 1_200_000,
});

function stub(proposals: PlanProposal[] = [GONE, FRESH, OIL, FOOD], overrides = {}) {
  setIpcHandlers({
    plan_from_history: () => proposals,
    apply_year_plan: () => proposals.length,
    ...overrides,
  });
}

beforeEach(() => {
  resetIpc();
  stub();
});

describe("what the dialog decides before you look at it", () => {
  it("keeps a seasonal line seasonal on the way out", () => {
    const rows = rowsFrom([OIL]);
    // $180 a month over five months is $900 a year. Multiplying by twelve
    // here is the one mistake that would silently double a heating budget.
    expect(picksFrom(rows)).toEqual([
      { category_id: "c-oil", annual_cents: 90_000, months: "111000000011", spread: "spent" },
    ]);
  });

  // §179 — a set-aside line's monthly figure is a twelfth of the bill, set
  // aside every month; its mask only says when the bill is due. Written back
  // over the mask's one month, and without its spread, it arrived as a $300
  // January and nothing else.
  it("keeps a set-aside line set aside, over twelve months", () => {
    expect(picksFrom(rowsFrom([INSURANCE]))).toEqual([
      { category_id: "c-insurance", annual_cents: 360_000, months: "100000000000", spread: "aside" },
    ]);
  });

  it("leaves out what is not ticked", () => {
    expect(picksFrom(rowsFrom([GONE, FRESH]))).toHaveLength(1);
    expect(picksFrom(rowsFrom([GONE, FRESH]))[0].category_id).toBe("c-fresh");
  });

  it("counts what it is about to write, and what it will write over", () => {
    expect(summaryOf(rowsFrom([GONE, FRESH]), 2027)).toBe("1 line into 2027");
    expect(summaryOf(rowsFrom([FRESH, FOOD]), 2027)).toBe(
      "2 lines into 2027, 1 of them over a figure already there"
    );
    expect(summaryOf([], 2027)).toBe("0 lines into 2027");
  });
});

describe("the dialog", () => {
  it("reads the year before, and arrives with the ended job unticked", async () => {
    render(<BuildPlanDialog year={2027} onCancel={() => {}} onApplied={() => {}} />);
    const gone = await screen.findByLabelText("Carry Old job into 2027");
    expect(gone).not.toBeChecked();
    expect(screen.getByLabelText("Carry New job into 2027")).toBeChecked();
    expect(screen.getByText("nothing since Oct")).toBeInTheDocument();
    expect(invokeCalls.find((c) => c.cmd === "plan_from_history")!.args).toEqual({
      fromYear: 2026,
      toYear: 2027,
    });
  });

  it("shows what a twelfth would have said for a job that started mid-year", async () => {
    render(<BuildPlanDialog year={2027} onCancel={() => {}} onApplied={() => {}} />);
    await screen.findByLabelText("Carry New job into 2027");
    // The figure it proposes is the rate; the twelfth is shown so the number
    // is checkable rather than asserted.
    expect(screen.getByLabelText("Monthly for New job")).toHaveValue("3,200.00");
    expect(screen.getByText(/a twelfth would be 1,066.66/)).toBeInTheDocument();
  });

  it("warns when a proposal would land on a figure already planned", async () => {
    render(<BuildPlanDialog year={2027} onCancel={() => {}} onApplied={() => {}} />);
    await screen.findByLabelText("Carry Food into 2027");
    expect(screen.getByText(/replaces 12,000.00 already planned/)).toBeInTheDocument();
    // Untick it and the warning goes with it — it is only true of a line that
    // is actually about to be written.
    await userEvent.click(screen.getByLabelText("Carry Food into 2027"));
    expect(screen.queryByText(/replaces 12,000.00 already planned/)).toBeNull();
  });

  it("writes the ticked lines, with an edited figure carried through", async () => {
    const onApplied = vi.fn();
    render(<BuildPlanDialog year={2027} onCancel={() => {}} onApplied={onApplied} />);
    await screen.findByLabelText("Carry New job into 2027");

    const box = screen.getByLabelText("Monthly for Heating oil");
    await userEvent.clear(box);
    await userEvent.type(box, "300");
    await userEvent.tab();

    await userEvent.click(screen.getByRole("button", { name: "Write these into 2027" }));
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "apply_year_plan")).toBe(true));
    const call = invokeCalls.find((c) => c.cmd === "apply_year_plan")!;
    expect(call.args.year).toBe(2027);
    const lines = call.args.lines as { category_id: string; annual_cents: number; months: string }[];
    // The ended job is not in it; the edited heating oil figure is, at $300 over
    // five months rather than over twelve.
    expect(lines.map((l) => l.category_id)).toEqual(["c-fresh", "c-oil", "c-food"]);
    expect(lines.find((l) => l.category_id === "c-oil")).toEqual({
      category_id: "c-oil",
      annual_cents: 150_000,
      months: "111000000011",
      spread: "spent",
    });
    expect(onApplied).toHaveBeenCalled();
  });

  it("shows and writes a set-aside line's annual figure over twelve months", async () => {
    stub([INSURANCE]);
    render(<BuildPlanDialog year={2027} onCancel={() => {}} onApplied={() => {}} />);
    const box = await screen.findByLabelText("Monthly for Home insurance");
    expect(box).toHaveValue("300.00");
    const row = box.closest("tr")!;
    expect(within(row).getByText("3,600.00")).toBeInTheDocument();

    await userEvent.clear(box);
    await userEvent.type(box, "310");
    await userEvent.tab();
    expect(within(row).getByText("3,720.00")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Write these into 2027" }));
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "apply_year_plan")).toBe(true));
    const call = invokeCalls.find((c) => c.cmd === "apply_year_plan")!;
    expect(call.args.lines).toEqual([
      { category_id: "c-insurance", annual_cents: 372_000, months: "100000000000", spread: "aside" },
    ]);
  });

  it("says there is nothing to go on rather than showing an empty table", async () => {
    stub([]);
    render(<BuildPlanDialog year={2027} onCancel={() => {}} onApplied={() => {}} />);
    expect(await screen.findByText(/Nothing in 2026 to go on/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Write these into 2027" })).toBeDisabled();
  });

  it("keeps the dialog open and says why when the write is refused", async () => {
    const onApplied = vi.fn();
    stub(undefined, {
      apply_year_plan: () => {
        throw new Error("nope");
      },
    });
    render(<BuildPlanDialog year={2027} onCancel={() => {}} onApplied={onApplied} />);
    await screen.findByLabelText("Carry New job into 2027");
    await userEvent.click(screen.getByRole("button", { name: "Write these into 2027" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/nope/);
    expect(onApplied).not.toHaveBeenCalled();
  });
});

describe("§183 — the dialog while it works, and a figure it cannot take", () => {
  it("ignores a click outside while the write is running", async () => {
    let finish!: (n: number) => void;
    stub(undefined, { apply_year_plan: () => new Promise<number>((r) => (finish = r)) });
    const onCancel = vi.fn();
    render(<BuildPlanDialog year={2027} onCancel={onCancel} onApplied={() => {}} />);
    await screen.findByLabelText("Carry New job into 2027");
    await userEvent.click(screen.getByRole("button", { name: "Write these into 2027" }));
    await userEvent.click(document.querySelector(".tm-dialog-backdrop")!);
    expect(onCancel).not.toHaveBeenCalled();
    finish(3);
  });

  it("says why a negative or unreadable monthly figure was put back", async () => {
    render(<BuildPlanDialog year={2027} onCancel={() => {}} onApplied={() => {}} />);
    const box = await screen.findByLabelText("Monthly for Heating oil");
    await userEvent.clear(box);
    await userEvent.type(box, "-5");
    await userEvent.tab();
    expect(await screen.findByRole("alert")).toHaveTextContent(/cannot be negative/);
    expect(box).toHaveValue("180.00");

    await userEvent.clear(box);
    await userEvent.type(box, "lots");
    await userEvent.tab();
    expect(screen.getByRole("alert")).toHaveTextContent(/"lots" is not an amount/);
  });
});
