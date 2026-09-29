// The menu bar.
//
// Money's five menus, and Money's behavior: click to open, then MOVE across
// the bar and the menus follow the pointer without another click. That one
// detail is most of what makes a menu bar feel like a menu bar rather than
// five dropdowns in a row.
//
// Keyboard: Alt+F / Alt+E / Alt+A / Alt+T / Alt+H open a menu (the underlined
// letter), ← → move between menus, ↑ ↓ move within one, → opens a submenu,
// ← closes it, Enter chooses, Escape closes and hands focus back. An item
// nothing can serve is skipped by the arrow keys as well as grayed, because
// arrowing onto a dead item and pressing Enter is its own small betrayal.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { isCommandAvailable, onAvailabilityChange, runCommand } from "../lib/commands";
import { accelMatches, menuLeaves, type Menu, type MenuItem, ariaKeys } from "../lib/menus";

/** Re-render whenever what the app can do changes. Exported, because
 *  the Ribbon reads the same registry and used to read it only when something
 *  else happened to re-render it, so its buttons stayed gray (or live) until
 *  you clicked somewhere. */
export function useCommandAvailability(): number {
  return useSyncExternalStore(
    (cb) => onAvailabilityChange(cb),
    () => availabilityVersion,
    () => availabilityVersion
  );
}
let availabilityVersion = 0;
onAvailabilityChange(() => {
  availabilityVersion++;
});

function itemsOf(item: MenuItem): MenuItem[] {
  return typeof item.items === "function" ? item.items() : (item.items ?? []);
}

function isEnabled(item: MenuItem): boolean {
  if (item.disabled) return false;
  if (item.items) return true;
  if (item.run) return true;
  return item.command ? isCommandAvailable(item.command) : false;
}

/** Shortcuts that mean something to the field being typed in, so a field
 *  with focus keeps them. Ctrl+Z and Ctrl+Y as well: inside a field
 *  they take back the TYPING, and handing them to the database undo instead
 *  meant a mistyped memo, corrected with Ctrl+Z, took back the transaction
 *  saved a minute ago. Edit → Undo in the menu still reaches the database. */
const FIELD_OWNS = ["edit.cut", "edit.copy", "edit.paste", "edit.undo", "edit.redo"];

/** Bind every accelerator the menus print. One table, so a shortcut shown and
 *  a shortcut bound cannot drift apart. */
export function useMenuAccelerators(menus: Menu[]): void {
  useEffect(() => {
    const leaves = menuLeaves(menus).filter((l) => l.accel && l.command);
    function onKey(e: KeyboardEvent) {
      // Never steal a plain Del or a typing key from a field being edited.
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      for (const l of leaves) {
        if (!accelMatches(l.accel!, e)) continue;
        if (typing && !e.ctrlKey && !e.metaKey && !e.altKey) return;
        // Ctrl+C / Ctrl+X / Ctrl+V inside a field belong to the field.
        if (typing && FIELD_OWNS.includes(l.command!)) return;
        if (runCommand(l.command!)) e.preventDefault();
        return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menus]);
}

interface Props {
  menus: Menu[];
}

/** The item buttons of one open panel, in order (a separator is not one). */
function panelButtons(panel: Element): HTMLButtonElement[] {
  return Array.from(panel.children)
    .map((slot) => slot.querySelector<HTMLButtonElement>(":scope > button[role=menuitem]"))
    .filter((b): b is HTMLButtonElement => !!b);
}

export default function MenuBar({ menus }: Props) {
  useCommandAvailability();
  const [open, setOpen] = useState<number | null>(null);
  const [path, setPath] = useState<number[]>([]);
  const barRef = useRef<HTMLDivElement>(null);
  // The header above promised arrow keys, Enter, and Escape handing
  // focus back, and none of it existed: Alt+F opened a menu only a mouse
  // could use. Focus now goes INTO the menu. `pendingFocus` is where it lands
  // once the panel it names has rendered; `returnTo` is whatever had focus
  // before the menu opened — the field Edit → Paste is meant for.
  const pendingFocus = useRef<{ depth: number; index: number | "first" } | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const returnTo = useRef<HTMLElement | null>(null);

  const panels = useCallback(
    (): Element[] => Array.from(barRef.current?.querySelectorAll("[role=menu]") ?? []),
    []
  );

  const close = useCallback((restoreFocus = false) => {
    setOpen(null);
    setPath([]);
    const back = returnTo.current;
    returnTo.current = null;
    if (restoreFocus && back && back.isConnected) back.focus();
  }, []);

  /** Remember where focus was, the moment a menu opens from nothing. */
  const noteReturn = useCallback(() => {
    const el = document.activeElement as HTMLElement | null;
    if (el && el !== document.body && !barRef.current?.contains(el)) returnTo.current = el;
  }, []);

  const focusSoon = useCallback((depth: number, index: number | "first") => {
    pendingFocus.current = { depth, index };
    setFocusTick((t) => t + 1);
  }, []);

  useEffect(() => {
    const want = pendingFocus.current;
    if (!want || open === null) return;
    pendingFocus.current = null;
    const panel = panels()[want.depth];
    if (!panel) return;
    const items = panelButtons(panel);
    const target = want.index === "first" ? items.find((b) => !b.disabled) : items[want.index];
    target?.focus();
  }, [open, path, focusTick, panels]);

  // Click anywhere else closes. Escape closes and hands focus back; the
  // arrows and Enter walk the open menu.
  useEffect(() => {
    if (open === null) return;
    const cur = open;
    function onDown(e: MouseEvent) {
      if (!barRef.current?.contains(e.target as Node)) close();
    }
    function onKey(e: KeyboardEvent) {
      // Handled here, at the document, so nothing listening on the window —
      // the register's arrows, Settings' Escape — acts on the same press.
      const handled = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.key === "Escape") {
        handled();
        close(true);
        return;
      }
      if (e.key === "Tab") {
        close();
        return;
      }
      const all = panels();
      const active = document.activeElement as HTMLElement | null;
      const panel = active?.closest("[role=menu]") ?? null;
      const depth = panel ? all.indexOf(panel) : -1;
      const items = panel ? panelButtons(panel) : [];
      const at = active ? items.indexOf(active as HTMLButtonElement) : -1;
      const hasSub = active?.getAttribute("aria-haspopup") === "true";
      const n = menus.length;
      switch (e.key) {
        case "ArrowDown":
        case "ArrowUp": {
          handled();
          // Focus still on the title (a menu opened by click): into the menu.
          const list = depth < 0 ? (all[0] ? panelButtons(all[0]) : []) : items;
          // A grayed item is skipped — arrowing onto it and pressing Enter
          // would be the small betrayal the header describes.
          const live = list.filter((b) => !b.disabled);
          if (live.length === 0) return;
          const pos = live.indexOf(active as HTMLButtonElement);
          const down = e.key === "ArrowDown";
          const next = pos < 0 ? (down ? 0 : live.length - 1) : (pos + (down ? 1 : -1) + live.length) % live.length;
          live[next].focus();
          return;
        }
        case "ArrowRight": {
          handled();
          if (depth >= 0 && at >= 0 && hasSub) {
            setPath([...path.slice(0, depth), at]);
            focusSoon(depth + 1, "first");
            return;
          }
          setOpen((cur + 1) % n);
          setPath([]);
          focusSoon(0, "first");
          return;
        }
        case "ArrowLeft": {
          handled();
          if (depth > 0) {
            const parent = path[depth - 1];
            setPath(path.slice(0, depth - 1));
            focusSoon(depth - 1, parent);
            return;
          }
          setOpen((cur - 1 + n) % n);
          setPath([]);
          focusSoon(0, "first");
          return;
        }
        case "Enter":
        case " ": {
          if (depth < 0 || at < 0) return;
          handled();
          if (hasSub) {
            setPath([...path.slice(0, depth), at]);
            focusSoon(depth + 1, "first");
          } else {
            (active as HTMLButtonElement).click();
          }
          return;
        }
      }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, path, close, menus, panels, focusSoon]);

  // Alt+letter opens the matching menu, with focus on its first item.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const i = menus.findIndex((m) => m.mnemonic === e.key.toLowerCase());
      if (i < 0) return;
      e.preventDefault();
      if (open === i) {
        close(true);
        return;
      }
      if (open === null) noteReturn();
      setOpen(i);
      setPath([]);
      focusSoon(0, "first");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menus, open, close, noteReturn, focusSoon]);

  function choose(item: MenuItem) {
    if (!isEnabled(item) || item.items) return;
    // Focus goes back BEFORE the command runs: Edit → Paste pastes into the
    // focused field, and a command that moves focus itself (Find) still wins.
    close(true);
    if (item.run) item.run();
    else if (item.command) runCommand(item.command);
  }

  return (
    <div className="tm-menubar" role="menubar" ref={barRef} aria-label="Main menu">
      {menus.map((m, i) => (
        <div key={m.label} className="tm-menubar-slot">
          <button
            type="button"
            role="menuitem"
            aria-haspopup="true"
            aria-expanded={open === i}
            // The mnemonic is drawn with <u>, which puts the letter in its
            // own text node — and the accessible name algorithm joins text
            // nodes with a space, so "File" would be announced (and queried)
            // as "F ile". The label is stated once, plainly, here.
            aria-label={m.label}
            className={`tm-menubar-title ${open === i ? "open" : ""}`}
            onMouseDown={() => {
              if (open === null) noteReturn();
            }}
            onClick={() => {
              if (open === i) close(true);
              else {
                setOpen(i);
                setPath([]);
              }
            }}
            // Money's behavior: once one is open, sliding across opens the next.
            onMouseEnter={() => {
              if (open !== null && open !== i) {
                setOpen(i);
                setPath([]);
              }
            }}
          >
            <MnemonicLabel label={m.label} mnemonic={m.mnemonic} />
          </button>
          {open === i && (
            <MenuPanel items={m.items} onChoose={choose} depth={0} path={path} setPath={setPath} />
          )}
        </div>
      ))}
    </div>
  );
}

/** The label with its Alt letter underlined: the first occurrence of
 *  the mnemonic, in either case. It used to be the first letter, always,
 *  which is right for File, Edit, Tools and Help and wrong for Favorites —
 *  Alt+A opens it, and it showed an underlined F that Alt+F cannot reach
 *  (*"ALT+F gives you File and I see the F on Favorites is underlined"*).
 *  A label without its letter draws plain rather than underlining a guess;
 *  `commands.test.ts` makes sure no menu ships like that. */
function MnemonicLabel({ label, mnemonic }: { label: string; mnemonic: string }) {
  const at = mnemonic ? label.toLowerCase().indexOf(mnemonic.toLowerCase()) : -1;
  if (at < 0) return <>{label}</>;
  return (
    <>
      {label.slice(0, at)}
      <u>{label.charAt(at)}</u>
      {label.slice(at + 1)}
    </>
  );
}

function MenuPanel({
  items,
  onChoose,
  depth,
  path,
  setPath,
}: {
  items: MenuItem[];
  onChoose: (item: MenuItem) => void;
  depth: number;
  path: number[];
  setPath: (p: number[]) => void;
}) {
  const openChild = path[depth];
  return (
    <div className="tm-menu" role="menu">
      {items.map((item, idx) => {
        const enabled = isEnabled(item);
        const sub = item.items ? itemsOf(item) : null;
        return (
          <div key={`${item.label}-${idx}`} className="tm-menu-slot">
            {item.separatorBefore && <div className="tm-menu-sep" role="separator" />}
            <button
              type="button"
              role="menuitem"
              className={`tm-menu-item ${enabled ? "" : "disabled"} ${openChild === idx ? "open" : ""}`}
              aria-disabled={!enabled}
              aria-haspopup={sub ? "true" : undefined}
              aria-keyshortcuts={item.accel ? ariaKeys(item.accel) : undefined}
              disabled={!enabled}
              onMouseEnter={() => setPath(sub ? [...path.slice(0, depth), idx] : path.slice(0, depth))}
              onClick={() => {
                if (sub) setPath([...path.slice(0, depth), idx]);
                else onChoose(item);
              }}
            >
              <span className="tm-menu-label">{item.label}</span>
              {/* The shortcut and the submenu arrow are decoration on the
                  name: an item is "Print…", not "Print… Ctrl+P ▸". The
                  shortcut is still announced, through aria-keyshortcuts. */}
              {item.accel && (
                <span className="tm-menu-accel" aria-hidden="true">
                  {item.accel}
                </span>
              )}
              {sub && (
                <span className="tm-menu-arrow" aria-hidden="true">
                  ▸
                </span>
              )}
            </button>
            {sub && openChild === idx && (
              <MenuPanel items={sub} onChoose={onChoose} depth={depth + 1} path={path} setPath={setPath} />
            )}
          </div>
        );
      })}
    </div>
  );
}
