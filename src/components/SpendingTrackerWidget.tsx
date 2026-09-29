// SpendingTrackerWidget — modular dashboard card showing budget vs. actual
// spending per category for a month, with progress bars.
//
// The title bar pages month by month (◀ ▶, "Today" to come back), and
// each line is a button that opens the Transactions by Category report for
// that category and month — "pull up the transaction report it's coming
// from", as asked.
import Money from "./Money";
import TmIcon from "./TmIcon";
import Notice from "./Notice";
import { useBudgetStore } from "../stores/useBudgetStore";
import { currentMonth } from "../lib/format";
import { monthRange, shiftMonth } from "./BillCalendar";
import type { ReportOpen } from "./ReportsView";

interface Props {
  onOpenReport?: (o: ReportOpen) => void;
}

/** "2026-09" → "September 2026". */
export function monthTitle(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

export default function SpendingTrackerWidget({ onOpenReport }: Props) {
  const summary = useBudgetStore((s) => s.summary);
  const month = useBudgetStore((s) => s.month);
  const setMonth = useBudgetStore((s) => s.setMonth);
  // A failed load is not an empty month. The card said "No spending
  // recorded" over a database it could not read.
  const error = useBudgetStore((s) => s.error);
  const thisMonth = currentMonth();
  // The largest single category's spend this month — the scale an unbudgeted
  // category's bar is drawn against.
  const biggest = summary.reduce((m, r) => (r.spent_cents > m ? r.spent_cents : m), 0);

  return (
    <section className="aero-card">
      <div className="aero-card-title flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5">
          <TmIcon name="reports" size={14} />
          Spending Tracker
        </span>
        <span className="inline-flex items-center gap-1 text-[11px] font-normal">
          <button
            type="button"
            className="aero-btn !py-0 !px-1.5"
            aria-label="Previous month"
            title="Previous month"
            onClick={() => void setMonth(shiftMonth(month, -1))}
          >
            ◀
          </button>
          <span className="text-slate-600 min-w-[8.5em] text-center" aria-label="Spending month">
            {monthTitle(month)}
          </span>
          <button
            type="button"
            className="aero-btn !py-0 !px-1.5"
            aria-label="Next month"
            title="Next month"
            onClick={() => void setMonth(shiftMonth(month, 1))}
          >
            ▶
          </button>
          {month !== thisMonth && (
            <button type="button" className="aero-btn !py-0 !px-1.5 text-[10px]" onClick={() => void setMonth(thisMonth)}>
              Today
            </button>
          )}
        </span>
      </div>
      <div className="p-2 space-y-2 tm-home-scroll">
        {error ? (
          <Notice tone="error" boxed>
            The spending for {monthTitle(month)} could not be loaded: {error}
          </Notice>
        ) : summary.length === 0 ? (
          <div className="text-[12px] text-slate-500 p-3 text-center">No spending recorded for {monthTitle(month)}.</div>
        ) : (
          summary.map((row) => {
            // The bar used to be `spent / target`, and 0% whenever there
            // was no target — so every category the user had not budgeted drew
            // an empty trough. The summary deliberately includes those (its
            // WHERE is `has a budget OR spent something`), so on a file with
            // few budgets the whole card looked broken: totals, no color.
            //
            // A category with no budget still has something worth showing —
            // how much of the month's spending it accounts for. Drawn in a
            // neutral fill so it never reads as "78% of budget" when there is
            // no budget to be 78% of.
            const budgeted = row.target_cents > 0;
            const pct = budgeted
              ? Math.min(100, Math.round((row.spent_cents / row.target_cents) * 100))
              : biggest > 0
                ? Math.max(2, Math.round((row.spent_cents / biggest) * 100))
                : 0;
            const over = row.remaining_cents < 0;
            const { from, to } = monthRange(month);
            return (
              <button
                key={row.category_id}
                type="button"
                className="block w-full text-left tm-tracker-row"
                aria-label={`${row.category_name} transactions`}
                title={
                  budgeted
                    ? `${pct}% of the ${formatTarget(row.target_cents)} budget. Click for the transactions behind ${row.category_name} in ${monthTitle(month)}.`
                    : `No budget set — the bar is this category's share of the month's biggest. Click for the transactions behind ${row.category_name} in ${monthTitle(month)}.`
                }
                disabled={!onOpenReport}
                onClick={() => onOpenReport?.({ kind: "transactions_by_category", categoryIds: [row.category_id], from, to })}
              >
                <div className="flex items-center justify-between text-[12px]">
                  <span className="font-medium">{row.category_name}</span>
                  <span className="tabular-nums">
                    <Money cents={row.spent_cents} />
                    {row.target_cents > 0 && <span className="text-slate-500"> / {formatTarget(row.target_cents)}</span>}
                  </span>
                </div>
                <div
                  className="mt-1 h-2 rounded-full overflow-hidden"
                  style={{ background: "var(--tm-ms-grid-header)", border: "1px solid var(--tm-ms-card-border)" }}
                  role="progressbar"
                  aria-label={`${row.category_name} ${budgeted ? "against budget" : "share of the month"}`}
                  aria-valuenow={pct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div
                    className="h-full"
                    style={{
                      width: `${pct}%`,
                      background: !budgeted
                        ? "linear-gradient(180deg,var(--tm-bar-neutral-top),var(--tm-bar-neutral-bot))"
                        : over
                          ? "linear-gradient(180deg,var(--tm-bar-over-top),var(--tm-bar-over-bot))"
                          : "linear-gradient(180deg,var(--tm-bar-under-top),var(--tm-bar-under-bot))",
                    }}
                  />
                </div>
              </button>
            );
          })
        )}
      </div>
    </section>
  );
}

function formatTarget(cents: number): string {
  const abs = Math.abs(cents);
  return `$${Math.floor(abs / 100).toLocaleString("en-US")}.${(abs % 100).toString().padStart(2, "0")}`;
}
