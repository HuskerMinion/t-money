// "Add a new account" — Money's two-step wizard.
//
// Step 1 is a radio group of categories; step 2 is a list box filtered by that
// choice, with a description pane on the right. Step 3 collects the name and
// opening balance (Money asks for more — institution, account number — which
// this app does not model yet), and the currency the account is kept in.
import { useEffect, useState } from "react";
import {
  ACCOUNT_CATEGORIES,
  isDebt,
  typesForCategory,
  type AccountCategory,
  type AccountTypeInfo,
} from "../lib/accountTypes";
import { formatAmountBare, formatDate, parseMoneyToCents } from "../lib/format";
import { CURRENCY_NAMES, formatRate, homeCurrency, homeName, rateForBackend, symbolFor } from "../lib/currency";
import { api } from "../lib/ipc";
import Notice from "./Notice";
import DateField from "./DateField";
import type { AccountType, Currency, ExchangeRate } from "../lib/types";

/** Types the backend keeps in the home currency: share prices are in it,
 *  so holdings are too. */
const HOME_ONLY: AccountType[] = ["investment", "retirement", "employee_stock_option", "watch"];

interface Props {
  onCreate: (
    name: string,
    type: AccountType,
    openingBalanceCents: number,
    openedOn: string,
    currency: string
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
  const home = homeCurrency();
  const [currency, setCurrency] = useState(home);
  // Typed "1 EUR = ____ <home>", for a currency with no rate yet.
  const [rateText, setRateText] = useState("");
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [rates, setRates] = useState<ExchangeRate[]>([]);
  const [fetching, setFetching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Without the list only the home currency is offered, which is still a working
    // wizard; the refusal is said.
    api.listCurrencies().then(setCurrencies, (e) => setError(String(e)));
    api.listExchangeRates().then(setRates, () => {});
  }, []);

  const choices = typesForCategory(category);
  const chosen = type && choices.some((c) => c.value === type.value) ? type : choices[0];
  // A mortgage, a loan or a card asks what you OWE, not what you have.
  const owed = !!chosen && isDebt(chosen.value);
  const foreignAllowed = !!chosen && !HOME_ONLY.includes(chosen.value);
  const code = foreignAllowed ? currency : home;
  const foreign = code !== home;
  // The newest rate on file for the chosen currency, if any.
  const latest = rates
    .filter((r) => r.currency === code)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  const needsRate = foreign && !latest;
  const sym = foreign ? ` (${symbolFor(code)})` : "";

  // Explicit only: nothing is fetched unless this is pressed.
  async function fetchRate() {
    setFetching(true);
    setError(null);
    try {
      const s = await api.fetchExchangeRates([code]);
      const got = await api.listExchangeRates();
      setRates(got);
      if (s.failures.length > 0 && !got.some((r) => r.currency === code)) {
        setError(s.failures.map((f) => (f.symbol ? `${f.symbol}: ${f.reason}` : f.reason)).join(" · "));
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setFetching(false);
    }
  }

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
    // A debt is stored NEGATIVE, and the wizard used to store whatever
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
      setError(`Type an opening date the form can read, such as ${formatDate("2026-08-03")}.`);
      return;
    }
    if (needsRate && !rateText.trim()) {
      setError(`Enter what 1 ${code} is worth in ${homeName()}, or press Get today's rate.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // The backend refuses an account in a currency with no rate, so the
      // rate goes in first. The backend checks the number.
      if (needsRate) {
        await api.setExchangeRate(code, asOf, rateForBackend(rateText));
        setRates(await api.listExchangeRates());
      }
      await onCreate(name.trim(), chosen.value, cents, asOf, code);
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
            {foreignAllowed && (
              <label className="flex items-center gap-2">
                <span style={{ width: 120 }}>Currency:</span>
                <select
                  className="aero-field"
                  aria-label="Currency"
                  value={code}
                  onChange={(e) => {
                    setCurrency(e.target.value);
                    setRateText("");
                  }}
                >
                  {(currencies.length ? currencies : [{ code: home, name: CURRENCY_NAMES[home] ?? home }]).map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code} — {c.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {foreign && latest && (
              <div className="tm-text-muted" style={{ paddingLeft: 128 }}>
                1 {code} = {formatRate(latest.rate_micro)} {home} (rate of {formatDate(latest.date)}). Totals across
                accounts are in {homeName()}. Rates are kept under Settings → Money → Currencies.
              </div>
            )}
            {needsRate && (
              <>
                <div className="flex items-center gap-2">
                  <span style={{ width: 120 }}>Exchange rate:</span>
                  <span>1 {code} =</span>
                  <input
                    className="aero-field"
                    style={{ width: 100 }}
                    aria-label={`${home} per ${code}`}
                    value={rateText}
                    onChange={(e) => setRateText(e.target.value)}
                    placeholder={formatRate(1_087_500)}
                  />
                  <span>{home}</span>
                  <button className="aero-btn" type="button" onClick={() => void fetchRate()} disabled={fetching}>
                    {fetching ? "Fetching…" : "Get today's rate"}
                  </button>
                </div>
                <div className="tm-text-muted" style={{ paddingLeft: 128 }}>
                  There is no rate for {code} yet. Totals across accounts are in {homeName()}, so one is
                  needed. Get today's rate looks it up online; nothing else is sent.
                </div>
              </>
            )}
            <label className="flex items-center gap-2">
              <span style={{ width: 120 }}>{owed ? `Amount you owe${sym}:` : `Opening balance${sym}:`}</span>
              <input
                className="aero-field flex-1"
                aria-label={owed ? "Amount you owe" : "Opening balance"}
                value={opening}
                onChange={(e) => setOpening(e.target.value)}
                placeholder={formatAmountBare(0)}
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
              <DateField label="Opening balance as of" value={asOf} onChange={setAsOf} width={130} />
            </label>
          </div>
        )}

        {/* The shared refusal box, as every other refusal on the Account List. */}
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
