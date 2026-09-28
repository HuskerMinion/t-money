// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

import DebtPlannerView from "./DebtPlannerView";
import { invokeCalls, resetIpc, setIpcHandlers } from "../test/tauriMock";
import { useAccountStore } from "../stores/useAccountStore";
import type { Account } from "../lib/types";

function acct(id: string, name: string, type: Account["type"], balance_cents: number): Account {
  return {
    id,
    name,
    type,
    balance_cents,
    holdings_value_cents: 0,
    tax_included: true,
    is_favorite: false,
    is_closed: false,
    updated_at: "2026-08-30T00:00:00Z",
    institution: null,
    account_number: null,
    routing_number: null,
    opened_on: null,
    credit_limit_cents: null,
    contact_phone: null,
    contact_email: null,
    website: null,
    address: null,
    account_notes: null,
  };
}

const accounts = [acct("a-chk", "Checking", "checking", 500_000), acct("a-visa", "Visa", "credit", -50_000), acct("a-truck", "Truck loan", "loan", -200_000), acct("a-paid", "Old card", "credit", 0)];

let stored: string | null = null;

beforeEach(() => {
  resetIpc();
  stored = null;
  setIpcHandlers({
    get_all_accounts: () => accounts,
    get_ui_setting: () => stored,
    set_ui_setting: (args) => {
      stored = args.value as string;
      return null;
    },
  });
  useAccountStore.setState({ accounts });
});

describe("the Debt Reduction Planner (§55)", () => {
  it("lists the debts, plans them with a budget, and keeps the rates", async () => {
    render(<DebtPlannerView />);
    const table = await screen.findByRole("table", { name: "Debts" });
    // Only accounts that owe something; the checking account and the paid-off card are not debts.
    expect(table).toHaveTextContent("Visa");
    expect(table).toHaveTextContent("Truck loan");
    expect(table).not.toHaveTextContent("Checking");
    expect(table).not.toHaveTextContent("Old card");
    await userEvent.type(screen.getByLabelText("Rate for Visa"), "21.99");
    await userEvent.type(screen.getByLabelText("Minimum payment for Visa"), "25");
    await userEvent.type(screen.getByLabelText("Rate for Truck loan"), "6.5");
    await userEvent.type(screen.getByLabelText("Minimum payment for Truck loan"), "150");
    await userEvent.type(screen.getByLabelText("Monthly budget"), "300");
    const result = screen.getByLabelText("Plan result");
    expect(result).toHaveTextContent(/Debt-free in \d+ months/);
    expect(screen.getByLabelText("Payoff for Visa")).not.toHaveTextContent("—");
    // Everything typed was saved to the file's setting.
    await waitFor(() => expect(invokeCalls.filter((c) => c.cmd === "set_ui_setting").length).toBeGreaterThan(0));
    expect(JSON.parse(stored!)).toMatchObject({ rates: { "a-visa": { apr: "21.99", min: "25" } }, budget: "300", order: "highest_rate" });
    // Under the minimums: says so in dollars.
    await userEvent.clear(screen.getByLabelText("Monthly budget"));
    await userEvent.type(screen.getByLabelText("Monthly budget"), "100");
    expect(screen.getByLabelText("Plan result")).toHaveTextContent("below the minimum payments ($175.00 a month)");
  });

  it("the one-debt planner answers both questions and shows the schedule", async () => {
    stored = JSON.stringify({ rates: { "a-visa": { apr: "12", min: "25" } }, budget: "", order: "highest_rate" });
    render(<DebtPlannerView />);
    await screen.findByRole("table", { name: "Debts" });
    await waitFor(() => expect(screen.getByLabelText("Rate for Visa")).toHaveValue("12"));
    // $500 at 12%, $100 a month → 6 months.
    await userEvent.type(screen.getByLabelText("Monthly payment"), "100");
    expect(screen.getByLabelText("Mini plan result")).toHaveTextContent(/Paid off in 6 months/);
    await userEvent.click(screen.getByRole("button", { name: "Show the schedule" }));
    const rows = screen.getAllByRole("row").filter((r) => r.closest("table")?.getAttribute("aria-label") === "Payment schedule");
    expect(rows.length).toBe(7); // header + 6
    // Deadline mode: the payment for 12 months.
    await userEvent.click(screen.getByLabelText(/Done in/));
    await userEvent.clear(screen.getByLabelText("Months to pay off"));
    await userEvent.type(screen.getByLabelText("Months to pay off"), "12");
    expect(screen.getByLabelText("Mini plan result")).toHaveTextContent(/^\$44\.43 a month/);
  });
});

describe("§183 — a save that fails", () => {
  it("says so instead of looking kept", async () => {
    setIpcHandlers({
      get_all_accounts: () => accounts,
      get_ui_setting: () => null,
      set_ui_setting: () => {
        throw "database is locked";
      },
    });
    render(<DebtPlannerView />);
    await screen.findByRole("table", { name: "Debts" });
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "get_ui_setting")).toBe(true));
    await userEvent.type(screen.getByLabelText("Monthly budget"), "3");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not save the rates and budget with this file: database is locked");
  });
});
