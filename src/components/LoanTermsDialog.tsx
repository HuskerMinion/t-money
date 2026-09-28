// Loan terms (§94) — the rate, the payment, and where each part of it goes.
//
// THE SCHEDULE IS A STARTING POINT, NOT THE TRUTH. Banks round differently,
// change escrow mid-year, apply a payment a day late and charge an extra day
// of interest. Everything here only proposes the split for the next payment;
// the Record payment dialog lets every number be typed over, and the loan's
// balance is whatever the payments actually applied.
//
// The preview below is computed in Rust, in cents, from the terms currently in
// the form — nothing is saved to preview it, and the opening balance is the
// real one. That is deliberate: the arithmetic that shows a schedule and the
// arithmetic that proposes a payment must be the same code, or the preview
// lies.
import { useEffect, useMemo, useState } from "react";
import DateField from "./DateField";
import Money from "./Money";
import CategorySelect from "./CategorySelect";
import { api } from "../lib/ipc";
import { formatAmountBare, formatDateUS, formatRate, parseMoneyToCents, parseRateToMicro, today } from "../lib/format";
import { useAccountStore } from "../stores/useAccountStore";
import type { Account, LoanPeriod, LoanTerms } from "../lib/types";

interface Props {
  account: Account;
  onDone: () => void;
  onCancel: () => void;
}

/** Where the escrow part of a payment goes. An account is money you still
 *  have, held by the bank; a category spends it the month it is paid. */
type EscrowTo = "account" | "category";

export default function LoanTermsDialog({ account, onDone, onCancel }: Props) {
  const accounts = useAccountStore((s) => s.accounts);
  const categories = useAccountStore((s) => s.categories);

  const [loaded, setLoaded] = useState(false);
  const [existing, setExisting] = useState(false);
  const [rate, setRate] = useState("");
  const [payment, setPayment] = useState("");
  const [escrow, setEscrow] = useState("0.00");
  const [extra, setExtra] = useState("0.00");
  const [escrowTo, setEscrowTo] = useState<EscrowTo>("account");
  const [escrowAccountId, setEscrowAccountId] = useState("");
  const [escrowCategoryId, setEscrowCategoryId] = useState("");
  const [interestCategoryId, setInterestCategoryId] = useState("");
  const [fromAccountId, setFromAccountId] = useState("");
  const [paymentDay, setPaymentDay] = useState("");
  const [firstDate, setFirstDate] = useState("");
  // §183 — the first payment date is optional, so "" alone cannot tell a
  // blank field from text DateField could not read; it reports the second.
  const [firstDateBad, setFirstDateBad] = useState(false);
  const [termMonths, setTermMonths] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<LoanPeriod[]>([]);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const owed = -account.balance_cents;

  // Accounts money can come out of, and accounts escrow can sit in. A loan
  // never pays itself, so it is not in either list.
  const cashAccounts = useMemo(
    () =>
      accounts.filter(
        (a) => a.id !== account.id && !a.is_closed && ["checking", "savings", "cash", "bank"].includes(a.type)
      ),
    [accounts, account.id]
  );

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const t = await api.getLoanTerms(account.id);
        if (!alive) return;
        if (t) {
          setExisting(true);
          setRate(formatRate(t.apr_micro));
          setPayment(formatAmountBare(t.payment_cents));
          setEscrow(formatAmountBare(t.escrow_cents));
          setExtra(formatAmountBare(t.extra_principal_cents));
          setEscrowTo(t.escrow_category_id && !t.escrow_account_id ? "category" : "account");
          setEscrowAccountId(t.escrow_account_id ?? "");
          setEscrowCategoryId(t.escrow_category_id ?? "");
          setInterestCategoryId(t.interest_category_id ?? "");
          setFromAccountId(t.from_account_id ?? "");
          setPaymentDay(t.payment_day === null ? "" : String(t.payment_day));
          setFirstDate(t.first_payment_date ?? "");
          setTermMonths(t.term_months === null ? "" : String(t.term_months));
          setNotes(t.notes ?? "");
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

  const aprMicro = parseRateToMicro(rate);
  const paymentCents = parseMoneyToCents(payment);
  const escrowCents = parseMoneyToCents(escrow);
  const extraCents = parseMoneyToCents(extra);

  /** The form as the backend wants it, or null while it is incomplete. */
  const terms: LoanTerms | null = useMemo(() => {
    if (aprMicro === null || paymentCents === null || escrowCents === null || extraCents === null) return null;
    if (aprMicro < 0 || paymentCents < 0 || escrowCents < 0 || extraCents < 0) return null;
    return {
      account_id: account.id,
      apr_micro: aprMicro,
      payment_cents: paymentCents,
      escrow_cents: escrowCents,
      extra_principal_cents: extraCents,
      escrow_account_id: escrowCents > 0 && escrowTo === "account" ? escrowAccountId || null : null,
      escrow_category_id: escrowCents > 0 && escrowTo === "category" ? escrowCategoryId || null : null,
      interest_category_id: interestCategoryId || null,
      from_account_id: fromAccountId || null,
      payment_day: paymentDay.trim() === "" ? null : Number(paymentDay),
      first_payment_date: firstDate || null,
      term_months: termMonths.trim() === "" ? null : Number(termMonths),
      notes: notes.trim() || null,
    };
  }, [
    account.id,
    aprMicro,
    paymentCents,
    escrowCents,
    extraCents,
    escrowTo,
    escrowAccountId,
    escrowCategoryId,
    interestCategoryId,
    fromAccountId,
    paymentDay,
    firstDate,
    termMonths,
    notes,
  ]);

  // Preview the next twelve payments as the numbers are typed. Debounced so a
  // rate being typed a digit at a time is one round trip, not five.
  useEffect(() => {
    if (!loaded || !terms || terms.payment_cents === 0) {
      setRows([]);
      return;
    }
    let alive = true;
    const id = setTimeout(() => {
      void (async () => {
        try {
          const s = await api.loanSchedule(account.id, firstDate || today(), 12, terms);
          if (!alive) return;
          setRows(s);
          setPreviewError(null);
        } catch (e) {
          if (alive) {
            setRows([]);
            setPreviewError(String(e));
          }
        }
      })();
    }, 250);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [loaded, terms, account.id, firstDate]);

  // Extra principal alone can retire a loan whose payment does not cover its
  // interest, so "this never pays off" has to look at both.
  const neverPaysOff =
    rows.length === 1 && rows[0].principal_cents === 0 && rows[0].extra_principal_cents === 0 && owed > 0;

  async function save() {
    if (!terms) {
      setError("A rate and a payment are needed, both as plain numbers.");
      return;
    }
    if (firstDateBad) {
      setError("Type a first payment date the form can read, such as 8/3/2026, or leave it blank.");
      return;
    }
    if (terms.escrow_cents > 0 && !terms.escrow_account_id && !terms.escrow_category_id) {
      setError("Say where the escrow part goes — an escrow account, or a category.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.setLoanTerms(terms);
      onDone();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  async function forget() {
    setBusy(true);
    setError(null);
    try {
      await api.clearLoanTerms(account.id);
      onDone();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <>
      <div className="tm-dialog-backdrop" onClick={busy ? undefined : onCancel} />
      <div className="tm-dialog" role="dialog" aria-label="Loan terms" style={{ minWidth: 680 }}>
        <div className="tm-dialog-title">Loan terms — {account.name}</div>
        <div className="tm-dialog-body space-y-3 text-[12px]">
          <div className="grid grid-cols-[130px_1fr_130px_1fr] gap-2 items-center">
            <label htmlFor="lt-rate">Interest rate %</label>
            <input
              id="lt-rate"
              className="aero-field text-right"
              value={rate}
              autoFocus
              placeholder="6.5"
              onChange={(e) => setRate(e.target.value)}
            />

            <label htmlFor="lt-payment">Payment (P&amp;I)</label>
            <input
              id="lt-payment"
              className="aero-field text-right"
              value={payment}
              placeholder="1,124.00"
              onChange={(e) => setPayment(e.target.value)}
            />

            <label htmlFor="lt-extra">Extra principal each month</label>
            <input
              id="lt-extra"
              className="aero-field text-right"
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
            />

            <label htmlFor="lt-escrow">Escrow each month</label>
            <input
              id="lt-escrow"
              className="aero-field text-right"
              value={escrow}
              onChange={(e) => setEscrow(e.target.value)}
            />

            <label htmlFor="lt-escrow-to">Escrow goes to</label>
            <select
              id="lt-escrow-to"
              className="aero-field"
              value={escrowTo}
              disabled={(escrowCents ?? 0) === 0}
              onChange={(e) => setEscrowTo(e.target.value as EscrowTo)}
            >
              <option value="account">An escrow account</option>
              <option value="category">A category</option>
            </select>

            {escrowTo === "account" ? (
              <>
                <label htmlFor="lt-escrow-acct">Escrow account</label>
                <select
                  id="lt-escrow-acct"
                  className="aero-field"
                  value={escrowAccountId}
                  disabled={(escrowCents ?? 0) === 0}
                  onChange={(e) => setEscrowAccountId(e.target.value)}
                >
                  <option value="">(choose)</option>
                  {accounts
                    .filter((a) => a.id !== account.id && !a.is_closed)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </select>
              </>
            ) : (
              <>
                <label>Escrow category</label>
                <CategorySelect
                  categories={categories}
                  value={escrowCategoryId}
                  onChange={setEscrowCategoryId}
                  kind="expense"
                  label="Escrow category"
                  disabled={(escrowCents ?? 0) === 0}
                />
              </>
            )}

            <label>Interest category</label>
            <CategorySelect
              categories={categories}
              value={interestCategoryId}
              onChange={setInterestCategoryId}
              kind="expense"
              label="Interest category"
            />

            <label htmlFor="lt-from">Usually paid from</label>
            <select id="lt-from" className="aero-field" value={fromAccountId} onChange={(e) => setFromAccountId(e.target.value)}>
              <option value="">(choose)</option>
              {cashAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>

            <label htmlFor="lt-day">Payment day</label>
            <input
              id="lt-day"
              className="aero-field text-right"
              value={paymentDay}
              placeholder="1"
              onChange={(e) => setPaymentDay(e.target.value.replace(/[^\d]/g, "").slice(0, 2))}
            />

            <label>First payment</label>
            <DateField value={firstDate} onChange={setFirstDate} onInvalid={setFirstDateBad} />

            <label htmlFor="lt-term">Term (months)</label>
            <input
              id="lt-term"
              className="aero-field text-right"
              value={termMonths}
              placeholder="360"
              onChange={(e) => setTermMonths(e.target.value.replace(/[^\d]/g, "").slice(0, 4))}
            />

            <label htmlFor="lt-notes">Note</label>
            <input id="lt-notes" className="aero-field" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>

          <div className="tm-text-muted">
            Owed now: <Money cents={owed} tone="neutral" />. These terms only propose how the next payment divides — when
            you record one, every part of it can be typed over, and the balance follows what you actually applied. Extra
            principal is paid on top of the payment and comes straight off the balance, so the schedule below is the payoff
            you are actually driving toward, not the lender's original one.
          </div>

          <div>
            <div className="font-bold pb-1">Next twelve payments</div>
            {previewError ? (
              <div className="money-neg">{previewError}</div>
            ) : rows.length === 0 ? (
              <div className="tm-text-muted">Type a rate and a payment to see the schedule.</div>
            ) : (
              <div style={{ maxHeight: 190, overflowY: "auto" }}>
                <table className="tm-report-table w-full" aria-label="Amortization schedule">
                  <thead>
                    <tr>
                      <th className="text-left">Date</th>
                      <th className="text-right">Payment</th>
                      <th className="text-right">Interest</th>
                      <th className="text-right">Principal</th>
                      <th className="text-right">Extra</th>
                      <th className="text-right">Escrow</th>
                      <th className="text-right">Balance after</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.date}>
                        <td>{formatDateUS(r.date)}</td>
                        <td className="text-right">
                          {formatAmountBare(r.payment_cents + r.escrow_cents + r.extra_principal_cents)}
                        </td>
                        <td className="text-right">{formatAmountBare(r.interest_cents)}</td>
                        <td className="text-right">{formatAmountBare(r.principal_cents)}</td>
                        <td className="text-right">{formatAmountBare(r.extra_principal_cents)}</td>
                        <td className="text-right">{formatAmountBare(r.escrow_cents)}</td>
                        <td className="text-right">{formatAmountBare(r.closing_cents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {neverPaysOff && (
              <div className="money-neg pt-1">
                At this rate the payment does not cover the interest, so the balance never falls. Check the rate and the
                payment.
              </div>
            )}
          </div>

          {error && <div className="money-neg">{error}</div>}

          <div className="flex justify-end gap-2 pt-1">
            <button className="aero-btn default" type="button" disabled={busy} onClick={() => void save()}>
              {busy ? "Saving…" : "Save"}
            </button>
            {existing && (
              <button className="aero-btn" type="button" disabled={busy} onClick={() => void forget()}>
                Remove terms
              </button>
            )}
            <button className="aero-btn" type="button" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
