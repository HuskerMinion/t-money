// Money's Autobudget: "Money takes up to a year of history plus your
// scheduled bills, proposes an amount per common category, and you accept
// per line." The backend proposes; this is the accept-per-line table. Each
// line can be unticked or its amount edited before Apply, and the accepted
// lines are written for the month and, optionally, the months after it
// (budgets are stored per month).
import { useEffect, useState } from "react";
import { api } from "../lib/ipc";
import { formatAmountBare, formatMoney, parseMoneyToCents } from "../lib/format";
import { homeCurrency } from "../lib/currency";
import { currentRegion } from "../lib/region";
import type { AutobudgetLine } from "../lib/types";

interface Props {
  /** "YYYY-MM" — the month the Budget view is showing. */
  month: string;
  /** Which proposal to accept per line.
   *
   *  `"history"` is the original proposal: every expense category that has been spent in,
   *  which on a real file is dozens of lines and is the right answer when you
   *  already budget and want the numbers refreshed.
   *
   *  `"starter"` is for somebody who has never budgeted: the TOP-LEVEL
   *  categories only, ranked by what they cost, capped at a dozen. Same table,
   *  same Apply — the only difference is which question was asked of the
   *  backend, so there is one accept-per-line screen to get right. */
  source?: "history" | "starter";
  onCancel: () => void;
  onApplied: (rows: number, months: number) => void;
}

interface Pick {
  on: boolean;
  amount: string;
}

/** The lines to send: ticked, parsed, non-negative. */
export function acceptedLines(lines: readonly AutobudgetLine[], picks: Readonly<Record<string, Pick>>): [string, number][] | null {
  const out: [string, number][] = [];
  for (const l of lines) {
    const p = picks[l.category_id];
    if (!p?.on) continue;
    const cents = parseMoneyToCents(p.amount);
    if (cents === null || cents < 0) return null;
    out.push([l.category_id, cents]);
  }
  return out;
}

/** One whole unit of the home currency, for "rounded up to the dollar". */
const UNIT_NAMES: Record<string, string> = { USD: "dollar", CAD: "dollar", AUD: "dollar", MXN: "peso", EUR: "euro", GBP: "pound" };

/** A suggestion as the amount box starts: "1234.00", "1234,00". */
export function amountInput(cents: number): string {
  return formatAmountBare(cents).split(currentRegion().group).join("");
}

export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

export default function AutobudgetDialog({ month, source = "history", onCancel, onApplied }: Props) {
  const starter = source === "starter";
  const [lookback, setLookback] = useState(12);
  const [months, setMonths] = useState(1);
  const [lines, setLines] = useState<AutobudgetLine[] | null>(null);
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let canceled = false;
    setLines(null);
    (starter ? api.getBudgetStarter(month, lookback, 12) : api.autobudget(month, lookback))
      .then((ls) => {
        if (canceled) return;
        setLines(ls);
        // Everything ticked at the proposal; a line that already has a
        // budget starts unticked so a considered figure is not overwritten
        // by accident.
        setPicks(Object.fromEntries(ls.map((l) => [l.category_id, { on: l.current_cents === null, amount: amountInput(l.suggested_cents) }])));
      })
      .catch((e) => {
        if (!canceled) setError(String(e));
      });
    return () => {
      canceled = true;
    };
  }, [month, lookback, starter]);

  const accepted = lines ? acceptedLines(lines, picks) : null;
  const total = accepted?.reduce((n, [, c]) => n + c, 0) ?? 0;

  async function apply() {
    if (!accepted || accepted.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const n = await api.applyAutobudget(month, months, accepted);
      onApplied(n, months);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <div
      className="tm-dialog"
      role="dialog"
      aria-label={starter ? "Start a budget" : "Autobudget"}
      style={{ width: 760 }}
    >
      <div className="tm-dialog-title">
        {starter ? "Start a budget" : "Autobudget"} — {monthLabel(month)}
      </div>
      <div className="tm-dialog-body space-y-2 text-[12px]">
        {starter ? (
          <p>
            A budget to start from, built out of what this file actually spends. These are the main
            categories — everything else you have sits underneath one of them, so budgeting these
            budgets everything without naming eighty things. Each amount is a typical month's
            spending (the middle month, not the average, so one bad month does not set the figure),
            or the scheduled bills if those come to more. Change anything that looks wrong, uncheck
            anything you would rather not budget, then Apply.
          </p>
        ) : (
          <p>
            A proposal per expense category from what was spent in the months before {monthLabel(month)} and from the scheduled bills: the average of the months that had spending, or the bills' monthly amount if that is more, rounded up to the {UNIT_NAMES[homeCurrency()] ?? "whole unit"}. Uncheck a line or change its amount, then Apply.
          </p>
        )}
        <div className="flex items-center gap-4">
          <label className="inline-flex items-center gap-1">
            Look back
            <select className="aero-field" aria-label="Months of history" value={lookback} onChange={(e) => setLookback(Number(e.target.value))}>
              {[3, 6, 12, 24].map((n) => (
                <option key={n} value={n}>
                  {n} months
                </option>
              ))}
            </select>
          </label>
          <label className="inline-flex items-center gap-1">
            Apply to
            <select className="aero-field" aria-label="Months to budget" value={months} onChange={(e) => setMonths(Number(e.target.value))}>
              <option value={1}>{monthLabel(month)} only</option>
              <option value={3}>3 months</option>
              <option value={6}>6 months</option>
              <option value={12}>12 months</option>
            </select>
          </label>
        </div>
        {error && <div className="money-neg">{error}</div>}
        {lines && lines.length === 0 && <p>No spending or scheduled bills to go on yet — nothing to propose.</p>}
        {lines && lines.length > 0 && (
          <div style={{ maxHeight: 380, overflowY: "auto" }}>
            <table className="tm-report-table w-full" aria-label="Autobudget proposals">
              <thead>
                <tr>
                  <th style={{ width: 24 }}>
                    <input
                      type="checkbox"
                      aria-label="Accept all"
                      checked={lines.every((l) => picks[l.category_id]?.on)}
                      onChange={(e) => setPicks(Object.fromEntries(lines.map((l) => [l.category_id, { ...picks[l.category_id], on: e.target.checked }])))}
                    />
                  </th>
                  <th>Category</th>
                  <th className="num">Average</th>
                  <th className="num">Months</th>
                  <th className="num">Scheduled</th>
                  <th className="num">Now</th>
                  <th className="num">Budget</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const p = picks[l.category_id] ?? { on: false, amount: "" };
                  const bad = p.on && (parseMoneyToCents(p.amount) === null || (parseMoneyToCents(p.amount) ?? 0) < 0);
                  return (
                    <tr key={l.category_id} className={p.on ? "" : "tm-text-muted"}>
                      <td>
                        <input type="checkbox" aria-label={`Accept ${l.category_name}`} checked={p.on} onChange={(e) => setPicks({ ...picks, [l.category_id]: { ...p, on: e.target.checked } })} />
                      </td>
                      <td>{l.category_name}</td>
                      <td className="num">{l.months_with_spending ? formatMoney(l.average_cents) : "—"}</td>
                      <td className="num">{l.months_with_spending || "—"}</td>
                      <td className="num">{l.scheduled_cents ? formatMoney(l.scheduled_cents) : "—"}</td>
                      <td className="num">{l.current_cents !== null ? formatMoney(l.current_cents) : "—"}</td>
                      <td className="num">
                        <input
                          className={`aero-field text-right${bad ? " money-neg" : ""}`}
                          style={{ width: 90 }}
                          aria-label={`Budget for ${l.category_name}`}
                          value={p.amount}
                          disabled={!p.on}
                          onChange={(e) => setPicks({ ...picks, [l.category_id]: { ...p, amount: e.target.value } })}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex items-center gap-2 pt-3">
          <span className="tm-text-muted flex-1">
            {accepted ? `${accepted.length} ${accepted.length === 1 ? "line" : "lines"}, ${formatMoney(total)} a month.` : lines ? "Check the amounts in red." : "Working it out…"}
          </span>
          <button className="aero-btn default" type="button" disabled={busy || !accepted || accepted.length === 0} onClick={() => void apply()}>
            Apply
          </button>
          <button className="aero-btn" type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
