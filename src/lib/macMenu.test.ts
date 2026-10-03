// The Mac menu bar is built from the same table as the in-window one; these
// prove what changes on the way and that nothing is lost.
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/menu", () => ({}));
vi.mock("./commands", () => ({ isCommandAvailable: () => true, runCommand: vi.fn(() => true) }));

import { actionsOf, macMenuModel, macShortcut, nativeAccel, signature, type Flat } from "./macMenu";
import { buildMenus } from "./menus";
import { keys } from "./keys";

const data = {
  favoriteAccounts: [{ id: "a", name: "Checking" }],
  savedReports: [],
  openAccount: () => {},
  openReport: () => {},
  recentFiles: [],
  openFile: () => {},
  undoLabel: "delete a transaction",
  redoLabel: null,
  forgetMissingFiles: () => {},
};

const labels = (f: Flat[]) => f.map((x) => (x.kind === "native" ? `[${x.native}]` : x.kind === "sep" ? "—" : x.label));

describe("the Mac menu", () => {
  const model = macMenuModel(buildMenus(data));
  const sub = (name: string) => model.find((m) => m.label === name)!.items!;

  it("has an app menu first, Window before Help, and Help last", () => {
    expect(model.map((m) => m.label)).toEqual(["T-Money", "File", "Edit", "Favorites", "Tools", "Window", "Help"]);
    expect(labels(sub("T-Money"))).toEqual(["About T-Money", "—", "Settings…", "—", "[Hide]", "[HideOthers]", "[ShowAll]", "—", "Quit T-Money"]);
    const app = sub("T-Money");
    expect(app.find((i) => i.label === "Settings…")!.accel).toBe("CmdOrCtrl+,");
    expect(app.find((i) => i.label === "Quit T-Money")!.accel).toBe("CmdOrCtrl+Q");
  });

  it("moves Exit, Settings and About to the app menu instead of showing them twice", () => {
    const all = JSON.stringify(model.slice(1).map((m) => labels(m.items!)));
    expect(all).not.toContain("Exit");
    expect(all).not.toContain("Settings…");
    expect(all).not.toContain("About T-Money");
  });

  it("uses the system's Cut, Copy, Paste and Select All, and ⇧⌘Z for Redo", () => {
    const edit = sub("Edit");
    expect(labels(edit).slice(0, 7)).toEqual([
      "Undo delete a transaction",
      "Redo",
      "—",
      "[Cut]",
      "[Copy]",
      "[Paste]",
      "[SelectAll]",
    ]);
    expect(edit[0].accel).toBe("CmdOrCtrl+Z");
    expect(edit[1].accel).toBe("CmdOrCtrl+Shift+Z");
  });

  it("never puts a shortcut with no modifier on the menu", () => {
    const del = sub("Edit").find((i) => i.label === "Delete transaction")!;
    expect(del.accel).toBeUndefined();
    const help = sub("Help").find((i) => i.label === "T-Money Help")!;
    expect(help.accel).toBeUndefined();
    expect(nativeAccel("Ctrl+N")).toBe("CmdOrCtrl+N");
    expect(nativeAccel("Alt+F4")).toBeUndefined();
    expect(nativeAccel("Del")).toBeUndefined();
  });

  it("keeps the live parts: favorite accounts are listed", () => {
    const fav = sub("Favorites").find((i) => i.label === "Favorite accounts")!;
    expect(labels(fav.items!)).toEqual(["Checking"]);
  });

  it("runs the latest callbacks even when the menu looks the same", () => {
    const first = vi.fn();
    const second = vi.fn();
    const withFile = (open: () => void) =>
      macMenuModel(buildMenus({ ...data, recentFiles: [{ path: "/m/a.tmny", name: "a", exists: true }], openFile: open }));
    const a = withFile(first);
    const b = withFile(second);
    expect(signature(a)).toBe(signature(b));
    // The same place in the menu, the newer callback.
    const fileIdx = b.findIndex((m) => m.label === "File");
    const recentIdx = b[fileIdx].items!.findIndex((i) => i.label === "Recent files");
    actionsOf(b).get(`${fileIdx}.${recentIdx}.0`)!();
    expect(second).toHaveBeenCalledWith("/m/a.tmny");
    expect(first).not.toHaveBeenCalled();
  });

  it("is rebuilt only when what it shows changes", () => {
    expect(signature(macMenuModel(buildMenus(data)))).toBe(signature(model));
    expect(signature(macMenuModel(buildMenus({ ...data, redoLabel: "edit a payee" })))).not.toBe(signature(model));
  });
});

describe("shortcuts written for the keyboard in front of you", () => {
  it("are ⌘ on a Mac and unchanged elsewhere", () => {
    expect(macShortcut("Ctrl+N")).toBe("⌘N");
    expect(macShortcut("Ctrl+Shift+Z")).toBe("⇧⌘Z");
    const text = "**Ctrl+Z** undoes; **Ctrl+Y** redoes; **Alt+F4** closes; Ctrl+M clears.";
    expect(keys(text, "mac")).toBe("**⌘Z** undoes; **⇧⌘Z** redoes; **⌘Q** closes; ⌘M clears.");
    expect(keys(text, "windows")).toBe(text);
    expect(keys(text, "linux")).toBe(text);
  });
});
