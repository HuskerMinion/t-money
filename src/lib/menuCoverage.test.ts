// §102 — which menu items still have no owner.
//
// §97's promise is that a dead menu item is impossible by construction: the
// registry decides, so an unserved item grays out rather than lying. That is
// true, and it is not the whole job — an item that is grayed out EVERYWHERE
// is a feature nobody can reach, and there were fourteen of those.
//
// This test does not assert that every command is served; that would need the
// whole app mounted in every state. It asserts the list of commands with no
// owner anywhere in the source is the one we have looked at and decided about.
// A new menu item with no registrar fails here on the day it is added, rather
// than being discovered by a user hovering a permanently gray row.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildMenus, menuLeaves } from "./menus";

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const code = sources("src")
  .map((p) => readFileSync(p, "utf8"))
  .join("\n");

const commands = menuLeaves(
  buildMenus({
    favoriteAccounts: [],
    savedReports: [],
    undoLabel: null,
    redoLabel: null,
    recentFiles: [],
    openFile: vi.fn(),
    forgetMissingFiles: vi.fn(),
    openAccount: vi.fn(),
    openReport: vi.fn(),
  })
)
  .map((l) => l.command)
  .filter((c): c is string => !!c);

/** Named, not silently tolerated. Each of these is a decision with a reason,
 *  and the list is meant to shrink.
 *
 *  §106 emptied it. `edit.replace` was the last entry: Money's Find and
 *  Replace was a bulk editor over any field, and promising it in the Edit
 *  menu while nothing served it made the menu carry a permanently gray lie.
 *  What T-Money actually has — the payee rules, run backwards over the file,
 *  with a preview and one undo step — went into Tools under its own name, and
 *  the item that overpromised was removed. An empty list is the point. */
const PENDING: string[] = [];

describe("every menu item has an owner (§102)", () => {
  it("nothing in the menus is unreachable from every screen", () => {
    const orphans = commands
      .filter((c) => !PENDING.includes(c))
      .filter((c) => !new RegExp(`useCommand\\(\\s*"${c.replace(/\./g, "\\.")}"`).test(code));
    expect(orphans, `menu items nothing registers: ${orphans.join(", ")}`).toEqual([]);
  });

  it("and every registration names an item that exists in a menu", () => {
    // The other direction: a command registered under a typo'd id is a
    // handler that can never run, and nothing else would ever notice.
    const registered = [...code.matchAll(/useCommand\("([^"]+)"/g)].map((m) => m[1]);
    const unknown = [...new Set(registered)].filter((c) => !commands.includes(c));
    expect(unknown, `registered but in no menu: ${unknown.join(", ")}`).toEqual([]);
  });
});
