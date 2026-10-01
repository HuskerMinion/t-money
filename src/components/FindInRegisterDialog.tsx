// Find, in a register. Money's Edit → Find opens a small window OVER
// the register: type something, choose which field to look in (or any), and
// the rows that match are listed; click one and the register behind selects
// it and scrolls to it; close the window and the selection stays where you
// put it. That is the difference from the header search, which opens a
// screen of its own across every account and comes back to the register when
// a hit is chosen. This is for "where is that check" while you are already
// looking at the account.
//
// It searches the rows the register is SHOWING — the view's filter and dates
// apply — so every match can be selected and scrolled to. Matching is a
// case-insensitive substring on the field's text; an amount matches its
// magnitude exactly, so "340" finds the $340.00 payment and the $340.00
// deposit and not $1,340.00; a date matches the way it is shown (7/4/2026)
// or as typed (2026-07-04).
import { useEffect, useRef, useState } from "react";
import { formatDateUS, formatMoney, formatScaled, parseMoneyToCents } from "../lib/format";
import type { RegisterRow } from "../lib/types";

export type FindField = "any" | "payee" | "category" | "memo" | "num" | "amount" | "date";

export const FIND_FIELDS: readonly { value: FindField; label: string }[] = [
  { value: "any", label: "Any field" },
  { value: "payee", label: "Payee" },
  { value: "category", label: "Category" },
  { value: "memo", label: "Memo" },
  { value: "num", label: "Num" },
  { value: "amount", label: "Amount" },
  { value: "date", label: "Date" },
];

/** What a row says in each field, for matching and for the results table. */
export function categoryText(row: RegisterRow): string {
  if (row.transfer_account_name) return `Transfer : ${row.transfer_account_name}`;
  if (row.security_name) return row.security_name;
  return row.category_name ?? "";
}

function has(hay: string | null | undefined, needle: string): boolean {
  return !!hay && hay.toLowerCase().includes(needle);
}

/** The rows of `rows` that match `query` in `field`, in register order. */
export function findInRegister(rows: readonly RegisterRow[], query: string, field: FindField): RegisterRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const cents = parseMoneyToCents(query.trim());
  const magnitude = cents === null ? null : Math.abs(cents);
  return rows.filter((r) => {
    const byAmount = magnitude !== null && Math.abs(r.amount_cents) === magnitude;
    const byDate = has(formatDateUS(r.date), q) || has(r.date, q);
    switch (field) {
      case "payee":
        return has(r.payee, q);
      case "category":
        return has(categoryText(r), q);
      case "memo":
        return has(r.notes, q);
      case "num":
        return has(r.check_number, q);
      case "amount":
        return byAmount;
      case "date":
        return byDate;
      default:
        return has(r.payee, q) || has(categoryText(r), q) || has(r.notes, q) || has(r.check_number, q) || byAmount || byDate;
    }
  });
}

interface Props {
  accountName: string;
  /** The account's currency; omitted, the home currency. */
  currency?: string;
  /** The register as shown, so a hit is always a row that can be reached. */
  rows: readonly RegisterRow[];
  /** The row the register currently has selected, if any — shown as the
   *  current hit so Find next moves on from it. */
  selectedId: string | null;
  /** Select this row in the register and scroll to it. The window stays. */
  onPick: (id: string) => void;
  onClose: () => void;
}

export default function FindInRegisterDialog({ accountName, currency, rows, selectedId, onPick, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [field, setField] = useState<FindField>("any");
  const inputRef = useRef<HTMLInputElement>(null);
  const matches = findInRegister(rows, query, field);
  const at = matches.findIndex((m) => m.id === selectedId);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  /** Enter, or Find next: the match after the selected one, wrapping. */
  function next() {
    if (matches.length === 0) return;
    const to = matches[(at + 1) % matches.length];
    onPick(to.id);
  }

  return (
    <div
      className="tm-dialog tm-find"
      role="dialog"
      aria-label="Find in this register"
      style={{ minWidth: 620, width: "min(820px, 92vw)" }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="tm-dialog-title flex items-center gap-2">
        <span className="flex-1">Find — {accountName}</span>
        <button className="aero-btn !py-0 !px-2 text-[11px] font-normal" type="button" onClick={onClose} aria-label="Close find">
          ✕
        </button>
      </div>
      <div className="tm-dialog-body space-y-2 text-[12px]">
        <div className="flex items-center gap-2 flex-wrap">
          <label htmlFor="tm-find-what">Find:</label>
          <input
            id="tm-find-what"
            ref={inputRef}
            className="aero-field"
            style={{ width: 260 }}
            placeholder="Payee, category, memo, number, amount or date"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                next();
              }
            }}
          />
          <label htmlFor="tm-find-field">in</label>
          <select id="tm-find-field" className="aero-field" value={field} onChange={(e) => setField(e.target.value as FindField)}>
            {FIND_FIELDS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
          <button className="aero-btn default" type="button" onClick={next} disabled={matches.length === 0} title="Enter">
            Find next
          </button>
          <span className="tm-text-muted" aria-live="polite">
            {query.trim() === ""
              ? `${formatScaled(rows.length, 0)} rows shown`
              : matches.length === 0
                ? "No match"
                : `${formatScaled(matches.length, 0)} ${matches.length === 1 ? "match" : "matches"}${at >= 0 ? ` — on ${at + 1}` : ""}`}
          </span>
        </div>
        {matches.length > 0 && (
          <div className="overflow-auto" style={{ maxHeight: "40vh" }}>
            <table className="register-table" aria-label="Matches">
              <thead>
                <tr>
                  <th style={{ width: 80 }}>Date</th>
                  <th style={{ width: 60 }}>Num</th>
                  <th>Payee</th>
                  <th>Category</th>
                  <th>Memo</th>
                  <th className="num" style={{ width: 100 }}>
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {matches.map((r) => (
                  <tr
                    key={r.id}
                    data-find-id={r.id}
                    className={[r.id === selectedId ? "active" : "", r.is_void ? "voided" : ""].filter(Boolean).join(" ") || undefined}
                    aria-selected={r.id === selectedId}
                    style={{ cursor: "pointer" }}
                    tabIndex={0}
                    aria-label={`Go to ${r.payee} on ${formatDateUS(r.date)}`}
                    onClick={() => onPick(r.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        onPick(r.id);
                      }
                    }}
                  >
                    <td className="whitespace-nowrap">{formatDateUS(r.date)}</td>
                    <td>{r.check_number ?? ""}</td>
                    <td>{r.payee}</td>
                    <td>{categoryText(r)}</td>
                    <td className="tm-text-muted">{r.notes ?? ""}</td>
                    <td className={`num${r.amount_cents < 0 ? " money-neg" : ""}`}>{formatMoney(r.amount_cents, { currency })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button className="aero-btn" type="button" onClick={onClose} title="Esc — the selected transaction stays selected">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
