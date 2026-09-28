// "That category doesn't exist yet" — the small wizard the entry form opens
// when you type a category that isn't there.
//
// Asked for directly: a way to add "a new top level with subcategory if it's
// new, or just a subcategory to an existing top level category", without
// leaving the transaction you are in the middle of entering.
//
// Names are unique PER PARENT (migration 0015), so "Repairs & Maintenance"
// under both Automobile and House is legitimate and this dialog does not
// second-guess it — the backend is the only judge, and its refusal is shown
// verbatim.
import { useState } from "react";
import type { Category, CategoryKind } from "../lib/types";

export interface NewCategoryDraft {
  name: string;
  kind: CategoryKind;
  parentId: string | null;
  /** When set, a subcategory of the newly created top-level category. */
  childName: string | null;
}

interface Props {
  /** What the user typed into the category field. */
  initialName: string;
  categories: readonly Category[];
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onCreate: (draft: NewCategoryDraft) => void | Promise<void>;
}

export default function NewCategoryDialog({
  initialName,
  categories,
  busy = false,
  error = null,
  onCancel,
  onCreate,
}: Props) {
  // If they typed "Home : Repairs", treat it as parent : child — it is the
  // notation the app shows everywhere, so it is the notation they will type.
  // When the parent half already exists, they are plainly adding a
  // subcategory to it: open in that mode with the parent chosen and only the
  // child half as the name. (Typing "Other Income : Garage Sale" used to put
  // "Other Income" in the subcategory box and ask for a parent.)
  const colon = initialName.indexOf(":");
  const [rawParent, rawChild] =
    colon >= 0
      ? [initialName.slice(0, colon).trim(), initialName.slice(colon + 1).trim()]
      : [initialName.trim(), ""];
  const topLevel = categories.filter((c) => c.parent_id === null);
  const typedParent =
    rawChild !== ""
      ? topLevel.find((c) => c.name.toLowerCase() === rawParent.toLowerCase()) ?? null
      : null;

  const [placement, setPlacement] = useState<"top" | "child">(typedParent ? "child" : "top");
  const [name, setName] = useState(typedParent ? rawChild : rawParent);
  const [childName, setChildName] = useState(typedParent ? "" : rawChild);
  const [parentId, setParentId] = useState(typedParent?.id ?? "");
  const [kind, setKind] = useState<CategoryKind>("expense");

  // Switching placement by hand keeps what was typed meaningful: to "child"
  // the subcategory half (if any) becomes the name and the parent half picks
  // the parent when it exists; back to "top" restores both halves.
  function place(p: "top" | "child") {
    if (p === placement) return;
    setPlacement(p);
    if (p === "child") {
      if (childName.trim()) {
        const parent = topLevel.find((c) => c.name.toLowerCase() === name.trim().toLowerCase());
        setParentId(parent?.id ?? "");
        setName(childName.trim());
        setChildName("");
      }
    } else if (parentId) {
      const parent = topLevel.find((c) => c.id === parentId);
      if (parent) {
        setChildName(name.trim());
        setName(parent.name);
      }
    }
  }

  const chosenParent = topLevel.find((c) => c.id === parentId) ?? null;
  const effectiveKind = chosenParent ? chosenParent.kind : kind;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    if (placement === "child" && !parentId) return;
    void onCreate({
      name: name.trim(),
      kind: effectiveKind,
      parentId: placement === "child" ? parentId : null,
      childName:
        placement === "top" && childName.trim() ? childName.trim() : null,
    });
  }

  return (
    <>
      <div className="tm-dialog-backdrop" onClick={onCancel} />
      <div className="tm-dialog" role="dialog" aria-label="New category">
        <div className="tm-dialog-title">New category</div>
        <form onSubmit={submit} className="tm-dialog-body space-y-3 text-[12px]">
          <fieldset className="space-y-1">
            <legend className="sr-only">Where does it go?</legend>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="placement"
                checked={placement === "top"}
                onChange={() => place("top")}
              />
              New top-level category
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="placement"
                checked={placement === "child"}
                onChange={() => place("child")}
              />
              Subcategory of an existing category
            </label>
          </fieldset>

          {placement === "child" && (
            <label className="block">
              Parent
              <select
                className="aero-field mt-1 w-full"
                aria-label="Parent category"
                value={parentId}
                onChange={(e) => setParentId(e.target.value)}
              >
                <option value="">(choose a category)</option>
                {topLevel.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.kind})
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="block">
            {placement === "child" ? "Subcategory name" : "Category name"}
            <input
              className="aero-field mt-1 w-full"
              aria-label="New category name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          {placement === "top" && (
            <>
              <label className="block">
                Type
                <select
                  className="aero-field mt-1 w-full"
                  aria-label="New category type"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as CategoryKind)}
                >
                  <option value="expense">Expense</option>
                  <option value="income">Income</option>
                </select>
              </label>
              <label className="block">
                Subcategory (optional)
                <input
                  className="aero-field mt-1 w-full"
                  aria-label="Subcategory name"
                  value={childName}
                  onChange={(e) => setChildName(e.target.value)}
                  placeholder="e.g. Repairs &amp; Maintenance"
                />
                <span className="block pt-1 text-slate-500">
                  Leave blank for a top-level category on its own. A subcategory
                  is selected for the transaction if you add one.
                </span>
              </label>
            </>
          )}

          {placement === "child" && chosenParent && (
            <div className="text-slate-500">
              Will be created as{" "}
              <strong>
                {chosenParent.name} : {name.trim() || "…"}
              </strong>{" "}
              ({chosenParent.kind}).
            </div>
          )}

          {error && <div className="money-neg">{error}</div>}

          <div className="flex justify-end gap-2 pt-1">
            <button
              className="aero-btn default"
              disabled={busy || !name.trim() || (placement === "child" && !parentId)}
            >
              Create
            </button>
            <button type="button" className="aero-btn" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
