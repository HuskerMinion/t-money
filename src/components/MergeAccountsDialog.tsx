// Money's "Merge duplicate accounts". One account survives; the other's
// transactions move into it and it is deleted. The dialog runs the merge as
// a dry run first so it can say exactly what will happen — rows moved, rows
// the survivor already had, transfers between the two that disappear — and
// then does it for real on "Merge".
import { useEffect, useState } from "react";
import { api } from "../lib/ipc";
import { formatMoney } from "../lib/format";
import { labelFor } from "../lib/accountTypes";
import { currencyOf, homeCurrency } from "../lib/currency";
import Notice from "./Notice";
import type { Account, MergeSummary } from "../lib/types";

interface Props {
  /** The account being merged away (the one the user picked "Merge" on). */
  from: Account;
  accounts: readonly Account[];
  onCancel: () => void;
  onMerged: (into: Account, summary: MergeSummary) => void;
}

export default function MergeAccountsDialog({ from, accounts, onCancel, onMerged }: Props) {
  // Only an account in the same currency: amounts move as they are, and the
  // backend refuses the rest.
  const currency = currencyOf(from);
  const candidates = accounts.filter((a) => a.id !== from.id && !a.is_closed && currencyOf(a) === currency);
  // Same type first, then same group name — the duplicate is usually a
  // second "Checking".
  const sorted = [...candidates].sort((a, b) => Number(b.type === from.type) - Number(a.type === from.type) || a.name.localeCompare(b.name));
  const [intoId, setIntoId] = useState(sorted[0]?.id ?? "");
  const [afterLast, setAfterLast] = useState(false);
  const [plan, setPlan] = useState<MergeSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const into = accounts.find((a) => a.id === intoId) ?? null;

  useEffect(() => {
    if (!intoId) return;
    let canceled = false;
    setPlan(null);
    setError(null);
    api
      .mergeAccounts(intoId, from.id, afterLast, true)
      .then((p) => {
        if (!canceled) setPlan(p);
      })
      .catch((e) => {
        if (!canceled) setError(String(e));
      });
    return () => {
      canceled = true;
    };
  }, [intoId, from.id, afterLast]);

  async function merge() {
    if (!into) return;
    setBusy(true);
    setError(null);
    try {
      const s = await api.mergeAccounts(into.id, from.id, afterLast, false);
      onMerged(into, s);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <div className="tm-dialog" role="dialog" aria-label="Merge accounts">
      <div className="tm-dialog-title">Merge accounts</div>
      <div className="tm-dialog-body space-y-2 text-[12px]">
        <p>
          Merge <strong>{from.name}</strong> into another account. Its transactions move there and <strong>{from.name}</strong> is deleted. Take a backup first if you are not sure.
        </p>
        {candidates.length === 0 ? (
          <p>There is no other open account{currency === homeCurrency() ? "" : ` in ${currency}`} to merge into.</p>
        ) : (
          <label className="block">
            Keep
            <select className="aero-field w-full" aria-label="Merge into" value={intoId} onChange={(e) => setIntoId(e.target.value)}>
              {sorted.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} — {labelFor(a.type)}, {formatMoney(a.balance_cents, { parens: true, currency })}
                </option>
              ))}
            </select>
          </label>
        )}
        {into && into.type !== from.type && (
          <p className="tm-text-muted">
            {from.name} is a {labelFor(from.type).toLowerCase()} account and {into.name} is {labelFor(into.type).toLowerCase()}. The rows still move; make sure that is what you want.
          </p>
        )}
        <fieldset className="space-y-1">
          <label className="flex items-center gap-1">
            <input type="radio" name="merge-mode" checked={!afterLast} onChange={() => setAfterLast(false)} />
            Move every transaction (rows {into ? into.name : "the kept account"} already has are skipped)
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" name="merge-mode" checked={afterLast} onChange={() => setAfterLast(true)} />
            Only transactions after {into ? into.name : "the kept account"}'s last one
          </label>
        </fieldset>
        {/* The shared refusal box, as every other refusal on the Account List. */}
        {error && (
          <Notice tone="error" boxed>
            {error}
          </Notice>
        )}
        {plan && into && (
          <div className="aero-card p-2" aria-label="What will happen">
            <div>
              <strong>{plan.moved}</strong> {plan.moved === 1 ? "transaction moves" : "transactions move"} into {into.name}.
            </div>
            {plan.duplicates > 0 && (
              <div>
                {plan.duplicates} already there ({plan.duplicates === 1 ? "the same date, amount and payee" : "same date, amount and payee"}) — skipped.
              </div>
            )}
            {plan.self_transfers > 0 && (
              <div>
                {plan.self_transfers} {plan.self_transfers === 1 ? "transfer" : "transfers"} between the two accounts removed from both sides.
              </div>
            )}
            {plan.left_behind > 0 && <div>{plan.left_behind} left behind and deleted with {from.name} (its opening balance{afterLast ? ", and rows on or before the last date" : ""}).</div>}
            {(plan.statements > 0 || plan.recurrences > 0 || plan.goals > 0) && (
              <div className="tm-text-muted">
                Also moved: {[plan.statements && `${plan.statements} statement${plan.statements === 1 ? "" : "s"}`, plan.recurrences && `${plan.recurrences} bill${plan.recurrences === 1 ? "" : "s"}`, plan.goals && `${plan.goals} goal${plan.goals === 1 ? "" : "s"}`].filter(Boolean).join(", ")}.
              </div>
            )}
            <div className="pt-1">
              {into.name} afterwards: <strong>{formatMoney(plan.balance_cents, { parens: true, currency })}</strong>
            </div>
          </div>
        )}
        <div className="flex justify-end gap-2 pt-3">
          <button className="aero-btn default" type="button" disabled={busy || !plan || !into} onClick={() => void merge()}>
            Merge
          </button>
          <button className="aero-btn" type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
