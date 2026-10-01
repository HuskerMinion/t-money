// A date you can TYPE. The native date picker is a fine calendar and
// a poor keyboard: in WebView2 it takes the caret segment by segment and
// double-clicking it opens the popup. Money's date field was plain text
// with a few keys. So: a text field showing the date the file's region's
// way (M/D/YYYY in the US), parsed as you type (M/D, M/D/YY, M/D/YYYY,
// YYYY-MM-DD all accepted, in the region's order), with Money's shortcuts —
// + and − step a day, T is today — and a small ▾ that opens the native
// picker for anyone who wants the calendar.
import { useEffect, useRef, useState } from "react";
import { formatDateUS, today } from "../lib/format";
import { currentRegion } from "../lib/region";

interface Props {
  /** ISO YYYY-MM-DD. */
  value: string;
  onChange: (iso: string) => void;
  label?: string;
  className?: string;
  autoFocus?: boolean;
  /** Shown but not changeable (a split line's far row: its date is
   *  the payment's). The +/−/T keys and the calendar are off too. */
  readOnly?: boolean;
  title?: string;
  /** Told whenever the typed text stops (true) or starts again (false)
   *  reading as a date. A form whose date may be left empty cannot tell an
   *  unreadable date from a cleared one by `value` alone ("" either way), so
   *  it listens here to refuse the save. */
  onInvalid?: (invalid: boolean) => void;
  /** The date may be left blank (an account's opened-on, a goal's
   *  deadline): emptying the field sends "" rather than restoring the date. */
  optional?: boolean;
  /** Tell the form only when the field is left, on Enter, or on +/−/T or the
   *  calendar — not as each character is typed. For a report that re-runs on
   *  every change. Unreadable text then keeps the form's date. */
  commitOnLeave?: boolean;
  /** Set a width to sit in a row beside other controls; without one the
   *  field fills its container. */
  width?: number | string;
}

const pad = (n: number) => String(n).padStart(2, "0");

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** A typed date in the file's region's order → ISO, else null. In the US
 *  "8/3", "8/3/26", "8/3/2026", "08-03-2026" are August 3; where the day comes
 *  first (most of Europe, Mexico, Australia) "3/8", "3.8.26", "03.08.2026"
 *  are. "2026-08-03" is read as itself everywhere. Where the year comes
 *  first (Canada) "8-3" is August 3 and "26-08-03" is too. A two-digit year
 *  is 20xx; a missing year is the current one. */
export function parseTypedDate(text: string, base: string = today()): string | null {
  const t = text.trim();
  if (!t) return null;
  let m = /^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/.exec(t);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{1,4}))?$/.exec(t);
  if (!m) return null;
  // The last part is a day where the year comes first ("26-8-3"), else a
  // year, which has two digits or four.
  const yearLast = currentRegion().date_order !== "ymd";
  if (yearLast && m[3] !== undefined && m[3].length !== 2 && m[3].length !== 4) return null;
  if (!yearLast && m[3] !== undefined && m[3].length > 2) return null;
  const year = (s: string | undefined) => (s === undefined ? Number(base.slice(0, 4)) : s.length === 2 ? 2000 + Number(s) : Number(s));
  const [a, b, c] = [m[1], m[2], m[3]];
  switch (currentRegion().date_order) {
    case "dmy":
      return iso(year(c), Number(b), Number(a));
    case "ymd":
      // Two parts are month and day; three with a short first are a short year.
      return c === undefined ? iso(year(undefined), Number(a), Number(b)) : iso(year(a), Number(b), Number(c));
    default:
      return iso(year(c), Number(a), Number(b));
  }
}

/** What the empty field shows: "M/D/YYYY", "DD.MM.YYYY", "YYYY-MM-DD". */
function datePattern(): string {
  const r = currentRegion();
  const s = r.date_sep;
  if (r.date_order === "mdy") return `M${s}D${s}YYYY`;
  if (r.date_order === "dmy") return `DD${s}MM${s}YYYY`;
  return `YYYY${s}MM${s}DD`;
}

/** The short forms the field reads, for its tooltip: "8/3, 8/3/26 or
 *  8/3/2026" in the US, "3.8, 3.8.26 or 03.08.2026" in Germany. */
function dateExamples(): string {
  const r = currentRegion();
  const s = r.date_sep;
  if (r.date_order === "mdy") return `8${s}3, 8${s}3${s}26 or 8${s}3${s}2026`;
  if (r.date_order === "dmy") return `3${s}8, 3${s}8${s}26 or 03${s}08${s}2026`;
  return `8${s}3, 26${s}08${s}03 or 2026${s}08${s}03`;
}

export function shiftDays(isoDate: string, by: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(y, m - 1, d + by);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

export default function DateField({
  value,
  onChange,
  label = "Date",
  className = "aero-field w-full",
  autoFocus,
  readOnly = false,
  title,
  onInvalid,
  optional = false,
  commitOnLeave = false,
  width,
}: Props) {
  const [text, setText] = useState(formatDateUS(value));
  const [bad, setBad] = useState(false);
  const focused = useRef(false);
  const pickerRef = useRef<HTMLInputElement>(null);
  // The date the field held when the caret came in. An unreadable
  // date now sends "" (see `read`), so `value` no longer says what the date
  // was: a year left off ("8/3") still means that date's year, + and − still
  // step from it, and a field emptied and left goes back to it.
  const before = useRef(value);
  const base = () => before.current || today();
  const invalid = useRef(false);
  const tellInvalid = (next: boolean) => {
    if (invalid.current === next) return;
    invalid.current = next;
    onInvalid?.(next);
  };
  // Follow the value when it changes from outside (the picker, a reset) —
  // but never rewrite what is being typed.
  useEffect(() => {
    if (!focused.current) {
      before.current = value;
      setText(formatDateUS(value));
      setBad(false);
      tellInvalid(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  /** Tell the form what the text says, as it is typed and when it is left.
   *  Text that does not read as a date sends "". The form used to keep
   *  the last date that DID parse on the way, so typing 2/29/2027 passed
   *  through 2/29/20 and saved 2020-02-29 under a red field; "" is a date the
   *  forms refuse. Empty text is not a date being typed — the form gets back
   *  the date it had, so clearing the field and leaving changes nothing —
   *  unless the date is optional, when empty means no date. Returns the date
   *  read, "" for an optional field emptied, null for none. */
  function read(raw: string): string | null {
    const empty = raw.trim() === "";
    const parsed = empty ? (optional ? "" : before.current || null) : parseTypedDate(raw, base());
    tellInvalid(parsed === null && !empty);
    // Left unreadable, a field that commits on leaving keeps the form's date.
    if (parsed === null && commitOnLeave) return null;
    const next = parsed ?? "";
    if (next !== value) onChange(next);
    return parsed;
  }

  /** The caret leaves (or Enter): commit, and show the date the region's way. */
  function leave(raw: string) {
    const parsed = read(raw);
    setBad(parsed === null && raw.trim() !== "");
    if (parsed) {
      setText(formatDateUS(parsed));
      before.current = parsed;
    }
  }

  return (
    <span className="tm-datefield" style={width === undefined ? undefined : { width, display: "inline-flex", flexShrink: 0 }}>
      <input
        className={`${className}${bad ? " tm-datefield-bad" : ""}`}
        type="text"
        inputMode="numeric"
        aria-label={label}
        aria-invalid={bad || undefined}
        placeholder={datePattern()}
        autoComplete="off"
        autoFocus={autoFocus}
        readOnly={readOnly}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          // Commit as soon as what is typed reads as a date, so Tab / Enter
          // never carry a half-typed one — and as soon as it does not,
          // so they never carry a stale one. The text itself is left alone,
          // and the field turns red only when it is left.
          if (!commitOnLeave && read(e.target.value) !== null) setBad(false);
        }}
        onBlur={(e) => {
          focused.current = false;
          leave(e.target.value);
        }}
        onFocus={(e) => {
          focused.current = true;
          // A field left unreadable holds "" — keep the date it had before.
          if (value) before.current = value;
          e.target.select();
        }}
        onKeyDown={(e) => {
          if (readOnly) return;
          if (e.key === "Enter" && commitOnLeave) leave(e.currentTarget.value);
          const set = (next: string) => {
            e.preventDefault();
            setText(formatDateUS(next));
            setBad(false);
            tellInvalid(false);
            before.current = next;
            onChange(next);
          };
          // Where dates are written with "-" (Canada, the Netherlands) the key
          // is part of the date, so it steps back a day only when the whole
          // field is selected or empty; "_" always does.
          const el = e.currentTarget;
          const whole = el.value === "" || (el.selectionStart === 0 && el.selectionEnd === el.value.length);
          const dashTypes = currentRegion().date_sep === "-" && !whole;
          if (e.key === "+" || e.key === "=") set(shiftDays(base(), 1));
          else if (e.key === "_" || (e.key === "-" && !dashTypes)) set(shiftDays(base(), -1));
          else if (e.key === "t" || e.key === "T") set(today());
        }}
        title={title ?? `Type a date (${dateExamples()}). + and − step a day; T is today.`}
      />
      <input
        ref={pickerRef}
        type="date"
        className="tm-datefield-picker"
        aria-label={`${label} picker`}
        tabIndex={-1}
        value={value}
        onChange={(e) => {
          if (e.target.value) onChange(e.target.value);
        }}
      />
      <button
        type="button"
        className="tm-datefield-btn"
        tabIndex={-1}
        disabled={readOnly}
        aria-label={`Choose ${label.toLowerCase()} from a calendar`}
        title="Calendar"
        onClick={() => {
          const p = pickerRef.current;
          if (!p) return;
          const withPicker = p as HTMLInputElement & { showPicker?: () => void };
          if (typeof withPicker.showPicker === "function") withPicker.showPicker();
          else p.click();
        }}
      >
        ▾
      </button>
    </span>
  );
}
