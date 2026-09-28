// §115 — the price timer's rule, and what the screen says about staleness.
//
// The rule matters more than it looks: this app's one outbound request has
// always been manual, and "automatically" must not quietly become "on every
// render" or "every thirty minutes for a week because the machine is
// offline". So the decision is a pure function of the stored status and the
// clock, and it is tested here rather than observed in a running app.
import { describe, expect, it } from "vitest";
import { daysBetween, isStale, localNow, refreshIsDue, stalenessNote, PRICE_INTERVALS } from "./prices";
import type { PriceStatus } from "./types";

const base: PriceStatus = {
  with_symbol: 3,
  newest_date: "2026-09-08",
  oldest_date: "2026-09-08",
  never_priced: 0,
  last_auto: null,
  interval: "off",
};

describe("when an automatic refresh is due", () => {
  it("is never due while the setting is off — the default", () => {
    expect(PRICE_INTERVALS[0].value).toBe("off");
    expect(refreshIsDue(base, "2027-01-01")).toBe(false);
    expect(refreshIsDue({ ...base, last_auto: "2020-01-01T00:00:00" }, "2027-01-01")).toBe(false);
  });

  it("is due at once when it has never run, so turning it on does something", () => {
    expect(refreshIsDue({ ...base, interval: "daily" }, "2026-09-08T09:00:00")).toBe(true);
  });

  it("is not due again the same day, and is the next one", () => {
    const s: PriceStatus = { ...base, interval: "daily", last_auto: "2026-09-08T09:00:00" };
    expect(refreshIsDue(s, "2026-09-08T23:59:00")).toBe(false);
    expect(refreshIsDue(s, "2026-09-09T00:01:00")).toBe(true);
  });

  it("waits a week on the weekly setting", () => {
    const s: PriceStatus = { ...base, interval: "weekly", last_auto: "2026-09-01T09:00:00" };
    expect(refreshIsDue(s, "2026-09-07T09:00:00")).toBe(false);
    expect(refreshIsDue(s, "2026-09-08T09:00:00")).toBe(true);
  });

  it("asks for nothing when there is no symbol to ask about", () => {
    // A file of checking accounts must not reach the network, ever.
    expect(refreshIsDue({ ...base, interval: "daily", with_symbol: 0 }, "2026-09-08")).toBe(false);
  });

  it("counts days, not hours", () => {
    expect(daysBetween("2026-09-01", "2026-09-08")).toBe(7);
    expect(daysBetween("2026-09-08T23:00:00", "2026-09-09T01:00:00")).toBe(1);
    // §180: unknown is null, not 0 — zero days reads as fresh.
    expect(daysBetween("nonsense", "2026-09-09")).toBeNull();
    expect(daysBetween("2026-09-09", "")).toBeNull();
  });

  it("rejects dates that are not on the calendar rather than rolling them over (§180)", () => {
    expect(daysBetween("2026-02-30", "2026-03-02")).toBeNull();
    expect(daysBetween("2026-13-01", "2026-12-01")).toBeNull();
    expect(daysBetween("2026-09-31T09:00:00", "2026-10-01")).toBeNull();
    expect(daysBetween("2028-02-29", "2028-03-01")).toBe(1);
    // Across the spring-forward weekend, still whole days.
    expect(daysBetween("2026-03-07", "2026-03-09")).toBe(2);
  });

  it("treats a stamp it cannot read as due, not as fresh (§180)", () => {
    expect(refreshIsDue({ ...base, interval: "daily", last_auto: "garbage" }, "2026-09-08T09:00:00")).toBe(true);
    expect(refreshIsDue({ ...base, interval: "weekly", last_auto: "2026-02-30T09:00:00" }, "2026-03-02T09:00:00")).toBe(true);
  });

  it("compares local stamps with local time, so an evening check is not a day late (§180)", () => {
    // 9:30 p.m. local on the 15th: UTC in U.S. Central is already the 16th.
    const evening = new Date(2026, 8, 15, 21, 30, 5);
    expect(localNow(evening)).toBe("2026-09-15T21:30:05");
    expect(localNow(new Date(2026, 0, 2, 3, 4, 5))).toBe("2026-01-02T03:04:05");
    const s: PriceStatus = { ...base, interval: "daily", last_auto: "2026-09-15T09:00:00" };
    expect(refreshIsDue(s, localNow(evening))).toBe(false);
    expect(refreshIsDue(s, localNow(new Date(2026, 8, 16, 0, 1)))).toBe(true);
  });
});

describe("what the screen says about how old the prices are", () => {
  it("says nothing when there is nothing to price", () => {
    expect(stalenessNote({ ...base, with_symbol: 0 }, "2026-09-08")).toBeNull();
    expect(isStale({ ...base, with_symbol: 0 }, "2026-09-08")).toBe(false);
  });

  it("reads in the units a person would use", () => {
    expect(stalenessNote(base, "2026-09-08")).toBe("Prices are today's");
    expect(stalenessNote(base, "2026-09-09")).toBe("Prices are a day old");
    expect(stalenessNote(base, "2026-09-13")).toBe("Prices are 5 days old");
    expect(stalenessNote(base, "2026-10-06")).toBe("Prices are 4 weeks old");
    expect(stalenessNote(base, "2026-12-08")).toBe("Prices are 3 months old");
  });

  it("counts the WORST holding, not the newest price", () => {
    // The backend hands back the oldest of each security's newest price,
    // because a portfolio priced by one fresh symbol and two stale ones is
    // stale — the total is wrong either way.
    const s: PriceStatus = { ...base, newest_date: "2026-09-08", oldest_date: "2026-06-08" };
    expect(stalenessNote(s, "2026-09-08")).toBe("Prices are 3 months old");
    expect(isStale(s, "2026-09-08")).toBe(true);
  });

  it("mentions holdings that have never been priced", () => {
    expect(stalenessNote({ ...base, never_priced: 2 }, "2026-09-08")).toBe("Prices are today's · 2 never priced");
    expect(stalenessNote({ ...base, never_priced: 1, oldest_date: null }, "2026-09-08")).toBe("1 holding never priced");
    expect(isStale({ ...base, never_priced: 1 }, "2026-09-08")).toBe(true);
  });

  it("never calls a date it cannot read today's (§180)", () => {
    const bad: PriceStatus = { ...base, oldest_date: "2026-02-30" };
    expect(stalenessNote(bad, "2026-03-02")).toBe("Price dates could not be read");
    expect(isStale(bad, "2026-03-02")).toBe(true);
    expect(isStale(base, "not a date")).toBe(true);
  });

  it("calls a week old stale, and yesterday not", () => {
    expect(isStale(base, "2026-09-09")).toBe(false);
    expect(isStale(base, "2026-09-15")).toBe(true);
  });
});
