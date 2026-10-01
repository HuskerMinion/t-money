// Settings → Money → Home currency and region.
//
// The region only changes how numbers and dates are written, so it applies
// the moment it is picked. The home currency changes what every total is IN,
// so it asks what the accounts already in the old one are: the same money
// under the wrong label (relabel them, amounts untouched), or money really
// kept in the old currency (keep them, and convert at a rate). There is no
// default answer: either one guessed wrong changes every balance in the file.
import { useEffect, useState } from "react";
import TmIcon from "./TmIcon";
import Notice from "./Notice";
import { api } from "../lib/ipc";
import { CURRENCY_NAMES, currencyOf } from "../lib/currency";
import { formatDate, formatMoney } from "../lib/format";
import { REGIONS, useFileFormat, type Region } from "../lib/region";
import { useAccountStore } from "../stores/useAccountStore";
import { HOME_CHOICES } from "./NewFileFormatDialog";

const nameOf = (c: string) => CURRENCY_NAMES[c] ?? c;

interface Props {
  /** Open Money → Currencies, where missing rates are added or fetched. */
  onCurrencies?: () => void;
}

export default function HomeCurrencyPane({ onCurrencies }: Props) {
  const home = useFileFormat((s) => s.home);
  const region = useFileFormat((s) => s.region);
  const [next, setNext] = useState("");
  const [how, setHow] = useState<"relabel" | "keep" | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Currencies in use that have no rate in the home currency. */
  const [missing, setMissing] = useState<string[]>([]);

  // The backend's list is the authority; the built-in one is the same table,
  // and stands in if it cannot be read.
  const [regions, setRegions] = useState<Region[]>(REGIONS);
  useEffect(() => {
    api.listRegions().then(
      (r) => {
        if (r.length) setRegions(r);
      },
      () => {}
    );
  }, []);

  const target = next && next !== home ? next : "";

  async function changeRegion(code: string) {
    setBusy(true);
    setMsg(null);
    setError(null);
    try {
      useFileFormat.getState().setFormat(await api.setRegion(code));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function changeHome() {
    if (!target || !how) return;
    const old = home;
    setBusy(true);
    setMsg(null);
    setError(null);
    setMissing([]);
    try {
      const f = await api.setHomeCurrency(target, how === "relabel");
      useFileFormat.getState().setFormat(f);
      await useAccountStore.getState().loadAccounts();
      // Rates are quoted in the home currency, so the old ones no longer
      // count: every other currency in use needs one in the new home.
      const rates = await api.listExchangeRates();
      const used = new Set(
        useAccountStore
          .getState()
          .accounts.map((a) => currencyOf(a))
          .filter((c) => c !== f.home_currency)
      );
      const lacking = [...used].filter((c) => !rates.some((r) => r.currency === c)).sort();
      setMissing(lacking);
      setNext("");
      setHow(null);
      setMsg(
        how === "relabel"
          ? `The home currency is now ${f.home_currency}. Accounts that were in ${old} are now in ${f.home_currency}; no amount was changed.`
          : `The home currency is now ${f.home_currency}. Accounts in ${old} stay in ${old} and convert at its rate.`
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  // One block, the two cards stacked: the settings body lays its child
  // out as a single pane, and two loose cards were squeezed side by side.
  return (
    <div className="space-y-3 min-w-0 flex-1">
      <section className="aero-card">
        <div className="aero-card-title flex items-center gap-2">
          <TmIcon name="settings" size={15} /> Region
        </div>
        <div className="p-3 space-y-2 text-[12px]">
          <div className="text-slate-500">
            How this file writes numbers and dates. It is kept in the file, so it looks the same on any computer.
          </div>
          <label className="flex items-center gap-2">
            Region
            <select
              className="aero-field"
              aria-label="Region"
              value={region.code}
              disabled={busy}
              onChange={(e) => void changeRegion(e.target.value)}
            >
              {regions.map((r) => (
                <option key={r.code} value={r.code}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <div aria-label="Region preview">
            Amounts look like <strong>{formatMoney(123456)}</strong> and{" "}
            <strong>{formatMoney(-123456)}</strong>; dates like <strong>{formatDate("2026-08-30")}</strong>.
          </div>
        </div>
      </section>

      <section className="aero-card">
        <div className="aero-card-title flex items-center gap-2">
          <TmIcon name="investments" size={15} /> Home currency
        </div>
        <div className="p-3 space-y-2 text-[12px]">
          <div className="text-slate-500">
            The home currency is <strong>{home}</strong> ({nameOf(home)}). Totals, net worth, budgets and reports
            are in it, and exchange rates are quoted in it. Investment accounts are always kept in it.
          </div>
          <label className="flex items-center gap-2">
            Change it to
            <select
              className="aero-field"
              aria-label="New home currency"
              value={next}
              disabled={busy}
              onChange={(e) => {
                setNext(e.target.value);
                setHow(null);
              }}
            >
              <option value="">—</option>
              {HOME_CHOICES.filter((c) => c !== home).map((c) => (
                <option key={c} value={c}>
                  {c} — {nameOf(c)}
                </option>
              ))}
            </select>
          </label>
          {target && (
            <fieldset className="space-y-1">
              <legend>What are the accounts now in {home}?</legend>
              <label className="flex items-start gap-2">
                <input
                  type="radio"
                  name="tm-home-how"
                  checked={how === "relabel"}
                  onChange={() => setHow("relabel")}
                />
                <span>
                  My accounts are already in {target} — relabel them (amounts are not converted). Use this for a
                  file set up in {home} by mistake.
                </span>
              </label>
              <label className="flex items-start gap-2">
                <input type="radio" name="tm-home-how" checked={how === "keep"} onChange={() => setHow("keep")} />
                <span>
                  Keep them in {home} and convert at a rate. They become foreign accounts; totals convert them at
                  the {home} rate in {target}. Not possible while an investment account is in {home}. Budgets,
                  goals and other amounts that belong to no account are not converted: a budget of 500 becomes
                  500 in {target}.
                </span>
              </label>
            </fieldset>
          )}
          <button
            type="button"
            className="aero-btn"
            disabled={busy || !target || !how}
            onClick={() => void changeHome()}
          >
            {busy ? "Working…" : "Change home currency"}
          </button>
          {error && (
            <Notice tone="error" boxed className="mt-2">
              {error}
            </Notice>
          )}
          {msg && (
            <div role="status" className="mt-2">
              {msg}
            </div>
          )}
          {missing.length > 0 && (
            <Notice
              boxed
              className="mt-2"
              actions={
                onCurrencies && (
                  <button type="button" className="aero-btn !py-0 !px-2 text-[11px]" onClick={onCurrencies}>
                    Open Currencies
                  </button>
                )
              }
            >
              There is no rate in {home} for {missing.join(", ")} yet, so totals and reports that include those
              accounts cannot be worked out. Add the rates, or get today's, under Money → Currencies.
            </Notice>
          )}
        </div>
      </section>
    </div>
  );
}
