// §141 — build next year from what this year did.
//
// The question it answers: if a job ended partway through the year and you
// build the new year from history, how do you say that job no longer exists?
//
// The answer this screen gives is that it already knows. A line that ran
// January to October and then went silent arrives UNTICKED with a note saying
// when it stopped — because a twelfth of ten months of pay is a plausible
// figure for income that will never arrive, and plausible is the dangerous
// kind of wrong. A line that started in September arrives annualized from the
// months it actually ran, with the twelfth shown beside it, because that
// error runs the other way and nothing about it looks wrong.
//
// Every figure here is editable and nothing is written until the button is
// pressed. The proposal is a reading of a year, not a decision.
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/ipc";
import Notice from "./Notice";
import { formatAmountBare, parseMoneyToCents } from "../lib/format";
import { annualFromMonthly } from "./YearPlanView";
import type { PlanProposal } from "../lib/types";

/** A row as the user has it: the proposal, plus what they have changed. */
export interface BuildRow {
  proposal: PlanProposal;
  include: boolean;
  monthlyCents: number;
}

export function rowsFrom(proposals: readonly PlanProposal[]): BuildRow[] {
  return proposals.map((p) => ({
    proposal: p,
    include: p.include,
    monthlyCents: p.suggested_monthly_cents,
  }));
}

/** What gets written: the annual figure is the monthly one over the months
 *  the line runs, so a seasonal line stays seasonal and a five-month line is
 *  never quietly turned into a twelve-month one.
 *
 *  §179 — and the spread goes with the mask. Without it the backend read
 *  every pick as "spent", so a set-aside bill (§143) came back as a lump in
 *  the month it is due. A set-aside line's monthly figure is a twelfth, so
 *  its annual figure is twelve of them, whatever its mask says. */
export function picksFrom(rows: readonly BuildRow[]) {
  return rows
    .filter((r) => r.include)
    .map((r) => ({
      category_id: r.proposal.category_id,
      annual_cents: annualFromMonthly(r.monthlyCents, r.proposal.months, r.proposal.spread),
      months: r.proposal.months,
      spread: r.proposal.spread,
    }));
}

/** The one-line summary above the button. Said in lines rather than in money:
 *  the money is on the rows, and a total here would invite reading it as the
 *  plan's total, which it is not — untouched lines are not in it. */
export function summaryOf(rows: readonly BuildRow[], year: number): string {
  const on = rows.filter((r) => r.include).length;
  const over = rows.filter((r) => r.include && r.proposal.existing_annual_cents !== null).length;
  const head = `${on} line${on === 1 ? "" : "s"} into ${year}`;
  return over > 0 ? `${head}, ${over} of them over a figure already there` : head;
}

export default function BuildPlanDialog({
  year,
  onCancel,
  onApplied,
}: {
  year: number;
  onCancel: () => void;
  onApplied: (written: number) => void;
}) {
  const from = year - 1;
  const [rows, setRows] = useState<BuildRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const proposals = await api.planFromHistory(from, year);
      setRows(rowsFrom(proposals));
      setError(null);
    } catch (e) {
      setRows([]);
      setError(String(e));
    }
  }, [from, year]);

  useEffect(() => {
    void load();
  }, [load]);

  function setRow(id: string, patch: Partial<BuildRow>) {
    setRows((rs) => (rs ?? []).map((r) => (r.proposal.category_id === id ? { ...r, ...patch } : r)));
  }

  async function apply() {
    if (!rows) return;
    setBusy(true);
    setError(null);
    try {
      const written = await api.applyYearPlan(year, picksFrom(rows));
      onApplied(written);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  const income = (rows ?? []).filter((r) => r.proposal.kind === "income");
  const expenses = (rows ?? []).filter((r) => r.proposal.kind === "expense");

  function block(label: string, list: BuildRow[]) {
    if (list.length === 0) return null;
    return (
      <>
        <tr className="tm-plan-band">
          <td colSpan={6}>{label}</td>
        </tr>
        {list.map((r) => {
          const p = r.proposal;
          const editingThis = editing?.id === p.category_id;
          return (
            <tr key={p.category_id} className={p.basis === "ended" ? "tm-build-ended" : undefined}>
              <td>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    aria-label={`Carry ${p.full_name} into ${year}`}
                    checked={r.include}
                    disabled={busy}
                    onChange={(e) => setRow(p.category_id, { include: e.target.checked })}
                  />
                  <span style={{ fontWeight: p.parent_id ? "normal" : "bold" }}>{p.full_name}</span>
                </label>
              </td>
              <td className="num">{formatAmountBare(p.actual_cents)}</td>
              <td>
                <span className="tm-budget-note">{p.note}</span>
                {p.basis === "running" && (
                  <span className="tm-budget-note">
                    {" "}
                    (a twelfth would be {formatAmountBare(p.plain_monthly_cents)})
                  </span>
                )}
                {p.existing_annual_cents !== null && r.include && (
                  <span className="tm-build-warn">
                    {" "}
                    replaces {formatAmountBare(p.existing_annual_cents)} already planned
                  </span>
                )}
              </td>
              <td className="num">
                <input
                  className="aero-field tm-budget-amount"
                  aria-label={`Monthly for ${p.full_name}`}
                  value={editingThis ? editing.text : formatAmountBare(r.monthlyCents)}
                  disabled={busy || !r.include}
                  onFocus={() => setEditing({ id: p.category_id, text: formatAmountBare(r.monthlyCents) })}
                  onChange={(e) => setEditing({ id: p.category_id, text: e.target.value })}
                  onBlur={(e) => {
                    setEditing(null);
                    const text = e.target.value.trim();
                    const cents = parseMoneyToCents(text);
                    // §183 — the old figure is put back either way, but said:
                    // a figure that silently reverted read as accepted.
                    if (cents === null) {
                      setError(
                        text === ""
                          ? `${p.full_name} needs a monthly figure — untick it to leave it out. It keeps ${formatAmountBare(r.monthlyCents)}.`
                          : `"${text}" is not an amount. ${p.full_name} keeps ${formatAmountBare(r.monthlyCents)}.`
                      );
                    } else if (cents < 0) {
                      setError(`A plan cannot be negative. ${p.full_name} keeps ${formatAmountBare(r.monthlyCents)}.`);
                    } else {
                      setError(null);
                      setRow(p.category_id, { monthlyCents: cents });
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    else if (e.key === "Escape") setEditing(null);
                  }}
                />
              </td>
              <td className="num">{formatAmountBare(annualFromMonthly(r.monthlyCents, p.months, p.spread))}</td>
              <td>{p.months_label}</td>
            </tr>
          );
        })}
      </>
    );
  }

  return (
    <>
      {/* §183 — not while the write is running: closing then left the plan
          written with nothing on screen saying so, and a refusal nowhere. */}
      <div className="tm-dialog-backdrop" onClick={() => !busy && onCancel()} />
      <div className="tm-dialog tm-dialog-wide" role="dialog" aria-label="Build from history">
        <div className="tm-dialog-title">Build the {year} plan from {from}</div>
        <div className="tm-dialog-body">
          <p className="pb-2">
            Every line {from} actually saw, with a figure proposed for {year}. Expenses round up to
            the next ten and income rounds down, so the year errs on the side of holding. Change
            anything; nothing is written until you press the button.
          </p>
          {error && (
            <Notice tone="error" boxed className="mb-2">
              {error}
            </Notice>
          )}
          {rows === null ? (
            <div className="tm-budget-empty">Reading {from}…</div>
          ) : rows.length === 0 ? (
            <div className="tm-budget-empty">
              Nothing in {from} to go on. Set the lines you want by typing into the grid.
            </div>
          ) : (
            <div style={{ maxHeight: "50vh", overflowY: "auto" }}>
              <table className="tm-budget-table" style={{ width: "100%" }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left" }}>Category</th>
                    <th className="num">{from} actual</th>
                    <th style={{ textAlign: "left" }}>What {from} did</th>
                    <th className="num">Monthly</th>
                    <th className="num">Annual</th>
                    <th style={{ textAlign: "left" }}>Spread over</th>
                  </tr>
                </thead>
                <tbody>
                  {block("Income", income)}
                  {block("Expenses", expenses)}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex items-center gap-3 pt-3">
            <span aria-label="What this will write">{summaryOf(rows ?? [], year)}</span>
            <div className="flex-grow" />
            <button
              type="button"
              className="aero-btn default"
              disabled={busy || !rows || picksFrom(rows).length === 0}
              onClick={() => void apply()}
            >
              Write these into {year}
            </button>
            <button type="button" className="aero-btn" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
