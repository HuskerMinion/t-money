// Back and Forward between screens, the way Money's arrows worked.
//
// A PLACE is what the shell needs to put a screen back: the tab, the screen
// inside it, the account whose register it was, the report on screen. Each
// new place is pushed; Back and Forward move along the list, and going
// somewhere new from the middle drops what was ahead, as a browser does.
//
// What counts as somewhere new is the place's KEY. A report re-run for
// another range, or customized, is still that report: its entry is updated
// in place, so Back goes to the screen before it rather than through every
// date you tried. A drill-down is a different report (another kind or a
// narrower scope), so it is a step. The rail highlight (`side`) is carried
// along so it comes back right, but it is not part of the key.
import type { Tab } from "../components/AeroHeader";
import type { ReportSpec } from "../components/ReportViewer";

export interface Place {
  tab: Tab;
  side: string;
  bankingScreen: "list" | "register" | "payees";
  budgetScreen: "budget" | "categories" | "classifications";
  /** The register's account, on Banking's register only. */
  accountId: string | null;
  /** The report on screen, on Reports only; null is the gallery. */
  report: ReportSpec | null;
  helpTopic: string | null;
  searchQuery: string | null;
}

export interface NavHistory {
  entries: Place[];
  index: number;
}

/** Far enough back for anyone; a long session does not grow without end. */
export const MAX_ENTRIES = 50;

export const EMPTY_HISTORY: NavHistory = { entries: [], index: -1 };

/** What makes two places the same screen. */
export function placeKey(p: Place): string {
  const parts: unknown[] = [p.tab];
  if (p.tab === "Banking") parts.push(p.bankingScreen, p.bankingScreen === "register" ? p.accountId : null);
  if (p.tab === "Budget") parts.push(p.budgetScreen);
  if (p.tab === "Help") parts.push(p.helpTopic);
  if (p.tab === "Search") parts.push(p.searchQuery);
  if (p.tab === "Reports") {
    const r = p.report;
    parts.push(
      r && [r.kind, r.categoryIds, r.payeeIds ?? [], r.classValueIds ?? [], r.excludeCategories ?? false, r.taxScope ?? false]
    );
  }
  return JSON.stringify(parts);
}

/** The history with `p` as the current place: the same screen updates its
 *  entry, a new one is pushed and drops anything ahead of it. */
export function record(h: NavHistory, p: Place): NavHistory {
  const here = h.entries[h.index];
  if (here && placeKey(here) === placeKey(p)) {
    const entries = h.entries.slice();
    entries[h.index] = p;
    return { entries, index: h.index };
  }
  const entries = [...h.entries.slice(0, h.index + 1), p].slice(-MAX_ENTRIES);
  return { entries, index: entries.length - 1 };
}

export const canGoBack = (h: NavHistory) => h.index > 0;
export const canGoForward = (h: NavHistory) => h.index >= 0 && h.index < h.entries.length - 1;

/** `by` steps along (-1 Back, +1 Forward), or the same history at an end. */
export function step(h: NavHistory, by: -1 | 1): NavHistory {
  const index = h.index + by;
  if (index < 0 || index >= h.entries.length) return h;
  return { entries: h.entries, index };
}
