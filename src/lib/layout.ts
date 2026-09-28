// §99 — looks. A LOOK is the shape of the app; a THEME is its colors. They
// are two settings on purpose, so Sidebar in Evening and Compact in Copper are
// both things you can have.
//
// > *"When I say different looks I mean exactly that. Like not tabs, rounded
// > tabs, completely different but still very effective layout of the app"*
//
// HOW A LOOK IS APPLIED. `data-look="compact"` on `<html>`, and the stylesheet
// does the rest — the same mechanism as `data-theme`. Where a look genuinely
// needs a different arrangement of the chrome rather than different spacing
// (Sidebar has no tab strip; Two-up hangs a second register beside the first)
// the shell reads `useLook()` and arranges accordingly. Everything else is CSS.
//
// The point of doing it this way: a look cannot invent its own colors. It
// gets the theme's tokens like everything else, which is what stops ten looks
// times ten themes from becoming a hundred things to check.
//
// MONEY CLASSIC IS THE DEFAULT AND ALWAYS WILL BE. It is what the app is for.
// A new look is something you go and choose, never something you arrive in.

export type Structure =
  /** Money's tab strip over a left rail. */
  | "classic"
  /** No tab strip: navigation lives in the left rail. */
  | "sidebar"
  /** Icon rail, a column of accounts with their balances, then the register. */
  | "three-pane"
  /** A ribbon of grouped actions under the menu bar. */
  | "ribbon"
  /** Open registers as tabs across the top. */
  | "documents"
  /** A second, read-only register beside the one being worked (§126). */
  | "two-up";

export interface Look {
  id: string;
  label: string;
  blurb: string;
  /** How the chrome is arranged. Several looks share a structure and differ
   *  only in the stylesheet — Compact and Terminal are both `classic`. */
  structure: Structure;
  /** Looks that only make sense against their own palette say so, and the
   *  Settings picker offers to switch the theme with them. */
  suggestsTheme?: string;
}

const KEY = "tm.look";
export const DEFAULT_LOOK = "classic";

export const LOOKS: readonly Look[] = [
  {
    id: "classic",
    label: "Money Classic",
    blurb: "The tab strip, the blue header, the left rail. What Money looked like, and the default.",
    structure: "classic",
  },
  {
    id: "sidebar",
    label: "Sidebar",
    blurb: "No tab strip. Navigation runs down the left and the content gets the full height.",
    structure: "sidebar",
  },
  {
    id: "compact",
    label: "Compact",
    blurb: "The same shape, tightened — smaller chrome and shorter rows, so far more fits on screen.",
    structure: "classic",
  },
  {
    id: "card",
    label: "Card",
    blurb: "Rounded panels, soft shadows, no gridlines. Roomy, and the best showcase for a theme.",
    structure: "classic",
  },
  {
    id: "ribbon",
    label: "Ribbon",
    blurb: "Actions grouped and labeled across the top, the way Office does it. Nothing hidden in a menu.",
    structure: "ribbon",
  },
  {
    id: "three-pane",
    label: "Three-pane",
    blurb: "Icons, then every account with its balance, then the register. All your balances stay in view.",
    structure: "three-pane",
  },
  {
    id: "documents",
    label: "Document tabs",
    blurb: "Registers open as tabs across the top. Switch between accounts without going back to a list.",
    structure: "documents",
  },
  {
    id: "two-up",
    label: "Two-up",
    blurb: "A second register beside the one you are working. Watch one account while you type in another.",
    structure: "two-up",
  },
  {
    id: "terminal",
    label: "Terminal",
    blurb: "Dense monospace on near-black. Everything aligns, color means sign. For a long session.",
    structure: "classic",
    suggestsTheme: "midnight",
  },
  {
    id: "focus",
    label: "Focus",
    blurb: "One column, wide margins, no gridlines. For reading and reviewing rather than entering.",
    structure: "classic",
  },
  // §102 — four more, asked for by name: "a few more interesting layouts",
  // "maybe with some rounded tabs".
  {
    id: "rounded",
    label: "Rounded",
    blurb: "Tabs as detached pills, soft corners everywhere, no hard edges. The friendly one.",
    structure: "classic",
  },
  {
    id: "ledger",
    label: "Ledger",
    blurb: "Accounting paper: banded rows, hairline rules, a serif hand. Made for reading down a column.",
    structure: "classic",
    suggestsTheme: "sepia",
  },
  {
    id: "workbench",
    label: "Workbench",
    blurb: "Three-pane, mirrored — accounts on the right, under your mouse hand, register on the left.",
    structure: "three-pane",
  },
  {
    id: "wide",
    label: "Wide",
    blurb: "Edge to edge. No margins, no card frames, tables the full width of the screen.",
    structure: "sidebar",
  },
];

export function lookById(id: string): Look {
  return LOOKS.find((l) => l.id === id) ?? LOOKS[0];
}

export function readLook(): string {
  try {
    const v = window.localStorage.getItem(KEY);
    if (v && LOOKS.some((l) => l.id === v)) return v;
  } catch {
    /* fall through to the default */
  }
  return DEFAULT_LOOK;
}

export function saveLook(id: string): void {
  try {
    window.localStorage.setItem(KEY, id);
  } catch {
    /* not remembered, still applied */
  }
}

/** Put the look on the document (or on a preview element). */
export function applyLook(id: string, el: HTMLElement = document.documentElement): void {
  const look = lookById(id);
  // `classic` sets the attribute too rather than clearing it, so a rule can
  // say `[data-look="classic"]` and mean it — a look that is the absence of
  // an attribute is a look no stylesheet can name.
  el.setAttribute("data-look", look.id);
  el.setAttribute("data-structure", look.structure);
}

/** The structure a look arranges the chrome as. */
export function structureOf(id: string): Structure {
  return lookById(id).structure;
}
