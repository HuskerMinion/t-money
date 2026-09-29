import { describe, expect, it } from "vitest";
import { allocateLots, cashEffect, formatPrice, formatShares, isLongTerm, mulDiv, parseMicro, priceFrom, valueCents } from "./shares";

describe("shares and prices in millionths", () => {
  it("parses decimals exactly and refuses what it cannot keep", () => {
    expect(parseMicro("12.3456")).toBe(12_345_600);
    expect(parseMicro("100")).toBe(100_000_000);
    expect(parseMicro(".5")).toBe(500_000);
    expect(parseMicro("1,234.5")).toBe(1_234_500_000);
    expect(parseMicro("-2")).toBe(-2_000_000);
    expect(parseMicro("0.1234567")).toBeNull();
    expect(parseMicro("abc")).toBeNull();
    expect(parseMicro("")).toBeNull();
    expect(parseMicro(".")).toBeNull();
  });

  it("prints shares without trailing zeros and prices to 2 or 4 places", () => {
    expect(formatShares(12_345_600)).toBe("12.3456");
    expect(formatShares(100_000_000)).toBe("100");
    expect(formatShares(-500_000)).toBe("-0.5");
    expect(formatPrice(34_567_800)).toBe("34.5678");
    // Five and six places survive, so a fund priced to the mill round-trips.
    expect(formatPrice(34_567_890)).toBe("34.56789");
    expect(formatPrice(1_000_123)).toBe("1.000123");
    expect(formatPrice(10_000_000)).toBe("10.00");
    expect(formatPrice(189_250_000)).toBe("189.25");
    expect(formatPrice(1_234_500_000)).toBe("1,234.50");
    expect(formatPrice(null)).toBe("");
  });

  it("matches the backend's arithmetic to the cent", () => {
    expect(valueCents(12_345_600, 34_567_800)).toBe(42_676);
    expect(priceFrom(123_456, 100_000_000)).toBe(12_345_600);
    expect(priceFrom(100, 0)).toBeNull();
    expect(mulDiv(10, 1, 4)).toBe(3);
    expect(mulDiv(-10, 1, 4)).toBe(-3);
    expect(mulDiv(7, 1, 3)).toBe(2);
  });

  it("knows what each activity does to cash", () => {
    expect(cashEffect("buy", 10_000, 495)).toBe(-10_495);
    expect(cashEffect("sell", 10_000, 495)).toBe(9_505);
    expect(cashEffect("reinvest_dividend", 625, 0)).toBe(0);
    expect(cashEffect("dividend", 625, 0)).toBe(625);
    expect(cashEffect("split", 0, 0)).toBe(0);
  });

  it("long-term means more than a year", () => {
    expect(isLongTerm("2025-03-10", "2026-03-10")).toBe(false);
    expect(isLongTerm("2025-03-10", "2026-03-11")).toBe(true);
  });

  it("allocates a sale by Money's distribution methods", () => {
    const lots = [
      { id: "a", acquired_on: "2024-01-10", shares_micro: 100_000_000, cost_cents: 100_000 }, // $10/sh
      { id: "b", acquired_on: "2025-06-10", shares_micro: 100_000_000, cost_cents: 300_000 }, // $30/sh
      { id: "c", acquired_on: "2025-09-10", shares_micro: 50_000_000, cost_cents: 100_000 }, // $20/sh
    ];
    expect(allocateLots(lots, 150_000_000, "fifo")).toEqual({});
    expect(allocateLots(lots, 120_000_000, "lifo")).toEqual({ c: 50_000_000, b: 70_000_000 });
    expect(allocateLots(lots, 120_000_000, "max_gain")).toEqual({ a: 100_000_000, c: 20_000_000 });
    expect(allocateLots(lots, 120_000_000, "min_gain")).toEqual({ b: 100_000_000, c: 20_000_000 });
    expect(allocateLots(lots, 999_000_000, "lifo")).toEqual({});
  });
});

// The file's rounding. Some brokers truncate; the default rounds half away.
describe("valueCents rounding", () => {
  it("20.125 × 10.07 is 202.66 nearest and 202.65 down; 10.25 × 50.07 is 513.22 / 513.21", () => {
    expect(valueCents(20_125_000, 10_070_000)).toBe(20_266);
    expect(valueCents(20_125_000, 10_070_000, "down")).toBe(20_265);
    expect(valueCents(10_250_000, 50_070_000)).toBe(51_322);
    expect(valueCents(10_250_000, 50_070_000, "down")).toBe(51_321);
    // An exact product is the same either way.
    expect(valueCents(10_000_000, 30_000_000, "down")).toBe(30_000);
  });
});

