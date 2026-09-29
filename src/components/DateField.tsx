// A date you can TYPE. The native date picker is a fine calendar and
// a poor keyboard: in WebView2 it takes the caret segment by segment and
// double-clicking it opens the popup. Money's date field was plain text
// with a few keys. So: a text field showing M/D/YYYY, parsed as you type
// (M/D, M/D/YY, M/D/YYYY, YYYY-MM-DD all accepted), with Money's shortcuts —
// + and − step a day, T is today — and a small ▾ that opens the native
// picker for anyone who wants the calendar.
import { useEffect, useRef, useState } from "react";
import { formatDateUS, today } from "../lib/format";

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
}

const pad = (n: number) => String(n).padStart(2, "0");

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** "8/3", "8/3/26", "8/3/2026", "08-03-2026", "2026-08-03" → ISO, else null.
 *  A two-digit year is 20xx; a missing year is the current one. */
export function parseTypedDate(text: string, base: string = today()): string | null {
  const t = text.trim();
  if (!t) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2}|\d{4}))?$/.exec(t);
  if (!m) return null;
  const y = m[3] === undefined ? Number(base.slice(0, 4)) : m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return iso(y, Number(m[1]), Number(m[2]));
}

export function shiftDays(isoDate: string, by: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(y, m - 1, d + by);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

export default function DateField({ value, onChange, label = "Date", className = "aero-field w-full", autoFocus, readOnly = false, title, onInvalid }: Props) {
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
   *  the date it had, so clearing the field and leaving changes nothing. */
  function read(raw: string): string | null {
    const parsed = raw.trim() === "" ? before.current || null : parseTypedDate(raw, base());
    const next = parsed ?? "";
    tellInvalid(parsed === null && raw.trim() !== "");
    if (next !== value) onChange(next);
    return parsed;
  }

  return (
    <span className="tm-datefield">
      <input
        className={`${className}${bad ? " tm-datefield-bad" : ""}`}
        type="text"
        inputMode="numeric"
        aria-label={label}
        aria-invalid={bad || undefined}
        placeholder="M/D/YYYY"
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
          if (read(e.target.value)) setBad(false);
        }}
        onBlur={(e) => {
          focused.current = false;
          const parsed = read(e.target.value);
          setBad(parsed === null && e.target.value.trim() !== "");
          if (parsed) {
            setText(formatDateUS(parsed));
            before.current = parsed;
          }
        }}
        onFocus={(e) => {
          focused.current = true;
          // A field left unreadable holds "" — keep the date it had before.
          if (value) before.current = value;
          e.target.select();
        }}
        onKeyDown={(e) => {
          if (readOnly) return;
          const set = (next: string) => {
            e.preventDefault();
            setText(formatDateUS(next));
            setBad(false);
            tellInvalid(false);
            before.current = next;
            onChange(next);
          };
          if (e.key === "+" || e.key === "=") set(shiftDays(base(), 1));
          else if (e.key === "-" || e.key === "_") set(shiftDays(base(), -1));
          else if (e.key === "t" || e.key === "T") set(today());
        }}
        title={title ?? "Type a date (8/3, 8/3/26 or 8/3/2026). + and − step a day; T is today."}
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
