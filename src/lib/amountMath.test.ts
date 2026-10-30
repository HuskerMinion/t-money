// Sums typed into an amount box (amountMath.ts, through parseMoneyToCents).
import { afterEach, describe, expect, it } from "vitest";
import { formatAmountTyped, parseMoneyStrict, parseMoneyToCents } from "./format";
import { looksLikeSum } from "./amountMath";
import { useFileFormat } from "./region";

afterEach(() => {
  useFileFormat.getState().setFormat({ home_currency: "USD", region: "en-US" });
});

describe("a sum in an amount box", () => {
  it("works out the four operations, in the usual order", () => {
    expect(parseMoneyToCents("12.99*4")).toBe(5196);
    expect(parseMoneyToCents("45+12.50-3")).toBe(5450);
    expect(parseMoneyToCents("10+2*3")).toBe(1600);
    expect(parseMoneyToCents("(120+35)/3")).toBe(5167);
    expect(parseMoneyToCents("12.99 × 2 ÷ 3")).toBe(866);
    expect(parseMoneyToCents("$20 - $4.50")).toBe(1550);
  });

  it("reads percent the way a till does", () => {
    expect(parseMoneyToCents("100+8.5%")).toBe(10850);
    expect(parseMoneyToCents("100-20%")).toBe(8000);
    expect(parseMoneyToCents("200*15%")).toBe(3000);
    // A rate as printed, with three decimals.
    expect(parseMoneyToCents("100+8.875%")).toBe(10888);
    expect(parseMoneyToCents("15%")).toBeNull();
  });

  it("rounds once, to the cent, half away from zero", () => {
    expect(parseMoneyToCents("10/3")).toBe(333);
    expect(parseMoneyToCents("0.05/2")).toBe(3);
    expect(parseMoneyToCents("0-0.05/2")).toBe(-3);
    expect(parseMoneyToCents("1.005*1")).toBe(101);
  });

  it("goes negative, and handles a leading minus", () => {
    expect(parseMoneyToCents("10-15")).toBe(-500);
    expect(parseMoneyToCents("-5+2")).toBe(-300);
    expect(parseMoneyToCents("-(5+2)")).toBe(-700);
  });

  it("refuses what is not a sum", () => {
    expect(parseMoneyToCents("12*")).toBeNull();
    expect(parseMoneyToCents("12/0")).toBeNull();
    expect(parseMoneyToCents("(12+3")).toBeNull();
    expect(parseMoneyToCents("abc+1")).toBeNull();
    expect(parseMoneyToCents("1.234.5+1")).toBeNull();
  });

  it("reads a lone number in brackets as the accounting negative, even in a sum", () => {
    expect(parseMoneyToCents("(405.26)-20")).toBe(-42526);
    expect(parseMoneyToCents("(12.50)*2")).toBe(-2500);
    expect(parseMoneyToCents("(120+35)/3")).toBe(5167);
  });

  it("takes digits only, not the other ways JavaScript writes a number", () => {
    expect(parseMoneyToCents("1e3+0")).toBeNull();
    expect(parseMoneyToCents("0x10+1")).toBeNull();
  });

  it("refuses a pasted page of brackets or minus signs rather than recursing on it", () => {
    expect(parseMoneyToCents("-".repeat(100_000) + "1")).toBeNull();
    expect(parseMoneyToCents("(".repeat(100_000) + "1")).toBeNull();
    expect(looksLikeSum("(".repeat(100_000))).toBe(false);
  });

  it("leaves plain amounts exactly as they were", () => {
    expect(parseMoneyToCents("1,234.56")).toBe(123456);
    expect(parseMoneyToCents("(12.50)")).toBe(-1250);
    expect(parseMoneyToCents("-12.50")).toBe(-1250);
    expect(looksLikeSum("(12.50)")).toBe(false);
    expect(looksLikeSum("-12.50")).toBe(false);
    expect(looksLikeSum("12-3")).toBe(true);
  });

  it("the strict reader, for search boxes, takes no sums", () => {
    expect(parseMoneyStrict("12.99*4")).toBeNull();
    expect(parseMoneyStrict("7-11")).toBeNull();
    expect(parseMoneyStrict("12.50")).toBe(1250);
  });

  it("reads each number the file's region's way", () => {
    useFileFormat.getState().setFormat({ home_currency: "EUR", region: "de-DE" });
    expect(parseMoneyToCents("12,50*2")).toBe(2500);
    expect(parseMoneyToCents("1.234,50+0,50")).toBe(123500);
    expect(parseMoneyToCents("100+19%")).toBe(11900);
    // A rate is a rate however its point is written: never eight thousand.
    expect(parseMoneyToCents("100+8.875%")).toBe(10888);
    expect(parseMoneyToCents("100+8,875%")).toBe(10888);
    expect(formatAmountTyped(123500)).toBe("1.235,00");
    expect(formatAmountTyped(-1200)).toBe("-12,00");
  });

  it("writes the result back with the region's marks", () => {
    expect(formatAmountTyped(519600)).toBe("5,196.00");
    expect(formatAmountTyped(-500)).toBe("-5.00");
  });
});
