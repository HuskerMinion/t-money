// One viewer for every report — Money's report page: title, the date
// range line under it, "Common tasks" on the left (Change view, Customize,
// Add to favorites, Print, Export), the table or the chart, and the
// "Date range:" dropdown along the bottom. Clicking a row drills through:
// a category to its transactions, a payee to its transactions, an account to
// its register, a transaction to its row.
import { useEffect, useMemo, useState } from "react";
import ReportChart, { baseKind, CHART_STYLES } from "./ReportChart";
import PickList from "./PickList";
import TmIcon from "./TmIcon";
import Notice from "./Notice";
import { api } from "../lib/ipc";
import { useCommand } from "../lib/useCommand";
import { save } from "@tauri-apps/plugin-dialog";
import { formatAccountingBare, today } from "../lib/format";
import { RANGE_OPTIONS, resolveRange, type DateRange } from "../lib/reportRanges";
import { useAccountStore } from "../stores/useAccountStore";
import { chartFor, chartStyleFor, DEFAULT_OPTIONS, isDefaultOptions, normalizeOptions, shapeReport, type ReportOptions } from "../lib/reportShape";
import type { Classification, Payee, Report, ReportLine, ReportRequest, SavedReport, Security } from "../lib/types";

export interface ReportSpec {
  kind: string;
  /** The range id from RANGE_OPTIONS, or "custom". */
  rangeId: string;
  range: DateRange;
  accountIds: string[];
  categoryIds: string[];
  compare: DateRange | null;
  /** Net worth's Level of detail. */
  detail?: string;
  /** Customize's Rows / Chart / Securities. Absent = defaults. */
  options?: ReportOptions;
  /** From the Taxes tab: accounts with tax_included = 0 are left out. */
  taxScope?: boolean;
  // The rest of the scope. Every field is optional and absent means
  // "no filter", so an existing spec is unchanged by their arrival.
  /** Only these payees (or, with `excludePayees`, all but these). */
  payeeIds?: string[];
  excludeCategories?: boolean;
  excludePayees?: boolean;
  /** Absolute amounts in cents. */
  minCents?: number | null;
  maxCents?: number | null;
  /** Any of "" (open), "C", "R". Empty = every state. */
  cleared?: string[];
  /** Payee or memo contains this. */
  text?: string;
  /** Classification values a line must carry; `none:<axis>` = none. */
  classValueIds?: string[];
  /** The axis a by-classification report groups on. */
  classificationId?: string;
  /** The security a benchmark report measures against. */
  benchmarkSecurityId?: string;
  /** Set when this spec came from a saved report: saving again
   *  replaces it rather than making a second one. */
  savedId?: string;
  savedName?: string;
}

/** Whether a spec carries any of the line filters — what the Customize
 *  link says, and whether Reset has anything to do. */
export function hasLineFilters(spec: ReportSpec): boolean {
  return (
    (spec.payeeIds?.length ?? 0) > 0 ||
    !!spec.excludeCategories ||
    !!spec.excludePayees ||
    spec.minCents != null ||
    spec.maxCents != null ||
    (spec.cleared?.length ?? 0) > 0 ||
    !!spec.text ||
    (spec.classValueIds?.length ?? 0) > 0
  );
}

/** A saved report, as a spec the viewer can run. */
export function specFromSaved(r: SavedReport): ReportSpec {
  return {
    kind: r.kind,
    rangeId: r.range_id,
    range: r.range_id === "custom" ? { from: r.from, to: r.to } : resolveRange(r.range_id, today(), { from: r.from, to: r.to }),
    accountIds: r.account_ids,
    categoryIds: r.category_ids,
    compare: r.compare_from && r.compare_to ? { from: r.compare_from, to: r.compare_to } : null,
    detail: r.detail ?? undefined,
    options: normalizeOptions(r.options as Partial<ReportOptions> | null | undefined),
    payeeIds: r.payee_ids ?? [],
    excludeCategories: r.exclude_categories ?? false,
    excludePayees: r.exclude_payees ?? false,
    minCents: r.min_cents ?? null,
    maxCents: r.max_cents ?? null,
    cleared: r.cleared ?? [],
    text: r.text ?? "",
    classValueIds: r.class_value_ids ?? [],
    classificationId: r.classification_id ?? undefined,
    benchmarkSecurityId: r.benchmark_security_id ?? undefined,
    savedId: r.id,
    savedName: r.name,
  };
}

/** The reverse: what to store for this spec under `name`. */
export function savedFromSpec(spec: ReportSpec, name: string): SavedReport {
  return {
    id: spec.savedId ?? "",
    name,
    kind: spec.kind,
    range_id: spec.rangeId,
    from: spec.range.from,
    to: spec.range.to,
    account_ids: spec.accountIds,
    category_ids: spec.categoryIds,
    compare_from: spec.compare?.from ?? null,
    compare_to: spec.compare?.to ?? null,
    detail: spec.detail ?? null,
    options: spec.options && !isDefaultOptions(spec.options) ? { ...spec.options } : null,
    payee_ids: spec.payeeIds ?? [],
    exclude_categories: !!spec.excludeCategories,
    exclude_payees: !!spec.excludePayees,
    min_cents: spec.minCents ?? null,
    max_cents: spec.maxCents ?? null,
    cleared: spec.cleared ?? [],
    text: spec.text || null,
    class_value_ids: spec.classValueIds ?? [],
    classification_id: spec.classificationId ?? null,
    benchmark_security_id: spec.benchmarkSecurityId ?? null,
  };
}

/** The request fields a spec's filters become — used for the report itself
 *  and for the quick look, so the two can never disagree about scope. */
export function filtersOf(spec: ReportSpec): Partial<ReportRequest> {
  return {
    payee_ids: spec.payeeIds?.length ? spec.payeeIds : null,
    exclude_categories: spec.excludeCategories ?? false,
    exclude_payees: spec.excludePayees ?? false,
    min_cents: spec.minCents ?? null,
    max_cents: spec.maxCents ?? null,
    cleared: spec.cleared?.length ? spec.cleared : null,
    text: spec.text || null,
    class_value_ids: spec.classValueIds?.length ? spec.classValueIds : null,
    classification_id: spec.classificationId ?? null,
    benchmark_security_id: spec.benchmarkSecurityId ?? null,
  };
}

interface Props {
  spec: ReportSpec;
  onSpec: (next: ReportSpec) => void;
  /** Drill-through targets that leave the Reports tab. */
  onOpenAccount: (accountId: string) => void;
  onOpenTransaction: (accountId: string | null, transactionId: string) => void;
  onBack: () => void;
  /** Save this spec under a name (a new saved report, or replacing the one
   *  it came from). Resolves to the stored copy. */
  onSave: (report: SavedReport) => Promise<SavedReport>;
  onDeleteSaved?: (id: string) => Promise<void>;
}

/** A typed amount as cents, or null when the box is empty. Signs are
 *  dropped: the filter is on the SIZE of a line, in or out. */
/** Cents as the amount boxes show them once left: "50.00", or blank. */
export function centsText(cents: number | null | undefined): string {
  return cents == null ? "" : (cents / 100).toFixed(2);
}

export function centsOrNull(v: string): number | null {
  const t = v.trim().replace(/[$,]/g, "");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(Math.abs(n) * 100) : null;
}

/** Is this a whole date the report can be run for?
 *
 *  A `<input type="date">` reports "" while the day or month is still being
 *  typed, and a year typed digit by digit passes through 0002-01-01 on its
 *  way to 2026-01-01. Running the report on those gives an empty table, and
 *  an empty table is a short page: the browser then scrolls back to the top
 *  and the box being typed in moves. So the viewer waits for a date that
 *  could plausibly be meant before it re-runs anything. */
export function isWholeDate(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const year = Number(m[1]);
  return year >= 1000 && year <= 9999;
}

/** Format a cell by its column kind. Percent columns carry basis points. */
export function formatCell(kind: string, cents: number | null, text: string | null): string {
  if (cents === null) return text ?? "";
  switch (kind) {
    case "percent":
      return `${(cents / 100).toFixed(1)}%`;
    case "count":
      return String(cents);
    case "money":
      // Money's report tables print bare numbers — 1,234.56 and (58.42) —
      // and keep the $ for the chart tooltips.
      return formatAccountingBare(cents);
    default:
      return text ?? String(cents);
  }
}

/** The report as CSV — label column first, one row per line. */
export function toCsv(report: Report): string {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const head = report.columns.map((c) => q(c.label)).join(",");
  const body = report.rows.map((r) => {
    const cells = r.cells.map((c, i) => {
      const kind = report.columns[i + 1]?.kind ?? "text";
      if (c.cents !== null && kind === "money") return (c.cents / 100).toFixed(2);
      if (c.cents !== null && kind === "percent") return (c.cents / 100).toFixed(2);
      if (c.cents !== null) return String(c.cents);
      return q(c.text ?? "");
    });
    return [q(r.label), ...cells].join(",");
  });
  return [head, ...body].join("\r\n");
}

/** Where a click on this row leads, if anywhere. */
export function drillFor(spec: ReportSpec, row: ReportLine): Partial<ReportSpec> | null {
  if (!row.key_kind || row.key === null) return null;
  switch (row.key_kind) {
    case "category":
      return { kind: "transactions_by_category", categoryIds: row.key ? [row.key] : [] };
    case "payee":
      // Scoped to the payee clicked (the line filter), so the report
      // it opens is that payee's transactions, not every payee's. A payee
      // with no id (key "") cannot be scoped and opens the whole listing.
      return row.key ? { kind: "transactions_by_payee", payeeIds: [row.key] } : { kind: "transactions_by_payee" };
    case "class_value":
      // A value opens its transactions. The unclassified bucket's key
      // is `none:<axis>`, which is a scope value in its own right — the
      // engine writes the axis into the key precisely so the viewer does not
      // have to know which axis the report chose.
      return { kind: "transactions_by_classification", classValueIds: [row.key] };
    case "month": {
      const [y, m] = row.key.split("-").map(Number);
      const last = new Date(y, m, 0).getDate();
      return { kind: "income_and_spending", rangeId: "custom", range: { from: `${row.key}-01`, to: `${row.key}-${String(last).padStart(2, "0")}` } };
    }
    default:
      return null;
  }
}

export default function ReportViewer({ spec, onSpec, onOpenAccount, onOpenTransaction, onBack, onSave, onDeleteSaved }: Props) {
  const accounts = useAccountStore((s) => s.accounts);
  const categories = useAccountStore((s) => s.categories);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"table" | "chart">("table");
  const [customize, setCustomize] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  // A save on its way. Save stayed live while the first one was in
  // flight, and a second click stored the same report twice.
  const [saveBusy, setSaveBusy] = useState(false);
  // Customize's At least / At most boxes, as typed. They showed the
  // parsed cents re-formatted on every keystroke, so "5" became "5.00" and
  // the next digit landed after the zeros: $50 could not be typed. The text
  // is read into cents when the box is left and on Apply.
  const [amountText, setAmountText] = useState<{ min: string; max: string }>({ min: "", max: "" });
  // What the custom date boxes are showing while they are being typed
  // in, which is not always something the report can be run for.
  const [dateEcho, setDateEcho] = useState<DateRange | null>(null);
  // Customize edits a copy. Nothing re-runs until Apply, so the panel
  // stays still while you work in it and Cancel really does undo.
  const [draft, setDraft] = useState<ReportSpec | null>(null);
  useEffect(() => {
    setDateEcho(null);
  }, [spec.range.from, spec.range.to]);

  const shownRange = dateEcho ?? spec.range;
  function commitDate(which: "from" | "to", value: string) {
    const next: DateRange = { ...shownRange, [which]: value };
    setDateEcho(next);
    if (isWholeDate(next.from) && isWholeDate(next.to)) {
      onSpec({ ...spec, rangeId: "custom", range: next });
    }
  }

  /** Open Customize on a copy of the current spec; close it either way. */
  function openCustomize() {
    setDraft({ ...spec });
    setAmountText({ min: centsText(spec.minCents), max: centsText(spec.maxCents) });
    setCustomize(true);
  }
  function closeCustomize(apply: boolean) {
    if (apply && draft) {
      // A half-filled comparison is no comparison. Clearing one of
      // the two dates left "" in the request, which the backend refused;
      // either box blank now means what the hint beside them says — the
      // same length of time just before.
      const compare = draft.compare && draft.compare.from && draft.compare.to ? draft.compare : null;
      onSpec({
        ...draft,
        compare,
        minCents: centsOrNull(amountText.min),
        maxCents: centsOrNull(amountText.max),
      });
    }
    setDraft(null);
    setCustomize(false);
  }

  useEffect(() => {
    let canceled = false;
    setError(null);
    const request: ReportRequest = {
      kind: spec.kind,
      from: spec.range.from,
      to: spec.range.to,
      account_ids: spec.accountIds.length ? spec.accountIds : null,
      category_ids: spec.categoryIds.length ? spec.categoryIds : null,
      compare_from: spec.compare?.from ?? null,
      compare_to: spec.compare?.to ?? null,
      detail: spec.detail ?? null,
      security_ids: spec.options?.securityIds.length ? spec.options.securityIds : null,
      tax_scope: spec.taxScope ?? false,
      ...filtersOf(spec),
    };
    api
      .runReport(request)
      .then((r) => {
        if (!canceled) setReport(r);
      })
      .catch((e) => {
        if (!canceled) {
          setError(String(e));
          setReport(null);
        }
      });
    return () => {
      canceled = true;
    };
  }, [spec]);

  const options = spec.options ?? DEFAULT_OPTIONS;
  const setOptions = (next: Partial<ReportOptions>) => onSpec({ ...spec, options: { ...options, ...next } });
  const shaped = useMemo(() => (report ? shapeReport(report, options) : null), [report, options]);
  const chart = useMemo(() => (report ? chartFor(report, options) : null), [report, options]);
  const chartStyle = report ? chartStyleFor(report, options) : null;
  const singleSeries = !!report?.chart && report.chart.series.length === 1;
  const isInvestmentKind = ["portfolio_value", "investment_performance", "capital_gains", "investment_transactions", "investment_income", "benchmark_comparison", "asset_allocation"].includes(spec.kind);
  const [securities, setSecurities] = useState<Security[]>([]);
  // The lists the scope picker offers. Loaded when Customize is
  // opened, not on every report — most reports are never customized.
  const [payees, setPayees] = useState<Payee[]>([]);
  const [classifications, setClassifications] = useState<Classification[]>([]);
  useEffect(() => {
    if (!customize) return;
    let live = true;
    api.listPayees().then((p) => live && setPayees(p)).catch(() => {});
    api.listClassifications().then((c) => live && setClassifications(c)).catch(() => {});
    return () => {
      live = false;
    };
  }, [customize]);
  // A by-classification report always needs an axis; the benchmark one
  // always needs a security, so both load their list without waiting for
  // Customize to be opened.
  const isClassKind = spec.kind.includes("classification");
  const isBenchmark = spec.kind === "benchmark_comparison";
  useEffect(() => {
    if (!isClassKind) return;
    let live = true;
    api.listClassifications().then((c) => live && setClassifications(c)).catch(() => {});
    return () => {
      live = false;
    };
  }, [isClassKind]);
  useEffect(() => {
    if (!isInvestmentKind) return;
    let live = true;
    api.listSecurities().then((l) => live && setSecurities(l)).catch(() => {});
    return () => {
      live = false;
    };
  }, [isInvestmentKind]);
  const hasChart = !!chart && chart.series.some((s) => s.points.length > 1);
  const isComparison = spec.kind.endsWith("_comparison");
  const isAsOf = ["net_worth", "account_balances", "account_balances_with_details", "portfolio_value", "investment_performance", "asset_allocation"].includes(spec.kind);

  const scopeNote = useMemo(() => {
    const parts: string[] = [];
    if (spec.accountIds.length) {
      parts.push(spec.accountIds.map((id) => accounts.find((a) => a.id === id)?.name ?? "?").join(", "));
    }
    if (spec.categoryIds.length) {
      const names = spec.categoryIds.map((id) => categories.find((c) => c.id === id)?.full_name ?? categories.find((c) => c.id === id)?.name ?? "?").join(", ");
      parts.push(spec.excludeCategories ? `all but ${names}` : names);
    }
    return parts.join(" · ");
  }, [spec, accounts, categories]);

  // A category or payee row opens a quick look at its transactions —
  // a small report over this report, not a trip to another one. "Open the
  // full report" in it is the old drill.
  const [peek, setPeek] = useState<{ row: ReportLine; drill: Partial<ReportSpec> } | null>(null);
  const [peekReport, setPeekReport] = useState<Report | null>(null);
  const [peekError, setPeekError] = useState<string | null>(null);
  useEffect(() => {
    if (!peek) {
      setPeekReport(null);
      setPeekError(null);
      return;
    }
    let canceled = false;
    const request: ReportRequest = {
      kind: peek.drill.kind ?? "transactions_by_category",
      from: peek.drill.range?.from ?? spec.range.from,
      to: peek.drill.range?.to ?? spec.range.to,
      account_ids: spec.accountIds.length ? spec.accountIds : null,
      category_ids: peek.drill.categoryIds?.length ? peek.drill.categoryIds : spec.categoryIds.length ? spec.categoryIds : null,
      classification_id: spec.classificationId ?? null,
      compare_from: null,
      compare_to: null,
      detail: null,
      security_ids: null,
      tax_scope: spec.taxScope ?? false,
      // The quick look is this report, narrowed — it must carry the same
      // filters or its rows would not add up to the row that opened it.
      ...filtersOf(spec),
      // …and the value that was clicked narrows it further.
      payee_ids: peek.drill.payeeIds?.length ? peek.drill.payeeIds : spec.payeeIds?.length ? spec.payeeIds : null,
      class_value_ids: peek.drill.classValueIds?.length
        ? peek.drill.classValueIds
        : spec.classValueIds?.length
          ? spec.classValueIds
          : null,
    };
    api
      .runReport(request)
      .then((r) => {
        if (canceled) return;
        // A payee report lists every payee; keep the group that was clicked.
        if (peek.row.key_kind === "payee") {
          const rows: ReportLine[] = [];
          let keep = false;
          for (const line of r.rows) {
            if (line.style === "header") keep = line.key === peek.row.key || line.label === peek.row.label;
            else if (line.style === "total") continue;
            if (keep) rows.push(line);
          }
          setPeekReport({ ...r, rows });
        } else {
          setPeekReport(r);
        }
      })
      .catch((e) => {
        if (!canceled) setPeekError(String(e));
      });
    return () => {
      canceled = true;
    };
  }, [peek, spec]);

  function click(row: ReportLine) {
    if (row.key_kind === "account" && row.key) {
      onOpenAccount(row.key);
      return;
    }
    if (row.key_kind === "transaction" && row.key) {
      // The account is not on the row; the register finds it.
      onOpenTransaction(null, row.key);
      return;
    }
    if ((row.key_kind === "category" || row.key_kind === "payee" || row.key_kind === "class_value") && row.key !== null && !spec.kind.startsWith("transactions_")) {
      const drill = drillFor(spec, row);
      if (drill) {
        setPeek({ row, drill });
        return;
      }
    }
    const drill = drillFor(spec, row);
    // A drilled report is a new report, not an edit of the saved one.
    if (drill) onSpec({ ...spec, ...drill, compare: null, savedId: undefined, savedName: undefined });
  }

  // File → Export → This report to CSV. The button on the rail has
  // done this all along; the menu item named it and nothing served it, so it
  // was grayed out even while a report was on screen.
  useCommand("export.report.csv", () => void saveCsv());

  // The same CSV, to a file of the user's choosing.
  async function saveCsv() {
    if (!report) return;
    try {
      const path = await save({ defaultPath: `${report.title.replace(/[\\/:*?"<>|]+/g, " ").trim()}.csv`, filters: [{ name: "CSV", extensions: ["csv"] }] });
      if (!path) return;
      await api.writeTextFile(path, toCsv(report) + "\r\n");
    } catch (e) {
      setError(`Could not save: ${e}`);
    }
  }

  async function copyCsv() {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(toCsv(report));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      setError(`Could not copy: ${e}`);
    }
  }

  return (
    <div className="flex gap-4 items-start">
      {/* Common tasks — Money's left rail for a report */}
      <aside className="tm-report-tasks" aria-label="Report tasks">
        <div className="tm-rail-head">Common tasks</div>
        <button className="tm-rail-link" type="button" onClick={onBack}>
          ◂ Reports home
        </button>
        {hasChart && (
          <button className="tm-rail-link" type="button" onClick={() => setView(view === "table" ? "chart" : "table")}>
            Change view: {view === "table" ? "chart" : "table"}
          </button>
        )}
        <button
          className="tm-rail-link"
          type="button"
          onClick={() => (customize ? closeCustomize(false) : openCustomize())}
          aria-expanded={customize}
        >
          {hasLineFilters(spec) ? "Customize… (filtered)" : "Customize…"}
        </button>
        <button
          className="tm-rail-link"
          type="button"
          onClick={() => {
            setSaveName(spec.savedName ?? (report?.title ?? ""));
            setSaveError(null);
            setSaving((v) => !v);
          }}
          aria-expanded={saving}
        >
          {spec.savedId ? "Save changes to this report…" : "Add to my favorite reports…"}
        </button>
        {spec.savedId && onDeleteSaved && (
          <button
            className="tm-rail-link"
            type="button"
            onClick={() => {
              if (window.confirm(`Remove "${spec.savedName}" from My favorites?`)) {
                // A refused remove used to vanish into an unhandled
                // rejection, and the report simply stayed.
                setError(null);
                onDeleteSaved(spec.savedId!)
                  .then(onBack)
                  .catch((e) => setError(`Could not remove it from My favorites: ${e}`));
              }
            }}
          >
            Remove from my favorites
          </button>
        )}
        <button className="tm-rail-link" type="button" onClick={() => window.print()}>
          Print this report
        </button>
        <button className="tm-rail-link" type="button" onClick={() => void copyCsv()}>
          {copied ? "Copied as CSV" : "Copy as CSV (for Excel)"}
        </button>
        <button className="tm-rail-link" type="button" onClick={() => void saveCsv()}>
          Save as CSV file…
        </button>
      </aside>

      <section className="flex-1 min-w-0">
        <h1 className="tm-report-title">{spec.savedName ?? report?.title ?? "…"}</h1>
        <div className="tm-report-subtitle">
          {report?.subtitle}
          {scopeNote && <span className="tm-text-muted"> — {scopeNote}</span>}
        </div>

        {/* The date control. It used to sit under the table, where a
            long report hid it entirely ("I don't see a way to change the date
            … found it at the VERY bottom"), and where typing a custom date
            shortened the page and threw the scroll back to the top with the
            field you were typing in. At the top it cannot move under you, and
            `commitDate` refuses the half-finished values a date box emits
            mid-keystroke, so the report re-runs once you have a whole date
            rather than on every digit. */}
        <div className="tm-report-range" role="group" aria-label="Report period">
          <label htmlFor="report-range">{isAsOf ? "As of the end of:" : "Date range:"}</label>
          <select
            id="report-range"
            className="aero-field"
            value={spec.rangeId}
            onChange={(e) => {
              const id = e.target.value;
              onSpec({ ...spec, rangeId: id, range: resolveRange(id, today(), spec.range) });
            }}
          >
            {RANGE_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>{o.label}</option>
            ))}
          </select>
          {spec.rangeId === "custom" && (
            <>
              <input
                type="date"
                className="aero-field"
                aria-label="From"
                value={shownRange.from}
                onChange={(e) => commitDate("from", e.target.value)}
              />
              <span>through</span>
              <input
                type="date"
                className="aero-field"
                aria-label="To"
                value={shownRange.to}
                onChange={(e) => commitDate("to", e.target.value)}
              />
            </>
          )}
        </div>

        {error && (
          <Notice tone="error" boxed className="my-2">
            {error}
          </Notice>
        )}

        {saving && (
          <form
            className="aero-card mb-3"
            aria-label="Save report"
            onSubmit={(e) => {
              e.preventDefault();
              if (saveBusy) return;
              setSaveError(null);
              setSaveBusy(true);
              onSave(savedFromSpec(spec, saveName))
                .then((stored) => {
                  onSpec({ ...spec, savedId: stored.id, savedName: stored.name });
                  setSaving(false);
                })
                .catch((err) => setSaveError(String(err)))
                .finally(() => setSaveBusy(false));
            }}
          >
            <div className="aero-card-title">{spec.savedId ? "Save changes" : "Add to my favorite reports"}</div>
            <div className="p-3 flex items-center gap-2 text-[12px]">
              <label htmlFor="save-report-name">Name:</label>
              <input
                id="save-report-name"
                className="aero-field flex-1"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                autoFocus
              />
              <button className="aero-btn default" type="submit" disabled={saveBusy}>Save</button>
              <button className="aero-btn" type="button" onClick={() => setSaving(false)}>Cancel</button>
            </div>
            <div className="px-3 pb-2 text-[12px] tm-text-muted">
              Saves the report with its date range, accounts and categories, into your file.
            </div>
            {saveError && (
              <div className="px-3 pb-2">
                <Notice tone="error" boxed>
                  {saveError}
                </Notice>
              </div>
            )}
          </form>
        )}

        {/* Customize edits `d`, a copy of the spec. The report keeps
            showing what you were looking at until Apply, so choosing five
            categories is five clicks and one re-run rather than five re-runs,
            and Cancel puts everything back. */}
        {customize && (() => {
          const d = draft ?? spec;
          const dOptions = d.options ?? DEFAULT_OPTIONS;
          const setD = (patch: Partial<ReportSpec>) => setDraft({ ...d, ...patch });
          const setDOptions = (patch: Partial<ReportOptions>) => setDraft({ ...d, options: { ...dOptions, ...patch } });
          const dirty = JSON.stringify(savedFromSpec(d, "")) !== JSON.stringify(savedFromSpec(spec, ""));
          return (
          <div className="aero-card mb-3" role="region" aria-label="Customize report">
            <div className="aero-card-title">Customize</div>
            <div className="p-3 grid grid-cols-1 md:grid-cols-2 gap-3 text-[12px]">
              <PickList
                label="Accounts"
                items={accounts.map((a) => ({ value: a.id, label: a.name }))}
                value={d.accountIds}
                onChange={(accountIds) => setD({ accountIds })}
                note="None checked = all accounts."
              />
              <div>
                <PickList
                  label="Categories"
                  items={categories.map((c) => ({ value: c.id, label: c.full_name ?? c.name }))}
                  value={d.categoryIds}
                  onChange={(categoryIds) => setD({ categoryIds })}
                  note="A category takes its subcategories."
                />
                <label className="inline-flex items-center gap-1 pt-1">
                  <input
                    type="checkbox"
                    checked={!!d.excludeCategories}
                    onChange={(e) => setD({ excludeCategories: e.target.checked })}
                  />
                  Leave these out instead
                </label>
              </div>
              {/* The rest of the scope, on every report rather than on
                  the handful that happened to support it. */}
              <div>
                <PickList
                  label="Payees"
                  items={payees.map((p) => ({ value: p.id, label: p.name }))}
                  value={d.payeeIds ?? []}
                  onChange={(payeeIds) => setD({ payeeIds })}
                  note="None checked = every payee."
                />
                <label className="inline-flex items-center gap-1 pt-1">
                  <input
                    type="checkbox"
                    checked={!!d.excludePayees}
                    onChange={(e) => setD({ excludePayees: e.target.checked })}
                  />
                  Leave these out instead
                </label>
              </div>
              <fieldset className="flex items-center gap-3 flex-wrap">
                <legend className="font-bold">Amounts</legend>
                <label className="inline-flex items-center gap-1">
                  At least
                  <input
                    className="aero-field"
                    style={{ width: 90 }}
                    aria-label="Smallest amount"
                    inputMode="decimal"
                    value={amountText.min}
                    onChange={(e) => setAmountText({ ...amountText, min: e.target.value })}
                    onBlur={() => {
                      const minCents = centsOrNull(amountText.min);
                      setD({ minCents });
                      setAmountText({ ...amountText, min: centsText(minCents) });
                    }}
                  />
                </label>
                <label className="inline-flex items-center gap-1">
                  At most
                  <input
                    className="aero-field"
                    style={{ width: 90 }}
                    aria-label="Largest amount"
                    inputMode="decimal"
                    value={amountText.max}
                    onChange={(e) => setAmountText({ ...amountText, max: e.target.value })}
                    onBlur={() => {
                      const maxCents = centsOrNull(amountText.max);
                      setD({ maxCents });
                      setAmountText({ ...amountText, max: centsText(maxCents) });
                    }}
                  />
                </label>
                <span className="tm-text-muted">Either can be left blank. Signs are ignored — 50 means fifty dollars in or out.</span>
              </fieldset>
              <fieldset className="flex items-center gap-3 flex-wrap">
                <legend className="font-bold">Status</legend>
                {[["", "Open"], ["C", "Cleared"], ["R", "Reconciled"]].map(([v, label]) => (
                  <label key={label} className="inline-flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={(d.cleared ?? []).includes(v)}
                      onChange={(e) => {
                        const on = new Set(d.cleared ?? []);
                        if (e.target.checked) on.add(v);
                        else on.delete(v);
                        setD({ cleared: [...on] });
                      }}
                    />
                    {label}
                  </label>
                ))}
                <span className="tm-text-muted">None checked = every state.</span>
              </fieldset>
              <label className="block">
                <div className="font-bold pb-1">Containing</div>
                <input
                  className="aero-field w-full"
                  aria-label="Text in payee or memo"
                  placeholder="Payee or memo contains…"
                  value={d.text ?? ""}
                  onChange={(e) => setD({ text: e.target.value })}
                />
              </label>
              {classifications.length > 0 && (
                <div className="md:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-3">
                  {classifications.map((c) => {
                    const mine = new Set([`none:${c.id}`, ...c.values.map((v) => v.id)]);
                    return (
                      <PickList
                        key={c.id}
                        label={c.name}
                        items={[
                          { value: `none:${c.id}`, label: "(not classified)" },
                          ...c.values.map((v) => ({ value: v.id, label: v.full_name })),
                        ]}
                        value={(d.classValueIds ?? []).filter((v) => mine.has(v))}
                        onChange={(picked) => {
                          const others = (d.classValueIds ?? []).filter((v) => !mine.has(v));
                          setD({ classValueIds: [...others, ...picked] });
                        }}
                        note={`None checked = every ${c.name.toLowerCase()}. A value takes its sub-values.`}
                        rows={6}
                      />
                    );
                  })}
                </div>
              )}
              {isClassKind && (
                <label className="block md:col-span-2">
                  <div className="font-bold pb-1">Group by</div>
                  <select
                    className="aero-field"
                    aria-label="Classification to group by"
                    value={d.classificationId ?? ""}
                    onChange={(e) => setD({ classificationId: e.target.value || undefined })}
                  >
                    <option value="">(the first one)</option>
                    {classifications.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </label>
              )}
              {isBenchmark && (
                <label className="block md:col-span-2">
                  <div className="font-bold pb-1">Benchmark</div>
                  <select
                    className="aero-field"
                    aria-label="Benchmark security"
                    value={d.benchmarkSecurityId ?? ""}
                    onChange={(e) => setD({ benchmarkSecurityId: e.target.value || undefined })}
                  >
                    <option value="">(choose one)</option>
                    {securities.map((x) => (
                      <option key={x.id} value={x.id}>{x.symbol ? `${x.name} (${x.symbol})` : x.name}</option>
                    ))}
                  </select>
                  <div className="tm-text-muted pt-1">
                    Everything is measured against this security's price movement over the range.
                  </div>
                </label>
              )}
              {spec.kind === "net_worth" && (
                <fieldset className="md:col-span-2 flex items-center gap-4">
                  <legend className="font-bold">Level of detail</legend>
                  {[
                    ["accounts", "Accounts"],
                    ["types", "Account types"],
                    ["sides", "Assets/liabilities"],
                  ].map(([v, label]) => (
                    <label key={v} className="inline-flex items-center gap-1">
                      <input
                        type="radio"
                        name="nw-detail"
                        value={v}
                        checked={(d.detail ?? "types") === v}
                        onChange={() => setD({ detail: v })}
                      />
                      {label}
                    </label>
                  ))}
                </fieldset>
              )}
              {isComparison && (
                <div className="md:col-span-2 flex items-center gap-2">
                  <span className="font-bold">Compare with:</span>
                  <input type="date" className="aero-field" aria-label="Compare from" value={d.compare?.from ?? ""} onChange={(e) => setD({ compare: { from: e.target.value, to: d.compare?.to ?? e.target.value } })} />
                  <span>through</span>
                  <input type="date" className="aero-field" aria-label="Compare to" value={d.compare?.to ?? ""} onChange={(e) => setD({ compare: { from: d.compare?.from ?? e.target.value, to: e.target.value } })} />
                  <span className="tm-text-muted">Blank = the same length of time just before.</span>
                </div>
              )}
              {isInvestmentKind && (
                <div className="md:col-span-2">
                  <PickList
                    label="Securities"
                    items={securities.map((x) => ({ value: x.id, label: x.symbol ? `${x.name} (${x.symbol})` : x.name }))}
                    value={dOptions.securityIds}
                    onChange={(securityIds) => setDOptions({ securityIds })}
                    note="None checked = every security."
                    rows={6}
                  />
                </div>
              )}
              <fieldset className="flex items-center gap-3 flex-wrap">
                <legend className="font-bold">Rows</legend>
                <label className="inline-flex items-center gap-1">
                  Sort by
                  <select className="aero-field" aria-label="Sort rows" value={dOptions.sort} onChange={(e) => setDOptions({ sort: e.target.value as ReportOptions["sort"] })}>
                    <option value="default">Money's order</option>
                    <option value="name">Name</option>
                    <option value="amount">Amount (largest first)</option>
                  </select>
                </label>
                <label className="inline-flex items-center gap-1">
                  Combine values under
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={0.5}
                    className="aero-field"
                    style={{ width: 70 }}
                    aria-label="Combine values under percent"
                    value={dOptions.combineUnderBps / 100}
                    onChange={(e) => setDOptions({ combineUnderBps: Math.round((Number(e.target.value) || 0) * 100) })}
                  />
                  % into “Other”
                </label>
              </fieldset>
              <fieldset className="flex items-center gap-3 flex-wrap">
                <legend className="font-bold">Chart</legend>
                {[["auto", "As the report draws it"], ...CHART_STYLES.map((c) => [c.value, c.label])].map(([v, label]) => (
                  <label key={v} className="inline-flex items-center gap-1">
                    <input type="radio" name="chart-kind" value={v} checked={dOptions.chart === v} onChange={() => setDOptions({ chart: v as ReportOptions["chart"] })} />
                    {label}
                  </label>
                ))}
                <label className="inline-flex items-center gap-1">
                  <input type="checkbox" checked={dOptions.depth} onChange={(e) => setDOptions({ depth: e.target.checked })} />
                  3-D
                </label>
                <span className="tm-text-muted">A pie or doughnut needs a single series; otherwise the report's own chart is kept.</span>
              </fieldset>
            </div>
            {/* The way out. Apply is the default button, so Enter anywhere in
                the panel runs the report you have just described. */}
            <div className="tm-customize-actions">
              <button className="aero-btn default" type="button" onClick={() => closeCustomize(true)}>
                Apply
              </button>
              <button className="aero-btn" type="button" onClick={() => closeCustomize(false)}>
                Cancel
              </button>
              <button
                className="aero-btn"
                type="button"
                onClick={() => {
                  setAmountText({ min: "", max: "" });
                  setDraft({
                    ...d,
                    accountIds: [],
                    categoryIds: [],
                    compare: null,
                    options: undefined,
                    payeeIds: [],
                    excludeCategories: false,
                    excludePayees: false,
                    minCents: null,
                    maxCents: null,
                    cleared: [],
                    text: "",
                    classValueIds: [],
                  });
                }}
              >
                Reset
              </button>
              <span className="tm-text-muted flex-1">
                {dirty ? "Not applied yet — the report below still shows the old scope." : "Nothing changed yet."}
              </span>
            </div>
          </div>
          );
        })()}

        {report && view === "chart" && chart && chartStyle && (
          <>
            {/* The chart's own style bar — every way to draw it, and depth. */}
            <div className="tm-chart-bar" role="toolbar" aria-label="Chart style">
              {CHART_STYLES.map((c) => {
                const blocked = baseKind(c.value) === "pie" && !singleSeries;
                return (
                  <button
                    key={c.value}
                    type="button"
                    className={`aero-btn !py-0 !px-2${chartStyle === c.value ? " tm-chart-bar-on" : ""}`}
                    aria-pressed={chartStyle === c.value}
                    aria-label={c.label}
                    title={blocked ? `${c.label} needs a single series` : c.label}
                    disabled={blocked}
                    onClick={() => setOptions({ chart: c.value })}
                  >
                    <span aria-hidden="true">{c.glyph}</span> {c.label}
                  </button>
                );
              })}
              <label className="inline-flex items-center gap-1 pl-2">
                <input type="checkbox" checked={options.depth} onChange={(e) => setOptions({ depth: e.target.checked })} />
                3-D
              </label>
            </div>
            <ReportChart
              chart={chart}
              style={chartStyle}
              depth={options.depth}
              // A slice or a bar is the row it was drawn from: find
              // that row and treat the click as a click on it, so a category
              // or payee opens its transactions (the quick look) and an
              // account opens its register. A chart label is the row's own
              // label, or its group's ("Total Automobile" for a category
              // group). A label with no keyed row behind it does nothing.
              onPick={
                report
                  ? (label) => {
                      const keyed = report.rows.filter((r) => r.key_kind && r.key !== null);
                      const row =
                        keyed.find((r) => r.label === label && r.style !== "subtotal") ??
                        keyed.find((r) => r.label === label) ??
                        keyed.find((r) => r.label === `Total ${label}`);
                      if (row) click(row);
                    }
                  : undefined
              }
            />
          </>
        )}

        {report && shaped && view === "table" && (
          <div className="overflow-auto">
            <table className="register-table tm-report-table" aria-label={report.title}>
              <thead>
                <tr>
                  {report.columns.map((c, i) => (
                    <th key={i} className={c.kind === "money" || c.kind === "percent" || c.kind === "count" || c.kind === "number" ? "num" : undefined}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shaped.rows.length === 0 && (
                  <tr>
                    <td colSpan={report.columns.length} className="text-center tm-text-muted">
                      Nothing in this range.
                    </td>
                  </tr>
                )}
                {shaped.rows.map((r, ri) => {
                  const clickable =
                    !!r.key_kind &&
                    r.key !== null &&
                    (r.key_kind !== "category" || spec.kind !== "transactions_by_category") &&
                    // A value row in the list it already opened leads
                    // nowhere; everywhere else it opens its transactions.
                    (r.key_kind !== "class_value" || spec.kind !== "transactions_by_classification") &&
                    r.key_kind !== "recurrence" &&
                    r.key_kind !== "investment" &&
                    r.key_kind !== "security";
                  return (
                    <tr
                      key={ri}
                      className={[
                        r.style === "header" ? "tm-report-section" : "",
                        r.style === "group" ? "tm-report-group" : "",
                        r.style === "bold" ? "tm-report-bold" : "",
                        r.style === "subtotal" ? "tm-report-subtotal" : "",
                        r.style === "total" ? "tm-report-total" : "",
                        clickable ? "tm-report-link" : "",
                      ].filter(Boolean).join(" ") || undefined}
                      onClick={clickable ? () => click(r) : undefined}
                      tabIndex={clickable ? 0 : undefined}
                      onKeyDown={clickable ? (e) => { if (e.key === "Enter") click(r); } : undefined}
                      aria-label={clickable ? `Open ${r.label}` : undefined}
                    >
                      <td style={{ paddingLeft: 6 + r.level * 18 }} colSpan={r.style === "header" ? report.columns.length : 1}>
                        {r.label}
                      </td>
                      {r.style !== "header" &&
                        r.cells.map((c, ci) => {
                          const kind = report.columns[ci + 1]?.kind ?? "text";
                          const num = kind === "money" || kind === "percent" || kind === "count" || kind === "number";
                          const neg = kind === "money" && (c.cents ?? 0) < 0;
                          // Money leaves a zero month blank on ordinary rows;
                          // totals still print 0.00.
                          const blankZero = kind === "money" && c.cents === 0 && r.style === "normal";
                          return (
                            <td key={ci} className={[num ? "num" : "", neg ? "money-neg" : ""].filter(Boolean).join(" ") || undefined}>
                              {blankZero ? "" : formatCell(kind, c.cents, c.text)}
                            </td>
                          );
                        })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {peek && (
          <>
            <div className="tm-dialog-backdrop" onClick={() => setPeek(null)} />
            <div className="tm-dialog tm-peek" role="dialog" aria-label={`Transactions: ${peek.row.label}`}>
              <div className="tm-dialog-title flex items-center gap-2">
                <span className="flex-1">
                  {peek.row.label} — transactions, {report?.subtitle ?? ""}
                </span>
                <button
                  className="aero-btn !py-0 !px-2 text-[11px] font-normal"
                  type="button"
                  onClick={() => {
                    const drill = peek.drill;
                    setPeek(null);
                    onSpec({ ...spec, ...drill, compare: null, savedId: undefined, savedName: undefined });
                  }}
                >
                  Make this a report
                </button>
                <button className="aero-btn !py-0 !px-2 text-[11px] font-normal" type="button" onClick={() => setPeek(null)} aria-label="Close">
                  ✕
                </button>
              </div>
              <div className="tm-dialog-body tm-peek-body">
                {peekError && <div className="money-neg">{peekError}</div>}
                {!peekReport && !peekError && <div className="tm-text-muted">Loading…</div>}
                {peekReport && peekReport.rows.length === 0 && <div className="tm-text-muted">No transactions in this range.</div>}
                {peekReport && peekReport.rows.length > 0 && (
                  <table className="tm-report-table" aria-label={`Transactions for ${peek.row.label}`}>
                    <thead>
                      <tr>
                        {peekReport.columns.map((c, i) => (
                          <th key={i} className={c.kind === "money" || c.kind === "count" ? "num" : undefined}>
                            {c.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {peekReport.rows.map((r, ri) => {
                        const isTxn = r.key_kind === "transaction" && r.key !== null;
                        return (
                          <tr
                            key={ri}
                            className={[r.style === "header" ? "tm-report-section" : "", r.style === "subtotal" ? "tm-report-subtotal" : "", r.style === "total" ? "tm-report-total" : "", isTxn ? "tm-report-link" : ""].filter(Boolean).join(" ") || undefined}
                            role={isTxn ? "button" : undefined}
                            tabIndex={isTxn ? 0 : undefined}
                            title={isTxn ? "Open in the register" : undefined}
                            onClick={isTxn ? () => { setPeek(null); onOpenTransaction(null, r.key!); } : undefined}
                            onKeyDown={isTxn ? (e) => { if (e.key === "Enter") { setPeek(null); onOpenTransaction(null, r.key!); } } : undefined}
                          >
                            <td style={{ paddingLeft: 6 + r.level * 12 }} colSpan={r.style === "header" ? peekReport.columns.length : 1}>
                              {r.label}
                            </td>
                            {r.style !== "header" &&
                              r.cells.map((c, ci) => {
                                const kind = peekReport.columns[ci + 1]?.kind ?? "text";
                                const num = kind === "money" || kind === "count";
                                const neg = kind === "money" && (c.cents ?? 0) < 0;
                                return (
                                  <td key={ci} className={[num ? "num" : "", neg ? "money-neg" : ""].filter(Boolean).join(" ") || undefined}>
                                    {formatCell(kind, c.cents, c.text)}
                                  </td>
                                );
                              })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </>
        )}

      </section>
    </div>
  );
}
