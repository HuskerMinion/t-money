// File → Import → TSP activity detail.
//
// The dialog exists for one reason: **the plan's file does not know what
// reached your bank.** A $1,000 distribution with tax withheld is $1,000 out
// of the funds and less than that into checking, and importing the gross as a
// transfer puts money in checking that never arrived — an easy mistake to
// make and a slow one to undo.
//
// So the shape here is: read the file, show what it says, and then ask about
// exactly the days it cannot finish describing. One row per payment, with the
// gross the plan sold on the left and two questions on the right — what the
// bank received and when, and what was kept back and under which category.
// The remainder is computed, never typed, so the arithmetic cannot be off by
// a cent.
//
// Everything else — collapsing the money sources, working out the position
// held before the export begins, checking that no fund goes negative — is
// done in Rust before this opens, and shown rather than hidden, because a
// user who can see "1,000 rows → 500 transactions" understands what happened
// to their file.
import { useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import Money from "./Money";
import Notice from "./Notice";
import DateField from "./DateField";
import { api } from "../lib/ipc";
import { formatAmountBare, formatDateUS, parseMoneyToCents } from "../lib/format";
import type { Account, ImportSummary, TspPaymentSplit, TspPlan } from "../lib/types";
import { currentRegion, groupDigits } from "../lib/region";

/** A decimal the backend wrote ("123.456789") with the region's decimal
 *  mark. */
function dec(s: string): string {
  return s.replace(".", currentRegion().decimal);
}

/** The withholding category. NOT `Taxes:Federal Income Tax` — that one carries
 *  the W-2 tax line, and this withholding comes on a 1099-R, which is a
 *  different line on the return. */
const WITHHELD = "Taxes:TSP Federal Withholding";
const LOAN_FEE = "Bank Charges:Loan fee";

interface Answer {
  /** What the bank received, as typed. */
  net: string;
  /** The date the bank posted it. */
  on: string;
  category: string;
  memo: string;
}

interface Props {
  accounts: readonly Account[];
  /** A file already chosen elsewhere (the CSV door sniffed a tsp.gov
   *  export and handed it over). The dialog opens on it rather than asking
   *  for it a second time. */
  initialPath?: string | null;
  onClose: () => void;
  onImported: (summary: ImportSummary) => void;
}

export default function TspImportDialog({ accounts, initialPath = null, onClose, onImported }: Props) {
  const [path, setPath] = useState("");
  const [plan, setPlan] = useState<TspPlan | null>(null);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [accountId, setAccountId] = useState("");
  const [cashAccountId, setCashAccountId] = useState("");
  const [busy, setBusy] = useState(false);
  // The import itself is running. Kept apart from `busy` (which a
  // preview sets too) so the account pickers lock only for the import: a
  // select disabled on every preview would drop the focus of someone
  // arrowing through its options.
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = accounts.filter((a) => !a.is_closed);
  // The plan account is a retirement or investment account; the cash account
  // is where the money landed. Offering every account for both would be
  // technically true and useless.
  const planAccounts = open.filter((a) => a.type === "retirement" || a.type === "investment");
  const cashAccounts = open.filter((a) => a.type !== "retirement" && a.type !== "investment");

  // The file the answers on screen belong to, so a re-preview of the SAME
  // file (the account changed) keeps what has been typed.
  const answeredFor = useRef("");
  // Which preview's answer still counts. Changing the account
  // re-previews, and two changes in quick succession sent two requests; the
  // slower one — for the account no longer chosen — could land last and put
  // its opening position ("already held") on screen under the other account.
  const previewSeq = useRef(0);

  async function load(picked: string, forAccount: string) {
    const mine = ++previewSeq.current;
    setPath(picked);
    setBusy(true);
    setError(null);
    try {
      const p = await api.previewTsp(picked, forAccount || null);
      if (mine !== previewSeq.current) return;
      setPlan(p);
      // Default every payment to "the whole gross reached the bank on the
      // plan's own date". It is the wrong answer for a distribution with tax
      // withheld — which is most of them — but it is the honest starting
      // point, and the totals on screen show it not adding up until it is
      // corrected.
      const next: Record<string, Answer> = {};
      for (const pay of p.payments) {
        next[pay.date] = {
          net: formatAmountBare(pay.gross_cents),
          on: pay.date,
          category: pay.is_loan ? LOAN_FEE : WITHHELD,
          memo: pay.is_loan ? "TSP loan setup fee" : "Tax withheld on TSP distribution",
        };
      }
      const same = answeredFor.current === picked;
      answeredFor.current = picked;
      setAnswers((a) => (same ? { ...next, ...a } : next));
    } catch (e) {
      if (mine !== previewSeq.current) return;
      setPlan(null);
      setError(String(e));
    } finally {
      if (mine === previewSeq.current) setBusy(false);
    }
  }

  async function choose() {
    setError(null);
    const picked = await openDialog({
      title: "TSP activity detail (CSV from tsp.gov)",
      multiple: false,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (typeof picked !== "string") return;
    await load(picked, accountId);
  }

  // Open on a file handed over, and re-preview whenever the account
  // changes: the opening position is netted against what THAT account
  // already holds, which is the difference between a right import and a
  // doubled one.
  useEffect(() => {
    const target = path || initialPath || "";
    if (target) void load(target, accountId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPath, accountId]);

  function keptBack(date: string, grossCents: number): number | null {
    const a = answers[date];
    if (!a) return null;
    const net = parseMoneyToCents(a.net);
    if (net === null) return null;
    return grossCents - net;
  }

  // The bank account is only a question when the plan PAID something
  // out. A file of contributions and reallocations moves nothing to a bank,
  // and "Money went to" was a required answer to a question with no subject:
  //
  // > *"If there's no money moving from TSP to an account I shouldn't have to
  // >  select where 'Money went to'."*
  const needsCash = !!plan && plan.payments.length > 0;
  const ready =
    !!plan &&
    plan.problems.length === 0 &&
    !!accountId &&
    (!needsCash || !!cashAccountId) &&
    plan.payments.every((p) => {
      const kept = keptBack(p.date, p.gross_cents);
      // A posted date DateField could not read is "".
      return kept !== null && kept >= 0 && !!answers[p.date]?.on && (kept === 0 || !!answers[p.date]?.category.trim());
    });

  async function run() {
    if (!plan) return;
    setBusy(true);
    setImporting(true);
    setError(null);
    try {
      const splits: TspPaymentSplit[] = plan.payments.map((p) => {
        const a = answers[p.date];
        const net = parseMoneyToCents(a.net) ?? 0;
        const kept = p.gross_cents - net;
        return {
          date: p.date,
          deposits: [{ on: a.on, amount_cents: net }],
          // One line, amount left null so Rust computes the remainder — the
          // one place the arithmetic is settled, rather than here and there.
          lines: kept > 0 ? [{ category: a.category.trim(), amount_cents: null, memo: a.memo }] : [],
        };
      });
      onImported(await api.importTsp(path, accountId, needsCash ? cashAccountId : null, splits));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      setImporting(false);
    }
  }

  const set = (date: string, patch: Partial<Answer>) =>
    setAnswers((a) => ({ ...a, [date]: { ...a[date], ...patch } }));

  return (
    <div className="tm-dialog" role="dialog" aria-label="Import TSP activity" style={{ minWidth: 640, maxWidth: 860 }}>
      <div className="tm-dialog-title">Import TSP activity detail</div>
      <div className="tm-dialog-body">
        {/* Only the file's contents scroll. The error was drawn at the
            top of the scrolling body and Import at the bottom, so a refused
            import — pressed at the foot of a long table of payments — wrote
            its reason out of view. The error now sits beside the buttons,
            outside the scroll, where the click was. */}
        <div style={{ maxHeight: "66vh", overflowY: "auto" }}>
          <p className="text-[12px] pb-2">
            Download <strong>Investment Activity Detail</strong> from tsp.gov as a CSV. The plan's file
            says what it sold; it does not say what reached your bank, so anything withheld is asked
            for below.
          </p>

          <div className="flex items-center gap-2 pb-3">
            <button className="aero-btn" type="button" onClick={() => void choose()} disabled={busy}>
              Choose file…
            </button>
            <span className="text-[11px] truncate flex-1" title={path}>
              {path || "No file chosen"}
            </span>
          </div>

          {plan && (
            <>
              <section className="aero-card">
                <div className="aero-card-title">What the file contains</div>
                <div className="p-3 text-[12px] space-y-1">
                  <div>
                    {groupDigits(plan.rows)} rows → <strong>{groupDigits(plan.transactions)}</strong>{" "}
                    transactions, in {plan.funds.join(", ")}.
                    <span className="block" style={{ color: "var(--tm-ms-text-muted)" }}>
                      The plan splits every transaction across its money sources — Traditional, Match,
                      Roth. Those are folded back together here.
                    </span>
                  </div>
                  {plan.opening.length > 0 && (
                    <div className="pt-1">
                      Held on {formatDateUS(plan.open_date)}, before the export begins:
                      <ul className="pl-4">
                        {plan.opening.map((o) => (
                          <li key={o.fund}>
                            {o.fund}: {dec(o.units)} units @ {dec(o.nav)} ={" "}
                            <Money cents={o.value_cents} tone="neutral" />
                            {o.rounding_sliver && (
                              <span style={{ color: "var(--tm-ms-text-muted)" }}>
                                {" "}
                                (+{dec(o.rounding_sliver)} to cover the plan's own rounding)
                              </span>
                            )}
                            {/* What is already there is not written again. */}
                            {accountId && o.already_held !== "0.000000" && (
                              <span className="block" style={{ color: "var(--tm-ms-text-muted)" }}>
                                {o.to_add === "0.000000"
                                  ? "Already in the register on that date — nothing is added."
                                  : `${dec(o.already_held)} already in the register; ${dec(o.to_add)} will be added.`}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                      <span className="block" style={{ color: "var(--tm-ms-text-muted)" }}>
                        Worked out from the file, not estimated: every unit change is known, so
                        anything that would go negative was already there.
                        {accountId
                          ? " Anything the account already holds on that date is not added again."
                          : " Choose the account: whatever it already holds on that date is not added again."}
                      </span>
                    </div>
                  )}
                </div>
              </section>

              {plan.problems.length > 0 && (
                <section className="aero-card" style={{ borderColor: "var(--tm-negative)" }}>
                  <div className="aero-card-title">This file does not add up</div>
                  <div className="p-3 text-[12px]">
                    <p className="pb-1">Nothing will be imported until these are explained:</p>
                    <ul className="pl-4">
                      {plan.problems.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                  </div>
                </section>
              )}

              <div className="grid grid-cols-2 gap-3 py-3">
                <label className="text-[11px]">
                  Import into
                  <select
                    className="aero-field mt-1 w-full"
                    aria-label="Plan account"
                    value={accountId}
                    disabled={importing}
                    onChange={(e) => setAccountId(e.target.value)}
                  >
                    <option value="">Choose the TSP account…</option>
                    {planAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
                {needsCash && (
                  <label className="text-[11px]">
                    Money went to
                    <select
                      className="aero-field mt-1 w-full"
                      aria-label="Cash account"
                      value={cashAccountId}
                      disabled={importing}
                      onChange={(e) => setCashAccountId(e.target.value)}
                    >
                      <option value="">Choose the bank account…</option>
                      {cashAccounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>

              {plan.payments.length > 0 && (
                <section className="aero-card">
                  <div className="aero-card-title">What actually reached the bank</div>
                  <div className="p-3">
                    <p className="text-[11px] pb-2" style={{ color: "var(--tm-ms-text-muted)" }}>
                      Copy these from your bank register. The difference is what the plan kept back —
                      withholding, or a loan fee — and it becomes its own categorized row so you can
                      total it in April.
                    </p>
                    <table className="w-full text-[12px]">
                      <thead>
                        <tr className="text-left">
                          <th>Plan paid</th>
                          <th className="text-right">Gross</th>
                          <th className="text-right">To the bank</th>
                          <th>Posted</th>
                          <th className="text-right">Kept back</th>
                          <th>Category</th>
                        </tr>
                      </thead>
                      <tbody>
                        {plan.payments.map((p) => {
                          const a = answers[p.date];
                          const kept = keptBack(p.date, p.gross_cents);
                          const bad = kept === null || kept < 0;
                          return (
                            <tr key={p.date}>
                              <td>
                                {formatDateUS(p.date)}
                                {p.is_loan && (
                                  <span className="block text-[10px]" style={{ color: "var(--tm-ms-text-muted)" }}>
                                    a loan, not a distribution
                                  </span>
                                )}
                              </td>
                              <td className="text-right tabular-nums">
                                <Money cents={p.gross_cents} tone="neutral" />
                              </td>
                              <td className="text-right">
                                <input
                                  className="aero-field text-right"
                                  style={{ width: 92 }}
                                  aria-label={`Received for ${p.date}`}
                                  value={a?.net ?? ""}
                                  onChange={(e) => set(p.date, { net: e.target.value })}
                                />
                              </td>
                              <td>
                                <DateField
                                  label={`Posted for ${p.date}`}
                                  value={a?.on ?? ""}
                                  onChange={(v) => set(p.date, { on: v })}
                                  width={116}
                                />
                              </td>
                              <td
                                className="text-right tabular-nums"
                                style={bad ? { color: "var(--tm-negative)" } : undefined}
                              >
                                {kept === null ? "—" : <Money cents={kept} tone="neutral" />}
                              </td>
                              <td>
                                <input
                                  className="aero-field w-full"
                                  aria-label={`Category for ${p.date}`}
                                  value={a?.category ?? ""}
                                  disabled={kept === 0}
                                  onChange={(e) => set(p.date, { category: e.target.value })}
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    <p className="text-[11px] pt-2" style={{ color: "var(--tm-ms-text-muted)" }}>
                      A category that does not exist yet is created on import. Set its tax line by hand
                      afterwards — nothing in a QIF can carry one — and turn on "include in tax
                      reports" for the plan account, or none of this reaches the Taxes tab.
                    </p>
                  </div>
                </section>
              )}
            </>
          )}
        </div>

        {error && (
          <Notice tone="error" boxed className="mt-2">
            {error}
          </Notice>
        )}
        <div className="flex justify-end gap-2 pt-3">
          <button className="aero-btn" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="aero-btn" type="button" onClick={() => void run()} disabled={!ready || busy}>
            {busy ? "Working…" : "Import"}
          </button>
        </div>
      </div>
    </div>
  );
}
