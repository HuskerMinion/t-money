// The one viewer behind every report.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

import ReportViewer, { centsOrNull, drillFor, filtersOf, formatCell, hasLineFilters, savedFromSpec, specFromSaved, toCsv, type ReportSpec } from "./ReportViewer";
import { niceStep } from "./ReportChart";
import { centsText } from "./ReportViewer";
import { useFileFormat } from "../lib/region";
import { invokeCalls, resetIpc, setIpcHandlers } from "../test/tauriMock";
import { useAccountStore } from "../stores/useAccountStore";
import type { Report, SavedReport } from "../lib/types";

const report: Report = {
  kind: "spending_by_category",
  title: "Spending by category",
  subtitle: "8/1/2026 through 8/31/2026",
  columns: [
    { label: "Category", kind: "text" },
    { label: "Total", kind: "money" },
    { label: "% of section", kind: "percent" },
    { label: "Count", kind: "count" },
  ],
  rows: [
    { key: null, key_kind: null, label: "Expense Categories", level: 0, style: "header", cells: [] },
    { key: "c-groc", key_kind: "category", label: "Groceries", level: 0, style: "normal", cells: [{ text: null, cents: 16000 }, { text: null, cents: 4571 }, { text: "3", cents: null }] },
    { key: "c-auto", key_kind: "category", label: "Automobile", level: 0, style: "subtotal", cells: [{ text: null, cents: 7000 }, { text: null, cents: 2000 }, { text: null, cents: null }] },
    { key: "c-fuel", key_kind: "category", label: "Fuel", level: 1, style: "normal", cells: [{ text: null, cents: 7000 }, { text: null, cents: 2000 }, { text: "2", cents: null }] },
    { key: null, key_kind: null, label: "Net Income", level: 0, style: "total", cells: [{ text: null, cents: -35000 }, { text: null, cents: null }, { text: null, cents: null }] },
  ],
  chart: { kind: "bar", series: [{ label: "Total", points: [["Groceries", 16000], ["Automobile", 7000]] }] },
};

const spec: ReportSpec = {
  kind: "spending_by_category",
  rangeId: "custom",
  range: { from: "2026-08-01", to: "2026-08-31" },
  accountIds: [],
  categoryIds: [],
  compare: null,
};

function setup(overrides: Partial<React.ComponentProps<typeof ReportViewer>> = {}) {
  const onSpec = vi.fn();
  const onOpenAccount = vi.fn();
  const onOpenTransaction = vi.fn();
  const onSave = vi.fn(async (r: SavedReport) => ({ ...r, id: r.id || "saved-1" }));
  render(
    <ReportViewer
      spec={spec}
      onSpec={onSpec}
      onOpenAccount={onOpenAccount}
      onOpenTransaction={onOpenTransaction}
      onBack={() => {}}
      onSave={onSave}
      {...overrides}
    />
  );
  return { onSpec, onOpenAccount, onOpenTransaction, onSave };
}

beforeEach(() => {
  resetIpc();
  setIpcHandlers({ run_report: () => report });
  useAccountStore.setState({ accounts: [], categories: [] });
});

describe("formatting", () => {
  it("formats by column kind — percent is basis points, money is cents", () => {
    expect(formatCell("money", -123456, null)).toBe("(1,234.56)");
    expect(formatCell("percent", 4571, null)).toBe("45.7%");
    expect(formatCell("count", 3, null)).toBe("3");
    expect(formatCell("text", null, "Kroger")).toBe("Kroger");
    expect(formatCell("money", null, null)).toBe("");
  });

  it("CSV carries the label column and plain decimals", () => {
    const csv = toCsv(report);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe('"Category","Total","% of section","Count"');
    expect(lines[2]).toBe('"Groceries",160.00,45.71,"3"');
    expect(lines[1]).toBe('"Expense Categories"');
  });

  it("axis steps are 1/2/5", () => {
    expect(niceStep(700_000)).toBe(200_000);
    expect(niceStep(35_000)).toBe(10_000);
    expect(niceStep(0)).toBe(100);
  });
});

describe("drill-through", () => {
  it("a category row opens its transactions, scoped to it", () => {
    expect(drillFor(spec, report.rows[1])).toEqual({ kind: "transactions_by_category", categoryIds: ["c-groc"] });
    expect(drillFor(spec, report.rows[0])).toBeNull();
    expect(drillFor(spec, { ...report.rows[1], key_kind: "month", key: "2026-02" })).toMatchObject({
      kind: "income_and_spending",
      range: { from: "2026-02-01", to: "2026-02-28" },
    });
  });

  // A category row opens a quick look first; the full report is a button in it.
  const txnReport: Report = {
    kind: "transactions_by_category", title: "Transactions by category", subtitle: "8/1/2026 through 8/31/2026", chart: null,
    columns: [{ label: "Date", kind: "text" }, { label: "Num", kind: "text" }, { label: "Payee", kind: "text" }, { label: "Account", kind: "text" }, { label: "Memo", kind: "text" }, { label: "Amount", kind: "money" }, { label: "C", kind: "text" }],
    rows: [
      { key: "c-groc", key_kind: "category", label: "Groceries", level: 0, style: "header", cells: [] },
      { key: "t-1", key_kind: "transaction", label: "8/3/2026", level: 1, style: "normal", cells: [{ text: "", cents: null }, { text: "Kroger", cents: null }, { text: "Checking", cents: null }, { text: "", cents: null }, { text: null, cents: -10_000 }, { text: "", cents: null }] },
      { key: "t-2", key_kind: "transaction", label: "8/6/2026", level: 1, style: "normal", cells: [{ text: "", cents: null }, { text: "Walmart", cents: null }, { text: "Visa", cents: null }, { text: "food", cents: null }, { text: null, cents: -6_000 }, { text: "", cents: null }] },
      { key: null, key_kind: null, label: "Total Groceries", level: 0, style: "subtotal", cells: [{ text: null, cents: null }, { text: null, cents: null }, { text: null, cents: null }, { text: null, cents: null }, { text: null, cents: -16_000 }, { text: null, cents: null }] },
      { key: null, key_kind: null, label: "Grand total (2 transactions)", level: 0, style: "total", cells: [{ text: null, cents: null }, { text: null, cents: null }, { text: null, cents: null }, { text: null, cents: null }, { text: null, cents: -16_000 }, { text: null, cents: null }] },
    ],
  };

  it("clicking a category row opens a quick look at its transactions, which can open the register or the full report", async () => {
    setIpcHandlers({ run_report: (args) => ((args as { request: { kind: string } }).request.kind === "transactions_by_category" ? txnReport : report) });
    const { onSpec, onOpenTransaction } = setup();
    const row = await screen.findByRole("row", { name: "Open Groceries" });
    await userEvent.click(row);
    const dialog = await screen.findByRole("dialog", { name: "Transactions: Groceries" });
    expect(within(dialog).getByRole("table", { name: "Transactions for Groceries" })).toHaveTextContent("Kroger");
    expect(within(dialog).getByText("Walmart")).toBeInTheDocument();
    // The request was scoped to the category and this report's range.
    const req = invokeCalls.filter((c) => c.cmd === "run_report").pop()!.args!.request as Record<string, unknown>;
    expect(req).toMatchObject({ kind: "transactions_by_category", category_ids: ["c-groc"], from: "2026-08-01", to: "2026-08-31" });
    expect(onSpec).not.toHaveBeenCalled();
    // A transaction row opens the register.
    await userEvent.click(within(dialog).getByRole("button", { name: /8\/6\/2026/ }));
    expect(onOpenTransaction).toHaveBeenCalledWith(null, "t-2");
    // The full report is one click away.
    await userEvent.click(await screen.findByRole("row", { name: "Open Groceries" }));
    await userEvent.click(await screen.findByRole("button", { name: "Make this a report" }));
    expect(onSpec).toHaveBeenCalledWith(expect.objectContaining({ kind: "transactions_by_category", categoryIds: ["c-groc"] }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

// A click on a chart's bar is a click on its row.
describe("chart clicks", () => {
  it("clicking a bar opens the quick look for that category", async () => {
    const txn: Report = { ...report, kind: "transactions_by_category", title: "Transactions by category", chart: null, rows: [{ key: "c-auto", key_kind: "category", label: "Automobile", level: 0, style: "header", cells: [] }] };
    setIpcHandlers({ run_report: (args) => ((args as { request: { kind: string } }).request.kind === "transactions_by_category" ? txn : report) });
    setup();
    await screen.findByRole("row", { name: "Open Groceries" });
    await userEvent.click(screen.getByRole("button", { name: /Change view: chart/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Automobile: $70.00" }));
    await screen.findByRole("dialog", { name: "Transactions: Automobile" });
    const req = invokeCalls.filter((c) => c.cmd === "run_report").pop()!.args!.request as Record<string, unknown>;
    expect(req).toMatchObject({ kind: "transactions_by_category", category_ids: ["c-auto"] });
  });
});

describe("the scope every report honors", () => {
  it("sends absent filters as nulls, and set ones as themselves", () => {
    expect(filtersOf(spec)).toEqual({
      payee_ids: null,
      exclude_categories: false,
      exclude_payees: false,
      min_cents: null,
      max_cents: null,
      cleared: null,
      text: null,
      class_value_ids: null,
      classification_id: null,
      benchmark_security_id: null,
    });
    const filtered: ReportSpec = {
      ...spec,
      payeeIds: ["p-1"],
      excludePayees: true,
      minCents: 5000,
      cleared: ["C"],
      text: "kro",
      classValueIds: ["v-cos"],
    };
    expect(filtersOf(filtered)).toMatchObject({
      payee_ids: ["p-1"],
      exclude_payees: true,
      min_cents: 5000,
      cleared: ["C"],
      text: "kro",
      class_value_ids: ["v-cos"],
    });
  });

  it("reads a typed amount as cents, ignoring the sign and the punctuation", () => {
    expect(centsOrNull("")).toBeNull();
    expect(centsOrNull("50")).toBe(5000);
    expect(centsOrNull("$1,234.56")).toBe(123456);
    expect(centsOrNull("-40")).toBe(4000);
    expect(centsOrNull("nonsense")).toBeNull();
  });

  it("knows when a report is filtered, so the rail can say so", () => {
    expect(hasLineFilters(spec)).toBe(false);
    expect(hasLineFilters({ ...spec, categoryIds: ["c-groc"] })).toBe(false);
    expect(hasLineFilters({ ...spec, text: "kro" })).toBe(true);
    expect(hasLineFilters({ ...spec, cleared: ["R"] })).toBe(true);
    expect(hasLineFilters({ ...spec, minCents: 100 })).toBe(true);
  });

  it("carries the whole scope into a favorite report and back out", () => {
    // A favorite that forgets its filters is a favorite that shows
    // different numbers tomorrow.
    const full: ReportSpec = {
      ...spec,
      payeeIds: ["p-1"],
      excludeCategories: true,
      maxCents: 9900,
      cleared: ["", "C"],
      text: "shell",
      classValueIds: ["v-cos", "none:cl-per"],
      classificationId: "cl-prop",
      benchmarkSecurityId: "s-idx",
    };
    const saved = savedFromSpec(full, "Maple, small charges");
    expect(saved).toMatchObject({
      payee_ids: ["p-1"],
      exclude_categories: true,
      max_cents: 9900,
      cleared: ["", "C"],
      text: "shell",
      class_value_ids: ["v-cos", "none:cl-per"],
      classification_id: "cl-prop",
      benchmark_security_id: "s-idx",
    });
    const back = specFromSaved({ ...saved, id: "r-1" });
    expect(filtersOf(back)).toEqual(filtersOf(full));
  });

  it("reads a report saved before the filters existed", () => {
    // Old rows have none of these keys at all. They must come back as "no
    // filter", not as undefined behavior.
    const old = { id: "r-old", name: "By Category", kind: "spending_by_category", range_id: "custom", from: "2025-01-01", to: "2025-12-31", account_ids: [], category_ids: [], compare_from: null, compare_to: null } as SavedReport;
    const back = specFromSaved(old);
    expect(hasLineFilters(back)).toBe(false);
    expect(filtersOf(back).cleared).toBeNull();
  });

  it("puts the filters on the request, and on the quick look inside it", async () => {
    setup({ spec: { ...spec, text: "kro", cleared: ["C"] } });
    await screen.findByRole("heading", { name: "Spending by category" });
    const request = invokeCalls.find((c) => c.cmd === "run_report")!.args as { request: Record<string, unknown> };
    expect(request.request).toMatchObject({ text: "kro", cleared: ["C"] });
    // The quick look is the same report narrowed to one row; if it dropped
    // the filters its rows would not add up to the row that opened it.
    invokeCalls.length = 0;
    await userEvent.click(await screen.findByRole("row", { name: "Open Groceries" }));
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "run_report")).toBe(true));
    const peek = invokeCalls.find((c) => c.cmd === "run_report")!.args as { request: Record<string, unknown> };
    expect(peek.request).toMatchObject({ text: "kro", cleared: ["C"], category_ids: ["c-groc"] });
  });

  it("says on the rail when a filter is on", async () => {
    setup({ spec: { ...spec, minCents: 5000 } });
    expect(await screen.findByRole("button", { name: "Customize… (filtered)" })).toBeInTheDocument();
  });
});

describe("classification reports", () => {
  it("a value row opens its transactions; the unclassified row opens the ones with none", () => {
    const row = { key: "v-cos", key_kind: "class_value" as const, label: "Maple", level: 0, style: "normal" as const, cells: [] };
    expect(drillFor(spec, row)).toEqual({ kind: "transactions_by_classification", classValueIds: ["v-cos"] });
    // The unclassified bucket's key IS a scope value — the engine writes the
    // axis into it, so the drill works whether or not an axis was chosen by
    // hand. (Review finding: it used to be "", and the drill then dropped
    // the filter and listed every transaction in the range under a heading
    // that said "unclassified".)
    expect(drillFor(spec, { ...row, key: "none:cl-prop", label: "(no property)" })).toEqual({
      kind: "transactions_by_classification",
      classValueIds: ["none:cl-prop"],
    });
  });
});

describe("the page", () => {
  it("runs the report for the spec and shows title, subtitle, rows and totals", async () => {
    setup();
    expect(await screen.findByRole("heading", { name: "Spending by category" })).toBeInTheDocument();
    expect(screen.getByText("8/1/2026 through 8/31/2026")).toBeInTheDocument();
    expect(invokeCalls.find((c) => c.cmd === "run_report")?.args).toEqual({
      request: {
        kind: "spending_by_category",
        from: "2026-08-01",
        to: "2026-08-31",
        account_ids: null,
        category_ids: null,
        compare_from: null,
        compare_to: null,
        detail: null,
        security_ids: null,
        tax_scope: false,
        // The rest of the scope rides on every request, absent
        // meaning "no filter". Listed here so that adding a filter without
        // wiring it through `filtersOf` fails loudly.
        payee_ids: null,
        exclude_categories: false,
        exclude_payees: false,
        min_cents: null,
        max_cents: null,
        cleared: null,
        text: null,
        class_value_ids: null,
        classification_id: null,
        benchmark_security_id: null,
      },
    });
    const table = screen.getByRole("table", { name: "Spending by category" });
    expect(within(table).getByText("Expense Categories")).toBeInTheDocument();
    // Bare numbers, Money style: no $, parens for negative, in red.
    expect(within(table).getByText("160.00")).toBeInTheDocument();
    expect(within(table).getByText("(350.00)")).toHaveClass("money-neg");
    // Subcategory indented under its parent.
    const fuel = within(table).getByText("Fuel").closest("td")!;
    expect(fuel.style.paddingLeft).toBe("24px");
  });

  it("the date-range dropdown resolves a named range and re-runs", async () => {
    const { onSpec } = setup();
    await screen.findByRole("heading", { name: "Spending by category" });
    await userEvent.selectOptions(screen.getByLabelText("Date range:"), "previous_year");
    const call = onSpec.mock.calls[0][0] as ReportSpec;
    expect(call.rangeId).toBe("previous_year");
    expect(call.range.from.endsWith("-01-01")).toBe(true);
    expect(call.range.to.endsWith("-12-31")).toBe(true);
  });

  it("Change view swaps the table for the chart", async () => {
    setup();
    await screen.findByRole("heading", { name: "Spending by category" });
    await userEvent.click(screen.getByRole("button", { name: /Change view: chart/ }));
    expect(screen.getByRole("img", { name: /bar chart/ })).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("Customize narrows the accounts and the request carries them, on Apply", async () => {
    useAccountStore.setState({
      accounts: [{ id: "a-1", name: "Checking" } as never, { id: "a-2", name: "Visa" } as never],
    });
    const { onSpec } = setup();
    await screen.findByRole("heading", { name: "Spending by category" });
    await userEvent.click(screen.getByRole("button", { name: "Customize…" }));
    // Checkboxes, not a Ctrl-click multi-select: one click ticks one account
    // and nothing else moves.
    await userEvent.click(within(screen.getByRole("group", { name: "Accounts" })).getByRole("checkbox", { name: "Visa" }));
    // Nothing has re-run yet — the report you were reading is still there.
    expect(onSpec).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onSpec).toHaveBeenCalledWith(expect.objectContaining({ accountIds: ["a-2"] }));
  });

  it("a second click unticks, and Cancel throws the whole edit away", async () => {
    useAccountStore.setState({
      accounts: [{ id: "a-1", name: "Checking" } as never, { id: "a-2", name: "Visa" } as never],
    });
    const { onSpec } = setup();
    await screen.findByRole("heading", { name: "Spending by category" });
    await userEvent.click(screen.getByRole("button", { name: "Customize…" }));
    const box = within(screen.getByRole("group", { name: "Accounts" })).getByRole("checkbox", { name: "Visa" });
    await userEvent.click(box);
    expect(box).toBeChecked();
    await userEvent.click(box);
    expect(box).not.toBeChecked();
    await userEvent.click(screen.getByRole("checkbox", { name: "Checking" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onSpec).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Customize report" })).not.toBeInTheDocument();
  });

  it("the period sits above the report, not under it", async () => {
    setup();
    const title = await screen.findByRole("heading", { name: "Spending by category" });
    const range = screen.getByRole("group", { name: "Report period" });
    const table = screen.getByRole("table", { name: "Spending by category" });
    // Node.compareDocumentPosition: 4 = the argument follows this node.
    expect(title.compareDocumentPosition(range) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(range.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("a half-typed custom date does not re-run the report", async () => {
    const { onSpec } = setup();
    await screen.findByRole("heading", { name: "Spending by category" });
    const from = screen.getByLabelText("From");
    // 7/1/20 is a date (2020) on the way to 7/1/2026; nothing runs until
    // the field is left.
    await userEvent.clear(from);
    await userEvent.type(from, "7/1/2026");
    expect(onSpec).not.toHaveBeenCalled();
    await userEvent.tab();
    expect(onSpec).toHaveBeenCalledTimes(1);
    expect(onSpec).toHaveBeenCalledWith(expect.objectContaining({ range: { from: "2026-07-01", to: "2026-08-31" } }));
  });

  it("shows a refusal instead of a blank page", async () => {
    setIpcHandlers({ run_report: () => { throw new Error("the date range ends before it starts"); } });
    setup();
    await waitFor(() => expect(screen.getByText(/ends before it starts/)).toBeInTheDocument());
  });

  it("Add to my favorite reports saves the kind WITH its scope and range, under a name", async () => {
    const { onSpec, onSave } = setup({ spec: { ...spec, accountIds: ["a-2"], rangeId: "previous_year" } });
    await screen.findByRole("heading", { name: "Spending by category" });
    await userEvent.click(screen.getByRole("button", { name: /Add to my favorite reports/ }));
    const name = screen.getByLabelText("Name:");
    await userEvent.clear(name);
    await userEvent.type(name, "Spending by category - Jordan");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).toMatchObject({
      id: "",
      name: "Spending by category - Jordan",
      kind: "spending_by_category",
      range_id: "previous_year",
      account_ids: ["a-2"],
      detail: null,
    });
    // The viewer now knows it is that saved report.
    await waitFor(() => expect(onSpec).toHaveBeenCalledWith(expect.objectContaining({ savedId: "saved-1", savedName: "Spending by category - Jordan" })));
  });

  it("a saved report shows its own name, and drilling out of it starts a new report", async () => {
    const { onSpec } = setup({ spec: { ...spec, savedId: "saved-1", savedName: "By Category - Sam" } });
    expect(await screen.findByRole("heading", { name: "By Category - Sam" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save changes to this report/ })).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("row", { name: "Open Groceries" }));
    await userEvent.click(await screen.findByRole("button", { name: "Make this a report" }));
    const next = onSpec.mock.calls[0][0] as ReportSpec;
    expect(next.kind).toBe("transactions_by_category");
    expect(next.savedId).toBeUndefined();
  });

  it("Customize's Rows and Chart choices reshape the table and ride in the spec", async () => {
    const { onSpec } = setup();
    await screen.findByRole("heading", { name: "Spending by category" });
    await userEvent.click(screen.getByRole("button", { name: "Customize…" }));
    await userEvent.selectOptions(screen.getByLabelText("Sort rows"), "name");
    await userEvent.click(screen.getByLabelText("Pie"));
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onSpec).toHaveBeenLastCalledWith(expect.objectContaining({ options: expect.objectContaining({ sort: "name", chart: "pie" }) }));
  });

  it("a sorted spec renders the rows in that order", async () => {
    setup({ spec: { ...spec, options: { sort: "name", combineUnderBps: 0, chart: "auto", depth: true, securityIds: [] } } });
    const table = await screen.findByRole("table", { name: "Spending by category" });
    const labels = within(table).getAllByRole("row").map((r) => r.textContent ?? "");
    // Automobile (a subtotal) breaks the run; Groceries and Fuel are in separate runs, so the order is unchanged here —
    // the shaping itself is covered in reportShape.test.ts; this checks nothing is lost.
    expect(labels.filter((l) => l.includes("Groceries"))).toHaveLength(1);
    expect(labels.filter((l) => l.includes("Net Income"))).toHaveLength(1);
  });
});

// What the code review found in the viewer.
describe("Customize, Save and Remove", () => {
  it("lets At least be typed as $50, and reads it on Apply", async () => {
    const { onSpec } = setup();
    await screen.findByRole("heading", { name: "Spending by category" });
    await userEvent.click(screen.getByRole("button", { name: "Customize…" }));
    const least = screen.getByLabelText("Smallest amount");
    await userEvent.type(least, "$50");
    expect(least).toHaveValue("$50");
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onSpec).toHaveBeenCalledWith(expect.objectContaining({ minCents: 5000, maxCents: null }));
  });

  it("tidies a typed amount when the box is left", async () => {
    setup({ spec: { ...spec, maxCents: 12_500 } });
    await screen.findByRole("heading", { name: "Spending by category" });
    await userEvent.click(screen.getByRole("button", { name: "Customize… (filtered)" }));
    const most = screen.getByLabelText("Largest amount");
    expect(most).toHaveValue("125.00");
    await userEvent.clear(most);
    await userEvent.type(most, "75");
    await userEvent.tab();
    expect(most).toHaveValue("75.00");
  });

  it("a comparison with one date cleared is sent as no comparison, not a blank date", async () => {
    const { onSpec } = setup({ spec: { ...spec, kind: "spending_comparison", compare: { from: "2026-07-01", to: "2026-07-31" } } });
    await screen.findByRole("heading", { name: "Spending by category" });
    await userEvent.click(screen.getByRole("button", { name: "Customize…" }));
    await userEvent.clear(screen.getByLabelText("Compare from"));
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onSpec).toHaveBeenCalledWith(expect.objectContaining({ compare: null }));
  });

  it("Save cannot be clicked twice while the first save is on its way", async () => {
    let finish: (r: SavedReport) => void = () => {};
    const onSave = vi.fn(() => new Promise<SavedReport>((res) => (finish = res)));
    setup({ onSave });
    await screen.findByRole("heading", { name: "Spending by category" });
    await userEvent.click(screen.getByRole("button", { name: /Add to my favorite reports/ }));
    const save = screen.getByRole("button", { name: "Save" });
    await userEvent.click(save);
    expect(save).toBeDisabled();
    await userEvent.click(save);
    expect(onSave).toHaveBeenCalledTimes(1);
    finish({ ...savedFromSpec(spec, "x"), id: "saved-1" });
  });

  it("a refused Remove from my favorites is shown, and the report stays", async () => {
    const onBack = vi.fn();
    const onDeleteSaved = vi.fn(async () => {
      throw new Error("the file is read-only");
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    setup({ spec: { ...spec, savedId: "saved-1", savedName: "Mine" }, onBack, onDeleteSaved });
    await screen.findByRole("heading", { name: "Mine" });
    await userEvent.click(screen.getByRole("button", { name: "Remove from my favorites" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("the file is read-only");
    expect(onBack).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe("in the file's region", () => {
  it("writes report cells and reads the amount filter the German way", () => {
    useFileFormat.getState().setFormat({ home_currency: "EUR", region: "de-DE" });
    expect(formatCell("money", 123456, null)).toBe("1.234,56");
    expect(formatCell("money", -123456, null)).toBe("(1.234,56)");
    expect(formatCell("percent", 4571, null)).toBe("45,7%");
    expect(centsOrNull("12,50")).toBe(1250);
    expect(centsOrNull("1.234,56 €")).toBe(123456);
    expect(centsOrNull("-40")).toBe(4000);
    expect(centsText(1250)).toBe("12,50");
  });
});
