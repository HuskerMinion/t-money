// @vitest-environment jsdom
// §97 — the menu bar. The behavior worth locking down is the graying: an
// item nothing can serve must be visibly unavailable and must not fire.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import MenuBar, { useMenuAccelerators } from "./MenuBar";
import type { Menu } from "../lib/menus";
import { registerCommand, resetCommands } from "../lib/commands";
import { buildMenus } from "../lib/menus";

const openAccount = vi.fn();
const openReport = vi.fn();
const openFile = vi.fn();
const forgetMissingFiles = vi.fn();

function menus() {
  return buildMenus({
    favoriteAccounts: [{ id: "a1", name: "Everyday Checking 1234" }],
    savedReports: [{ id: "r1", name: "By Category - Sam" }],
    undoLabel: null,
    redoLabel: null,
    recentFiles: [{ path: "E:\\Money\\Sam.tmny", name: "Sam", exists: true }],
    openFile,
    forgetMissingFiles,
    openAccount,
    openReport,
  });
}

beforeEach(() => {
  resetCommands();
  openAccount.mockClear();
  openReport.mockClear();
});

describe("MenuBar (§97)", () => {
  it("shows Money's five menus and opens one on click", async () => {
    render(<MenuBar menus={menus()} />);
    expect(screen.getByRole("menubar", { name: "Main menu" })).toBeInTheDocument();
    for (const label of ["File", "Edit", "Favorites", "Tools", "Help"]) {
      expect(screen.getByRole("menuitem", { name: label })).toBeInTheDocument();
    }
    await userEvent.click(screen.getByRole("menuitem", { name: "File" }));
    expect(screen.getByRole("menuitem", { name: /Back up now/ })).toBeInTheDocument();
  });

  it("grays out what nothing can do, and runs what something can", async () => {
    const backup = vi.fn();
    registerCommand("file.backup", backup);
    render(<MenuBar menus={menus()} />);
    await userEvent.click(screen.getByRole("menuitem", { name: "File" }));

    // Nothing has registered Verify, so it is disabled and cannot be chosen.
    const verify = screen.getByRole("menuitem", { name: /Verify this file/ });
    expect(verify).toBeDisabled();
    expect(verify).toHaveAttribute("aria-disabled", "true");

    await userEvent.click(screen.getByRole("menuitem", { name: /Back up now/ }));
    expect(backup).toHaveBeenCalledTimes(1);
    // Choosing an item closes the menu.
    expect(screen.queryByRole("menuitem", { name: /Back up now/ })).not.toBeInTheDocument();
  });

  it("grays an item again the moment its owner goes away", async () => {
    const off = registerCommand("file.print", vi.fn());
    const { rerender } = render(<MenuBar menus={menus()} />);
    await userEvent.click(screen.getByRole("menuitem", { name: "File" }));
    expect(screen.getByRole("menuitem", { name: /^Print…/ })).toBeEnabled();

    // The register unmounts — nobody prints any more.
    off();
    rerender(<MenuBar menus={menus()} />);
    expect(screen.getByRole("menuitem", { name: /^Print…/ })).toBeDisabled();
  });

  it("opens a submenu and runs a dynamic favorite", async () => {
    render(<MenuBar menus={menus()} />);
    await userEvent.click(screen.getByRole("menuitem", { name: "Favorites" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Favorite accounts/ }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Everyday Checking 1234" }));
    expect(openAccount).toHaveBeenCalledWith("a1");
  });

  it("slides between menus once one is open, the way a menu bar does", async () => {
    render(<MenuBar menus={menus()} />);
    await userEvent.click(screen.getByRole("menuitem", { name: "File" }));
    await userEvent.hover(screen.getByRole("menuitem", { name: "Tools" }));
    expect(screen.getByRole("menuitem", { name: /Find duplicates/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Back up now/ })).not.toBeInTheDocument();
  });

  it("Escape closes it", async () => {
    render(<MenuBar menus={menus()} />);
    await userEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    // §106: "Find and replace…" was removed — it promised Money's bulk
    // editor and nothing served it. Any item in the Edit menu will do here;
    // the test is about Escape, not about which items exist.
    expect(screen.getByRole("menuitem", { name: /Void transaction/ })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menuitem", { name: /Void transaction/ })).not.toBeInTheDocument();
  });

  it("Alt and the underlined letter opens the right menu", async () => {
    render(<MenuBar menus={menus()} />);
    await userEvent.keyboard("{Alt>}t{/Alt}");
    const panel = screen.getByRole("menu");
    expect(within(panel).getByRole("menuitem", { name: /Settings…/ })).toBeInTheDocument();
  });

  // §186 — "ALT+F gives you File and I see the F on Favorites is underlined."
  it("underlines each menu's own Alt letter — the a in Favorites, not its F", async () => {
    render(<MenuBar menus={menus()} />);
    const underlined = (name: string) =>
      Array.from(screen.getByRole("menuitem", { name }).querySelectorAll("u")).map((u) => u.textContent);
    expect(underlined("Favorites")).toEqual(["a"]);
    expect(screen.getByRole("menuitem", { name: "Favorites" }).textContent).toBe("Favorites");
    for (const [name, letter] of [["File", "F"], ["Edit", "E"], ["Tools", "T"], ["Help", "H"]]) {
      expect(underlined(name), name).toEqual([letter]);
    }

    await userEvent.keyboard("{Alt>}a{/Alt}");
    expect(screen.getByRole("menuitem", { name: "Favorites" })).toHaveAttribute("aria-expanded", "true");
    expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Favorite accounts" })).toBeInTheDocument();
  });
});

// §183 — Ctrl+Z in a field is the field's. It took back the last SAVED change
// instead, so correcting a typo in a memo undid a transaction.
describe("§183 — undo and redo in a field belong to the field", () => {
  function Shell({ m }: { m: Menu[] }) {
    useMenuAccelerators(m);
    return (
      <>
        <MenuBar menus={m} />
        <input aria-label="Memo" />
      </>
    );
  }

  it("Ctrl+Z and Ctrl+Y typed in a field do not reach the database undo; outside one they do", async () => {
    const undo = vi.fn();
    const redo = vi.fn();
    registerCommand("edit.undo", undo);
    registerCommand("edit.redo", redo);
    render(<Shell m={menus()} />);

    await userEvent.click(screen.getByRole("textbox", { name: "Memo" }));
    await userEvent.keyboard("{Control>}z{/Control}{Control>}y{/Control}");
    expect(undo).not.toHaveBeenCalled();
    expect(redo).not.toHaveBeenCalled();

    (document.activeElement as HTMLElement).blur();
    await userEvent.keyboard("{Control>}z{/Control}{Control>}y{/Control}");
    expect(undo).toHaveBeenCalledTimes(1);
    expect(redo).toHaveBeenCalledTimes(1);
  });

  it("Edit → Undo in the menu still works with a field focused", async () => {
    const undo = vi.fn();
    registerCommand("edit.undo", undo);
    render(<Shell m={menus()} />);
    await userEvent.click(screen.getByRole("textbox", { name: "Memo" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /^Undo/ }));
    expect(undo).toHaveBeenCalledTimes(1);
  });
});

// §183 — the header promised a keyboard menu; Alt+F opened one nobody could
// move through.
describe("§183 — the menus work from the keyboard", () => {
  it("Alt+F puts focus on the first item that can run, and the arrows skip gray ones", async () => {
    registerCommand("file.open", vi.fn());
    registerCommand("file.close", vi.fn());
    render(<MenuBar menus={menus()} />);
    await userEvent.keyboard("{Alt>}f{/Alt}");
    // "New" is a submenu, so it is live.
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "New" }));
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: /Open a T-Money file/ }));
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Close file" }));
    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "New" }));
    // Up from the top wraps to the bottom-most live item (Recent files is a submenu).
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Export" }));
  });

  it("Enter runs the focused item and closes the menu", async () => {
    const open = vi.fn();
    registerCommand("file.open", open);
    render(<MenuBar menus={menus()} />);
    await userEvent.keyboard("{Alt>}f{/Alt}{ArrowDown}{Enter}");
    expect(open).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("→ opens a submenu and ← closes it; → on a plain item moves to the next menu", async () => {
    render(<MenuBar menus={menus()} />);
    await userEvent.keyboard("{Alt>}a{/Alt}");
    // Favorites: the three commands are gray, so focus lands on the submenu.
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Favorite accounts" }));
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Everyday Checking 1234" }));
    await userEvent.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Favorite accounts" }));
    expect(screen.queryByRole("menuitem", { name: "Everyday Checking 1234" })).not.toBeInTheDocument();
    await userEvent.keyboard("{ArrowRight}{Enter}");
    expect(openAccount).toHaveBeenCalledWith("a1");
  });

  it("← and → move between menus", async () => {
    registerCommand("tools.settings", vi.fn());
    registerCommand("help.contents", vi.fn());
    render(<MenuBar menus={menus()} />);
    await userEvent.click(screen.getByRole("menuitem", { name: "Tools" }));
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: /Settings…/ }));
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("menuitem", { name: "Help" })).toHaveAttribute("aria-expanded", "true");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: /T-Money Help/ }));
  });

  it("Escape closes the menu and gives focus back to where it was", async () => {
    registerCommand("edit.copy", vi.fn());
    render(
      <>
        <MenuBar menus={menus()} />
        <input aria-label="Memo" />
      </>
    );
    const memo = screen.getByRole("textbox", { name: "Memo" });
    await userEvent.click(memo);
    await userEvent.keyboard("{Alt>}e{/Alt}");
    expect(document.activeElement).not.toBe(memo);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(memo);
  });
});
