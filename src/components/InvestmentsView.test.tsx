// The Portfolio page: a holding's symbol is set where the user looks for it.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

import InvestmentsView from "./InvestmentsView";
import { invokeCalls, resetIpc, setIpcHandlers } from "../test/tauriMock";
import type { Portfolio, Position, Security } from "../lib/types";

const fund: Security = {
  id: "s-1",
  name: "VTSAX",
  symbol: "",
  kind: "mutual_fund",
  notes: "from the 401(k) file",
  updated_at: "",
  last_price_micro: null,
  price_date: null,
  price_source: null,
};

const position: Position = {
  account_id: "a-1",
  account_name: "Demo 401(k)",
  security_id: "s-1",
  security_name: "VTSAX",
  symbol: "",
  security_kind: "mutual_fund",
  shares_micro: 10_000_000,
  cost_cents: 100_000,
  price_micro: null,
  price_date: null,
  value_cents: 100_000,
  gain_cents: 0,
  lots: [],
};

const portfolio: Portfolio = { as_of: "2026-09-07", positions: [position], total_cost_cents: 100_000, total_value_cents: 100_000, cash_cents: 0, problems: [], rounding: "nearest" };

describe("InvestmentsView — symbol in place", () => {
  beforeEach(() => resetIpc());

  it("a holding without a symbol offers 'add symbol'; typing one updates the security and reloads", async () => {
    const updateSecurity = vi.fn(async () => undefined);
    let sym = "";
    setIpcHandlers({
      get_portfolio: async () => ({ ...portfolio, positions: [{ ...position, symbol: sym }] }),
      list_securities: async () => [{ ...fund, symbol: sym }],
      get_roi: async () => [],
      get_performance: async () => [],
      update_security: async (args: Record<string, unknown>) => {
        await updateSecurity();
        expect(args).toMatchObject({ id: "s-1", name: "VTSAX", symbol: "VTSAX", kind: "mutual_fund", notes: "from the 401(k) file" });
        sym = "VTSAX";
        return undefined;
      },
    });
    render(<InvestmentsView />);
    const add = await screen.findByRole("button", { name: "add symbol" });
    await userEvent.click(add);
    const field = screen.getByLabelText("Symbol for VTSAX");
    await userEvent.type(field, "vtsax{Enter}");
    await waitFor(() => expect(updateSecurity).toHaveBeenCalledTimes(1));
    // reloaded: the cell now shows the symbol and is still a button (click to change)
    expect(await screen.findByRole("button", { name: "VTSAX" })).toBeTruthy();
  });

  it("Escape puts the old symbol back without writing", async () => {
    const updateSecurity = vi.fn(async () => undefined);
    setIpcHandlers({
      get_portfolio: async () => ({ ...portfolio, positions: [{ ...position, symbol: "SCHD" }] }),
      list_securities: async () => [{ ...fund, symbol: "SCHD" }],
      get_roi: async () => [],
      get_performance: async () => [],
      update_security: updateSecurity,
    });
    render(<InvestmentsView />);
    await userEvent.click(await screen.findByRole("button", { name: "SCHD" }));
    await userEvent.type(screen.getByLabelText("Symbol for VTSAX"), "xx{Escape}");
    expect(screen.getByRole("button", { name: "SCHD" })).toBeTruthy();
    expect(updateSecurity).not.toHaveBeenCalled();
  });
});

describe("the share ledger's unhonored rows (§96)", () => {
  beforeEach(() => resetIpc());

  const problems = [
    "Sell on 2024-04-15: 5009.78354 shares of TSP C Fund sold but only 4989.880385 were held — the extra 19.903155 are ignored.",
    "Sell on 2024-07-15: 12.5 shares of TSP S Fund sold but only 10 were held — the extra 2.5 are ignored.",
  ];

  it("folds them away behind their count instead of pushing the holdings off the screen", async () => {
    setIpcHandlers({
      get_portfolio: async () => ({ ...portfolio, problems }),
      list_securities: async () => [fund],
      get_roi: async () => [],
      get_performance: async () => [],
    });
    render(<InvestmentsView />);

    // The count is on screen; the sentences are not, until asked for.
    const summary = await screen.findByText("2 rows the share ledger could not honor");
    expect(screen.queryByText(problems[0])).not.toBeVisible();

    await userEvent.click(summary);
    expect(screen.getByText(problems[0])).toBeVisible();
    expect(screen.getByText(problems[1])).toBeVisible();
  });

  it("says nothing at all when the ledger is clean", async () => {
    setIpcHandlers({
      get_portfolio: async () => portfolio,
      list_securities: async () => [fund],
      get_roi: async () => [],
      get_performance: async () => [],
    });
    render(<InvestmentsView />);
    await screen.findByRole("table", { name: "Holdings" });
    expect(screen.queryByText(/could not honor/)).not.toBeInTheDocument();
  });
});

// §172 — the two returns Money never had, and what kind of thing the money
// is in.
describe("Performance and Allocation (§172)", () => {
  beforeEach(() => resetIpc());

  it("shows each period's returns as percentages, and dashes where there is none", async () => {
    setIpcHandlers({
      get_portfolio: async () => portfolio,
      list_securities: async () => [fund],
      get_roi: async () => [],
      get_performance: async () => [
        { label: "12 months", from: "2025-09-07", to: "2026-09-07", start_value_cents: 100_000, end_value_cents: 121_000, flows_in_cents: 10_000, flows_out_cents: 0, gain_cents: 11_000, twr_bps: 1_576, twr_annual_bps: 1_590, mwr_annual_bps: 1_230, flow_days: 1 },
        { label: "Past month", from: "2026-08-07", to: "2026-09-07", start_value_cents: 120_000, end_value_cents: 121_000, flows_in_cents: 0, flows_out_cents: 0, gain_cents: 1_000, twr_bps: 83, twr_annual_bps: null, mwr_annual_bps: null, flow_days: 0 },
      ],
    });
    render(<InvestmentsView />);
    const table = await screen.findByRole("table", { name: "Performance" });
    expect(within(table).getByLabelText("12 months time-weighted")).toHaveTextContent("15.8%");
    expect(within(table).getByLabelText("12 months time-weighted per year")).toHaveTextContent("15.9%");
    expect(within(table).getByLabelText("12 months money-weighted per year")).toHaveTextContent("12.3%");
    expect(within(table).getByLabelText("Past month time-weighted per year")).toHaveTextContent("—");
    expect(table.textContent).toContain("110.00");
  });

  // §172.2 / §172.3 — one account, then one holding in it.
  it("can show the returns of one account and of one holding in it, asking the backend by each", async () => {
    const row = (label: string, gain: number) => ({ label, from: "2025-09-07", to: "2026-09-07", start_value_cents: 100_000, end_value_cents: 100_000 + gain, flows_in_cents: 0, flows_out_cents: 0, gain_cents: gain, twr_bps: 1_000, twr_annual_bps: 1_000, mwr_annual_bps: 1_000, flow_days: 0 });
    setIpcHandlers({
      get_portfolio: async () => portfolio,
      list_securities: async () => [fund],
      get_roi: async () => [],
      get_performance: async (args) => [row(args.securityId === "s-1" ? "12 months" : "All time", args.securityId === "s-1" ? 4_200 : 9_900)],
    });
    render(<InvestmentsView />);
    const table = await screen.findByRole("table", { name: "Performance" });
    expect(table.textContent).toContain("All time");
    const first = invokeCalls.find((c) => c.cmd === "get_performance")!;
    expect(first.args).toEqual({ accountId: null, securityId: null, asOf: null });
    // The account first: the holding list narrows to what it holds and reads "Whole account".
    await userEvent.selectOptions(screen.getByLabelText("Performance account"), "a-1");
    await waitFor(() => expect(invokeCalls.filter((c) => c.cmd === "get_performance").pop()!.args).toEqual({ accountId: "a-1", securityId: null, asOf: null }));
    expect(within(screen.getByLabelText("Performance holding")).getByRole("option", { name: "Whole account" })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Performance holding"), "s-1");
    await waitFor(() => expect(screen.getByRole("table", { name: "Performance" }).textContent).toContain("12 months"));
    expect(invokeCalls.filter((c) => c.cmd === "get_performance").pop()!.args).toEqual({ accountId: "a-1", securityId: "s-1", asOf: null });
    expect(screen.getByText(/For one holding, value is its shares/)).toBeInTheDocument();
    // US labels, and no yearly rate for a short period.
    const t2 = screen.getByRole("table", { name: "Performance" });
    for (const h of ["Start value", "Money in", "Money out", "End value", "Gain"]) expect(within(t2).getByText(h)).toBeInTheDocument();
    expect(within(t2).queryByText("Put in")).not.toBeInTheDocument();
    // Back to the whole account: the security goes with it.
    await userEvent.selectOptions(screen.getByLabelText("Performance account"), "");
    await waitFor(() => expect(invokeCalls.filter((c) => c.cmd === "get_performance").pop()!.args).toEqual({ accountId: null, securityId: null, asOf: null }));
  });

  it("allocates by the security's kind, with cash as its own line", async () => {
    setIpcHandlers({
      get_portfolio: async () => ({ ...portfolio, cash_cents: 25_000, positions: [{ ...position, value_cents: 75_000, security_kind: "mutual_fund" }] }),
      list_securities: async () => [fund],
      get_roi: async () => [],
      get_performance: async () => [],
    });
    render(<InvestmentsView />);
    const table = await screen.findByRole("table", { name: "Allocation" });
    const rows = within(table).getAllByRole("row").slice(1).map((r) => r.textContent);
    expect(rows[0]).toContain("Mutual funds");
    expect(rows[0]).toContain("75.0%");
    expect(rows[1]).toContain("Cash");
    expect(rows[1]).toContain("25.0%");
  });
});

describe("§183 — failures and slow answers on the Portfolio page", () => {
  beforeEach(() => resetIpc());
  const second: Security = { ...fund, id: "s-2", name: "Schwab dividend", symbol: "SCHD" };
  const price = (security_id: string, date: string, price_micro: number) => ({ security_id, date, price_micro, source: "manual" });

  it("says the returns could not be worked out, not that nothing was held long enough", async () => {
    setIpcHandlers({
      get_portfolio: async () => portfolio,
      list_securities: async () => [fund],
      get_roi: async () => [],
      get_performance: async () => {
        throw "the price history is unreadable";
      },
    });
    render(<InvestmentsView />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be worked out: the price history is unreadable/);
    expect(screen.queryByText(/Nothing held long enough/)).toBeNull();
  });

  it("keeps a slow price history for the first security out from under the second's name", async () => {
    let late!: (v: unknown) => void;
    setIpcHandlers({
      get_portfolio: async () => portfolio,
      list_securities: async () => [fund, second],
      get_roi: async () => [],
      get_performance: async () => [],
      list_security_prices: (args) =>
        args.securityId === "s-1" ? new Promise((r) => (late = r)) : [price("s-2", "2026-09-01", 80_000_000)],
    });
    render(<InvestmentsView />);
    await userEvent.click(await screen.findByRole("button", { name: "Securities…" }));
    const table = screen.getByRole("table", { name: "Securities" });
    const rowOf = (n: string) => within(table).getByText(n, { selector: "td" }).closest("tr")!;
    await userEvent.click(within(rowOf("VTSAX")).getByRole("button", { name: "Prices" }));
    await userEvent.click(within(rowOf("Schwab dividend")).getByRole("button", { name: "Prices" }));
    const history = await screen.findByRole("table", { name: "Price history" });
    await waitFor(() => expect(history.textContent).toContain("80.00"));
    late([price("s-1", "2026-08-01", 12_340_000)]);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText(/Price history — Schwab dividend/)).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Price history" }).textContent).not.toContain("12.34");
  });

  it("does not add the same security twice when Add is pressed again before the first answer", async () => {
    let finish!: (v: unknown) => void;
    setIpcHandlers({
      get_portfolio: async () => portfolio,
      list_securities: async () => [fund],
      get_roi: async () => [],
      get_performance: async () => [],
      create_security: () => new Promise((r) => (finish = r)),
    });
    render(<InvestmentsView />);
    await userEvent.click(await screen.findByRole("button", { name: "Securities…" }));
    const form = screen.getByRole("button", { name: "Add" }).closest("form")!;
    await userEvent.type(within(form).getAllByRole("textbox")[0], "New fund");
    await userEvent.click(within(form).getByRole("button", { name: "Add" }));
    expect(within(form).getByRole("button", { name: "Add" })).toBeDisabled();
    await userEvent.click(within(form).getByRole("button", { name: "Add" }));
    expect(invokeCalls.filter((c) => c.cmd === "create_security")).toHaveLength(1);
    finish(fund);
  });
});
