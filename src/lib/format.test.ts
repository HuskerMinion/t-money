// Money/date formatting — the one place a cents-vs-dollars slip would
// silently corrupt every number on screen.
import { describe, expect, it } from "vitest";
import {
  currentMonth,
  formatAccountingBare,
  formatAmountBare,
  formatDateUS,
  formatMoney,
  formatRate,
  parseMoneyToCents,
  parseRateToMicro,
  today,
} from "./format";

describe("formatMoney", () => {
  it("formats zero and whole dollars", () => {
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(100)).toBe("$1.00");
  });

  it("keeps two decimal places, padding single-digit cents", () => {
    expect(formatMoney(105)).toBe("$1.05");
    expect(formatMoney(1)).toBe("$0.01");
  });

  it("adds thousands separators", () => {
    expect(formatMoney(123842)).toBe("$1,238.42");
    expect(formatMoney(1234567890)).toBe("$12,345,678.90");
  });

  it("uses accounting parens for negatives by default", () => {
    expect(formatMoney(-4250)).toBe("($42.50)");
    expect(formatMoney(-123842)).toBe("($1,238.42)");
  });

  it("uses a leading minus when parens are disabled", () => {
    expect(formatMoney(-4250, { parens: false })).toBe("-$42.50");
  });
});

describe("parseMoneyToCents", () => {
  it("parses plain and decorated dollar amounts", () => {
    expect(parseMoneyToCents("123.45")).toBe(12345);
    expect(parseMoneyToCents("$1,234.56")).toBe(123456);
    expect(parseMoneyToCents(" 42 ")).toBe(4200);
  });

  it("parses negatives", () => {
    expect(parseMoneyToCents("-1,234.56")).toBe(-123456);
    expect(parseMoneyToCents("-0.99")).toBe(-99);
  });

  it("never multiplies a float — cents come from the digits", () => {
    expect(parseMoneyToCents("0.1")).toBe(10);
    expect(parseMoneyToCents("19.99")).toBe(1999);
    expect(parseMoneyToCents("1.1")).toBe(110);
    expect(parseMoneyToCents(".5")).toBe(50);
    // A third decimal is not money in this app; refuse rather than round
    // in one of two directions.
    expect(parseMoneyToCents("1.115")).toBeNull();
  });

  it("reads the accounting form this app's own formatters write", () => {
    // The reconcile wizard seeds its starting balance with
    // formatAccountingBare; a negative one used to parse as null → $0.
    expect(parseMoneyToCents("(405.26)")).toBe(-40526);
    expect(parseMoneyToCents("($1,234.56)")).toBe(-123456);
    expect(parseMoneyToCents("(0.00)")).toBe(0);
  });

  it("returns null for empty or partial input", () => {
    expect(parseMoneyToCents("")).toBeNull();
    expect(parseMoneyToCents("   ")).toBeNull();
    expect(parseMoneyToCents("-")).toBeNull();
    expect(parseMoneyToCents(".")).toBeNull();
  });

  it("returns null for non-numeric input", () => {
    expect(parseMoneyToCents("abc")).toBeNull();
    expect(parseMoneyToCents("12.34.56")).toBeNull();
    expect(parseMoneyToCents("1e5")).toBeNull();
  });

  it("round-trips through formatMoney", () => {
    for (const cents of [0, 1, 99, 100, 4250, -4250, 123842, -1234567]) {
      expect(parseMoneyToCents(formatMoney(cents, { parens: false }))).toBe(cents);
    }
  });
});

describe("date helpers", () => {
  it("currentMonth is YYYY-MM", () => {
    expect(currentMonth()).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
  });

  it("today is YYYY-MM-DD and starts with currentMonth", () => {
    expect(today()).toMatch(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);
    expect(today().startsWith(currentMonth())).toBe(true);
  });
});

describe("register formatting (§6.1a)", () => {
  it("formatDateUS converts ISO to M/D/YYYY without zero padding", () => {
    expect(formatDateUS("2026-08-30")).toBe("8/30/2026");
    expect(formatDateUS("2026-01-05")).toBe("1/5/2026");
    expect(formatDateUS("2026-12-25")).toBe("12/25/2026");
  });

  it("formatDateUS tolerates a timestamp suffix", () => {
    expect(formatDateUS("2026-08-30T12:00:00Z")).toBe("8/30/2026");
  });

  it("formatDateUS returns unparseable input unchanged", () => {
    expect(formatDateUS("")).toBe("");
    expect(formatDateUS("not a date")).toBe("not a date");
  });

  it("formatAmountBare drops the sign and the currency symbol", () => {
    expect(formatAmountBare(-172332)).toBe("1,723.32");
    expect(formatAmountBare(172332)).toBe("1,723.32");
    expect(formatAmountBare(0)).toBe("0.00");
    expect(formatAmountBare(-5)).toBe("0.05");
  });

  it("formatAccountingBare parenthesizes negatives, no currency symbol", () => {
    expect(formatAccountingBare(-40526)).toBe("(405.26)");
    expect(formatAccountingBare(368732)).toBe("3,687.32");
    expect(formatAccountingBare(0)).toBe("0.00");
  });
});

// §94 — a rate is millionths of a percent, for the same reason money is cents.
describe("parseRateToMicro / formatRate", () => {
  it("parses a rate as an exact integer of millionths", () => {
    expect(parseRateToMicro("5.875")).toBe(5_875_000);
    expect(parseRateToMicro("5.875%")).toBe(5_875_000);
    expect(parseRateToMicro("24.99")).toBe(24_990_000);
    expect(parseRateToMicro("0")).toBe(0);
    expect(parseRateToMicro(".5")).toBe(500_000);
    expect(parseRateToMicro("3.")).toBe(3_000_000);
  });

  it("refuses what it cannot represent rather than rounding it", () => {
    expect(parseRateToMicro("")).toBeNull();
    expect(parseRateToMicro(".")).toBeNull();
    expect(parseRateToMicro("6.1234567")).toBeNull(); // seven decimals
    expect(parseRateToMicro("-3")).toBeNull(); // a loan at minus three percent is a typo
    expect(parseRateToMicro("six")).toBeNull();
  });

  it("round-trips what it printed", () => {
    expect(formatRate(5_875_000)).toBe("5.875");
    expect(formatRate(7_000_000)).toBe("7");
    expect(formatRate(0)).toBe("0");
    for (const s of ["5.875", "0.0001", "24.99", "18"]) {
      expect(formatRate(parseRateToMicro(s)!)).toBe(Number(s).toString());
    }
  });
});
