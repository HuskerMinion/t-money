// The year plan: the Budget screen as one decision a year.
//
// > *"I'm seeing that I have to budget every single month. Not put a budget
// >  in and see how it holds up for every month of the year."*
//
// THE SHAPE. Two columns you type in — Annual and Monthly, each computing the
// other — then twelve columns you never type in, which fill themselves as
// transactions are categorized, then the year so far and how it is holding
// up. Income sits in the same grid on the same terms, with a Net line at the
// bottom, because that is what a spreadsheet ends on.
//
// WHAT THIS SCREEN DELIBERATELY WILL NOT DO. There is no way to set a single
// month. The user was asked and declined: *"That doesn't upend the plan, it just
// is."* A heavy month is a fact in the actuals, and the plan it is measured
// against did not change. The backend enforces it — `set_plan` rewrites the
// twelve monthly rows every time — so this is not a UI convention that a
// future screen could quietly break.
//
// COLOR. One rule for both blocks, because the backend gives variance a
// single sign convention: positive is the good direction, income above plan
// and expense below it. Individual income MONTHS are never colored at all —
// asked for directly, and right: a lump-sum month is not a fault, and a light
// one is not a failure. Only the year-to-date figure judges anything.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/ipc";
import { formatAmountBare, parseMoneyToCents } from "../lib/format";
import BuildPlanDialog from "./BuildPlanDialog";
import Notice from "./Notice";
import FindOnPage from "./FindOnPage";
import { isFinding, matchGroups } from "../lib/findOnPage";
import type { PlanLine,
  PlanSpread, YearPlan } from "../lib/types";

export const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export const EVERY_MONTH = "111111111111";

/** How many months a mask runs. A malformed mask reads as every month, the
 *  same way the backend reads it — the two must not disagree about a line. */
export function monthCount(months: string): number {
  if (months.length !== 12) return 12;
  const n = [...months].filter((c) => c === "1").length;
  return n === 0 ? 12 : n;
}

/** Typing a MONTHLY figure sets the annual one, over the months it runs. That
 *  is the whole reason both columns are editable: the user thinks in "about $100 a
 *  year" for registration and "$1,000 a month" for food, and neither should
 *  have to be converted by hand.
 *
 *  Over TWELVE for a set-aside line, whatever its mask says. Its
 *  mask names the months the bill is due, not the months it is funded, so
 *  multiplying by the mask's count would read "$340 a month" as a $680 year.
 */
export function annualFromMonthly(
  monthlyCents: number,
  months: string,
  spread: PlanSpread = "spent"
): number {
  return monthlyCents * (spread === "aside" ? 12 : monthCount(months));
}

/** What a month cell shows when nothing has been recorded in it.
 *
 * > *"it should have the monthly amount until an actual categorized item is
 * >  entered... the amount for the spread over payment should land in the
 * >  month(s) selected replacing the lower monthly amount."*
 *
 * So: the month you are DUE to pay shows the payment, every other month shows
 * what you are putting by, and a month the line does not run at all shows
 * nothing. `null` means "draw the old dash or dot", not "zero".
 *
 * A month with no plan projects nothing — there is no figure to project.
 */
export function projectedCents(line: PlanLine, i: number, elapsed = 12): number | null {
  if (!line.has_plan) return null;
  if (line.spread === "aside") {
    // A due month that has already GONE BY without a payment does
    // not get to promise one.
    //
    // Insurance due Jan and Jul, paid 1,950.00 in June, and
    // January — nine months in the past, nothing recorded — still showing a
    // projected 2,000.00. The row was asserting money had left in a month
    // that is over and in which nothing left. July keeps its projection,
    // because July has not happened yet and that bill is still to come.
    //
    // What a past due month shows instead is the ordinary monthly figure:
    // you were still setting money aside that month, whatever the bill did.
    const past = i + 1 < elapsed;
    if (isDueMonth(line, i) && !past) return line.payment_cents;
    return line.monthly_cents;
  }
  // A "spent" line only runs in the months it is spent in.
  const runs = line.months.length !== 12 || line.months[i] === "1";
  return runs ? line.monthly_cents : null;
}

/** A parent and the children under it, in the order the backend sent. */
export interface PlanGroup {
  parent: PlanLine;
  children: PlanLine[];
}

export function groupPlan(lines: readonly PlanLine[]): PlanGroup[] {
  const groups = new Map<string, PlanGroup>();
  for (const l of lines) if (l.parent_id === null) groups.set(l.category_id, { parent: l, children: [] });
  for (const l of lines) {
    if (l.parent_id === null) continue;
    const g = groups.get(l.parent_id);
    if (g) g.children.push(l);
    else groups.set(l.category_id, { parent: l, children: [] });
  }
  return [...groups.values()];
}

/** Worth showing when the screen is not showing everything: planned, or money
 *  actually moved through it this year. */
export function groupIsInteresting(g: PlanGroup): boolean {
  return [g.parent, ...g.children].some(
    (r) => r.has_plan || r.actual_cents.some((c) => c !== 0)
  );
}

/** What the Spread over column reads for one line.
 *
 * A "spent" line says when it runs, as it always did. An "aside" line has two
 * numbers and both matter: *"I show what I need to save monthly and I show
 * the month I need to pay the bill in."* So it says both, in money, rather
 * than picking one and leaving the other to be worked out.
 */
export function spreadLabel(line: PlanLine): string {
  if (!line.has_plan) return "—";
  if (line.spread !== "aside") return line.months_label;
  const due = line.months_label === "every month" ? "every month" : line.months_label;
  return `${formatAmountBare(line.monthly_cents)} a month · ${formatAmountBare(
    line.payment_cents
  )} due ${due}`;
}

/** What the last column MEANS for one line.
 *
 * On an ordinary line it is a variance: ahead of plan, or behind it.
 *
 * On a set-aside line it is not a variance at all, it is a **balance** — what
 * you have put by for this and not yet spent. `expected_to_date` accrues every
 * elapsed month, including the month a bill lands, and `actual_to_date` is the
 * payments; the difference is the money still sitting there.
 *
 * > *"even when the real payment hits in a case like that the monthly amount
 * >  is still also getting saved so is there a way to account for that"*
 *
 * There is, and this is it. A negative figure is the real warning — the bill
 * arrived before enough had been put by — and is normal in the first year of
 * a plan, when nothing has accrued yet.
 */
export function varianceNote(line: PlanLine): string | undefined {
  if (!line.has_plan) return undefined;
  const amount = formatAmountBare(Math.abs(line.variance_cents));
  if (line.spread === "aside") {
    return line.variance_cents >= 0
      ? `${line.name}: ${amount} saved so far, not yet spent`
      : `${line.name}: short by ${amount} — the bill came before the saving did`;
  }
  if (line.kind === "income") {
    return line.variance_cents >= 0
      ? `${line.name}: ${amount} more than planned, so far`
      : `${line.name}: ${amount} less than planned, so far`;
  }
  return line.variance_cents >= 0
    ? `${line.name}: ${amount} under plan, so far`
    : `${line.name}: ${amount} over plan, so far`;
}

/** Is month `i` (0-based) one this line's bill is DUE in? Only
 *  "aside" lines mark a month: for a "spent" line every month it runs in is
 *  already carrying its own figure, and underlining all of them would say
 *  nothing. */
export function isDueMonth(line: PlanLine, i: number): boolean {
  return line.has_plan && line.spread === "aside" && line.months.length === 12 && line.months[i] === "1";
}

/** What to say about a parent this write moved. */
export function raiseNotice(
  raised: { category_name: string; target_cents: number; created: boolean } | null
): string | null {
  if (!raised) return null;
  const amount = formatAmountBare(raised.target_cents);
  return raised.created
    ? `${raised.category_name} had no plan, so it was set to ${amount} a month to cover its subcategories.`
    : `${raised.category_name} raised to ${amount} a month to cover its subcategories.`;
}

export default function YearPlanView() {
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [plan, setPlan] = useState<YearPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);
  // Ctrl+F here finds a budget line, not a transaction.
  const [find, setFind] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  /** The cell being typed in, so a half-typed "12" is not written as $12 on
   *  every keystroke. Committed on Enter or blur. */
  const [editing, setEditing] = useState<{ id: string; col: "annual" | "monthly"; text: string } | null>(null);
  /** The line whose months are being chosen. */
  const [spreadFor, setSpreadFor] = useState<PlanLine | null>(null);
  const [building, setBuilding] = useState(false);

  /** The year on screen, and the newest request whose answer has been
   *  shown. Typing a figure and clicking › saved into 2026 and started 2027's
   *  load; the save's own reload of 2026 then landed last and put 2026's
   *  figures under "2027", where the next edit wrote them into 2027. An answer
   *  counts only for the year being shown, and only if nothing newer for that
   *  year has been shown already. */
  const shownYear = useRef(year);
  const seq = useRef(0);
  const applied = useRef(0);

  const load = useCallback(async (y: number) => {
    const mine = ++seq.current;
    try {
      const answer = await api.getYearPlan(y);
      if (y !== shownYear.current || mine < applied.current) return;
      applied.current = mine;
      // Checked rather than trusted. Every figure on this screen is read off
      // the totals, so an answer missing them renders nothing and takes the
      // whole tab down with it — which is exactly what happened the first
      // time a test stubbed this command with an empty array. A screen that
      // says it cannot read the plan is a bug report; a blank app is a
      // mystery.
      if (!answer || !Array.isArray(answer.income) || !answer.income_total || !answer.net) {
        throw new Error("The year plan came back in a shape this screen cannot read.");
      }
      setPlan(answer);
      setError(null);
    } catch (e) {
      if (y !== shownYear.current || mine < applied.current) return;
      applied.current = mine;
      setPlan(null);
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    // The old year's rows go the moment the heading changes, so no
    // figure is ever on screen under a year it does not belong to, and no box
    // from the old year is there to type into while the new one loads.
    if (shownYear.current !== year) {
      shownYear.current = year;
      setPlan(null);
      setEditing(null);
    }
    void load(year);
  }, [load, year]);

  /** The month column the eye should land on. Only in the current
   *  year: tinting January of 2031 because today is January would be a lie
   *  about which figures are real. 0 means no column is now. */
  const nowMonth = useMemo(() => {
    const now = new Date();
    return year === now.getFullYear() ? now.getMonth() + 1 : 0;
  }, [year]);

  const incomeGroups = useMemo(() => groupPlan(plan?.income ?? []), [plan]);
  const expenseGroups = useMemo(() => groupPlan(plan?.expenses ?? []), [plan]);
  const finding = isFinding(find);
  const shownIncome = finding
    ? matchGroups(incomeGroups, find)
    : showAll
      ? incomeGroups
      : incomeGroups.filter(groupIsInteresting);
  const shownExpenses = finding
    ? matchGroups(expenseGroups, find)
    : showAll
      ? expenseGroups
      : expenseGroups.filter(groupIsInteresting);

  async function write(
    line: PlanLine,
    annualCents: number,
    months: string,
    // Defaults to the line's OWN reading, so typing a new figure into
    // a set-aside line does not quietly turn it back into a spent one.
    spread: PlanSpread = line.spread
  ) {
    setBusy(true);
    setError(null);
    try {
      const written = await api.setBudgetPlan(line.category_id, year, annualCents, months, spread);
      setNotice(raiseNotice(written.raised));
      await load(year);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function commit(line: PlanLine, col: "annual" | "monthly", text: string) {
    setEditing(null);

    // EMPTYING A BOX CLEARS THE LINE. It does not write a zero.
    //
    // An earlier change made an emptied box mean zero, on the reasoning that the year plan defines
    // zero as a real plan of nothing. Driven, that was wrong twice over:
    //
    // > *"when I put an amount in a child category and then delete it it goes
    // >  to zero and doesn't clear that field... Otherwise it shows up on the
    // >  following month page budget only because it has a 0.00 in it."*
    //
    // and, worse, tabbing through an EMPTY box on a line that had no plan
    // created one:
    //
    // > *"if I click in to the Monthly box and tab out it puts 0.00 in both
    // >  monthly and annual and that's bad - it needs to stay blank unless an
    // >  actual amount is entered"*
    //
    // So: nothing there and nothing typed means nothing happened. Something
    // there and the text deleted means take it away. A plan of zero is still
    // reachable and still means "nothing here on purpose" — by TYPING 0,
    // which is a different act from rubbing the figure out.
    if (text.trim() === "") {
      if (line.has_plan) await clear(line);
      return;
    }

    const cents = parseMoneyToCents(text);
    // Not a number: put the row back rather than guess — and say so.
    // The figure used to vanish without a word, which reads as a save.
    if (cents === null) {
      setError(`"${text.trim()}" is not an amount. ${line.full_name} was left as it was.`);
      return;
    }
    if (cents < 0) {
      setError("A plan cannot be negative.");
      return;
    }
    // Tabbing THROUGH a monthly box must not rewrite the plan. The
    // monthly figure is rounded up, so $4,000 a year reads $340 a month and
    // 340 x 12 is $4,080: committing a figure nobody retyped would walk the
    // annual up every time the field was visited. This is the old Tab-through
    // class of bug, and the guard is to compare against what was SHOWN.
    if (line.has_plan && col === "monthly" && cents === line.monthly_cents) return;
    const annual =
      col === "annual" ? cents : annualFromMonthly(cents, line.months, line.spread);
    if (line.has_plan && annual === line.annual_cents) return;
    await write(line, annual, line.months);
  }

  async function clear(line: PlanLine) {
    setBusy(true);
    setError(null);
    try {
      await api.clearBudgetPlan(line.category_id, year);
      setNotice(null);
      await load(year);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function amountCell(line: PlanLine, col: "annual" | "monthly") {
    const value = col === "annual" ? line.annual_cents : line.monthly_cents;
    const editingThis = editing?.id === line.category_id && editing.col === col;
    return (
      <td className="num tm-plan-authored" style={{ padding: "2px 4px" }}>
        <input
          className="aero-field tm-budget-amount"
          aria-label={`${col === "annual" ? "Annual" : "Monthly"} plan for ${line.full_name}`}
          value={editingThis ? editing.text : line.has_plan ? formatAmountBare(value) : ""}
          /* An empty field still shows the tic the empty month cells
             use, so a line with no plan reads as two boxes waiting for a
             figure rather than as blank table. */
          placeholder="—"
          disabled={busy}
          onFocus={() => {
            setSelected(line.category_id);
            setEditing({
              id: line.category_id,
              col,
              text: line.has_plan ? formatAmountBare(value) : "",
            });
          }}
          onChange={(e) => setEditing({ id: line.category_id, col, text: e.target.value })}
          onBlur={(e) => void commit(line, col, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setEditing(null);
            }
          }}
        />
      </td>
    );
  }

  function row(line: PlanLine, child: boolean, alt: boolean, group?: PlanGroup) {
    const isSelected = selected === line.category_id;
    const income = line.kind === "income";
    const expandable = !child && (group?.children.length ?? 0) > 0;
    const isOpen = open.has(line.category_id);
    return (
      <tr
        key={line.category_id}
        className={[
          child ? "tm-budget-child" : "tm-budget-parent",
          alt ? "tm-plan-alt" : "",
          isSelected ? "selected" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        data-category-id={line.category_id}
        aria-selected={isSelected}
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
                onClick={() =>
                  setOpen((s) => {
                    const next = new Set(s);
                    if (next.has(line.category_id)) next.delete(line.category_id);
                    else next.add(line.category_id);
                    return next;
                  })
                }
              >
                {isOpen ? "▾" : "▸"}
              </button>
            ) : (
              <span className="tm-budget-twisty" aria-hidden="true" />
            )}
            <span>{line.name}</span>
          </div>
        </td>
        {amountCell(line, "annual")}
        {amountCell(line, "monthly")}
        <td className="tm-plan-authored tm-plan-authored-end">
          <button
            type="button"
            className="tm-plan-when"
            aria-label={`When ${line.full_name} runs`}
            disabled={busy || !line.has_plan}
            onClick={() => setSpreadFor(line)}
          >
            {spreadLabel(line)}
          </button>
        </td>
        {line.actual_cents.map((cents, i) => {
          const future = i + 1 > (plan?.months_elapsed ?? 0);
          // An "aside" line runs in EVERY month: its twelfth is being
          // set aside all year, and the mask is naming where the bill lands,
          // not where the line is active.
          const aside = line.spread === "aside";
          const runs = aside || line.months.length !== 12 || line.months[i] === "1";
          // An expense month over its share reads red. An income month never
          // does: a month is what it was.
          //
          // And neither does an "aside" month, for the same reason.
          // The bill landing in January is not an overspend, it is the thing
          // eleven months of saving were FOR. Judging it per month would paint
          // the due month red every single year. Only `vs plan` judges an
          // aside line, and over the year it comes back to zero.
          const over = !income && !aside && line.has_plan && runs && cents > line.monthly_cents;
          // A month with nothing recorded shows what it is PLANNED to
          // be, so the row reads as a whole year: what happened behind you,
          // what you are budgeting for ahead. A real figure replaces it the
          // moment one is categorized.
          //
          // Zero is treated as "nothing recorded". The register cannot tell a
          // month where nothing happened from one that has not been entered,
          // and when asked, the answer was to show the amount: it is what is being
          // projected and saved even in a month with no bill.
          const projected =
            cents === 0 ? projectedCents(line, i, plan?.months_elapsed ?? 12) : null;
          const body =
            cents !== 0
              ? formatAmountBare(cents)
              : projected !== null
                ? formatAmountBare(projected)
                : line.has_plan && !runs
                  ? "—"
                  : future
                    ? "·"
                    : formatAmountBare(0);
          return (
            <td
              key={MONTH_NAMES[i]}
              className={`num tm-plan-month${i + 1 === nowMonth ? " tm-plan-now" : ""}${
                over ? " money-neg" : ""
              }${cents === 0 && projected === null ? " tm-plan-quiet" : ""}${
                projected !== null ? " tm-plan-projected" : ""
              }${isDueMonth(line, i) ? " tm-plan-due" : ""}`}
              title={
                projected !== null
                  ? isDueMonth(line, i)
                    ? `${line.name}: ${formatAmountBare(projected)} due in ${MONTH_NAMES[i]} — planned, not yet paid`
                    : `${line.name}: ${formatAmountBare(projected)} planned for ${MONTH_NAMES[i]}, nothing recorded yet`
                  : isDueMonth(line, i)
                    ? `${line.name} is due in ${MONTH_NAMES[i]}`
                    : undefined
              }
            >
              {body}
            </td>
          );
        })}
        <td className="num tm-plan-sofar">{formatAmountBare(line.actual_to_date)}</td>
        <td
          className={`num ${line.variance_cents >= 0 ? "money-pos" : "money-neg"}`}
          title={varianceNote(line)}
        >
          {/* A set-aside line shows a BALANCE, and a balance does not
              take a plus sign: "380.00" is what is put by, not "+380.00" as
              though it were a surplus against something. A shortfall keeps
              its minus, because that one IS a warning. */}
          {!line.has_plan
            ? ""
            : line.spread === "aside"
              ? (
                  <>
                    {(line.variance_cents < 0 ? "−" : "") + formatAmountBare(Math.abs(line.variance_cents))}
                    {/* The word ON the screen, not only in the hover
                        note. An earlier change put "saved so far, not yet spent" in the
                        title, and the user never saw it: nobody hovers a number.
                        One word fits the column; the sentence stays as the
                        title for anyone who does. */}
                    <span className="tm-plan-word">{line.variance_cents < 0 ? "short" : "saved"}</span>
                  </>
                )
              : (line.variance_cents >= 0 ? "+" : "−") + formatAmountBare(Math.abs(line.variance_cents))}
        </td>
        <td>
          {line.has_plan && (
            <button
              type="button"
              className="aero-btn"
              aria-label={`Clear the plan for ${line.full_name}`}
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

  function block(label: string, groups: PlanGroup[]) {
    return (
      <Fragment key={label}>
        <tr className="tm-plan-band">
          <td colSpan={19}>{label}</td>
        </tr>
        {groups.map((g, i) => (
          <Fragment key={g.parent.category_id}>
            {row(g.parent, false, i % 2 === 1, g)}
            {open.has(g.parent.category_id) &&
              g.children.map((c, j) => row(c, true, (i + j + 1) % 2 === 1))}
          </Fragment>
        ))}
      </Fragment>
    );
  }

  function totalsRow(label: string, t: YearPlan["income_total"], variance: boolean) {
    return (
      <tr className="tm-plan-total">
        <td>{label}</td>
        <td className="num">{formatAmountBare(t.annual_cents)}</td>
        <td className="num">{formatAmountBare(t.monthly_cents)}</td>
        <td />
        {t.actual_cents.map((c, i) => (
          <td
            key={MONTH_NAMES[i]}
            className={`num tm-plan-month${i + 1 === nowMonth ? " tm-plan-now" : ""}`}
          >
            {i + 1 > (plan?.months_elapsed ?? 0) && c === 0 ? "·" : formatAmountBare(c)}
          </td>
        ))}
        <td className="num tm-plan-sofar">{formatAmountBare(t.actual_to_date)}</td>
        <td className={`num ${t.variance_cents >= 0 ? "money-pos" : "money-neg"}`}>
          {variance ? (t.variance_cents >= 0 ? "+" : "−") + formatAmountBare(Math.abs(t.variance_cents)) : ""}
        </td>
        <td />
      </tr>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4">
      <section className="aero-card">
        <div className="aero-card-title">{year} budget</div>

        <div className="flex items-center gap-3 p-2 bg-white border-b border-[color:var(--tm-ms-card-border)] flex-wrap">
          <div className="flex items-center gap-1">
            {/* Held while a write is in flight: the write belongs to the
                year it was typed in, and its reload must not cross a year
                change (see `shownYear`). */}
            <button type="button" className="aero-btn" aria-label="Previous year" disabled={busy} onClick={() => setYear((y) => y - 1)}>
              ‹
            </button>
            <span className="font-bold px-2" style={{ fontSize: "1.2em", color: "var(--tm-ms-text-heading)" }}>
              {year}
            </span>
            <button type="button" className="aero-btn" aria-label="Next year" disabled={busy} onClick={() => setYear((y) => y + 1)}>
              ›
            </button>
            <button type="button" className="aero-btn" disabled={busy} onClick={() => setYear(new Date().getFullYear())}>
              This year
            </button>
          </div>
          <div className="flex-grow" />
          <FindOnPage value={find} onChange={setFind} what="category" />
          <button type="button" className="aero-btn" disabled={busy} onClick={() => setBuilding(true)}>
            Build from history…
          </button>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
            Show every category
          </label>
        </div>

        {plan && (
          <div className="flex flex-wrap bg-[color:var(--tm-ms-card-body)] border-b border-[color:var(--tm-ms-card-border)]">
            <div className="px-3 py-2 border-r border-[color:var(--tm-ms-card-border)]">
              <div className="tm-text-muted">Income planned</div>
              <div className="font-bold" style={{ fontSize: "1.3em" }}>
                {formatAmountBare(plan.income_total.annual_cents)}
              </div>
            </div>
            <div className="px-3 py-2 border-r border-[color:var(--tm-ms-card-border)]">
              <div className="tm-text-muted">Expenses planned</div>
              <div className="font-bold" style={{ fontSize: "1.3em" }}>
                {formatAmountBare(plan.expense_total.annual_cents)}
              </div>
            </div>
            <div className="px-3 py-2 border-r border-[color:var(--tm-ms-card-border)]">
              <div className="tm-text-muted">Left over, planned</div>
              <div className={`font-bold ${plan.net.annual_cents >= 0 ? "money-pos" : "money-neg"}`} style={{ fontSize: "1.3em" }}>
                {formatAmountBare(plan.net.annual_cents)}
              </div>
            </div>
            <div className="px-3 py-2 border-r border-[color:var(--tm-ms-card-border)]">
              <div className="tm-text-muted">Left over so far</div>
              <div className={`font-bold ${plan.net.actual_to_date >= 0 ? "money-pos" : "money-neg"}`} style={{ fontSize: "1.3em" }}>
                {formatAmountBare(plan.net.actual_to_date)}
              </div>
            </div>
            <div className="px-3 py-2">
              <div className="tm-text-muted">Expenses vs plan</div>
              <div className={`font-bold ${plan.expense_total.variance_cents >= 0 ? "money-pos" : "money-neg"}`} style={{ fontSize: "1.3em" }}>
                {(plan.expense_total.variance_cents >= 0 ? "+" : "−") +
                  formatAmountBare(Math.abs(plan.expense_total.variance_cents))}
              </div>
            </div>
          </div>
        )}

        {notice && (
          <div className="tm-file-banner" role="status">
            <span>{notice}</span>
            <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)}>
              ✕
            </button>
          </div>
        )}
        {error && (
          <div className="p-2">
            <Notice tone="error" boxed onDismiss={() => setError(null)}>
              {error}
            </Notice>
          </div>
        )}

        <div style={{ overflowX: "auto" }}>
          <table className="tm-budget-table tm-plan-table" style={{ width: "100%" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Category</th>
                <th className="num tm-plan-authored" style={{ width: 96 }}>
                  Annual
                </th>
                <th className="num tm-plan-authored" style={{ width: 96 }}>
                  Monthly
                </th>
                <th
                  className="tm-plan-authored tm-plan-authored-end"
                  style={{ textAlign: "left", width: 150 }}
                >
                  Spread over
                </th>
                {MONTH_NAMES.map((m, i) => (
                  <th
                    key={m}
                    className={`num tm-plan-month${i + 1 === nowMonth ? " tm-plan-now" : ""}`}
                    scope="col"
                  >
                    {m}
                  </th>
                ))}
                <th className="num">So far</th>
                <th className="num">vs plan</th>
                <th style={{ width: 60 }} />
              </tr>
            </thead>
            <tbody>
              {block("Income", shownIncome)}
              {plan && totalsRow("Total income", plan.income_total, true)}
              {block("Expenses", shownExpenses)}
              {plan && totalsRow("Total expenses", plan.expense_total, true)}
              {plan && totalsRow("Net", plan.net, false)}
            </tbody>
          </table>
          {finding && shownIncome.length === 0 && shownExpenses.length === 0 && (
            <div className="tm-budget-note p-3 text-center" role="status">
              No category on this page matches “{find.trim()}”.
            </div>
          )}
        </div>

        <div className="p-2 tm-text-muted">
          Nothing on this screen is set per month. The two amount columns are the whole budget — type either one and the
          other follows — and the twelve columns after them are what actually happened.
        </div>
      </section>

      {building && (
        <BuildPlanDialog
          year={year}
          onCancel={() => setBuilding(false)}
          onApplied={(written) => {
            setBuilding(false);
            setNotice(
              `${written} line${written === 1 ? "" : "s"} written into ${year}. Everything on this screen can still be typed over.`
            );
            void load(year);
          }}
        />
      )}

      {spreadFor && (
        <SpreadDialog
          line={spreadFor}
          busy={busy}
          onCancel={() => setSpreadFor(null)}
          onSave={async (months, spread) => {
            const line = spreadFor;
            setSpreadFor(null);
            // The ANNUAL figure is what the user decided; changing when it is spent
            // must not change what it costs, so the annual travels unchanged
            // and the monthly figure moves instead.
            await write(line, line.annual_cents, months, spread);
          }}
        />
      )}
    </div>
  );
}

/** The one place a line says anything about individual months, and it
 *  says it once for the year rather than twelve times. */
/** "January", "January and July", "January, April and July". The
 *  dialog says which months a bill lands in, and a comma-separated machine
 *  list reads like a setting rather than like a sentence. */
export function monthsPhrase(months: string): string {
  const names = MONTH_NAMES.filter((_, i) => months[i] === "1");
  if (names.length === 0) return "no month";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function SpreadDialog({
  line,
  busy,
  onCancel,
  onSave,
}: {
  line: PlanLine;
  busy: boolean;
  onCancel: () => void;
  onSave: (months: string, spread: PlanSpread) => void | Promise<void>;
}) {
  const [months, setMonths] = useState(line.months.length === 12 ? line.months : EVERY_MONTH);
  const [spread, setSpread] = useState<PlanSpread>(line.spread === "aside" ? "aside" : "spent");
  const every = months === EVERY_MONTH;
  const count = [...months].filter((c) => c === "1").length;
  const aside = spread === "aside";
  // The divisor is the whole difference between the two readings.
  const per = aside
    ? Math.round(line.annual_cents / 12)
    : count === 0
      ? 0
      : Math.round(line.annual_cents / count);
  const payment = count === 0 ? 0 : Math.round(line.annual_cents / count);

  function toggle(i: number) {
    setMonths((m) => {
      const chars = [...m];
      chars[i] = chars[i] === "1" ? "0" : "1";
      const next = chars.join("");
      // AN EXPENSE THAT STOPS RUNNING ALL YEAR IS ASSUMED TO BE SAVED
      // FOR, not merely skipped.
      //
      // An expense that is ticked for only some months is, in practice, one
      // that is saved for every month and paid in a few: a water bill that
      // comes every other month is the usual example.
      //
      // Unticking a month used to slide a line silently from "every month"
      // to *spent only in these months*, because the mode was derived from
      // the mask rather than chosen. For an expense that is the wrong guess
      // almost every time: a bi-monthly water bill became $600 in six
      // months and nothing in the other six, when what was wanted was a
      // twelfth every month with six due months marked.
      //
      // INCOME IS LEFT ALONE. Acme Corp over January to April is money that
      // ARRIVES in those months; you do not set money aside for income, and
      // a twelfth of it would claim $1,500 landing in July when nothing
      // does. Spent-only is right there, and it is still one click away for
      // an expense that really is seasonal.
      if (next !== EVERY_MONTH && spread === "spent" && line.kind === "expense") {
        setSpread("aside");
      }
      return next;
    });
  }

  /** The three readings, as one radio group. "Every month" is not a separate
   *  storage mode — it is `spent` with all twelve set — so picking it sets
   *  the mask rather than the spread. */
  function choose(next: "every" | "only" | "aside") {
    if (next === "every") {
      setSpread("spent");
      setMonths(EVERY_MONTH);
    } else if (next === "only") {
      setSpread("spent");
      if (every) setMonths("100000000000");
    } else {
      setSpread("aside");
      if (every) setMonths("100000000000");
    }
  }

  const mode: "every" | "only" | "aside" = aside ? "aside" : every ? "every" : "only";

  return (
    <>
      <div className="tm-dialog-backdrop" onClick={onCancel} />
      <div className="tm-dialog" role="dialog" aria-label="When does this run">
        <div className="tm-dialog-title">{line.full_name} — when does this run?</div>
        <div className="tm-dialog-body space-y-2">
          <div className="space-y-1">
            <label className="flex items-start gap-2">
              <input
                type="radio"
                name="tm-spread"
                checked={mode === "every"}
                onChange={() => choose("every")}
              />
              <span>
                <b>Spent every month</b> — a twelfth each.
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input
                type="radio"
                name="tm-spread"
                checked={mode === "only"}
                onChange={() => choose("only")}
              />
              <span>
                <b>Spent only in these months</b> — nothing goes out the rest of the year. Heating
                oil over the cold months.
              </span>
            </label>
            {/* The third reading. */}
            <label className="flex items-start gap-2">
              <input
                type="radio"
                name="tm-spread"
                checked={mode === "aside"}
                onChange={() => choose("aside")}
              />
              <span>
                <b>Saved every month, paid in these months</b> — money goes by all year and the bill
                lands then. Insurance, property tax.
              </span>
            </label>
          </div>

          <div>{aside ? "Which months is the bill paid in?" : "Which months does this money move in?"}</div>
          <div className="flex flex-wrap gap-1">
            {MONTH_NAMES.map((m, i) => (
              <label
                key={m}
                className="flex items-center gap-1 px-2 py-1 border"
                style={{
                  borderColor: "var(--tm-ms-field-border-top)",
                  background: months[i] === "1" ? "var(--tm-ms-row-active)" : "var(--tm-ms-field-bg)",
                }}
              >
                <input type="checkbox" checked={months[i] === "1"} onChange={() => toggle(i)} />
                {m}
              </label>
            ))}
          </div>
          {!aside && (
            <div className="flex gap-2">
              <button type="button" className="aero-btn" onClick={() => choose("every")}>
                Every month
              </button>
              <button type="button" className="aero-btn" onClick={() => setMonths("000000000000")}>
                None
              </button>
            </div>
          )}
          {/* Said in money rather than in rules: what this choice does to the
              figure in the row, before it is made. */}
          <div className="aero-card p-2" aria-label="What this means">
            {count === 0 ? (
              <span>
                {aside
                  ? "Pick the month the bill is paid in — that is the whole point of this choice."
                  : "Pick at least one month — a plan has to be spent somewhere."}
              </span>
            ) : aside ? (
              <span>
                <b>{formatAmountBare(per)}</b> set aside every month, all twelve. The bill is{" "}
                <b>{formatAmountBare(payment)}</b> in {monthsPhrase(months)}, and that month is marked
                rather than counted against you. The year is still{" "}
                <b>{formatAmountBare(line.annual_cents)}</b>.
              </span>
            ) : every ? (
              <span>
                <b>{formatAmountBare(per)}</b> a month, every month. The year is{" "}
                <b>{formatAmountBare(line.annual_cents)}</b>.
              </span>
            ) : (
              <span>
                <b>{formatAmountBare(per)}</b> expected in each of {count} month{count === 1 ? "" : "s"}. The rest show a
                dash and count nothing against you. The year is still{" "}
                <b>{formatAmountBare(line.annual_cents)}</b>.
              </span>
            )}
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              className="aero-btn default"
              disabled={busy || count === 0}
              onClick={() => void onSave(months, spread)}
            >
              OK
            </button>
            <button type="button" className="aero-btn" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
