// Payees manager.
//
// `transactions.payee` is a denormalized copy of the name (the register reads
// it directly), so a rename here rewrites every transaction as well; the store
// reloads the register afterwards so the old text does not linger on screen.
//
// Delete is deliberately narrow: a payee still on transactions must be MERGED,
// not deleted, or the register would show a name with nothing behind it. The
// backend enforces that; this view only offers Delete when the count is zero.
import { useEffect, useMemo, useRef, useState } from "react";
import TmIcon from "./TmIcon";
import Notice from "./Notice";
import CategorySelect from "./CategorySelect";
import PayeeRulesCard from "./PayeeRulesCard";
import { useAccountStore } from "../stores/useAccountStore";
import { useCommand } from "../lib/useCommand";
import type { Payee } from "../lib/types";

export default function PayeesView() {
  const payees = useAccountStore((s) => s.payees);
  const categories = useAccountStore((s) => s.categories);
  const loadPayees = useAccountStore((s) => s.loadPayees);
  const loadCategories = useAccountStore((s) => s.loadCategories);
  const editPayee = useAccountStore((s) => s.editPayee);
  const addPayee = useAccountStore((s) => s.addPayee);
  const mergePayees = useAccountStore((s) => s.mergePayees);
  const removePayee = useAccountStore((s) => s.removePayee);

  const [filter, setFilter] = useState("");
  const newRef = useRef<HTMLInputElement>(null);
  // File → New → Payee, when this screen is the one in front (command
  // priority). Off screen, the shell brings you here first.
  useCommand("new.payee", () => newRef.current?.focus(), true, 10);
  // Tools → Payee rename rules. The card is on this screen; when the
  // screen is open the menu item scrolls to it, and the shell brings you here
  // when it is not.
  useCommand(
    "tools.payee.rules",
    () => document.querySelector("[data-payee-rules]")?.scrollIntoView({ block: "start" }),
    true,
    10
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [newName, setNewName] = useState("");
  const [merging, setMerging] = useState<Payee | null>(null);
  const [mergeInto, setMergeInto] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A refused merge, shown in the merge dialog. It went to the edit
  // form's error line, behind the dialog's backdrop, where it could not be
  // seen (the same rule as the category dialogs). Cleared when the question
  // changes, so it never outlives the choice it answered.
  const [dialogError, setDialogError] = useState<string | null>(null);
  useEffect(() => {
    setDialogError(null);
  }, [merging, mergeInto]);

  useEffect(() => {
    loadPayees();
    loadCategories();
  }, [loadPayees, loadCategories]);

  const selected = payees.find((p) => p.id === selectedId) ?? null;

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? payees.filter((p) => p.name.toLowerCase().includes(q)) : payees;
  }, [payees, filter]);

  function select(p: Payee) {
    setSelectedId(p.id);
    setName(p.name);
    setCategoryId(p.last_category_id ?? "");
    setMsg(null);
    setError(null);
  }

  async function run(ok: string, fn: () => Promise<unknown>, onError: (text: string) => void = setError) {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      await fn();
      setMsg(ok);
      return true;
    } catch (e) {
      onError(String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    if (!name.trim()) {
      setError("Enter a payee name.");
      return;
    }
    await run("Payee saved.", () =>
      editPayee(selected.id, name.trim(), categoryId || null)
    );
  }

  /** Add a payee before its first transaction exists — the case the screen
   *  had no answer for. */
  async function add(e: React.FormEvent) {
    e.preventDefault();
    const wanted = newName.trim();
    if (!wanted) {
      setError("Enter a payee name.");
      return;
    }
    const ok = await run(`Added ${wanted}.`, () => addPayee(wanted, null));
    if (ok) {
      setNewName("");
      // Select it, so the category can be set straight away — which is most of
      // the reason to create one by hand.
      const made = useAccountStore.getState().payees.find((p) => p.name === wanted);
      if (made) select(made);
    }
  }

  async function confirmMerge() {
    if (!merging || !mergeInto) return;
    const ok = await run("Payees merged.", () => mergePayees(merging.id, mergeInto), setDialogError);
    if (ok) {
      if (selectedId === merging.id) {
        // Load the survivor into the form, not just its id. Setting
        // only `selectedId` left the merged-away payee's name in the Name
        // box under "Edit <survivor>", and Save then renamed the survivor —
        // and every transaction it had just been given — back to the name
        // the merge was meant to retire. The store has reloaded by now.
        const target = useAccountStore.getState().payees.find((p) => p.id === mergeInto);
        if (target) select(target);
        else setSelectedId(null);
        setMsg("Payees merged.");
      }
      setMerging(null);
      setMergeInto("");
    }
  }

  async function remove(p: Payee) {
    const ok = await run("Payee deleted.", () => removePayee(p.id));
    if (ok && selectedId === p.id) {
      setSelectedId(null);
      setName("");
      setCategoryId("");
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4">
      {/* The edit form first: choosing a payee in the list below fills it
          in, and a form at the foot of a long list was a long scroll away
          from the row that was just clicked. */}
      <section className="aero-card max-w-2xl">
        <div className="aero-card-title">
          {selected ? `Edit "${selected.name}"` : "Edit payee"}
        </div>
        <form onSubmit={save} className="p-3 space-y-2">
          {!selected && (
            <div className="text-[12px] text-slate-500">
              Choose a payee below to rename it or set the category it defaults to.
            </div>
          )}
          <label className="block text-[11px] text-slate-600">
            Name
            <input
              className="aero-field mt-1 w-full"
              aria-label="Payee name"
              value={name}
              disabled={!selected}
              onChange={(e) => setName(e.target.value)}
            />
            <span className="block pt-1 text-slate-500">
              Renaming updates every transaction that uses this payee.
            </span>
          </label>
          <label className="block text-[11px] text-slate-600">
            Default category
            <CategorySelect
              className="aero-field mt-1 w-full"
              label="Default category"
              categories={categories}
              value={categoryId}
              disabled={!selected}
              onChange={setCategoryId}
            />
            <span className="block pt-1 text-slate-500">
              Offered automatically the next time you enter this payee.
            </span>
          </label>
          <div className="pt-1">
            <button className="aero-btn default" disabled={busy || !selected}>
              Save
            </button>
          </div>
          {msg && <div className="text-[11px] text-green-700">{msg}</div>}
          {error && (
            <Notice tone="error" boxed>
              {error}
            </Notice>
          )}
        </form>
      </section>

      <section className="aero-card">
        <div className="aero-card-title">
          <TmIcon name="transactions" /> Payees
        </div>
        <div className="p-2">
          <div className="flex flex-wrap items-end gap-4 pb-2">
            <label className="block text-[11px] text-slate-600">
              Find
              <input
                className="aero-field mt-1 w-full max-w-xs"
                aria-label="Find payee"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Type part of a name"
              />
            </label>
            <form className="flex items-end gap-2" onSubmit={add}>
              <label className="block text-[11px] text-slate-600">
                New payee
                <input
                  className="aero-field mt-1"
                  ref={newRef}
                  aria-label="New payee name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. City Water"
                />
              </label>
              <button className="aero-btn" type="submit" disabled={busy || !newName.trim()}>
                Add
              </button>
            </form>
          </div>
          {shown.length === 0 ? (
            <div className="text-[12px] text-slate-500 p-3 text-center">
              {payees.length === 0
                ? "No payees yet. Add one above, or they appear as you enter transactions."
                : "No payee matches that."}
            </div>
          ) : (
            <table className="w-full text-[12px]">
              <thead>
                <tr
                  className="text-left text-slate-500 border-b"
                  style={{ borderColor: "var(--tm-ms-grid-line)" }}
                >
                  <th className="py-1 pl-1">Payee</th>
                  <th className="py-1">Default category</th>
                  <th className="py-1 text-right pr-2">Transactions</th>
                  <th className="py-1"></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr
                    key={p.id}
                    onClick={() => select(p)}
                    style={
                      p.id === selectedId
                        ? { background: "var(--tm-ms-row-active)" }
                        : undefined
                    }
                  >
                    <td className="py-[2px] pl-1">{p.name}</td>
                    <td className="py-[2px]">{p.last_category_name ?? "—"}</td>
                    <td className="py-[2px] text-right tabular-nums pr-2">
                      {p.usage_count}
                    </td>
                    <td className="py-[2px] text-right pr-1 whitespace-nowrap">
                      <button
                        type="button"
                        className="aero-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          setMerging(p);
                          setMergeInto("");
                        }}
                      >
                        Merge…
                      </button>{" "}
                      <button
                        type="button"
                        className="aero-btn"
                        disabled={busy || p.usage_count > 0}
                        title={
                          p.usage_count > 0
                            ? "Used by transactions — merge it instead"
                            : "Delete this payee"
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          void remove(p);
                        }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <PayeeRulesCard
        categories={categories}
        onApplied={async () => {
          await loadPayees();
          await useAccountStore.getState().reloadAll();
        }}
      />
      {merging && (
        <>
          <div className="tm-dialog-backdrop" onClick={() => !busy && setMerging(null)} />
          <div className="tm-dialog" role="dialog" aria-label="Merge payee">
            <div className="tm-dialog-title">Merge payee</div>
            <div className="tm-dialog-body space-y-2 text-[12px]">
              <p>
                Move all {merging.usage_count} transaction(s) from{" "}
                <strong>{merging.name}</strong> onto another payee, then delete it.
              </p>
              <label className="block">
                Merge into
                <select
                  className="aero-field mt-1 w-full"
                  aria-label="Merge into payee"
                  value={mergeInto}
                  onChange={(e) => setMergeInto(e.target.value)}
                >
                  <option value="">(choose a payee)</option>
                  {payees
                    .filter((p) => p.id !== merging.id)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </select>
              </label>
              {dialogError && (
                <Notice tone="error" boxed>
                  {dialogError}
                </Notice>
              )}
              <div className="flex justify-end gap-2 pt-3">
                <button
                  className="aero-btn default"
                  onClick={confirmMerge}
                  disabled={busy || !mergeInto}
                >
                  Merge
                </button>
                <button className="aero-btn" onClick={() => setMerging(null)} disabled={busy}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
