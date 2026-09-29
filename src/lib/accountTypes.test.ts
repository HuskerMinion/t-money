// The account taxonomy — the wizard's filtering and the Account List's
// grouping both read from this table, and it must stay in step with the CHECK
// constraint in migration 0009.
import { describe, expect, it } from "vitest";
import migrationsRs from "../../src-tauri/src/db/migrations.rs?raw";
import {
  ACCOUNT_CATEGORIES,
  ACCOUNT_GROUPS,
  ACCOUNT_TYPES,
  groupFor,
  isAmortizable,
  isDebt,
  labelFor,
  pickableAccounts,
  typesForCategory,
} from "./accountTypes";

describe("taxonomy", () => {
  it("has no duplicate values", () => {
    const values = ACCOUNT_TYPES.map((t) => t.value);
    expect(new Set(values).size).toBe(values.length);
  });

  it("assigns every type to one of the four Account List groups", () => {
    for (const t of ACCOUNT_TYPES) {
      expect(ACCOUNT_GROUPS).toContain(t.group);
    }
  });

  it("matches the CHECK constraint in migration 0009 exactly", () => {
    // This is the seam where the two halves drift: adding a type in TypeScript
    // without widening the CHECK produces a runtime insert failure.
    const check = /widen_account_types[\s\S]*?CHECK \(type IN \(([\s\S]*?)\)\)/.exec(migrationsRs);
    expect(check).not.toBeNull();
    const sqlTypes = [...check![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(ACCOUNT_TYPES.map((t) => t.value).sort()).toEqual(sqlTypes);
  });

  it("excludes Money's bill-payment category, which is out of scope", () => {
    expect(ACCOUNT_CATEGORIES.map((c) => c.value)).toEqual([
      "banking",
      "credit",
      "investment",
      "other",
    ]);
    expect(ACCOUNT_TYPES.some((t) => t.value.includes("bill"))).toBe(false);
  });
});

describe("wizard step 2 filtering", () => {
  it("Banking offers Bank, Checking and Savings", () => {
    expect(typesForCategory("banking").map((t) => t.label)).toEqual([
      "Bank",
      "Checking",
      "Savings",
    ]);
  });

  it("Credit card offers Credit Card and Line of Credit", () => {
    expect(typesForCategory("credit").map((t) => t.label)).toEqual([
      "Credit Card",
      "Line of Credit",
    ]);
  });

  it("Investment offers the four investment types", () => {
    expect(typesForCategory("investment").map((t) => t.label)).toEqual([
      "Employee Stock Option",
      "Investment",
      "Retirement",
      "Watch",
    ]);
  });

  it("Other offers every type", () => {
    expect(typesForCategory("other")).toHaveLength(ACCOUNT_TYPES.length);
  });

  it("every type carries a description for the wizard's pane", () => {
    for (const t of ACCOUNT_TYPES) {
      expect(t.description.length).toBeGreaterThan(10);
    }
  });
});

describe("grouping helpers", () => {
  it("groups the sampled real accounts the way Money's list does", () => {
    expect(groupFor("checking")).toBe("Bank Accounts");
    expect(groupFor("savings")).toBe("Bank Accounts");
    expect(groupFor("credit")).toBe("Credit Accounts");
    expect(groupFor("investment")).toBe("Investment Accounts");
    expect(groupFor("loan")).toBe("Other Accounts");
    expect(groupFor("mortgage")).toBe("Other Accounts");
  });

  it("includes Money's literal \"Other\" type, which sorts after Mortgage", () => {
    const otherOnly = typesForCategory("other").map((t) => t.label);
    expect(otherOnly).toContain("Other");
    expect(otherOnly.indexOf("Other")).toBeGreaterThan(otherOnly.indexOf("Mortgage"));
  });

  it("falls back to Other Accounts for an unknown type", () => {
    expect(groupFor("nonsense")).toBe("Other Accounts");
  });

  it("labelFor returns Money's display names", () => {
    expect(labelFor("credit")).toBe("Credit Card");
    expect(labelFor("vehicle")).toBe("Car or other Vehicle");
    expect(labelFor("home_equity_line_of_credit")).toBe("Home Equity Line of Credit");
  });
});

// Which accounts amortize. A credit card is a debt, but its balance is
// whatever was charged, not a schedule, so it gets no loan terms.
describe("isAmortizable", () => {
  it("covers the debts with a rate and a payment, and no others", () => {
    for (const k of ["loan", "mortgage", "home_equity_line_of_credit", "liability", "line_of_credit"]) {
      expect(isAmortizable(k)).toBe(true);
    }
    for (const k of ["credit", "checking", "savings", "cash", "home", "vehicle", "asset", "investment", "retirement"]) {
      expect(isAmortizable(k)).toBe(false);
    }
  });

  it("is a subset of the debts that can be secured on an asset", () => {
    for (const k of ["loan", "mortgage", "home_equity_line_of_credit", "liability", "line_of_credit"]) {
      expect(isDebt(k)).toBe(true);
    }
  });
});

// N9: a closed account is out of every picker, except where the thing
// being edited already names it.
describe("pickableAccounts", () => {
  const list = [
    { id: "a", is_closed: false },
    { id: "old", is_closed: true },
    { id: "b" },
  ];
  it("leaves closed accounts out", () => {
    expect(pickableAccounts(list).map((a) => a.id)).toEqual(["a", "b"]);
  });
  it("keeps a closed account the edited row already uses, in its place", () => {
    expect(pickableAccounts(list, [null, "old", undefined]).map((a) => a.id)).toEqual(["a", "old", "b"]);
  });
});
