import { describe, expect, it } from "vitest";
import { monthRange, monthTitle, recentMonths, resolveRange } from "./reportRanges";

describe("resolveRange", () => {
  const today = "2026-09-05";
  it("whole months and quarters", () => {
    expect(resolveRange("this_month", today)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(resolveRange("last_month", today)).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    expect(resolveRange("this_quarter", today)).toEqual({ from: "2026-07-01", to: "2026-09-30" });
    expect(resolveRange("last_quarter", today)).toEqual({ from: "2026-04-01", to: "2026-06-30" });
    expect(resolveRange("last_quarter", "2026-02-10")).toEqual({ from: "2025-10-01", to: "2025-12-31" });
    expect(resolveRange("last_month", "2026-01-10")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });
  it("years", () => {
    expect(resolveRange("year_to_date", today)).toEqual({ from: "2026-01-01", to: "2026-09-05" });
    expect(resolveRange("previous_year", today)).toEqual({ from: "2025-01-01", to: "2025-12-31" });
    expect(resolveRange("last_12_months", today)).toEqual({ from: "2025-10-01", to: "2026-09-30" });
    expect(resolveRange("last_12_months", "2026-12-15")).toEqual({ from: "2026-01-01", to: "2026-12-31" });
    expect(resolveRange("last_24_months", today)).toEqual({ from: "2024-10-01", to: "2026-09-30" });
    expect(resolveRange("last_24_months", "2026-12-15")).toEqual({ from: "2025-01-01", to: "2026-12-31" });
  });
  it("rolling day windows are inclusive of today", () => {
    expect(resolveRange("last_30_days", today)).toEqual({ from: "2026-08-07", to: "2026-09-05" });
    expect(resolveRange("last_90_days", "2026-03-01")).toEqual({ from: "2025-12-02", to: "2026-03-01" });
  });
  it("custom keeps what was there; February is 28 or 29 days", () => {
    const cur = { from: "2020-01-01", to: "2020-02-02" };
    expect(resolveRange("custom", today, cur)).toBe(cur);
    expect(resolveRange("this_month", "2028-02-10")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(monthRange("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });
});

describe("monthly report helpers", () => {
  it("labels and lists months Money's way", () => {
    expect(monthTitle("2026-09")).toBe("September, 2026");
    expect(recentMonths("2026-02-10", 4)).toEqual(["2026-02", "2026-01", "2025-12", "2025-11"]);
  });
});
