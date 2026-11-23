import { describe, expect, it } from "vitest";
import { nextMonthlyDate, nextScheduledDate } from "./scheduleDraft";

describe("nextScheduledDate", () => {
  it("yearly keeps the month and day, from the next one not yet past", () => {
    expect(nextScheduledDate("yearly", "2026-03-10", "2026-11-23")).toBe("2027-03-10");
    expect(nextScheduledDate("yearly", "2026-12-01", "2026-11-23")).toBe("2027-12-01");
    expect(nextScheduledDate("yearly", "2020-06-01", "2026-11-23")).toBe("2027-06-01");
    // A Feb 29 payment comes on the 28th in other years.
    expect(nextScheduledDate("yearly", "2024-02-29", "2024-03-01")).toBe("2025-02-28");
    expect(nextScheduledDate("yearly", "2024-02-29", "2027-03-01")).toBe("2028-02-29");
  });

  it("weekly keeps the weekday", () => {
    expect(nextScheduledDate("weekly", "2026-11-02", "2026-11-23")).toBe("2026-11-23");
    expect(nextScheduledDate("weekly", "2026-12-28", "2026-12-30")).toBe("2027-01-04");
  });

  it("monthly and twice a month are the monthly date; once has none", () => {
    expect(nextScheduledDate("monthly", "2026-01-31", "2026-01-01")).toBe(nextMonthlyDate("2026-01-31", "2026-01-01"));
    expect(nextScheduledDate("semi_monthly", "2026-01-31", "2026-01-01")).toBe("2026-02-28");
    expect(nextScheduledDate("once", "2026-01-31", "2026-01-01")).toBeNull();
  });
});
