// §115 — how old a price is, and when the timer should fire.
//
// The app fetches only when told to. "Automatically" here means the app asks
// once a day (or once a week) WHILE IT IS OPEN, and only after the setting is
// turned on: there is no background service, nothing runs when the app is
// closed, and the default is still off. Everything in this file is pure so
// the rule can be tested without a clock or a network.
import type { PriceInterval, PriceStatus } from "./types";

export const PRICE_INTERVALS: { value: PriceInterval; label: string; days: number }[] = [
  { value: "off", label: "Only when I ask", days: 0 },
  // §158 — "while T-Money is open" includes the moment it opens a file: a
  // file whose last fetch is older than the interval is refreshed then,
  // rather than at the first half-hour tick.
  { value: "daily", label: "Once a day, while T-Money is open", days: 1 },
  { value: "weekly", label: "Once a week, while T-Money is open", days: 7 },
];

/** The calendar day of an ISO date (yyyy-mm-dd, or a timestamp that starts
 *  with one) as a whole-day count, or null when it is not a real date.
 *  §180: `Date.parse` rolls 2026-02-30 over to March 2, and the old answer
 *  for nonsense was 0 days — which every caller reads as "fresh". Counted in
 *  UTC so a daylight-saving change cannot make a day 23 hours long. */
function dayNumber(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return t / 86_400_000;
}

/** Whole days between two ISO dates (yyyy-mm-dd or a full timestamp), or
 *  null when either is not a real date — unknown, which callers must treat as
 *  old, never as today. */
export function daysBetween(fromIso: string, toIso: string): number | null {
  const a = dayNumber(fromIso);
  const b = dayNumber(toIso);
  if (a === null || b === null) return null;
  return b - a;
}

/** Now on this machine's clock, in the shape the backend stamps `last_auto`
 *  with (chrono's Local, "2026-09-15T18:00:00"). §180: the timer used to pass
 *  `toISOString()`, which is UTC — from 7 p.m. in U.S. Central (6 p.m. in
 *  winter) that is already tomorrow, so a daily refresh looked a day old and
 *  ran again at every half-hour tick until local midnight, each run stamping
 *  a local "today" the next tick again read as yesterday. Both sides of the
 *  comparison must be on the same calendar. */
export function localNow(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Whether the automatic refresh is due. `now` is a LOCAL ISO date or
 *  timestamp (`localNow()`), matching how `last_auto` is stamped. */
export function refreshIsDue(status: PriceStatus, now: string): boolean {
  const interval = PRICE_INTERVALS.find((i) => i.value === status.interval);
  if (!interval || interval.days === 0) return false;
  // Nothing to fetch: a file with no symbols must not ask the network.
  if (status.with_symbol === 0) return false;
  // Never run: due now, so turning it on does something visible.
  if (!status.last_auto) return true;
  const days = daysBetween(status.last_auto, now);
  // §180: a stamp that will not parse is due, not fresh. The run re-stamps
  // it, so this asks once rather than every half hour.
  return days === null || days >= interval.days;
}

/** What to say beside a portfolio value. Null when there is nothing to say —
 *  no securities, or prices from today. */
export function stalenessNote(status: PriceStatus, today: string): string | null {
  if (status.with_symbol === 0) return null;
  if (status.never_priced > 0 && !status.oldest_date) {
    return `${status.never_priced} holding${status.never_priced === 1 ? "" : "s"} never priced`;
  }
  if (!status.oldest_date) return null;
  const days = daysBetween(status.oldest_date, today);
  const parts: string[] = [];
  // §180: a date that will not parse is not "today's" — say so, and isStale
  // points at it.
  if (days === null) parts.push("Price dates could not be read");
  else if (days <= 0) parts.push("Prices are today's");
  else if (days === 1) parts.push("Prices are a day old");
  else if (days < 14) parts.push(`Prices are ${days} days old`);
  else if (days < 60) parts.push(`Prices are ${Math.round(days / 7)} weeks old`);
  else parts.push(`Prices are ${Math.round(days / 30)} months old`);
  if (status.never_priced > 0) {
    parts.push(`${status.never_priced} never priced`);
  }
  return parts.join(" · ");
}

/** Old enough to be worth pointing at, rather than merely stating. */
export function isStale(status: PriceStatus, today: string): boolean {
  if (status.with_symbol === 0) return false;
  if (status.never_priced > 0) return true;
  if (!status.oldest_date) return false;
  const days = daysBetween(status.oldest_date, today);
  return days === null || days >= 7;
}
