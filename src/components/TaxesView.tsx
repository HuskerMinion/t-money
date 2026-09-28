// Taxes (§43) — Money's tax tools, cut down to what the file can honestly
// say: a year's totals by tax line (Money's "Tax-related transactions"),
// the Tax Line Manager (categories with money this year and NO line, so
// the gaps are visible and can be fixed here), Schedule D from the lots
// (§41) and Schedule B from investment income. Everything is a summary of
// what was recorded. No estimator, no advice.
//
// The numbers come from the same report engine the Reports tab uses
// (`run_report`), so what this page prints and what the report prints can
// never disagree.
import { useEffect, useRef, useState } from "react";
import TaxLinePicker from "./TaxLinePicker";
import Notice from "./Notice";
import TmIcon from "./TmIcon";
import { formatCell } from "./ReportViewer";
import { api } from "../lib/ipc";
import { formatDateUS, today } from "../lib/format";
import { formOf, taxYears } from "../lib/taxLines";
import { labelFor } from "../lib/accountTypes";
import { useAccountStore } from "../stores/useAccountStore";
import type { Report, ReportLine } from "../lib/types";

import type { ReportOpen } from "./ReportsView";

interface Props {
  onOpenReport: (open: ReportOpen) => void;
}

interface LineGroup {
  /** null = the "no tax line" group. */
  line: string | null;
  categories: { id: string; name: string; cents: number; count: string }[];
  total: number;
}

/** Fold the Tax summary report's rows (header / keyed / subtotal) back into
 *  groups. The report is the source of truth; this is only a reshaping. */
export function groupTaxSummary(report: Report): LineGroup[] {
  const groups: LineGroup[] = [];
  let cur: LineGroup | null = null;
  for (const r of report.rows) {
    if (r.style === "header") {
      cur = { line: r.label.startsWith("Categories with") ? null : r.label, categories: [], total: 0 };
      groups.push(cur);
    } else if (r.style === "subtotal") {
      if (cur) cur.total = r.cells[0]?.cents ?? 0;
    } else if (cur && r.key_kind === "category" && r.key) {
      cur.categories.push({ id: r.key, name: r.label, cents: r.cells[0]?.cents ?? 0, count: r.cells[1]?.text ?? "" });
    }
  }
  return groups;
}

function subtotal(report: Report | null, label: string): ReportLine | undefined {
  return report?.rows.find((r) => r.label === label);
}

export default function TaxesView({ onOpenReport }: Props) {
  const [year, setYear] = useState(() => Number(today().slice(0, 4)));
  const [summary, setSummary] = useState<Report | null>(null);
  const [gains, setGains] = useState<Report | null>(null);
  const [income, setIncome] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  // §183 — a refusal is said beside the control that caused it. Both of these
  // wrote to `error`, which is drawn in the top card — above the fold from
  // the Tax Line Manager, and a screen away from the accounts list.
  const [lineError, setLineError] = useState<string | null>(null);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const accounts = useAccountStore((s) => s.accounts);
  const loadAccounts = useAccountStore((s) => s.loadAccounts);
  const categories = useAccountStore((s) => s.categories);
  const loadCategories = useAccountStore((s) => s.loadCategories);
  const editCategory = useAccountStore((s) => s.editCategory);

  const from = `${year}-01-01`;
  const to = `${year}-12-31`;

  // §183 — which load still counts. Changing the year while the last one is
  // still running must not let the old year's answer land under the new
  // year's heading.
  const latest = useRef(0);
  async function load(freshYear = false) {
    const mine = ++latest.current;
    setError(null);
    // A new year starts from nothing: a failed load used to leave last year's
    // figures on screen under this year's title.
    if (freshYear) {
      setSummary(null);
      setGains(null);
      setIncome(null);
    }
    const req = (kind: string) => ({ kind, from, to, account_ids: null, category_ids: null, compare_from: null, compare_to: null, detail: null, tax_scope: true });
    try {
      const [s, g, i] = await Promise.all([
        api.runReport(req("tax_summary")),
        api.runReport(req("capital_gains")),
        api.runReport(req("investment_income")),
      ]);
      if (mine !== latest.current) return;
      setSummary(s);
      setGains(g);
      setIncome(i);
    } catch (e) {
      if (mine !== latest.current) return;
      setError(String(e));
    }
  }

  useEffect(() => {
    void load(true);
    void loadCategories();
    void loadAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year]);

  async function assign(categoryId: string, line: string) {
    const c = categories.find((x) => x.id === categoryId);
    if (!c) return;
    setLineError(null);
    try {
      await editCategory(c.id, c.name, c.kind, c.parent_id, line || null);
    } catch (e) {
      setLineError(`The tax line for ${c.name} was not saved: ${String(e)}`);
      return;
    }
    await load();
  }

  const groups = summary ? groupTaxSummary(summary) : [];
  const lined = groups.filter((g) => g.line !== null);
  const unassigned = groups.find((g) => g.line === null);
  const forms: string[] = [];
  for (const g of lined) {
    const f = formOf(g.line!);
    if (!forms.includes(f)) forms.push(f);
  }
  const open = (kind: string, categoryIds?: string[]) => onOpenReport({ kind, categoryIds, from, to, taxScope: true });

  // Money's "Choose accounts to include in tax information" (§48): the
  // Taxes tab and its reports count only these. Retirement accounts start
  // out excluded; their dividends and sales are not taxable events.
  async function setIncluded(accountId: string, included: boolean) {
    setAccountsError(null);
    try {
      await api.setAccountTaxIncluded(accountId, included);
    } catch (e) {
      setAccountsError(String(e));
      return;
    }
    await loadAccounts();
    await load();
  }
  const openAccounts = accounts.filter((a) => !a.is_closed);
  const excluded = openAccounts.filter((a) => !a.tax_included);
  const money = (c: number | null | undefined) => formatCell("money", c ?? 0, null);

  const st = subtotal(gains, "Total short-term");
  const lt = subtotal(gains, "Total long-term");
  const net = subtotal(gains, "Net gain/loss");
  const incomeTotal = income?.rows.find((r) => r.style === "total");

  return (
    <div className="grid grid-cols-1 gap-4">
      <section className="aero-card">
        <div className="aero-card-title flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-2">
            <TmIcon name="reports" size={15} /> Taxes
          </span>
          <span className="inline-flex items-center gap-3 font-normal">
          <button className="aero-btn !py-0 !px-2 text-[11px]" type="button" onClick={() => window.print()} title="Print this tab: the totals by form, the tax line manager, Schedules D and B">
            Print…
          </button>
          <label className="inline-flex items-center gap-2 font-normal">
            Tax year
            <select className="aero-field" aria-label="Tax year" value={year} onChange={(e) => setYear(Number(e.target.value))}>
              {taxYears(today()).map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
          </span>
        </div>
        <div className="tm-print-only" data-print={`Taxes ${year} — a summary of what is recorded in this file, by tax line. Printed ${formatDateUS(today())}. Not tax advice; not a return.`} />
        <div className="p-2 text-[12px] tm-text-muted">
          A summary of what is recorded in this file for {year}, by the tax line each category is assigned to. It is not
          tax advice and not a return — check it against your forms.
        </div>
        {error && (
          <Notice tone="error" boxed className="mx-2 mb-2">
            The figures for {year} could not be loaded: {error}
          </Notice>
        )}
      </section>

      <section className="aero-card">
        <div className="aero-card-title flex items-center justify-between">
          <span>Tax-related totals, {year}</span>
          <button className="aero-btn !py-0 !px-2 text-[11px]" type="button" onClick={() => open("tax_related_transactions")}>
            Every transaction, by line
          </button>
        </div>
        <div className="p-2">
          {summary && lined.length === 0 && (
            <div className="text-[12px] tm-text-muted p-2">Nothing in {year} is filed under a category with a tax line.</div>
          )}
          {forms.length > 0 && (
            <table className="tm-report-table w-full" aria-label="Tax-related totals">
              <thead>
                <tr>
                  <th>Line</th>
                  <th className="num">Amount</th>
                  <th className="num">Lines</th>
                </tr>
              </thead>
              <tbody>
                {forms.map((form) => (
                  <FormRows key={form} form={form} groups={lined.filter((g) => formOf(g.line!) === form)} onOpen={open} money={money} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="aero-card">
        <div className="aero-card-title flex items-center justify-between">
          <span>Tax Line Manager</span>
          <button className="aero-btn !py-0 !px-2 text-[11px]" type="button" onClick={() => setShowAll(!showAll)}>
            {showAll ? "Hide assignments" : "All assignments…"}
          </button>
        </div>
        <div className="p-2">
          <div className="text-[12px] pb-1">
            Categories with money in {year} and <b>no tax line</b>. Pick a line to move them into the totals above — or
            leave them, if they are not tax-related.
          </div>
          {lineError && (
            <Notice tone="error" boxed className="mb-2">
              {lineError}
            </Notice>
          )}
          {unassigned && unassigned.categories.length > 0 ? (
            <table className="tm-report-table w-full" aria-label="Categories without a tax line">
              <thead>
                <tr>
                  <th>Category</th>
                  <th className="num">Amount</th>
                  <th>Tax line</th>
                </tr>
              </thead>
              <tbody>
                {unassigned.categories.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <button type="button" className="tm-link" onClick={() => open("transactions_by_category", [c.id])}>
                        {c.name}
                      </button>
                    </td>
                    <td className={`num${c.cents < 0 ? " money-neg" : ""}`}>{money(c.cents)}</td>
                    <td>
                      <TaxLinePicker value="" onChange={(line) => void assign(c.id, line)} label={`Tax line for ${c.name}`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            summary && <div className="text-[12px] tm-text-muted p-2">Every category with money in {year} has a tax line, or none needs one.</div>
          )}
          {showAll && (
            <table className="tm-report-table w-full mt-3" aria-label="All tax line assignments">
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Tax line</th>
                </tr>
              </thead>
              <tbody>
                {categories
                  .filter((c) => c.tax_line)
                  .map((c) => (
                    <tr key={c.id}>
                      <td>{c.full_name}</td>
                      <td>
                        <TaxLinePicker value={c.tax_line ?? ""} onChange={(line) => void assign(c.id, line)} label={`Tax line for ${c.full_name}`} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section className="aero-card">
          <div className="aero-card-title flex items-center justify-between">
            <span>Schedule D — capital gains, {year}</span>
            <button className="aero-btn !py-0 !px-2 text-[11px]" type="button" onClick={() => open("capital_gains")}>
              Full report
            </button>
          </div>
          <div className="p-2">
            <table className="tm-report-table w-full" aria-label="Capital gains summary">
              <thead>
                <tr>
                  <th />
                  <th className="num">Proceeds</th>
                  <th className="num">Cost basis</th>
                  <th className="num">Gain/loss</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["Short-term", st],
                  ["Long-term", lt],
                ].map(([label, r]) => (
                  <tr key={label as string}>
                    <td>{label as string}</td>
                    <td className="num">{r ? money((r as ReportLine).cells[4]?.cents) : "—"}</td>
                    <td className="num">{r ? money((r as ReportLine).cells[5]?.cents) : "—"}</td>
                    <td className={`num${r && ((r as ReportLine).cells[6]?.cents ?? 0) < 0 ? " money-neg" : ""}`}>
                      {r ? money((r as ReportLine).cells[6]?.cents) : "—"}
                    </td>
                  </tr>
                ))}
                <tr className="font-bold">
                  <td>Net</td>
                  <td className="num">{money(net?.cells[4]?.cents)}</td>
                  <td className="num">{money(net?.cells[5]?.cents)}</td>
                  <td className={`num${(net?.cells[6]?.cents ?? 0) < 0 ? " money-neg" : ""}`}>{money(net?.cells[6]?.cents)}</td>
                </tr>
              </tbody>
            </table>
            <div className="text-[11px] tm-text-muted pt-1">
              From the lots: one year or less is short-term.{excluded.length > 0 && ` Sales in ${excluded.length === 1 ? excluded[0].name : `${excluded.length} excluded accounts`} are left out.`}
            </div>
          </div>
        </section>

        <section className="aero-card">
          <div className="aero-card-title flex items-center justify-between">
            <span>Schedule B — investment income, {year}</span>
            <button className="aero-btn !py-0 !px-2 text-[11px]" type="button" onClick={() => open("investment_income")}>
              Full report
            </button>
          </div>
          <div className="p-2">
            <table className="tm-report-table w-full" aria-label="Investment income summary">
              <tbody>
                <tr>
                  <td>Dividends</td>
                  <td className="num">{money(incomeTotal?.cells[0]?.cents)}</td>
                </tr>
                <tr>
                  <td>Interest</td>
                  <td className="num">{money(incomeTotal?.cells[1]?.cents)}</td>
                </tr>
                <tr>
                  <td>Capital gain distributions</td>
                  <td className="num">{money(incomeTotal?.cells[2]?.cents)}</td>
                </tr>
                <tr className="font-bold">
                  <td>Total</td>
                  <td className="num">{money(incomeTotal?.cells[3]?.cents)}</td>
                </tr>
                <tr>
                  <td className="tm-text-muted">of which reinvested</td>
                  <td className="num tm-text-muted">{money(incomeTotal?.cells[4]?.cents)}</td>
                </tr>
              </tbody>
            </table>
            <div className="text-[11px] tm-text-muted pt-1">Dividends and interest recorded on investment rows, reinvested or not. Bank interest is in the totals above under its category's line.</div>
          </div>
        </section>
      </div>

      <section className="aero-card">
        <div className="aero-card-title">Accounts included in tax information</div>
        <div className="p-2">
          <div className="text-[11px] tm-text-muted pb-1">
            Everything above, and the tax reports opened from here, count only the checked accounts. Retirement accounts start unchecked: interest, dividends and sales inside a 401(k) or IRA are not taxable events.
          </div>
          {accountsError && (
            <Notice tone="error" boxed className="mb-2">
              {accountsError}
            </Notice>
          )}
          <table className="tm-report-table w-full" aria-label="Accounts included in tax information">
            <tbody>
              {openAccounts.map((a) => (
                <tr key={a.id}>
                  <td style={{ width: 24 }}>
                    <input type="checkbox" aria-label={`Include ${a.name} in tax information`} checked={a.tax_included} onChange={(e) => void setIncluded(a.id, e.target.checked)} />
                  </td>
                  <td>{a.name}</td>
                  <td className="tm-text-muted">{labelFor(a.type)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function FormRows({ form, groups, onOpen, money }: { form: string; groups: LineGroup[]; onOpen: (kind: string, ids?: string[]) => void; money: (c: number | null | undefined) => string }) {
  return (
    <>
      <tr className="tm-report-section">
        <td colSpan={3}>{form}</td>
      </tr>
      {groups.map((g) => (
        <LineRows key={g.line} group={g} onOpen={onOpen} money={money} />
      ))}
    </>
  );
}

function LineRows({ group, onOpen, money }: { group: LineGroup; onOpen: (kind: string, ids?: string[]) => void; money: (c: number | null | undefined) => string }) {
  const line = group.line!;
  const short = line.slice(line.indexOf(":") + 1).trim();
  return (
    <>
      <tr className="font-bold">
        <td>
          <button type="button" className="tm-link" onClick={() => onOpen("tax_related_transactions", group.categories.map((c) => c.id))} title="Every transaction on this line">
            {short}
          </button>
        </td>
        <td className={`num${group.total < 0 ? " money-neg" : ""}`}>{money(group.total)}</td>
        <td />
      </tr>
      {group.categories.map((c) => (
        <tr key={c.id}>
          <td style={{ paddingLeft: 24 }}>
            <button type="button" className="tm-link" onClick={() => onOpen("tax_related_transactions", [c.id])}>
              {c.name}
            </button>
          </td>
          <td className={`num${c.cents < 0 ? " money-neg" : ""}`}>{money(c.cents)}</td>
          <td className="num">{c.count}</td>
        </tr>
      ))}
    </>
  );
}
