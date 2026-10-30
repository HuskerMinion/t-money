// The calendar under a date field's ▾.
//
// It was the native date picker. In WebView2 that is a small popup that
// follows Windows, not the app's theme, and a user asked for "a calendar" with
// the ▾ already there, so it was not reading as one. This is the app's own:
// a month grid in the app's colors, opened by the ▾, by Alt+↓ or by F4 in the
// field (the Windows keys for a drop-down).
//
// The keys are the Windows calendar's: arrows move a day or a week, Page Up
// and Page Down a month (with Shift, a year), Home and End the week's ends,
// T is today, Enter or Space picks, Escape closes and gives focus back to the
// field. Every key stops here, so a dialog underneath does not also close on
// Escape and the app's shortcuts do not act on the screen behind.
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { monthGrid, shiftMonth } from "./BillCalendar";
import { formatDateUS, today } from "../lib/format";

interface Props {
  /** ISO YYYY-MM-DD the calendar opens on; "" opens on today. */
  value: string;
  /** The field it drops from: placed under it, and given focus back. */
  anchor: HTMLElement;
  onPick: (iso: string) => void;
  onClose: () => void;
  /** For the screen reader: "Date", "Start date". */
  label: string;
}

const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function shiftDays(iso: string, by: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d + by);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

/** The same day `by` months on, kept inside the month: Jan 31 + 1 is Feb 28. */
export function shiftMonthDay(iso: string, by: number): string {
  const month = shiftMonth(iso.slice(0, 7), by);
  const [y, m] = month.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  const day = Math.min(Number(iso.slice(8, 10)), last);
  return `${month}-${String(day).padStart(2, "0")}`;
}

export default function DatePopup({ value, anchor, onPick, onClose, label }: Props) {
  const now = today();
  const [focusDay, setFocusDay] = useState(value || now);
  const month = focusDay.slice(0, 7);
  const rows = monthGrid(month);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(() => {
    const r = anchor.getBoundingClientRect();
    return { x: r.left, y: r.bottom + 2 };
  });

  // On screen: under the field, or above it when there is no room below.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = anchor.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    // Lined up with the field's left edge, slid left only as far as the
    // window's edge needs.
    const x = Math.max(0, Math.min(r.left, window.innerWidth - box.width));
    const y = r.bottom + 2 + box.height <= window.innerHeight ? r.bottom + 2 : Math.max(0, r.top - 2 - box.height);
    setPos({ x, y });
  }, [anchor]);

  // The focused day has focus, so the arrows and a screen reader follow it.
  useLayoutEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>(`[data-day="${focusDay}"]`)?.focus();
  }, [focusDay]);

  function close() {
    onClose();
    // Once the pick has rendered: the field's focus handler reads the form's
    // date, and before then that is still the old one.
    setTimeout(() => anchor.focus(), 0);
  }

  function pick(iso: string) {
    onPick(iso);
    close();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const move = (next: string) => setFocusDay(next);
    const dow = new Date(Number(focusDay.slice(0, 4)), Number(focusDay.slice(5, 7)) - 1, Number(focusDay.slice(8, 10))).getDay();
    switch (e.key) {
      case "ArrowLeft":
        move(shiftDays(focusDay, -1));
        break;
      case "ArrowRight":
        move(shiftDays(focusDay, 1));
        break;
      case "ArrowUp":
        move(shiftDays(focusDay, -7));
        break;
      case "ArrowDown":
        move(shiftDays(focusDay, 7));
        break;
      case "PageUp":
        move(shiftMonthDay(focusDay, e.shiftKey ? -12 : -1));
        break;
      case "PageDown":
        move(shiftMonthDay(focusDay, e.shiftKey ? 12 : 1));
        break;
      case "Home":
        move(shiftDays(focusDay, -dow));
        break;
      case "End":
        move(shiftDays(focusDay, 6 - dow));
        break;
      case "t":
      case "T":
        move(now);
        break;
      case "Enter":
      case " ":
        pick(focusDay);
        break;
      case "Escape":
      case "Tab":
        close();
        break;
      default:
        e.stopPropagation();
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  const [y, m] = month.split("-").map(Number);
  // A portal still bubbles through the React tree, so a click here would also
  // reach the row or form the field sits in. It stops at the wrapper.
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return createPortal(
    <div onClick={stop} onDoubleClick={stop} onMouseDown={stop} onContextMenu={stop}>
      <div className="tm-dialog-backdrop" style={{ background: "transparent", zIndex: 69 }} onMouseDown={(e) => { e.preventDefault(); close(); }} />
      <div
        ref={ref}
        className="tm-datepopup"
        role="dialog"
        aria-label={`${label} calendar`}
        style={{ top: pos.y, left: pos.x }}
        onKeyDown={onKeyDown}
      >
        <div className="tm-datepopup-head">
          <button type="button" tabIndex={-1} aria-label="Previous month" title="Previous month (Page Up)" onClick={() => setFocusDay(shiftMonthDay(focusDay, -1))}>
            ‹
          </button>
          <span aria-live="polite">{MONTHS[m - 1]} {y}</span>
          <button type="button" tabIndex={-1} aria-label="Next month" title="Next month (Page Down)" onClick={() => setFocusDay(shiftMonthDay(focusDay, 1))}>
            ›
          </button>
        </div>
        <table role="grid" aria-label={`${MONTHS[m - 1]} ${y}`}>
          <thead>
            <tr>
              {DOW.map((d) => (
                <th key={d} scope="col">{d}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri}>
                {row.map((day, ci) =>
                  day === null ? (
                    <td key={ci} />
                  ) : (
                    <td key={ci}>
                      <button
                        type="button"
                        data-day={day}
                        tabIndex={day === focusDay ? 0 : -1}
                        aria-label={formatDateUS(day)}
                        aria-pressed={day === value}
                        className={[day === value ? "tm-datepopup-chosen" : "", day === now ? "tm-datepopup-today" : ""].filter(Boolean).join(" ") || undefined}
                        onClick={() => pick(day)}
                      >
                        {Number(day.slice(8, 10))}
                      </button>
                    </td>
                  )
                )}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="tm-datepopup-foot">
          <button type="button" tabIndex={-1} className="tm-rail-link" title="Today (T)" onClick={() => pick(now)}>
            Today: {formatDateUS(now)}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
