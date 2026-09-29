import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  availableCommands,
  isCommandAvailable,
  onAvailabilityChange,
  registerCommand,
  resetCommands,
  runCommand,
} from "./commands";
import { accelMatches, ariaKeys, buildMenus, menuLeaves } from "./menus";
import { HELP_TOPICS } from "../help/topics";

beforeEach(() => resetCommands());

describe("the command registry", () => {
  it("a command is available exactly while something offers it", () => {
    expect(isCommandAvailable("file.print")).toBe(false);
    const off = registerCommand("file.print", () => {});
    expect(isCommandAvailable("file.print")).toBe(true);
    off();
    expect(isCommandAvailable("file.print")).toBe(false);
  });

  it("running an unserved command does nothing and says so", () => {
    // The menu grays these out, but a keyboard shortcut can still arrive —
    // and must not throw, and must not swallow the keystroke.
    expect(runCommand("file.print")).toBe(false);
  });

  it("the highest priority serves it, so a dialog beats the screen behind it", () => {
    const screen = vi.fn();
    const dialog = vi.fn();
    registerCommand("edit.delete", screen, 0);
    const closeDialog = registerCommand("edit.delete", dialog, 10);
    runCommand("edit.delete");
    expect(dialog).toHaveBeenCalledTimes(1);
    expect(screen).not.toHaveBeenCalled();
    // Close the dialog and the screen has it back.
    closeDialog();
    runCommand("edit.delete");
    expect(screen).toHaveBeenCalledTimes(1);
  });

  it("unregistering one of two leaves the command available", () => {
    const a = registerCommand("file.print", () => {});
    registerCommand("file.print", () => {});
    a();
    expect(isCommandAvailable("file.print")).toBe(true);
  });

  it("tells the menu when availability changes, so it can re-gray", () => {
    const seen = vi.fn();
    const stop = onAvailabilityChange(seen);
    const off = registerCommand("x", () => {});
    expect(seen).toHaveBeenCalledTimes(1);
    off();
    expect(seen).toHaveBeenCalledTimes(2);
    stop();
    registerCommand("y", () => {});
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("lists what is available, for tests and for asking the app what it can do", () => {
    registerCommand("b", () => {});
    registerCommand("a", () => {});
    expect(availableCommands()).toEqual(["a", "b"]);
  });

  it("a failing async command is caught and named, not left unhandled", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    registerCommand("file.export", () => Promise.reject(new Error("disk full")));
    expect(runCommand("file.export")).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(err).toHaveBeenCalledWith('command "file.export" failed:', expect.any(Error));
    err.mockRestore();
  });
});

const openFile = vi.fn();
const forgetMissingFiles = vi.fn();

describe("the menu's contents", () => {
  const menus = buildMenus({
    favoriteAccounts: [{ id: "a1", name: "Everyday Checking" }],
    savedReports: [{ id: "r1", name: "By Category - Sam" }],
    undoLabel: null,
    redoLabel: null,
    recentFiles: [{ path: "E:\\Money\\Sam.tmny", name: "Sam", exists: true }],
    openFile,
    forgetMissingFiles,
    openAccount: vi.fn(),
    openReport: vi.fn(),
  });

  it("keeps Money's five menus in Money's order", () => {
    expect(menus.map((m) => m.label)).toEqual(["File", "Edit", "Favorites", "Tools", "Help"]);
  });

  it("gives every menu a distinct Alt letter", () => {
    const ms = menus.map((m) => m.mnemonic);
    expect(new Set(ms).size).toBe(ms.length);
  });

  // The underline is drawn at the mnemonic's place in the label, so a
  // letter the label does not contain would underline nothing and leave the
  // Alt key a secret. One lower-case letter, so `e.key.toLowerCase()` in the
  // menu bar can match it.
  it("gives every menu a single lower-case Alt letter that appears in its label", () => {
    for (const m of menus) {
      expect(m.mnemonic, m.label).toMatch(/^[a-z]$/);
      expect(m.label.toLowerCase(), `${m.label} does not contain its Alt letter "${m.mnemonic}"`).toContain(m.mnemonic);
    }
  });

  it("every leaf either names a command or carries its own action", () => {
    // A leaf with neither is a dead item — the exact thing this design is
    // meant to make impossible.
    for (const leaf of menuLeaves(menus)) {
      expect(leaf.command ?? leaf.run ?? leaf.disabled, `"${leaf.label}" does nothing`).toBeTruthy();
    }
  });

  it("names no command twice, so one item cannot shadow another", () => {
    const ids = menuLeaves(menus)
      .map((l) => l.command)
      .filter(Boolean) as string[];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("builds the favorites submenus from live data", () => {
    const fav = menus.find((m) => m.label === "Favorites")!;
    const accounts = fav.items.find((i) => i.label === "Favorite accounts")!;
    expect(typeof accounts.items).toBe("function");
    expect((accounts.items as () => { label: string }[])().map((i) => i.label)).toEqual(["Everyday Checking"]);
    const reports = fav.items.find((i) => i.label === "Favorite reports")!;
    expect((reports.items as () => { label: string }[])().map((i) => i.label)).toEqual(["By Category - Sam"]);
  });

  it("says so rather than showing an empty submenu", () => {
    const empty = buildMenus({
      favoriteAccounts: [],
      savedReports: [],
      undoLabel: null,
      redoLabel: null,
      recentFiles: [],
      openFile,
      forgetMissingFiles,
      openAccount: vi.fn(),
      openReport: vi.fn(),
    });
    const fav = empty.find((m) => m.label === "Favorites")!;
    const accounts = fav.items.find((i) => i.label === "Favorite accounts")!;
    const items = (accounts.items as () => { label: string; disabled?: boolean }[])();
    expect(items).toEqual([{ label: "(none starred yet)", disabled: true }]);
  });
});

describe("accelerators are read off the label they print", () => {
  const ev = (init: Partial<KeyboardEvent> & { key: string }) =>
    ({ ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...init }) as KeyboardEvent;

  it("matches the modifier set exactly", () => {
    expect(accelMatches("Ctrl+P", ev({ key: "p", ctrlKey: true }))).toBe(true);
    expect(accelMatches("Ctrl+P", ev({ key: "p" }))).toBe(false);
    expect(accelMatches("Ctrl+P", ev({ key: "p", ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(accelMatches("Ctrl+P", ev({ key: "P", ctrlKey: true }))).toBe(true);
  });

  it("handles the ones that are not a single letter", () => {
    expect(accelMatches("F1", ev({ key: "F1" }))).toBe(true);
    expect(accelMatches("Del", ev({ key: "Delete" }))).toBe(true);
    expect(accelMatches("Alt+F4", ev({ key: "F4", altKey: true }))).toBe(true);
  });

  it("a bare accelerator refuses Ctrl or Cmd, and Cmd stands in for Ctrl", () => {
    // Ctrl+Delete in a field deletes a word; it must not reach "Del", which
    // deletes the selected transaction.
    expect(accelMatches("Del", ev({ key: "Delete", ctrlKey: true }))).toBe(false);
    expect(accelMatches("Del", ev({ key: "Delete", metaKey: true }))).toBe(false);
    expect(accelMatches("F1", ev({ key: "F1", ctrlKey: true }))).toBe(false);
    expect(accelMatches("Ctrl+P", ev({ key: "p", metaKey: true }))).toBe(true);
  });

  it("every printed accelerator can actually be matched", () => {
    // A label saying Ctrl+Q that no key event can satisfy is a lie printed in
    // the menu forever, so each one is checked against a synthesized press.
    for (const leaf of menuLeaves(menus_for_accel).filter((l) => l.accel)) {
      const parts = leaf.accel!.split("+");
      const key = parts[parts.length - 1];
      const e = ev({
        key: key === "Del" ? "Delete" : key,
        ctrlKey: parts.includes("Ctrl"),
        altKey: parts.includes("Alt"),
        shiftKey: parts.includes("Shift"),
      });
      expect(accelMatches(leaf.accel!, e), `${leaf.label} (${leaf.accel})`).toBe(true);
    }
  });
});

const menus_for_accel = buildMenus({
  favoriteAccounts: [],
  savedReports: [],
  undoLabel: null,
  redoLabel: null,
    recentFiles: [{ path: "E:\\Money\\Sam.tmny", name: "Sam", exists: true }],
    openFile,
    forgetMissingFiles,
  openAccount: () => {},
  openReport: () => {},
});

describe("Recent files in the File menu", () => {
  const recents = () =>
    buildMenus({
      favoriteAccounts: [],
      savedReports: [],
      undoLabel: null,
      redoLabel: null,
      recentFiles: [
        { path: "E:\\Money\\Sam.tmny", name: "Sam", exists: true },
        { path: "E:\\Money\\Jordan.tmny", name: "Jordan", exists: false },
      ],
      openFile,
      forgetMissingFiles,
      openAccount: vi.fn(),
      openReport: vi.fn(),
    })
      .find((m) => m.label === "File")!
      .items.find((i) => i.label === "Recent files")!;

  it("numbers them and opens the one chosen", () => {
    const items = (recents().items as () => { label: string; run?: () => void }[])();
    expect(items[0].label).toBe("1  Sam");
    openFile.mockClear();
    items[0].run!();
    expect(openFile).toHaveBeenCalledWith("E:\\Money\\Sam.tmny");
  });

  it("keeps a file that has gone missing, says so, and will not open it", () => {
    // Dropping the entry would leave the user with no idea the file was ever
    // there — which is the one thing this list is uniquely able to tell them.
    const items = (recents().items as () => { label: string; disabled?: boolean }[])();
    expect(items[1].label).toContain("Jordan");
    expect(items[1].label).toContain("(missing)");
    expect(items[1].disabled).toBe(true);
  });

  it("says so rather than opening onto nothing", () => {
    const empty = buildMenus({
      favoriteAccounts: [],
      savedReports: [],
      undoLabel: null,
      redoLabel: null,
      recentFiles: [],
      openFile,
      forgetMissingFiles,
      openAccount: vi.fn(),
      openReport: vi.fn(),
    })
      .find((m) => m.label === "File")!
      .items.find((i) => i.label === "Recent files")!;
    expect((empty.items as () => { label: string }[])()).toEqual([{ label: "(nothing yet)", disabled: true }]);
  });
});

// The menu prints Windows spellings and announces ARIA ones.
describe("ariaKeys", () => {
  it("translates the printed shortcut into the names ARIA defines", () => {
    expect(ariaKeys("Ctrl+M")).toBe("Control+M");
    expect(ariaKeys("Ctrl+Shift+P")).toBe("Control+Shift+P");
    expect(ariaKeys("Del")).toBe("Delete");
    expect(ariaKeys("Alt+F4")).toBe("Alt+F4");
    expect(ariaKeys("F1")).toBe("F1");
  });

  it("every accelerator in the menus survives the translation", () => {
    // A key name that comes out empty or lowercase is announced wrongly, and
    // nobody sighted would ever notice.
    const all = buildMenus({
      favoriteAccounts: [],
      savedReports: [],
      undoLabel: null,
      redoLabel: null,
      recentFiles: [],
      openFile: vi.fn(),
      forgetMissingFiles: vi.fn(),
      openAccount: vi.fn(),
      openReport: vi.fn(),
    });
    for (const leaf of menuLeaves(all)) {
      if (!leaf.accel) continue;
      const aria = ariaKeys(leaf.accel);
      expect(aria.length, leaf.accel).toBeGreaterThan(0);
      expect(aria, leaf.accel).not.toMatch(/\bctrl\b|\bdel\b/i);
    }
  });
});

// "anything that has a keyboard shortcut should show it".
//
// Two places print shortcuts: the menu item itself, and Help → Keyboard
// shortcuts. The menu table is the single source, so the risk is the help
// page falling behind it — which is exactly what happened to Ctrl+M, bound
// in the register with a private listener and printed in neither.
describe("the shortcuts help page", () => {
  const shortcuts = HELP_TOPICS.find((t) => t.id === "shortcuts")!;

  it("lists every accelerator the menus bind", () => {
    const menus = buildMenus({
      favoriteAccounts: [],
      savedReports: [],
      undoLabel: null,
      redoLabel: null,
      recentFiles: [],
      openFile: vi.fn(),
      forgetMissingFiles: vi.fn(),
      openAccount: vi.fn(),
      openReport: vi.fn(),
    });
    const missing = menuLeaves(menus)
      .map((l) => l.accel)
      .filter((a): a is string => !!a)
      .filter((a) => !shortcuts.body.includes(a));
    expect(missing, `not in Help → Keyboard shortcuts: ${missing.join(", ")}`).toEqual([]);
  });
});

describe("An argument rides along", () => {
  it("hands runCommand's argument to the handler that serves it", () => {
    const seen: unknown[] = [];
    const off = registerCommand("import.tsp", (arg) => {
      seen.push(arg);
    });
    expect(runCommand("import.tsp", "E:/Downloads/tsp.csv")).toBe(true);
    expect(runCommand("import.tsp")).toBe(true);
    expect(seen).toEqual(["E:/Downloads/tsp.csv", undefined]);
    off();
  });
});
