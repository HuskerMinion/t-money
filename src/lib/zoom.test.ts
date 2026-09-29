// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const setZoom = vi.fn(async () => {});
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setZoom }) }));

import { DEFAULT_ZOOM, ZOOM_LEVELS, applyZoom, readZoom, saveZoom } from "./zoom";

describe("text size", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setZoom.mockClear();
  });

  it("defaults to a size up from Money's, and the default is one of the offered levels", () => {
    expect(readZoom()).toBe(DEFAULT_ZOOM);
    expect(DEFAULT_ZOOM).toBeGreaterThan(1);
    expect(ZOOM_LEVELS.some((l) => l.value === DEFAULT_ZOOM)).toBe(true);
  });

  it("remembers the choice and ignores nonsense", () => {
    saveZoom(1.4);
    expect(readZoom()).toBe(1.4);
    window.localStorage.setItem("tm.zoom", "banana");
    expect(readZoom()).toBe(DEFAULT_ZOOM);
    window.localStorage.setItem("tm.zoom", "9");
    expect(readZoom()).toBe(DEFAULT_ZOOM);
  });

  it("zooms the webview", async () => {
    await applyZoom(1.25);
    expect(setZoom).toHaveBeenCalledWith(1.25);
  });
});
