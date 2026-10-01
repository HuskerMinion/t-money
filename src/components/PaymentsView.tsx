// Bills — scheduled money in and out, and where the balance is heading.
//
// Two panels:
//
//   1. **Upcoming** — every occurrence in the horizon, resolved against what
//      actually happened. A bill paid by hand shows as `matched` rather than
//      nagging, because the register already has it.
//   2. **Forecast** — one account's balance projected across the horizon, with
//      the low point called out. That number is the reason a cash-flow
//      forecast exists: not "what will I have at the end", but "how close to
//      the floor do I get, and when".
//
// This replaced the one-off payments screen. Migration 0019 folded those rows
// into recurrence rules, so there is one list of upcoming money.
//
// Every amount here belongs to one account and is in that account's
// currency. A scheduled transfer moves one amount, so both its accounts
// must be in the same currency — the picker offers only those.
import { useEffect, useMemo, useState, useRef } from "react";
import TmIcon from "./TmIcon";
import Notice from "./Notice";
import DateField from "./DateField";
import Money from "./Money";
import CategorySelect from "./CategorySelect";
import CategoryCombo, { type ComboItem } from "./CategoryCombo";
import { groupFor, pickableAccounts } from "../lib/accountTypes";
import ForecastChart from "./ForecastChart";
import { api } from "../lib/ipc";
import { useCommand } from "../lib/useCommand";
import { describeStatus, isOpen, pickForecastAccount } from "../lib/bills";
import BillCalendar, { monthRange } from "./BillCalendar";
import { useAccountStore } from "../stores/useAccountStore";
import { formatDateUS, parseMoneyToCents, today } from "../lib/format";
import { currentRegion } from "../lib/region";
import { currencyOf, homeCurrency } from "../lib/currency";
import type {
  Account,
  CashForecast,
  Category,
  Goal,
  NewRecurrence,
  Occurrence,
  Recurrence,
} from "../lib/types";

/** The horizon the user asked for. */
const HORIZON_DAYS = 90;
/** Whether the forecast also projects detected recurring charges;
 *  "off" turns it off, anything else (or nothing) leaves it on. */
export const DETECTED_KEY = "forecast.detected";

const FREQ_LABELS: Record<Recurrence["freq"], string> = {
  once: "Once",
  weekly: "Weekly",
  semi_monthly: "Twice a month",
  monthly: "Monthly",
  yearly: "Yearly",
};

/** "Monthly", "Every 2 weeks", "Every 3 months" — how a rule reads in a list. */
export function describeRule(r: Pick<Recurrence, "freq" | "interval_n">): string {
  if (r.interval_n <= 1) return FREQ_LABELS[r.freq];
  const unit = r.freq === "weekly" ? "weeks" : r.freq === "yearly" ? "years" : "months";
  return `Every ${r.interval_n} ${unit}`;
}

export { describeStatus, isOpen, pickForecastAccount } from "../lib/bills";

const BLANK: NewRecurrence = {
  payee: "",
  amount_cents: 0,
  account_id: null,
  category_id: null,
  freq: "monthly",
  interval_n: 1,
  start_date: today(),
  end_date: null,
  second_day: null,
  weekend_rule: "none",
  notes: null,
};

type MsgWhere = "form" | "list" | "forecast";
interface Msg {
  text: string;
  where: MsgWhere;
  tone: "info" | "error";
}

export default function PaymentsView() {
  const [rules, setRules] = useState<Recurrence[]>([]);
  const [upcoming, setUpcoming] = useState<Occurrence[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [forecast, setForecast] = useState<CashForecast | null>(null);
  const [forecastAccount, setForecastAccount] = useState<string>("");
  // Also project the recurring charges the detector has noticed.
  // On by default; the choice follows the file (a UI setting), like the
  // Home card's ignore list it respects.
  const [includeDetected, setIncludeDetected] = useState(true);
  useEffect(() => {
    api
      .getUiSetting(DETECTED_KEY)
      .then((raw) => {
        if (raw === "off") setIncludeDetected(false);
      })
      .catch(() => {
        // The default stands.
      });
  }, []);
  function setDetected(on: boolean) {
    setIncludeDetected(on);
    void api.setUiSetting(DETECTED_KEY, on ? "on" : "off").catch(() => {});
  }
  // A forecast from an older build (or a stub) may carry no list at all.
  const detected = forecast?.detected ?? [];
  const covered = forecast?.covered_by_bills ?? [];
  // A message says where it belongs. A refusal used to land in one
  // line under every card, styled the same as "Scheduled.", so a save that
  // failed read as a save that worked. Now it is a Notice beside the part of
  // the screen that failed: the rule form, the bill list, or the forecast.
  const [msg, setMsgState] = useState<Msg | null>(null);
  const setMsg = (text: string | null, where: MsgWhere = "form", tone: Msg["tone"] = "error") =>
    setMsgState(text === null ? null : { text, where, tone });
  const [busy, setBusy] = useState(false);

  // The rule form.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<NewRecurrence>(BLANK);
  // The end date may be blank; DateField reports text it could not read.
  const [endBad, setEndBad] = useState(false);
  const payeeRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLElement>(null);
  const [amount, setAmount] = useState("");
  // "Every" as typed. Held as text so clearing the box to type 3 does
  // not snap it back to 1 and leave "13"; it is read into a number on save.
  const [intervalText, setIntervalText] = useState("1");
  const [direction, setDirection] = useState<"out" | "in">("out");
  // Money's bill calendar: the same occurrences as a month grid.
  const [billsView, setBillsView] = useState<"list" | "calendar">("list");
  const [calMonth, setCalMonth] = useState(() => today().slice(0, 7));
  const [calItems, setCalItems] = useState<Occurrence[]>([]);
  // Scheduled transfers: a goal that watches the receiving account.
  const [goals, setGoals] = useState<Goal[]>([]);

  /** Accounts as combo items, grouped the way the account list groups them so
   *  a long list still reads as Banking / Credit Cards / Investments. */
  // Closed accounts stay out, except the ones the rule being edited
  // already names: its picker has to show its own value.
  const editingRule = editingId ? rules.find((r) => r.id === editingId) : undefined;
  const accountItems: ComboItem[] = useMemo(
    () =>
      pickableAccounts(accounts, [editingRule?.account_id, editingRule?.transfer_account_id]).map((a) => ({
        value: a.id,
        label: a.is_closed ? `${a.name} (closed)` : a.name,
        group: groupFor(a.type),
      })),
    [accounts, editingRule?.account_id, editingRule?.transfer_account_id]
  );
  /** The currency an account is kept in; one not on file reads as the home currency. */
  const currencyFor = (id: string | null | undefined) => {
    const a = id ? accounts.find((x) => x.id === id) : undefined;
    return a ? currencyOf(a) : undefined;
  };
  const fromCurrency = currencyFor(draft.account_id);
  // A scheduled transfer moves one amount: only an account in the same
  // currency can receive it (the backend refuses the others).
  const sameCurrency = (id: string) => fromCurrency === undefined || currencyFor(id) === fromCurrency;

  async function load() {
    const [rs, up, accts, cats, gs] = await Promise.all([
      api.listRecurrences(),
      api.getUpcoming(HORIZON_DAYS),
      api.getAllAccounts(),
      api.listCategories(),
      api.listGoals().catch(() => [] as Goal[]),
    ]);
    setRules(rs);
    setUpcoming(up);
    setAccounts(accts);
    setCategories(cats);
    setGoals(gs);
    return [accts, rs] as const;
  }

  useEffect(() => {
    load()
      .then(([accts, rs]) => {
        // Default to the account the bills actually come out of — a cash
        // forecast for a wallet is not what anyone opened this screen for.
        // The rules are passed so the "most scheduled activity" tiebreak
        // actually has something to count.
        if (accts.length) setForecastAccount((cur) => cur || pickForecastAccount(accts, rs).id);
      })
      .catch((e) => setMsg(String(e), "forecast"));
  }, []);

  useEffect(() => {
    if (!forecastAccount) return;
    // Only the answer for the account still picked counts. Switching
    // accounts quickly could otherwise let the first, slower forecast land
    // last and draw Checking's projection under "Savings".
    let canceled = false;
    api
      .getCashForecast(forecastAccount, HORIZON_DAYS, includeDetected)
      .then((f) => {
        if (!canceled) setForecast(f);
      })
      .catch((e) => {
        if (!canceled) setMsg(String(e), "forecast");
      });
    return () => {
      canceled = true;
    };
  }, [forecastAccount, upcoming, includeDetected]);

  /** Run a write, then refresh. Returns whether it succeeded, so a form can
   *  keep what the user typed when it did not. */
  async function act(fn: () => Promise<unknown>, note?: string, where: MsgWhere = "form"): Promise<boolean> {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setUpcoming(await api.getUpcoming(HORIZON_DAYS));
      setRules(await api.listRecurrences());
      // Entering a bill writes a transaction and moves a balance that the
      // sidebar and Account List are showing.
      const store = useAccountStore.getState();
      await store.loadAccounts();
      if (store.selectedAccountId) await store.loadRegister(store.selectedAccountId);
      if (note) setMsg(note, where, "info");
      return true;
    } catch (e) {
      setMsg(String(e), where);
      return false;
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (billsView !== "calendar") return;
    let canceled = false;
    const { from, to } = monthRange(calMonth);
    api
      .getOccurrences(from, to)
      .then((items) => {
        if (!canceled) setCalItems(items);
      })
      .catch((e) => {
        if (!canceled) setMsg(String(e), "list");
      });
    return () => {
      canceled = true;
    };
    // `upcoming` changes whenever something was entered or skipped, so the
    // calendar re-reads then too.
  }, [billsView, calMonth, upcoming]);

  function startEdit(r: Recurrence) {
    setEditingId(r.id);
    setDirection(r.amount_cents < 0 ? "out" : "in");
    setAmount((Math.abs(r.amount_cents) / 100).toFixed(2).replace(".", currentRegion().decimal));
    setIntervalText(String(r.interval_n));
    // A twice-a-month rule saved with no second day (the form used to
    // show 15 while sending nothing) is loaded as it is: the box stays empty
    // with a note, so the user sees it runs once a month and can fix it.
    setDraft({
      payee: r.payee,
      amount_cents: r.amount_cents,
      account_id: r.account_id,
      category_id: r.category_id,
      freq: r.freq,
      interval_n: r.interval_n,
      start_date: r.start_date,
      end_date: r.end_date,
      second_day: r.second_day,
      weekend_rule: r.weekend_rule,
      notes: r.notes,
      transfer_account_id: r.transfer_account_id ?? null,
      goal_id: r.goal_id ?? null,
    });
  }

  /** Open an upcoming row's schedule in the form, and take the user
   *  there. *"I do see a need to be able to edit scheduled things"*: editing
   *  existed, but only from the short "Scheduled items" list under the form
   *  and from the calendar, and the list the user works in offered Enter and Skip
   *  and nothing else. The form sits beside the list on a wide window and
   *  below it on a narrow one, so it is scrolled to and its first field
   *  focused — a form that changed out of sight would read as nothing
   *  happening. */
  function editOccurrence(o: Occurrence) {
    const rule = rules.find((r) => r.id === o.recurrence_id);
    if (!rule) {
      setMsg(`The schedule for ${o.payee} is no longer on file.`, "list");
      return;
    }
    startEdit(rule);
    formRef.current?.scrollIntoView?.({ block: "nearest" });
    payeeRef.current?.focus();
  }

  // File → New → Scheduled bill or deposit, when the Bills screen is
  // in front (command priority); off screen, the shell navigates here first.
  useCommand(
    "new.recurrence",
    () => {
      resetForm();
      payeeRef.current?.focus();
    },
    true,
    10
  );

  function resetForm() {
    setEditingId(null);
    setDraft({ ...BLANK, start_date: today() });
    setAmount("");
    setIntervalText("1");
    setDirection("out");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const cents = parseMoneyToCents(amount);
    if (!draft.payee.trim() || cents === null || cents === 0) {
      setMsg("Enter a payee and an amount.");
      return;
    }
    const repeats = draft.freq !== "once" && draft.freq !== "semi_monthly";
    const interval = Number(intervalText.trim());
    if (repeats && !(Number.isInteger(interval) && interval >= 1)) {
      setMsg("Enter how often it repeats — a whole number, 1 or more.");
      return;
    }
    if (draft.freq === "semi_monthly" && draft.second_day === null) {
      setMsg("Enter the second day of the month it is due.");
      return;
    }
    // DateField sends "" for text it cannot read.
    if (!draft.start_date) {
      setMsg(`Type a first due date the form can read, such as ${formatDateUS("2026-08-03")}.`);
      return;
    }
    if (endBad) {
      setMsg(`Type an end date the form can read, such as ${formatDateUS("2026-08-03")}, or leave it blank.`);
      return;
    }
    // One sign convention: out is negative, the same as a transaction.
    const signed = direction === "out" ? -Math.abs(cents) : Math.abs(cents);
    const payload: NewRecurrence = {
      ...draft,
      amount_cents: signed,
      interval_n: repeats ? interval : draft.interval_n,
    };
    const ok = await act(
      () => (editingId ? api.updateRecurrence(editingId, payload) : api.createRecurrence(payload)),
      editingId ? "Updated." : "Scheduled."
    );
    // A refused save keeps the form — the user should not retype it.
    if (ok) resetForm();
  }

  const open = useMemo(() => upcoming.filter(isOpen), [upcoming]);
  const settled = useMemo(() => upcoming.filter((o) => !isOpen(o)), [upcoming]);
  // Scoped to the account being forecast: "still to come" beside a
  // per-account projection has to mean the same account, or the two numbers
  // quietly disagree.
  const dueTotal = open
    .filter((o) => o.account_id === forecastAccount)
    .reduce((s, o) => s + o.amount_cents, 0);
  // The forecast is one account's, in that account's currency.
  const fc = currencyFor(forecastAccount);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      {/* ── Forecast ─────────────────────────────────────────────────── */}
      <section className="aero-card lg:col-span-3">
        <div className="aero-card-title flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-2">
            <TmIcon name="calendar" size={15} /> Next {HORIZON_DAYS} days
          </span>
          <select
            className="aero-field"
            aria-label="Forecast account"
            value={forecastAccount}
            onChange={(e) => setForecastAccount(e.target.value)}
          >
            {/* N9: a closed account is not forecast. */}
            {pickableAccounts(accounts, [forecastAccount]).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        {msg?.where === "forecast" && (
          <div className="p-2">
            <Notice tone={msg.tone} boxed>
              {msg.text}
            </Notice>
          </div>
        )}
        {forecast && (
          <div className="p-3">
            <div className="flex flex-wrap gap-6 pb-3">
              <Stat label="Today" cents={forecast.starting_balance_cents} currency={fc} />
              {/* The headline. A forecast is for spotting the floor, not the
                  finish line. */}
              <Stat
                label={`Lowest — ${formatDateUS(forecast.low_date)}`}
                cents={forecast.low_balance_cents}
                currency={fc}
                emphasis
              />
              <Stat label={`In ${HORIZON_DAYS} days`} cents={forecast.ending_balance_cents} currency={fc} />
              <div>
                <div className="text-[11px] text-slate-600">Still to come</div>
                <div className="text-[13px] tabular-nums">
                  <Money cents={dueTotal} currency={fc} />
                </div>
              </div>
            </div>
            {forecast.low_balance_cents < 0 && (
              <div className="money-neg pb-2 text-[12px]">
                This account is projected to go negative on{" "}
                {formatDateUS(forecast.low_date)}.
              </div>
            )}
            <ForecastChart points={forecast.points} lowDate={forecast.low_date} currency={fc} />
            {/* The recurring charges the detector noticed, projected
                alongside the scheduled bills; the switch turns them off,
                and a charge you have told the Home card to ignore is never
                here. Each line names its next date, so a projection that
                looks wrong can be traced to the charge that caused it. */}
            <div className="pt-2 text-[12px]">
              <label className="inline-flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={includeDetected}
                  onChange={(e) => setDetected(e.target.checked)}
                  aria-label="Also project recurring charges T-Money has noticed"
                />
                Also project recurring charges T-Money has noticed
                {includeDetected && detected.length > 0 && (
                  <span className="tm-text-muted">
                    {" "}— {detected.length}, <Money cents={detected.reduce((n, d) => n + d.amount_cents * d.dates.length, 0)} tone="neutral" currency={fc} /> over the {HORIZON_DAYS} days
                  </span>
                )}
                {includeDetected && detected.length === 0 && (
                  <span className="tm-text-muted"> — none found in this account</span>
                )}
              </label>
              {includeDetected && detected.length > 0 && (
                <ul className="pl-5 pt-1 tm-text-muted" aria-label="Recurring charges projected">
                  {detected.map((d) => (
                    <li key={d.payee}>
                      {d.payee} · every {d.cadence} · <Money cents={d.amount_cents} tone="neutral" currency={fc} />
                      {d.varies ? " (amount varies; a typical recent one)" : ""} · next {formatDateUS(d.dates[0])}
                      {d.ignored_on_home ? " · ignored on the Home page's Subscriptions card, still projected here" : ""}
                      {d.dates.length > 1 ? ` and ${d.dates.length - 1} more` : ""}
                    </li>
                  ))}
                </ul>
              )}
              {includeDetected && covered.length > 0 && (
                <div className="pl-5 pt-1 tm-text-muted" aria-label="Recurring charges left to their bills">
                  Also on a schedule, and already in the forecast through their scheduled bills: {covered.join(", ")}.
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      {/* ── Upcoming ─────────────────────────────────────────────────── */}
      <section className="aero-card lg:col-span-2">
        <div className="aero-card-title flex items-center gap-2">
          <TmIcon name="calendar" size={15} /> Bills to Pay &amp; income
          <span className="flex-1" />
          <button className={`aero-btn !py-0 !px-2 text-[11px]${billsView === "list" ? " default" : ""}`} type="button" aria-pressed={billsView === "list"} onClick={() => setBillsView("list")}>
            List
          </button>
          <button className={`aero-btn !py-0 !px-2 text-[11px]${billsView === "calendar" ? " default" : ""}`} type="button" aria-pressed={billsView === "calendar"} onClick={() => setBillsView("calendar")}>
            Calendar
          </button>
        </div>
        <div className="p-2 max-h-[46vh] overflow-y-auto">
          {msg?.where === "list" && (
            <Notice tone={msg.tone} boxed className="mb-2">
              {msg.text}
            </Notice>
          )}
          {billsView === "calendar" ? (
            <BillCalendar
              accounts={accounts}
              month={calMonth}
              occurrences={calItems}
              today={today()}
              onMonth={setCalMonth}
              onDayDoubleClick={(date) => {
                resetForm();
                setDraft({ ...BLANK, start_date: date });
              }}
              onPick={(o) => {
                const rule = rules.find((r) => r.id === o.recurrence_id);
                if (rule) startEdit(rule);
              }}
            />
          ) : upcoming.length === 0 ? (
            <div className="p-3 text-center text-[12px] text-slate-500">
              Nothing scheduled. Add a bill or a paycheck on the right.
            </div>
          ) : (
            <table className="register-table">
              <thead>
                <tr>
                  <th>Due</th>
                  <th>Payee</th>
                  <th>Account</th>
                  <th className="num">Amount</th>
                  <th>Status</th>
                  <th className="num" style={{ width: 190 }}>
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {[...open, ...settled].map((o) => {
                  const s = describeStatus(o);
                  return (
                    <tr
                      key={`${o.recurrence_id}:${o.due_date}`}
                      className={s.tone}
                      // The row whose schedule is in the form is marked,
                      // so what Save will change is visible from the list.
                      style={o.recurrence_id === editingId ? { background: "var(--tm-ms-row-active)" } : undefined}
                      onDoubleClick={(e) => {
                        // A quick second press on Enter or Skip is not a
                        // request to edit.
                        if ((e.target as HTMLElement).closest("button")) return;
                        editOccurrence(o);
                      }}
                    >
                      <td>{formatDateUS(o.due_date)}</td>
                      <td>{o.payee}</td>
                      <td className="text-slate-600">{o.account_name ?? "—"}{o.transfer_account_name && ` → ${o.transfer_account_name}`}</td>
                      <td className="num">
                        <Money cents={o.actual_amount_cents ?? o.amount_cents} currency={currencyFor(o.account_id)} />
                      </td>
                      <td className="text-[11px]">{s.label}</td>
                      <td className="num">
                        <span className="inline-flex gap-1">
                          {isOpen(o) && !o.account_id ? (
                            // Migrated one-off bills arrive with no account
                            // (the old payments table had none), so Enter
                            // cannot know where to put them. Send the user to
                            // the fix rather than showing a dead button.
                            <button
                              className="aero-btn !py-0 !px-1.5 text-[11px]"
                              onClick={() => editOccurrence(o)}
                            >
                              Set account
                            </button>
                          ) : isOpen(o) ? (
                            <>
                              <button
                                className="aero-btn !py-0 !px-1.5 text-[11px]"
                                disabled={busy}
                                title="Enter this in the register"
                                onClick={() =>
                                  void act(
                                    () =>
                                      api.enterOccurrence(
                                        o.recurrence_id,
                                        o.due_date,
                                        o.due_date,
                                        null,
                                        null
                                      ),
                                    `Entered ${o.payee}.`,
                                    "list"
                                  )
                                }
                              >
                                Enter
                              </button>
                              <button
                                className="aero-btn !py-0 !px-1.5 text-[11px]"
                                disabled={busy}
                                onClick={() =>
                                  void act(
                                    () => api.skipOccurrence(o.recurrence_id, o.due_date),
                                    `Skipped ${o.payee}.`,
                                    "list"
                                  )
                                }
                              >
                                Skip
                              </button>
                            </>
                          ) : (
                            <button
                              className="aero-btn !py-0 !px-1.5 text-[11px]"
                              disabled={busy}
                              title="Put this back on the list"
                              onClick={() =>
                                void act(
                                  () => api.clearOccurrence(o.recurrence_id, o.due_date),
                                  undefined,
                                  "list"
                                )
                              }
                            >
                              Undo
                            </button>
                          )}
                          {/* On every row, open or settled: a paid
                              bill's amount is still the one next month uses. */}
                          <button
                            type="button"
                            className="aero-btn !py-0 !px-1.5 text-[11px]"
                            aria-label={`Edit the schedule for ${o.payee}`}
                            title="Change this schedule — the amount, the date, how often it repeats"
                            onClick={() => editOccurrence(o)}
                          >
                            Edit
                          </button>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* ── The rule form ────────────────────────────────────────────── */}
      <section className="aero-card" ref={formRef}>
        <div className="aero-card-title flex items-center gap-2">
          <TmIcon name="calendar" size={15} />{" "}
          {/* Which schedule, by the payee it was opened with rather
              than the Payee box, so the title does not change as a rename
              is typed. */}
          {editingId
            ? editingRule
              ? `Edit scheduled item: ${editingRule.payee}`
              : "Edit scheduled item"
            : "Schedule a bill or paycheck"}
        </div>
        <form className="p-3 space-y-2 text-[11px]" onSubmit={submit}>
          <label className="block">
            Payee
            <input
              className="aero-field mt-1 w-full"
              value={draft.payee}
              ref={payeeRef}
              onChange={(e) => setDraft({ ...draft, payee: e.target.value })}
            />
          </label>
          <div className="flex gap-2">
            <label className="block flex-1">
              Amount
              <input
                className="aero-field mt-1 w-full"
                inputMode="decimal"
                placeholder={fromCurrency && fromCurrency !== homeCurrency() ? `${fromCurrency} 0${currentRegion().decimal}00` : `0${currentRegion().decimal}00`}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
            <label className="block">
              Direction
              <select
                className="aero-field mt-1"
                aria-label="Direction"
                value={draft.transfer_account_id ? "transfer" : direction}
                onChange={(e) => {
                  if (e.target.value === "transfer") {
                    setDirection("out");
                    setDraft({ ...draft, category_id: null, transfer_account_id: draft.transfer_account_id || accounts.find((a) => !a.is_closed && a.id !== draft.account_id && sameCurrency(a.id))?.id || null });
                  } else {
                    setDirection(e.target.value as "out" | "in");
                    setDraft({ ...draft, transfer_account_id: null, goal_id: null });
                  }
                }}
              >
                <option value="out">Money out</option>
                <option value="in">Money in</option>
                <option value="transfer">Transfer to…</option>
              </select>
            </label>
          </div>
          <label className="block">
            Account
            {/* Type to find it. A native select only jumps by first letter,
                which stops being useful somewhere around a dozen accounts —
                the same reason the category field is a combo. */}
            <CategoryCombo
              className="aero-field mt-1 w-full"
              label="Account"
              placeholder="(choose an account)"
              items={accountItems}
              value={draft.account_id ?? ""}
              onChange={(v) => {
                // A transfer whose receiving account is now in another
                // currency moves to one that is not, if there is one.
                let to = draft.transfer_account_id;
                const cur = currencyFor(v);
                if (to && cur && currencyFor(to) !== cur) {
                  to = accounts.find((a) => !a.is_closed && a.id !== v && currencyOf(a) === cur)?.id ?? to;
                }
                setDraft({ ...draft, account_id: v || null, transfer_account_id: to });
              }}
            />
          </label>
          {draft.transfer_account_id ? (
            <>
              <label className="block">
                Transfer to
                <CategoryCombo
                  className="aero-field mt-1 w-full"
                  label="Transfer to"
                  placeholder="(choose the receiving account)"
                  items={accountItems.filter((i) => i.value !== draft.account_id && (sameCurrency(i.value) || i.value === draft.transfer_account_id))}
                  value={draft.transfer_account_id}
                  onChange={(v) => setDraft({ ...draft, transfer_account_id: v || null, goal_id: null })}
                />
              </label>
              {goals.some((g) => g.account_id === draft.transfer_account_id) && (
                <label className="block">
                  Counts toward goal
                  <select className="aero-field mt-1 w-full" aria-label="Counts toward goal" value={draft.goal_id ?? ""} onChange={(e) => setDraft({ ...draft, goal_id: e.target.value || null })}>
                    <option value="">(none)</option>
                    {goals
                      .filter((g) => g.account_id === draft.transfer_account_id)
                      .map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                  </select>
                </label>
              )}
            </>
          ) : (
            <label className="block">
              Category
              <CategorySelect
                className="aero-field mt-1 w-full"
                label="Scheduled category"
                categories={categories}
                value={draft.category_id ?? ""}
                onChange={(id) => setDraft({ ...draft, category_id: id || null })}
              />
            </label>
          )}
          <div className="flex gap-2">
            <label className="block flex-1">
              Repeats
              <select
                className="aero-field mt-1 w-full"
                aria-label="Repeats"
                value={draft.freq}
                onChange={(e) => {
                  const freq = e.target.value as Recurrence["freq"];
                  // The second day the box shows is the one that is
                  // saved. It showed `?? 15` over a null, the null went to
                  // the backend, and schedule.rs scheduled the start day only.
                  const second_day =
                    freq === "semi_monthly" && draft.second_day === null ? 15 : draft.second_day;
                  setDraft({ ...draft, freq, second_day });
                }}
              >
                {(Object.keys(FREQ_LABELS) as Recurrence["freq"][]).map((f) => (
                  <option key={f} value={f}>
                    {FREQ_LABELS[f]}
                  </option>
                ))}
              </select>
            </label>
            {draft.freq !== "once" && draft.freq !== "semi_monthly" && (
              <label className="block" style={{ width: 70 }}>
                Every
                <input
                  className="aero-field mt-1 w-full"
                  type="number"
                  min={1}
                  aria-label="Interval"
                  value={intervalText}
                  onChange={(e) => setIntervalText(e.target.value)}
                />
              </label>
            )}
          </div>
          {draft.freq === "semi_monthly" && (
            <label className="block">
              Second day of the month
              <input
                className="aero-field mt-1 w-full"
                type="number"
                min={1}
                max={31}
                aria-label="Second day"
                value={draft.second_day ?? ""}
                onChange={(e) => {
                  const n = Number(e.target.value.trim());
                  setDraft({
                    ...draft,
                    second_day: e.target.value.trim() && Number.isInteger(n) && n >= 1 && n <= 31 ? n : null,
                  });
                }}
              />
              {draft.second_day === null && (
                <span className="block pt-0.5 tm-text-muted">
                  No second day is set, so this is only scheduled on the first due date's day of the month.
                </span>
              )}
            </label>
          )}
          <div className="flex gap-2">
            <label className="block flex-1">
              First due
              <span className="block mt-1">
                <DateField label="First due" value={draft.start_date} onChange={(v) => setDraft({ ...draft, start_date: v })} />
              </span>
            </label>
            <label className="block flex-1">
              Ends (optional)
              <span className="block mt-1">
                <DateField
                  label="Ends"
                  value={draft.end_date ?? ""}
                  onChange={(v) => setDraft({ ...draft, end_date: v || null })}
                  onInvalid={setEndBad}
                  optional
                />
              </span>
            </label>
          </div>
          <label className="block">
            If it lands on a weekend
            <select
              className="aero-field mt-1 w-full"
              aria-label="Weekend rule"
              value={draft.weekend_rule}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  weekend_rule: e.target.value as Recurrence["weekend_rule"],
                })
              }
            >
              <option value="none">Leave it on the weekend</option>
              <option value="before">Move to the Friday before</option>
              <option value="after">Move to the Monday after</option>
            </select>
          </label>
          {msg?.where === "form" && (
            <Notice tone={msg.tone} boxed>
              {msg.text}
            </Notice>
          )}
          <div className="flex gap-2 pt-1">
            <button className="aero-btn default" disabled={busy}>
              {editingId ? "Save" : "Schedule it"}
            </button>
            {editingId && (
              <button className="aero-btn" type="button" onClick={resetForm}>
                Cancel
              </button>
            )}
          </div>
        </form>

        {/* The rules themselves, so they can be edited or retired. */}
        <div className="border-t p-2" style={{ borderColor: "var(--tm-ms-card-border)" }}>
          <div className="px-1 pb-1 text-[11px] text-slate-600">Scheduled items</div>
          {rules.length === 0 ? (
            <div className="px-1 text-[11px] text-slate-500">None yet.</div>
          ) : (
            <ul className="text-[11px]">
              {rules.map((r) => (
                <li key={r.id} className="flex items-center gap-2 px-1 py-0.5">
                  <span className={r.is_active ? "" : "text-slate-400 line-through"}>
                    {r.payee} · {describeRule(r)}
                    {r.transfer_account_name && ` · → ${r.transfer_account_name}`}
                    {r.goal_name && ` ⚑ ${r.goal_name}`}
                  </span>
                  <span className="flex-1" />
                  <button
                    className="aero-btn !py-0 !px-1.5"
                    onClick={() => startEdit(r)}
                    type="button"
                  >
                    Edit
                  </button>
                  <button
                    className="aero-btn !py-0 !px-1.5"
                    type="button"
                    title={r.is_active ? "Stop scheduling this" : "Schedule it again"}
                    onClick={() => void act(() => api.setRecurrenceActive(r.id, !r.is_active))}
                  >
                    {r.is_active ? "Pause" : "Resume"}
                  </button>
                  <button
                    className="aero-btn !py-0 !px-1.5"
                    type="button"
                    onClick={() => {
                      if (window.confirm(`Delete the schedule for "${r.payee}"?`)) {
                        void act(() => api.deleteRecurrence(r.id));
                      }
                    }}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

    </div>
  );
}

function Stat({ label, cents, currency, emphasis }: { label: string; cents: number; currency?: string; emphasis?: boolean }) {
  return (
    <div>
      <div className="text-[11px] text-slate-600">{label}</div>
      <div className={emphasis ? "text-[16px] font-semibold tabular-nums" : "text-[13px] tabular-nums"}>
        <Money cents={cents} currency={currency} />
      </div>
    </div>
  );
}
