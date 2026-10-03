// The Mac menu bar.
//
// On Windows and Linux the menu is drawn inside the window, Money-style. A Mac
// has one menu bar, at the top of the screen, and an app that draws a second
// one inside its window looks like a port. So on macOS the same table
// `menus.ts` builds becomes the native menu, and the in-window bar is hidden.
// Every item runs the same registry command and grays out the same way: one
// table, so the two cannot drift.
//
// What changes on the way, because Mac users expect it:
//   - A "T-Money" app menu first: About, Settings… ⌘, , Hide, Quit ⌘Q.
//     File → Exit becomes Quit there.
//   - Cut, Copy, Paste and Select All are the system's own items, so text
//     fields behave as in every other Mac app.
//   - Redo is ⇧⌘Z.
//   - A shortcut with no modifier (Del, F1) is not put on the menu: a menu
//     shortcut fires before the page sees the key, and Delete would stop
//     working in text fields. The page's own handler still serves them.
//   - Undo and Redo inside a text field take back the typing, as the
//     in-window menu's handler does, not a saved transaction.
import { Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import { isCommandAvailable, runCommand, type CommandId } from "./commands";
import type { Menu as TmMenu, MenuItem as TmItem } from "./menus";

/** One evaluated entry: what the native menu shows, for comparing builds. */
export interface Flat {
  kind: "item" | "sub" | "sep" | "native";
  label?: string;
  accel?: string;
  enabled?: boolean;
  native?: string;
  items?: Flat[];
  run?: () => void;
}

/** "Ctrl+Shift+Z" → "CmdOrCtrl+Shift+Z"; a shortcut with no modifier → none. */
export function nativeAccel(accel: string | undefined): string | undefined {
  if (!accel) return undefined;
  const parts = accel.split("+").map((p) => p.trim());
  if (!parts.some((p) => /^(ctrl|alt|shift)$/i.test(p)) || parts.length < 2) return undefined;
  if (!parts.some((p) => /^ctrl$/i.test(p))) return undefined; // Alt+F4 and the like: Windows-only
  return parts.map((p) => (/^ctrl$/i.test(p) ? "CmdOrCtrl" : p)).join("+");
}

/** The shortcut as a Mac shows it: ⌘N, ⇧⌘Z, ⌥⌘P. */
export function macShortcut(accel: string): string {
  const parts = accel.split("+").map((p) => p.trim());
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1).map((p) => p.toLowerCase());
  return (
    (mods.includes("alt") ? "⌥" : "") +
    (mods.includes("shift") ? "⇧" : "") +
    (mods.includes("ctrl") ? "⌘" : "") +
    (key.toLowerCase() === "del" ? "⌫" : key.length === 1 ? key.toUpperCase() : key)
  );
}

function fieldFocused(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

function itemsOf(i: TmItem): TmItem[] {
  return typeof i.items === "function" ? i.items() : (i.items ?? []);
}

function leaf(i: TmItem, override?: Partial<Flat>): Flat {
  const command = i.command;
  return {
    kind: "item",
    label: i.label,
    accel: nativeAccel(i.accel),
    enabled: !i.disabled && (i.run ? true : command ? isCommandAvailable(command) : false),
    run: i.run ?? (command ? () => void runCommand(command) : undefined),
    ...override,
  };
}

function flatten(items: TmItem[]): Flat[] {
  const out: Flat[] = [];
  for (const i of items) {
    if (i.separatorBefore && out.length) out.push({ kind: "sep" });
    if (i.items) out.push({ kind: "sub", label: i.label, items: flatten(itemsOf(i)) });
    else out.push(leaf(i));
  }
  return out;
}

const SYSTEM_EDIT: Record<string, string> = { "edit.cut": "Cut", "edit.copy": "Copy", "edit.paste": "Paste" };

/** The whole Mac menu, evaluated now, from T-Money's own menus. */
export function macMenuModel(menus: TmMenu[]): Flat[] {
  const find = (c: CommandId) => {
    for (const m of menus) for (const i of m.items) if (i.command === c) return i;
    return undefined;
  };
  const about = find("help.about");
  const settings = find("tools.settings");
  const appMenu: Flat = {
    kind: "sub",
    label: "T-Money",
    items: [
      ...(about ? [leaf(about)] : []),
      { kind: "sep" },
      ...(settings ? [leaf(settings, { accel: "CmdOrCtrl+," })] : []),
      { kind: "sep" },
      { kind: "native", native: "Hide" },
      { kind: "native", native: "HideOthers" },
      { kind: "native", native: "ShowAll" },
      { kind: "sep" },
      { kind: "item", label: "Quit T-Money", accel: "CmdOrCtrl+Q", enabled: true, run: () => void runCommand("file.exit") },
    ],
  };

  const rest: Flat[] = menus.map((m) => {
    let items = m.items;
    if (m.label === "File") items = items.filter((i) => i.command !== "file.exit");
    if (m.label === "Tools") items = items.filter((i) => i.command !== "tools.settings");
    if (m.label === "Help") items = items.filter((i) => i.command !== "help.about");
    let flat = flatten(items);
    if (m.label === "Edit") {
      flat = flat.flatMap((f): Flat[] => {
        const src = items.find((i) => i.label === f.label);
        const c = src?.command;
        if (c && SYSTEM_EDIT[c]) {
          return c === "edit.paste"
            ? [{ kind: "native", native: "Paste" }, { kind: "native", native: "SelectAll" }]
            : [{ kind: "native", native: SYSTEM_EDIT[c] }];
        }
        if (c === "edit.undo" || c === "edit.redo") {
          const which = c === "edit.undo" ? "undo" : "redo";
          return [
            {
              ...f,
              accel: c === "edit.redo" ? "CmdOrCtrl+Shift+Z" : f.accel,
              // In a text field the shortcut takes back the typing; the
              // menu item then has to be usable for that too.
              enabled: true,
              run: () => {
                if (fieldFocused()) document.execCommand(which);
                else void runCommand(c);
              },
            },
          ];
        }
        return [f];
      });
    }
    return { kind: "sub", label: m.label, items: flat };
  });

  const windowMenu: Flat = {
    kind: "sub",
    label: "Window",
    items: [{ kind: "native", native: "Maximize" }, { kind: "native", native: "Fullscreen" }],
  };
  // Help stays last, as on every Mac.
  const help = rest.filter((m) => m.label === "Help");
  const others = rest.filter((m) => m.label !== "Help");
  return [appMenu, ...others, windowMenu, ...help];
}

/** What a model looks like without its functions, to tell builds apart. */
export function signature(model: Flat[]): string {
  return JSON.stringify(model, (k, v) => (k === "run" ? undefined : v));
}

/** What each native item does, by its place in the menu ("2.0.3"). Refreshed
 *  on every call, so an item runs the CURRENT callback (the recent files of
 *  this render, not of the render that last rebuilt the menu) even when
 *  nothing visible changed and the native menu is left as it is. */
let actions = new Map<string, () => void>();

export function actionsOf(model: Flat[], prefix = "", into = new Map<string, () => void>()): Map<string, () => void> {
  model.forEach((f, i) => {
    const id = prefix ? `${prefix}.${i}` : String(i);
    if (f.kind === "sub") actionsOf(f.items ?? [], id, into);
    else if (f.kind === "item" && f.run) into.set(id, f.run);
  });
  return into;
}

async function realize(f: Flat, id: string): Promise<MenuItem | Submenu | PredefinedMenuItem> {
  switch (f.kind) {
    case "sep":
      return PredefinedMenuItem.new({ item: "Separator" });
    case "native":
      return PredefinedMenuItem.new({ item: f.native as "Copy" });
    case "sub": {
      const items = await Promise.all((f.items ?? []).map((c, i) => realize(c, `${id}.${i}`)));
      return Submenu.new({ text: f.label ?? "", items: items as never[] });
    }
    default:
      return MenuItem.new({ text: f.label ?? "", accelerator: f.accel, enabled: f.enabled, action: () => actions.get(id)?.() });
  }
}

let current: Menu | null = null;
let lastSig = "";
let queue: Promise<void> = Promise.resolve();

/** Make the menu the app's menu. The actions are taken now; the native
 *  menu is rebuilt only when what it shows changed, one build at a time and
 *  in order, and a build that fails is tried again next time. */
export function applyMacMenu(menus: TmMenu[]): Promise<void> {
  const model = macMenuModel(menus);
  actions = actionsOf(model);
  const sig = signature(model);
  queue = queue
    .then(async () => {
      if (sig === lastSig) return;
      const items = await Promise.all(model.map((f, i) => realize(f, String(i))));
      const menu = await Menu.new({ items: items as never[] });
      await menu.setAsAppMenu();
      lastSig = sig;
      const old = current;
      current = menu;
      await old?.close().catch(() => {});
    })
    .catch(() => {});
  return queue;
}
