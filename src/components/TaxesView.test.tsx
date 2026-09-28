// The Taxes tab (§43): totals by line, the Tax Line Manager, and the way out
// to the full reports.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

import TaxesView, { groupTaxSummary } from "./TaxesView";
import { invokeCalls, resetIpc, setIpcHandlers } from "../test/tauriMock";
import { useAccountStore } from "../stores/useAccountStore";
import type { Report } from "../lib/types";

const summary: Report = {
  kind: "tax_summary",
  title: "Tax summary by line",
  subtitle: "",
  columns: [
    { label: "Category", kind: "text" },
    { label: "Amount", kind: "money" },
    { label: "Lines", kind: "count" },
  ],
  rows: [
    { key: null, key_kind: null, label: "Schedule A: Home mortgage interest", level: 0, style: "header", cells: [] },
    { key: "c-mort", key_kind: "category", label: "Home : Mortgage Interest", level: 1, style: "normal", cells: [{ text: null, cents: -640_000 }, { text: "12", cents: null }] },
    { key: null, key_kind: null, label: "Total Schedule A: Home mortgage interest", level: 0, style: "subtotal", cells: [{ text: null, cents: -640_000 }, { text: null, cents: null }] },
    { key: null, key_kind: null, label: "Schedule B: Interest income", level: 0, style: "header", cells: [] },
    { key: "c-int", key_kind: "category", label: "Interest Income", level: 1, style: "normal", cells: [{ text: null, cents: 12_345 }, { text: "4", cents: null }] },
    { key: null, key_kind: null, label: "Total Schedule B: Interest income", level: 0, style: "subtotal", cells: [{ text: null, cents: 12_345 }, { text: null, cents: null }] },
    { key: null, key_kind: null, label: "Categories with spending and NO tax line", level: 0, style: "header", cells: [] },
    { key: "c-groc", key_kind: "category", label: "Groceries", level: 1, style: "normal", cells: [{ text: null, cents: -80_000 }, { text: "30", cents: null }] },
    { key: null, key_kind: null, label: "Total (no tax line)", level: 0, style: "subtotal", cells: [{ text: null, cents: -80_000 }, { text: null, cents: null }] },
  ],
  chart: null,
};

const gains: Report = {
  kind: "capital_gains",
  title: "Capital gains",
  subtitle: "",
  columns: [],
  rows: [
    { key: null, key_kind: null, label: "Total short-term", level: 0, style: "subtotal", cells: [null, null, null, null, { text: null, cents: 93_728 }, { text: null, cents: 94_500 }, { text: null, cents: -772 }].map((c) => c ?? { text: null, cents: null }) },
    { key: null, key_kind: null, label: "Net gain/loss", level: 0, style: "total", cells: [null, null, null, null, { text: null, cents: 93_728 }, { text: null, cents: 94_500 }, { text: null, cents: -772 }].map((c) => c ?? { text: null, cents: null }) },
  ],
  chart: null,
};

const income: Report = {
  kind: "investment_income",
  title: "Investment income",
  subtitle: "",
  columns: [],
  rows: [{ key: null, key_kind: null, label: "Total", level: 0, style: "total", cells: [{ text: null, cents: 50_000 }, { text: null, cents: 6_000 }, { text: null, cents: 0 }, { text: null, cents: 56_000 }, { text: null, cents: 40_000 }] }],
  chart: null,
};

beforeEach(() => {
  resetIpc();
  setIpcHandlers({
    run_report: (args) => {
      const kind = (args.request as { kind: string }).kind;
      return kind === "tax_summary" ? summary : kind === "capital_gains" ? gains : income;
    },
    list_categories: () => [
      { id: "c-groc", name: "Groceries", parent_id: null, kind: "expense", tax_line: null, full_name: "Groceries", usage_count: 30 },
      { id: "c-int", name: "Interest Income", parent_id: null, kind: "income", tax_line: "Schedule B: Interest income", full_name: "Interest Income", usage_count: 4 },
    ],
    get_all_accounts: () => [acct("a-chk", "Everyday Checking", "checking", true), acct("a-401k", "TSP", "retirement", false)],
    set_account_tax_included: () => null,
    update_category: (args) => ({ id: args.id, name: args.name, parent_id: args.parentId ?? null, kind: args.kind, tax_line: args.taxLine ?? null, full_name: args.name, usage_count: 0 }),
  });
  useAccountStore.setState({ categories: [], accounts: [] });
});

function acct(id: string, name: string, type: string, tax_included: boolean) {
  return {
    id,
    name,
    type,
    balance_cents: 0,
    holdings_value_cents: 0,
    tax_included,
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

describe("the Taxes tab", () => {
  it("folds the report into lines and keeps the unassigned group apart", () => {
    const g = groupTaxSummary(summary);
    expect(g.map((x) => x.line)).toEqual(["Schedule A: Home mortgage interest", "Schedule B: Interest income", null]);
    expect(g[0].total).toBe(-640_000);
    expect(g[2].categories[0]).toMatchObject({ id: "c-groc", cents: -80_000, count: "30" });
  });

  it("shows totals by form for the year and the gaps in the manager", async () => {
    const onOpenReport = vi.fn();
    render(<TaxesView onOpenReport={onOpenReport} />);
    const totals = await screen.findByRole("table", { name: "Tax-related totals" });
    expect(within(totals).getByText("Schedule A")).toBeInTheDocument();
    expect(within(totals).getByText("Schedule B")).toBeInTheDocument();
    expect(within(totals).getByText("Home mortgage interest")).toBeInTheDocument();
    expect(within(totals).getAllByText("(6,400.00)")).toHaveLength(2); // the line and its one category
    const manager = screen.getByRole("table", { name: "Categories without a tax line" });
    expect(within(manager).getByText("Groceries")).toBeInTheDocument();
    // Schedule D and B blocks read the report totals.
    expect(within(screen.getByRole("table", { name: "Capital gains summary" })).getAllByText("(7.72)")).toHaveLength(2); // short-term and net
    expect(within(screen.getByRole("table", { name: "Investment income summary" })).getByText("560.00")).toBeInTheDocument();
    // The year is the request's range.
    const first = invokeCalls.find((c) => c.cmd === "run_report")!.args.request as { from: string; to: string };
    expect(first.from.endsWith("-01-01") && first.to.endsWith("-12-31")).toBe(true);
  });

  it("assigning a line writes the category and re-runs; a line opens the scoped report", async () => {
    const onOpenReport = vi.fn();
    render(<TaxesView onOpenReport={onOpenReport} />);
    await screen.findByRole("table", { name: "Tax-related totals" });
    await waitFor(() => expect(useAccountStore.getState().categories.length).toBe(2));
    await userEvent.selectOptions(screen.getByLabelText("Tax line for Groceries"), "Schedule A: Medical and dental expenses");
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "update_category")).toBe(true));
    expect(invokeCalls.find((c) => c.cmd === "update_category")!.args).toMatchObject({ id: "c-groc", taxLine: "Schedule A: Medical and dental expenses" });
    expect(invokeCalls.filter((c) => c.cmd === "run_report" && (c.args.request as { kind: string }).kind === "tax_summary").length).toBeGreaterThan(1);

    await userEvent.click(screen.getByRole("button", { name: "Home mortgage interest" }));
    expect(onOpenReport).toHaveBeenCalledWith(expect.objectContaining({ kind: "tax_related_transactions", categoryIds: ["c-mort"] }));
    await userEvent.click(screen.getAllByRole("button", { name: "Full report" })[0]);
    expect(onOpenReport).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "capital_gains" }));
  });

  it("asks for tax-scoped reports and lets an account be included or left out (§48)", async () => {
    const onOpenReport = vi.fn();
    render(<TaxesView onOpenReport={onOpenReport} />);
    await screen.findByRole("table", { name: "Tax-related totals" });
    // Every request from this tab is tax-scoped, and so is a report opened from it.
    for (const c of invokeCalls.filter((x) => x.cmd === "run_report")) expect((c.args.request as { tax_scope: boolean }).tax_scope).toBe(true);
    await userEvent.click(screen.getAllByRole("button", { name: "Full report" })[0]);
    expect(onOpenReport).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "capital_gains", taxScope: true }));
    // The panel: the retirement account starts unchecked and the note names it.
    const panel = await screen.findByRole("table", { name: "Accounts included in tax information" });
    expect(within(panel).getByLabelText("Include Everyday Checking in tax information")).toBeChecked();
    const tsp = within(panel).getByLabelText("Include TSP in tax information");
    expect(tsp).not.toBeChecked();
    expect(screen.getByText(/Sales in TSP are left out/)).toBeInTheDocument();
    const before = invokeCalls.filter((x) => x.cmd === "run_report").length;
    await userEvent.click(tsp);
    await waitFor(() => expect(invokeCalls.some((x) => x.cmd === "set_account_tax_included")).toBe(true));
    expect(invokeCalls.find((x) => x.cmd === "set_account_tax_included")!.args).toEqual({ accountId: "a-401k", included: true });
    await waitFor(() => expect(invokeCalls.filter((x) => x.cmd === "run_report").length).toBeGreaterThan(before));
  });
});

// §183 — errors went to the top card, out of sight of what failed, and a year
// that would not load left the previous year's figures under its heading.
describe("§183 — Taxes says what failed where it failed", () => {
  it("a year that will not load shows no figures from the year before", async () => {
    render(<TaxesView onOpenReport={vi.fn()} />);
    await screen.findByRole("table", { name: "Tax-related totals" });
    setIpcHandlers({
      run_report: () => {
        throw "database is locked";
      },
      list_categories: () => [],
      get_all_accounts: () => [],
    });
    const select = screen.getByLabelText("Tax year") as HTMLSelectElement;
    const other = Array.from(select.options).find((o) => o.value !== select.value)!.value;
    await userEvent.selectOptions(select, other);
    expect(await screen.findByText(new RegExp(`The figures for ${other} could not be loaded: database is locked`))).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Tax-related totals" })).not.toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Categories without a tax line" })).not.toBeInTheDocument();
  });

  it("a slow answer for the year you left does not land under the new one", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const empty: Report = { ...summary, rows: [] };
    let first = true;
    setIpcHandlers({
      run_report: async (args) => {
        const kind = (args.request as { kind: string }).kind;
        const from = (args.request as { from: string }).from;
        if (first && kind === "tax_summary") {
          first = false;
          await held;
          return { ...summary, subtitle: from };
        }
        return kind === "tax_summary" ? empty : kind === "capital_gains" ? gains : income;
      },
      list_categories: () => [],
      get_all_accounts: () => [],
    });
    render(<TaxesView onOpenReport={vi.fn()} />);
    const select = screen.getByLabelText("Tax year") as HTMLSelectElement;
    const other = Array.from(select.options).find((o) => o.value !== select.value)!.value;
    await userEvent.selectOptions(select, other);
    await screen.findByText(new RegExp(`Nothing in ${other} is filed under a category with a tax line`));
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("table", { name: "Tax-related totals" })).not.toBeInTheDocument();
  });

  it("a refused tax line is shown in the Tax Line Manager", async () => {
    render(<TaxesView onOpenReport={vi.fn()} />);
    const manager = await screen.findByRole("table", { name: "Categories without a tax line" });
    await waitFor(() => expect(useAccountStore.getState().categories.length).toBe(2));
    setIpcHandlers({
      run_report: (args) => {
        const kind = (args.request as { kind: string }).kind;
        return kind === "tax_summary" ? summary : kind === "capital_gains" ? gains : income;
      },
      list_categories: () => [],
      get_all_accounts: () => [],
      update_category: () => {
        throw "a category with that name already exists";
      },
    });
    await userEvent.selectOptions(screen.getByLabelText("Tax line for Groceries"), "Schedule A: Medical and dental expenses");
    const card = manager.closest("section")!;
    expect(await within(card as HTMLElement).findByRole("alert")).toHaveTextContent(/Groceries was not saved: a category with that name already exists/);
  });

  it("a refused include is shown beside the accounts", async () => {
    render(<TaxesView onOpenReport={vi.fn()} />);
    const panel = await screen.findByRole("table", { name: "Accounts included in tax information" });
    await within(panel).findByLabelText("Include TSP in tax information");
    setIpcHandlers({
      run_report: () => summary,
      list_categories: () => [],
      get_all_accounts: () => [],
      set_account_tax_included: () => {
        throw "no such account";
      },
    });
    await userEvent.click(within(panel).getByLabelText("Include TSP in tax information"));
    expect(await within(panel.closest("section") as HTMLElement).findByRole("alert")).toHaveTextContent("no such account");
  });
});
