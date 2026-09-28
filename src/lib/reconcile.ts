// Reconcile arithmetic, kept out of the component so it can be tested directly.
// (§6.1f)
import type { RegisterRow } from "./types";

/**
 * How far the register is from the statement.
 *
 *   difference = ending − (starting + everything cleared this session)
 *
 * Rows already marked "R" belong to earlier statements and are baked into the
 * starting balance, so only "C" rows count here — counting them again is the
 * classic double-count bug in a reconcile screen.
 *
 * Zero means balanced.
 */
export function reconcileDifferenceCents(
  rows: readonly RegisterRow[],
  startingBalanceCents: number,
  endingBalanceCents: number
): number {
  const cleared = rows
    // A voided row is on no statement and contributes nothing to any balance
    // (§6.1h) — belt and braces, since voiding also clears the mark.
    .filter((r) => r.cleared_state === "C" && !r.is_void)
    .reduce((sum, r) => sum + r.amount_cents, 0);
  return endingBalanceCents - (startingBalanceCents + cleared);
}

/** Rows that are still available to clear against this statement. */
export function unclearedRows(rows: readonly RegisterRow[]): RegisterRow[] {
  return rows.filter((r) => r.cleared_state === "" && !r.is_void);
}

/**
 * The amount an adjustment transaction must carry to make the account balance.
 *
 * Do not reason about this from a screenshot — derive it. Adding a cleared
 * transaction of amount X changes the cleared sum by X, so
 *
 *   difference' = ending − (starting + Σcleared + X) = difference − X
 *
 * which is zero exactly when X = difference. The sign therefore falls out of
 * the definition; there is nothing to guess. `reconcileDifferenceCents` applied
 * to a register including this adjustment must return 0, and a test asserts it.
 */
export function adjustmentForDifference(differenceCents: number): number {
  return differenceCents;
}

export type AutoReconcileHit =
  | { kind: "clear" | "unclear"; row: RegisterRow; explanation: string }
  /** No row: amounts alone cannot say WHICH cleared row is wrong, and the
   *  register used to select the first one as if they could. */
  | { kind: "amount"; row: null; explanation: string };

/**
 * AutoReconcile (§6.1f [D]). Money names the three things that go wrong, so
 * look for exactly those, cheapest first:
 *
 *   1. a statement transaction never cleared here — clearing one row whose
 *      amount equals the difference would balance it;
 *   2. a transaction cleared here that is not on the statement — unclearing one
 *      whose amount equals the negated difference would balance it;
 *   3. a cleared transaction with the wrong amount. Any cleared row could be
 *      the one that is off by the difference, so this names no row — it only
 *      says to check them against the statement.
 *
 * Returns nothing when nothing is cleared and no single row explains the gap.
 * Voided rows are on no statement (§6.1h) and are never suggested.
 */
export function autoReconcile(
  rows: readonly RegisterRow[],
  differenceCents: number
): AutoReconcileHit | null {
  if (differenceCents === 0) return null;

  const toClear = rows.find(
    (r) => r.cleared_state === "" && !r.is_void && r.amount_cents === differenceCents
  );
  if (toClear) {
    return {
      kind: "clear",
      row: toClear,
      explanation: `"${toClear.payee}" is on your statement but was never cleared here. Clearing it balances the account.`,
    };
  }

  const toUnclear = rows.find(
    (r) => r.cleared_state === "C" && !r.is_void && r.amount_cents === -differenceCents
  );
  if (toUnclear) {
    return {
      kind: "unclear",
      row: toUnclear,
      explanation: `"${toUnclear.payee}" is cleared here but may not be on your statement. Unclearing it balances the account.`,
    };
  }

  if (rows.some((r) => r.cleared_state === "C" && !r.is_void)) {
    return {
      kind: "amount",
      row: null,
      explanation: `No single uncleared transaction accounts for the difference. A cleared transaction may have the wrong amount — check each against your statement.`,
    };
  }

  return null;
}
