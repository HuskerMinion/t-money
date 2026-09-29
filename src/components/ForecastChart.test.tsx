// The two rules that decide whether the forecast panel is readable.
//
// jsdom draws nothing, so these test the DECISIONS, not the picture: what
// range to plot, and whether a chart is the right form at all. Both were got
// wrong in the first version — a fixed zero-anchored range turned an account
// that was already overdrawn into a solid red block.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ForecastChart, { domainOf, isFlat } from "./ForecastChart";
import type { ForecastPoint } from "../lib/types";

function pts(values: number[]): ForecastPoint[] {
  return values.map((v, i) => ({
    date: `2026-09-${String(i + 1).padStart(2, "0")}`,
    delta_cents: 0,
    balance_cents: v,
  }));
}

describe("domainOf", () => {
  it("includes zero when the balance crosses it", () => {
    const d = domainOf([50000, -20000]);
    expect(d.showZero).toBe(true);
    expect(d.min).toBeLessThan(0);
    expect(d.max).toBeGreaterThan(0);
  });

  it("includes zero when the balance is already below it", () => {
    // The reported case: every value negative. The old code anchored the range
    // at zero and painted the whole panel.
    const d = domainOf([-3942, -3942]);
    expect(d.showZero).toBe(true);
    expect(d.max).toBeGreaterThanOrEqual(0);
  });

  it("includes zero when the balance comes close to it", () => {
    // Near-zero is exactly when "am I about to go negative" is the question.
    expect(domainOf([100000, 15000]).showZero).toBe(true);
  });

  it("leaves zero out when the account is nowhere near it", () => {
    // Forcing zero in here would squash three months of variation into the top
    // third of the panel and fill the rest with a flat block.
    const d = domainOf([240000, 821000]);
    expect(d.showZero).toBe(false);
    expect(d.min).toBeGreaterThan(0);
  });

  it("gives a flat series a range rather than a zero-height one", () => {
    const d = domainOf([5000, 5000, 5000]);
    expect(d.max).toBeGreaterThan(d.min);
  });
});

describe("isFlat", () => {
  it("recognizes a balance that never moves", () => {
    expect(isFlat([100, 100, 100])).toBe(true);
    expect(isFlat([100, 101, 100])).toBe(false);
    expect(isFlat([])).toBe(false);
  });
});

describe("<ForecastChart />", () => {
  it("says so in words when nothing is projected to change", () => {
    // The form heuristic's first question: a single unchanging value is a
    // number, not a chart. 90 days of a flat line says nothing and fills the
    // panel doing it.
    render(<ForecastChart points={pts([-3942, -3942, -3942])} lowDate="2026-09-01" />);
    expect(screen.getByText(/not projected to change/i)).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("draws a chart when the balance actually moves", () => {
    render(<ForecastChart points={pts([100000, 90000, 120000])} lowDate="2026-09-02" />);
    expect(screen.getByRole("img")).toBeInTheDocument();
  });

  it("gives each instance its own clip ids", () => {
    // Two forecasts on one page shared `tm-fc-above`/`tm-fc-below`, and the
    // FIRST definition won for both — so the second chart was clipped by the
    // first one's baseline and rendered almost nothing.
    const a = render(<ForecastChart points={pts([100000, 90000, 120000])} lowDate="2026-09-02" />);
    const b = render(<ForecastChart points={pts([500, -900, 200])} lowDate="2026-09-02" />);
    const idsOf = (c: HTMLElement) =>
      [...c.querySelectorAll("clipPath")].map((n) => n.getAttribute("id"));
    const first = idsOf(a.container);
    const second = idsOf(b.container);
    expect(first.length).toBeGreaterThan(0);
    expect(first.some((id) => second.includes(id))).toBe(false);
  });

  it("names the low point for a screen reader", () => {
    render(<ForecastChart points={pts([100000, 40000, 120000])} lowDate="2026-09-02" />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(/Lowest \$400\.00/);
  });
});
