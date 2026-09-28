// Money's Customize → Rows and Chart tabs (§47), applied on the viewer's
// side to a report the engine already produced: sort the rows of each
// section, fold the small ones into "Other", pick the chart kind. The
// engine's numbers are never changed — a block moves or merges whole, and
// subtotal / total rows are left exactly where and what they were.
import type { Report, ReportChart, ReportLine } from "./types";
import { baseKind, CHART_STYLES, type ChartStyle } from "../components/ReportChart";

export interface ReportOptions {
  /** default = the engine's order (Money's tree); name; amount (largest first). */
  sort: "default" | "name" | "amount";
  /** Rows under this share of their section's absolute total fold into
   *  "Other". Basis points; 0 = off. */
  combineUnderBps: number;
  /** auto = what the engine chose; otherwise one of the viewer's styles (§59). */
  chart: "auto" | ChartStyle;
  /** Money-style depth on the chart (§59). */
  depth: boolean;
  /** Investment reports: which securities. Empty = all. */
  securityIds: string[];
}

export const DEFAULT_OPTIONS: ReportOptions = { sort: "default", combineUnderBps: 0, chart: "auto", depth: true, securityIds: [] };

export function normalizeOptions(o: Partial<ReportOptions> | null | undefined): ReportOptions {
  return {
    sort: o?.sort === "name" || o?.sort === "amount" ? o.sort : "default",
    combineUnderBps: Math.max(0, Math.min(10_000, Math.round(Number(o?.combineUnderBps) || 0))),
    chart: CHART_STYLES.some((c) => c.value === o?.chart) ? (o!.chart as ChartStyle) : "auto",
    depth: o?.depth === undefined ? true : !!o.depth,
    securityIds: Array.isArray(o?.securityIds) ? o!.securityIds.filter((s) => typeof s === "string") : [],
  };
}

export function isDefaultOptions(o: ReportOptions): boolean {
  return o.sort === "default" && o.combineUnderBps === 0 && o.chart === "auto" && o.depth && o.securityIds.length === 0;
}

/** A level-0 row and the deeper rows that follow it: what moves together. */
interface Block {
  rows: ReportLine[];
  /** The block's true total in the first money column (see `cellTotal`). */
  amount: number;
}

/** What the row at `at` is worth in cell `i`. §180: a row that carries a
 *  number already includes the rows beneath it — the engine prints a
 *  parent's amount and then its breakdown (reports.rs's asset-allocation
 *  lines) — so its own cell is the answer and adding the children would
 *  count them twice. A row with a blank cell is a heading for the rows
 *  beneath it — a `group` parent, or category_txn_tree's subcategory line
 *  over its transactions — and is worth the sum of its direct children,
 *  each valued the same way. Summing only the head's cell dropped every
 *  group-headed block's money from "Other", and made those blocks weigh
 *  nothing, so they always folded. */
function cellTotal(rows: ReportLine[], at: number, i: number): number {
  const head = rows[at];
  const own = head.cells[i]?.cents;
  if (own !== null && own !== undefined) return own;
  let sum = 0;
  let j = at + 1;
  while (j < rows.length && rows[j].level > head.level) {
    sum += cellTotal(rows, j, i);
    const childLevel = rows[j].level;
    j++;
    // Skip the child's own descendants: they are inside its value already.
    while (j < rows.length && rows[j].level > childLevel) j++;
  }
  return sum;
}

function firstMoneyTotal(report: Report, rows: ReportLine[]): number {
  const head = rows[0];
  for (let i = 0; i < head.cells.length; i++) {
    if (report.columns[i + 1]?.kind === "money") return cellTotal(rows, 0, i);
  }
  return 0;
}

/** Split a section (rows between headers, minus its subtotal/total rows)
 *  into blocks. Only normal/group/bold rows at level 0 head a block. */
function blocks(report: Report, rows: ReportLine[]): Block[] {
  const out: ReportLine[][] = [];
  for (const r of rows) {
    if (r.level === 0 || out.length === 0) {
      out.push([r]);
    } else {
      out[out.length - 1].push(r);
    }
  }
  // Valued once the block is whole: a group head's worth is its children.
  return out.map((rs) => ({ rows: rs, amount: firstMoneyTotal(report, rs) }));
}

const MOVABLE = new Set(["normal", "group", "bold"]);

export function shapeReport(report: Report, options: ReportOptions): Report {
  if (options.sort === "default" && options.combineUnderBps === 0) return report;
  const out: ReportLine[] = [];
  // Sections: a run of movable rows, broken by header / subtotal / total rows.
  let run: ReportLine[] = [];
  const flush = () => {
    if (run.length === 0) return;
    let bs = blocks(report, run);
    if (options.sort === "name") bs = [...bs].sort((a, b) => a.rows[0].label.localeCompare(b.rows[0].label, undefined, { sensitivity: "base" }));
    if (options.sort === "amount") bs = [...bs].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
    if (options.combineUnderBps > 0 && bs.length > 2) {
      const total = bs.reduce((n, b) => n + Math.abs(b.amount), 0);
      if (total > 0) {
        const keep: Block[] = [];
        const fold: Block[] = [];
        for (const b of bs) {
          const share = Math.round((Math.abs(b.amount) * 10_000) / total);
          (share < options.combineUnderBps ? fold : keep).push(b);
        }
        if (fold.length > 1) {
          const head = fold[0].rows[0];
          const cells = head.cells.map((c, i) => {
            const kind = report.columns[i + 1]?.kind;
            if (kind === "money" || kind === "count" || kind === "percent") {
              const sum = fold.reduce((n, b) => n + cellTotal(b.rows, 0, i), 0);
              return { text: null, cents: sum };
            }
            return { text: null, cents: null };
          });
          keep.push({
            rows: [{ key: null, key_kind: null, label: `Other (${fold.length} combined)`, level: head.level, style: "normal", cells }],
            amount: fold.reduce((n, b) => n + b.amount, 0),
          });
          bs = keep;
        }
      }
    }
    for (const b of bs) out.push(...b.rows);
    run = [];
  };
  for (const r of report.rows) {
    if (MOVABLE.has(r.style)) run.push(r);
    else {
      flush();
      out.push(r);
    }
  }
  flush();
  return { ...report, rows: out };
}

/** How the chart is drawn: the style the user asked for when the data
 *  allows it (a pie needs a single series), else the engine's own kind. */
export function chartStyleFor(report: Report, options: ReportOptions): ChartStyle | null {
  if (!report.chart) return null;
  if (options.chart === "auto") return report.chart.kind;
  if (baseKind(options.chart) === "pie" && report.chart.series.length !== 1) return report.chart.kind;
  return options.chart;
}

/** The chart to draw, with `kind` set to the base kind of the chosen style. */
export function chartFor(report: Report, options: ReportOptions): ReportChart | null {
  const style = chartStyleFor(report, options);
  if (!style || !report.chart) return null;
  return { ...report.chart, kind: baseKind(style) };
}
