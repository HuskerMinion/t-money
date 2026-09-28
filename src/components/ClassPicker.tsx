// ClassPicker (§112) — one dropdown per classification, side by side.
//
// It appears in two places, and the second one is the one that matters: the
// transaction form AND the split dialog. An axis that only reaches whole
// transactions leaks the moment somebody splits a Home Depot receipt across
// two houses, which is exactly the case the axis exists for — so this
// component is written once and used in both.
//
// Empty means "no value on this axis"; on a split line it means "whatever the
// transaction says", which is why the split dialog labels it differently.
import type { ClassPick, Classification } from "../lib/types";

interface Props {
  classifications: readonly Classification[];
  /** Current picks, one per axis at most. Axes not named here are unset. */
  value: readonly ClassPick[];
  onChange: (next: ClassPick[]) => void;
  /** What an empty choice means here. */
  emptyLabel?: string;
  /** Prefix for the field ids, so two pickers on screen stay distinct. */
  idPrefix?: string;
  disabled?: boolean;
  compact?: boolean;
}

/** The picked value on one axis, or "" for none. */
export function valueOn(picks: readonly ClassPick[], classificationId: string): string {
  return picks.find((p) => p.classification_id === classificationId)?.value_id ?? "";
}

/** Set one axis, dropping it entirely when cleared. Never touches the others. */
export function withValue(picks: readonly ClassPick[], classificationId: string, valueId: string): ClassPick[] {
  const rest = picks.filter((p) => p.classification_id !== classificationId);
  return valueId ? [...rest, { classification_id: classificationId, value_id: valueId }] : rest;
}

/** The picks a save must send: every axis, so a cleared one is cleared rather
 *  than left as it was. An axis with no value goes as an empty `value_id`. */
export function picksToSend(classifications: readonly Classification[], picks: readonly ClassPick[]): ClassPick[] {
  return classifications.map((c) => ({
    classification_id: c.id,
    value_id: valueOn(picks, c.id),
  }));
}

/** Whether two pick sets mean the same thing, ignoring order and labels. */
export function samePicks(a: readonly ClassPick[], b: readonly ClassPick[]): boolean {
  const norm = (xs: readonly ClassPick[]) =>
    xs
      .filter((x) => x.value_id)
      .map((x) => `${x.classification_id}:${x.value_id}`)
      .sort()
      .join("|");
  return norm(a) === norm(b);
}

export default function ClassPicker({
  classifications,
  value,
  onChange,
  emptyLabel = "(none)",
  idPrefix = "class",
  disabled = false,
  compact = false,
}: Props) {
  if (classifications.length === 0) return null;
  return (
    <>
      {classifications.map((c) => (
        <span key={c.id} className="inline-flex items-center gap-1">
          {!compact && (
            <label htmlFor={`${idPrefix}-${c.id}`} className="text-right">
              {c.name}:
            </label>
          )}
          {/* §117.1 — a classification with no values is a question with no
              answers, and it used to draw a field offering "(none)" and
              nothing else. One classification per value, rather than one
              classification with the values in it, gave the register dead
              dropdowns with no hint of what was wrong. It now says what to
              do, and cannot be fiddled with. */}
          <select
            id={`${idPrefix}-${c.id}`}
            className="aero-field"
            aria-label={c.name}
            title={
              c.values.length === 0
                ? `“${c.name}” has no values yet. Add them under Budget → Classifications — the classification is the question (Property), its values are the answers (each address).`
                : `${c.name} — what this was for`
            }
            disabled={disabled || c.values.length === 0}
            value={valueOn(value, c.id)}
            onChange={(e) => onChange(withValue(value, c.id, e.target.value))}
          >
            {c.values.length === 0 ? (
              <option value="">(no values yet — add them under Budget → Classifications)</option>
            ) : (
              <>
                <option value="">{emptyLabel}</option>
                {c.values.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.full_name}
                  </option>
                ))}
              </>
            )}
          </select>
        </span>
      ))}
    </>
  );
}
