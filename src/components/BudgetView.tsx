// The Budget screen, rebuilt.
//
// > *"the Budget tab needs re-worked to make it easier to navigate/change/
// > update as is its just overwhelming to try and figure out how to manage it.
// > scrolling all the way to the bottom, selecting a category and changing it
// > is very non-intuitive"*
//
// The user was describing three separate mistakes that compounded:
//
//  1. **The amount was not where the number was.** The table showed budgets;
//     a form BELOW it set them. Changing one figure meant scrolling past
//     everything, finding the category again in a dropdown, and typing into a
//     form with no visible connection to the row you were looking at. Now the
//     amount is an input IN the row. You click the number and type.
//
//  2. **You could only see what was already budgeted.** A category with no
//     budget and no spending this month had no row, so the only way to add
//     one was the dropdown. Every expense category is a row now.
//
//  3. **The rows moved.** They were ordered by amount spent, so typing an
//     amount re-sorted the table under the cursor. The order is the category
//     tree, and it does not change.
//
// And the thing that makes it not overwhelming: **it opens showing the
// top-level categories only.** Those are the dozen-ish things a household
// actually decides about, the children roll into them (see `budget_grid` for
// the envelope rule, and `raise_parent_to_cover_children` for the floor a
// parent is held to), and a parent expands when you want the detail.
//
// A parent with budgeted children now always HAS an envelope: the
// first child amount creates one at the next whole ten above the children if
// the parent had none. "Mainly budget off of parent categories but be able to
// see the child categories as well" does not survive a parent whose box is
// empty while the totals are made of its children.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Money from "./Money";
import Notice from "./Notice";
import AutobudgetDialog, { monthLabel } from "./AutobudgetDialog";
import FindOnPage from "./FindOnPage";
import { isFinding, matchGroups } from "../lib/findOnPage";
import { api } from "../lib/ipc";
import { currentMonth, formatAmountBare, parseMoneyToCents } from "../lib/format";
import { useBudgetStore } from "../stores/useBudgetStore";
import type { BudgetGrid, BudgetLine, RaisedParent } from "../lib/types";

/** What to say about a parent this write moved.
 *
 *  Two different events, two different sentences. A parent that went UP had a
 *  number and now has a bigger one. A parent that was CREATED had none at
 *  all, and a figure appearing in a box nobody typed in has to say why — it
 *  is the one thing this screen refused to do, and doing it quietly would be worse
 *  than not doing it. */
/** Where this figure came from, since it can no longer be typed here.
 *
 * The year plan is the editor; this table is materialized from it. A
 * line with no plan behind it is one of the hand-set budgets that predate the
 * year plan, which still work and are still read — they are just no longer
 * the place to make a change. */
export function budgetSource(line: BudgetLine): string {
  if (!line.has_budget) return "No budget for this category this month.";
  const amount = formatAmountBare(line.target_cents);
  return `${amount} — set on the Year plan. Change it there.`;
}

export function raiseNotice(raised: RaisedParent | null): string | null {
  if (!raised) return null;
  const amount = formatAmountBare(raised.target_cents);
  return raised.created
    ? `${raised.category_name} had no budget, so it was set to ${amount} to cover its subcategories.`
    : `${raised.category_name} raised to ${amount} to cover its subcategories.`;
}

/** "2026-09" → "2026-10" / "2026-08". */
export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + by, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** A parent and the children under it, in the order the backend sent. */
export interface BudgetGroup {
  parent: BudgetLine;
  children: BudgetLine[];
}

/** Group the flat rows into the two-level tree. A child whose parent is
 *  missing (it should not happen, but a hand-edited file could) becomes its
 *  own group rather than vanishing from a screen that claims to show every
 *  category. */
export function groupLines(lines: readonly BudgetLine[]): BudgetGroup[] {
  const groups = new Map<string, BudgetGroup>();
  for (const l of lines) {
    if (l.parent_id === null) groups.set(l.category_id, { parent: l, children: [] });
  }
  for (const l of lines) {
    if (l.parent_id === null) continue;
    const g = groups.get(l.parent_id);
    if (g) g.children.push(l);
    else groups.set(l.category_id, { parent: l, children: [] });
  }
  return [...groups.values()];
}

/** Is this group worth showing when the screen is not showing everything?
 *  Budgeted or spent — anything you have an opinion about or have touched. */
export function groupIsInteresting(g: BudgetGroup): boolean {
  const rows = [g.parent, ...g.children];
  return rows.some((r) => r.has_budget || r.spent_cents > 0);
}

export default function BudgetView() {
  const [month, setMonth] = useState(currentMonth());
  const [grid, setGrid] = useState<BudgetGrid | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  // Ctrl+F here finds a budget line, not a transaction.
  const [find, setFind] = useState("");
  const finding = isFinding(find);
  const [dialog, setDialog] = useState<null | "history" | "starter">(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** The row being typed in, so a half-typed "12" is not saved as $12 on
   *  every keystroke. Committed on blur or Enter. */
  /** The row you are working on, highlighted so there is no doubt
   *  which line a number is about to land on. Clicking anywhere in the row
   *  selects it; typing in its amount selects it too. */
  const [selected, setSelected] = useState<string | null>(null);

  /** The categories whose rows for this month the Year plan wrote.
   *  `materialize` deletes and rewrites every row of a planned category for
   *  the whole year, so Clear on one of those looked like it worked and was
   *  undone by the next plan edit. Those lines say where to clear instead. */
  const [planned, setPlanned] = useState<Set<string>>(new Set());
  /** Which load's answer still counts. ‹ › pressed quickly sent two
   *  requests, and a slow September arriving after October put September's
   *  figures under October's heading. */
  const latest = useRef(0);

  const load = useCallback(async (m: string) => {
    const mine = ++latest.current;
    try {
      const next = await api.getBudgetGrid(m);
      // Not fatal: without the plan the screen still reads, and Clear is
      // offered on every budgeted line as it was before.
      const plan = await api.getYearPlan(Number(m.slice(0, 4))).catch(() => null);
      if (mine !== latest.current) return;
      setGrid(next);
      setPlanned(new Set((plan?.expenses ?? []).filter((p) => p.has_plan).map((p) => p.category_id)));
      setError(null);
    } catch (e) {
      if (mine !== latest.current) return;
      setGrid(null);
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void load(month);
  }, [load, month]);

  const groups = useMemo(() => groupLines(grid?.lines ?? []), [grid]);
  const shown = finding ? matchGroups(groups, find) : showAll ? groups : groups.filter(groupIsInteresting);
  const nothingBudgeted = (grid?.budgeted_lines ?? 0) === 0;

  /** Write one row's amount. Everything reloads afterwards, including the
   *  store the Home screen reads, because a budget change moves the
   *  parent's remaining as well as the child's. */
  // `commit` and `setPeriod` lived here and are gone. This screen no
  // longer writes a budget figure: the year plan is the editor and `budgets`
  // is materialized from it, so a figure typed here was either
  // invisible to the year plan or wiped by the next materialize. `clear`
  // survives because removing a hand-set budget that predates the year plan
  // is still something you may need to do here.
  //
  // The period picker went with them. A yearly figure is the Annual column on
  // the year plan now, which is also where B4c went looking for it.

  /** Clear a budget — different from setting it to zero, which is a decision
   *  to spend nothing there. */
  async function clear(line: BudgetLine) {
    setBusy(true);
    setError(null);
    try {
      const rows = await api.listBudgets(month);
      const row = rows.find((b) => b.category_id === line.category_id);
      if (row) await api.deleteBudget(row.id);
      await load(month);
      await useBudgetStore.getState().loadSummary();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function toggle(id: string) {
    setOpen((was) => {
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function row(line: BudgetLine, isChild: boolean, group: BudgetGroup | null) {
    const expandable = group !== null && group.children.length > 0;
    // A find opens the groups it found things in; a match you cannot
    // see is not a find.
    const isOpen = group !== null && (open.has(group.parent.category_id) || (finding && group.children.length > 0));
    const over = line.has_budget && line.remaining_cents < 0;
    const pct =
      line.has_budget && line.target_cents > 0
        ? Math.min(100, Math.round((line.spent_cents / line.target_cents) * 100))
        : 0;

    return (
      <tr
        key={line.category_id}
        className={[isChild ? "tm-budget-child" : "tm-budget-parent", selected === line.category_id ? "selected" : ""]
          .filter(Boolean)
          .join(" ")}
        data-category-id={line.category_id}
        aria-selected={selected === line.category_id}
        onClick={() => setSelected(line.category_id)}
      >
        <td>
          <div className="tm-budget-name">
            {expandable ? (
              <button
                type="button"
                className="tm-budget-twisty"
                aria-expanded={isOpen}
                aria-label={`${isOpen ? "Hide" : "Show"} the categories under ${line.name}`}
                onClick={() => toggle(group.parent.category_id)}
              >
                {isOpen ? "▾" : "▸"}
              </button>
            ) : (
              <span className="tm-budget-twisty" aria-hidden="true" />
            )}
            <span>{line.name}</span>
            {/* What the parent is carrying for its children, said plainly —
                otherwise a parent showing more spent than its own rows is
                just confusing. */}
            {line.rolled_cents > 0 && (
              <span className="tm-budget-note">
                incl. {formatAmountBare(line.rolled_cents)} below
              </span>
            )}
            {/* How much of this envelope its parts have claimed. The
                amount is kept strictly above this, so it never reads as
                "fully spoken for". */}
            {line.children_budgeted_cents > 0 && (
              <span className="tm-budget-note">
                {formatAmountBare(line.children_budgeted_cents)} allocated below
              </span>
            )}
          </div>
        </td>
        {/* READ-ONLY since the year plan became the editor.
            > "I went to This Month, clicked forward to October, it showed
            >  Credit Card at 0.00 where I had set it and I changed it to 60.
            >  Where does that go? I went back to the year and it still shows
            >  nothing for annual or monthly."
            Nowhere, was the answer. This table is materialized from
            `budget_plans`, so a figure typed here is either invisible to the
            year plan (no plan on that category) or wiped by the next
            materialize (there is one). Two places to type the same number is
            how they come apart. The screen stays — it is a good reading —
            but the typing lives on the year plan now. */}
        <td className="num" title={budgetSource(line)}>
          {line.has_budget ? formatAmountBare(line.target_cents) : <span className="tm-budget-note">—</span>}
        </td>
        <td className="tm-budget-percell">
          {line.has_budget && (
            <span
              className="tm-budget-note"
              title={
                line.period === "yearly"
                  ? `${formatAmountBare(line.target_cents)} a year — ${formatAmountBare(line.monthly_cents)} a month`
                  : "A monthly amount"
              }
            >
              {line.period === "yearly" ? "/yr" : "/mo"}
            </span>
          )}
        </td>
        <td className="num">
          <Money cents={line.spent_cents} tone="neutral" />
          {/* A yearly line is measured against the YEAR, so say so
              rather than leave a number that looks like the month's. */}
          {line.period === "yearly" && line.has_budget && (
            <span className="tm-budget-note"> this year</span>
          )}
        </td>
        <td className="num">
          {line.has_budget ? <Money cents={line.remaining_cents} /> : <span className="tm-budget-note">—</span>}
        </td>
        <td className="tm-budget-barcell">
          {line.has_budget && line.target_cents > 0 && (
            <span className="tm-budget-bar" title={`${pct}% of ${formatAmountBare(line.target_cents)}`}>
              <span className={over ? "fill over" : "fill"} style={{ width: `${pct}%` }} />
            </span>
          )}
        </td>
        <td className="num">
          {line.has_budget && planned.has(line.category_id) && (
            <span className="tm-budget-note" title="This figure comes from the Year plan, which rewrites it. Clear it there.">
              Year plan
            </span>
          )}
          {line.has_budget && !planned.has(line.category_id) && (
            <button
              type="button"
              className="aero-btn !py-0 !px-1 text-[11px]"
              aria-label={`Clear the budget for ${line.full_name}`}
              disabled={busy}
              onClick={() => void clear(line)}
            >
              Clear
            </button>
          )}
        </td>
      </tr>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3">
      <section className="aero-card">
        <div className="aero-card-title flex items-center justify-between">
          <span className="flex items-center gap-1">
            <button
              type="button"
              className="aero-btn !py-0 !px-2"
              aria-label="Previous month"
              onClick={() => setMonth(shiftMonth(month, -1))}
            >
              {"‹"}
            </button>
            <span style={{ minWidth: 140, textAlign: "center" }}>{monthLabel(month)}</span>
            <button
              type="button"
              className="aero-btn !py-0 !px-2"
              aria-label="Next month"
              onClick={() => setMonth(shiftMonth(month, 1))}
            >
              {"›"}
            </button>
            {month !== currentMonth() && (
              <button type="button" className="aero-btn !py-0 !px-2 text-[11px]" onClick={() => setMonth(currentMonth())}>
                This month
              </button>
            )}
          </span>
          <span className="flex items-center gap-2">
            <FindOnPage value={find} onChange={setFind} what="category" />
            <button className="aero-btn !py-0 !px-2 text-[11px]" type="button" onClick={() => setDialog("starter")}>
              Start a budget…
            </button>
            <button className="aero-btn !py-0 !px-2 text-[11px]" type="button" onClick={() => setDialog("history")}>
              Autobudget…
            </button>
          </span>
        </div>

        {grid && (
          <div className="tm-budget-totals">
            <span>
              Budgeted <Money cents={grid.budgeted_cents} tone="neutral" />
            </span>
            <span>
              Spent <Money cents={grid.spent_cents} tone="neutral" />
            </span>
            {/* `auto` colors a negative red on its own, so the signed value
                does the work and the word in front of it only says which way
                to read the number. */}
            <span className="font-bold">
              {grid.remaining_cents < 0 ? "Over by " : "Left "}
              <Money
                cents={Math.abs(grid.remaining_cents)}
                tone={grid.remaining_cents < 0 ? "neutral" : "positive"}
                className={grid.remaining_cents < 0 ? "money-neg" : ""}
              />
            </span>
            <span className="tm-budget-note">
              {grid.budgeted_lines} of {grid.total_lines} categories budgeted · per month, with
              yearly amounts counted as a twelfth
            </span>
          </div>
        )}

        {notice && <div className="text-[11px] px-2 pb-1">{notice}</div>}
        {error && (
          <div className="px-2 pb-1">
            <Notice tone="error" boxed>
              {error}
            </Notice>
          </div>
        )}

        {nothingBudgeted && (
          <div className="tm-budget-empty">
            <div className="font-bold pb-1">Nothing is budgeted for {monthLabel(month)}.</div>
            <p className="pb-2">
              You do not have to budget every category — most people never do. Start with the dozen or
              so things you actually decide about, and everything underneath them counts against
              them. T-Money can propose those from what this file already spends.
            </p>
            <button type="button" className="aero-btn default" onClick={() => setDialog("starter")}>
              Start a budget from my spending…
            </button>
          </div>
        )}

        <div className="p-2">
          <table className="tm-budget-table w-full text-[12px]">
            <thead>
              <tr>
                <th className="text-left">Category</th>
                <th className="num">Budget</th>
                <th>Per</th>
                <th className="num">Spent</th>
                <th className="num">Left</th>
                <th></th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((g) => (
                <Fragment key={g.parent.category_id}>
                  {row(g.parent, false, g)}
                  {(open.has(g.parent.category_id) || (finding && g.children.length > 0)) &&
                    g.children.map((c) => row(c, true, null))}
                </Fragment>
              ))}
            </tbody>
          </table>
          {shown.length === 0 && finding && (
            <div className="tm-budget-note p-3 text-center" role="status">
              No category on this page matches “{find.trim()}”.
            </div>
          )}
          {shown.length === 0 && !finding && (
            <div className="tm-budget-note p-3 text-center">
              Nothing budgeted or spent yet this month. Check the box below to list
              every category; amounts are set on the Year plan.
            </div>
          )}
          <label className="inline-flex items-center gap-1 pt-2 text-[11px]">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
            Show every category, including the ones with nothing spent or budgeted
          </label>
        </div>
      </section>

      {dialog && (
        <>
          <div className="tm-dialog-backdrop" onClick={() => setDialog(null)} />
          <AutobudgetDialog
            month={month}
            source={dialog}
            onCancel={() => setDialog(null)}
            onApplied={async (rows, months) => {
              setDialog(null);
              await load(month);
              await useBudgetStore.getState().loadSummary();
              setNotice(`Set ${rows} budget ${rows === 1 ? "line" : "lines"}${months > 1 ? ` across ${months} months` : ""}.`);
            }}
          />
        </>
      )}
    </div>
  );
}
