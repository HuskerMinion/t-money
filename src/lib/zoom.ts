// Text size (§58). Money's type was small and this app inherited it (11px
// body). Rather than touch every hard-coded size, the whole webview is
// zoomed — the register, dialogs, the portaled combo lists and the charts
// all scale together and nothing has to be re-laid-out. WebView2 keeps the
// zoom until told otherwise; the choice is remembered on this machine and
// re-applied at startup.
import { getCurrentWebview } from "@tauri-apps/api/webview";

export const ZOOM_LEVELS: readonly { value: number; label: string }[] = [
  { value: 1.0, label: "Small (Money's size)" },
  { value: 1.15, label: "Medium" },
  { value: 1.25, label: "Large" },
  { value: 1.4, label: "Larger" },
  { value: 1.6, label: "Largest" },
];

/** The default: about two font sizes up from Money's 11px. */
export const DEFAULT_ZOOM = 1.25;

const KEY = "tm.zoom";

export function readZoom(): number {
  try {
    const raw = window.localStorage.getItem(KEY);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0.5 && n <= 3 ? n : DEFAULT_ZOOM;
  } catch {
    return DEFAULT_ZOOM;
  }
}

export function saveZoom(z: number): void {
  try {
    window.localStorage.setItem(KEY, String(z));
  } catch {
    /* no storage — the zoom just will not be remembered */
  }
}

/** Zooms the webview; quietly does nothing outside Tauri (tests, a browser). */
export async function applyZoom(z: number): Promise<void> {
  try {
    await getCurrentWebview().setZoom(z);
  } catch {
    /* not running under Tauri */
  }
}
