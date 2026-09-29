// Categories manager — Money's category tree.
//
// The tree is exactly two levels: a category, and its subcategories. Each side
// of the tree is either Income or Expense, and a subcategory always shares its
// parent's kind — that rule lives in the backend (`update_category` cascades
// it), so this view never has to reconcile a child with a parent it disagrees
// with.
//
// Delete and Merge are the two operations that touch existing transactions, so
// both state plainly how many they will move before you confirm.
import { useEffect, useRef, useState } from "react";
import TaxLinePicker from "./TaxLinePicker";
import TmIcon from "./TmIcon";
import Notice from "./Notice";
import { useAccountStore } from "../stores/useAccountStore";
import { api } from "../lib/ipc";
import { useCommand } from "../lib/useCommand";
import type { Category, CategoryKind, MergePreview } from "../lib/types";

/** Top-level categories of one kind, each followed by its children. */
export function treeOf(
  categories: readonly Category[],
  kind: CategoryKind
): { parent: Category; children: Category[] }[] {
  return categories
    .filter((c) => c.kind === kind && c.parent_id === null)
    .map((parent) => ({
      parent,
      children: categories.filter((c) => c.parent_id === parent.id),
    }));
}

/** The plain-English list of what a merge moves.
 *
 *  Exported and pure so it can be tested without a dialog. Zero counts are
 *  left out entirely: "0 payee rules" is noise in a sentence whose job is to
 *  make one specific consequence obvious.
 */
export function movesList(p: MergePreview): string[] {
  const out: string[] = [];
  const n = (count: number, one: string, many: string) =>
    `${count} ${count === 1 ? one : many}`;
  if (p.transactions) out.push(n(p.transactions, "transaction", "transactions"));
  if (p.splits) out.push(n(p.splits, "split line", "split lines"));
  if (p.children) out.push(n(p.children, "subcategory", "subcategories"));
  if (p.budgets) out.push(n(p.budgets, "budgeted month", "budgeted months"));
  if (p.payeeRules) out.push(n(p.payeeRules, "payee rule", "payee rules"));
  if (p.recurrences) out.push(n(p.recurrences, "scheduled bill", "scheduled bills"));
  if (p.otherLinks) out.push(n(p.otherLinks, "other link", "other links"));
  return out;
}

export default function CategoriesView() {
  const categories = useAccountStore((s) => s.categories);
  const loadCategories = useAccountStore((s) => s.loadCategories);
  const addCategory = useAccountStore((s) => s.addCategory);
  const editCategory = useAccountStore((s) => s.editCategory);
  const removeCategory = useAccountStore((s) => s.removeCategory);
  const mergeCategories = useAccountStore((s) => s.mergeCategories);
  const seedStandardCategories = useAccountStore((s) => s.seedStandardCategories);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  // File → New → Category. Registered at priority 10 so that when this
  // screen is already open the menu item does the thing here rather than the
  // shell's "go to the categories screen". Same command, two owners, the
  // nearer one wins.
  useCommand(
    "new.category",
    () => {
      setSelectedId(null);
      setName("");
      setParentId("");
      nameRef.current?.focus();
    },
    true,
    10
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Form state — doubles as "new category" and "edit selected".
  const [name, setName] = useState("");
  const [kind, setKind] = useState<CategoryKind>("expense");
  const [parentId, setParentId] = useState("");
  const [taxLine, setTaxLine] = useState("");

  // Delete / merge targets.
  const [deleting, setDeleting] = useState<Category | null>(null);
  const [reassignTo, setReassignTo] = useState("");
  const [merging, setMerging] = useState<Category | null>(null);
  const [mergeInto, setMergeInto] = useState("");
  // What the merge would do, re-asked whenever either side changes.
  const [mergePreview, setMergePreview] = useState<MergePreview | null>(null);
  // A refused delete or merge, shown INSIDE the dialog that was
  // refused. It went to the form's error line, which sits behind the dialog's
  // backdrop, so the press looked like nothing at all: "Delete refused but
  // there was no message, it just acted like I didn't press the button".
  // Cleared when the dialog or its choice changes, so it never outlives the
  // question it answered.
  const [dialogError, setDialogError] = useState<string | null>(null);
  useEffect(() => {
    setDialogError(null);
  }, [deleting, merging, reassignTo, mergeInto]);

  // Ask the backend rather than counting in the browser. `usage_count` is the
  // transactions and nothing else, and the four numbers that surprised a user
  // — payee rules, scheduled bills, budgeted months, subcategories — are not
  // in the category list at all.
  useEffect(() => {
    if (!merging || !mergeInto) {
      setMergePreview(null);
      return;
    }
    let alive = true;
    api
      .previewCategoryMerge(merging.id, mergeInto)
      .then((p) => alive && setMergePreview(p))
      .catch(() => alive && setMergePreview(null));
    return () => {
      alive = false;
    };
  }, [merging, mergeInto]);

  useEffect(() => {
    loadCategories();
  }, [loadCategories]);

  const selected = categories.find((c) => c.id === selectedId) ?? null;
  const topLevel = categories.filter((c) => c.parent_id === null);

  /** Back to "new category". `keepMessage`: after a create or a
   *  delete the form is emptied, but the line saying it worked has to stay;
   *  clearing it here wiped "Category created." the moment it was set. */
  function clearForm(keepMessage = false) {
    setSelectedId(null);
    setName("");
    setKind("expense");
    setParentId("");
    setTaxLine("");
    if (!keepMessage) setMsg(null);
    setError(null);
  }

  function select(c: Category) {
    setSelectedId(c.id);
    setName(c.name);
    setKind(c.kind);
    setParentId(c.parent_id ?? "");
    setTaxLine(c.tax_line ?? "");
    setMsg(null);
    setError(null);
  }

  async function run(what: string, fn: () => Promise<unknown>, onError: (text: string) => void = setError) {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      await fn();
      setMsg(what);
      return true;
    } catch (e) {
      onError(String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Enter a category name.");
      return;
    }
    const parent = parentId || null;
    const tax = taxLine.trim() || null;
    if (selected) {
      const ok = await run("Category saved.", () =>
        editCategory(selected.id, name.trim(), kind, parent, tax)
      );
      if (ok) setMsg("Category saved.");
    } else {
      const ok = await run("Category created.", () =>
        addCategory(name.trim(), kind, parent, tax)
      );
      if (ok) clearForm(true);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    const target = reassignTo || null;
    const ok = await run(
      target ? "Category deleted and its transactions refiled." : "Category deleted.",
      () => removeCategory(deleting.id, target),
      setDialogError
    );
    if (ok) {
      setDeleting(null);
      setReassignTo("");
      if (selectedId === deleting.id) clearForm(true);
    }
  }

  /** The category being merged INTO — the one that survives. */
  const mergeTarget = categories.find((c) => c.id === mergeInto) ?? null;

  /** Keep the other one instead. Picking the wrong survivor is the
   *  mistake this dialog exists to prevent, and making it recoverable inside
   *  the dialog is better than making it recoverable afterwards. */
  function swapMergeDirection() {
    if (!merging || !mergeTarget) return;
    const from = merging;
    setMerging(mergeTarget);
    setMergeInto(from.id);
  }

  async function confirmMerge() {
    if (!merging || !mergeInto) return;
    const ok = await run("Categories merged.", () => mergeCategories(merging.id, mergeInto), setDialogError);
    if (ok) {
      setMerging(null);
      setMergeInto("");
      setMergePreview(null);
      if (selectedId === merging.id) clearForm(true);
      // Stay where the user was working.
      // > "once I made the change it pops back to the top of the categories
      // >  and when I undid it it brought the category back as it should but
      // >  was at the top and I had to scroll to see it again."
      // The list reloads and the page goes back to the top, which on a long
      // category list means hunting for the row you just acted on. Select the
      // SURVIVING category and bring it into view instead: it is the row the
      // merge just changed, and it is where the eye should land.
      revealCategory(mergeInto);
      setMsg("Categories merged.");
    }
  }

  /** Select a category and scroll it into view once the list that
   *  holds it has been drawn again. Used after a merge, and after an undo
   *  puts a category back.
   *
   *  `requestAnimationFrame` rather than a bare call: the row does not exist
   *  until the reload has rendered, and scrolling to a row that is not there
   *  yet is a silent no-op — an old class of bug, where a control moves the
   *  selection and leaves the user where they were. */
  function revealCategory(id: string) {
    if (!id) return;
    // Select it properly: the form as well as the highlight. Setting
    // only `selectedId` left the form holding whatever it held before — the
    // merged-away category, or another one entirely — under the survivor's
    // highlight, and Save then renamed the survivor to that old name. The
    // store has the reloaded list by the time a merge resolves.
    const c = useAccountStore.getState().categories.find((x) => x.id === id);
    if (c) select(c);
    else setSelectedId(id);
    requestAnimationFrame(() => {
      const row = document.querySelector(`[data-category-row="${id}"]`);
      // Feature-checked: `scrollIntoView` is not implemented in jsdom, and an
      // unhandled throw here would take the whole view down over a nicety.
      if (row && typeof row.scrollIntoView === "function") {
        row.scrollIntoView({ block: "center" });
      }
    });
  }

  function row(c: Category, isChild: boolean) {
    return (
      <tr
        key={c.id}
        data-category-row={c.id}
        className={c.id === selectedId ? "tm-row-selected" : undefined}
        style={c.id === selectedId ? { background: "var(--tm-ms-row-active)" } : undefined}
        onClick={() => select(c)}
      >
        <td className="py-[2px]" style={{ paddingLeft: isChild ? 22 : 6 }}>
          {isChild ? "└ " : ""}
          {c.name}
        </td>
        <td className="py-[2px] text-right tabular-nums pr-2">{c.usage_count}</td>
        <td className="py-[2px] pr-2">{c.tax_line ?? ""}</td>
        <td className="py-[2px] text-right pr-1 whitespace-nowrap">
          <button
            type="button"
            className="aero-btn"
            onClick={(e) => {
              e.stopPropagation();
              setMerging(c);
              setMergeInto("");
              setDeleting(null);
            }}
          >
            Merge…
          </button>{" "}
          <button
            type="button"
            className="aero-btn"
            onClick={(e) => {
              e.stopPropagation();
              setDeleting(c);
              setReassignTo("");
              setMerging(null);
            }}
          >
            Delete…
          </button>
        </td>
      </tr>
    );
  }

  function side(k: CategoryKind, title: string) {
    const tree = treeOf(categories, k);
    return (
      <section className="aero-card">
        <div className="aero-card-title">
          <TmIcon name="budgeting" /> {title}
        </div>
        <div className="p-2">
          {tree.length === 0 ? (
            <div className="text-[12px] text-slate-500 p-3 text-center">
              No {title.toLowerCase()} categories yet.
            </div>
          ) : (
            <table className="w-full text-[12px]">
              <thead>
                <tr
                  className="text-left text-slate-500 border-b"
                  style={{ borderColor: "var(--tm-ms-grid-line)" }}
                >
                  <th className="py-1 pl-1">Category</th>
                  <th className="py-1 text-right pr-2">Used</th>
                  <th className="py-1 pr-2">Tax line</th>
                  <th className="py-1"></th>
                </tr>
              </thead>
              <tbody>
                {tree.flatMap(({ parent, children }) => [
                  row(parent, false),
                  ...children.map((c) => row(c, true)),
                ])}
              </tbody>
            </table>
          )}
        </div>
      </section>
    );
  }

  async function addStandardSet() {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const created = await seedStandardCategories();
      setMsg(
        created === 0
          ? "Nothing to add — you already have the whole standard set."
          : `Added ${created} standard categor${created === 1 ? "y" : "ies"}.`
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4">
      {/* Money ships a standard chart of categories and you prune it. A file
          with none makes every picker in the app useless — the Budget screen
          offers nothing to budget against — so this is offered prominently
          while the list is empty, and stays available afterwards because the
          set grows as categories are added upstream. */}
      <section className="aero-card">
        <div className="aero-card-title">Standard categories</div>
        <div className="p-3 flex items-center gap-3 flex-wrap">
          <button
            type="button"
            className={categories.length === 0 ? "aero-btn default" : "aero-btn"}
            onClick={addStandardSet}
            disabled={busy}
          >
            Add standard categories
          </button>
          <span className="text-[11px] text-slate-600">
            {categories.length === 0
              ? "You have no categories yet. This adds Money's usual set — income, expenses and subcategories — which you can then rename, delete or add to."
              : "Adds anything from Money's usual set you don't already have. Never changes or removes a category you have edited."}
          </span>
        </div>
      </section>

      {side("income", "Income")}
      {side("expense", "Expense")}

      <section className="aero-card max-w-2xl">
        <div className="aero-card-title">
          {selected ? `Edit "${selected.full_name}"` : "New category"}
        </div>
        <form onSubmit={submit} className="p-3 space-y-2">
          <label className="block text-[11px] text-slate-600">
            Name
            <input
              className="aero-field mt-1 w-full"
              ref={nameRef}
              aria-label="Category name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Groceries"
            />
          </label>
          <label className="block text-[11px] text-slate-600">
            Type
            <select
              className="aero-field mt-1 w-full"
              aria-label="Category type"
              value={kind}
              disabled={parentId !== ""}
              onChange={(e) => setKind(e.target.value as CategoryKind)}
            >
              <option value="expense">Expense</option>
              <option value="income">Income</option>
            </select>
          </label>
          <label className="block text-[11px] text-slate-600">
            Subcategory of
            <select
              className="aero-field mt-1 w-full"
              aria-label="Parent category"
              value={parentId}
              onChange={(e) => {
                setParentId(e.target.value);
                const p = categories.find((c) => c.id === e.target.value);
                if (p) setKind(p.kind);
              }}
            >
              <option value="">(top level)</option>
              {topLevel
                .filter((c) => c.id !== selectedId)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.kind})
                  </option>
                ))}
            </select>
            <span className="block pt-1 text-slate-500">
              A subcategory takes its parent's type.
            </span>
          </label>
          <label className="block text-[11px] text-slate-600">
            Tax line
            <div className="mt-1">
              <TaxLinePicker value={taxLine} onChange={setTaxLine} className="aero-field w-full" />
            </div>
          </label>
          <div className="flex gap-2 pt-1">
            <button className="aero-btn default" disabled={busy}>
              {selected ? "Save" : "Create"}
            </button>
            {selected && (
              <button type="button" className="aero-btn" onClick={() => clearForm()} disabled={busy}>
                New
              </button>
            )}
          </div>
          {msg && <div className="text-[11px] text-green-700">{msg}</div>}
          {error && (
            <Notice tone="error" boxed>
              {error}
            </Notice>
          )}
        </form>
      </section>

      {deleting && (
        <>
          <div className="tm-dialog-backdrop" onClick={() => setDeleting(null)} />
          <div className="tm-dialog" role="dialog" aria-label="Delete category">
            <div className="tm-dialog-title">Delete category</div>
            <div className="tm-dialog-body space-y-2 text-[12px]">
              <p>
                Delete <strong>{deleting.full_name}</strong>?
              </p>
              <p>
                {deleting.usage_count === 0
                  ? "Nothing is filed under it."
                  : `${deleting.usage_count} transaction line(s) are filed under it.`}
              </p>
              <label className="block">
                Move them to
                <select
                  className="aero-field mt-1 w-full"
                  aria-label="Reassign transactions to"
                  value={reassignTo}
                  onChange={(e) => setReassignTo(e.target.value)}
                >
                  <option value="">(leave uncategorized)</option>
                  {categories
                    .filter((c) => c.id !== deleting.id)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.full_name}
                      </option>
                    ))}
                </select>
              </label>
              <p className="text-slate-500">
                Any subcategories are kept and promoted to the top level.
              </p>
              {dialogError && (
                <Notice tone="error" boxed>
                  {dialogError}
                </Notice>
              )}
              <div className="flex justify-end gap-2 pt-3">
                <button className="aero-btn default" onClick={confirmDelete} disabled={busy}>
                  Delete
                </button>
                <button className="aero-btn" onClick={() => setDeleting(null)} disabled={busy}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {merging && (
        <>
          <div className="tm-dialog-backdrop" onClick={() => setMerging(null)} />
          <div className="tm-dialog" role="dialog" aria-label="Merge category">
            <div className="tm-dialog-title">Merge category</div>
            <div className="tm-dialog-body space-y-2 text-[12px]">
              <label className="block">
                Merge into
                <select
                  className="aero-field mt-1 w-full"
                  aria-label="Merge into"
                  value={mergeInto}
                  onChange={(e) => setMergeInto(e.target.value)}
                >
                  <option value="">(choose a category)</option>
                  {categories
                    .filter((c) => c.id !== merging.id)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.full_name}
                      </option>
                    ))}
                </select>
              </label>

              {/* The direction, drawn rather than described.
                  > "Its not intuitive on which way the merge goes"
                  One side is kept and one side is deleted; saying so in a
                  sentence did not land, so each side says its own fate under
                  its own name, and Swap flips them without reopening. */}
              {mergeTarget ? (
                <>
                  <div className="tm-merge-flow">
                    <div className="tm-merge-side tm-merge-from">
                      <div className="tm-merge-name">{merging.full_name}</div>
                      <div className="tm-merge-fate">emptied, then deleted</div>
                    </div>
                    <div className="tm-merge-arrow" aria-hidden="true">
                      →
                    </div>
                    <div className="tm-merge-side tm-merge-into">
                      <div className="tm-merge-name">{mergeTarget.full_name}</div>
                      <div className="tm-merge-fate">kept — receives everything</div>
                    </div>
                  </div>
                  <div className="text-right">
                    <button
                      type="button"
                      className="aero-btn"
                      onClick={swapMergeDirection}
                      disabled={busy}
                      title="Keep the other one instead"
                    >
                      ⇄ Swap direction
                    </button>
                  </div>
                </>
              ) : (
                <p>
                  Everything filed under <strong>{merging.full_name}</strong> moves to the
                  category you choose, and <strong>{merging.full_name}</strong> is then
                  deleted.
                </p>
              )}

              {mergePreview?.blocked ? (
                /* A refusal should look like one.
                   > "While the button to merge an expense and income category
                   >  doesn't work, I'd like something more substantial like
                   >  this merge can't be done and the reason with only cancel
                   >  or select another category as an option."
                   The button was already disabled, so nothing bad could
                   happen — but a grayed button and one line of red text left
                   the user pressing something that did not respond, which reads as
                   the app being broken rather than as an answer. */
                <div className="tm-merge-blocked" role="alert">
                  <div className="tm-merge-blocked-head">This merge cannot be done</div>
                  <p>{mergePreview.blocked}</p>
                  <p className="tm-text-muted">
                    Choose a different category above, use <strong>⇄ Swap direction</strong>, or
                    Cancel.
                  </p>
                </div>
              ) : (
                mergePreview && (
                  <>
                    <p>
                      {movesList(mergePreview).length > 0 ? (
                        <>
                          Moves {movesList(mergePreview).join(", ")} to{" "}
                          <strong>{mergeTarget?.full_name}</strong>.
                        </>
                      ) : (
                        <>
                          <strong>{merging.full_name}</strong> has nothing filed under it —
                          this only deletes it.
                        </>
                      )}
                    </p>
                    {mergePreview.budgetsFolded > 0 && (
                      <p className="tm-text-muted">
                        {mergePreview.budgetsFolded === 1
                          ? "One month is budgeted on both sides; the two amounts are added together."
                          : `${mergePreview.budgetsFolded} months are budgeted on both sides; each pair of amounts is added together.`}
                      </p>
                    )}
                  </>
                )
              )}

              <p className="tm-text-muted">
                Edit → Undo (Ctrl+Z) takes this back, including the budgets.
              </p>
              {dialogError && (
                <Notice tone="error" boxed>
                  {dialogError}
                </Notice>
              )}

              <div className="flex justify-end gap-2 pt-3">
                {/* The Merge button is not shown at all when the merge
                    is refused. A disabled button invites a press; its absence
                    says the same thing without the dead click. */}
                {!mergePreview?.blocked && (
                  <button
                    className="aero-btn default"
                    onClick={confirmMerge}
                    disabled={busy || !mergeInto}
                  >
                    {mergeTarget
                      ? `Merge ${merging.name} into ${mergeTarget.name}`
                      : "Merge"}
                  </button>
                )}
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
