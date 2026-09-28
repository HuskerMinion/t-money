// §106 — Tools → Rename payees in existing transactions.
//
// This is what T-Money has instead of Money's Find and Replace, and it is
// narrower on purpose. Money's version was a bulk editor over any field; this
// one does the job that actually comes up — your bank writes
// "NETFLIX.COM 866-579-7172 CA" and you want it to say "Netflix" on the two
// hundred rows already in the file, not just the next import.
//
// THE APPLY IS NOT NEW. The button on the payee rules card has rewritten
// existing rows since §84. What was missing is the two things that make a bulk
// edit safe to press:
//
//   1. **Seeing it first.** "412 rows changed" told after the fact is not
//      information, it is a thing that has happened to you. Every row is
//      listed here with what it says now and what it would say, and each can
//      be unticked.
//   2. **Taking it back.** It is one step on the undo stack now, so Ctrl+Z
//      returns all of it. A bulk edit that can only be undone one row at a
//      time is not one anybody would dare run on ten years of history.
//
// Rows are ticked by default: you came here to apply the rules, and a list
// that starts empty makes you do the work twice. The grouping is by rule,
// because a surprising row is nearly always a rule matching more widely than
// its author expected — and the fastest way to see that is to find every row
// one rule claimed sitting together.
import { useEffect, useMemo, useState } from "react";
import Money from "./Money";
import Notice from "./Notice";
import { api } from "../lib/ipc";
import { formatDateUS } from "../lib/format";
import type { PayeeRuleChange } from "../lib/types";

interface Props {
  onClose: () => void;
  /** Rows were changed; reload registers and payees. */
  onApplied: (changed: number) => void;
}

export default function ApplyPayeeRulesDialog({ onClose, onApplied }: Props) {
  const [changes, setChanges] = useState<PayeeRuleChange[] | null>(null);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .previewPayeeRules()
      .then((c) => {
        if (live) setChanges(c);
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
    };
  }, []);

  /** By rule, so a rule matching more widely than intended is obvious. */
  const groups = useMemo(() => {
    const by = new Map<string, { id: string; match: string; to: string; rows: PayeeRuleChange[] }>();
    for (const c of changes ?? []) {
      const g = by.get(c.rule_id) ?? { id: c.rule_id, match: c.match_text, to: c.new_payee, rows: [] };
      g.rows.push(c);
      by.set(c.rule_id, g);
    }
    return [...by.values()].sort((a, b) => b.rows.length - a.rows.length);
  }, [changes]);

  const chosen = (changes ?? []).filter((c) => !skipped.has(c.transaction_id));

  function toggle(id: string) {
    setSkipped((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleGroup(rows: PayeeRuleChange[], on: boolean) {
    setSkipped((s) => {
      const next = new Set(s);
      for (const r of rows) {
        if (on) next.delete(r.transaction_id);
        else next.add(r.transaction_id);
      }
      return next;
    });
  }

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const n = await api.applyPayeeRules(chosen.map((c) => c.transaction_id));
      onApplied(n);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <div
      className="tm-dialog"
      role="dialog"
      aria-label="Rename payees in existing transactions"
      style={{ minWidth: 620, maxWidth: 900 }}
    >
      <div className="tm-dialog-title">Rename payees in existing transactions</div>
      <div className="tm-dialog-body" style={{ maxHeight: "74vh", overflowY: "auto" }}>
        {error && (
          <Notice tone="error" boxed className="mb-2">
            {error}
          </Notice>
        )}

        {changes === null ? (
          <p className="text-[12px]">Looking through the file…</p>
        ) : changes.length === 0 ? (
          <p className="text-[12px]">
            Nothing to change — every transaction already matches your rules, or you have no rules
            yet. Rules live under <strong>Tools → Payee rename rules</strong>.
          </p>
        ) : (
          <>
            <p className="text-[12px] pb-2">
              {changes.length} transaction{changes.length === 1 ? "" : "s"} would change. Uncheck
              anything you want left alone. This lands on the undo stack as one step, so{" "}
              <strong>Ctrl+Z</strong> takes all of it back.
            </p>

            {groups.map((g) => {
              const allOn = g.rows.every((r) => !skipped.has(r.transaction_id));
              return (
                // §183 — keyed by the rule, as the groups are built. Two rules
                // can share match text (§171's amount, memo and account conditions),
                // and two sections under one key had React mixing up their rows.
                <section className="aero-card" key={g.id} style={{ marginBottom: 10 }}>
                  <div className="aero-card-title flex items-center justify-between gap-2">
                    <span>
                      “{g.match}” → <strong>{g.to}</strong>
                    </span>
                    <label className="flex items-center gap-1 text-[11px] font-normal">
                      <input
                        type="checkbox"
                        checked={allOn}
                        aria-label={`All ${g.rows.length} rows matching ${g.match}`}
                        onChange={() => toggleGroup(g.rows, !allOn)}
                      />
                      all {g.rows.length}
                    </label>
                  </div>
                  <div className="p-2">
                    <table className="w-full text-[12px]">
                      <thead>
                        <tr className="text-left">
                          <th style={{ width: 24 }} />
                          <th style={{ width: 84 }}>Date</th>
                          <th>Account</th>
                          <th>Payee now</th>
                          <th className="text-right" style={{ width: 90 }}>
                            Amount
                          </th>
                          <th style={{ width: 150 }}>Category</th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.rows.map((c) => {
                          const on = !skipped.has(c.transaction_id);
                          const filing =
                            c.new_category_id !== null &&
                            c.new_category_name !== c.category_name;
                          return (
                            <tr key={c.transaction_id} style={on ? undefined : { opacity: 0.45 }}>
                              <td>
                                <input
                                  type="checkbox"
                                  checked={on}
                                  aria-label={`Rename ${c.payee} on ${c.date}`}
                                  onChange={() => toggle(c.transaction_id)}
                                />
                              </td>
                              <td>{formatDateUS(c.date)}</td>
                              <td className="truncate">{c.account_name}</td>
                              <td className="truncate" title={c.payee}>
                                {c.payee}
                              </td>
                              <td className="text-right tabular-nums">
                                <Money cents={c.amount_cents} />
                              </td>
                              <td className="truncate">
                                {filing ? (
                                  <span>
                                    <span style={{ color: "var(--tm-ms-text-muted)" }}>(none)</span> →{" "}
                                    {c.new_category_name}
                                  </span>
                                ) : (
                                  <span style={{ color: "var(--tm-ms-text-muted)" }}>
                                    {c.category_name ?? "(none)"}
                                  </span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </section>
              );
            })}

            <p className="text-[11px]" style={{ color: "var(--tm-ms-text-muted)" }}>
              A category is only filled in where the transaction has none. One you chose yourself is
              never overwritten.
            </p>
          </>
        )}

        <div className="flex items-center justify-between pt-3">
          <span className="text-[11px]" style={{ color: "var(--tm-ms-text-muted)" }}>
            {changes && changes.length > 0 && `${chosen.length} of ${changes.length} selected`}
          </span>
          <div className="flex gap-2">
            <button className="aero-btn" type="button" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              className="aero-btn"
              type="button"
              onClick={() => void run()}
              disabled={busy || chosen.length === 0}
            >
              {busy ? "Renaming…" : `Rename ${chosen.length}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
