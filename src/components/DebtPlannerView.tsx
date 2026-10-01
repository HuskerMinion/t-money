// Money's Debt Reduction Planner, both sizes:
//
// - the mini planner: one debt, "how long at this payment?" or "how much a
//   month to be done by then?", with the schedule;
// - the full planner: every loan and card, one monthly budget, highest
//   rate first (cheapest) or smallest balance first (the snowball), with
//   each debt's payoff month and the total interest.
//
// Balances come from the accounts; rates and minimum payments are not on
// the account record, so they are typed here and kept in a per-file setting
// (`ui.debt_planner`). The arithmetic is src/lib/debt.ts — integer cents and
// basis points, nothing else.
//
// A debt's balance and minimum are in its own account's currency. The full
// plan adds them together, so it is in the home currency at today's rate; a debt in a
// currency with no rate is left out of it, and the page says so. The one-debt
// planner adds nothing and stays in the debt's own currency.
import { useEffect, useMemo, useRef, useState } from "react";
import TmIcon from "./TmIcon";
import Notice from "./Notice";
import { api } from "../lib/ipc";
import { formatMoney, parseMoneyToCents, today } from "../lib/format";
import { amortize, formatAprBp, inHome, monthAfter, parseAprBp, paymentFor, plan, type PlanOrder } from "../lib/debt";
import { currencyOf, homeCurrency, homeName, rateOf, symbolFor, toHome } from "../lib/currency";
import { currentRegion } from "../lib/region";
import { groupFor } from "../lib/accountTypes";
import { useAccountStore } from "../stores/useAccountStore";

const SETTING = "debt_planner";

interface Saved {
  rates: Record<string, { apr: string; min: string }>;
  budget: string;
  order: PlanOrder;
}

const EMPTY: Saved = { rates: {}, budget: "", order: "highest_rate" };

export default function DebtPlannerView() {
  const accounts = useAccountStore((s) => s.accounts);
  const loadAccounts = useAccountStore((s) => s.loadAccounts);
  const [saved, setSaved] = useState<Saved>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  // Mini planner.
  const [miniId, setMiniId] = useState("");
  const [miniMode, setMiniMode] = useState<"payment" | "months">("payment");
  const [miniPayment, setMiniPayment] = useState("");
  const [miniMonths, setMiniMonths] = useState("36");
  const [showSchedule, setShowSchedule] = useState(false);
  // A save that failed. The rates and the budget are saved on every
  // keystroke, and a failure used to be swallowed: the plan on screen looked
  // kept, and was gone the next time the planner opened.
  const [saveError, setSaveError] = useState<string | null>(null);
  // Only the newest save's answer counts. Saves go out one per keystroke, and
  // an early failure landing after a later success would put back an error
  // that is no longer true (or the other way round).
  const saveSeq = useRef(0);

  // Debts are the liability accounts: loans, mortgages, cards, lines of credit.
  const debts = useMemo(() => accounts.filter((a) => !a.is_closed && (groupFor(a.type) === "Credit Accounts" || a.type === "loan" || a.type === "mortgage" || a.type === "liability") && a.balance_cents < 0), [accounts]);

  useEffect(() => {
    void loadAccounts();
    api
      .getUiSetting(SETTING)
      .then((v) => {
        if (v) {
          try {
            const parsed = JSON.parse(v) as Partial<Saved>;
            setSaved({ ...EMPTY, ...parsed, rates: parsed.rates ?? {} });
          } catch {
            /* a bad setting is an empty one */
          }
        }
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [loadAccounts]);

  function update(next: Saved) {
    setSaved(next);
    if (!loaded) return;
    const mine = ++saveSeq.current;
    api
      .setUiSetting(SETTING, JSON.stringify(next))
      .then(() => {
        if (mine === saveSeq.current) setSaveError(null);
      })
      .catch((e) => {
        if (mine === saveSeq.current) setSaveError(String(e));
      });
  }
  function setRate(id: string, patch: Partial<{ apr: string; min: string }>) {
    const cur = saved.rates[id] ?? { apr: "", min: "" };
    update({ ...saved, rates: { ...saved.rates, [id]: { ...cur, ...patch } } });
  }

  useEffect(() => {
    if (!miniId && debts.length > 0) setMiniId(debts[0].id);
  }, [debts, miniId]);

  const parsed = debts.map((a) => {
    const r = saved.rates[a.id] ?? { apr: "", min: "" };
    return {
      id: a.id,
      name: a.name,
      balance_cents: -a.balance_cents,
      currency: currencyOf(a),
      rate_micro: rateOf(a),
      apr_bp: r.apr.trim() ? parseAprBp(r.apr) : 0,
      min_payment_cents: r.min.trim() ? parseMoneyToCents(r.min) : 0,
      aprBad: r.apr.trim() !== "" && parseAprBp(r.apr) === null,
      minBad: r.min.trim() !== "" && parseMoneyToCents(r.min) === null,
    };
  });
  const anyBad = parsed.some((d) => d.aprBad || d.minBad);
  const budgetCents = saved.budget.trim() ? parseMoneyToCents(saved.budget) : null;
  // In the home currency: the plan adds every debt and payment together.
  const home = inHome(parsed.map((d) => ({ id: d.id, name: d.name, balance_cents: d.balance_cents, apr_bp: d.apr_bp ?? 0, min_payment_cents: d.min_payment_cents ?? 0, currency: d.currency, rate_micro: d.rate_micro })));
  const leftOut = home.leftOut;
  const anyForeign = parsed.some((d) => d.currency !== homeCurrency());
  const zero = `0${currentRegion().decimal}00`;
  const fullPlan = useMemo(() => {
    if (anyBad || budgetCents === null) return null;
    return plan(home.debts, budgetCents, saved.order);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved, accounts, anyBad, budgetCents]);

  // Mini planner numbers.
  const mini = parsed.find((d) => d.id === miniId);
  const miniPaymentCents = miniPayment.trim() ? parseMoneyToCents(miniPayment) : null;
  const miniMonthsN = /^\d+$/.test(miniMonths.trim()) ? Number(miniMonths) : null;
  const miniResult = useMemo(() => {
    if (!mini || mini.aprBad) return null;
    const apr = mini.apr_bp ?? 0;
    if (miniMode === "payment") {
      if (miniPaymentCents === null) return null;
      return { kind: "payment" as const, ...amortize(mini.balance_cents, apr, miniPaymentCents), payment: miniPaymentCents };
    }
    if (miniMonthsN === null) return null;
    const p = paymentFor(mini.balance_cents, apr, miniMonthsN);
    if (p === null) return { kind: "months" as const, payment: null, months: null, total_interest_cents: 0, total_paid_cents: 0, schedule: [], never: false };
    return { kind: "months" as const, payment: p, ...amortize(mini.balance_cents, apr, p) };
  }, [mini, miniMode, miniPaymentCents, miniMonthsN]);

  const start = today();
  // The one-debt planner is in that debt's own currency.
  const mc = { currency: mini?.currency };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <section className="aero-card lg:col-span-3">
        <div className="aero-card-title flex items-center gap-2">
          <TmIcon name="calendar" size={15} /> Debt Reduction Planner
        </div>
        <div className="p-3 text-[12px] space-y-2">
          {debts.length === 0 ? (
            <p>No loans, mortgages or cards with a balance. Debts are the liability accounts in the account list.</p>
          ) : (
            <>
              <p className="tm-text-muted">
                Balances are from the accounts. Type each debt's rate and required monthly payment (they are kept with this file), then a monthly budget for all of them together. Minimums are paid on everything; the rest goes on the first debt in line, and each payoff rolls its payment onto the next.
                {anyForeign && ` Each minimum is in its debt's own currency; the budget and the plan are in ${homeName()}, at today's rates.`}
              </p>
              {leftOut.length > 0 && (
                <Notice boxed>
                  Left out of the plan: {leftOut.map((d) => `${d.name} (no ${d.currency} rate)`).join(", ")}. Add a rate in Settings → Currencies to count {leftOut.length === 1 ? "it" : "them"}.
                </Notice>
              )}
              <table className="tm-report-table w-full" aria-label="Debts">
                <thead>
                  <tr>
                    <th>Debt</th>
                    <th className="num">Owed</th>
                    <th className="num">Rate (APR)</th>
                    <th className="num">Minimum / month</th>
                    <th className="num">Paid off</th>
                    <th className="num">Interest{anyForeign ? ` (${homeName()})` : ""}</th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.map((d) => {
                    const r = saved.rates[d.id] ?? { apr: "", min: "" };
                    const pd = fullPlan?.debts.find((x) => x.id === d.id);
                    return (
                      <tr key={d.id}>
                        <td>{d.name}</td>
                        <td className="num">
                          {formatMoney(d.balance_cents, { currency: d.currency })}
                          {d.currency !== homeCurrency() && d.rate_micro !== 0 && <div className="tm-text-muted">≈ {formatMoney(toHome(d.balance_cents, d.rate_micro))}</div>}
                        </td>
                        <td className="num">
                          <input className={`aero-field text-right${d.aprBad ? " money-neg" : ""}`} style={{ width: 70 }} aria-label={`Rate for ${d.name}`} value={r.apr} placeholder={`6${currentRegion().decimal}5`} onChange={(e) => setRate(d.id, { apr: e.target.value })} />
                        </td>
                        <td className="num">
                          <input className={`aero-field text-right${d.minBad ? " money-neg" : ""}`} style={{ width: 90 }} aria-label={`Minimum payment for ${d.name}`} value={r.min} placeholder={d.currency === homeCurrency() ? zero : `${symbolFor(d.currency)}${zero}`} onChange={(e) => setRate(d.id, { min: e.target.value })} />
                        </td>
                        <td className="num" aria-label={`Payoff for ${d.name}`}>{d.rate_micro === 0 ? "not planned" : pd?.paid_off_month ? monthAfter(start, pd.paid_off_month) : fullPlan && !fullPlan.problem ? "—" : ""}</td>
                        <td className="num">{pd && !fullPlan?.problem ? formatMoney(pd.interest_cents) : ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="flex flex-wrap items-center gap-4 pt-1">
                <label className="inline-flex items-center gap-1">
                  Monthly budget for all debts{anyForeign ? ` (${homeName()})` : ""}
                  <input className="aero-field text-right" style={{ width: 100 }} aria-label="Monthly budget" value={saved.budget} placeholder={zero} onChange={(e) => update({ ...saved, budget: e.target.value })} />
                </label>
                <label className="inline-flex items-center gap-1">
                  Order
                  <select className="aero-field" aria-label="Payoff order" value={saved.order} onChange={(e) => update({ ...saved, order: e.target.value as PlanOrder })}>
                    <option value="highest_rate">Highest rate first (least interest)</option>
                    <option value="smallest_balance">Smallest balance first (the snowball)</option>
                  </select>
                </label>
                {fullPlan && (
                  <span className="font-bold" aria-label="Plan result">
                    {fullPlan.problem
                      ? fullPlan.problem.replace(/\((\d+) cents a month\)/, (_, c) => `(${formatMoney(Number(c))} a month)`)
                      : fullPlan.months === 0
                        ? "Nothing owed."
                        : fullPlan.months === null
                          ? "Not paid off within 100 years."
                          : `Debt-free in ${fullPlan.months} months (${monthAfter(start, fullPlan.months)}), ${formatMoney(fullPlan.total_interest_cents)} in interest.`}
                  </span>
                )}
                {!fullPlan && budgetCents === null && <span className="tm-text-muted">Enter the budget to see the plan.</span>}
              </div>
              {saveError && (
                <Notice tone="error" boxed>
                  Could not save the rates and budget with this file: {saveError}
                </Notice>
              )}
              {fullPlan && !fullPlan.problem && fullPlan.months !== null && fullPlan.minimums_cents > 0 && (
                <div className="tm-text-muted">
                  Minimums alone are {formatMoney(fullPlan.minimums_cents)} a month; the extra {formatMoney(fullPlan.budget_cents - fullPlan.minimums_cents)} is what shortens it.
                </div>
              )}
            </>
          )}
        </div>
      </section>

      <section className="aero-card lg:col-span-3">
        <div className="aero-card-title flex items-center gap-2">
          <TmIcon name="calendar" size={15} /> One debt at a time
        </div>
        <div className="p-3 text-[12px] space-y-2">
          {debts.length === 0 ? (
            <p>Nothing to plan.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-4">
                <label className="inline-flex items-center gap-1">
                  Debt
                  <select className="aero-field" aria-label="Debt" value={miniId} onChange={(e) => setMiniId(e.target.value)}>
                    {parsed.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name} — {formatMoney(d.balance_cents, { currency: d.currency })}{d.apr_bp ? ` at ${formatAprBp(d.apr_bp)}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="inline-flex items-center gap-1">
                  <input type="radio" name="mini-mode" checked={miniMode === "payment"} onChange={() => setMiniMode("payment")} />
                  Paying
                  <input className="aero-field text-right" style={{ width: 90 }} aria-label="Monthly payment" value={miniPayment} placeholder={mini && mini.currency !== homeCurrency() ? `${symbolFor(mini.currency)}${zero}` : zero} disabled={miniMode !== "payment"} onChange={(e) => setMiniPayment(e.target.value)} />
                  a month
                </label>
                <label className="inline-flex items-center gap-1">
                  <input type="radio" name="mini-mode" checked={miniMode === "months"} onChange={() => setMiniMode("months")} />
                  Done in
                  <input className="aero-field text-right" style={{ width: 50 }} aria-label="Months to pay off" value={miniMonths} disabled={miniMode !== "months"} onChange={(e) => setMiniMonths(e.target.value)} />
                  months
                </label>
              </div>
              {mini && !mini.apr_bp && !mini.aprBad && <div className="tm-text-muted">No rate entered for {mini.name} above — this assumes 0%.</div>}
              {miniResult && (
                <div className="font-bold" aria-label="Mini plan result">
                  {miniResult.never
                    ? `${formatMoney(miniResult.payment ?? 0, mc)} a month does not cover the interest — the balance would grow.`
                    : miniResult.payment === null
                      ? "That cannot be done in the time — the balance is more than the months allow."
                      : miniResult.months === null
                        ? "Not paid off within 100 years."
                        : miniResult.kind === "payment"
                          ? `Paid off in ${miniResult.months} months (${monthAfter(start, miniResult.months)}); ${formatMoney(miniResult.total_interest_cents, mc)} in interest, ${formatMoney(miniResult.total_paid_cents, mc)} in all.`
                          : `${formatMoney(miniResult.payment, mc)} a month; paid off ${monthAfter(start, miniResult.months)}, ${formatMoney(miniResult.total_interest_cents, mc)} in interest.`}
                </div>
              )}
              {miniResult && miniResult.schedule.length > 0 && (
                <>
                  <button type="button" className="tm-link" onClick={() => setShowSchedule((v) => !v)}>
                    {showSchedule ? "Hide the schedule" : "Show the schedule"}
                  </button>
                  {showSchedule && (
                    <div style={{ maxHeight: 260, overflowY: "auto" }}>
                      <table className="tm-report-table w-full" aria-label="Payment schedule">
                        <thead>
                          <tr>
                            <th>Month</th>
                            <th className="num">Interest</th>
                            <th className="num">Principal</th>
                            <th className="num">Balance</th>
                          </tr>
                        </thead>
                        <tbody>
                          {miniResult.schedule.map((r) => (
                            <tr key={r.month}>
                              <td>{monthAfter(start, r.month)}</td>
                              <td className="num">{formatMoney(r.interest_cents, mc)}</td>
                              <td className="num">{formatMoney(r.principal_cents, mc)}</td>
                              <td className="num">{formatMoney(r.balance_cents, mc)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
