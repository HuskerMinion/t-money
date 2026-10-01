// Update value — what a house or a car is worth now.
//
// Not "adjust by": you know the truck is worth $9,000, not that it fell $1,850
// since you last looked. The difference is worked out in the backend and
// written as a dated revaluation — a row that moves the balance and shows in
// Net worth and Net worth over time, but that no income, spending, payee or
// tax report ever counts. A house gaining $20,000 is not money you can spend,
// and counting it as income would bury a year of real spending.
//
// Backdating is the point, not an edge case: a value on each date is what
// makes the net-worth curve true instead of a flat line that jumps today.
import { useState } from "react";
import DateField from "./DateField";
import Money from "./Money";
import { api } from "../lib/ipc";
import { noteChanged } from "../lib/undo";
import { formatAmountBare, formatDate, parseMoneyToCents, today } from "../lib/format";
import { accountWorth } from "../lib/accountTypes";
import { currencyOf, isForeign } from "../lib/currency";
import type { Account } from "../lib/types";

interface Props {
  account: Account;
  onDone: () => void;
  onCancel: () => void;
}

export default function UpdateValueDialog({ account, onDone, onCancel }: Props) {
  const current = accountWorth(account);
  const currency = currencyOf(account);
  const [date, setDate] = useState(today());
  const [value, setValue] = useState(formatAmountBare(current));
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cents = parseMoneyToCents(value);
  const delta = cents === null ? null : cents - current;

  async function save() {
    // DateField sends "" for text it cannot read.
    if (!date) {
      setError(`Type a date the form can read, such as ${formatDate("2026-08-03")}.`);
      return;
    }
    if (cents === null) {
      setError("Type what it is worth now.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.setAccountValue(account.id, date, cents, notes.trim() || null);
      // "update a value" is an undo step; without this the Edit menu
      // kept offering whatever it offered before the revaluation.
      noteChanged();
      onDone();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <>
      <div className="tm-dialog-backdrop" onClick={busy ? undefined : onCancel} />
      <div className="tm-dialog" role="dialog" aria-label="Update value" style={{ minWidth: 420 }}>
        <div className="tm-dialog-title">Update value — {account.name}</div>
        <div className="tm-dialog-body space-y-3 text-[12px]">
          <div className="grid grid-cols-2 gap-2 items-center">
            <label>As of</label>
            <DateField value={date} onChange={setDate} />

            <label htmlFor="uv-value">It is now worth{isForeign(account) ? ` (${currency})` : ""}</label>
            <input
              id="uv-value"
              className="aero-field text-right"
              value={value}
              autoFocus
              onChange={(e) => setValue(e.target.value)}
            />

            <label htmlFor="uv-notes">Note</label>
            <input
              id="uv-notes"
              className="aero-field"
              placeholder="Kelley Blue Book, an appraisal, Zillow…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          <div className="tm-text-muted">
            Currently <Money cents={current} tone="neutral" currency={currency} />.{" "}
            {delta === null ? (
              "Type an amount."
            ) : delta === 0 ? (
              "No change — nothing will be written."
            ) : (
              <>
                This writes a {delta > 0 ? "rise" : "fall"} of <Money cents={Math.abs(delta)} tone="neutral" currency={currency} /> on that date.
              </>
            )}
          </div>

          <div className="tm-text-muted">
            A change in value counts in Net worth and Net worth over time, and in nothing else — it is not income and not spending.
          </div>

          {error && <div className="money-neg">{error}</div>}

          <div className="flex justify-end gap-2 pt-1">
            <button className="aero-btn default" type="button" disabled={busy} onClick={() => void save()}>
              {busy ? "Saving…" : "Save"}
            </button>
            <button className="aero-btn" type="button" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
