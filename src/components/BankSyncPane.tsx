// Settings → Money → Bank sync: SimpleFIN.
//
// SimpleFIN Bridge is a paid service the user signs up for themselves. It
// hands out a setup token; T-Money claims it once and keeps what comes back
// in the computer's credential store. Nothing on this screen ever holds that
// credential — the backend reports the server's name and nothing more.
//
// Nothing is fetched on a timer. Each button press is one request, and
// SimpleFIN asks apps to stay under 24 a day, so the count is shown.
import { Fragment, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import TmIcon from "./TmIcon";
import Notice from "./Notice";
import DateField from "./DateField";
import { api } from "../lib/ipc";
import { currencyOf } from "../lib/currency";
import { formatDate, formatMoney, parseMoneyToCents } from "../lib/format";
import { isDebt, labelFor } from "../lib/accountTypes";
import { refreshUndo } from "../lib/undo";
import { useAccountStore } from "../stores/useAccountStore";
import type { Account, AccountType, SimplefinAccount, SimplefinStatus, SimplefinSync } from "../lib/types";

/** Shares, not cash: SimpleFIN cannot fill these. */
const NOT_FILLABLE = ["investment", "retirement", "employee_stock_option", "watch"];

/** The T-Money accounts a SimpleFIN account may fill: open, cash-like, in
 *  the same currency, and not already filled by another. */
export function fillable(sf: SimplefinAccount, accounts: Account[], all: SimplefinAccount[]): Account[] {
  const taken = new Set(all.filter((a) => a.sf_id !== sf.sf_id && a.account_id).map((a) => a.account_id));
  return accounts.filter(
    (a) =>
      (!a.is_closed || a.id === sf.account_id) &&
      !NOT_FILLABLE.includes(a.type) &&
      currencyOf(a) === sf.currency &&
      !taken.has(a.id)
  );
}

/** The Fills list's "make one" choice. Not an account id: ids are UUIDs. */
export const NEW_ACCOUNT = "__new__";

/** The kinds a new account made from a SimpleFIN account can be: the
 *  cash-like ones SimpleFIN fills. */
export const NEW_TYPES: AccountType[] = ["checking", "savings", "credit", "cash", "line_of_credit", "loan"];

/** A first guess at the kind from the bank's name for the account. */
export function guessType(name: string): AccountType {
  if (/card|visa|mastercard|amex|credit/i.test(name)) return "credit";
  if (/saving|money market/i.test(name)) return "savings";
  if (/loan/i.test(name)) return "loan";
  return "checking";
}

/** YYYY-MM-DD, `days` before today in local time. */
export function daysAgoIso(days: number, now = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The first fetch reaches back 88 days. An opening balance dated the day
 *  before heads the register instead of landing under the fetched rows. */
const OPENING_DAYS_BACK = 89;

/** Make a T-Money account for a SimpleFIN account, in its currency. The
 *  caller links it. */
function NewAccountForm({
  sf,
  busy,
  onCreate,
  onCancel,
}: {
  sf: SimplefinAccount;
  busy: boolean;
  onCreate: (name: string, type: AccountType, openingCents: number, openedOn: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(sf.name);
  const [type, setType] = useState<AccountType>(guessType(sf.name));
  const [opening, setOpening] = useState("");
  const [asOf, setAsOf] = useState(daysAgoIso(OPENING_DAYS_BACK));
  const [error, setError] = useState<string | null>(null);
  const owed = isDebt(type);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError("Give the account a name.");
      return;
    }
    const typed = opening.trim() === "" ? 0 : parseMoneyToCents(opening);
    if (typed === null) {
      setError(`"${opening}" is not an amount.`);
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
      setError(`Type a date the form can read, such as ${formatDate("2026-08-03")}.`);
      return;
    }
    // A debt is stored negative; what is owed is typed as a positive
    // number, as in the New Account wizard.
    await onCreate(name.trim(), type, owed ? -typed : typed, asOf);
  }

  return (
    <form className="space-y-2 py-2" aria-label={`New account for ${sf.name}`} onSubmit={(e) => void submit(e)}>
      <div className="flex flex-wrap items-center gap-3">
        <label className="inline-flex items-center gap-1">
          Name
          <input className="aero-field w-48" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="inline-flex items-center gap-1">
          Type
          <select className="aero-field" value={type} onChange={(e) => setType(e.target.value as AccountType)}>
            {NEW_TYPES.map((t) => (
              <option key={t} value={t}>
                {labelFor(t)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="inline-flex items-center gap-1">
          {owed ? "Amount you owed" : "Opening balance"}
          <input
            className="aero-field w-28 text-right"
            inputMode="decimal"
            placeholder="0.00"
            value={opening}
            onChange={(e) => setOpening(e.target.value)}
          />
        </label>
        <DateField label="Opening balance as of" value={asOf} onChange={setAsOf} width={130} />
      </div>
      <div className="text-slate-500">
        Optional: what the account held on that date. The date is set before the first fetch reaches back, so the
        opening balance sits at the top of the register. Kept in {sf.currency}.
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex gap-2">
        <button type="submit" className="aero-btn default" disabled={busy}>
          Create and link
        </button>
        <button type="button" className="aero-btn" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** What a long step is doing. `share` is how far through, 0..1, when that
 *  is known; null while waiting on SimpleFIN, which says nothing until it
 *  answers. */
export interface Progress {
  label: string;
  share: number | null;
}

/** The bar under the buttons while a step runs. A sweeping bar while the
 *  time is unknown, a filling one once accounts are being written. */
export function ProgressBar({ progress }: { progress: Progress }) {
  const pct = progress.share == null ? undefined : Math.round(progress.share * 100);
  return (
    <div className="space-y-1" aria-live="polite">
      <div
        className="tm-progress"
        role="progressbar"
        aria-label={progress.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        {pct == null ? (
          <div className="tm-progress-sweep" />
        ) : (
          <div className="tm-progress-fill" style={{ width: `${Math.max(4, pct)}%` }} />
        )}
      </div>
      <div className="text-slate-500">{progress.label}</div>
    </div>
  );
}

export default function BankSyncPane() {
  const accounts = useAccountStore((s) => s.accounts);
  const [status, setStatus] = useState<SimplefinStatus | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SimplefinSync | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const [messages, setMessages] = useState<string[]>([]);
  const [progress, setProgress] = useState<Progress | null>(null);
  /** The SimpleFIN account a new T-Money account is being made for. */
  const [creating, setCreating] = useState<string | null>(null);

  // The backend names each account as it starts writing it.
  useEffect(() => {
    // `.catch`: outside the app (a test, a preview) `listen` rejects.
    const stop = listen<{ done: number; total: number; account: string }>("tm://simplefin-progress", (e) => {
      const { done, total, account } = e.payload;
      setProgress({
        label: total > 1 ? `Importing ${account} (${done + 1} of ${total})…` : `Importing ${account}…`,
        share: total > 0 ? (done + 0.5) / total : null,
      });
    }).catch(() => null);
    return () => {
      void stop.then((off) => off?.());
    };
  }, []);

  useEffect(() => {
    api.simplefinStatus().then(setStatus, (e) => setError(String(e)));
    if (useAccountStore.getState().accounts.length === 0) void useAccountStore.getState().loadAccounts();
  }, []);

  /** Run a step; true when it worked. SimpleFIN's messages from the step
   *  stay on screen until the next one. `waiting` names a step that goes
   *  to SimpleFIN, for the progress bar. */
  async function run(op: () => Promise<SimplefinStatus>, waiting?: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    if (waiting) setProgress({ label: waiting, share: null });
    try {
      const s = await op();
      setStatus(s);
      setMessages(s.messages);
      return true;
    } catch (e) {
      setError(String(e));
      // A refused step can still have changed something (a request counted).
      api.simplefinStatus().then(setStatus, () => {});
      return false;
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  /** Make the account, then link it: two writes, and a failed link leaves
   *  an ordinary account that can be picked from the list. */
  async function createAndLink(sf: SimplefinAccount, name: string, type: AccountType, openingCents: number, openedOn: string) {
    setBusy(true);
    setError(null);
    let made: Account;
    try {
      made = await useAccountStore.getState().addAccount(name, type, openingCents, openedOn, sf.currency ?? undefined);
    } catch (e) {
      setError(String(e));
      setBusy(false);
      return;
    }
    if (await run(() => api.simplefinLink(sf.sf_id, made.id))) setCreating(null);
  }

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    if (!token.trim()) return;
    // Kept on a failure that happened before the claim, so it need not be
    // pasted again.
    if (await run(() => api.simplefinConnect(token.trim()), "Connecting to SimpleFIN…")) setToken("");
  }

  async function sync() {
    setBusy(true);
    setError(null);
    setResult(null);
    setMessages([]);
    const n = status?.accounts.filter((a) => a.account_id).length ?? 0;
    setProgress({ label: `Asking SimpleFIN for ${n === 1 ? "1 account" : `${n} accounts`}… This can take up to a minute.`, share: null });
    try {
      const r = await api.simplefinSync();
      setProgress({ label: "Updating the registers…", share: 1 });
      setResult(r);
      const store = useAccountStore.getState();
      await store.loadAccounts();
      if (store.selectedAccountId && r.lines.some((l) => l.account_id === store.selectedAccountId)) {
        await store.loadRegister(store.selectedAccountId);
      }
      await store.loadPayees();
      await store.loadCategories();
      await refreshUndo();
    } catch (e) {
      setError(String(e));
    } finally {
      api.simplefinStatus().then(setStatus, () => {});
      setBusy(false);
      setProgress(null);
    }
  }

  if (!status) {
    return (
      <div className="min-w-0 flex-1 p-3 text-[12px] text-slate-500">
        {error ? <Notice tone="error">{error}</Notice> : "Loading…"}
      </div>
    );
  }

  const spent = status.requests_today >= status.daily_limit;
  const linked = status.accounts.filter((a) => a.account_id).length;

  return (
    <div className="space-y-3 min-w-0 flex-1">
      <section className="aero-card">
        <div className="aero-card-title flex items-center gap-2">
          <TmIcon name="sync" size={15} /> Bank sync (SimpleFIN)
        </div>
        <div className="p-3 space-y-2 text-[12px]">
          {!status.connected ? (
            <>
              <div className="text-slate-500">
                SimpleFIN Bridge (bridge.simplefin.org) is a separate paid service that reads your US and Canadian
                bank accounts. Sign up there, connect your banks, and make a setup token. Paste it here and T-Money
                will fetch transactions whenever you ask — never on its own. SimpleFIN's fee is paid to SimpleFIN;
                T-Money stays free.
              </div>
              <div className="text-slate-500">
                The connection is kept in this computer's credential store, not in the file itself. Opened
                on another computer, the file needs connecting there.
              </div>
              <form className="space-y-2" onSubmit={connect}>
                <textarea
                  className="aero-field w-full font-mono"
                  rows={3}
                  aria-label="SimpleFIN setup token"
                  placeholder="Paste the setup token"
                  value={token}
                  spellCheck={false}
                  autoComplete="off"
                  disabled={busy}
                  onChange={(e) => setToken(e.target.value)}
                />
                <button type="submit" className="aero-btn default" disabled={busy || !token.trim()}>
                  {busy ? "Connecting…" : "Connect"}
                </button>
              </form>
            </>
          ) : (
            <>
              <div>
                Connected to <strong>{status.server ?? "SimpleFIN"}</strong>. Requests in the last 24 hours:{" "}
                <strong>
                  {status.requests_today} of {status.daily_limit}
                </strong>
                .
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="aero-btn default"
                  disabled={busy || spent || linked === 0}
                  title={
                    spent
                      ? "SimpleFIN allows about 24 requests a day; T-Money stops at 20. Try again later."
                      : linked === 0
                        ? "Link at least one account below first"
                        : undefined
                  }
                  onClick={() => void sync()}
                >
                  {busy ? "Working…" : "Get bank transactions"}
                </button>
                <button
                  type="button"
                  className="aero-btn"
                  disabled={busy || spent}
                  onClick={() => void run(api.simplefinRefreshAccounts, "Asking SimpleFIN which accounts there are…")}
                >
                  Check for new accounts
                </button>
                {confirmOff ? (
                  <>
                    <button
                      type="button"
                      className="aero-btn"
                      disabled={busy}
                      onClick={() => {
                        setConfirmOff(false);
                        setResult(null);
                        setMessages([]);
                        void run(api.simplefinDisconnect);
                      }}
                    >
                      Yes, disconnect
                    </button>
                    <button type="button" className="aero-btn" disabled={busy} onClick={() => setConfirmOff(false)}>
                      Keep it
                    </button>
                  </>
                ) : (
                  <button type="button" className="aero-btn" disabled={busy} onClick={() => setConfirmOff(true)}>
                    Disconnect
                  </button>
                )}
              </div>
              {confirmOff && (
                <div className="text-slate-500">
                  T-Money forgets the connection and the account links. Transactions already fetched stay. To connect
                  again you need a new setup token.
                </div>
              )}
            </>
          )}
          {progress && <ProgressBar progress={progress} />}
          {status.connected && spent && (
            <div className="text-slate-500">
              That is {status.daily_limit} requests in the last 24 hours, as many as T-Money makes. Each one frees up a
              day after it was made.
            </div>
          )}
          {messages.map((m, i) => (
            <Notice key={i} tone="error">
              SimpleFIN says: {m}
            </Notice>
          ))}
          {error && <Notice tone="error">{error}</Notice>}
        </div>
      </section>

      {status.accounts.length > 0 && (
        <section className="aero-card">
          <div className="aero-card-title flex items-center gap-2">
            <TmIcon name="accounts" size={15} /> Accounts
          </div>
          <div className="p-3 space-y-2 text-[12px]">
            <div className="text-slate-500">
              Pick the T-Money account each one fills, or choose New account… to make one. The first fetch reaches back 88 days; later ones start a few
              days before the last, and anything already in the register is skipped.
            </div>
            <table className="w-full" aria-label="SimpleFIN accounts">
              <thead>
                <tr className="text-left text-slate-500">
                  <th className="font-normal py-1">At the bank</th>
                  <th className="font-normal py-1 text-right">Bank balance</th>
                  <th className="font-normal py-1 pl-3">Fills</th>
                  <th className="font-normal py-1 pl-3">Last fetched</th>
                </tr>
              </thead>
              <tbody>
                {status.accounts.map((sf) => {
                  const choices = fillable(sf, accounts, status.accounts);
                  return (
                    <Fragment key={sf.sf_id}>
                    <tr className="border-t border-slate-200/60">
                      <td className="py-1">
                        {sf.org ? <span className="text-slate-500">{sf.org} · </span> : null}
                        {sf.name}
                      </td>
                      <td className="py-1 text-right tabular-nums">
                        {sf.balance_cents == null || !sf.currency
                          ? "—"
                          : formatMoney(sf.balance_cents, { currency: sf.currency })}
                      </td>
                      <td className="py-1 pl-3">
                        {sf.currency ? (
                          <select
                            className="aero-field"
                            aria-label={`T-Money account for ${sf.name}`}
                            value={creating === sf.sf_id ? NEW_ACCOUNT : (sf.account_id ?? "")}
                            disabled={busy}
                            onChange={(e) => {
                              if (e.target.value === NEW_ACCOUNT) {
                                setCreating(sf.sf_id);
                                return;
                              }
                              if (creating === sf.sf_id) setCreating(null);
                              void run(() => api.simplefinLink(sf.sf_id, e.target.value || null));
                            }}
                          >
                            <option value="">Not linked</option>
                            {/* The linked account, even before the account list has loaded. */}
                            {sf.account_id && !choices.some((a) => a.id === sf.account_id) && (
                              <option value={sf.account_id}>{sf.account_name ?? "Linked account"}</option>
                            )}
                            {choices.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.name}
                              </option>
                            ))}
                            {!sf.account_id && <option value={NEW_ACCOUNT}>New account…</option>}
                          </select>
                        ) : (
                          <span className="text-slate-500">Not a currency T-Money keeps</span>
                        )}
                      </td>
                      <td className="py-1 pl-3 text-slate-500">
                        {sf.synced_through ? formatDate(sf.synced_through) : "—"}
                      </td>
                    </tr>
                    {creating === sf.sf_id && (
                      <tr>
                        <td colSpan={4}>
                          <NewAccountForm
                            sf={sf}
                            busy={busy}
                            onCreate={(name, type, cents, on) => createAndLink(sf, name, type, cents, on)}
                            onCancel={() => setCreating(null)}
                          />
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {result && (
        <section className="aero-card" aria-label="Bank sync result">
          <div className="aero-card-title flex items-center gap-2">
            <TmIcon name="check" size={15} /> Fetched {formatDate(result.from)} to {formatDate(result.to)}
          </div>
          <div className="p-3 space-y-2 text-[12px]">
            {result.lines.map((l) => (
              <div key={l.account_id}>
                <strong>{l.account_name}</strong>:{" "}
                {l.error ?? (
                  <>
                    {l.imported} new
                    {l.matched > 0 && `, ${l.matched} matched to ones you entered`}, {l.duplicates} already there.
                    {l.bank_balance_cents != null && (
                      <>
                        {" "}
                        The bank says {formatMoney(l.bank_balance_cents, { currency: accountCurrency(accounts, l.account_id) })};
                        T-Money says {formatMoney(l.balance_cents, { currency: accountCurrency(accounts, l.account_id) })}.
                      </>
                    )}
                  </>
                )}
                {l.note && <div className="text-slate-500">{l.note}</div>}
              </div>
            ))}
            {result.unlinked > 0 && (
              <div className="text-slate-500">
                {result.unlinked === 1 ? "One account is" : `${result.unlinked} accounts are`} not linked, so nothing
                was fetched into {result.unlinked === 1 ? "it" : "them"}.
              </div>
            )}
            {result.messages.map((m, i) => (
              <Notice key={i} tone="error">
                SimpleFIN says: {m}
              </Notice>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function accountCurrency(accounts: Account[], id: string): string | null {
  const a = accounts.find((x) => x.id === id);
  return a ? currencyOf(a) : null;
}
