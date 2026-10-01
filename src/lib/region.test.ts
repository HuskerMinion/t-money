// The frontend's half of the region table must write what region.rs writes:
// the same cases as `money_is_written_the_regions_way` and
// `dates_are_written_in_the_regions_order`, through the app's formatters.
import { describe, expect, it } from "vitest";
import { formatAmountBare, formatDateUS, formatMoney, formatRate, formatScaled, parseMoneyToCents, parseRateToMicro } from "./format";
import { parseTypedDate } from "../components/DateField";
import { homeName, symbolFor } from "./currency";
import { REGIONS, useFileFormat } from "./region";

function use(home: string, region: string) {
  useFileFormat.getState().setFormat({ home_currency: home, region });
}

describe("money in each region", () => {
  it("writes what the backend writes", () => {
    use("USD", "en-US");
    expect(formatMoney(123_456, { parens: false })).toBe("$1,234.56");
    expect(formatMoney(-123_456, { parens: false })).toBe("-$1,234.56");
    expect(formatMoney(123_456, { currency: "EUR" })).toBe("€1,234.56");
    expect(formatMoney(123_456, { currency: "CAD" })).toBe("CA$1,234.56");
    use("CAD", "en-CA");
    expect(formatMoney(123_456)).toBe("$1,234.56");
    expect(formatMoney(123_456, { currency: "USD" })).toBe("US$1,234.56");
    use("EUR", "de-DE");
    expect(formatMoney(123_456_789)).toBe("1.234.567,89\u00a0€");
    expect(formatMoney(-5, { parens: false })).toBe("-0,05\u00a0€");
    expect(formatMoney(-5)).toBe("(0,05\u00a0€)");
    use("EUR", "fr-FR");
    expect(formatMoney(123_456)).toBe("1\u202f234,56\u00a0€");
    use("CAD", "fr-CA");
    expect(formatMoney(123_456)).toBe("1\u00a0234,56\u00a0$");
    use("EUR", "nl-NL");
    expect(formatMoney(123_456)).toBe("€\u00a01.234,56");
    use("GBP", "en-GB");
    expect(formatMoney(0)).toBe("£0.00");
    expect(homeName()).toBe("British pounds");
  });

  it("writes bare amounts, rates and shares with the region's marks", () => {
    use("EUR", "de-DE");
    expect(formatAmountBare(-172_332)).toBe("1.723,32");
    expect(formatRate(5_875_000)).toBe("5,875");
    expect(formatScaled(12_345_678, 3)).toBe("12.345,678");
    expect(symbolFor("USD")).toBe("US$");
  });

  it("every region names a currency the app has a symbol for", () => {
    for (const r of REGIONS) expect(symbolFor(r.currency, r)).not.toMatch(/ $/);
  });
});

describe("typing money in each region", () => {
  it("reads the region's marks and forgives the other decimal mark", () => {
    use("EUR", "de-DE");
    expect(parseMoneyToCents("1.234,56 €")).toBe(123_456);
    expect(parseMoneyToCents("12,5")).toBe(1_250);
    expect(parseMoneyToCents("12.50")).toBe(1_250);
    expect(parseMoneyToCents("1.234")).toBe(123_400);
    expect(parseMoneyToCents("(0,05 €)")).toBe(-5);
    expect(parseRateToMicro("5,875")).toBe(5_875_000);
    expect(parseRateToMicro("5.875")).toBe(5_875_000);
    use("EUR", "fr-FR");
    expect(parseMoneyToCents("1\u202f234,56\u00a0€")).toBe(123_456);
    expect(parseMoneyToCents("1 234,56")).toBe(123_456);
    use("USD", "en-US");
    expect(parseMoneyToCents("1,234.56")).toBe(123_456);
    expect(parseMoneyToCents("12,50")).toBe(1_250);
    expect(parseMoneyToCents("US$5")).toBe(500);
  });
});

describe("dates in each region", () => {
  it("are written in the region's order", () => {
    use("USD", "en-US");
    expect(formatDateUS("2026-10-01")).toBe("10/1/2026");
    use("GBP", "en-GB");
    expect(formatDateUS("2026-10-01")).toBe("01/10/2026");
    use("EUR", "de-DE");
    expect(formatDateUS("2026-10-01")).toBe("01.10.2026");
    use("CAD", "en-CA");
    expect(formatDateUS("2026-10-01")).toBe("2026-10-01");
    use("EUR", "nl-NL");
    expect(formatDateUS("2026-10-01")).toBe("01-10-2026");
  });

  it("are read in the region's order", () => {
    use("USD", "en-US");
    expect(parseTypedDate("8/3/2026")).toBe("2026-08-03");
    use("EUR", "de-DE");
    expect(parseTypedDate("3.8.2026")).toBe("2026-08-03");
    expect(parseTypedDate("03.08.26")).toBe("2026-08-03");
    expect(parseTypedDate("2026-08-03")).toBe("2026-08-03");
    expect(parseTypedDate("31.02.2026")).toBeNull();
    use("CAD", "en-CA");
    expect(parseTypedDate("2026-08-03")).toBe("2026-08-03");
    expect(parseTypedDate("8-3", "2026-01-01")).toBe("2026-08-03");
    expect(parseTypedDate("26-08-03")).toBe("2026-08-03");
  });
});

describe("one reader for every number field", () => {
  it("reads money, shares and rates the same way, and refuses what it would have to guess", async () => {
    const { parseMicro } = await import("./shares");
    use("EUR", "de-DE");
    expect(parseMoneyToCents("1.2345")).toBeNull();
    expect(parseMoneyToCents("0.123")).toBeNull();
    expect(parseMoneyToCents("1.2.3,45")).toBeNull();
    expect(parseMicro("0.125")).toBe(125_000);
    expect(parseMicro("1.234,5")).toBe(1_234_500_000);
    expect(parseMicro("12,3456")).toBe(12_345_600);
    expect(parseRateToMicro("5.875")).toBe(5_875_000);
    use("USD", "en-US");
    expect(parseMicro("1,5")).toBe(1_500_000);
    expect(parseMoneyToCents("1,5")).toBe(150);
    expect(parseMicro("1,234.567")).toBe(1_234_567_000);
    expect(parseMoneyToCents("1,234.567")).toBeNull();
    use("EUR", "fr-FR");
    expect(parseMicro("1.234,5")).toBeNull();
    expect(parseMoneyToCents("1.234,5")).toBeNull();
    expect(parseMicro("1.2.3")).toBeNull();
  });
});

describe("the region table matches the backend's", () => {
  it("has the same rows as region.rs, field for field", async () => {
    const rs: string = (await import("../../src-tauri/src/region.rs?raw")).default;
    const unescape = (v: string) =>
      v === "NBSP" ? " " : v === "NNBSP" ? " " : v.replace(/^"|"$/g, "");
    const rows = [...rs.matchAll(/Region \{ code: "([^"]+)", name: "([^"]+)", currency: "([A-Z]{3})", group: ("[^"]*"|NBSP|NNBSP), decimal: "([^"]+)", symbol_after: (true|false), symbol_space: (true|false), date_order: DateOrder::(\w+), date_sep: "([^"]+)" \}/g)].map(
      (m) => ({
        code: m[1],
        name: m[2],
        currency: m[3],
        group: unescape(m[4].trim()),
        decimal: m[5],
        symbol_after: m[6] === "true",
        symbol_space: m[7] === "true",
        date_order: m[8].toLowerCase(),
        date_sep: m[9],
      }),
    );
    expect(rows.length).toBe(REGIONS.length);
    expect(rows).toEqual(REGIONS);
  });
});
