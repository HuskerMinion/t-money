// How a scheduled occurrence reads and is colored — shared by the bills
// list and the bill calendar.
import type { Occurrence } from "./types";
import { groupFor } from "./accountTypes";

/** How an occurrence's state reads, and how it is colored. */
export function describeStatus(o: Occurrence): { label: string; tone: string } {
  switch (o.status) {
    case "paid":
      return { label: "Entered", tone: "tm-bill-done" };
    case "matched":
      // The important one: it is already in the register, so it is settled —
      // but say WHY, so an automatic decision is visible and can be undone.
      return { label: "Already in register", tone: "tm-bill-done" };
    case "skipped":
      return { label: "Skipped", tone: "tm-bill-skipped" };
    case "overdue":
      return { label: "Overdue", tone: "tm-bill-overdue" };
    default:
      return { label: "Due", tone: "" };
  }
}

/** Which account to forecast by default.
 *
 *  Bills come out of a current account, so a wallet or a credit card is the
 *  wrong first answer — the screen opened on "Demo Cash" and showed a flat
 *  line, which is true and useless. Prefer an open bank-ish account, and among
 *  those prefer whichever has the most scheduled activity. */
export function pickForecastAccount<
  T extends { id: string; name: string; type: string; is_closed?: boolean }
>(
  accounts: readonly T[],
  scheduled: readonly { account_id: string | null }[] = []
): T {
  const rank = (a: T) => {
    if (a.is_closed) return 0;
    if (a.type === "checking" || a.type === "bank") return 3;
    if (a.type === "savings") return 2;
    if (a.type === "cash" || a.type === "credit") return 1;
    return 1;
  };
  const count = (a: T) => scheduled.filter((s) => s.account_id === a.id).length;
  return [...accounts].sort(
    (x, y) => rank(y) - rank(x) || count(y) - count(x) || x.name.localeCompare(y.name)
  )[0];
}

/** Still going to happen, so still worth acting on. */
export function isOpen(o: Occurrence): boolean {
  return o.status === "due" || o.status === "overdue";
}
