// @vitest-environment jsdom
// The report chart's styles (§59): every one draws from the same numbers,
// and the depth switch changes the marks, not the data.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ReportChart, { baseKind, CHART_STYLES, niceStep, shortMoney } from "./ReportChart";
import type { ReportChart as ChartData } from "../lib/types";

const one: ChartData = { kind: "bar", series: [{ label: "Total", points: [["Groceries", 16_000], ["Automobile", 7_000], ["Refund", -2_000]] }] };
const two: ChartData = {
  kind: "line",
  series: [
    { label: "Income", points: [["Jan", 500_000], ["Feb", 520_000], ["Mar", 510_000]] },
    { label: "Expenses", points: [["Jan", 400_000], ["Feb", 450_000], ["Mar", 380_000]] },
  ],
};

// §166 — a slice, a bar or a legend entry is a click on the thing it stands
// for; without a handler the chart is inert, as it always was.
describe("ReportChart clicks (§166)", () => {
  it("a bar says what it is and hands its label to onPick", async () => {
    const onPick = vi.fn();
    render(<ReportChart chart={one} style="bar" onPick={onPick} />);
    const bar = screen.getByRole("button", { name: "Automobile: $70.00" });
    await userEvent.click(bar);
    expect(onPick).toHaveBeenCalledWith("Automobile");
    bar.focus();
    await userEvent.keyboard("{Enter}");
    expect(onPick).toHaveBeenCalledTimes(2);
  });

  it("a pie slice and its legend entry both pick the slice", async () => {
    const onPick = vi.fn();
    const pie: ChartData = { kind: "pie", series: [{ label: "Balance", points: [["Bank accounts", 300_000], ["Investments", 900_000]] }] };
    render(<ReportChart chart={pie} style="pie" onPick={onPick} />);
    await userEvent.click(screen.getByRole("button", { name: "Investments: $9,000.00" }));
    expect(onPick).toHaveBeenLastCalledWith("Investments");
    const legend = screen.getByRole("list", { name: "Legend" });
    await userEvent.click(within(legend).getAllByRole("button")[0]);
    expect(onPick).toHaveBeenLastCalledWith("Bank accounts");
  });

  it("is inert without a handler", () => {
    render(<ReportChart chart={one} style="bar" />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("ReportChart (§59)", () => {
  it("maps every style onto an engine kind", () => {
    expect(CHART_STYLES.map((c) => baseKind(c.value))).toEqual(["bar", "bar", "bar", "line", "line", "pie", "pie"]);
  });

  it("draws bars with depth: a lit top and a shaded side per bar, plus the front", () => {
    const { container } = render(<ReportChart chart={one} style="bar" depth />);
    expect(screen.getByRole("img", { name: /bar chart/ })).toBeInTheDocument();
    // Three values → three fronts, three tops, three sides.
    expect(container.querySelectorAll("rect[fill^='url(#bg-']").length).toBe(3);
    expect(container.querySelectorAll("polygon").length).toBe(6);
    expect(container.querySelector("title")?.textContent).toBe("Groceries: $160.00");
  });

  it("draws flat bars with no faces", () => {
    const { container } = render(<ReportChart chart={one} style="bar" depth={false} />);
    expect(container.querySelectorAll("polygon").length).toBe(0);
    expect(container.querySelectorAll("rect[fill^='url(#bg-']").length).toBe(3);
  });

  it("stacks two series into one bar per label, with one top face each", () => {
    const { container } = render(<ReportChart chart={two} style="stacked" depth />);
    expect(container.querySelectorAll("rect[fill^='url(#bg-']").length).toBe(6);
    // 3 tops (outermost segment only) + 6 sides.
    expect(container.querySelectorAll("polygon").length).toBe(9);
    expect(screen.getByRole("list", { name: "Legend" })).toHaveTextContent("Income");
  });

  it("turns the axes for a horizontal bar chart", () => {
    const { container } = render(<ReportChart chart={one} style="hbar" depth={false} />);
    const texts = Array.from(container.querySelectorAll("text")).map((t) => t.textContent);
    expect(texts).toContain("Groceries");
    // Category labels sit at the left (text-anchor end), value ticks along the bottom (middle).
    const grocery = Array.from(container.querySelectorAll("text")).find((t) => t.textContent === "Groceries")!;
    expect(grocery.getAttribute("text-anchor")).toBe("end");
  });

  it("draws lines and areas, with a shadow only in depth", () => {
    const { container, rerender } = render(<ReportChart chart={two} style="line" depth />);
    expect(container.querySelectorAll("path[stroke][fill='none']").length).toBe(2);
    expect(container.querySelectorAll("path[filter]").length).toBe(2);
    rerender(<ReportChart chart={two} style="area" depth={false} />);
    expect(container.querySelectorAll("path[fill^='url(#ag-']").length).toBe(2);
    expect(container.querySelectorAll("path[filter]").length).toBe(0);
  });

  it("draws a pie with walls in depth and a doughnut with a hole", () => {
    const { container, rerender } = render(<ReportChart chart={one} style="pie" depth />);
    expect(screen.getByRole("img", { name: /by share/ })).toBeInTheDocument();
    // Two positive slices (the refund is left out); each has a top path.
    const legend = screen.getByRole("list", { name: "Legend" });
    expect(legend).toHaveTextContent("Groceries");
    expect(legend).not.toHaveTextContent("Refund");
    expect(legend).toHaveTextContent("69.6%");
    const tops = container.querySelectorAll("path[fill^='url(#pg-']");
    expect(tops.length).toBe(2);
    // The front rim is walled; both slices touch the front half (Groceries spans past 0 rad).
    expect(container.querySelectorAll("path[fill^='color-mix']").length).toBeGreaterThan(0);
    // Percent labels on the slices.
    expect(container.textContent).toContain("70%");
    rerender(<ReportChart chart={one} style="doughnut" depth={false} />);
    expect(container.querySelectorAll("path[fill^='color-mix']").length).toBe(0);
    expect(container.querySelectorAll("path[fill^='url(#pg-']").length).toBe(2);
    // A doughnut slice's path has both an outer and an inner arc.
    expect((container.querySelector("path[fill^='url(#pg-']") as SVGPathElement).getAttribute("d")!.split("A").length).toBe(3);
  });

  it("falls back to the table with too little to draw", () => {
    render(<ReportChart chart={{ kind: "bar", series: [{ label: "Total", points: [["Only", 100]] }] }} />);
    expect(screen.getByText(/Not enough to chart/)).toBeInTheDocument();
  });

  it("keeps the nice axis step", () => {
    expect(niceStep(16_000)).toBe(5_000);
    expect(niceStep(0)).toBe(100);
  });
});

// §183 — an axis label is the value at its gridline.
describe("shortMoney", () => {
  it("keeps one decimal under $10k, so $1,500 is not 2k", () => {
    expect(shortMoney(150_000)).toBe("1.5k");
    expect(shortMoney(250_000)).toBe("2.5k");
    expect(shortMoney(200_000)).toBe("2k");
    expect(shortMoney(-150_000)).toBe("-1.5k");
  });
  it("rounds to whole thousands from $10k, and to millions past that", () => {
    expect(shortMoney(1_500_000)).toBe("15k");
    expect(shortMoney(150_000_000)).toBe("1.5M");
    expect(shortMoney(50_00)).toBe("50");
  });
});
