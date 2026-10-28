// "Schedule this transaction…" — a register row handed to the Bills form.
//
// The register and the Bills screen are never on screen together, so the
// draft is parked here, File → New → Scheduled bill or deposit takes the user
// to Bills, and the form picks the draft up when it mounts (or at once, when
// Bills is already in front and serves the command itself).
import type { NewRecurrence } from "./types";

let pending: NewRecurrence | null = null;

/** Park a draft for the Bills form. */
export function requestSchedule(draft: NewRecurrence): void {
  pending = draft;
}

/** Take the parked draft, if any. Read once: a second visit to Bills starts
 *  from a blank form. */
export function takeScheduleDraft(): NewRecurrence | null {
  const d = pending;
  pending = null;
  return d;
}
