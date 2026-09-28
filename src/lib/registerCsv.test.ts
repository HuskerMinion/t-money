// §85 — the register as CSV.
import { describe, expect, it } from "vitest";
import { csvCents, registerCsv } from "./registerCsv";
import type { RegisterRow } from "./types";

const row = (over: Partial<RegisterRow>): RegisterRow => ({
  id: "t", date: "2026-09-02", payee: "Netflix", category_name: "Streaming", category_id: "c", amount_cents: -1549, running_balance_cents: 98451,
  is_reconciled: false, cleared_state: "C", check_number: null, is_void: false, notes: "monthly", transfer_account_id: null, transfer_account_name: null,
  activity: null, security_id: null, security_name: null, shares_micro: null, price_micro: null, gross_cents: null, commission_cents: null,
  lot_specified: false, goal_id: null, goal_name: null, tax_line: null, funding_account_id: null,
  ...over,
} as RegisterRow);

describe("registerCsv", () => {
  it("formats cents as plain decimals", () => {
    expect(csvCents(-1549)).toBe("-15.49");
    expect(csvCents(5)).toBe("0.05");
    expect(csvCents(123456789)).toBe("1234567.89");
  });

  it("writes Money's columns, a transfer as Transfer : Account, quotes what needs it, and drops Balance when asked", () => {
    const rows = [
      row({}),
      row({ id: "t2", payee: 'Joe "Bob" Diner', amount_cents: 2500, transfer_account_name: "Savings", category_name: null, notes: null, cleared_state: "", check_number: "1051", running_balance_cents: 100951 }),
    ];
    const withBalance = registerCsv(rows, true).split("\r\n");
    expect(withBalance[0]).toBe('"Num","Date","Payee","Category","Memo","C","Payment","Deposit","Balance"');
    expect(withBalance[1]).toBe('"",2026-09-02,"Netflix","Streaming","monthly",C,15.49,,984.51');
    expect(withBalance[2]).toBe('"1051",2026-09-02,"Joe ""Bob"" Diner","Transfer : Savings","",,,25.00,1009.51');
    const without = registerCsv(rows, false).split("\r\n");
    expect(without[0]).not.toContain("Balance");
    expect(without[1].split(",")).toHaveLength(8);
  });

  it("defuses text that Excel would run as a formula, and leaves the amounts numbers (§180)", () => {
    const out = registerCsv(
      [
        row({ payee: '=HYPERLINK("http://x")', category_name: "+Groceries", notes: "-cash back", check_number: "@1", amount_cents: -1234, running_balance_cents: -500 }),
        row({ payee: "\tTab", notes: "\r=1", transfer_account_name: "=Evil", activity: "buy", security_name: "-VTSAX", amount_cents: -1234, gross_cents: -1234 }),
        row({ payee: "Coffee - Main St", notes: "a=b", amount_cents: 99 }),
      ],
      true,
    ).split("\r\n");
    // The header is ours and starts with a letter: untouched.
    expect(out[0].startsWith('"Num","Date","Payee","Category","Memo","C","Payment","Deposit","Balance"')).toBe(true);
    // Every text column is defused; a negative balance stays a bare number.
    expect(out[1].startsWith(`"'@1",2026-09-02,"'=HYPERLINK(""http://x"")","'+Groceries","'-cash back",C,12.34,,-5.00,`)).toBe(true);
    expect(out[2]).toContain(`"'\tTab","Transfer : =Evil","'\r=1"`);
    expect(out[2]).toContain(`,buy,"'-VTSAX",,,-12.34,`);
    // Only the first character matters: a dash or equals sign inside is ordinary text.
    expect(out[3]).toContain('"Coffee - Main St","Streaming","a=b"');
  });

  it("adds the investment columns when any row is an activity", () => {
    const out = registerCsv([row({ activity: "buy", security_name: "VTSAX", shares_micro: 12_345_600, price_micro: 34_567_800, gross_cents: 42_674, commission_cents: 0, amount_cents: -42_674 })], true);
    const [head, line] = out.split("\r\n");
    expect(head).toContain('"Activity","Security","Shares","Price","Total","Commission"');
    expect(line.endsWith(",buy,\"VTSAX\",12.3456,34.5678,426.74,")).toBe(true);
  });
});
