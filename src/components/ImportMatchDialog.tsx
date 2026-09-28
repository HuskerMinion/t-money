// Import review (§89) — the step between reading a statement and writing it.
//
// Only the rows worth a decision are here: a row that is exactly what the
// register already holds is skipped without asking, and a row with nothing
// like it imports without asking. What is left is the near misses — the bank
// posting a day late, or writing SAFEWAY #1234 ANYTOWN US where the user wrote
// Safeway — which the old exact key could not recognize and which arrived as
// duplicates to clean up by hand.
//
// Match keeps the user's payee, category and memo and marks the row cleared.
// Import as new writes it anyway. Skip leaves it out altogether.
//
// §159 — and a second question, for a different set of rows: the new ones
// that would be written with no category, because the file gave none and no
// payee rule caught them. Each gets a picker, and a "remember" box that
// turns the pick into a rule so the next statement does not ask.
import { useEffect, useState } from "react";
import Money from "./Money";
import Notice from "./Notice";
import { api } from "../lib/ipc";
import { formatDateUS } from "../lib/format";
import CategorySelect from "./CategorySelect";
import type { Category, CsvMapping, ImportMatchPreview, ImportSummary, MemoRule, RowDecision } from "../lib/types";

interface Props {
  path: string;
  accountId: string;
  mapping: CsvMapping | null;
  /** §159 — for the category picker on rows that have none. */
  categories?: readonly Category[];
  /** §90: the memo answers, carried through to the import. */
  memoRules?: MemoRule[];
  preview: ImportMatchPreview;
  /** Re-read at a different date window; the parent owns the preview. */
  onWindowChange: (days: number) => void;
  onImported: (summary: ImportSummary) => void;
  onCancel: () => void;
}

type Choice = { action: "match" | "new" | "skip"; existingId?: string };

export default function ImportMatchDialog({
  path,
  accountId,
  mapping,
  categories = [],
  memoRules = [],
  preview,
  onWindowChange,
  onImported,
  onCancel,
}: Props) {
  const [choices, setChoices] = useState<Record<number, Choice>>({});
  // §159 — a category per uncategorized row, and whether to keep it as a
  // payee rule so the next statement does not ask again.
  const [picks, setPicks] = useState<Record<number, string>>({});
  const [remember, setRemember] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = path.split(/[\\/]/).pop() ?? path;

  // The confident pairings start ticked; everything else starts as "import
  // it", which is what would have happened without this dialog.
  useEffect(() => {
    const next: Record<number, Choice> = {};
    for (const row of preview.rows) {
      next[row.index] =
        row.likely && row.candidates[0]
          ? { action: "match", existingId: row.candidates[0].existing.id }
          : { action: "new" };
    }
    setChoices(next);
  }, [preview]);

  function choose(index: number, choice: Choice) {
    setChoices((c) => ({ ...c, [index]: choice }));
  }

  const matching = Object.values(choices).filter((c) => c.action === "match").length;
  const asNew = Object.values(choices).filter((c) => c.action === "new").length;
  const skipping = Object.values(choices).filter((c) => c.action === "skip").length;

  async function doImport() {
    setBusy(true);
    setError(null);
    try {
      const decisions: RowDecision[] = Object.entries(choices).map(([index, c]) => ({
        index: Number(index),
        action: c.action,
        existingId: c.action === "match" ? c.existingId ?? null : null,
      }));
      // §159 — the categories chosen for rows that had none. The decision
      // carries the category, so this row is filed whatever the rules say.
      //
      // §183 — the rules are made AFTER the import, one per payee text. They
      // were made first, a row at a time, and the backend refuses a second
      // rule for the same text ("there is already a rule for …"): two rows
      // from the same payee both set to remember aborted the whole import,
      // and a failed import left the first rule saved, so every retry was
      // refused before it reached the import at all.
      const rules = new Map<string, { payee: string; categoryId: string }>();
      for (const row of preview.uncategorized) {
        const categoryId = picks[row.index];
        if (!categoryId) continue;
        decisions.push({ index: row.index, action: "new", existingId: null, categoryId });
        // Same key as the backend's duplicate test: trimmed, any case. The
        // first row asked about wins when two disagree.
        const key = row.payee.trim().toLowerCase();
        if (remember[row.index] && key && !rules.has(key)) rules.set(key, { payee: row.payee, categoryId });
      }
      const summary = await api.importWithDecisions(path, accountId, mapping, decisions, memoRules);
      // The statement is in; a rule that will not save is not a reason to say
      // it is not. "Already a rule" means the next statement is caught
      // anyway. Anything else is said in the summary's notes, which the
      // Import card shows once this dialog has closed.
      const notes: string[] = [];
      for (const { payee, categoryId } of rules.values()) {
        try {
          await api.createPayeeRule(payee, payee, categoryId);
        } catch (e) {
          const msg = String(e);
          if (!/already a rule/i.test(msg)) notes.push(`Could not remember a rule for ${payee}: ${msg}`);
        }
      }
      onImported(notes.length > 0 ? { ...summary, notes: [...(summary.notes ?? []), ...notes] } : summary);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <>
      <div className="tm-dialog-backdrop" onClick={busy ? undefined : onCancel} />
      <div className="tm-dialog" role="dialog" aria-label="Review matches" style={{ minWidth: 820, maxWidth: "94vw" }}>
        <div className="tm-dialog-title">
          Review matches — {file} into {preview.account_name}
        </div>
        <div className="tm-dialog-body space-y-3 text-[12px]" style={{ maxHeight: "80vh", overflowY: "auto" }}>
          <div className="tm-text-muted">
            {preview.rows.length} of {preview.total_rows} {preview.total_rows === 1 ? "row" : "rows"} look like something already in this
            account. {preview.new_rows} {preview.new_rows === 1 ? "row is" : "rows are"} new and will be imported;{" "}
            {preview.duplicates} {preview.duplicates === 1 ? "is an exact duplicate and is" : "are exact duplicates and are"} skipped.
            {preview.uncategorized.length > 0 &&
              ` ${preview.uncategorized.length} of the new ${preview.uncategorized.length === 1 ? "row has" : "rows have"} no category yet.`}{" "}
            Nothing is written until you click Import.
          </div>

          {preview.uncategorized.length > 0 && (
            <section className="aero-card" aria-label="Rows with no category">
              <div className="aero-card-title">No category yet</div>
              <div className="p-2 space-y-1">
                <div className="tm-text-muted">
                  The file did not say, and no payee rule caught these. Choose a category now, or leave one blank
                  and it lands as Uncategorized. Check <em>remember</em> to make a rule for that payee, so the next
                  statement files it without asking.
                </div>
                <table className="register-table" aria-label="Rows with no category" style={{ tableLayout: "auto", width: "auto" }}>
                  <thead>
                    <tr>
                      <th>From the file</th>
                      <th className="num">Amount</th>
                      <th>Category</th>
                      <th>Remember</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.uncategorized.map((row) => (
                      <tr key={row.index}>
                        <td className="whitespace-nowrap">
                          {formatDateUS(row.date)} {row.payee}
                        </td>
                        <td className="num">
                          <Money cents={row.amount_cents} />
                        </td>
                        <td>
                          <CategorySelect
                            categories={categories}
                            value={picks[row.index] ?? ""}
                            onChange={(id) => setPicks((p) => ({ ...p, [row.index]: id }))}
                            label={`Category for ${row.payee}`}
                            noneLabel="Leave uncategorized"
                            disabled={busy}
                            style={{ minWidth: 220 }}
                          />
                        </td>
                        <td>
                          <label className="inline-flex items-center gap-1" title="Make a payee rule, so the next statement files this payee here without asking">
                            <input
                              type="checkbox"
                              aria-label={`Remember ${row.payee}`}
                              disabled={busy || !picks[row.index]}
                              checked={!!remember[row.index] && !!picks[row.index]}
                              onChange={(e) => setRemember((r) => ({ ...r, [row.index]: e.target.checked }))}
                            />
                            remember
                          </label>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {preview.rows.length > 0 && (
          <>
          <label className="inline-flex items-center gap-1">
            <span>Look for matches within</span>
            <select
              className="aero-field"
              aria-label="Date window"
              value={String(preview.window_days)}
              disabled={busy}
              onChange={(e) => onWindowChange(Number(e.target.value))}
            >
              <option value="1">1 day</option>
              <option value="3">3 days</option>
              <option value="7">a week</option>
              <option value="14">two weeks</option>
            </select>
          </label>

          <table className="register-table" aria-label="Rows to review">
            <thead>
              <tr>
                <th>From the file</th>
                <th className="num">Amount</th>
                <th>Already in {preview.account_name}</th>
                <th>What to do</th>
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row) => {
                const choice = choices[row.index] ?? { action: "new" as const };
                return (
                  <tr key={row.index}>
                    <td className="whitespace-nowrap">
                      {formatDateUS(row.date)} {row.payee}
                      {row.check_number ? ` — check ${row.check_number}` : ""}
                    </td>
                    <td className="num">
                      <Money cents={row.amount_cents} />
                    </td>
                    <td>
                      {row.candidates.map((c) => (
                        <label key={c.existing.id} className="flex items-start gap-1 py-0.5">
                          <input
                            type="radio"
                            name={`row-${row.index}`}
                            className="mt-0.5"
                            disabled={busy}
                            checked={choice.action === "match" && choice.existingId === c.existing.id}
                            onChange={() => choose(row.index, { action: "match", existingId: c.existing.id })}
                            aria-label={`Match ${row.payee} to ${c.existing.payee} on ${c.existing.date}`}
                          />
                          <span>
                            {formatDateUS(c.existing.date)} {c.existing.payee}
                            {c.existing.category_name ? ` · ${c.existing.category_name}` : ""}
                            {c.existing.is_transfer ? " · transfer" : ""}
                            <span className="tm-text-muted"> — {c.why}</span>
                          </span>
                        </label>
                      ))}
                    </td>
                    <td className="whitespace-nowrap">
                      <label className="inline-flex items-center gap-1 pr-2">
                        <input
                          type="radio"
                          name={`row-${row.index}`}
                          disabled={busy}
                          checked={choice.action === "new"}
                          onChange={() => choose(row.index, { action: "new" })}
                        />
                        Import as new
                      </label>
                      <label className="inline-flex items-center gap-1">
                        <input
                          type="radio"
                          name={`row-${row.index}`}
                          disabled={busy}
                          checked={choice.action === "skip"}
                          onChange={() => choose(row.index, { action: "skip" })}
                        />
                        Skip
                      </label>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="tm-text-muted">
            A match marks the transaction you already have as cleared and stores the bank&apos;s id on it, so a re-import recognizes it
            without asking. Your payee, category and memo are kept.
          </div>
          </>
          )}

          {error && (
            <Notice tone="error" boxed>
              {error}
            </Notice>
          )}

          <div className="flex items-center justify-between gap-2 pt-1">
            <div className="tabular-nums">
              {matching} matched · {asNew + preview.new_rows} imported · {skipping} skipped
            </div>
            <div className="flex gap-2">
              <button className="aero-btn default" type="button" disabled={busy} onClick={() => void doImport()}>
                {busy ? "Importing…" : "Import"}
              </button>
              <button className="aero-btn" type="button" onClick={onCancel} disabled={busy}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
