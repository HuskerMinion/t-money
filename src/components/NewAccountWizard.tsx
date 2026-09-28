// "Add a new account" — Money's two-step wizard (§6.1g).
//
// Step 1 is a radio group of categories; step 2 is a list box filtered by that
// choice, with a description pane on the right. Step 3 collects the name and
// opening balance (Money asks for more — institution, account number — which
// this app does not model yet; see §10.1).
import { useState } from "react";
import {
  ACCOUNT_CATEGORIES,
  isDebt,
  typesForCategory,
  type AccountCategory,
  type AccountTypeInfo,
} from "../lib/accountTypes";
import { parseMoneyToCents } from "../lib/format";
import Notice from "./Notice";
import type { AccountType } from "../lib/types";

interface Props {
  onCreate: (
    name: string,
    type: AccountType,
    openingBalanceCents: number,
    openedOn: string
  ) => Promise<void>;
  onCancel: () => void;
}

/** Today as YYYY-MM-DD in local time, for the "as of" default. */
function todayIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export default function NewAccountWizard({ onCreate, onCancel }: Props) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [category, setCategory] = useState<AccountCategory>("banking");
  const [type, setType] = useState<AccountTypeInfo | null>(null);
  const [name, setName] = useState("");
  const [opening, setOpening] = useState("");
  const [asOf, setAsOf] = useState(todayIso());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choices = typesForCategory(category);
  const chosen = type && choices.some((c) => c.value === type.value) ? type : choices[0];
  // §120: a mortgage, a loan or a card asks what you OWE, not what you have.
  const owed = !!chosen && isDebt(chosen.value);

  async function finish() {
    if (!chosen) return;
    if (!name.trim()) {
      setError("Enter a name for the account.");
      return;
    }
    // A typo in the opening balance used to become $0 silently. Blank is
    // zero; "12x" is an error.
    const typed = opening.trim() === "" ? 0 : parseMoneyToCents(opening);
    if (typed === null) {
      setError(`"${opening}" is not an amount.`);
      return;
    }
    // §120 — a debt is stored NEGATIVE, and the wizard used to store whatever
    // was typed. Opening a mortgage at 150,000 made a $150,000 ASSET: the
    // sidebar showed it as money you have, net worth was out by twice the
    // mortgage, and every principal payment afterwards — a positive amount in
    // a loan account — made the number grow instead of shrink.
    //
    // Negated, not made-negative: someone with a credit balance on a card
    // types -500 and still gets +500, which is the one case a bare `-abs`
    // would take away from them.
    const cents = isDebt(chosen.value) ? -typed : typed;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
      setError("Enter the opening date as YYYY-MM-DD.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCreate(name.trim(), chosen.value, cents, asOf);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="tm-dialog" role="dialog" aria-label="Choose an account type">
      <div className="tm-dialog-title">Add a new account</div>
      <div className="tm-dialog-body">
        <h2 className="font-bold pb-2" style={{ color: "var(--tm-ms-text-heading)" }}>
          {step === 3 ? "Enter the account details" : "Choose an account type"}
        </h2>

        {step === 1 && (
          <fieldset className="p-3" style={{ background: "var(--tm-ms-card-body)" }}>
            <legend className="sr-only">Account category</legend>
            {ACCOUNT_CATEGORIES.map((c) => (
              <label key={c.value} className="flex items-center gap-2 py-1">
                <input
                  type="radio"
                  name="account-category"
                  value={c.value}
                  checked={category === c.value}
                  onChange={() => {
                    setCategory(c.value);
                    setType(null);
                  }}
                />
                {c.label}
              </label>
            ))}
          </fieldset>
        )}

        {step === 2 && (
          <div className="flex gap-3 p-3" style={{ background: "var(--tm-ms-card-body)" }}>
            <select
              size={10}
              className="aero-field"
              style={{ width: 260 }}
              aria-label="Account type"
              value={chosen?.value ?? ""}
              onChange={(e) =>
                setType(choices.find((c) => c.value === e.target.value) ?? null)
              }
            >
              {choices.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            <div className="flex-1">
              <div className="font-bold">{chosen?.label}</div>
              <p className="pt-1">{chosen?.description}</p>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="p-3 space-y-2" style={{ background: "var(--tm-ms-card-body)" }}>
            <div>
              Type: <strong>{chosen?.label}</strong>
            </div>
            <label className="flex items-center gap-2">
              <span style={{ width: 120 }}>Name:</span>
              <input
                className="aero-field flex-1"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Everyday Checking 1234"
                autoFocus
              />
            </label>
            <label className="flex items-center gap-2">
              <span style={{ width: 120 }}>{owed ? "Amount you owe:" : "Opening balance:"}</span>
              <input
                className="aero-field flex-1"
                aria-label={owed ? "Amount you owe" : "Opening balance"}
                value={opening}
                onChange={(e) => setOpening(e.target.value)}
                placeholder="0.00"
              />
            </label>
            {owed && (
              <div className="tm-text-muted" style={{ paddingLeft: 128 }}>
                Type what is still owed as a positive number — {chosen ? chosen.label.toLowerCase() : "this account"} is a
                debt, so it is held as a negative balance and counts against your net worth.
              </div>
            )}
            <label className="flex items-center gap-2">
              <span style={{ width: 120 }}>As of:</span>
              <input
                className="aero-field"
                type="date"
                aria-label="Opening balance as of"
                value={asOf}
                onChange={(e) => setAsOf(e.target.value)}
              />
            </label>
          </div>
        )}

        {/* §181 — the shared refusal box, as every other refusal on the Account List. */}
        {error && (
          <Notice tone="error" boxed>
            {error}
          </Notice>
        )}

        <div className="flex justify-end gap-2 pt-3">
          {step > 1 && (
            <button
              className="aero-btn"
              type="button"
              onClick={() => setStep((s) => (s === 3 ? 2 : 1))}
            >
              Back
            </button>
          )}
          {step < 3 ? (
            <button
              className="aero-btn default"
              type="button"
              onClick={() => setStep((s) => (s === 1 ? 2 : 3))}
            >
              Next &gt;
            </button>
          ) : (
            <button
              className="aero-btn default"
              type="button"
              onClick={() => void finish()}
              disabled={busy}
            >
              {busy ? "Creating…" : "Finish"}
            </button>
          )}
          <button className="aero-btn" type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
