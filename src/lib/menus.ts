// The menu bar's contents.
//
// Modeled on MS Money Plus (File, Edit, Favorites, Tools, Help) and kept in
// that order, because muscle memory is the whole reason to have a menu bar in
// 2026. Where Money had something T-Money does not, the entry is left out
// rather than grayed out forever: Convert Quicken File, Print Checks, Money
// Solution Center, Favorite Web Sites, Internet Updates and the recent-file
// list all describe a world this app does not live in.
//
// Where T-Money has something Money did not, it goes in the menu Money would
// have put it in. Verify this file is a File command. Find duplicates and the
// payee rename rules are Tools, next to Find and Replace, which is what they
// are a specialized form of.
//
// NOTHING HERE MAKES A COMMAND EXIST. Every leaf names a command id; the
// registry in `commands.ts` decides whether anything can serve it right now,
// and the menu grays out the rest. So this file can name Print without
// knowing that the register is what prints, and Print is automatically
// unavailable everywhere else.
import type { CommandId } from "./commands";

export interface MenuItem {
  label: string;
  /** The registry command this runs. Absent on a submenu parent. */
  command?: CommandId;
  /** A dynamic leaf — Favorites builds these from live data, so they carry
   *  their own action rather than a registry id. */
  run?: () => void;
  /** Shown right-aligned. Display only: the shortcut itself is bound in
   *  `useMenuAccelerators`, from this same table, so the two cannot drift. */
  accel?: string;
  /** A rule above this item. */
  separatorBefore?: boolean;
  /** A submenu. A function is evaluated when the menu opens, which is how
   *  Favorite Accounts lists the accounts you have starred today. */
  items?: MenuItem[] | (() => MenuItem[]);
  /** Force the item unavailable regardless of the registry — used for a
   *  submenu that turned out to have nothing in it. */
  disabled?: boolean;
}

export interface Menu {
  label: string;
  /** The letter Alt opens it with, and the one underlined in the label. */
  mnemonic: string;
  items: MenuItem[];
}

/** Dynamic parts the shell supplies when it builds the menus. */
export interface MenuData {
  favoriteAccounts: { id: string; name: string }[];
  savedReports: { id: string; name: string }[];
  openAccount: (id: string) => void;
  openReport: (id: string) => void;
  /** The last few T-Money files, newest first. A missing one is shown
   *  struck through rather than hidden. */
  recentFiles: { path: string; name: string; exists: boolean }[];
  openFile: (path: string) => void;
  /** What undo and redo would do, in the backend's own words
   *  ("delete a transaction"), or null when that side of the stack is empty.
   *  The label is what makes the item worth reading: "Undo delete a
   *  transaction" tells you what you are about to get back, where a bare
   *  "Undo" after a few minutes of typing is a guess. */
  undoLabel: string | null;
  redoLabel: string | null;
  /** Drop the entries whose files are gone. They are shown until asked
   *  about, never removed behind your back; this is how you ask. */
  forgetMissingFiles: () => void;
}

export function buildMenus(d: MenuData): Menu[] {
  return [
    {
      label: "File",
      mnemonic: "f",
      items: [
        {
          label: "New",
          items: [
            { label: "T-Money file…", command: "file.new" },
            // For handing the app to somebody to try. It can only ever
            // create a new file, never seed one that exists.
            { label: "Sample file with demo data…", command: "file.sample" },
            { label: "Account…", command: "new.account", separatorBefore: true },
            { label: "Transaction", command: "new.transaction", accel: "Ctrl+N" },
            { label: "Category…", command: "new.category" },
            { label: "Classification…", command: "new.classification" },
            { label: "Payee…", command: "new.payee" },
            { label: "Scheduled bill or deposit…", command: "new.recurrence" },
            { label: "Savings goal…", command: "new.goal" },
          ],
        },
        { label: "Open a T-Money file…", command: "file.open", accel: "Ctrl+O", separatorBefore: true },
        // Close closes: no file open, and the start screen. An earlier version had
        // it return to the app's own database instead, which on a machine
        // with the same accounts in both files looked like nothing happening
        // at all.
        { label: "Close file", command: "file.close" },
        {
          label: "Recent files",
          items: () => {
            if (d.recentFiles.length === 0) return [{ label: "(nothing yet)", disabled: true }];
            const items: MenuItem[] = d.recentFiles.map((f, i) => ({
              label: `${i + 1}  ${f.name}${f.exists ? "" : "   (missing)"}`,
              disabled: !f.exists,
              run: () => d.openFile(f.path),
            }));
            if (d.recentFiles.some((f) => !f.exists)) {
              items.push({
                label: "Remove the missing ones from this list",
                separatorBefore: true,
                run: () => d.forgetMissingFiles(),
              });
            }
            return items;
          },
        },
        {
          label: "Import",
          separatorBefore: true,
          items: [
            { label: "Bank or broker file (QIF, OFX, QFX)…", command: "import.qif" },
            { label: "Spreadsheet or CSV…", command: "import.csv" },
            { label: "TSP activity detail (tsp.gov CSV)…", command: "import.tsp" },
            { label: "Prices only…", command: "import.prices" },
          ],
        },
        {
          label: "Export",
          items: [
            { label: "This register to CSV…", command: "export.register.csv" },
            { label: "This register to QIF…", command: "export.register.qif" },
            { label: "This report to CSV…", command: "export.report.csv" },
          ],
        },
        { label: "Back up now", command: "file.backup", separatorBefore: true },
        { label: "Restore from a backup…", command: "file.restore" },
        { label: "Backup settings…", command: "file.backup.settings" },
        { label: "Verify this file…", command: "file.verify", separatorBefore: true },
        { label: "Print…", command: "file.print", accel: "Ctrl+P", separatorBefore: true },
        { label: "Print preview", command: "file.print.preview" },
        { label: "Exit", command: "file.exit", accel: "Alt+F4", separatorBefore: true },
      ],
    },
    {
      label: "Edit",
      mnemonic: "e",
      items: [
        { label: d.undoLabel ? `Undo ${d.undoLabel}` : "Undo", command: "edit.undo", accel: "Ctrl+Z" },
        { label: d.redoLabel ? `Redo ${d.redoLabel}` : "Redo", command: "edit.redo", accel: "Ctrl+Y" },
        { label: "Cut", command: "edit.cut", accel: "Ctrl+X", separatorBefore: true },
        { label: "Copy", command: "edit.copy", accel: "Ctrl+C" },
        { label: "Paste", command: "edit.paste", accel: "Ctrl+V" },
        { label: "Find…", command: "edit.find", accel: "Ctrl+F", separatorBefore: true },
        // "Find and replace…" is gone. Money's version was a bulk
        // editor over any field, and promising it here while nothing served
        // it made the Edit menu carry a permanently gray lie. What T-Money
        // actually has is narrower and more useful: the payee rules, applied
        // backwards over what is already in the file — so it lives in Tools,
        // next to the rules themselves, under its own name.
        { label: "Delete transaction", command: "edit.delete", accel: "Del", separatorBefore: true },
        { label: "Void transaction", command: "edit.void" },
        // Ctrl+M was bound inside the register's grid and printed
        // nowhere, so the shortcut existed and nothing said so. Two rules,
        // both learned from F1 being bound twice: the accelerator is
        // declared HERE, and whoever performs it registers the command rather
        // than listening for the key itself.
        { label: "Mark as cleared", command: "edit.clear", accel: "Ctrl+M" },
        { label: "Balance this account…", command: "edit.reconcile" },
      ],
    },
    {
      label: "Favorites",
      mnemonic: "a",
      items: [
        // Two items rather than one that changes its name, because
        // each can then be grayed honestly: "Add" is dead once the account is
        // starred, "Remove" is dead until it is. Both need an account open,
        // so both gray out everywhere else.
        { label: "Add this account to favorites", command: "fav.add" },
        { label: "Remove this account from favorites", command: "fav.remove" },
        { label: "Organize favorites…", command: "fav.organize" },
        {
          label: "Favorite accounts",
          separatorBefore: true,
          items: () =>
            d.favoriteAccounts.length === 0
              ? [{ label: "(none starred yet)", disabled: true }]
              : d.favoriteAccounts.map((a) => ({ label: a.name, run: () => d.openAccount(a.id) })),
        },
        {
          label: "Favorite reports",
          items: () =>
            d.savedReports.length === 0
              ? [{ label: "(none saved yet)", disabled: true }]
              : d.savedReports.map((r) => ({ label: r.name, run: () => d.openReport(r.id) })),
        },
      ],
    },
    {
      label: "Tools",
      mnemonic: "t",
      items: [
        { label: "Find duplicates…", command: "tools.duplicates" },
        { label: "Payee rename rules…", command: "tools.payee.rules" },
        { label: "Rename payees in existing transactions…", command: "tools.payee.apply" },
        { label: "Categories and payees", command: "tools.categories" },
        { label: "Classifications", command: "tools.classifications" },
        { label: "Update prices", command: "tools.update.prices", separatorBefore: true },
        { label: "Calculator", command: "tools.calculator", accel: "Ctrl+K" },
        { label: "Settings…", command: "tools.settings", separatorBefore: true },
      ],
    },
    {
      label: "Help",
      mnemonic: "h",
      items: [
        { label: "T-Money Help", command: "help.contents", accel: "F1" },
        { label: "Keyboard shortcuts", command: "help.shortcuts" },
        { label: "About T-Money", command: "help.about", separatorBefore: true },
      ],
    },
  ];
}

/** Flatten to every leaf that names a command, for the accelerator binding
 *  and for the test that says the menu names nothing impossible. */
export function menuLeaves(menus: Menu[]): MenuItem[] {
  const out: MenuItem[] = [];
  const walk = (items: MenuItem[]) => {
    for (const it of items) {
      if (typeof it.items === "function") continue; // dynamic: no fixed leaves
      if (it.items) walk(it.items);
      else out.push(it);
    }
  };
  for (const m of menus) walk(m.items);
  return out;
}

/**
 * `"Ctrl+P"` → does this keyboard event match?
 *
 * Written against the label rather than a second table so a shortcut printed
 * in the menu and the shortcut that fires cannot disagree — which is the way
 * this always rots.
 */
/** The same shortcut in the spelling ARIA wants.
 *
 *  The menu PRINTS Money's spelling — "Ctrl+P", "Del", "Alt+F4" — because
 *  that is what a Windows user reads. `aria-keyshortcuts` is not read, it is
 *  announced, and its values are defined by the UI Events key names: Control,
 *  Delete, Alt. Passing the printed form there made screen readers announce a
 *  key that does not exist. One table, two audiences.
 */
export function ariaKeys(accel: string): string {
  const NAMES: Record<string, string> = {
    ctrl: "Control",
    alt: "Alt",
    shift: "Shift",
    del: "Delete",
    esc: "Escape",
    ins: "Insert",
    pgup: "PageUp",
    pgdn: "PageDown",
  };
  return accel
    .split("+")
    .map((p) => p.trim())
    .map((p) => NAMES[p.toLowerCase()] ?? (p.length === 1 ? p.toUpperCase() : p))
    .join("+");
}

export function accelMatches(accel: string, e: KeyboardEvent): boolean {
  const parts = accel.split("+").map((p) => p.trim().toLowerCase());
  const key = parts[parts.length - 1];
  const wantCtrl = parts.includes("ctrl");
  const wantAlt = parts.includes("alt");
  const wantShift = parts.includes("shift");
  // Ctrl or Cmd, either one, counts as "Ctrl". Comparing each to wantCtrl
  // separately let Ctrl+Delete match a bare "Del" — and inside a field, where
  // MenuBar only guards presses with no modifier, that deleted the selected
  // transaction instead of the next word.
  if ((e.ctrlKey || e.metaKey) !== wantCtrl) return false;
  if (e.altKey !== wantAlt) return false;
  if (e.shiftKey !== wantShift) return false;
  const pressed = e.key.toLowerCase();
  if (key === "del") return pressed === "delete";
  return pressed === key;
}
