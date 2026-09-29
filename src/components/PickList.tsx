// Choosing several things from a long list.
//
// The report customizer used `<select multiple>` for accounts, categories,
// payees and securities. That control is a trap outside a spreadsheet: you
// must know to hold Ctrl to add one and Shift to add a run, a plain click
// silently throws away everything you had chosen, and on a chart of accounts
// with sixty categories there is no way to see what is ticked without
// scrolling the selection back into view.
//
// Reported plainly: "having to hold shift or CTRL to select multiple things
// is not best practice — click to select/deselect and it sticks."
//
// So: checkboxes. Click toggles one and nothing else moves; a search box
// narrows a long list; All / None act on what the search is showing, which is
// what makes "tick every Auto category" one gesture instead of six.
import { useMemo, useState } from "react";

export interface PickItem {
  value: string;
  label: string;
  /** Optional second line — an account's type, a value's parent. */
  hint?: string;
}

interface Props {
  label: string;
  items: readonly PickItem[];
  /** The values currently ticked. */
  value: readonly string[];
  onChange: (next: string[]) => void;
  /** Shown under the list — what "none ticked" means here. */
  note?: string;
  /** Offer the search box above this many items. */
  searchOver?: number;
  rows?: number;
}

export default function PickList({
  label,
  items,
  value,
  onChange,
  note,
  searchOver = 8,
  rows = 8,
}: Props) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) => i.label.toLowerCase().includes(q) || (i.hint ?? "").toLowerCase().includes(q));
  }, [items, query]);

  const on = new Set(value);
  const shownValues = shown.map((i) => i.value);
  const allShownOn = shownValues.length > 0 && shownValues.every((v) => on.has(v));

  function toggle(v: string) {
    const next = new Set(on);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    // Keep the caller's order stable: the item order, not click order.
    onChange(items.map((i) => i.value).filter((x) => next.has(x)));
  }

  /** All / None apply to what the SEARCH is showing, not the whole list —
   *  that is what makes "every Auto category" one gesture. */
  function setShown(ticked: boolean) {
    const next = new Set(on);
    for (const v of shownValues) {
      if (ticked) next.add(v);
      else next.delete(v);
    }
    onChange(items.map((i) => i.value).filter((x) => next.has(x)));
  }

  return (
    <div className="tm-picklist" role="group" aria-label={label}>
      <div className="font-bold pb-1 flex items-center gap-2">
        <span className="flex-1">{label}</span>
        {on.size > 0 && <span className="tm-text-muted font-normal">{on.size} chosen</span>}
      </div>
      {items.length > searchOver && (
        <input
          className="aero-field w-full mb-1"
          type="search"
          aria-label={`Search ${label.toLowerCase()}`}
          placeholder="Type to narrow the list…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      <div className="tm-picklist-box" style={{ maxHeight: rows * 22 }}>
        {shown.length === 0 && <div className="tm-text-muted p-2">Nothing matches “{query}”.</div>}
        {shown.map((i) => (
          <label key={i.value} className="tm-picklist-row" title={i.hint}>
            <input type="checkbox" checked={on.has(i.value)} onChange={() => toggle(i.value)} />
            <span className="tm-picklist-label">{i.label}</span>
            {i.hint && <span className="tm-picklist-hint">{i.hint}</span>}
          </label>
        ))}
      </div>
      <div className="flex items-center gap-2 pt-1">
        <button type="button" className="aero-btn !py-0 !px-2" onClick={() => setShown(!allShownOn)} disabled={shown.length === 0}>
          {allShownOn ? "None" : query.trim() ? `All ${shown.length} shown` : "All"}
        </button>
        {on.size > 0 && (
          <button type="button" className="aero-btn !py-0 !px-2" onClick={() => onChange([])}>
            Clear
          </button>
        )}
        {note && <span className="tm-text-muted flex-1">{note}</span>}
      </div>
    </div>
  );
}
