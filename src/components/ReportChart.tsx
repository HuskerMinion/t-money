// The chart view of a report: the same numbers the
// table shows, as a bar, stacked bar, horizontal bar, pie, doughnut, line
// or area chart, flat or with Money-style depth. Inline SVG, no library;
// colors from the --tm-series-* tokens, which were read off Money's own
// chart, with shades mixed from them in CSS (color-mix) so the tokens stay
// the single source of color.
//
// The one rule from the forecast chart applies here too: a chart earns its
// place by showing a shape. So a bar chart of one value, or a line of one
// point, falls back to the table rather than drawing a lonely mark.
import { useId, useState } from "react";
import { formatMoney } from "../lib/format";
import type { ReportChart as ChartData } from "../lib/types";

/** Every way the viewer can draw a report's numbers. */
export type ChartStyle = "bar" | "stacked" | "hbar" | "pie" | "doughnut" | "line" | "area";

export const CHART_STYLES: readonly { value: ChartStyle; label: string; glyph: string }[] = [
  { value: "bar", label: "Bar", glyph: "▮▮" },
  { value: "stacked", label: "Stacked bar", glyph: "▤" },
  { value: "hbar", label: "Horizontal bar", glyph: "▬" },
  { value: "line", label: "Line", glyph: "⟋" },
  { value: "area", label: "Area", glyph: "◢" },
  { value: "pie", label: "Pie", glyph: "◕" },
  { value: "doughnut", label: "Doughnut", glyph: "◯" },
];

/** The engine's kind a style is a variation of. */
export function baseKind(style: ChartStyle): ChartData["kind"] {
  if (style === "stacked" || style === "hbar") return "bar";
  if (style === "doughnut") return "pie";
  if (style === "area") return "line";
  return style;
}

interface Props {
  chart: ChartData;
  /** How to draw it; defaults to the engine's kind. */
  style?: ChartStyle;
  /** Money-style depth on bars and pies, a soft shadow on lines. */
  depth?: boolean;
  height?: number;
  /** A slice, a bar or a legend entry was clicked: the label of the
   *  thing it stands for. The viewer opens that thing's transactions, as a
   *  click on its row in the table does. Omit and the chart is inert. */
  onPick?: (label: string) => void;
}

const W = 1000;

export function seriesColor(i: number): string {
  return `var(--tm-series-${(i % 16) + 1})`;
}
/** A lighter or darker shade of a series color, for the lit and shaded faces. */
function shade(i: number, pct: number, toward: "white" | "black"): string {
  return `color-mix(in srgb, ${seriesColor(i)} ${100 - pct}%, ${toward})`;
}

/** "Nice" axis step for a max value in cents: 1/2/5 × 10^n, ≥ 4 ticks. */
export function niceStep(maxAbs: number): number {
  if (maxAbs <= 0) return 100;
  const raw = maxAbs / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) {
    if (m * mag >= raw) return m * mag;
  }
  return 10 * mag;
}

export function shortMoney(cents: number): string {
  const abs = Math.abs(cents);
  const sign = cents < 0 ? "-" : "";
  if (abs >= 100_000_000) return `${sign}${(abs / 100_000_000).toFixed(1)}M`;
  // One decimal under $10k. A 500-step axis rounded $1,500 and
  // $2,500 to "2k" and "3k", so two ticks could read the same or skip; the
  // labels have to say the value the gridline is at.
  if (abs >= 1_000_000) return `${sign}${Math.round(abs / 100_000)}k`;
  if (abs >= 100_000) return `${sign}${(abs / 100_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${sign}${Math.round(abs / 100)}`;
}

const FONT = { fontFamily: "var(--tm-font-body)" } as const;

function Flat() {
  return (
    <div className="tm-chart tm-chart-flat">
      <div className="tm-fc-flatnote">Not enough to chart — see the table.</div>
    </div>
  );
}

export default function ReportChart({ chart, style, depth = true, height = 420, onPick }: Props) {
  // What a clickable mark carries: a hand cursor, a role, and Enter.
  const pick = (label: string) =>
    onPick
      ? {
          role: "button" as const,
          tabIndex: 0,
          style: { cursor: "pointer" } as React.CSSProperties,
          onClick: () => onPick(label),
          onKeyDown: (e: React.KeyboardEvent) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onPick(label);
            }
          },
        }
      : {};
  const [hover, setHover] = useState<string | null>(null);
  const uid = useId().replace(/:/g, "");
  const series = chart.series.filter((s) => s.points.length > 0);
  const kind: ChartStyle = style ?? chart.kind;
  if (series.length === 0) return null;
  const totalPoints = series.reduce((n, s) => n + s.points.length, 0);
  if (totalPoints < 2) return <Flat />;

  // ---------------------------------------------------------------- pies
  if (kind === "pie" || kind === "doughnut") {
    const pts = series[0].points.filter(([, v]) => v > 0);
    const total = pts.reduce((n, [, v]) => n + v, 0);
    if (total <= 0 || pts.length < 2) return <Flat />;
    const RX = 200;
    const RY = depth ? 120 : 200;
    const D = depth ? 36 : 0; // wall height
    const cx = 250;
    const cy = depth ? 190 : 220;
    const inner = kind === "doughnut" ? 0.55 : 0;
    const svgW = 500;
    const svgH = depth ? 370 : 440;
    let angle = -Math.PI / 2;
    const pt = (a: number, r: number, dy = 0) => [cx + RX * r * Math.cos(a), cy + RY * r * Math.sin(a) + dy] as const;
    const arc = (a0: number, a1: number, r: number, dy: number, sweep: 0 | 1) => {
      const [x, y] = pt(sweep ? a1 : a0, r, dy);
      const large = Math.abs(a1 - a0) > Math.PI ? 1 : 0;
      return `A${(RX * r).toFixed(1)} ${(RY * r).toFixed(1)} 0 ${large} ${sweep} ${x.toFixed(1)} ${y.toFixed(1)}`;
    };
    const slices = pts.map(([label, v], i) => {
      const frac = v / total;
      const a0 = angle;
      const a1 = angle + frac * 2 * Math.PI;
      angle = a1;
      const whole = frac >= 0.9999;
      const [ox0, oy0] = pt(a0, 1);
      const [ix1, iy1] = pt(a1, inner);
      const [ix0, iy0] = pt(a0, inner);
      let top: string;
      if (whole) {
        top = `M${(cx - RX).toFixed(1)} ${cy} A${RX} ${RY} 0 1 1 ${(cx + RX).toFixed(1)} ${cy} A${RX} ${RY} 0 1 1 ${(cx - RX).toFixed(1)} ${cy} Z`;
        if (inner) top += ` M${(cx - RX * inner).toFixed(1)} ${cy} A${RX * inner} ${RY * inner} 0 1 0 ${(cx + RX * inner).toFixed(1)} ${cy} A${RX * inner} ${RY * inner} 0 1 0 ${(cx - RX * inner).toFixed(1)} ${cy} Z`;
      } else if (inner) {
        top = `M${ix0.toFixed(1)} ${iy0.toFixed(1)} L${ox0.toFixed(1)} ${oy0.toFixed(1)} ${arc(a0, a1, 1, 0, 1)} L${ix1.toFixed(1)} ${iy1.toFixed(1)} ${arc(a0, a1, inner, 0, 0)} Z`;
      } else {
        top = `M${cx} ${cy} L${ox0.toFixed(1)} ${oy0.toFixed(1)} ${arc(a0, a1, 1, 0, 1)} Z`;
      }
      // The outer wall shows where the rim faces the viewer (sin > 0): the
      // part of the arc between 0 and π, clipped to this slice.
      const walls: string[] = [];
      if (depth) {
        const lo = Math.max(a0, 0);
        const hi = Math.min(a1, Math.PI);
        const segs: [number, number][] = [];
        if (whole) segs.push([0, Math.PI]);
        else if (lo < hi) segs.push([lo, hi]);
        for (const [s0, s1] of segs) {
          const [x0, y0] = pt(s0, 1);
          const [x1, y1] = pt(s1, 1, D);
          walls.push(`M${x0.toFixed(1)} ${y0.toFixed(1)} ${arc(s0, s1, 1, 0, 1)} L${x1.toFixed(1)} ${y1.toFixed(1)} ${arc(s0, s1, 1, D, 0)} Z`);
        }
        // A doughnut's inner wall shows on the far side (sin < 0).
        if (inner) {
          const ilo = Math.max(a0, Math.PI);
          const ihi = Math.min(a1, 2 * Math.PI);
          const isegs: [number, number][] = whole ? [[Math.PI, 2 * Math.PI]] : [];
          if (!whole) {
            if (ilo < ihi) isegs.push([ilo, ihi]);
            if (a0 < 0) isegs.push([a0, Math.min(a1, 0)]);
          }
          for (const [s0, s1] of isegs) {
            const [x0, y0] = pt(s0, inner);
            const [x1, y1] = pt(s1, inner, D);
            walls.push(`M${x0.toFixed(1)} ${y0.toFixed(1)} ${arc(s0, s1, inner, 0, 1)} L${x1.toFixed(1)} ${y1.toFixed(1)} ${arc(s0, s1, inner, D, 0)} Z`);
          }
        }
      }
      const mid = (a0 + a1) / 2;
      const [lx, ly] = pt(mid, inner ? (1 + inner) / 2 : 0.62);
      return { label, v, frac, top, walls, i, lx, ly };
    });
    const dim = (label: string) => (hover && hover !== label ? 0.45 : 1);
    return (
      <figure className="tm-chart" style={{ margin: 0 }}>
        <div className="flex gap-4 items-start flex-wrap">
          <svg viewBox={`0 0 ${svgW} ${svgH}`} role="img" aria-label={`${series[0].label}, by share`} style={{ width: svgW, height: svgH, maxWidth: "100%" }}>
            <defs>
              {slices.map((s) => (
                <radialGradient key={s.i} id={`pg-${uid}-${s.i}`} cx="45%" cy="40%" r="70%">
                  <stop offset="0%" stopColor={shade(s.i, 28, "white")} />
                  <stop offset="100%" stopColor={seriesColor(s.i)} />
                </radialGradient>
              ))}
              <filter id={`ps-${uid}`} x="-10%" y="-10%" width="120%" height="130%">
                <feDropShadow dx="0" dy="3" stdDeviation="3" floodOpacity="0.25" />
              </filter>
            </defs>
            {depth && (
              <g filter={`url(#ps-${uid})`}>
                {slices.map((s) =>
                  s.walls.map((d, wi) => (
                    <path key={`${s.label}-${wi}`} d={d} fill={shade(s.i, 30, "black")} stroke={shade(s.i, 40, "black")} strokeWidth={0.5} opacity={dim(s.label)} />
                  ))
                )}
              </g>
            )}
            {slices.map((s) => (
              <path
                key={s.label}
                d={s.top}
                fill={`url(#pg-${uid}-${s.i})`}
                fillRule="evenodd"
                stroke="var(--tm-pure-white, #fff)"
                strokeWidth={1}
                opacity={dim(s.label)}
                filter={depth ? undefined : `url(#ps-${uid})`}
                onMouseEnter={() => setHover(s.label)}
                onMouseLeave={() => setHover(null)}
                aria-label={`${s.label}: ${formatMoney(s.v)}`}
                {...pick(s.label)}
              >
                <title>{`${s.label}: ${formatMoney(s.v)} (${(s.frac * 100).toFixed(1)}%)${onPick ? " — click for the transactions" : ""}`}</title>
              </path>
            ))}
            {slices
              .filter((s) => s.frac >= 0.06)
              .map((s) => (
                <text key={`${s.label}-pct`} x={s.lx} y={s.ly + 5} fontSize={14} fontWeight={700} textAnchor="middle" fill="var(--tm-pure-white, #fff)" style={{ ...FONT, pointerEvents: "none", paintOrder: "stroke", stroke: "rgba(0,0,0,0.35)", strokeWidth: 2 }}>
                  {Math.round(s.frac * 100)}%
                </text>
              ))}
          </svg>
          <ul className="tm-chart-legend" aria-label="Legend">
            {slices.map((s) => (
              <li key={s.label} onMouseEnter={() => setHover(s.label)} onMouseLeave={() => setHover(null)} {...pick(s.label)}>
                <span className="tm-chart-swatch" style={{ background: seriesColor(s.i) }} />
                {s.label} <span className="tm-text-muted">{formatMoney(s.v)} · {(s.frac * 100).toFixed(1)}%</span>
              </li>
            ))}
          </ul>
        </div>
      </figure>
    );
  }

  // ------------------------------------------------- axes for the rest
  const labels: string[] = [];
  for (const s of series) for (const [l] of s.points) if (!labels.includes(l)) labels.push(l);
  const at = (s: (typeof series)[number], l: string) => s.points.find(([pl]) => pl === l)?.[1] ?? 0;
  const stacked = kind === "stacked" && series.length > 1;
  const multi = series.length > 1;
  // Stacked bars reach the sum of the positives (and of the negatives).
  const extents = labels.map((l) => {
    const vs = series.map((s) => at(s, l));
    return stacked
      ? [vs.filter((v) => v > 0).reduce((n, v) => n + v, 0), vs.filter((v) => v < 0).reduce((n, v) => n + v, 0)]
      : [Math.max(0, ...vs), Math.min(0, ...vs)];
  });
  const maxV = Math.max(0, ...extents.map((e) => e[0]));
  const minV = Math.min(0, ...extents.map((e) => e[1]));
  const step = niceStep(Math.max(maxV, -minV));
  const top = Math.ceil(maxV / step) * step;
  const bottom = Math.floor(minV / step) * step;
  const ticks: number[] = [];
  for (let v = bottom; v <= top; v += step) ticks.push(v);
  const horizontal = kind === "hbar";
  const H = horizontal ? Math.max(260, labels.length * (multi && !stacked ? 16 * series.length + 10 : 26) + 60) : height;
  const PAD_L = horizontal ? 150 : 62;
  const PAD_R = 16;
  const PAD_T = 16;
  const PAD_B = !horizontal && labels.length > 8 ? 70 : 34;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  // Value → pixel along the value axis, and label slot along the other.
  const valPx = (v: number) => (horizontal ? PAD_L + ((v - bottom) / (top - bottom || 1)) * plotW : PAD_T + plotH - ((v - bottom) / (top - bottom || 1)) * plotH);
  const slot = (horizontal ? plotH : plotW) / labels.length;
  const slotStart = (li: number) => (horizontal ? PAD_T : PAD_L) + li * slot;
  const zero = valPx(0);
  // Depth of the extruded faces.
  const DX = depth ? Math.min(14, slot * 0.18) : 0;
  const DY = depth ? DX * 0.6 : 0;

  const bars: React.ReactNode[] = [];
  if (kind === "bar" || kind === "stacked" || kind === "hbar") {
    labels.forEach((l, li) => {
      const n = stacked ? 1 : series.length;
      const gap = slot * 0.25;
      const bw = (slot - gap) / n;
      let posBase = 0;
      let negBase = 0;
      series.forEach((s, si) => {
        const v = at(s, l);
        if (v === 0) return;
        let from = 0;
        if (stacked) {
          if (v > 0) {
            from = posBase;
            posBase += v;
          } else {
            from = negBase;
            negBase += v;
          }
        }
        const a = valPx(from);
        const b = valPx(from + v);
        const along0 = slotStart(li) + gap / 2 + (stacked ? 0 : si * bw);
        const ci = multi ? si : li;
        const key = `${l}|${s.label}`;
        const faded = hover && hover !== key ? 0.5 : 1;
        // Front face rectangle in screen coordinates.
        let x: number, y: number, w: number, h: number;
        if (horizontal) {
          x = Math.min(a, b);
          y = along0;
          w = Math.max(1, Math.abs(b - a));
          h = Math.max(1, bw - 1);
        } else {
          x = along0;
          y = Math.min(a, b);
          w = Math.max(1, bw - 1);
          h = Math.max(1, Math.abs(b - a));
        }
        const title = `${l}${multi ? ` — ${s.label}` : ""}: ${formatMoney(v)}`;
        // In a stack only the outermost segment shows a lit top face; an
        // inner one's would poke out beside the segment above it.
        const outermost = !stacked || (v > 0 ? from + v === extents[li][0] : extents[li][0] === 0 && from === 0);
        bars.push(
          <g key={key} opacity={faded} onMouseEnter={() => setHover(key)} onMouseLeave={() => setHover(null)} aria-label={title} {...pick(l)}>
            {depth && (
              <>
                {outermost && <polygon points={`${x},${y} ${x + DX},${y - DY} ${x + w + DX},${y - DY} ${x + w},${y}`} fill={shade(ci, 30, "white")} stroke={shade(ci, 10, "black")} strokeWidth={0.5} />}
                {/* right face */}
                <polygon points={`${x + w},${y} ${x + w + DX},${y - DY} ${x + w + DX},${y + h - DY} ${x + w},${y + h}`} fill={shade(ci, 32, "black")} stroke={shade(ci, 40, "black")} strokeWidth={0.5} />
              </>
            )}
            <rect x={x} y={y} width={w} height={h} fill={`url(#bg-${uid}-${ci % 16})`} stroke={shade(ci, 15, "black")} strokeWidth={0.5} />
            <title>{title}</title>
          </g>
        );
      });
    });
  }

  const lines: React.ReactNode[] = [];
  if (kind === "line" || kind === "area") {
    series.forEach((s, si) => {
      const pts = labels.map((l, li) => [slotStart(li) + slot / 2, valPx(at(s, l))] as const);
      const d = pts.map(([px, py], i) => `${i === 0 ? "M" : "L"}${px.toFixed(1)} ${py.toFixed(1)}`).join(" ");
      const areaD = `${d} L${pts[pts.length - 1][0].toFixed(1)} ${zero.toFixed(1)} L${pts[0][0].toFixed(1)} ${zero.toFixed(1)} Z`;
      const faded = hover && hover !== s.label ? 0.35 : 1;
      lines.push(
        <g key={s.label} clipPath={`url(#clip-${uid})`} opacity={faded} onMouseEnter={() => setHover(s.label)} onMouseLeave={() => setHover(null)}>
          {kind === "area" && <path d={areaD} fill={`url(#ag-${uid}-${si % 16})`} stroke="none" />}
          <path d={d} fill="none" stroke={seriesColor(si)} strokeWidth={depth ? 3 : 2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" filter={depth ? `url(#ls-${uid})` : undefined} />
          {pts.map(([px, py], i) => (
            <circle key={i} cx={px} cy={py} r={depth ? 4 : 3} fill={shade(si, 35, "white")} stroke={seriesColor(si)} strokeWidth={1.5} vectorEffect="non-scaling-stroke">
              <title>{`${labels[i]} — ${s.label}: ${formatMoney(at(s, labels[i]))}`}</title>
            </circle>
          ))}
        </g>
      );
    });
  }

  return (
    <figure className="tm-chart" style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${baseKind(kind)} chart: ${series.map((s) => s.label).join(", ")}`} style={{ width: "100%", height: "auto", display: "block" }}>
        <defs>
          <clipPath id={`clip-${uid}`}>
            <rect x={PAD_L} y={0} width={plotW} height={H} />
          </clipPath>
          <linearGradient id={`plot-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--tm-ms-row-alt)" />
            <stop offset="100%" stopColor="var(--tm-ms-row)" />
          </linearGradient>
          <filter id={`ls-${uid}`} x="-5%" y="-20%" width="110%" height="150%">
            <feDropShadow dx="0" dy="3" stdDeviation="2.5" floodOpacity="0.3" />
          </filter>
          {Array.from({ length: Math.min(16, multi ? series.length : labels.length) }, (_, i) => (
            <linearGradient key={i} id={`bg-${uid}-${i}`} x1={horizontal ? "0" : "0"} y1="0" x2={horizontal ? "1" : "0"} y2={horizontal ? "0" : "1"}>
              <stop offset="0%" stopColor={shade(i, 22, "white")} />
              <stop offset="100%" stopColor={seriesColor(i)} />
            </linearGradient>
          ))}
          {Array.from({ length: Math.min(16, series.length) }, (_, i) => (
            <linearGradient key={i} id={`ag-${uid}-${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={seriesColor(i)} stopOpacity={0.55} />
              <stop offset="100%" stopColor={seriesColor(i)} stopOpacity={0.08} />
            </linearGradient>
          ))}
        </defs>
        <rect x={PAD_L} y={PAD_T} width={plotW} height={plotH} fill={`url(#plot-${uid})`} />
        {ticks.map((v) => {
          const p = valPx(v);
          return (
            <g key={v}>
              {horizontal ? (
                <>
                  <line x1={p} x2={p} y1={PAD_T} y2={PAD_T + plotH} stroke={v === 0 ? "var(--tm-chart-axis)" : "var(--tm-chart-grid)"} strokeWidth={1} vectorEffect="non-scaling-stroke" />
                  <text x={p} y={PAD_T + plotH + 14} fontSize={11} textAnchor="middle" fill="var(--tm-chart-axis)" style={FONT}>
                    {shortMoney(v)}
                  </text>
                </>
              ) : (
                <>
                  <line x1={PAD_L} x2={W - PAD_R} y1={p} y2={p} stroke={v === 0 ? "var(--tm-chart-axis)" : "var(--tm-chart-grid)"} strokeWidth={1} vectorEffect="non-scaling-stroke" />
                  <text x={PAD_L - 6} y={p + 4} fontSize={11} textAnchor="end" fill="var(--tm-chart-axis)" style={FONT}>
                    {shortMoney(v)}
                  </text>
                </>
              )}
            </g>
          );
        })}
        {bars}
        {lines}
        {labels.map((l, li) => {
          const mid = slotStart(li) + slot / 2;
          const text = l.length > 22 ? `${l.slice(0, 20)}…` : l;
          if (horizontal) {
            return (
              <text key={l} x={PAD_L - 8} y={mid + 4} fontSize={11} textAnchor="end" fill="var(--tm-chart-axis)" style={FONT}>
                {text}
              </text>
            );
          }
          const rotate = labels.length > 8;
          return (
            <text key={l} x={mid} y={PAD_T + plotH + 14} fontSize={11} textAnchor={rotate ? "end" : "middle"} transform={rotate ? `rotate(-35 ${mid} ${PAD_T + plotH + 14})` : undefined} fill="var(--tm-chart-axis)" style={FONT}>
              {text}
            </text>
          );
        })}
      </svg>
      {multi && (
        <ul className="tm-chart-legend horizontal" aria-label="Legend">
          {series.map((s, si) => (
            <li key={s.label} onMouseEnter={() => setHover(kind === "line" || kind === "area" ? s.label : null)} onMouseLeave={() => setHover(null)}>
              <span className="tm-chart-swatch" style={{ background: seriesColor(si) }} />
              {s.label}
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}
