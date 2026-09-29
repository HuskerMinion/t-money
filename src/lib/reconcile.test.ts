// Reconcile arithmetic. The double-count bug this guards against —
// counting already-reconciled rows a second time — is invisible until a real
// statement fails to balance.
import { describe, expect, it } from "vitest";
import {
  adjustmentForDifference,
  autoReconcile,
  reconcileDifferenceCents,
  unclearedRows,
} from "./reconcile";
import type { ClearedState, RegisterRow } from "./types";

const row = (
  id: string,
  amount_cents: number,
  cleared_state: ClearedState,
  payee = "Payee"
): RegisterRow => ({
  id,
  date: "2026-08-30",
  payee,
  category_name: null,
  category_id: null,
  transfer_account_id: null,
  amount_cents,
  running_balance_cents: 0,
  is_reconciled: cleared_state === "R",
  cleared_state,
  check_number: null,
  is_void: false,
  notes: null,
  transfer_account_name: null,
  activity: null,
  security_id: null,
  security_name: null,
  shares_micro: null,
  price_micro: null,
  gross_cents: null,
  commission_cents: 0,
  lot_specified: false,
  goal_id: null,
  goal_name: null,
});

describe("reconcileDifferenceCents", () => {
  it("is zero when the cleared rows account for the whole statement", () => {
    const rows = [row("a", -5000, "C"), row("b", 2000, "C")];
    // 100000 + (-5000 + 2000) = 97000
    expect(reconcileDifferenceCents(rows, 100000, 97000)).toBe(0);
  });

  it("ignores rows already reconciled on an earlier statement", () => {
    // "R" rows are baked into the starting balance; counting them again is the
    // double-count this test exists to prevent.
    const rows = [row("old", -999999, "R"), row("a", -5000, "C")];
    expect(reconcileDifferenceCents(rows, 100000, 95000)).toBe(0);
  });

  it("ignores uncleared rows", () => {
    const rows = [row("a", -5000, "C"), row("pending", -12345, "")];
    expect(reconcileDifferenceCents(rows, 100000, 95000)).toBe(0);
  });

  it("reports what is still missing", () => {
    const rows = [row("a", -5000, "C")];
    // Statement says 90000; register accounts for 95000 → 5000 unexplained.
    expect(reconcileDifferenceCents(rows, 100000, 90000)).toBe(-5000);
  });

  it("handles an empty register", () => {
    expect(reconcileDifferenceCents([], 100000, 100000)).toBe(0);
    expect(reconcileDifferenceCents([], 0, 4835_63)).toBe(483563);
  });
});

describe("adjustmentForDifference", () => {
  // The property that matters is not "what sign does Money show" but "does the
  // account balance afterwards". These assert the invariant directly, so the
  // sign is proven rather than guessed.
  const cases = [
    { starting: 100000, ending: 90000, cleared: [-5000] },
    { starting: 100000, ending: 120000, cleared: [-5000, 2500] },
    { starting: 0, ending: 483563, cleared: [] },
    { starting: 346644, ending: 346644, cleared: [-1234, 1234] },
    { starting: -50000, ending: -25000, cleared: [-7500] },
  ];

  it.each(cases)(
    "applying the adjustment zeroes the difference (starting $starting → ending $ending)",
    ({ starting, ending, cleared }) => {
      const rows = cleared.map((amount, i) => row(`c${i}`, amount, "C"));
      const difference = reconcileDifferenceCents(rows, starting, ending);
      const adjustment = adjustmentForDifference(difference);

      // The adjustment is written as a transaction and cleared onto this
      // statement, exactly as finish_statement does.
      const withAdjustment = [...rows, row("adj", adjustment, "C")];
      expect(reconcileDifferenceCents(withAdjustment, starting, ending)).toBe(0);
    }
  );

  it("is zero when the account already balances", () => {
    expect(adjustmentForDifference(0)).toBe(0);
  });
});

describe("voided rows", () => {
  it("never count toward the difference, even if somehow still marked", () => {
    const rows = [
      row("a", -5000, "C"),
      { ...row("fraud", -99999, "C"), is_void: true },
    ];
    expect(reconcileDifferenceCents(rows, 100000, 95000)).toBe(0);
  });

  it("are never suggested by AutoReconcile", () => {
    const rows = [{ ...row("fraud", -2500, ""), is_void: true }];
    expect(autoReconcile(rows, -2500)).toBeNull();
  });

  it("are never suggested for unclearing, even if somehow still marked", () => {
    const rows = [{ ...row("fraud", -2500, "C"), is_void: true }];
    expect(autoReconcile(rows, 2500)).toBeNull();
  });

  it("are not offered to clear", () => {
    const rows = [row("a", 1, ""), { ...row("fraud", 2, ""), is_void: true }];
    expect(unclearedRows(rows).map((r) => r.id)).toEqual(["a"]);
  });
});

describe("unclearedRows", () => {
  it("returns only the blank-state rows", () => {
    const rows = [row("a", 1, ""), row("b", 2, "C"), row("c", 3, "R")];
    expect(unclearedRows(rows).map((r) => r.id)).toEqual(["a"]);
  });
});

describe("autoReconcile", () => {
  it("finds an uncleared transaction that exactly explains the gap", () => {
    const rows = [row("a", -5000, "C"), row("missing", -2500, "", "City Power & Light")];
    const hit = autoReconcile(rows, -2500);
    expect(hit?.kind).toBe("clear");
    expect(hit?.row?.id).toBe("missing");
    expect(hit?.explanation).toContain("City Power & Light");
  });

  it("finds a cleared transaction that should not be cleared", () => {
    const rows = [row("wrong", -2500, "C", "Safeway")];
    const hit = autoReconcile(rows, 2500);
    expect(hit?.kind).toBe("unclear");
    expect(hit?.row?.id).toBe("wrong");
  });

  it("returns nothing when the account already balances", () => {
    expect(autoReconcile([row("a", -5000, "C")], 0)).toBeNull();
  });

  it("returns nothing when no single row explains the difference", () => {
    // Nothing cleared and nothing matching — the honest answer is "no idea".
    expect(autoReconcile([row("a", -100, "")], -12345)).toBeNull();
  });

  it("falls back to the wrong-amount hint when rows are cleared but none match", () => {
    const rows = [row("a", -5000, "C"), row("b", -700, "C")];
    const hit = autoReconcile(rows, -33);
    expect(hit?.kind).toBe("amount");
    expect(hit?.explanation).toContain("wrong amount");
    // Nothing says it is "a" rather than "b", so no row is named — the
    // register used to select the first cleared row as if it were the culprit.
    expect(hit?.row).toBeNull();
  });
});
