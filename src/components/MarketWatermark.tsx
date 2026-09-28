// §96, and redrawn three times since — the watermark behind Favorite Accounts.
//
// The history is worth keeping, because each attempt failed for a reason that
// is now a rule:
//
//   1. A candlestick chart. A chart is a drawing of DATA, so on a card of real
//      balances the eye keeps going back to work out whether it means
//      anything.
//   2. A neoclassical bank facade. An emblem rather than a plot, which fixed
//      that — but generic. It could have been any finance app's.
//   3. T-Money's own mark in outline. The textbook answer, and the user did not
//      want the logo sitting behind their accounts.
//   4. My own hand-drawn scatter, in the spirit of a reference they sent. It
//      came out childish. That is the honest word for it: freehand
//      illustration of a piggy bank is a drawing skill, and iterating on SVG
//      path data was not going to reach the quality of the reference.
//
// So: the app's OWN icon set, which is professionally drawn, already on brand,
// and already on every screen. A field of them across the whole card, at an
// opacity the stylesheet owns.
//
// WHY THIS WORKS WHERE THE DRAWINGS DID NOT. These shapes were made to be
// read at 18px in a menu, so they are legible as silhouettes and have no fine
// detail to turn to mush at a tenth of full strength. They are the same
// vocabulary as the reference — a bank, a money bag with a $, a rising chart,
// a pie, a percentage, a target — drawn by someone who could draw them.
//
// The layout is a loose stagger rather than a grid: nothing large enough to
// dominate, nothing sitting square behind a figure, and no two on the same
// line as each other. `slice` keeps it filling the card whatever height the
// card happens to be, which changes with how many accounts are starred.
//
// Tinting: the icons take `--tm-icon-*`, so `.tm-watermark` sets all three ink
// variables to `currentColor` and the knockout to the card's own body color —
// which is what keeps the internal detail (the $ on the bag, the slice in the
// pie) rather than flattening each icon into a blob. Inert: aria-hidden,
// pointer-events none, no focus stop.

/** name, x, y, size, rotation — a stagger, not a grid. */
const SCATTER: [string, number, number, number, number][] = [
  ["accounts", 14, 74, 54, -5],
  ["budgeting", 92, 132, 44, 6],
  ["investments", 150, 66, 52, -3],
  ["goals", 224, 136, 40, 5],
  ["taxes", 268, 62, 46, -4],
  ["transactions", 336, 132, 46, 3],
  ["calendar", 398, 60, 44, -5],
  ["reports", 466, 128, 42, 4],
  ["home", 72, 34, 34, 4],
  ["sync", 206, 30, 32, -4],
  ["search", 330, 34, 32, 5],
  ["payments", 462, 32, 34, -3],
];

export default function MarketWatermark() {
  return (
    <svg
      className="tm-watermark"
      viewBox="0 0 520 200"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      {SCATTER.map(([name, x, y, size, rot]) => (
        <g key={name} transform={`translate(${x},${y}) rotate(${rot}) scale(${size / 24})`}>
          {/* `width` and `height` are NOT optional here. A <use> of a <symbol>
              with no size takes 100% x 100% OF THE VIEWPORT — so each icon was
              drawn at 520x200 and then scaled up again, which put one enormous
              icon off to the right and nothing else anywhere. The symbol's own
              viewBox is 24x24; saying so maps it into a 24-unit box, and the
              scale above is then the size in the card's units. */}
          <use href={`#tm-${name}`} width="24" height="24" />
        </g>
      ))}
    </svg>
  );
}
