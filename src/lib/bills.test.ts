// What "All bank and cash accounts" adds up.
import { describe, expect, it } from "vitest";
import { spendableAccounts } from "./bills";

const a = (id: string, type: string, currency = "USD", is_closed = false) => ({ id, type, currency, is_closed });

describe("spendableAccounts", () => {
  it("is the open bank and cash accounts in the file's currency", () => {
    const accounts = [
      a("chk", "checking"),
      a("sav", "savings"),
      a("wallet", "cash"),
      a("visa", "credit"),
      a("brok", "investment"),
      a("old", "checking", "USD", true),
      a("eur", "checking", "EUR"),
    ];
    const ids = spendableAccounts(accounts, (x) => x.currency, "USD").map((x) => x.id);
    expect(ids).toEqual(["chk", "sav", "wallet"]);
  });
});
