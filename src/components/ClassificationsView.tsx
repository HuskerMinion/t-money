// Classifications manager — the axis Money called a classification.
//
// A category says what KIND of money a line is; a classification says what it
// was FOR. "Repairs" is the category, "Maple Street house" is the classification
// value, and the two are independent — which is the whole point, because the
// alternative is Repairs:Maple, Utilities:Maple, Insurance:Maple and
// a category tree that doubles every time a house is bought.
//
// Money allowed exactly two axes, would not let you delete one once it was
// used, and honored them inconsistently across reports. None of those limits
// are repeated here: axes are rows, a delete says how many links it will take
// before it takes them, and every report reads the same effective value.
import { useEffect, useRef, useState } from "react";
import TmIcon from "./TmIcon";
import Notice from "./Notice";
import { api } from "../lib/ipc";
import { noteChanged } from "../lib/undo";
import { useCommand } from "../lib/useCommand";
import type { Classification, ClassificationValue } from "../lib/types";

/** Top-level values, each followed by its sub-values. */
export function valueTree(
  values: readonly ClassificationValue[]
): { parent: ClassificationValue; children: ClassificationValue[] }[] {
  return values
    .filter((v) => v.parent_id === null)
    .map((parent) => ({
      parent,
      children: values.filter((v) => v.parent_id === parent.id),
    }));
}

export default function ClassificationsView() {
  const [axes, setAxes] = useState<Classification[]>([]);
  const [selectedAxis, setSelectedAxis] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // New-axis and new-value forms.
  const [axisName, setAxisName] = useState("");
  const [valueName, setValueName] = useState("");
  const [valueParent, setValueParent] = useState("");
  const valueRef = useRef<HTMLInputElement>(null);

  // Renames, in place.
  const [renaming, setRenaming] = useState<{ kind: "axis" | "value"; id: string; name: string } | null>(null);
  // What a delete would take with it, confirmed before it happens.
  const [deleting, setDeleting] = useState<{ kind: "axis" | "value"; id: string; label: string; links: number } | null>(null);

  async function load(keep?: string | null) {
    try {
      const list = await api.listClassifications();
      setAxes(list);
      setSelectedAxis((cur) => {
        const want = keep !== undefined ? keep : cur;
        return want && list.some((a) => a.id === want) ? want : (list[0]?.id ?? null);
      });
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useCommand(
    "new.classification",
    () => {
      setAxisName("");
      setError(null);
      document.getElementById("new-axis-name")?.focus();
    },
    true,
    10
  );

  const axis = axes.find((a) => a.id === selectedAxis) ?? null;

  // "Under" names a parent by id, and the id has to be one of THIS
  // axis's top-level values. It was kept across a switch to another axis and
  // across deleting the parent itself, so the next Add sent a parent the
  // backend could only refuse — with the picker showing "(top level)", since
  // the option it named was gone.
  useEffect(() => {
    if (!valueParent) return;
    if (!axis || !axis.values.some((v) => v.id === valueParent && v.parent_id === null)) setValueParent("");
  }, [axis, valueParent]);

  async function run(what: () => Promise<unknown>, keep?: string | null) {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      await what();
      await load(keep);
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function addAxis(e: React.FormEvent) {
    e.preventDefault();
    if (!axisName.trim()) return;
    let created: Classification | null = null;
    const ok = await run(async () => {
      created = await api.createClassification(axisName.trim());
    });
    if (ok) {
      setAxisName("");
      if (created) setSelectedAxis((created as Classification).id);
    }
  }

  async function addValue(e: React.FormEvent) {
    e.preventDefault();
    if (!axis || !valueName.trim()) return;
    const ok = await run(
      () => api.createClassificationValue(axis.id, valueName.trim(), valueParent || null),
      axis.id
    );
    if (ok) {
      setValueName("");
      valueRef.current?.focus();
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    const d = deleting;
    const ok = await run(
      () => (d.kind === "axis" ? api.deleteClassification(d.id) : api.deleteClassificationValue(d.id)),
      d.kind === "axis" ? null : axis?.id ?? null
    );
    if (ok) {
      // The backend clears the undo stack on a delete; the Edit menu
      // has to hear it.
      noteChanged();
      setDeleting(null);
      setMsg(
        d.links === 0
          ? `Deleted "${d.label}".`
          : `Deleted "${d.label}" and untagged ${d.links} line${d.links === 1 ? "" : "s"}.`
      );
    }
  }

  async function commitRename() {
    if (!renaming) return;
    const r = renaming;
    const ok = await run(
      () => (r.kind === "axis" ? api.renameClassification(r.id, r.name) : api.renameClassificationValue(r.id, r.name)),
      axis?.id ?? null
    );
    if (ok) setRenaming(null);
  }

  function valueRow(v: ClassificationValue, isChild: boolean) {
    const editing = renaming?.kind === "value" && renaming.id === v.id;
    return (
      <tr key={v.id}>
        <td className="py-1 pl-1" style={{ paddingLeft: isChild ? 22 : 4 }}>
          {editing ? (
            <input
              className="aero-field"
              autoFocus
              value={renaming!.name}
              aria-label={`Rename ${v.full_name}`}
              onChange={(e) => setRenaming({ ...renaming!, name: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitRename();
                if (e.key === "Escape") setRenaming(null);
              }}
            />
          ) : (
            <span className={isChild ? "" : "font-bold"}>{v.name}</span>
          )}
        </td>
        <td className="py-1 text-right pr-2 tabular-nums">{v.usage_count}</td>
        <td className="py-1 text-right pr-1">
          {editing ? (
            <>
              <button type="button" className="aero-btn !py-0 !px-2" disabled={busy} onClick={() => void commitRename()}>
                Save
              </button>{" "}
              <button type="button" className="aero-btn !py-0 !px-2" onClick={() => setRenaming(null)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="aero-btn !py-0 !px-2"
                onClick={() => setRenaming({ kind: "value", id: v.id, name: v.name })}
              >
                Rename…
              </button>{" "}
              <button
                type="button"
                className="aero-btn !py-0 !px-2"
                onClick={() => setDeleting({ kind: "value", id: v.id, label: v.full_name, links: v.usage_count })}
              >
                Delete…
              </button>
            </>
          )}
        </td>
      </tr>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4">
      <section className="aero-card">
        <div className="aero-card-title">
          <TmIcon name="budgeting" /> Classifications
        </div>
        <div className="p-3 text-[11px] text-slate-600 space-y-2">
          <p>
            A category says what kind of spending something is. A classification says what it was{" "}
            <em>for</em> — which house, which vehicle, which person — so a report can answer “what
            did that house cost me last year” without a category for every combination.
          </p>
          {/* The thing that has to be said BEFORE the box, because
              the first go at this made four classifications named after two
              houses and two people, each with nothing in it, and the register
              then showed four empty fields. */}
          <p>
            <strong>A classification is the question; its values are the answers.</strong> Make one
            called <em>Property</em> and put each address in it as a value — not one classification
            per address. Two or three questions (Property, Person, Project) is the usual whole
            setup.
          </p>
        </div>
        <form className="px-3 pb-3 flex items-end gap-2 flex-wrap" onSubmit={addAxis}>
          <label className="text-[11px] text-slate-600">
            New classification — the question
            <input
              id="new-axis-name"
              className="aero-field mt-1"
              style={{ minWidth: 200 }}
              placeholder="Property, Person, Project…"
              value={axisName}
              onChange={(e) => setAxisName(e.target.value)}
              title="The kind of thing, not one of them: Property, not an address."
            />
          </label>
          <button type="submit" className="aero-btn default" disabled={busy || !axisName.trim()}>
            Add
          </button>
          {msg && <span className="text-slate-600">{msg}</span>}
        </form>
        {/* The shared refusal box; while the delete dialog is open the
            refusal is shown there instead, next to the button that failed. */}
        {error && !deleting && (
          <div className="px-3 pb-3">
            <Notice tone="error" boxed>
              {error}
            </Notice>
          </div>
        )}
      </section>

      {axes.length === 0 ? (
        <section className="aero-card">
          <div className="p-4 text-[12px] text-slate-600 text-center">
            No classifications yet. Add one above — “Property”, “Vehicle”, “Person” and “Project”
            are the usual ones — then give it values and tag transactions with them.
          </div>
        </section>
      ) : (
        <>
          <div className="aero-subnav flex gap-4">
            {axes.map((a) => (
              <button
                key={a.id}
                type="button"
                className={a.id === selectedAxis ? "selected" : ""}
                onClick={() => setSelectedAxis(a.id)}
              >
                {a.name}
              </button>
            ))}
          </div>

          {axis && (
            <section className="aero-card">
              <div className="aero-card-title flex items-center gap-2">
                <span className="flex-1">
                  {renaming?.kind === "axis" && renaming.id === axis.id ? (
                    <input
                      className="aero-field"
                      autoFocus
                      aria-label={`Rename ${axis.name}`}
                      value={renaming.name}
                      onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void commitRename();
                        if (e.key === "Escape") setRenaming(null);
                      }}
                    />
                  ) : (
                    `${axis.name} — ${axis.values.length} value${axis.values.length === 1 ? "" : "s"}, ${axis.usage_count} tagged line${axis.usage_count === 1 ? "" : "s"}`
                  )}
                </span>
                <button
                  type="button"
                  className="aero-btn !py-0 !px-2 text-[11px] font-normal"
                  onClick={() => setRenaming({ kind: "axis", id: axis.id, name: axis.name })}
                >
                  Rename…
                </button>
                <button
                  type="button"
                  className="aero-btn !py-0 !px-2 text-[11px] font-normal"
                  onClick={() => setDeleting({ kind: "axis", id: axis.id, label: axis.name, links: axis.usage_count })}
                >
                  Delete…
                </button>
              </div>

              <div className="p-2">
                {axis.values.length === 0 ? (
                  <div className="text-[12px] text-slate-500 p-3 text-center">
                    <div className="font-bold pb-1">“{axis.name}” has no values yet</div>
                    Until it does, its field in the register has nothing to choose and is grayed
                    out. Add the answers below — if “{axis.name}” is itself one of the answers,
                    delete it and make the question instead (Property, with the addresses in it).
                  </div>
                ) : (
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="text-left text-slate-500 border-b" style={{ borderColor: "var(--tm-ms-grid-line)" }}>
                        <th className="py-1 pl-1">Value</th>
                        <th className="py-1 text-right pr-2">Used</th>
                        <th className="py-1"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {valueTree(axis.values).flatMap(({ parent, children }) => [
                        valueRow(parent, false),
                        ...children.map((c) => valueRow(c, true)),
                      ])}
                    </tbody>
                  </table>
                )}
              </div>

              <form className="px-3 pb-3 flex items-end gap-2 flex-wrap" onSubmit={addValue}>
                <label className="text-[11px] text-slate-600">
                  New value of “{axis.name}” — an answer
                  <input
                    ref={valueRef}
                    className="aero-field mt-1"
                    style={{ minWidth: 240 }}
                    placeholder="e.g. an address, a vehicle, a person"
                    value={valueName}
                    onChange={(e) => setValueName(e.target.value)}
                  />
                </label>
                <label className="text-[11px] text-slate-600">
                  Under
                  <select
                    className="aero-field mt-1"
                    aria-label="Parent value"
                    value={valueParent}
                    onChange={(e) => setValueParent(e.target.value)}
                  >
                    <option value="">(top level)</option>
                    {axis.values
                      .filter((v) => v.parent_id === null)
                      .map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                  </select>
                </label>
                <button type="submit" className="aero-btn" disabled={busy || !valueName.trim()}>
                  Add value
                </button>
                <span className="text-[11px] text-slate-500">
                  Values go one level deep, as Money’s did.
                </span>
              </form>
            </section>
          )}
        </>
      )}

      {deleting && (
        <>
          <div className="tm-dialog-backdrop" onClick={() => setDeleting(null)} />
          <div className="tm-dialog" role="dialog" aria-label={`Delete ${deleting.label}`}>
            <div className="tm-dialog-title">Delete “{deleting.label}”?</div>
            <div className="tm-dialog-body text-[12px]">
              <p className="pb-2">
                {deleting.links === 0
                  ? "Nothing is tagged with it, so nothing else changes."
                  : `${deleting.links} line${deleting.links === 1 ? " is" : "s are"} tagged with it${
                      deleting.kind === "axis" ? " on this classification" : " (or one of its sub-values)"
                    }. They keep their category, their amount and everything else — they simply stop being tagged.`}
              </p>
              <p className="pb-3 text-slate-600">
                Undo does not cover this.
              </p>
              <div className="flex gap-2 justify-end">
                <button type="button" className="aero-btn default" disabled={busy} onClick={() => void confirmDelete()}>
                  Delete
                </button>
                <button type="button" className="aero-btn" onClick={() => setDeleting(null)}>
                  Cancel
                </button>
              </div>
              {error && (
                <Notice tone="error" boxed className="mt-2">
                  {error}
                </Notice>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
