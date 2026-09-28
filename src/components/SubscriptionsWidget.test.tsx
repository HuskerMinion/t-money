// @vitest-environment jsdom
// Home's subscription reminder (§60).
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));
import SubscriptionsWidget, { parseIgnored, splitRows } from "./SubscriptionsWidget";
import { invokeCalls, resetIpc, setIpcHandlers } from "../test/tauriMock";
import type { Report, ReportLine } from "../lib/types";

const cell = (text: string | null, cents: number | null) => ({ text, cents });
const sub = (payee: string, billed: string, amount: number, last: string, next: string, n: number, year: number): ReportLine => ({
  key: `p-${payee}`, key_kind: "payee", label: payee, level: 1, style: "normal",
  cells: [cell(billed, null), cell(null, amount), cell(last, null), cell(next, null), cell(String(n), null), cell(null, year)],
});
const blanks = () => Array.from({ length: 6 }, () => cell(null, null));
const report: Report = {
  kind: "subscriptions", title: "Subscriptions and recurring charges", subtitle: "", chart: null,
  columns: [],
  rows: [
    { key: null, key_kind: null, label: "Active", level: 0, style: "header", cells: blanks() },
    sub("Netflix", "Every month", 1_549, "8/14/2026", "9/13/2026", 6, 18_588),
    sub("Amazon Prime", "Every year", 13_900, "2/3/2026", "2/3/2027", 2, 13_900),
    { key: null, key_kind: null, label: "Active per month", level: 0, style: "subtotal", cells: [cell(null, null), cell(null, 2_707), cell(null, null), cell(null, null), cell(null, null), cell(null, null)] },
    { key: null, key_kind: null, label: "Active per year", level: 0, style: "total", cells: [cell(null, null), cell(null, null), cell(null, null), cell(null, null), cell(null, null), cell(null, 32_488)] },
    { key: null, key_kind: null, label: "May have stopped", level: 0, style: "header", cells: blanks() },
    sub("Anytime Fitness", "Every month", 4_500, "5/1/2026", "5/31/2026", 5, 54_000),
  ],
};

beforeEach(() => {
  resetIpc();
  setIpcHandlers({ list_saved_reports: () => [], run_report: () => report });
});

describe("the Subscriptions card (§60)", () => {
  it("splits the report into active, stopped and the totals", () => {
    const p = splitRows(report);
    expect(p.active.map((r) => r.payee)).toEqual(["Netflix", "Amazon Prime"]);
    expect(p.stopped.map((r) => r.payee)).toEqual(["Anytime Fitness"]);
    expect(p.perMonth).toBe(2_707);
    expect(p.perYear).toBe(32_488);
  });

  it("runs the report over two years for the spending accounts and shows what is active", async () => {
    const onOpenReport = vi.fn();
    render(<SubscriptionsWidget onOpenReport={onOpenReport} />);
    const table = await screen.findByRole("table", { name: "Active subscriptions" });
    expect(table).toHaveTextContent("Netflix");
    expect(table).toHaveTextContent("9/13/2026");
    expect(screen.getByLabelText("Per month")).toHaveTextContent("$27.07");
    expect(screen.getByLabelText("Per year total")).toHaveTextContent("$324.88");
    const req = invokeCalls.find((c) => c.cmd === "run_report")!.args!.request as Record<string, unknown>;
    expect(req.kind).toBe("subscriptions");
    expect(req.account_ids).toBeNull();
    expect(String(req.from) < String(req.to)).toBe(true);
    // Stopped ones are folded away until asked for.
    expect(screen.queryByText(/Anytime Fitness/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /1 that may have stopped/ }));
    expect(screen.getByRole("list", { name: "Stopped subscriptions" })).toHaveTextContent("Anytime Fitness — $45.00 every month, last 5/1/2026");
    expect(screen.getByText(/Watching checking, savings, cash and card accounts/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open report" }));
    expect(onOpenReport).toHaveBeenCalledWith({ kind: "subscriptions", accountIds: undefined });
  });

  it("uses the accounts of a favorite Subscriptions report when there is one", async () => {
    setIpcHandlers({
      list_saved_reports: () => [
        { id: "s-2", name: "Subs - Sam", kind: "subscriptions", range_id: "last_24_months", from: "", to: "", account_ids: ["a-chk", "a-visa"], category_ids: [], compare_from: null, compare_to: null },
        { id: "s-1", name: "By Category", kind: "spending_by_category", range_id: "year_to_date", from: "", to: "", account_ids: ["a-x"], category_ids: [], compare_from: null, compare_to: null },
      ],
      run_report: () => report,
    });
    const onOpenReport = vi.fn();
    render(<SubscriptionsWidget onOpenReport={onOpenReport} />);
    await screen.findByRole("table", { name: "Active subscriptions" });
    const req = invokeCalls.find((c) => c.cmd === "run_report")!.args!.request as Record<string, unknown>;
    expect(req.account_ids).toEqual(["a-chk", "a-visa"]);
    expect(screen.getByText(/Watching the accounts in your favorite report/)).toHaveTextContent("Subs - Sam");
    await userEvent.click(screen.getByRole("button", { name: "Open report" }));
    expect(onOpenReport).toHaveBeenCalledWith({ kind: "subscriptions", accountIds: ["a-chk", "a-visa"] });
  });

  it("says so when nothing repeats", async () => {
    setIpcHandlers({ list_saved_reports: () => [], run_report: () => ({ ...report, rows: [report.rows[0], report.rows[3], report.rows[4]] }) });
    render(<SubscriptionsWidget onOpenReport={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/Nothing that repeats/)).toBeInTheDocument());
  });
});

describe("the ignore list (§76)", () => {
  it("hides an ignored charge, drops it from the totals, keeps it in the file, and can watch it again", async () => {
    let saved: string | null = JSON.stringify(["Amazon Prime"]);
    setIpcHandlers({
      list_saved_reports: () => [],
      run_report: () => report,
      get_ui_setting: () => saved,
      set_ui_setting: (a) => {
        saved = String(a!.value);
        return null;
      },
    });
    render(<SubscriptionsWidget onOpenReport={vi.fn()} />);
    const table = await screen.findByRole("table", { name: "Active subscriptions" });
    await waitFor(() => expect(table).not.toHaveTextContent("Amazon Prime"));
    expect(screen.getByLabelText("Per year total")).toHaveTextContent("$185.88");
    expect(screen.getByLabelText("Per month")).toHaveTextContent("$15.49");
    await userEvent.click(screen.getByRole("button", { name: "Ignore Netflix" }));
    expect(JSON.parse(saved!)).toEqual(["Amazon Prime", "Netflix"]);
    expect(screen.getByText(/Nothing that repeats/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /2 ignored/ }));
    const list = screen.getByRole("list", { name: "Ignored subscriptions" });
    expect(list).toHaveTextContent("Amazon Prime — $139.00 every year");
    await userEvent.click(screen.getByRole("button", { name: "Watch Amazon Prime again" }));
    expect(JSON.parse(saved!)).toEqual(["Netflix"]);
    expect(await screen.findByRole("table", { name: "Active subscriptions" })).toHaveTextContent("Amazon Prime");
  });

  it("treats a missing or unreadable setting as an empty list", () => {
    expect(parseIgnored(null)).toEqual([]);
    expect(parseIgnored("not json")).toEqual([]);
    expect(parseIgnored('{"a":1}')).toEqual([]);
    expect(parseIgnored('["Mortgage", 3]')).toEqual(["Mortgage"]);
  });
});

// §183 — a failed save left the row hidden as if it had been ignored.
describe("§183 — a refused ignore is put back", () => {
  it("restores the row and says the list could not be saved", async () => {
    setIpcHandlers({
      list_saved_reports: () => [],
      run_report: () => report,
      get_ui_setting: () => null,
      set_ui_setting: () => {
        throw "the file is read-only";
      },
    });
    render(<SubscriptionsWidget onOpenReport={vi.fn()} />);
    const table = await screen.findByRole("table", { name: "Active subscriptions" });
    await userEvent.click(screen.getByRole("button", { name: "Ignore Netflix" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be saved: the file is read-only/);
    expect(table).toHaveTextContent("Netflix");
  });
});
