// A category field you can type into — Money's behavior, and the thing a
// plain <select> cannot do.
//
// A native select only jumps by first letter, which is useless against a list
// where everything reads "Automobile : Fuel". This filters on any part of the
// name as you type, keeps the keyboard flow (↓ ↑ Enter Esc, Tab commits and
// moves on), and still shows the Income / Expense grouping.
//
// It takes generic items rather than categories because the register's
// Category field is also how Money enters a transfer — "Transfer : <Account>"
// lives in the same list.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface ComboItem {
  value: string;
  label: string;
  /** Optional heading this item sits under. */
  group?: string;
}

interface Props {
  items: readonly ComboItem[];
  value: string;
  onChange: (value: string) => void;
  label: string;
  id?: string;
  placeholder?: string;
  className?: string;
  style?: React.CSSProperties;
  disabled?: boolean;
  /** Offer "Add <what you typed>…" so a missing category can be created
   *  without abandoning the transaction. Omit to hide the option. */
  onAddNew?: (query: string) => void;
}

/** One spelling for a category name, so that what is typed is
 *  compared with what is stored on the same terms. The standard form is
 *  "Parent : Child" (space, colon, space), but "Loan:HELOC",
 *  "loan : heloc" and "Loan  :HELOC" all mean the same thing, and the field
 *  should recognize them rather than offer to create a duplicate. Case is
 *  folded, whitespace around every colon is normalized, runs of spaces
 *  inside a name collapse to one. */
export function categoryKey(text: string): string {
  return text
    .split(":")
    .map((part) => part.trim().replace(/\s+/g, " ").toLowerCase())
    .join(" : ");
}

/** Match on the label, spelling normalized: "loan:heloc" finds
 *  "Loan : HELOC". An item whose whole name is what was typed comes first,
 *  so Tab and Enter take it over a longer name that merely contains it. */
export function filterItems(
  items: readonly ComboItem[],
  query: string
): ComboItem[] {
  const q = categoryKey(query);
  if (!q.trim()) return [...items];
  const exact: ComboItem[] = [];
  const rest: ComboItem[] = [];
  for (const i of items) {
    const k = categoryKey(i.label);
    if (k === q) exact.push(i);
    else if (k.includes(q)) rest.push(i);
  }
  return [...exact, ...rest];
}

export default function CategoryCombo({
  items,
  value,
  onChange,
  label,
  id,
  placeholder = "(none)",
  className = "aero-field",
  style,
  disabled = false,
  onAddNew,
}: Props) {
  const selected = items.find((i) => i.value === value) ?? null;
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // Has the user typed or arrowed since the list opened? Tab commits the
  // highlighted match only if so. Focusing a field (which opens the list)
  // and tabbing straight on used to re-file the transaction under whatever
  // sat first in the list — "Auto : Fuel" became "Bonus" by passing through.
  const [touched, setTouched] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // The register sits inside an `overflow-auto` wrapper, so an absolutely
  // positioned list is CLIPPED by it — a short filtered list fitted and showed,
  // the full one did not, which is exactly how this was reported. The list is
  // therefore portaled to <body> and positioned from the input's viewport
  // rect, which no ancestor's overflow or stacking context can affect.
  const [rect, setRect] = useState<DOMRect | null>(null);

  // While closed the input shows the chosen category; typing takes over.
  const text = open ? query : (selected?.label ?? "");
  const matches = useMemo(
    () => (open ? filterItems(items, query) : [...items]),
    [items, query, open]
  );

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const r = inputRef.current?.getBoundingClientRect();
      if (r) setRect(r);
    };
    measure();
    // Keep it pinned while the register scrolls underneath.
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open]);

  // Open ON the category the row already has, not at the top of the
  // list. `openList` has always highlighted the current one, so Enter and the
  // arrows started from the right place; what nothing did was SCROLL to it.
  // With a full chart of accounts that meant clicking "Loan : HELOC Interest"
  // and being shown the As, with the highlight somewhere off-screen below —
  // which reads as the field having forgotten what it holds.
  //
  // `block: "nearest"` so a choice already in view does not jump; the ref map
  // is keyed by index because the options are portaled and re-filtered as
  // you type.
  const optionRefs = useRef(new Map<number, HTMLDivElement>());
  useLayoutEffect(() => {
    if (!open) return;
    const el = optionRefs.current.get(active);
    // jsdom has no scrollIntoView, and neither does every embedded webview —
    // a list that cannot scroll itself must not take the field down with it.
    el?.scrollIntoView?.({ block: "nearest" });
  }, [open, active, matches.length]);

  useEffect(() => {
    if (!open) return;
    function onDocPointerDown(e: MouseEvent) {
      const t = e.target as Node;
      // The list lives in a portal, so it is NOT inside boxRef — check both or
      // clicking an option would close the list before it could be chosen.
      if (!boxRef.current?.contains(t) && !listRef.current?.contains(t)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocPointerDown);
    return () => document.removeEventListener("mousedown", onDocPointerDown);
  }, [open]);

  function openList() {
    setQuery("");
    optionRefs.current.clear();
    setOpen(true);
    setTouched(false);
    // Highlight the current choice, so Enter or an arrow starts from it.
    const current = items.findIndex((i) => i.value === value);
    setActive(current >= 0 ? current : 0);
  }

  function choose(item: ComboItem | null) {
    onChange(item?.value ?? "");
    setOpen(false);
    setQuery("");
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setTouched(true);
      if (!open) {
        setOpen(true);
        setActive(0);
      } else {
        setActive((a) => Math.min(a + 1, matches.length - 1));
      }
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setTouched(true);
      setActive((a) => Math.max(a - 1, 0));
      return;
    }
    if (e.key === "Enter" && open) {
      // Don't let Enter also commit the transaction — picking a category and
      // saving the row are two different intents.
      e.preventDefault();
      e.stopPropagation();
      // Nothing matches what was typed: Enter used to choose "(none)"
      // and wipe the category the row had, where Tab leaves it alone. Offer
      // to create what was typed when that is on offer; otherwise do nothing,
      // and the list stays open showing "No match".
      if (matches.length === 0) {
        if (canAdd) addNew();
        return;
      }
      choose(matches[Math.min(active, matches.length - 1)]);
      return;
    }
    if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      setQuery("");
      return;
    }
    if (e.key === "Tab" && open) {
      // Tab takes the highlighted match and moves on — the fast path — but
      // only when the user has typed or arrowed. Passing through a field
      // must leave its value alone.
      if (touched && matches[active]) choose(matches[active]);
      else {
        setOpen(false);
        setQuery("");
      }
    }
  }

  // Offer creation only when they have typed something that is not already
  // an exact match — otherwise the row is noise on every keystroke.
  // Compared on the normalized spelling, so "Loan:HELOC" typed against
  // an existing "Loan : HELOC" is recognized, not offered as a new one.
  const canAdd =
    !!onAddNew &&
    query.trim().length > 0 &&
    !items.some((i) => categoryKey(i.label) === categoryKey(query));

  function addNew() {
    const q = query.trim();
    setOpen(false);
    setQuery("");
    onAddNew!(q);
  }

  // "Parent : Child" where the parent exists reads as adding a subcategory,
  // so say so on the row rather than offering the whole string as a name.
  const addLabel = (() => {
    const q = query.trim();
    const colon = q.indexOf(":");
    if (colon < 0) return `+ Add "${q}"…`;
    const parent = q.slice(0, colon).trim();
    const child = q.slice(colon + 1).trim();
    const known = items.find((i) => categoryKey(i.label) === categoryKey(parent));
    if (known && child) return `+ Add "${child}" under ${known.label}…`;
    return `+ Add "${q}"…`;
  })();

  // Below the field by default; above it when the viewport has no room.
  const MAX_LIST_HEIGHT = 260;
  const spaceBelow = rect ? window.innerHeight - rect.bottom : 0;
  const dropUp = !!rect && spaceBelow < 160 && rect.top > spaceBelow;
  const listStyle: React.CSSProperties = rect
    ? {
        position: "fixed",
        left: rect.left,
        width: rect.width,
        maxHeight: Math.min(
          MAX_LIST_HEIGHT,
          Math.max(120, dropUp ? rect.top - 8 : spaceBelow - 8)
        ),
        ...(dropUp
          ? { bottom: window.innerHeight - rect.top }
          : { top: rect.bottom }),
      }
    : { position: "fixed", visibility: "hidden" };

  let lastGroup: string | undefined;

  return (
    <div ref={boxRef} className="relative" style={style}>
      <input
        ref={inputRef}
        id={id}
        className={className}
        style={{ width: "100%" }}
        aria-label={label}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        autoComplete="off"
        disabled={disabled}
        placeholder={placeholder}
        value={text}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setTouched(true);
          setActive(0);
        }}
        onFocus={openList}
        // Choosing an option calls preventDefault on mousedown so the input
        // keeps focus (the keyboard flow depends on that) — which means the
        // NEXT click fires no focus event. Without this the list would not
        // reopen until you clicked away and back.
        onClick={openList}
        onKeyDown={onKeyDown}
      />
      {open &&
        createPortal(
          <ul
            ref={listRef}
            className="tm-combo-list"
            role="listbox"
            aria-label={`${label} options`}
            style={listStyle}
          >
          <li
            role="option"
            aria-selected={value === ""}
            className={active === -1 ? "active" : undefined}
            onMouseDown={(e) => {
              e.preventDefault();
              choose(null);
            }}
          >
            (none)
          </li>
          {matches.length === 0 && !canAdd && (
            <li className="tm-combo-empty" aria-disabled="true">
              No match
            </li>
          )}
          {canAdd && (
            <li
              role="option"
              aria-selected={false}
              className="tm-combo-add"
              onMouseDown={(e) => {
                e.preventDefault();
                addNew();
              }}
            >
              {addLabel}
            </li>
          )}
          {matches.map((item, i) => {
            const heading = item.group !== lastGroup ? item.group : undefined;
            lastGroup = item.group;
            return (
              <li key={item.value} className="contents">
                {heading && <div className="tm-combo-group">{heading}</div>}
                <div
                  role="option"
                  ref={(el) => {
                    if (el) optionRefs.current.set(i, el);
                    else optionRefs.current.delete(i);
                  }}
                  aria-selected={i === active}
                  className={`tm-combo-option${i === active ? " active" : ""}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(item);
                  }}
                >
                  {item.label}
                </div>
              </li>
            );
          })}
          </ul>,
          document.body
        )}
    </div>
  );
}
