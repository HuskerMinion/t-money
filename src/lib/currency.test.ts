// The frontend's half of currency arithmetic must agree with fx.rs to the
// cent: the same cases as `rounding_is_half_away_from_zero_and_symmetric`.
import { describe, expect, it } from "vitest";
import { currencyOf, formatRate, isForeign, MICRO, rateOf, symbolFor, toHome, worthHome } from "./currency";
import { formatMoney, parseMoneyToCents } from "./format";

describe("toHome", () => {
  it("rounds half away from zero, the same both ways, as the backend does", () => {
    expect(toHome(1, 500_000)).toBe(1);
    expect(toHome(-1, 500_000)).toBe(-1);
    expect(toHome(1, 499_999)).toBe(0);
    expect(toHome(10_000, 1_087_500)).toBe(10_875);
    expect(toHome(-10_000, 1_087_500)).toBe(-10_875);
    expect(toHome(12_345, MICRO)).toBe(12_345);
    expect(toHome(3, 1_166_667)).toBe(4);
    expect(toHome(-987_654_321, 54_321)).toBe(-53_650_370);
  });

  it("stays exact past 2^53 in the intermediate product", () => {
    expect(toHome(90_000_000_000, 999_999_999)).toBe(89_999_999_910_000);
  });
});

describe("an account's currency", () => {
  it("is dollars when the account does not say", () => {
    expect(currencyOf({})).toBe("USD");
    expect(isForeign({})).toBe(false);
    expect(rateOf({})).toBe(MICRO);
  });

  it("uses today's rate for a foreign account, and 0 when there is none", () => {
    expect(rateOf({ currency: "EUR", home_rate_micro: 1_100_000 })).toBe(1_100_000);
    expect(rateOf({ currency: "EUR" })).toBe(0);
    expect(worthHome({ currency: "EUR", home_rate_micro: 1_100_000, balance_cents: 50_000 })).toBe(55_000);
  });
});

describe("writing currency amounts", () => {
  it("puts the account's symbol in front, and dollars by default", () => {
    expect(formatMoney(123_456)).toBe("$1,234.56");
    expect(formatMoney(123_456, { currency: "EUR" })).toBe("€1,234.56");
    expect(formatMoney(-500, { currency: "CAD" })).toBe("(CA$5.00)");
    expect(formatMoney(-500, { currency: "MXN", parens: false })).toBe("-MX$5.00");
    expect(symbolFor("GBP")).toBe("£");
    expect(symbolFor("XYZ")).toBe("XYZ ");
  });

  it("reads back what it writes", () => {
    expect(parseMoneyToCents("€1,234.56")).toBe(123_456);
    expect(parseMoneyToCents("(CA$5.00)")).toBe(-500);
    expect(parseMoneyToCents("-MX$5")).toBe(-500);
    expect(parseMoneyToCents("A$10")).toBe(1_000);
    expect(parseMoneyToCents("£7.25")).toBe(725);
    expect(parseMoneyToCents("12 EUR")).toBe(1_200);
    expect(parseMoneyToCents("$12x")).toBeNull();
  });

  it("writes a rate without trailing zeros", () => {
    expect(formatRate(1_087_500)).toBe("1.0875");
    expect(formatRate(54_321)).toBe("0.054321");
    expect(formatRate(2_000_000)).toBe("2");
  });
});
