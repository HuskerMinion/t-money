// The Payee field — free text with Money's completion: as you type, the
// payees you have used before drop down, best match first, and **Tab or
// Enter takes the highlighted one** and moves on. Typing a name nobody has
// used is still fine; the list is an offer, not a constraint.
//
// It replaced a <datalist>, which could show names but never accept one on
// Tab — the user saw "Netflix" sitting under the field and had to reach for
// the mouse or finish typing it.
//
// Ranking: a name that STARTS with what was typed beats one that merely
// contains it; within a tier the most-used payee first. Eight rows at most.
// Nothing is offered until something is typed, so tabbing straight through
// an empty field leaves it empty. Enter with the list open picks; Enter with
// it closed falls through to the row (which commits the transaction).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Payee } from "../lib/types";

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** Called with the final text when the field is left or a name accepted —
   *  the register recalls the payee's last category and amount from it. */
  onSettle?: (value: string) => void;
  payees: readonly Payee[];
  placeholder?: string;
  readOnly?: boolean;
  title?: string;
  autoFocus?: boolean;
  className?: string;
  label?: string;
}

export const MAX_SUGGESTIONS = 8;

/** Starts-with first, then contains; most used first inside each tier. */
export function suggestPayees(payees: readonly Payee[], query: string, max = MAX_SUGGESTIONS): Payee[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const starts: Payee[] = [];
  const contains: Payee[] = [];
  for (const p of payees) {
    const n = p.name.toLowerCase();
    if (n.startsWith(q)) starts.push(p);
    else if (n.includes(q)) contains.push(p);
  }
  const byUse = (a: Payee, b: Payee) => b.usage_count - a.usage_count || a.name.localeCompare(b.name);
  starts.sort(byUse);
  contains.sort(byUse);
  return [...starts, ...contains].slice(0, max);
}

export default function PayeeField({
  value,
  onChange,
  onSettle,
  payees,
  placeholder = "Payee",
  readOnly = false,
  title,
  autoFocus = false,
  className = "aero-field w-full",
  label = "Payee",
}: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const matches = useMemo(() => (open ? suggestPayees(payees, value) : []), [payees, value, open]);
  // An exact match (case-insensitive) alone in the list is nothing to offer.
  const showing = matches.length > 0 && !(matches.length === 1 && matches[0].name.toLowerCase() === value.trim().toLowerCase());

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const r = inputRef.current?.getBoundingClientRect();
      if (r) setRect(r);
    };
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDocPointerDown(e: MouseEvent) {
      const t = e.target as Node;
      if (!inputRef.current?.contains(t) && !listRef.current?.contains(t)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocPointerDown);
    return () => document.removeEventListener("mousedown", onDocPointerDown);
  }, [open]);

  function accept(p: Payee) {
    onChange(p.name);
    setOpen(false);
    onSettle?.(p.name);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (readOnly) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      else setActive((a) => Math.min(a + 1, matches.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
      return;
    }
    if (e.key === "Escape" && open) {
      setOpen(false);
      // Only a list on screen takes the Escape. `open` stays true after
      // any keystroke, with or without matches, and swallowing Escape then
      // made the row's Esc-to-cancel (and the split dialog's) need two presses.
      if (showing) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if ((e.key === "Enter" || e.key === "Tab") && open && showing && matches[active]) {
      // Tab: take it and move on (the browser's Tab still fires — the focus
      // moves — we only fill the field first). Enter: take it, stay here,
      // and do not let the row commit on the same keystroke.
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
      }
      accept(matches[active]);
    }
  }

  const listStyle: React.CSSProperties = rect
    ? { position: "fixed", left: rect.left, width: Math.max(rect.width, 220), top: rect.bottom, maxHeight: 220 }
    : { position: "fixed", visibility: "hidden" };

  return (
    <>
      <input
        ref={inputRef}
        className={className}
        aria-label={label}
        role="combobox"
        aria-expanded={open && showing}
        aria-autocomplete="list"
        autoComplete="off"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onBlur={(e) => {
          // Leaving the field (Tab included) settles whatever is in it; a
          // Tab that accepted a match already settled that name.
          setOpen(false);
          onSettle?.(e.target.value);
        }}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        readOnly={readOnly}
        title={title ?? (readOnly ? undefined : "Type, then Tab or Enter takes the highlighted payee")}
        autoFocus={autoFocus}
      />
      {open &&
        showing &&
        createPortal(
          <ul ref={listRef} className="tm-combo-list" role="listbox" aria-label={`${label} suggestions`} style={listStyle}>
            {matches.map((p, i) => (
              <li
                key={p.id}
                role="option"
                aria-selected={i === active}
                className={`tm-combo-option${i === active ? " active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  accept(p);
                }}
              >
                {p.name}
                {p.last_category_name && <span className="tm-text-muted"> — {p.last_category_name}</span>}
              </li>
            ))}
          </ul>,
          document.body
        )}
    </>
  );
}
