import { describe, expect, it } from "vitest";
import { chartFor, chartStyleFor, DEFAULT_OPTIONS, normalizeOptions, shapeReport } from "./reportShape";
import type { Report, ReportLine } from "./types";

const row = (label: string, cents: number, level = 0, style: ReportLine["style"] = "normal"): ReportLine => ({
  key: label,
  key_kind: "category",
  label,
  level,
  style,
  cells: [{ text: null, cents }, { text: null, cents: 0 }],
});
const header = (label: string): ReportLine => ({ key: null, key_kind: null, label, level: 0, style: "header", cells: [] });
const total = (label: string, cents: number): ReportLine => ({ key: null, key_kind: null, label, level: 0, style: "total", cells: [{ text: null, cents }, { text: null, cents: null }] });

const report: Report = {
  kind: "spending_by_category",
  title: "",
  subtitle: "",
  columns: [
    { label: "Category", kind: "text" },
    { label: "Total", kind: "money" },
    { label: "%", kind: "percent" },
  ],
  rows: [
    header("Expense Categories"),
    row("Automobile", -7000, 0, "subtotal"),
    row("Fuel", -7000, 1),
    row("Groceries", -16000),
    row("Coffee", -300),
    row("Stamps", -100),
    row("Rent", -80000),
    total("Total Expenses", -103400),
  ],
  chart: { kind: "bar", series: [{ label: "Total", points: [["Groceries", 16000]] }] },
};

describe("shaping a report", () => {
  it("leaves the default alone and sorts blocks, children riding along", () => {
    expect(shapeReport(report, DEFAULT_OPTIONS)).toBe(report);
    const byAmount = shapeReport(report, { ...DEFAULT_OPTIONS, sort: "amount" }).rows.map((r) => r.label);
    // The subtotal row breaks the run: Automobile stays put; Fuel sorts alone inside its run
    expect(byAmount.slice(0, 2)).toEqual(["Expense Categories", "Automobile"]);
    expect(byAmount.slice(2, 7)).toEqual(["Rent", "Groceries", "Fuel", "Coffee", "Stamps"]);
    expect(byAmount[7]).toBe("Total Expenses");
    const byName = shapeReport(report, { ...DEFAULT_OPTIONS, sort: "name" }).rows.map((r) => r.label);
    expect(byName.slice(2, 7)).toEqual(["Coffee", "Fuel", "Groceries", "Rent", "Stamps"]);
  });

  it("folds the small ones into Other and keeps the totals", () => {
    const shaped = shapeReport(report, { ...DEFAULT_OPTIONS, combineUnderBps: 500 });
    const labels = shaped.rows.map((r) => r.label);
    expect(labels).toContain("Other (2 combined)");
    expect(labels).not.toContain("Coffee");
    const other = shaped.rows.find((r) => r.label.startsWith("Other"))!;
    expect(other.cells[0].cents).toBe(-400);
    expect(shaped.rows.find((r) => r.style === "total")!.cells[0].cents).toBe(-103400);
    // One small row alone is not worth an "Other".
    const one = shapeReport({ ...report, rows: [header("x"), row("A", -100), row("B", -1)] }, { ...DEFAULT_OPTIONS, combineUnderBps: 500 });
    expect(one.rows.map((r) => r.label)).toEqual(["x", "A", "B"]);
  });

  // A group row carries no amounts; its money is in the rows beneath it.
  const group = (label: string, level = 0): ReportLine => ({ key: label, key_kind: "category", label, level, style: "group", cells: [{ text: null, cents: null }, { text: null, cents: null }] });
  const blank = (label: string, level: number): ReportLine => ({ ...group(label, level), style: "normal" });
  const withGroup = (rows: ReportLine[]): Report => ({ ...report, rows: [header("Expense Categories"), ...rows, total("Total Expenses", 0)] });
  const small = [row("Groceries", -16000), row("Coffee", -300), row("Stamps", -100), row("Rent", -80000)];

  it("weighs a group-headed block by its children, so it does not always fold", () => {
    // 8,000 of 104,400 is 7.7%: over a 5% threshold, kept whole.
    const r = withGroup([group("Healthcare"), row("Doctor", -5000, 1), row("Dental", -3000, 1), ...small]);
    const kept = shapeReport(r, { ...DEFAULT_OPTIONS, combineUnderBps: 500 });
    expect(kept.rows.map((x) => x.label)).toContain("Healthcare");
    expect(kept.rows.map((x) => x.label)).toContain("Dental");
    expect(kept.rows.find((x) => x.label.startsWith("Other"))!.cells[0].cents).toBe(-400);
    // Sorted by amount it lands between Groceries and Coffee, children riding along.
    const sorted = shapeReport(r, { ...DEFAULT_OPTIONS, sort: "amount" }).rows.map((x) => x.label);
    expect(sorted.slice(1, 8)).toEqual(["Rent", "Groceries", "Healthcare", "Doctor", "Dental", "Coffee", "Stamps"]);
  });

  it("folds a group-headed block's money into Other rather than dropping it", () => {
    // Under 10%: Healthcare folds with Coffee and Stamps, and brings its 8,000.
    const r = withGroup([group("Healthcare"), row("Doctor", -5000, 1), row("Dental", -3000, 1), ...small]);
    const shaped = shapeReport(r, { ...DEFAULT_OPTIONS, combineUnderBps: 1000 });
    const other = shaped.rows.find((x) => x.label.startsWith("Other"))!;
    expect(other.label).toBe("Other (3 combined)");
    expect(other.cells[0].cents).toBe(-8400);
    expect(shaped.rows.map((x) => x.label)).not.toContain("Doctor");
  });

  it("values nested headings through to the rows that hold the money", () => {
    // category_txn_tree's shape: parent group → subcategory line (blank) → transactions.
    const r = withGroup([group("Tax"), blank("Federal", 1), row("09/01/2026", -2000, 2), row("09/15/2026", -2500, 2), row("Tax - state", -1000, 1), ...small]);
    const shaped = shapeReport(r, { ...DEFAULT_OPTIONS, combineUnderBps: 1000 });
    expect(shaped.rows.find((x) => x.label.startsWith("Other"))!.cells[0].cents).toBe(-5500 - 400);
  });

  it("does not count a row's breakdown on top of the row", () => {
    // A row with its own amount already includes the rows beneath it.
    const r = withGroup([row("Brokerage", -6000), row("Stocks", -4000, 1), row("Bonds", -2000, 1), ...small]);
    const shaped = shapeReport(r, { ...DEFAULT_OPTIONS, combineUnderBps: 1000 });
    expect(shaped.rows.find((x) => x.label.startsWith("Other"))!.cells[0].cents).toBe(-6400);
  });

  it("overrides the chart kind only when the data allows", () => {
    expect(chartFor(report, DEFAULT_OPTIONS)!.kind).toBe("bar");
    expect(chartFor(report, { ...DEFAULT_OPTIONS, chart: "pie" })!.kind).toBe("pie");
    const two = { ...report, chart: { kind: "line" as const, series: [{ label: "a", points: [] }, { label: "b", points: [] }] } };
    expect(chartFor(two, { ...DEFAULT_OPTIONS, chart: "pie" })!.kind).toBe("line");
    // The viewer's styles map onto the engine's kinds; a doughnut is a pie and needs one series too.
    expect(chartStyleFor(report, { ...DEFAULT_OPTIONS, chart: "doughnut" })).toBe("doughnut");
    expect(chartFor(report, { ...DEFAULT_OPTIONS, chart: "doughnut" })!.kind).toBe("pie");
    expect(chartStyleFor(two, { ...DEFAULT_OPTIONS, chart: "doughnut" })).toBe("line");
    expect(chartStyleFor(two, { ...DEFAULT_OPTIONS, chart: "stacked" })).toBe("stacked");
    expect(chartFor(two, { ...DEFAULT_OPTIONS, chart: "hbar" })!.kind).toBe("bar");
    expect(normalizeOptions({ chart: "area", depth: false }).depth).toBe(false);
    expect(normalizeOptions({ chart: "area" }).depth).toBe(true);
  });

  it("normalizes whatever a saved report carries", () => {
    expect(normalizeOptions(null)).toEqual(DEFAULT_OPTIONS);
    expect(normalizeOptions({ sort: "amount", combineUnderBps: 250.4, chart: "pie", securityIds: ["s-1"] })).toEqual({ sort: "amount", combineUnderBps: 250, chart: "pie", depth: true, securityIds: ["s-1"] });
    expect(normalizeOptions({ sort: "bogus" as never, combineUnderBps: -5, chart: "x" as never })).toEqual(DEFAULT_OPTIONS);
  });
});
