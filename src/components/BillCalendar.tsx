// Money's bill calendar: the month as a grid, each day carrying the
// bills and deposits due on it, colored by status the same way the list
// is. Double-click a day to schedule something on that date; click an entry
// to open its rule. The occurrences are the same ones the list shows, so
// "Enter" in the list and a mark on the calendar never disagree.
//
// Each entry is in its account's currency. The month's in and out add
// accounts together, so they are in the home currency at today's rate.
import { useMemo } from "react";
import { formatMoney } from "../lib/format";
import { currencyOf, homeCurrency, homeName, MICRO, rateOf, toHome } from "../lib/currency";
import { useAccountStore } from "../stores/useAccountStore";
import type { Account, Occurrence } from "../lib/types";
import { describeStatus } from "../lib/bills";

interface Props {
  /** "YYYY-MM" */
  month: string;
  occurrences: readonly Occurrence[];
  today: string;
  onMonth: (month: string) => void;
  onDayDoubleClick: (date: string) => void;
  onPick: (o: Occurrence) => void;
  /** For each entry's currency; absent, the app's loaded accounts. */
  accounts?: readonly Account[];
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  const zero = y * 12 + (m - 1) + by;
  const yy = Math.floor(zero / 12);
  const mm = zero - yy * 12 + 1;
  return `${String(yy).padStart(4, "0")}-${String(mm).padStart(2, "0")}`;
}

/** First and last ISO dates of the month. */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

/** The grid: six rows of seven ISO dates (or null outside the month). */
export function monthGrid(month: string): (string | null)[][] {
  const [y, m] = month.split("-").map(Number);
  const first = new Date(y, m - 1, 1).getDay();
  const last = new Date(y, m, 0).getDate();
  const cells: (string | null)[] = [];
  for (let i = 0; i < first; i++) cells.push(null);
  for (let d = 1; d <= last; d++) cells.push(`${month}-${String(d).padStart(2, "0")}`);
  while (cells.length % 7 !== 0) cells.push(null);
  const rows: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
  return rows;
}

export default function BillCalendar({ month, occurrences, today, onMonth, onDayDoubleClick, onPick, accounts: given }: Props) {
  const rows = useMemo(() => monthGrid(month), [month]);
  const byDay = useMemo(() => {
    const map = new Map<string, Occurrence[]>();
    for (const o of occurrences) {
      const list = map.get(o.due_date) ?? [];
      list.push(o);
      map.set(o.due_date, list);
    }
    return map;
  }, [occurrences]);
  const [y, m] = month.split("-").map(Number);
  const title = new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const loaded = useAccountStore((s) => s.accounts);
  const accounts = given ?? loaded;
  const byId = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  // An occurrence with no account, or one not loaded, reads as the home currency.
  const kept = (o: Occurrence) => {
    const a = o.account_id ? byId.get(o.account_id) : undefined;
    return a ? { currency: currencyOf(a), rate: rateOf(a) } : { currency: homeCurrency(), rate: MICRO };
  };
  // A currency with no rate cannot be added in; it is named instead.
  const counted = occurrences.filter((o) => o.status !== "skipped");
  const unrated = [...new Set(counted.filter((o) => kept(o).rate === 0).map((o) => kept(o).currency))];
  const inHome = (o: Occurrence) => {
    const k = kept(o);
    return k.rate === 0 ? 0 : toHome(o.actual_amount_cents ?? o.amount_cents, k.rate);
  };
  const monthOut = counted.filter((o) => o.amount_cents < 0).reduce((s, o) => s + inHome(o), 0);
  const monthIn = counted.filter((o) => o.amount_cents > 0).reduce((s, o) => s + inHome(o), 0);
  const anyForeign = counted.some((o) => kept(o).currency !== homeCurrency());

  return (
    <div className="tm-calendar" aria-label={`Bill calendar for ${title}`}>
      <div className="flex items-center gap-2 pb-1">
        <button className="aero-btn !py-0 !px-2" type="button" aria-label="Previous month" onClick={() => onMonth(shiftMonth(month, -1))}>
          ◀
        </button>
        <span className="font-bold flex-1 text-center">{title}</span>
        <button className="aero-btn !py-0 !px-2" type="button" aria-label="Next month" onClick={() => onMonth(shiftMonth(month, 1))}>
          ▶
        </button>
        <button className="aero-btn !py-0 !px-2 text-[11px]" type="button" onClick={() => onMonth(today.slice(0, 7))}>
          Today
        </button>
      </div>
      <table className="tm-calendar-grid w-full" role="grid">
        <thead>
          <tr>
            {DOW.map((d) => (
              <th key={d}>{d}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((date, j) => {
                if (!date) return <td key={j} className="tm-cal-empty" />;
                const items = byDay.get(date) ?? [];
                const isToday = date === today;
                return (
                  <td
                    key={date}
                    className={`tm-cal-day${isToday ? " tm-cal-today" : ""}${date < today ? " tm-cal-past" : ""}`}
                    role="gridcell"
                    aria-label={date}
                    onDoubleClick={() => onDayDoubleClick(date)}
                    title="Double-click to schedule something on this day"
                  >
                    <div className="tm-cal-num">{Number(date.slice(8))}</div>
                    {items.map((o) => {
                      const s = describeStatus(o);
                      const cur = kept(o).currency;
                      return (
                        <button
                          key={`${o.recurrence_id}:${o.due_date}`}
                          type="button"
                          className={`tm-cal-item ${s.tone}${o.amount_cents > 0 ? " tm-cal-in" : ""}`}
                          title={`${o.payee} — ${formatMoney(o.actual_amount_cents ?? o.amount_cents, { currency: cur })} · ${s.label}${o.account_name ? ` · ${o.account_name}${o.transfer_account_name ? ` → ${o.transfer_account_name}` : ""}` : ""}`}
                          onClick={() => onPick(o)}
                        >
                          <span className="tm-cal-payee">{o.payee}</span>
                          <span className="tm-cal-amt">{formatMoney(Math.abs(o.actual_amount_cents ?? o.amount_cents), { currency: cur })}</span>
                        </button>
                      );
                    })}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex gap-4 pt-1 text-[11px] tm-text-muted">
        <span>Out this month: {formatMoney(-monthOut)}</span>
        <span>In: {formatMoney(monthIn)}</span>
        {anyForeign && <span>({homeName()}, at today's rates{unrated.length > 0 ? `; leaves out ${unrated.join(", ")} — no rate` : ""})</span>}
        <span className="flex-1" />
        <span>Double-click a day to schedule a bill on it; click a bill to open its rule.</span>
      </div>
    </div>
  );
}
