// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

import UpdateHoldingsDialog, { linesToRequest } from "./UpdateHoldingsDialog";
import { invokeCalls, resetIpc, setIpcHandlers } from "../test/tauriMock";
import type { Account, HoldingChange, Security, StatementHolding } from "../lib/types";

const account: Account = {
  id: "a-401k",
  name: "TSP",
  type: "retirement",
  balance_cents: 0,
  holdings_value_cents: 250_000,
  tax_included: false,
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

const securities: Security[] = [
  { id: "s-fund", name: "Target Fund", symbol: "TGTF", kind: "mutual_fund", notes: null, updated_at: "", last_price_micro: 25_000_000, price_date: "2026-01-15", price_source: "transaction" },
  { id: "s-bond", name: "Bond Index", symbol: "BNDX", kind: "mutual_fund", notes: null, updated_at: "", last_price_micro: null, price_date: null, price_source: null },
];

function change(security_id: string, held: number, statement: number, price: number): HoldingChange {
  const delta = statement - held;
  return { security_id, security_name: security_id, symbol: "", held_micro: held, statement_micro: statement, delta_micro: delta, price_micro: price, gross_cents: Math.round((Math.abs(delta) / 1e6) * (price / 1e6) * 100), transaction_id: null, problem: null };
}

beforeEach(() => {
  resetIpc();
  setIpcHandlers({
    get_portfolio: () => ({
      positions: [{ account_id: "a-401k", account_name: "TSP", security_id: "s-fund", security_name: "Target Fund", symbol: "TGTF", security_kind: "mutual_fund", shares_micro: 100_000_000, cost_cents: 250_000, price_micro: 25_000_000, price_date: "2026-01-15", value_cents: 250_000, gain_cents: 0, lots: [] }],
      total_cost_cents: 250_000,
      total_value_cents: 250_000,
      cash_cents: 0,
      problems: [],
    }),
    update_holdings: (args) => {
      const lines = args.lines as StatementHolding[];
      return lines.map((l) => {
        if (l.security_id === "s-fund") return change("s-fund", 100_000_000, l.shares_micro ?? 0, l.price_micro ?? 25_000_000);
        if (l.value_cents !== null && l.price_micro === null) return { ...change("s-bond", 0, 0, 0), problem: "No price to turn the value into shares — enter the price too." };
        return { ...change("s-bond", 0, 100_000_000, 10_000_000), transaction_id: args.dryRun ? null : "t-new" };
      });
    },
  });
});

describe("Update holdings from a statement", () => {
  it("turns the typed lines into the request, skipping empty ones", () => {
    expect(linesToRequest([
      { security_id: "s-fund", shares: "112.5", price: "26.40", value: "" },
      { security_id: "s-bond", shares: "", price: "", value: "$1,000.00" },
      { security_id: "s-x", shares: "", price: "9", value: "" },
      { security_id: "", shares: "5", price: "", value: "" },
    ])).toEqual([
      { security_id: "s-fund", shares_micro: 112_500_000, price_micro: 26_400_000, value_cents: null },
      { security_id: "s-bond", shares_micro: null, price_micro: null, value_cents: 100_000 },
    ]);
  });

  it("lists what is held, previews the change with a dry run, and writes on Update", async () => {
    const onDone = vi.fn();
    render(<UpdateHoldingsDialog account={account} securities={securities} onCancel={() => {}} onDone={onDone} />);
    // The held position is a line, price pre-filled from the portfolio.
    await screen.findByText("Target Fund (TGTF)");
    expect(screen.getByLabelText("Price of Target Fund")).toHaveValue("25.00");
    expect(screen.getByRole("button", { name: "Update" })).toBeDisabled();

    await userEvent.clear(screen.getByLabelText("Price of Target Fund"));
    await userEvent.type(screen.getByLabelText("Price of Target Fund"), "26.40");
    await userEvent.type(screen.getByLabelText("Shares of Target Fund"), "112.5");
    await waitFor(() => expect(screen.getByLabelText("Change for Target Fund")).toHaveTextContent("+12.5 sh ($330.00)"));
    const dry = invokeCalls.filter((c) => c.cmd === "update_holdings");
    expect(dry.length).toBeGreaterThan(0);
    expect(dry[dry.length - 1].args).toMatchObject({ accountId: "a-401k", dryRun: true, lines: [{ security_id: "s-fund", shares_micro: 112_500_000, price_micro: 26_400_000, value_cents: null }] });

    // A new holding by value alone: the backend says it needs a price; the
    // button stays off until it has one.
    await userEvent.click(screen.getByRole("button", { name: /Another investment/ }));
    await userEvent.selectOptions(screen.getByLabelText("Add investment"), "s-bond");
    await userEvent.type(screen.getByLabelText("Value of Bond Index"), "1000");
    await waitFor(() => expect(screen.getByLabelText("Change for Bond Index")).toHaveTextContent(/enter the price too/));
    expect(screen.getByRole("button", { name: "Update" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Price of Bond Index"), "10");
    await waitFor(() => expect(screen.getByLabelText("Change for Bond Index")).toHaveTextContent("+100 sh ($1,000.00)"));
    expect(screen.getByText("2 rows to write.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const calls = invokeCalls.filter((c) => c.cmd === "update_holdings");
    expect(calls[calls.length - 1].args).toMatchObject({ dryRun: false });
    expect(onDone.mock.calls[0][0][1].transaction_id).toBe("t-new");
  });
});

describe("A refused preview", () => {
  it("drops the old preview and holds Update, then clears the refusal when the figures read again", async () => {
    let refuse = false;
    setIpcHandlers({
      get_portfolio: () => ({ positions: [{ account_id: "a-401k", account_name: "TSP", security_id: "s-fund", security_name: "Target Fund", symbol: "TGTF", security_kind: "mutual_fund", shares_micro: 100_000_000, cost_cents: 250_000, price_micro: 25_000_000, price_date: "2026-01-15", value_cents: 250_000, gain_cents: 0, lots: [] }], total_cost_cents: 250_000, total_value_cents: 250_000, cash_cents: 0, problems: [] }),
      update_holdings: (args) => {
        if (refuse) throw "the statement date is before the account was opened";
        const l = (args.lines as StatementHolding[])[0];
        return [change("s-fund", 100_000_000, l.shares_micro ?? 0, 25_000_000)];
      },
    });
    render(<UpdateHoldingsDialog account={account} securities={securities} onCancel={() => {}} onDone={() => {}} />);
    await screen.findByText("Target Fund (TGTF)");
    await userEvent.type(screen.getByLabelText("Shares of Target Fund"), "110");
    await waitFor(() => expect(screen.getByRole("button", { name: "Update" })).toBeEnabled());

    refuse = true;
    await userEvent.type(screen.getByLabelText("Shares of Target Fund"), "5");
    expect(await screen.findByRole("alert")).toHaveTextContent(/before the account was opened/);
    expect(screen.getByRole("button", { name: "Update" })).toBeDisabled();
    expect(screen.getByLabelText("Change for Target Fund").textContent).toBe("");

    refuse = false;
    await userEvent.type(screen.getByLabelText("Shares of Target Fund"), "0");
    await waitFor(() => expect(screen.getByRole("button", { name: "Update" })).toBeEnabled());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
