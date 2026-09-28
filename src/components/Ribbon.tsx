// §99 — the Ribbon look's ribbon.
//
// Office's idea, and a good one: the things you do are named and drawn, in
// groups, where you can see them — rather than remembered, and hunted for in
// a menu. It costs vertical space and buys discoverability, which is the
// trade a menu makes in the other direction.
//
// EVERY BUTTON IS A REGISTRY COMMAND (§97), so the ribbon grays out exactly
// as the menu does: Print is live in a register and dead everywhere else,
// without the ribbon knowing what a register is. A ribbon of buttons that do
// nothing when they do not apply would be worse than the menu it replaces.
//
// > *"on the ribbon the icons need to reflect what they actually are not just
// > color blocks"*
//
// So each one is a real icon from the brand sprite, chosen for what the
// command does. Where the sprite has nothing honest for a command the button
// is text-only rather than wearing an icon that means something else — a
// wrong icon is worse than none, because it is read instead of the label.
//
// §125 — AND IT COLLAPSES.
//
// > *"The Ribbon collaps to an icon strip and expand on a click"*
//
// The ribbon's cost is vertical space, on the screen where vertical space is
// rows of your register. Collapsed, it keeps the big commands as a single
// strip of icons that still RUN — it is a toolbar, not a stub, so the space
// comes back without the actions going with it — and a chevron at the end
// puts the labels back. The choice is remembered: a person who wants their
// rows back wants them back tomorrow too.
import { useState } from "react";
import TmIcon from "./TmIcon";
import { isCommandAvailable, runCommand } from "../lib/commands";
import type { CommandId } from "../lib/commands";
import { useCommandAvailability } from "./MenuBar";

/** Remembered like the look itself is (`tm.look`), in localStorage: it is a
 *  preference about this screen, not something the file should carry to
 *  another machine. Reading it can throw in a locked-down webview, and a
 *  ribbon that will not draw because a preference would not load is a worse
 *  bug than a ribbon that opens expanded. */
const KEY = "tm.ribbon.collapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

interface Item {
  command: CommandId;
  label: string;
  /** A sprite name, or null for text-only. */
  icon: string | null;
}

interface Group {
  name: string;
  /** Drawn large, with the icon above the label. */
  big: Item[];
  /** Stacked small, icon beside the label. */
  small: Item[];
}

const GROUPS: Group[] = [
  {
    name: "Enter",
    big: [
      { command: "new.transaction", label: "New\ntransaction", icon: "add" },
      { command: "new.account", label: "New\naccount", icon: "accounts" },
    ],
    small: [
      { command: "edit.delete", label: "Delete", icon: null },
      { command: "edit.void", label: "Void", icon: null },
      { command: "edit.clear", label: "Mark cleared", icon: null },
    ],
  },
  {
    name: "Balance",
    big: [{ command: "edit.reconcile", label: "Balance\naccount", icon: "calendar" }],
    small: [
      { command: "tools.duplicates", label: "Find duplicates", icon: "filter" },
      { command: "file.verify", label: "Verify this file", icon: "alerts" },
      { command: "tools.payee.rules", label: "Payee rules", icon: null },
    ],
  },
  {
    name: "File",
    big: [
      { command: "import.qif", label: "Import", icon: "sync" },
      { command: "export.register.csv", label: "Export", icon: "export" },
    ],
    small: [
      { command: "file.open", label: "Open a file…", icon: null },
      { command: "file.backup", label: "Back up now", icon: null },
      { command: "file.print", label: "Print…", icon: null },
    ],
  },
  {
    name: "Look at",
    big: [
      { command: "tools.update.prices", label: "Update\nprices", icon: "investments" },
      { command: "tools.categories", label: "Categories", icon: "budgeting" },
      { command: "tools.settings", label: "Settings", icon: "settings" },
    ],
    small: [],
  },
];

function Button({ item, big }: { item: Item; big: boolean }) {
  const on = isCommandAvailable(item.command);
  return (
    <button
      type="button"
      className={`tm-ribbon-btn ${big ? "big" : "small"}${on ? "" : " disabled"}`}
      disabled={!on}
      aria-disabled={!on}
      onClick={() => runCommand(item.command)}
      title={item.label.replace("\n", " ")}
    >
      {item.icon ? <TmIcon name={item.icon} size={big ? 26 : 14} /> : big ? null : <span className="tm-ribbon-dot" />}
      <span>
        {item.label.split("\n").map((line, i) => (
          <span key={i} className="block">
            {line}
          </span>
        ))}
      </span>
    </button>
  );
}

/** §125 — one command in the collapsed strip. The label is the accessible
 *  name and the tooltip rather than text on screen; that is the whole trade
 *  the strip makes, and it is why nothing without an icon appears here. */
function IconButton({ item }: { item: Item }) {
  const on = isCommandAvailable(item.command);
  const name = item.label.replace("\n", " ");
  return (
    <button
      type="button"
      className={`tm-ribbon-btn icon${on ? "" : " disabled"}`}
      disabled={!on}
      aria-disabled={!on}
      aria-label={name}
      title={name}
      onClick={() => runCommand(item.command)}
    >
      <TmIcon name={item.icon ?? ""} size={18} />
    </button>
  );
}

export default function Ribbon() {
  // §183 — subscribed, as the menu bar is. The buttons read the registry
  // while rendering, and nothing re-rendered the ribbon when a screen
  // registered or dropped a command, so Print stayed gray in a register until
  // some unrelated click redrew the shell.
  useCommandAvailability();
  const [collapsed, setCollapsed] = useState(readCollapsed);

  function toggle() {
    setCollapsed((was) => {
      const next = !was;
      try {
        localStorage.setItem(KEY, next ? "1" : "0");
      } catch {
        // Not being able to remember the choice is not a reason to refuse it.
      }
      return next;
    });
  }

  // §127 — the control says what it does.
  //
  // > *"the small ^ on the right is a little too small it should be something
  // > that makes it more intuitive that it collapses the ribbon"*
  //
  // A bare chevron is a shape you have to already know. This is a button with
  // a word on it, drawn like a button, and the word is the accessible name as
  // well as what is on screen — one thing to read, whether you are looking or
  // listening.
  const toggleButton = (
    <button
      type="button"
      className="tm-ribbon-toggle"
      onClick={toggle}
      aria-expanded={!collapsed}
      title={collapsed ? "Show the ribbon's labels again" : "Collapse the ribbon to a strip of icons"}
    >
      <span className="tm-ribbon-toggle-arrow" aria-hidden="true">
        {collapsed ? "\u25bc" : "\u25b2"}
      </span>
      {collapsed ? "Show ribbon" : "Hide ribbon"}
    </button>
  );

  if (collapsed) {
    return (
      <div className="tm-ribbon collapsed" role="toolbar" aria-label="Ribbon">
        {GROUPS.map((g) => (
          <div className="tm-ribbon-group" key={g.name}>
            {/* Only the commands that have an honest icon: the strip has no
                room for a label, so a command that cannot be drawn cannot be
                shown here. They are all one click away again. */}
            {g.big.filter((i) => i.icon).map((i) => (
              <IconButton key={i.command} item={i} />
            ))}
          </div>
        ))}
        {toggleButton}
      </div>
    );
  }

  return (
    <div className="tm-ribbon" role="toolbar" aria-label="Ribbon">
      {GROUPS.map((g) => (
        <div className="tm-ribbon-group" key={g.name}>
          <div className="tm-ribbon-row">
            {g.big.map((i) => (
              <Button key={i.command} item={i} big />
            ))}
            {g.small.length > 0 && (
              <div className="tm-ribbon-stack">
                {g.small.map((i) => (
                  <Button key={i.command} item={i} big={false} />
                ))}
              </div>
            )}
          </div>
          <div className="tm-ribbon-name">{g.name}</div>
        </div>
      ))}
      {toggleButton}
    </div>
  );
}
