// SplitDialog — "Transaction with Multiple Categories".
//
// Modeled on reference/ms-money-04-split-dialog.png. Two stages, as in Money:
//
//   1. On a transaction with no amount yet, a direction prompt: did you SPEND
//      money or RECEIVE it? Money needs the sign before it can itemize, and
//      the answer also decides which half of the category tree the pickers
//      offer. (Skipped when the parent already has an amount — its sign
//      answers the question.)
//   2. The itemize grid: Category | Description | Amount, with a live Total.
//
// Buttons follow Money: Delete / Delete All / Help on the right rail, then
// Done / Cancel.
//
// What a morning of real entry asked for:
//   - When the transaction already has an amount, the footer shows that
//     amount, the lines' total, and the DIFFERENCE, which reads 0.00 when the
//     lines account for all of it. That is the number you are working toward.
//   - Done with lines that total something else is allowed — the lines are
//     the amount — but it is CONFIRMED first, and the confirmation
//     says when the transaction has already been reconciled, because moving a
//     reconciled amount puts the next statement out by the difference.
//   - Enter is Done and Escape is Cancel, as they are on the transaction form
//     behind this dialog. A field with its list open still takes Enter for
//     its own choice, as the Category field always has.
//   - The Description completes from descriptions used on earlier split
//     lines, the way the Payee field completes a payee.
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/ipc";
import { formatAmountBare, formatMoney, parseMoneyToCents } from "../lib/format";
import type { Account, Category, ClassPick, Classification, NewSplit, Payee, UsedText } from "../lib/types";
import CategorySelect, { transferTargetOf, transferValue } from "./CategorySelect";
import ClassPicker, { picksToSend, valueOn } from "./ClassPicker";
import PayeeField from "./PayeeField";
import Notice from "./Notice";

export type SplitDirection = "spent" | "received";

interface SplitLine {
  categoryId: string;
  description: string;
  amount: string;
  /** This line's own classification values. Empty on an axis means the
   *  line follows the transaction's value for it. */
  classes: ClassPick[];
}

interface Props {
  categories: readonly Category[];
  /** Accounts a line may transfer to. A split line has been able to
   *  carry a transfer for some time — the column, the Rust and the ledger all
   *  handle it — but nothing could ever create one, because this dialog's
   *  picker offered categories only. Money puts transfers in the same field,
   *  so a paycheck can be split into salary, tax and "the part that went to
   *  savings" in one transaction. Omit and no line can be a transfer. */
  transferTargets?: readonly Account[];
  /** The parent's signed amount, if it already has one. */
  parentAmountCents?: number | null;
  /** The transaction has been reconciled against a statement, so a
   *  Done that moves its amount says what that costs. */
  reconciled?: boolean;
  /** Existing lines when re-opening a split transaction. */
  initialSplits?: readonly NewSplit[];
  /** The file's classification axes. Empty hides the columns. */
  classifications?: readonly Classification[];
  /** What the transaction itself is tagged with — shown as the fallback in
   *  each line's picker, since a line with no value of its own inherits it. */
  parentClasses?: readonly ClassPick[];
  onDone: (splits: NewSplit[], totalCents: number) => void;
  onCancel: () => void;
}

const BLANK: SplitLine = { categoryId: "", description: "", amount: "", classes: [] };
const VISIBLE_ROWS = 12;

function toLines(splits: readonly NewSplit[]): SplitLine[] {
  return splits.map((s) => ({
    // A transfer line comes back as the account it points at, in the same
    // field, so re-opening a split shows what it actually is.
    categoryId: s.transfer_account_id ? transferValue(s.transfer_account_id) : (s.category_id ?? ""),
    description: s.description ?? "",
    amount: formatAmountBare(s.amount_cents),
    classes: (s.classes ?? []).filter((c) => c.value_id).map((c) => ({ ...c })),
  }));
}

/** The Payee field's completion, fed descriptions instead of payees.
 *  It only reads `name` and `usage_count`; the rest is the shape it asks for. */
export function asPayees(texts: readonly UsedText[]): Payee[] {
  return texts.map((t) => ({
    id: t.name,
    name: t.name,
    usage_count: t.usage_count,
    last_category_id: null,
    last_category_name: null,
    updated_at: "",
    last_amount_cents: null,
  }));
}

export default function SplitDialog({
  categories,
  transferTargets = [],
  parentAmountCents = null,
  reconciled = false,
  initialSplits = [],
  classifications = [],
  parentClasses = [],
  onDone,
  onCancel,
}: Props) {
  // The parent's own sign answers the direction question when it has one.
  const knownDirection: SplitDirection | null =
    parentAmountCents === null || parentAmountCents === 0
      ? null
      : parentAmountCents < 0
        ? "spent"
        : "received";

  const [direction, setDirection] = useState<SplitDirection | null>(knownDirection);
  const [lines, setLines] = useState<SplitLine[]>(
    initialSplits.length ? toLines(initialSplits) : [BLANK]
  );
  const [selected, setSelected] = useState(0);
  // Done with a total that is not the transaction's amount waits for
  // a yes. Holds the lines it would write, so the answer needs no re-read.
  const [confirming, setConfirming] = useState<{ splits: NewSplit[]; total: number } | null>(null);
  // The lines whose amount Done could not read, by index. Such a
  // line used to count as empty and drop out of the split without a word.
  const [unreadable, setUnreadable] = useState<number[]>([]);
  const [descriptions, setDescriptions] = useState<Payee[]>([]);
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let canceled = false;
    api
      .listSplitDescriptions()
      .then((d) => {
        if (!canceled) setDescriptions(asPayees(d));
      })
      .catch(() => {
        // Completion is an offer; a file that cannot supply it loses nothing.
      });
    return () => {
      canceled = true;
    };
  }, []);

  // The grid opens with the caret in the first Category, as Money's does —
  // on a NEW split. Re-opening one lands in the first Amount instead: focus
  // opens the Category field's list and shows the query in place of the
  // name, which on a split that already has lines reads as the first line
  // having lost its category.
  useEffect(() => {
    if (direction === null) return;
    const grid = gridRef.current;
    if (!grid) return;
    const first = initialSplits.length
      ? grid.querySelector<HTMLInputElement>('input[aria-label="Amount 1"]')
      : grid.querySelector<HTMLInputElement>("input");
    first?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [direction]);

  const sign = direction === "received" ? 1 : -1;
  const totalCents = lines.reduce((sum, l) => {
    const c = parseMoneyToCents(l.amount);
    return c === null ? sum : sum + Math.abs(c) * sign;
  }, 0);
  // The amount the lines are working toward, when there is one.
  const target = parentAmountCents !== null && parentAmountCents !== 0 ? parentAmountCents : null;
  const difference = target === null ? null : target - totalCents;

  // Stage 1 — the direction prompt.
  if (direction === null) {
    return (
      <div
        className="tm-dialog"
        role="dialog"
        aria-label="Split transaction"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      >
        <div className="tm-dialog-title">Split Transaction</div>
        <div className="tm-dialog-body">
          <p className="font-bold pb-2">Did you spend or receive this money?</p>
          <div className="flex gap-2">
            <button className="aero-btn default" type="button" autoFocus onClick={() => setDirection("spent")}>
              I spent money
            </button>
            <button className="aero-btn" type="button" onClick={() => setDirection("received")}>
              I received money
            </button>
            <button className="aero-btn" type="button" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  function update(i: number, patch: Partial<SplitLine>) {
    setLines((ls) => ls.map((l, n) => (n === i ? { ...l, ...patch } : l)));
    edited();
    if (patch.amount !== undefined) setUnreadable((u) => u.filter((n) => n !== i));
  }

  /** Any change to the lines withdraws a pending confirmation. It
   *  holds the lines as they were at the first Done, and Enter or its button
   *  wrote exactly those — a fix typed below the banner was lost. The next
   *  Done reads the grid again, and asks again if it still does not add up. */
  function edited() {
    setConfirming(null);
  }

  /** Typing in the last row grows the grid, as Money's does. */
  function ensureTrailingBlank(i: number) {
    if (i === lines.length - 1) setLines((ls) => [...ls, { ...BLANK }]);
  }

  /** The lines as they would be written: untouched rows dropped. */
  function collect(): NewSplit[] {
    const out: NewSplit[] = [];
    for (const l of lines) {
      const c = parseMoneyToCents(l.amount);
      if (c === null || c === 0) continue; // skip untouched rows (done() has refused unreadable ones)
      out.push({
        // One field, two kinds of destination — exactly as the register's
        // own category field works.
        category_id: transferTargetOf(l.categoryId) || l.categoryId === "" ? null : l.categoryId,
        transfer_account_id: transferTargetOf(l.categoryId),
        description: l.description.trim() === "" ? null : l.description.trim(),
        amount_cents: Math.abs(c) * sign,
        // Every axis goes, so clearing one on a line clears it; an empty
        // value means the line follows the transaction's.
        classes: classifications.length > 0 ? picksToSend(classifications, l.classes) : undefined,
      });
    }
    return out;
  }

  function done() {
    // An amount that is there but is not money ("12.345", "1O.00")
    // is not an empty line. Refuse, and say which.
    const bad = lines.flatMap((l, n) => (l.amount.trim() !== "" && parseMoneyToCents(l.amount) === null ? [n] : []));
    setUnreadable(bad);
    if (bad.length > 0) {
      setConfirming(null);
      return;
    }
    const out = collect();
    const total = out.reduce((s, x) => s + x.amount_cents, 0);
    // The lines ARE the amount, but moving an amount that was typed
    // (or, worse, reconciled) is asked about first. Clearing every line is
    // not a change of amount: the form keeps what it had.
    if (target !== null && out.length > 0 && total !== target) {
      setConfirming({ splits: out, total });
      return;
    }
    onDone(out, total);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const el = e.target as HTMLElement;
    if (e.key === "Escape") {
      e.preventDefault();
      if (confirming) setConfirming(null);
      else onCancel();
      return;
    }
    if (e.key !== "Enter") return;
    // A button takes its own Enter (Cancel must not become Done), and a
    // field with its list open has already stopped the event.
    if (el.tagName === "BUTTON") return;
    e.preventDefault();
    if (confirming) onDone(confirming.splits, confirming.total);
    else done();
  }

  return (
    <div className="tm-dialog" role="dialog" aria-label="Transaction with Multiple Categories" onKeyDown={onKeyDown}>
      <div className="tm-dialog-title">Transaction with Multiple Categories</div>
      <div className="tm-dialog-body">
        <p className="font-bold pb-2">
          Itemize the amount spent in each category below. The amounts should add up to
          the total transaction amount.
        </p>
        {classifications.length > 0 && (
          <p className="text-[11px] tm-text-muted pb-2">
            A classification in brackets is the transaction’s, and the line follows it — change the
            transaction and the line changes with it. Choose one here to pin that line to it
            instead, which is what you want when the lines are for different things.
          </p>
        )}
        <div className="flex gap-2">
          <div ref={gridRef} className="flex-1 overflow-auto" style={{ maxHeight: 320 }}>
            <table className="register-table">
              <thead>
                <tr>
                  <th>Category</th>
                  {classifications.map((c) => (
                    <th key={c.id}>{c.name}</th>
                  ))}
                  <th>Description</th>
                  <th className="num" style={{ width: 120 }}>
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr
                    key={i}
                    className={i === selected ? "active" : undefined}
                    onFocus={() => setSelected(i)}
                  >
                    <td>
                      <CategorySelect
                        className="aero-field w-full"
                        label={`Category ${i + 1}`}
                        categories={categories}
                        // The spent/received answer IS the income/expense
                        // filter — a "spent" line never offers an
                        // income category.
                        kind={direction === "received" ? "income" : "expense"}
                        transferTargets={transferTargets}
                        value={l.categoryId}
                        onChange={(id) => {
                          update(i, { categoryId: id });
                          ensureTrailingBlank(i);
                        }}
                      />
                    </td>
                    {classifications.map((c) => {
                      // A line with nothing of its own follows the
                      // transaction — say so in the empty option rather than
                      // showing a bare "(none)" that would read as "not
                      // classified".
                      const inherited = parentClasses.find((p) => p.classification_id === c.id && p.value_id);
                      const inheritedLabel = inherited
                        ? c.values.find((v) => v.id === inherited.value_id)?.full_name ?? "the transaction's"
                        : null;
                      return (
                        <td key={c.id}>
                          <select
                            className="aero-field w-full"
                            aria-label={`${c.name} ${i + 1}`}
                            // Same as the entry form: an axis with
                            // no values cannot be used, and says why.
                            disabled={c.values.length === 0}
                            title={c.values.length === 0 ? `“${c.name}” has no values yet — add them under Budget → Classifications.` : undefined}
                            value={valueOn(l.classes, c.id)}
                            onChange={(e) => {
                              const next = l.classes.filter((x) => x.classification_id !== c.id);
                              if (e.target.value) next.push({ classification_id: c.id, value_id: e.target.value });
                              update(i, { classes: next });
                              ensureTrailingBlank(i);
                            }}
                          >
                            {/* The brackets are the whole
                                distinction between a line that FOLLOWS the
                                transaction and one that carries a value of
                                its own, and "(418 Maple Street)" beside
                                "418 Maple Street" did not say which was
                                which. Now it says it in words. */}
                            <option value="">
                              {c.values.length === 0
                                ? "(no values yet)"
                                : inheritedLabel
                                  ? `(same as the transaction — ${inheritedLabel})`
                                  : "(none — and the transaction has none either)"}
                            </option>
                            {c.values.map((v) => (
                              <option key={v.id} value={v.id}>
                                {v.full_name}
                              </option>
                            ))}
                          </select>
                        </td>
                      );
                    })}
                    <td>
                      {/* Completes from earlier split descriptions;
                          typing something new is still fine. */}
                      <PayeeField
                        className="aero-field w-full"
                        label={`Description ${i + 1}`}
                        placeholder=""
                        title="Type, then Tab or Enter takes the highlighted description"
                        payees={descriptions}
                        value={l.description}
                        onChange={(v) => {
                          update(i, { description: v });
                          ensureTrailingBlank(i);
                        }}
                      />
                    </td>
                    <td>
                      <input
                        className="aero-field w-full text-right"
                        aria-label={`Amount ${i + 1}`}
                        aria-invalid={unreadable.includes(i) || undefined}
                        style={unreadable.includes(i) ? { borderColor: "var(--tm-negative)", color: "var(--tm-negative)" } : undefined}
                        value={l.amount}
                        onChange={(e) => {
                          update(i, { amount: e.target.value });
                          ensureTrailingBlank(i);
                        }}
                      />
                    </td>
                  </tr>
                ))}
                {Array.from(
                  { length: Math.max(0, VISIBLE_ROWS - lines.length) },
                  (_, i) => (
                    <tr key={`f${i}`} className="filler" aria-hidden="true">
                      <td />
                      {classifications.map((c) => (
                        <td key={c.id} />
                      ))}
                      <td />
                      <td />
                    </tr>
                  )
                )}
              </tbody>
            </table>
          </div>

          <div className="flex flex-col gap-1" style={{ width: 110 }}>
            <button
              className="aero-btn"
              type="button"
              onClick={() => {
                setLines((ls) => (ls.length === 1 ? [{ ...BLANK }] : ls.filter((_, n) => n !== selected)));
                edited();
                setUnreadable([]);
              }}
            >
              Delete
            </button>
            <button
              className="aero-btn"
              type="button"
              onClick={() => {
                setLines([{ ...BLANK }]);
                edited();
                setUnreadable([]);
              }}
            >
              Delete All
            </button>
            <button className="aero-btn" type="button" disabled>
              Help
            </button>
            <span className="flex-1" />
            <button className="aero-btn default" type="button" onClick={done} title="Enter">
              Done
            </button>
            <button className="aero-btn" type="button" onClick={onCancel} title="Esc">
              Cancel
            </button>
          </div>
        </div>

        {/* The amount the lines are working toward, and how far off
            they are. "Difference" is the number you watch; 0.00 means done. */}
        <div className="pt-1" style={{ paddingRight: 118 }}>
          {target !== null && (
            <div className="flex justify-end gap-3">
              <span>Transaction amount:</span>
              <span className="tabular-nums" aria-label="Transaction amount">{formatMoney(target)}</span>
            </div>
          )}
          <div className="flex justify-end gap-3">
            <span className="font-bold">Total:</span>
            <span className="font-bold tabular-nums" aria-label="Split total">{formatMoney(totalCents)}</span>
          </div>
          {difference !== null && (
            <div className="flex justify-end gap-3">
              <span className={difference === 0 ? undefined : "money-neg"}>Difference:</span>
              <span className={`tabular-nums${difference === 0 ? "" : " money-neg"}`} aria-label="Difference">
                {formatMoney(difference)}
              </span>
            </div>
          )}
        </div>

        {unreadable.length > 0 && (
          <Notice tone="error" boxed className="mt-2">
            {unreadable.length === 1
              ? `The amount on line ${unreadable[0] + 1}, “${lines[unreadable[0]]?.amount.trim()}”, is not an amount. `
              : `The amounts on lines ${unreadable.map((n) => n + 1).join(", ")} are not amounts. `}
            Type dollars and cents, such as 12.34, or clear the line.
          </Notice>
        )}

        {confirming && (
          <div className="tm-merge-blocked mt-2" role="alert" style={{ lineHeight: 1.5 }}>
            <div className="tm-merge-blocked-head">The lines do not add up to the amount entered</div>
            <p>
              The lines total {formatMoney(confirming.total)}, but the transaction amount is{" "}
              {formatMoney(target ?? 0)}. Done will change the transaction amount to{" "}
              {formatMoney(confirming.total)}.
            </p>
            {reconciled && (
              <p className="font-bold">
                This transaction has already been reconciled against a statement. Changing its amount
                will put the next reconcile out by {formatMoney(Math.abs((target ?? 0) - confirming.total))}.
              </p>
            )}
            <div className="flex gap-2 pt-1">
              <button
                className="aero-btn default"
                type="button"
                autoFocus
                onClick={() => onDone(confirming.splits, confirming.total)}
              >
                Change the amount to {formatMoney(confirming.total)}
              </button>
              <button className="aero-btn" type="button" onClick={() => setConfirming(null)}>
                Go back
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
