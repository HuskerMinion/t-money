// §102, rebuilt in §104 — Tools → Calculator (Ctrl+K).
//
// The first version was a tape and nothing else: type an amount, press Enter,
// it adds up. That is the right *core* — you are entering a transaction, the
// receipt has three numbers on it, and a running list is auditable where a
// calculator that has eaten your keystrokes is not — but as the whole thing it
// was, in a user's word, basic. You could not multiply four items at $12.99,
// take 8.5% off, or divide a bill three ways, and those are the arithmetic a
// register actually needs.
//
// So: a real four-function calculator with the tape kept beside it. Type into
// the entry, press an operator, type the next number — the way every desk
// calculator has worked — and each completed step is written to the tape as a
// line you can read back. The tape is the feature; the keypad is the way in.
//
// PERCENT is the operation people actually mean: on `100 + 8.5%` it gives
// 8.50 (a percentage OF the running value), not 0.085. That is what a till
// does and what a receipt means.
//
// MONEY IS INTEGER CENTS at the boundary — `parseMoneyToCents` in,
// `(cents/100).toFixed(2)` out. Inside, the arithmetic is done on a JS number,
// because division does not stay in cents (a third of $10 is not a whole
// number of cents) and pretending otherwise would round twice. The tape shows
// exactly what each step produced, so nothing is hidden.
import { useEffect, useRef, useState } from "react";
import Notice from "./Notice";
import { formatMoney, parseMoneyToCents } from "../lib/format";

interface Props {
  onClose: () => void;
}

type Op = "+" | "−" | "×" | "÷";

interface Line {
  /** What produced this line: the operator that was pending, or null for the
   *  first entry of a run. */
  op: Op | null;
  /** The number that was entered, in cents. */
  cents: number;
  /** The running total after applying it. */
  total: number;
}

const KEYS: string[][] = [
  ["7", "8", "9", "÷"],
  ["4", "5", "6", "×"],
  ["1", "2", "3", "−"],
  ["0", ".", "%", "+"],
];

/** Apply one step. Cents in, cents out; the intermediate is a number because
 *  division has to be. Division by zero never reaches here — `commit` refuses
 *  it first (§183). */
function apply(total: number, op: Op, value: number): number {
  switch (op) {
    case "+":
      return total + value;
    case "−":
      return total - value;
    case "×":
      // Both sides are cents, so the product is cents² — divide by 100 once.
      return Math.round((total * value) / 100);
    case "÷":
      return Math.round((total * 100) / value);
  }
}

export default function CalculatorDialog({ onClose }: Props) {
  const [lines, setLines] = useState<Line[]>([]);
  const [total, setTotal] = useState(0);
  const [pending, setPending] = useState<Op | null>(null);
  const [draft, setDraft] = useState("");
  /** True once a run has started, so the first number does not add to zero
   *  through an invisible "+". */
  const [started, setStarted] = useState(false);
  const [copied, setCopied] = useState(false);
  // §183 — a step that cannot be done. Dividing by zero used to keep the
  // total and write "÷ $0.00" to the tape as if it had happened, so the tape
  // — the thing you read back to check the sum — recorded a step with no
  // result. Now it is refused, nothing is written, and the ÷ stays pending
  // for a divisor that works.
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const tapeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    // Keep the newest line in view; a tape that scrolls away from you is a
    // tape you stop trusting.
    //
    // `scrollTop`, not `scrollTo` — the smooth-scroll API is not implemented
    // everywhere this renders, and an effect that throws takes the whole
    // dialog down with it (§102's boundary would catch it, which is not the
    // same as it being fine).
    const tape = tapeRef.current;
    if (tape) tape.scrollTop = tape.scrollHeight;
  }, [lines.length]);

  /** Commit whatever is typed, applying the pending operator. Returns the new
   *  running total so a caller can chain. */
  function commit(): number {
    const raw = draft.trim();
    if (raw === "") return total;
    const cents = parseMoneyToCents(raw);
    if (cents === null) return total;
    setDraft("");
    setCopied(false);
    if (!started) {
      setStarted(true);
      setTotal(cents);
      setLines((l) => [...l, { op: null, cents, total: cents }]);
      return cents;
    }
    const op = pending ?? "+";
    if (op === "÷" && cents === 0) {
      setError("Cannot divide by zero. Type another number, or press C to start over.");
      return total;
    }
    setError(null);
    const next = apply(total, op, cents);
    setTotal(next);
    setPending(null);
    setLines((l) => [...l, { op, cents, total: next }]);
    return next;
  }

  /** An operator: finish what is typed, then wait for the next number. */
  function operator(op: Op) {
    commit();
    setPending(op);
    inputRef.current?.focus();
  }

  /** Percent is of the RUNNING TOTAL, which is what a receipt means: 8.5%
   *  after 100.00 is 8.50, not 0.085. */
  function percent() {
    const cents = parseMoneyToCents(draft.trim());
    if (cents === null || !started) return;
    const part = Math.round((total * cents) / 10_000);
    setDraft((part / 100).toFixed(2));
    inputRef.current?.focus();
  }

  function clearAll() {
    setError(null);
    setLines([]);
    setTotal(0);
    setPending(null);
    setDraft("");
    setStarted(false);
    setCopied(false);
    inputRef.current?.focus();
  }

  function key(k: string) {
    if (k === "%") return percent();
    if (k === "+" || k === "−" || k === "×" || k === "÷") return operator(k);
    setDraft((d) => (k === "." && d.includes(".") ? d : d + k));
    inputRef.current?.focus();
  }

  return (
    <div className="tm-dialog" role="dialog" aria-label="Calculator" style={{ minWidth: 340, maxWidth: 400 }}>
      <div className="tm-dialog-title">Calculator</div>
      <div className="tm-dialog-body">
        <div ref={tapeRef} className="tm-tape" role="log" aria-label="Tape">
          {lines.length === 0 ? (
            <div className="text-[11px]" style={{ color: "var(--tm-ms-text-muted)" }}>
              Type a number, then an operator. Enter finishes the sum.
            </div>
          ) : (
            lines.map((l, i) => (
              <div key={i} className="tm-tape-line">
                <span style={{ width: 14 }}>{l.op ?? ""}</span>
                <span className="tabular-nums flex-1 text-right">{formatMoney(l.cents)}</span>
                <span
                  className="tabular-nums text-right"
                  style={{ width: 96, color: "var(--tm-ms-text-muted)" }}
                >
                  {formatMoney(l.total)}
                </span>
              </div>
            ))
          )}
        </div>

        <div className="tm-tape-total">
          <span>{pending ? `Total ${pending}` : "Total"}</span>
          <span className="tabular-nums font-bold">{formatMoney(total)}</span>
        </div>

        {error && (
          <Notice tone="error" boxed className="mt-2">
            {error}
          </Notice>
        )}

        <form
          className="pt-2"
          onSubmit={(e) => {
            e.preventDefault();
            commit();
          }}
        >
          <input
            ref={inputRef}
            className="aero-field w-full text-right"
            aria-label="Amount"
            inputMode="decimal"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // The operator keys work from the keyboard as they are written
              // on a keyboard, not as they are drawn on the buttons.
              const map: Record<string, Op> = { "+": "+", "-": "−", "*": "×", "/": "÷" };
              const op = map[e.key];
              if (op) {
                e.preventDefault();
                operator(op);
              } else if (e.key === "%") {
                e.preventDefault();
                percent();
              } else if (e.key === "Escape") {
                e.preventDefault();
                if (draft) setDraft("");
                else onClose();
              }
            }}
            placeholder="0.00"
          />
        </form>

        <div className="tm-calc-keys">
          {KEYS.map((row) =>
            row.map((k) => (
              <button
                key={k}
                type="button"
                className={`aero-btn tm-calc-key${/[+−×÷%]/.test(k) ? " op" : ""}`}
                onClick={() => key(k)}
              >
                {k}
              </button>
            ))
          )}
          <button type="button" className="aero-btn tm-calc-key wide" onClick={() => commit()}>
            =
          </button>
          <button
            type="button"
            className="aero-btn tm-calc-key"
            onClick={() => setDraft((d) => d.slice(0, -1))}
            aria-label="Backspace"
          >
            ⌫
          </button>
          <button type="button" className="aero-btn tm-calc-key" onClick={clearAll}>
            C
          </button>
        </div>

        <div className="flex justify-end gap-2 pt-3">
          <button
            className="aero-btn"
            type="button"
            disabled={!started}
            onClick={() => {
              // Bare digits, not "$1,234.56" — this is going into an amount
              // field, and a formatted string would have to be un-formatted
              // by whatever receives it.
              void navigator.clipboard
                ?.writeText((total / 100).toFixed(2))
                .then(() => setCopied(true))
                .catch(() => setCopied(false));
            }}
          >
            {copied ? "Copied" : "Copy total"}
          </button>
          <button className="aero-btn" type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
