// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

import AutobudgetDialog, { acceptedLines, monthLabel } from "./AutobudgetDialog";
import { invokeCalls, resetIpc, setIpcHandlers } from "../test/tauriMock";
import type { AutobudgetLine } from "../lib/types";

const lines: AutobudgetLine[] = [
  { category_id: "c-elec", category_name: "Electric", average_cents: 9_000, months_with_spending: 1, scheduled_cents: 12_000, suggested_cents: 12_000, current_cents: null },
  { category_id: "c-gift", category_name: "Gifts", average_cents: 0, months_with_spending: 0, scheduled_cents: 5_000, suggested_cents: 5_000, current_cents: null },
  { category_id: "c-groc", category_name: "Groceries", average_cents: 46_670, months_with_spending: 3, scheduled_cents: 0, suggested_cents: 46_700, current_cents: 25_000 },
];

beforeEach(() => {
  resetIpc();
  setIpcHandlers({
    autobudget: (args) => (args.lookback === 3 ? lines.slice(0, 1) : lines),
    apply_autobudget: (args) => (args.lines as unknown[]).length * (args.months as number),
  });
});

describe("Autobudget", () => {
  it("collects the ticked lines and refuses a bad amount", () => {
    expect(acceptedLines(lines, { "c-elec": { on: true, amount: "120.00" }, "c-gift": { on: false, amount: "50" }, "c-groc": { on: true, amount: "$500" } })).toEqual([
      ["c-elec", 12_000],
      ["c-groc", 50_000],
    ]);
    expect(acceptedLines(lines, { "c-elec": { on: true, amount: "abc" } })).toBeNull();
    expect(monthLabel("2026-09")).toBe("September 2026");
  });

  it("proposes, starts a budgeted line unticked, lets amounts change, applies for the chosen months", async () => {
    const onApplied = vi.fn();
    render(<AutobudgetDialog month="2026-09" onCancel={() => {}} onApplied={onApplied} />);
    await screen.findByRole("table", { name: "Autobudget proposals" });
    expect(invokeCalls.find((c) => c.cmd === "autobudget")!.args).toEqual({ month: "2026-09", lookback: 12 });
    expect(screen.getByLabelText("Accept Electric")).toBeChecked();
    expect(screen.getByLabelText("Accept Groceries")).not.toBeChecked();
    expect(screen.getByLabelText("Budget for Groceries")).toBeDisabled();
    expect(screen.getByLabelText("Budget for Electric")).toHaveValue("120.00");
    expect(screen.getByText("2 lines, $170.00 a month.")).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText("Accept Groceries"));
    await userEvent.clear(screen.getByLabelText("Budget for Groceries"));
    await userEvent.type(screen.getByLabelText("Budget for Groceries"), "450");
    expect(screen.getByText("3 lines, $620.00 a month.")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Months to budget"), "3");
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(onApplied).toHaveBeenCalledWith(9, 3));
    expect(invokeCalls.find((c) => c.cmd === "apply_autobudget")!.args).toEqual({
      month: "2026-09",
      months: 3,
      lines: [
        ["c-elec", 12_000],
        ["c-gift", 5_000],
        ["c-groc", 45_000],
      ],
    });
  });

  it("re-proposes when the lookback changes", async () => {
    render(<AutobudgetDialog month="2026-09" onCancel={() => {}} onApplied={() => {}} />);
    await screen.findByLabelText("Accept Groceries");
    await userEvent.selectOptions(screen.getByLabelText("Months of history"), "3");
    await waitFor(() => expect(screen.queryByLabelText("Accept Groceries")).not.toBeInTheDocument());
    expect(screen.getByLabelText("Accept Electric")).toBeInTheDocument();
  });
});
