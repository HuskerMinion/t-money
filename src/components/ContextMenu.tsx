// The one right-click menu.
//
// Money put the deeper actions on the right mouse button: split this, schedule
// that, go to the other side of a transfer. The first T-Money menu was written
// inline in the register, and every other list in the app had none, so a
// right-click there did nothing at all. This is the shared piece, so each list
// only says WHAT its menu offers.
//
// It behaves like a Windows menu: it opens at the pointer and stays on
// screen near an edge, the first item has focus, the arrow keys move (Home and
// End jump), Enter or Space chooses, Escape or Tab closes it and gives focus
// back. Shift+F10 and the Menu key fire the same `contextmenu` event with no
// pointer position, so `menuPoint` opens those at the row instead of in the
// window's top-left corner.
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Shown on hover; says what a less obvious item will do. */
  title?: string;
  /** A rule above this item, to group the menu the way Money does. */
  separatorBefore?: boolean;
}

/** An entry may be left out by passing anything falsy, so a menu can be
 *  written as one list with `condition && { … }` inline. */
export type MenuEntry = ContextMenuItem | false | null | undefined | "" | 0;

interface Props {
  x: number;
  y: number;
  items: readonly MenuEntry[];
  onClose: () => void;
  /** Read out by a screen reader, e.g. "Transaction actions". */
  label?: string;
}

/** Where a `contextmenu` event should open the menu.
 *
 *  A mouse right-click carries the pointer; Shift+F10 and the Menu key carry
 *  (0, 0), and that becomes the lower-left of the element, like Windows. */
export function menuPoint(e: { clientX: number; clientY: number; currentTarget: Element }): { x: number; y: number } {
  if (e.clientX !== 0 || e.clientY !== 0) return { x: e.clientX, y: e.clientY };
  const r = e.currentTarget.getBoundingClientRect();
  return { x: r.left + 8, y: r.bottom };
}

/** Keep a box of `w` by `h` at (x, y) inside a viewport of `vw` by `vh`:
 *  flipped to the left of or above the point when it would run off, and never
 *  past the top-left corner. */
export function clampToViewport(x: number, y: number, w: number, h: number, vw: number, vh: number): { x: number; y: number } {
  const left = x + w > vw ? Math.max(0, x - w) : x;
  const top = y + h > vh ? Math.max(0, Math.min(y - h, vh - h)) : y;
  return { x: left, y: top };
}

/** Whether a right-click should still get the webview's own menu: in a
 *  text box, or over selected text, where Cut, Copy and Paste live. */
export function keepsBrowserMenu(target: EventTarget | null, selection: string): boolean {
  if (selection.trim() !== "") return true;
  const el = target instanceof Element ? target : null;
  return !!el?.closest("input, textarea, [contenteditable='true']");
}

export default function ContextMenu({ x, y, items, onClose, label }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  // Where focus was before the menu opened, so Escape can put it back.
  const returnTo = useRef<Element | null>(null);
  const shown = items.filter((i): i is ContextMenuItem => !!i);

  useLayoutEffect(() => {
    returnTo.current = document.activeElement;
    const el = ref.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    setPos(clampToViewport(x, y, box.width, box.height, window.innerWidth, window.innerHeight));
    el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [x, y]);

  function close(restoreFocus: boolean) {
    onClose();
    if (restoreFocus && returnTo.current instanceof HTMLElement) returnTo.current.focus();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => buttons[(i + buttons.length) % buttons.length]?.focus();
    switch (e.key) {
      case "ArrowDown":
        go(at + 1);
        break;
      case "ArrowUp":
        go(at < 0 ? buttons.length - 1 : at - 1);
        break;
      case "Home":
        go(0);
        break;
      case "End":
        go(buttons.length - 1);
        break;
      case "Escape":
        close(true);
        break;
      case "Tab":
        close(false);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  return createPortal(
    <>
      <div
        className="tm-dialog-backdrop"
        style={{ background: "transparent", zIndex: 59 }}
        onClick={() => close(false)}
        onContextMenu={(e) => {
          e.preventDefault();
          close(false);
        }}
      />
      <div
        ref={ref}
        className="tm-context-menu"
        role="menu"
        aria-label={label}
        style={{ top: pos.y, left: pos.x }}
        onKeyDown={onKeyDown}
      >
        {shown.map((item, i) => (
          <div key={`${i}:${item.label}`}>
            {item.separatorBefore && i > 0 && <div className="tm-context-sep" role="separator" />}
            <button
              role="menuitem"
              type="button"
              disabled={item.disabled}
              title={item.title}
              onClick={() => {
                // Closed first: an action that opens a dialog should not
                // have the menu still on top of it.
                onClose();
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          </div>
        ))}
      </div>
    </>,
    document.body
  );
}

/** The state a list keeps for its menu: which thing was right-clicked, and
 *  where. `open` is written to be the `onContextMenu` handler itself. */
export function useContextMenu<T>() {
  const [menu, setMenu] = useState<{ target: T; x: number; y: number } | null>(null);
  return {
    menu,
    open: (e: React.MouseEvent, target: T) => {
      e.preventDefault();
      e.stopPropagation();
      setMenu({ target, ...menuPoint(e) });
    },
    close: () => setMenu(null),
  };
}
