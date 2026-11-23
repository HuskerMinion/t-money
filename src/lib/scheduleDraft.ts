// "Schedule this transaction…" — a register row handed to the Bills form.
//
// The register and the Bills screen are never on screen together, so the
// draft is parked here, File → New → Scheduled bill or deposit takes the user
// to Bills, and the form picks the draft up when it mounts (or at once, when
// Bills is already in front and serves the command itself).
import type { NewRecurrence, Recurrence } from "./types";

/** A parked draft, and the date of the register row it came from. The form
 *  uses that date to move the start date when Repeats changes; it is not
 *  saved with the schedule. */
export type ScheduleDraft = NewRecurrence & { from_date?: string };

let pending: ScheduleDraft | null = null;

/** Park a draft for the Bills form. */
export function requestSchedule(draft: ScheduleDraft): void {
  pending = draft;
}

/** Take the parked draft, if any. Read once: a second visit to Bills starts
 *  from a blank form. */
export function takeScheduleDraft(): ScheduleDraft | null {
  const d = pending;
  pending = null;
  return d;
}

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (dt: Date) => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;

/** The first date `months` apart from `date`, on its day of the month, that is
 *  not before `notBefore`. Jan 31 → Feb 28, not Mar 3; a row from two years ago
 *  starts its schedule now, not with two years of overdue bills. */
function nextByMonths(date: string, months: number, notBefore: string): string {
  const [y, m, d] = date.split("-").map(Number);
  let out = date;
  // Bounded: a row from a century ago still stops.
  for (let k = 1; k <= 1200; k++) {
    const last = new Date(y, m - 1 + k * months + 1, 0).getDate();
    out = iso(new Date(y, m - 1 + k * months, Math.min(d, last)));
    if (out >= notBefore) break;
  }
  return out;
}

/** The first monthly date after `date` that is not before `notBefore`. */
export function nextMonthlyDate(date: string, notBefore: string): string {
  return nextByMonths(date, 1, notBefore);
}

/** Where a schedule made from a row dated `date` starts, for each Repeats
 *  choice: the next time it would come, on the row's day (and month, for a
 *  yearly one), not before `notBefore`. Once has no next time: null. */
export function nextScheduledDate(freq: Recurrence["freq"], date: string, notBefore: string): string | null {
  switch (freq) {
    case "monthly":
    case "semi_monthly":
      return nextByMonths(date, 1, notBefore);
    case "yearly":
      return nextByMonths(date, 12, notBefore);
    case "weekly": {
      const [y, m, d] = date.split("-").map(Number);
      let out = date;
      for (let k = 1; k <= 5300; k++) {
        out = iso(new Date(y, m - 1, d + 7 * k));
        if (out >= notBefore) break;
      }
      return out;
    }
    default:
      return null;
  }
}
