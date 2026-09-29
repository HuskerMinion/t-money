// Home's subscription reminder: what is being paid for on a schedule,
// so a service nobody uses any more gets noticed and canceled instead of
// billing quietly for months.
//
// It is the "Subscriptions and recurring charges" report, run for the last
// two years. Which accounts it watches is configured the way Money
// configures anything on Home: from the report itself — Customize the
// report to the accounts wanted and Add to favorites; a favorite of this
// kind is what the widget runs (the first one, by name). With no favorite
// it watches the spending accounts (checking, savings, cash, cards).
import { useEffect, useState } from "react";
import Money from "./Money";
import TmIcon from "./TmIcon";
import Notice from "./Notice";
import { api } from "../lib/ipc";
import { today } from "../lib/format";
import { resolveRange } from "../lib/reportRanges";
import type { Report, ReportLine, SavedReport } from "../lib/types";
import type { ReportOpen } from "./ReportsView";

/** Rows shown on Home before "more in the report"; the card is a reminder, not the report. */
const SHOW = 10;

/** The ignore list — payees the card should not remind about (the
 *  mortgage is a recurring charge, not news). Kept in the file's UI settings
 *  as a JSON array of payee names, so it follows the data file. */
export const IGNORED_KEY = "subscriptions.ignored";

export function parseIgnored(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

interface Props {
  onOpenReport: (o: ReportOpen) => void;
}

export interface SubscriptionRow {
  payee: string;
  billed: string;
  amount_cents: number;
  last: string;
  next: string;
  charges: string;
  per_year_cents: number;
}

/** The report's rows, split by section. */
export function splitRows(report: Report): { active: SubscriptionRow[]; stopped: SubscriptionRow[]; perMonth: number; perYear: number } {
  const active: SubscriptionRow[] = [];
  const stopped: SubscriptionRow[] = [];
  let perMonth = 0;
  let perYear = 0;
  let section: "active" | "stopped" = "active";
  const toRow = (r: ReportLine): SubscriptionRow => ({
    payee: r.label,
    billed: r.cells[0]?.text ?? "",
    amount_cents: r.cells[1]?.cents ?? 0,
    last: r.cells[2]?.text ?? "",
    next: r.cells[3]?.text ?? "",
    charges: r.cells[4]?.text ?? "",
    per_year_cents: r.cells[5]?.cents ?? 0,
  });
  for (const r of Array.isArray(report.rows) ? report.rows : []) {
    if (r.style === "header") {
      section = r.label === "Active" ? "active" : "stopped";
      continue;
    }
    if (r.style === "subtotal" && r.label === "Active per month") perMonth = r.cells[1]?.cents ?? 0;
    else if (r.style === "total" && r.label === "Active per year") perYear = r.cells[5]?.cents ?? 0;
    else if (r.key_kind === "payee") (section === "active" ? active : stopped).push(toRow(r));
  }
  return { active, stopped, perMonth, perYear };
}

export default function SubscriptionsWidget({ onOpenReport }: Props) {
  const [report, setReport] = useState<Report | null>(null);
  const [favorite, setFavorite] = useState<SavedReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showStopped, setShowStopped] = useState(false);
  const [ignored, setIgnored] = useState<string[]>([]);
  const [showIgnored, setShowIgnored] = useState(false);

  // A save that failed now puts the list back. The row vanished from
  // the card on the click and stayed gone, so the card said "ignored" about a
  // payee the file would remind about again the next time Home opened.
  const [saveError, setSaveError] = useState<string | null>(null);
  async function saveIgnored(next: string[]) {
    const previous = ignored;
    setIgnored(next);
    setSaveError(null);
    try {
      await api.setUiSetting(IGNORED_KEY, JSON.stringify(next));
    } catch (e) {
      setIgnored(previous);
      setSaveError(`The ignore list could not be saved: ${String(e)}`);
    }
  }
  const ignore = (payee: string) => void saveIgnored(ignored.includes(payee) ? ignored : [...ignored, payee]);
  const watchAgain = (payee: string) => void saveIgnored(ignored.filter((p) => p !== payee));

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const raw = await api.getUiSetting(IGNORED_KEY).catch(() => null);
        if (live) setIgnored(parseIgnored(raw));
        const favs = await api.listSavedReports();
        const fav = favs.filter((f) => f.kind === "subscriptions").sort((a, b) => a.name.localeCompare(b.name))[0] ?? null;
        const range = resolveRange("last_24_months", today());
        const rep = await api.runReport({
          kind: "subscriptions",
          from: range.from,
          to: range.to,
          account_ids: fav && fav.account_ids.length ? fav.account_ids : null,
        });
        if (!live) return;
        setFavorite(fav);
        setReport(rep);
      } catch (e) {
        if (live) setError(String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const all = report ? splitRows(report) : null;
  // The card's totals are for what it shows: an ignored charge is not a
  // reminder and does not belong in the "/mo".
  const parts = all
    ? (() => {
        const active = all.active.filter((r) => !ignored.includes(r.payee));
        const stopped = all.stopped.filter((r) => !ignored.includes(r.payee));
        const perYear = active.reduce((n, r) => n + r.per_year_cents, 0);
        return { active, stopped, perMonth: Math.trunc(perYear / 12), perYear };
      })()
    : null;
  const ignoredRows = all ? [...all.active, ...all.stopped].filter((r) => ignored.includes(r.payee)) : [];
  const ignoreButton = (payee: string) => (
    <button
      type="button"
      className="tm-subs-ignore"
      aria-label={`Ignore ${payee}`}
      title={`Stop reminding about ${payee} — it stays in the report`}
      onClick={() => ignore(payee)}
    >
      ×
    </button>
  );
  const open = () => onOpenReport({ kind: "subscriptions", accountIds: favorite?.account_ids.length ? favorite.account_ids : undefined });

  return (
    <section className="aero-card" aria-label="Subscriptions">
      <div className="aero-card-title flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5">
          <TmIcon name="bills" size={14} />
          Subscriptions
        </span>
        <button type="button" className="aero-btn !py-0 !px-2 text-[11px] font-normal" onClick={open}>
          Open report
        </button>
      </div>
      <div className="p-2 text-[12px]">
        {error && (
          <Notice tone="error" boxed>
            {error}
          </Notice>
        )}
        {saveError && (
          <Notice tone="error" boxed onDismiss={() => setSaveError(null)}>
            {saveError}
          </Notice>
        )}
        {!report && !error && <div className="text-slate-500 p-3 text-center">Looking for charges that repeat…</div>}
        {parts && (
          <>
            {parts.active.length === 0 ? (
              <div className="text-slate-500 p-3 text-center">Nothing that repeats on a schedule in the watched accounts.</div>
            ) : (
              <table className="w-full tm-subs" aria-label="Active subscriptions">
                <thead>
                  <tr className="text-slate-500 text-[11px]">
                    <th className="text-left font-normal">Service</th>
                    <th className="text-left font-normal">Billed</th>
                    <th className="text-right font-normal">Amount</th>
                    <th className="text-right font-normal">Next</th>
                    <th className="text-right font-normal">Per year</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {parts.active.slice(0, SHOW).map((r) => (
                    <tr key={r.payee}>
                      <td className="font-medium">{r.payee}</td>
                      <td className="text-slate-600">{r.billed.replace(/^Every /, "")}</td>
                      <td className="text-right tabular-nums">
                        <Money cents={r.amount_cents} />
                      </td>
                      <td className="text-right tabular-nums text-slate-600">{r.next}</td>
                      <td className="text-right tabular-nums">
                        <Money cents={r.per_year_cents} />
                      </td>
                      <td className="text-right">{ignoreButton(r.payee)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="font-bold border-t">
                    <td colSpan={2}>
                      {parts.active.length} active
                      {parts.active.length > SHOW && <span className="font-normal text-slate-500"> · {parts.active.length - SHOW} more in the report</span>}
                    </td>
                    <td className="text-right tabular-nums" aria-label="Per month">
                      <Money cents={parts.perMonth} />
                      <span className="font-normal text-slate-500"> /mo</span>
                    </td>
                    <td />
                    <td className="text-right tabular-nums" aria-label="Per year total">
                      <Money cents={parts.perYear} />
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            )}
            {parts.stopped.length > 0 && (
              <div className="pt-2">
                <button type="button" className="tm-subs-link" aria-expanded={showStopped} onClick={() => setShowStopped((s) => !s)}>
                  {showStopped ? "▾" : "▸"} {parts.stopped.length} that may have stopped
                </button>
                {showStopped && (
                  <ul className="pl-4 text-slate-600" aria-label="Stopped subscriptions">
                    {parts.stopped.map((r) => (
                      <li key={r.payee}>
                        {r.payee} — <Money cents={r.amount_cents} /> {r.billed.toLowerCase()}, last {r.last} {ignoreButton(r.payee)}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {ignored.length > 0 && (
              <div className="pt-2">
                <button type="button" className="tm-subs-link" aria-expanded={showIgnored} onClick={() => setShowIgnored((s) => !s)}>
                  {showIgnored ? "▾" : "▸"} {ignored.length} ignored
                </button>
                {showIgnored && (
                  <ul className="pl-4 text-slate-600" aria-label="Ignored subscriptions">
                    {ignored.map((payee) => {
                      const r = ignoredRows.find((x) => x.payee === payee);
                      return (
                        <li key={payee}>
                          {payee}
                          {r && (
                            <>
                              {" "}— <Money cents={r.amount_cents} /> {r.billed.toLowerCase()}
                            </>
                          )}{" "}
                          <button type="button" className="tm-subs-link" aria-label={`Watch ${payee} again`} onClick={() => watchAgain(payee)}>
                            watch again
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
            <div className="pt-2 text-[11px] text-slate-500">
              {favorite ? (
                <>
                  Watching the accounts in your favorite report <strong>{favorite.name}</strong>.
                </>
              ) : (
                <>Watching checking, savings, cash and card accounts. To choose accounts: open the report, Customize the accounts, and Add to favorites.</>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
