// Record a loan payment — one transaction, split up to four ways.
//
// Interest is a category (it is spending). Principal is a transfer to the loan
// (it is debt repaid, and it is what makes the balance fall). Extra principal
// is a second transfer to the same loan, kept apart so a month paid ahead can
// be seen a year later. Escrow is a transfer to the escrow account, or a
// category if that is how you keep it. One transaction in the register,
// however many lines in its split — exactly what the bank's statement shows,
// which is the point: a $1,800 debit at the bank is a $1,800 row here, never
// two rows that happen to add up.
//
// THE NUMBERS ARE PROPOSED, NOT IMPOSED. The terms fill them in from the
// balance and the rate; the statement wins over both. Type over any of them
// and the totals and the resulting balance re-derive from what you typed —
// that is the whole reason the schedule is editable.
import { useEffect, useMemo, useState } from "react";
import DateField from "./DateField";
import Money from "./Money";
import { currencyOf } from "../lib/currency";
import { api } from "../lib/ipc";
import { noteChanged } from "../lib/undo";
import { formatAmountBare, formatDate, parseMoneyToCents, today } from "../lib/format";
import { useAccountStore } from "../stores/useAccountStore";
import type { Account } from "../lib/types";

interface Props {
  account: Account;
  onDone: () => void;
  onCancel: () => void;
}

export default function RecordPaymentDialog({ account, onDone, onCancel }: Props) {
  const accounts = useAccountStore((s) => s.accounts);

  const [loaded, setLoaded] = useState(false);
  const [hasTerms, setHasTerms] = useState(false);
  const [date, setDate] = useState(today());
  const [fromAccountId, setFromAccountId] = useState("");
  const [payee, setPayee] = useState(account.name);
  const [checkNumber, setCheckNumber] = useState("");
  const [interest, setInterest] = useState(() => formatAmountBare(0));
  const [principal, setPrincipal] = useState(() => formatAmountBare(0));
  const [escrow, setEscrow] = useState(() => formatAmountBare(0));
  const [extra, setExtra] = useState(() => formatAmountBare(0));
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const owed = -account.balance_cents;

  const cashAccounts = useMemo(
    () =>
      accounts.filter(
        (a) => a.id !== account.id && !a.is_closed && ["checking", "savings", "cash", "bank"].includes(a.type)
      ),
    [accounts, account.id]
  );
  // Only an account "Paid from" actually lists counts as chosen. The
  // terms remember a funding account, and when that account has since been
  // closed it was preselected anyway: hidden from the list (the select showed
  // "(choose)"), yet still the one the payment was written against. Derived
  // rather than checked once when the terms load, so a list that changes
  // under the dialog cannot leave a stale pick behind either.
  const paidFrom = cashAccounts.some((a) => a.id === fromAccountId) ? fromAccountId : "";

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const t = await api.getLoanTerms(account.id);
        if (!alive) return;
        setHasTerms(t !== null);
        if (t?.from_account_id) setFromAccountId(t.from_account_id);
        if (t) {
          const p = await api.nextLoanPayment(account.id, null);
          if (!alive) return;
          setInterest(formatAmountBare(p.interest_cents));
          setPrincipal(formatAmountBare(p.principal_cents));
          setEscrow(formatAmountBare(p.escrow_cents));
          setExtra(formatAmountBare(p.extra_principal_cents));
        }
      } catch (e) {
        if (alive) setError(String(e));
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [account.id]);

  const interestCents = parseMoneyToCents(interest);
  const principalCents = parseMoneyToCents(principal);
  const escrowCents = parseMoneyToCents(escrow);
  const extraCents = parseMoneyToCents(extra);
  const complete =
    interestCents !== null && principalCents !== null && escrowCents !== null && extraCents !== null;
  const total = complete ? interestCents + principalCents + escrowCents + extraCents : null;
  // Both principal lines come off the loan.
  const offTheLoan = (principalCents ?? 0) + (extraCents ?? 0);

  async function save() {
    // DateField sends "" for text it cannot read; say so here rather
    // than let the backend answer with a raw parse error.
    if (!date) {
      setError(`Type a date the form can read, such as ${formatDate("2026-08-03")}.`);
      return;
    }
    if (!complete || total === null) {
      setError("Interest, principal, escrow and extra principal all need to be amounts.");
      return;
    }
    if (interestCents < 0 || principalCents < 0 || escrowCents < 0 || extraCents < 0) {
      setError("None of the parts can be negative. A refund is an ordinary deposit.");
      return;
    }
    if (total === 0) {
      setError("A payment of nothing is not a payment.");
      return;
    }
    if (!paidFrom) {
      setError("Choose the account the payment comes out of.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.recordLoanPayment({
        accountId: account.id,
        fromAccountId: paidFrom,
        date,
        interestCents,
        principalCents,
        escrowCents,
        extraPrincipalCents: extraCents,
        payee: payee.trim() || account.name,
        checkNumber: checkNumber.trim() || null,
        notes: notes.trim() || null,
      });
      // A loan payment is one undo step ("record a loan payment"); the
      // Edit menu has to hear about it like every other recorded write.
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
      <div className="tm-dialog" role="dialog" aria-label="Record payment" style={{ minWidth: 460 }}>
        <div className="tm-dialog-title">Record payment — {account.name}</div>
        <div className="tm-dialog-body space-y-3 text-[12px]">
          {loaded && !hasTerms && (
            <div className="money-neg">
              This loan has no terms yet. Set the rate and payment first, so the split can be proposed.
            </div>
          )}

          <div className="grid grid-cols-2 gap-2 items-center">
            <label>Date</label>
            <DateField value={date} onChange={setDate} />

            <label htmlFor="rp-from">Paid from</label>
            <select id="rp-from" className="aero-field" value={paidFrom} onChange={(e) => setFromAccountId(e.target.value)}>
              <option value="">(choose)</option>
              {cashAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>

            <label htmlFor="rp-payee">Pay to</label>
            <input id="rp-payee" className="aero-field" value={payee} onChange={(e) => setPayee(e.target.value)} />

            <label htmlFor="rp-check">Check number</label>
            <input id="rp-check" className="aero-field" value={checkNumber} onChange={(e) => setCheckNumber(e.target.value)} />

            <label htmlFor="rp-interest">Interest</label>
            <input
              id="rp-interest"
              className="aero-field text-right"
              value={interest}
              onChange={(e) => setInterest(e.target.value)}
            />

            <label htmlFor="rp-principal">Principal</label>
            <input
              id="rp-principal"
              className="aero-field text-right"
              value={principal}
              autoFocus
              onChange={(e) => setPrincipal(e.target.value)}
            />

            <label htmlFor="rp-extra">Extra principal</label>
            <input
              id="rp-extra"
              className="aero-field text-right"
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
            />

            <label htmlFor="rp-escrow">Escrow</label>
            <input id="rp-escrow" className="aero-field text-right" value={escrow} onChange={(e) => setEscrow(e.target.value)} />

            <label htmlFor="rp-notes">Memo</label>
            <input id="rp-notes" className="aero-field" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>

          <div className="tm-text-muted">
            {total === null ? (
              "Type each part as it appears on the statement."
            ) : (
              <>
                Total payment <Money cents={total} tone="neutral" currency={currencyOf(account)} /> — one row in the register, for the amount the bank
                shows. Owed now <Money cents={owed} tone="neutral" currency={currencyOf(account)} />, and <Money cents={owed - offTheLoan} tone="neutral" currency={currencyOf(account)} />{" "}
                after this payment.
              </>
            )}
          </div>

          <div className="tm-text-muted">
            The statement's numbers win over ours — type over any part and everything re-derives from what you typed. Only
            the interest counts as spending; principal, extra principal and escrow are all transfers. Extra principal is a
            line of its own so a month paid ahead still shows as one payment here and as one payment at the bank.
          </div>

          {error && <div className="money-neg">{error}</div>}

          <div className="flex justify-end gap-2 pt-1">
            <button className="aero-btn default" type="button" disabled={busy || !loaded} onClick={() => void save()}>
              {busy ? "Saving…" : "Record"}
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
