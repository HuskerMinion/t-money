// Money's "Date range:" dropdown, as pure functions of today.
//
// Every report carries the same list, and the selected range is what the
// subtitle prints ("1/1/2025 through 12/31/2025"). Ranges are inclusive,
// YYYY-MM-DD, computed in local time from `today`.

export interface DateRange {
  from: string;
  to: string;
}

export interface RangeOption {
  id: string;
  label: string;
}

/** In Money's order. `custom` is handled by the viewer (two date fields). */
export const RANGE_OPTIONS: RangeOption[] = [
  { id: "this_month", label: "This month" },
  { id: "last_month", label: "Last month" },
  { id: "this_quarter", label: "This quarter" },
  { id: "last_quarter", label: "Last quarter" },
  { id: "year_to_date", label: "Year to date" },
  { id: "previous_year", label: "Previous year" },
  { id: "last_12_months", label: "Last 12 months" },
  { id: "last_24_months", label: "Last 2 years" },
  { id: "last_30_days", label: "Last 30 days" },
  { id: "last_90_days", label: "Last 90 days" },
  { id: "all_dates", label: "All dates" },
  { id: "custom", label: "Custom dates…" },
];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function iso(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}
function daysInMonth(y: number, m: number): number {
  // Day 0 of the next month is the last day of this one.
  return new Date(y, m, 0).getDate();
}
function shiftDays(y: number, m: number, d: number, days: number): [number, number, number] {
  const t = new Date(y, m - 1, d);
  t.setDate(t.getDate() + days);
  return [t.getFullYear(), t.getMonth() + 1, t.getDate()];
}

/** Resolve a range id against `today` (YYYY-MM-DD). `custom` returns the
 *  fallback `current` unchanged so the viewer keeps whatever was typed. */
export function resolveRange(id: string, today: string, current?: DateRange): DateRange {
  const [y, m, d] = today.split("-").map(Number);
  switch (id) {
    case "this_month":
      return { from: iso(y, m, 1), to: iso(y, m, daysInMonth(y, m)) };
    case "last_month": {
      const [ly, lm] = m === 1 ? [y - 1, 12] : [y, m - 1];
      return { from: iso(ly, lm, 1), to: iso(ly, lm, daysInMonth(ly, lm)) };
    }
    case "this_quarter": {
      const q0 = Math.floor((m - 1) / 3) * 3 + 1;
      return { from: iso(y, q0, 1), to: iso(y, q0 + 2, daysInMonth(y, q0 + 2)) };
    }
    case "last_quarter": {
      let q0 = Math.floor((m - 1) / 3) * 3 + 1 - 3;
      let qy = y;
      if (q0 < 1) {
        q0 += 12;
        qy -= 1;
      }
      return { from: iso(qy, q0, 1), to: iso(qy, q0 + 2, daysInMonth(qy, q0 + 2)) };
    }
    case "year_to_date":
      return { from: iso(y, 1, 1), to: today };
    case "previous_year":
      return { from: iso(y - 1, 1, 1), to: iso(y - 1, 12, 31) };
    case "last_12_months": {
      // Twelve whole months ending with this one.
      const [sy, sm] = m === 12 ? [y, 1] : [y - 1, m + 1];
      return { from: iso(sy, sm, 1), to: iso(y, m, daysInMonth(y, m)) };
    }
    case "last_24_months": {
      // Twenty-four whole months ending with this one (long enough to see a yearly charge twice).
      const [sy, sm] = m === 12 ? [y - 1, 1] : [y - 2, m + 1];
      return { from: iso(sy, sm, 1), to: iso(y, m, daysInMonth(y, m)) };
    }
    case "last_30_days": {
      const [fy, fm, fd] = shiftDays(y, m, d, -29);
      return { from: iso(fy, fm, fd), to: today };
    }
    case "last_90_days": {
      const [fy, fm, fd] = shiftDays(y, m, d, -89);
      return { from: iso(fy, fm, fd), to: today };
    }
    case "all_dates":
      return { from: "1900-01-01", to: iso(y + 10, 12, 31) };
    default:
      return current ?? { from: iso(y, m, 1), to: iso(y, m, daysInMonth(y, m)) };
  }
}

/** A whole calendar month, for the Monthly reports list. */
export function monthRange(ym: string): DateRange {
  const [y, m] = ym.split("-").map(Number);
  return { from: iso(y, m, 1), to: iso(y, m, daysInMonth(y, m)) };
}

/** "September, 2026" — Money's monthly-report label. */
export function monthTitle(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const names = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${names[m - 1]}, ${y}`;
}

/** The last `n` months as YYYY-MM, newest first, starting with `today`'s. */
export function recentMonths(today: string, n: number): string[] {
  const [y0, m0] = today.split("-").map(Number);
  const out: string[] = [];
  let y = y0;
  let m = m0;
  for (let i = 0; i < n; i++) {
    out.push(`${y}-${pad(m)}`);
    if (m === 1) {
      m = 12;
      y -= 1;
    } else {
      m -= 1;
    }
  }
  return out;
}
