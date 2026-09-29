// The left rail's width. Money's rail is fixed; the user asked for one
// they can drag, because account names and balances did not fit. Kept in
// localStorage — a per-machine screen preference, not something that
// belongs in the encrypted file.
export const RAIL_DEFAULT = 208;
export const RAIL_MIN = 150;
export const RAIL_MAX = 480;
const KEY = "tm.railWidth";

export function clampRail(px: number): number {
  if (!Number.isFinite(px)) return RAIL_DEFAULT;
  return Math.min(RAIL_MAX, Math.max(RAIL_MIN, Math.round(px)));
}

export function loadRailWidth(): number {
  try {
    const raw = window.localStorage?.getItem(KEY);
    return raw ? clampRail(Number(raw)) : RAIL_DEFAULT;
  } catch {
    return RAIL_DEFAULT;
  }
}

export function saveRailWidth(px: number): void {
  try {
    window.localStorage?.setItem(KEY, String(clampRail(px)));
  } catch {
    // A browser that refuses storage just forgets the width; nothing breaks.
  }
}
