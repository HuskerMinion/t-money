// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import BillCalendar, { monthGrid, monthRange, shiftMonth } from "./BillCalendar";
import type { Occurrence } from "../lib/types";

function occ(over: Partial<Occurrence> = {}): Occurrence {
  return {
    recurrence_id: "r-1",
    payee: "Anytown Properties",
    amount_cents: -145_000,
    account_id: "acc-1",
    account_name: "Checking",
    category_id: null,
    category_name: null,
    due_date: "2026-09-01",
    status: "due",
    transaction_id: null,
    actual_amount_cents: null,
    ...over,
  };
}

describe("the bill calendar (§52)", () => {
  it("walks months and lays the grid out from the right weekday", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-09", -12)).toBe("2025-09");
    expect(monthRange("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(monthRange("2028-02").to).toBe("2028-02-29");
    const g = monthGrid("2026-09"); // 1 Sep 2026 is a Tuesday
    expect(g[0]).toEqual([null, null, "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"]);
    expect(g[g.length - 1].filter(Boolean).pop()).toBe("2026-09-30");
    expect(g.every((r) => r.length === 7)).toBe(true);
  });

  it("puts each bill on its day, colored by status, and totals the month", async () => {
    const onPick = vi.fn();
    const onDay = vi.fn();
    const onMonth = vi.fn();
    const items = [
      occ(),
      occ({ recurrence_id: "r-2", payee: "Employer", amount_cents: 300_000, due_date: "2026-09-15", status: "matched", actual_amount_cents: 301_000 }),
      occ({ recurrence_id: "r-3", payee: "Gym", amount_cents: -4_000, due_date: "2026-09-15", status: "skipped" }),
      occ({ recurrence_id: "r-4", payee: "Water", amount_cents: -6_000, due_date: "2026-09-03", status: "overdue" }),
    ];
    render(<BillCalendar month="2026-09" occurrences={items} today="2026-09-06" onMonth={onMonth} onDayDoubleClick={onDay} onPick={onPick} />);
    expect(screen.getByText("September 2026")).toBeInTheDocument();
    const first = screen.getByRole("gridcell", { name: "2026-09-01" });
    expect(within(first).getByText("Anytown Properties")).toBeInTheDocument();
    expect(within(first).getByText("$1,450.00")).toBeInTheDocument();
    const fifteenth = screen.getByRole("gridcell", { name: "2026-09-15" });
    expect(within(fifteenth).getAllByRole("button")).toHaveLength(2);
    expect(within(fifteenth).getByRole("button", { name: /Employer/ })).toHaveClass("tm-bill-done", "tm-cal-in");
    expect(within(fifteenth).getByRole("button", { name: /Gym/ })).toHaveClass("tm-bill-skipped");
    expect(within(screen.getByRole("gridcell", { name: "2026-09-03" })).getByRole("button", { name: /Water/ })).toHaveClass("tm-bill-overdue");
    expect(screen.getByRole("gridcell", { name: "2026-09-06" })).toHaveClass("tm-cal-today");
    // Skipped is left out of the totals; the matched deposit counts what actually arrived.
    expect(screen.getByText("Out this month: $1,510.00")).toBeInTheDocument();
    expect(screen.getByText("In: $3,010.00")).toBeInTheDocument();

    await userEvent.click(within(first).getByRole("button", { name: /Anytown/ }));
    expect(onPick).toHaveBeenCalledWith(items[0]);
    await userEvent.dblClick(screen.getByRole("gridcell", { name: "2026-09-20" }));
    expect(onDay).toHaveBeenCalledWith("2026-09-20");
    await userEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(onMonth).toHaveBeenCalledWith("2026-10");
  });
});
