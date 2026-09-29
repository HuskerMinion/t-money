// Goals — savings goals with progress toward target (MS Money "Planning").
// CRUD over list_goals / create_goal / update_goal / delete_goal.
//
// A goal may WATCH an account. Its progress is then the starting
// amount plus every row in that account tagged for it — the monthly
// transfer to savings "for the roof" moves the roof — and "Contribute…"
// writes such a transfer from here. An unlinked goal is the typed number,
// as before.
import { Fragment, useEffect, useState, useRef } from "react";
import Money from "./Money";
import TmIcon from "./TmIcon";
import Notice from "./Notice";
import { useCommand } from "../lib/useCommand";
import { api } from "../lib/ipc";
import { noteChanged } from "../lib/undo";
import { formatMoney, parseMoneyToCents, today } from "../lib/format";
import { useAccountStore } from "../stores/useAccountStore";
import type { Goal } from "../lib/types";

export default function GoalsView() {
  const [goals, setGoals] = useState<Goal[]>([]);
  const accounts = useAccountStore((s) => s.accounts);
  const loadAccounts = useAccountStore((s) => s.loadAccounts);
  const [accountId, setAccountId] = useState("");
  // Contribute…: which goal is taking one, and the form.
  const [contributing, setContributing] = useState<string | null>(null);
  const [fromAccount, setFromAccount] = useState("");
  const [contribAmount, setContribAmount] = useState("");
  const [contribDate, setContribDate] = useState(today());
  const [contribMsg, setContribMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [saved, setSaved] = useState("");
  const [deadline, setDeadline] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setGoals(await api.listGoals());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    void loadAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function contribute(g: Goal) {
    const cents = parseMoneyToCents(contribAmount);
    if (!fromAccount) return setContribMsg("Pick the account the money comes from.");
    if (cents === null || cents <= 0) return setContribMsg("Enter an amount.");
    setBusy(true);
    setContribMsg(null);
    try {
      await api.contributeToGoal(g.id, fromAccount, contribDate, cents, null);
      noteChanged(); // The backend cleared the undo stack.
      setContributing(null);
      setContribAmount("");
      await load();
      await loadAccounts();
    } catch (err) {
      setContribMsg(String(err));
    } finally {
      setBusy(false);
    }
  }

  // File → New → Savings goal, when this screen is in front (command
  // priority); off screen, the shell navigates here first.
  useCommand(
    "new.goal",
    () => {
      resetForm();
      nameRef.current?.focus();
    },
    true,
    10
  );

  function resetForm() {
    setEditingId(null);
    setName("");
    setTarget("");
    setSaved("");
    setDeadline("");
    setNotes("");
    setAccountId("");
    setMsg(null);
  }

  function startEdit(g: Goal) {
    setEditingId(g.id);
    setName(g.name);
    setTarget((g.target_cents / 100).toFixed(2));
    // The typed part only: what the tagged rows add is not editable here.
    setSaved((g.starting_cents / 100).toFixed(2));
    setAccountId(g.account_id ?? "");
    setDeadline(g.deadline ?? "");
    setNotes(g.notes ?? "");
    setMsg(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const t = parseMoneyToCents(target);
    const s = parseMoneyToCents(saved);
    if (!name.trim() || t === null || s === null) {
      setMsg("Enter a name, target, and saved amount.");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const payload = {
        name: name.trim(),
        targetCents: t,
        savedCents: s,
        deadline: deadline || null,
        notes: notes.trim() || null,
      };
      if (editingId) {
        await api.updateGoal(editingId, payload.name, payload.targetCents, payload.savedCents, payload.deadline, payload.notes, accountId || null);
      } else {
        await api.createGoal(payload.name, payload.targetCents, payload.savedCents, payload.deadline, payload.notes, accountId || null);
      }
      resetForm();
      await load();
    } catch (err) {
      setMsg(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(g: Goal) {
    if (!window.confirm(`Delete goal "${g.name}"?`)) return;
    try {
      await api.deleteGoal(g.id);
      if (editingId === g.id) resetForm();
      await load();
    } catch (err) {
      setMsg(String(err));
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      {/* Goals list */}
      <section className="aero-card lg:col-span-2">
        <div className="aero-card-title flex items-center gap-2">
          <TmIcon name="goals" size={15} /> Savings Goals
        </div>
        <div className="p-2 max-h-[60vh] overflow-y-auto">
          {error && (
            <Notice tone="error" boxed className="mb-2">
              {error}
            </Notice>
          )}
          {loading && goals.length === 0 ? (
            <div className="text-[12px] text-slate-500 p-3 text-center">Loading…</div>
          ) : goals.length === 0 ? (
            <div className="text-[12px] text-slate-500 p-3 text-center">
              No goals yet. Add one on the right.
            </div>
          ) : (
            <table className="register-table">
              <thead>
                <tr>
                  <th>Goal</th>
                  <th className="num">Saved</th>
                  <th className="num">Target</th>
                  <th style={{ width: 140 }}>Progress</th>
                  <th>Deadline</th>
                  <th className="num" style={{ width: 110 }}>
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {goals.map((g) => {
                  const pct =
                    g.target_cents > 0
                      ? Math.min(100, Math.round((g.saved_cents / g.target_cents) * 100))
                      : 0;
                  const done = g.target_cents > 0 && g.saved_cents >= g.target_cents;
                  return (
                    <Fragment key={g.id}>
                    <tr title={g.notes ?? undefined}>
                      <td>
                        {g.name}
                        {done && (
                          <span className="ml-1 text-[color:var(--tm-positive)] font-bold" title="Goal reached">
                            ✓
                          </span>
                        )}
                      </td>
                      <td
                        className="num"
                        title={
                          g.account_id
                            ? `${formatMoney(g.starting_cents)} to start + ${formatMoney(g.linked_cents)} from ${g.linked_count} tagged row${g.linked_count === 1 ? "" : "s"} in ${g.account_name}`
                            : "Typed — link the goal to an account to have it counted from the register"
                        }
                      >
                        <Money cents={g.saved_cents} tone="neutral" />
                        {g.account_id && <span className="block text-[10px] text-slate-500">watches {g.account_name}</span>}
                      </td>
                      <td className="num">
                        <Money cents={g.target_cents} tone="neutral" />
                      </td>
                      <td>
                        <div className="flex items-center gap-2">
                          <div
                            className="h-2 rounded overflow-hidden"
                            style={{ width: 80, background: "var(--tm-ms-grid-header)", border: "1px solid var(--tm-ms-card-border)" }}
                          >
                            <div
                              style={{
                                width: `${pct}%`,
                                height: "100%",
                                background: done
                                  ? "linear-gradient(180deg,var(--tm-bar-done-top),var(--tm-bar-done-bot))"
                                  : "linear-gradient(180deg,var(--tm-bar-under-top),var(--tm-bar-under-bot))",
                              }}
                            />
                          </div>
                          <span className="text-[11px] tabular-nums text-slate-600">{pct}%</span>
                        </div>
                      </td>
                      <td className="tabular-nums text-slate-600">{g.deadline ?? "—"}</td>
                      <td className="num">
                        <span className="inline-flex gap-1">
                          {g.account_id && (
                            <button
                              className="aero-btn !py-0 !px-1.5 text-[11px]"
                              onClick={() => {
                                // A new form for a different goal starts
                                // empty. "From" carried over, and a From that was
                                // THIS goal's own account is filtered out of its
                                // list: the picker read "(choose)" while the state
                                // still said Savings, and Move sent Savings to
                                // Savings.
                                if (contributing !== g.id) {
                                  setFromAccount("");
                                  setContribAmount("");
                                }
                                setContributing(contributing === g.id ? null : g.id);
                                setContribMsg(null);
                              }}
                              title={`Move money into ${g.account_name} for this goal`}
                            >
                              Contribute…
                            </button>
                          )}
                          <button
                            className="aero-btn !py-0 !px-1.5 text-[11px]"
                            onClick={() => startEdit(g)}
                            title="Edit"
                          >
                            Edit
                          </button>
                          <button
                            className="aero-btn !py-0 !px-1.5 text-[11px] money-neg"
                            onClick={() => remove(g)}
                            title="Delete"
                          >
                            Del
                          </button>
                        </span>
                      </td>
                    </tr>
                    {contributing === g.id && (
                      <tr>
                        <td colSpan={6}>
                          <form
                            className="flex items-end gap-2 flex-wrap py-1"
                            onSubmit={(e) => {
                              e.preventDefault();
                              void contribute(g);
                            }}
                          >
                            <label className="flex flex-col text-[11px]">
                              From
                              <select className="aero-field" aria-label="From account" value={fromAccount} onChange={(e) => setFromAccount(e.target.value)}>
                                <option value="">(choose)</option>
                                {accounts
                                  .filter((a) => a.id !== g.account_id && !a.is_closed)
                                  .map((a) => (
                                    <option key={a.id} value={a.id}>
                                      {a.name}
                                    </option>
                                  ))}
                              </select>
                            </label>
                            <label className="flex flex-col text-[11px]">
                              Amount
                              <input className="aero-field text-right" style={{ width: 100 }} aria-label="Contribution" value={contribAmount} onChange={(e) => setContribAmount(e.target.value)} placeholder="0.00" />
                            </label>
                            <label className="flex flex-col text-[11px]">
                              Date
                              <input className="aero-field" type="date" aria-label="Contribution date" value={contribDate} onChange={(e) => setContribDate(e.target.value)} />
                            </label>
                            <button className="aero-btn" type="submit" disabled={busy}>
                              Move to {g.account_name}
                            </button>
                            <span className="text-[11px] tm-text-muted">A transfer, tagged for the goal — it shows in both registers.</span>
                            {contribMsg && (
                              <Notice tone="error" boxed>
                                {contribMsg}
                              </Notice>
                            )}
                          </form>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* Add / edit form */}
      <section className="aero-card">
        <div className="aero-card-title">{editingId ? "Edit Goal" : "New Goal"}</div>
        <form onSubmit={submit} className="p-3 space-y-2">
          <label className="block text-[11px] text-slate-600">
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded px-2 py-1 text-[12px] border"
              style={{ borderColor: "var(--tm-ms-card-border)" }}
              ref={nameRef}
              placeholder="e.g. Emergency Fund"
            />
          </label>
          <label className="block text-[11px] text-slate-600">
            Target
            <input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="mt-1 w-full rounded px-2 py-1 text-[12px] border"
              style={{ borderColor: "var(--tm-ms-card-border)" }}
              placeholder="10000.00"
            />
          </label>
          <label className="block text-[11px] text-slate-600">
            Watches account
            <select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="mt-1 w-full rounded px-2 py-1 text-[12px] border"
              style={{ borderColor: "var(--tm-ms-card-border)" }}
              aria-label="Watches account"
            >
              <option value="">(none — I will type the amount)</option>
              {accounts
                .filter((a) => !a.is_closed)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
            <span className="block text-[10px] text-slate-500">
              Linked, the goal counts every row in that account you tag for it; “Contribute…” writes one.
            </span>
          </label>
          <label className="block text-[11px] text-slate-600">
            {accountId ? "Starting amount (before the tagged rows)" : "Saved so far"}
            <input
              value={saved}
              onChange={(e) => setSaved(e.target.value)}
              className="mt-1 w-full rounded px-2 py-1 text-[12px] border"
              style={{ borderColor: "var(--tm-ms-card-border)" }}
              placeholder="2500.00"
            />
          </label>
          <label className="block text-[11px] text-slate-600">
            Deadline
            <input
              type="date"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
              className="mt-1 w-full rounded px-2 py-1 text-[12px] border"
              style={{ borderColor: "var(--tm-ms-card-border)" }}
            />
          </label>
          <label className="block text-[11px] text-slate-600">
            Notes
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="mt-1 w-full rounded px-2 py-1 text-[12px] border"
              style={{ borderColor: "var(--tm-ms-card-border)" }}
              placeholder="optional"
            />
          </label>
          <div className="flex gap-2">
            <button className="aero-btn flex-1" disabled={busy}>
              {busy ? "Saving…" : editingId ? "Save Changes" : "Add Goal"}
            </button>
            {editingId && (
              <button type="button" className="aero-btn" onClick={resetForm}>
                Cancel
              </button>
            )}
          </div>
          {/* Every message this form sets is a refusal (a missing figure,
              or the backend's), and in gray text it read as a hint. */}
          {msg && (
            <Notice tone="error" boxed>
              {msg}
            </Notice>
          )}
        </form>
      </section>
    </div>
  );
}
