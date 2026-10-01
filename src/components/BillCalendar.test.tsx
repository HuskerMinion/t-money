// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import BillCalendar, { monthGrid, monthRange, shiftMonth } from "./BillCalendar";
import type { Account, Occurrence } from "../lib/types";
import { useFileFormat } from "../lib/region";

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

describe("the bill calendar", () => {
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

describe("bills in other currencies", () => {
  it("shows each in its account's currency and totals the month in the home currency", () => {
    const eur = { id: "acc-eur", name: "Euro checking", currency: "EUR", home_rate_micro: 1_100_000 } as Account;
    const items = [
      occ(),
      occ({ recurrence_id: "r-2", payee: "Rent abroad", amount_cents: -50_000, account_id: "acc-eur", account_name: "Euro checking", due_date: "2026-09-02" }),
    ];
    render(<BillCalendar accounts={[eur]} month="2026-09" occurrences={items} today="2026-09-06" onMonth={() => {}} onDayDoubleClick={() => {}} onPick={() => {}} />);
    expect(within(screen.getByRole("gridcell", { name: "2026-09-02" })).getByText("€500.00")).toBeInTheDocument();
    // $1,450 + €500 at 1.10 ($550).
    expect(screen.getByText("Out this month: $2,000.00")).toBeInTheDocument();
    expect(screen.getByText("(US dollars, at today's rates)")).toBeInTheDocument();
  });
});

describe("a file in euros, written the German way", () => {
  it("totals the month in euros and writes a dollar bill as US$", () => {
    useFileFormat.getState().setFormat({ home_currency: "EUR", region: "de-DE" });
    const usd = { id: "acc-usd", name: "Dollar checking", currency: "USD", home_rate_micro: 900_000 } as Account;
    const items = [
      occ({ amount_cents: -123_456 }),
      occ({ recurrence_id: "r-2", payee: "Rent abroad", amount_cents: -50_000, account_id: "acc-usd", account_name: "Dollar checking", due_date: "2026-09-02" }),
    ];
    render(<BillCalendar accounts={[usd]} month="2026-09" occurrences={items} today="2026-09-06" onMonth={() => {}} onDayDoubleClick={() => {}} onPick={() => {}} />);
    expect(within(screen.getByRole("gridcell", { name: "2026-09-01" })).getByText("1.234,56 €")).toBeInTheDocument();
    expect(within(screen.getByRole("gridcell", { name: "2026-09-02" })).getByText("500,00 US$")).toBeInTheDocument();
    // 1.234,56 € + US$500 at 0,90 (450 €).
    expect(screen.getByText("Out this month: 1.684,56 €")).toBeInTheDocument();
    expect(screen.getByText("(euros, at today's rates)")).toBeInTheDocument();
  });
});
