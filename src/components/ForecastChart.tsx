// The 90-day balance projection (§33).
//
// The first version was 91 saturated bars anchored to a zero line, and when
// the selected account was already negative every bar was full-height red —
// a solid block that said nothing. Two mistakes, both in the anti-pattern
// catalog: the wrong FORM (bars for a continuous trend), and thick
// saturated blocks where thin marks belong.
//
// The data's job here is "trend over time, one series", so: a thin line with a
// soft area fill, a hairline zero baseline, and exactly one direct label — the
// low point, which is the number the whole panel exists to show. Everything
// else is left to the axis and the hover readout.
import { useId, useMemo, useState } from "react";
import { formatDateUS, formatMoney } from "../lib/format";
import type { ForecastPoint } from "../lib/types";

interface Props {
  points: readonly ForecastPoint[];
  /** The low point, direct-labeled. */
  lowDate: string;
  height?: number;
}

/** Plot geometry in the SVG's own user units; the SVG scales to its box. */
const W = 1000;
const PAD_T = 14;
const PAD_B = 18;
const PAD_R = 6;
const PAD_L = 6;

/** The y-range to draw, and whether zero belongs in it.
 *
 *  Zero is included when the balance crosses it, is already below it, or comes
 *  within a quarter of the peak — those are the cases where "am I about to go
 *  negative" is the question. When the account never goes near zero, forcing
 *  zero into the range squashes the whole line into the top third and fills
 *  most of the panel with a flat block, which is what the first version did.
 *
 *  Exported because this rule, not the drawing, is what makes the chart
 *  readable or useless. */
export function domainOf(values: readonly number[]): {
  min: number;
  max: number;
  showZero: boolean;
} {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const showZero = lo < 0 || hi <= 0 || lo <= hi * 0.25;
  const dLo = showZero ? Math.min(0, lo) : lo;
  const dHi = showZero ? Math.max(0, hi) : hi;
  const span = dHi - dLo;
  const pad = span === 0 ? Math.max(1000, Math.abs(dHi) * 0.2 || 1000) : span * 0.08;
  return { min: dLo - pad, max: dHi + pad, showZero };
}

/** A balance that never moves is a number, not a chart — the form heuristic's
 *  first question. Drawing 90 days of an unchanging line says nothing and
 *  fills the panel doing it. */
export function isFlat(values: readonly number[]): boolean {
  return values.length > 0 && values.every((v) => v === values[0]);
}

export default function ForecastChart({ points, lowDate, height = 132 }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  // Unique per instance: two forecasts on one page shared these ids, and the
  // FIRST definition won for both — so the second chart was clipped by the
  // first one's baseline and rendered almost nothing.
  const uid = useId().replace(/:/g, "");

  const geom = useMemo(() => {
    const values = points.map((p) => p.balance_cents);
    const { min, max, showZero } = domainOf(values);
    const h = height;
    const plotH = h - PAD_T - PAD_B;
    const plotW = W - PAD_L - PAD_R;
    const x = (i: number) =>
      PAD_L + (points.length <= 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
    const y = (v: number) => PAD_T + plotH - ((v - min) / (max - min || 1)) * plotH;
    return { x, y, zeroY: y(0), h, plotH, showZero };
  }, [points, height]);

  const values = points.map((p) => p.balance_cents);

  if (points.length === 0) return null;

  // Nothing scheduled and nothing dated ahead: say so rather than drawing a
  // flat line across three months.
  if (isFlat(values)) {
    return (
      <div className="tm-chart tm-chart-flat">
        <div className="tm-fc-flatvalue">{formatMoney(values[0])}</div>
        <div className="tm-fc-flatnote">
          Nothing scheduled for this account, so the balance is not projected to
          change over the next {points.length - 1} days.
        </div>
      </div>
    );
  }

  const { x, y, zeroY, h, showZero } = geom;
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(p.balance_cents).toFixed(1)}`).join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(1)} ${zeroY.toFixed(1)} L${x(0).toFixed(1)} ${zeroY.toFixed(1)} Z`;
  const lowIndex = Math.max(0, points.findIndex((p) => p.date === lowDate));
  const low = points[lowIndex];
  const goesNegative = points.some((p) => p.balance_cents < 0);
  const active = hover !== null ? points[hover] : null;

  // A handful of date ticks — enough to place a month, not a ruler.
  const tickEvery = Math.max(1, Math.floor(points.length / 4));
  const last = points.length - 1;
  const ticks = points
    .map((p, i) => ({ p, i }))
    // The final tick is always drawn, so drop any regular tick close enough to
    // collide with it — two dates overlapping at the right edge is the whole
    // reason to bother.
    .filter(({ i }) => (i % tickEvery === 0 && last - i > tickEvery / 2) || i === last);

  return (
    <figure className="tm-chart" style={{ margin: 0 }}>
      <svg
        viewBox={`0 0 ${W} ${h}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Projected balance over ${points.length} days. Lowest ${formatMoney(
          low?.balance_cents ?? 0
        )} on ${formatDateUS(lowDate)}.`}
        style={{ width: "100%", height: h, display: "block" }}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const frac = (e.clientX - box.left) / (box.width || 1);
          const i = Math.round(frac * (points.length - 1));
          setHover(Math.min(points.length - 1, Math.max(0, i)));
        }}
      >
        {/* The area is clipped at the baseline so the part below zero can be
            drawn in the critical color — that is a status, not a series. */}
        <defs>
          <clipPath id={`fc-above-${uid}`}>
            <rect x="0" y="0" width={W} height={Math.max(0, zeroY)} />
          </clipPath>
          <clipPath id={`fc-below-${uid}`}>
            <rect x="0" y={Math.max(0, zeroY)} width={W} height={h} />
          </clipPath>
        </defs>

        <path d={area} className="tm-fc-area" clipPath={`url(#fc-above-${uid})`} />
        {goesNegative && (
          <path d={area} className="tm-fc-area neg" clipPath={`url(#fc-below-${uid})`} />
        )}

        {/* Solid hairline, never dashed: a dashed rule reads as a threshold.
            Only drawn when zero is actually in range. */}
        {showZero && <line x1={0} x2={W} y1={zeroY} y2={zeroY} className="tm-fc-zero" />}

        <path d={line} className="tm-fc-line" clipPath={`url(#fc-above-${uid})`} />
        {goesNegative && (
          <path d={line} className="tm-fc-line neg" clipPath={`url(#fc-below-${uid})`} />
        )}

        {/* The one direct label: the low point. A value on every point would
            go unread. */}
        {low && (
          <>
            <circle
              cx={x(lowIndex)}
              cy={y(low.balance_cents)}
              r={4}
              className={`tm-fc-low${low.balance_cents < 0 ? " neg" : ""}`}
            />
            <text
              x={Math.min(W - 90, Math.max(4, x(lowIndex) - 30))}
              y={Math.max(11, y(low.balance_cents) - 9)}
              className="tm-fc-lowlabel"
            >
              {formatMoney(low.balance_cents)}
            </text>
          </>
        )}

        {active && hover !== null && (
          <line
            x1={x(hover)}
            x2={x(hover)}
            y1={PAD_T - 6}
            y2={h - PAD_B}
            className="tm-fc-crosshair"
          />
        )}

        {ticks.map(({ p, i }) => (
          <text
            key={p.date}
            x={Math.min(W - 4, Math.max(4, x(i)))}
            y={h - 5}
            className="tm-fc-tick"
            textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}
          >
            {formatDateUS(p.date)}
          </text>
        ))}
      </svg>

      <figcaption className="tm-fc-readout">
        {active
          ? `${formatDateUS(active.date)} — ${formatMoney(active.balance_cents)}`
          : `Lowest ${formatMoney(low?.balance_cents ?? 0)} on ${formatDateUS(lowDate)}`}
      </figcaption>
    </figure>
  );
}
