// "Balance this account" — Money's reconcile wizard.
//
// Five states, matching reference/ms-money-05..09:
//   A resume   — only when a previous attempt was postponed
//   B statement— date / starting / ending, plus service charge and interest
//   C clearing — the DIALOG STAYS OPEN and the register behind it switches to
//                a grouped, checkable view. This component renders only the
//                small panel; the register does the rest.
//   D unbalanced — AutoReconcile / adjust / go back
//   E balanced — "Balanced!" with a suppressible Don't-show-again
import { useState } from "react";
import { formatAccountingBare, formatDateUS, formatMoney, parseMoneyToCents } from "../lib/format";
import { adjustmentForDifference } from "../lib/reconcile";
import type { Category, Statement } from "../lib/types";
import CategorySelect from "./CategorySelect";
import Notice from "./Notice";
import DateField from "./DateField";

export type ReconcileStage = "resume" | "statement" | "clearing" | "unbalanced" | "balanced";

export interface StatementDraft {
  statementDate: string;
  startingBalanceCents: number;
  endingBalanceCents: number;
  serviceChargeCents: number | null;
  serviceChargeCategoryId: string | null;
  interestCents: number | null;
  interestCategoryId: string | null;
}

interface Props {
  accountName: string;
  /** The ISO code of the account being balanced; omitted = the home currency. */
  currency?: string | null;
  stage: ReconcileStage;
  categories: readonly Category[];
  /** Suggested defaults: last statement + 1 month, and its ending balance. */
  suggestedDate: string;
  suggestedStartingCents: number;
  lastStatement: Statement | null;
  /** Live difference during clearing; zero means balanced. */
  differenceCents: number;
  onResume: () => void;
  onStatement: (draft: StatementDraft) => void | Promise<void>;
  onNextFromClearing: () => void;
  onPostpone: () => void;
  onUnbalancedChoice: (
    choice: "back" | "auto" | "adjust",
    adjustmentCategoryId: string | null
  ) => void | Promise<void>;
  onFinish: (dontShowAgain: boolean) => void | Promise<void>;
  onCancel: () => void;
  /** The clearing stage is drawn as a strip above the register, not a
   *  centered dialog, so the rows stay clickable while the difference is in view. */
  inline?: boolean;
  /** A refusal from the backend (a statement it would not start, a
   *  finish that failed). It is drawn inside the dialog, beside the buttons:
   *  the register used to write it to its own notice strip, which is under
   *  the backdrop while this dialog is up, so Next simply seemed not to work. */
  error?: string | null;
}

export default function ReconcileDialog(props: Props) {
  const { accountName, stage, inline = false } = props;
  if (inline && stage === "clearing") {
    return (
      <div className="tm-reconcile-bar" role="region" aria-label={`Balance ${accountName}`}>
        <ClearingBar {...props} />
      </div>
    );
  }
  return (
    <div className="tm-dialog" role="dialog" aria-label={`Balance ${accountName}`}>
      <div className="tm-dialog-title">Balance {accountName}</div>
      <div className="tm-dialog-body">
        {stage === "resume" && <Resume {...props} />}
        {stage === "statement" && <StatementStep {...props} />}
        {stage === "clearing" && <Clearing {...props} />}
        {stage === "unbalanced" && <Unbalanced {...props} />}
        {stage === "balanced" && <Balanced {...props} />}
        {/* The statement step shows its own, merged with what it checks
            before sending. */}
        {props.error && stage !== "statement" && (
          <Notice tone="error" boxed className="mt-2">
            {props.error}
          </Notice>
        )}
      </div>
    </div>
  );
}

function Resume({ onResume, onCancel }: Props) {
  return (
    <>
      <p className="pb-2">
        Money&apos;s records show that you previously began the process of balancing your
        account, but stopped before your account was balanced.
      </p>
      <p className="pb-2">
        The information you provided last time was saved, including all the transactions you
        marked as cleared. To continue from where you previously stopped, click Next.
      </p>
      <div className="flex justify-end gap-2 pt-2">
        <button className="aero-btn default" type="button" onClick={onResume}>
          Next &gt;
        </button>
        <button className="aero-btn" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </>
  );
}

function StatementStep({
  categories,
  suggestedDate,
  suggestedStartingCents,
  lastStatement,
  onStatement,
  onCancel,
  error: refused,
}: Props) {
  const [date, setDate] = useState(suggestedDate);
  const [starting, setStarting] = useState(
    formatAccountingBare(suggestedStartingCents)
  );
  const [ending, setEnding] = useState("");
  const [charge, setCharge] = useState("");
  const [chargeCat, setChargeCat] = useState("");
  const [interest, setInterest] = useState("");
  const [interestCat, setInterestCat] = useState("");
  const [error, setError] = useState<string | null>(null);

  function next() {
    // DateField sends "" for text it cannot read.
    if (!date) {
      setError(`Type a statement date the form can read, such as ${formatDateUS("2026-08-03")}.`);
      return;
    }
    const end = parseMoneyToCents(ending);
    if (end === null) {
      setError("Enter the ending balance from your statement.");
      return;
    }
    const start = parseMoneyToCents(starting);
    if (start === null) {
      setError(`"${starting}" is not an amount.`);
      return;
    }
    // A service charge or interest that does not read as an amount is
    // refused like the balances are. Both used to become "none": a typo in
    // the $12.00 fee started a statement without it, and the account then
    // would not balance by exactly the amount that had been typed.
    const serviceCharge = charge.trim() ? parseMoneyToCents(charge) : null;
    if (charge.trim() && serviceCharge === null) {
      setError(`"${charge.trim()}" is not an amount. Leave the service charge empty if there was none.`);
      return;
    }
    const interestEarned = interest.trim() ? parseMoneyToCents(interest) : null;
    if (interest.trim() && interestEarned === null) {
      setError(`"${interest.trim()}" is not an amount. Leave interest earned empty if there was none.`);
      return;
    }
    setError(null);
    void onStatement({
      statementDate: date,
      startingBalanceCents: start,
      endingBalanceCents: end,
      serviceChargeCents: serviceCharge,
      serviceChargeCategoryId: chargeCat || null,
      interestCents: interestEarned,
      interestCategoryId: interestCat || null,
    });
  }

  const field = (label: string, node: React.ReactNode) => (
    <label className="flex items-center gap-2 py-0.5 justify-end">
      <span className="text-right" style={{ width: 140 }}>
        {label}
      </span>
      {node}
    </label>
  );

  return (
    <>
      <h2 className="font-bold pb-2" style={{ color: "var(--tm-ms-text-heading)" }}>
        Enter the following information from your bank statement
      </h2>
      {field(
        "Statement date:",
        <DateField label="Statement date" value={date} onChange={setDate} width={180} />
      )}
      {field(
        "Starting balance:",
        <input
          className="aero-field text-right"
          value={starting}
          onChange={(e) => setStarting(e.target.value)}
          style={{ width: 180 }}
        />
      )}
      {field(
        "Ending balance:",
        <input
          className="aero-field text-right"
          value={ending}
          onChange={(e) => setEnding(e.target.value)}
          style={{ width: 180 }}
          autoFocus
        />
      )}

      <h2 className="font-bold py-2" style={{ color: "var(--tm-ms-text-heading)" }}>
        Enter bank statement details
      </h2>
      {field(
        "Service charge:",
        <input
          className="aero-field text-right"
          value={charge}
          onChange={(e) => setCharge(e.target.value)}
          style={{ width: 180 }}
        />
      )}
      {field(
        "Category:",
        <CategorySelect
          label="Service charge category"
          categories={categories}
          kind="expense"
          value={chargeCat}
          onChange={setChargeCat}
          style={{ width: 180 }}
        />
      )}
      {field(
        "Interest earned:",
        <input
          className="aero-field text-right"
          value={interest}
          onChange={(e) => setInterest(e.target.value)}
          style={{ width: 180 }}
        />
      )}
      {field(
        "Category:",
        <CategorySelect
          label="Interest category"
          categories={categories}
          kind="income"
          value={interestCat}
          onChange={setInterestCat}
          style={{ width: 180 }}
        />
      )}

      {(error ?? refused) && (
        <Notice tone="error" boxed className="mt-2">
          {error ?? refused}
        </Notice>
      )}

      <div className="flex items-center justify-between pt-3">
        <span style={{ color: "var(--tm-ms-text-muted)" }}>
          Last statement reconciled:{" "}
          {lastStatement?.reconciled_on ? formatDateUS(lastStatement.reconciled_on) : "—"}
        </span>
        <span className="flex gap-2">
          <button className="aero-btn default" type="button" onClick={next}>
            Next &gt;
          </button>
          <button className="aero-btn" type="button" onClick={onCancel}>
            Cancel
          </button>
        </span>
      </div>
    </>
  );
}

function Clearing({ differenceCents, currency, onNextFromClearing, onPostpone }: Props) {
  const balanced = differenceCents === 0;
  return (
    <>
      <h2 className="font-bold pb-2" style={{ color: "var(--tm-ms-text-heading)" }}>
        Balance Account
      </h2>
      <p className="pb-2">
        Compare your bank statement to the register, and click the &quot;C&quot; column for
        each matched transaction. Correct any missing or incorrect transactions.
      </p>
      <p className="pb-1">The difference between your statement and register is:</p>
      <p className={`font-bold pb-2 ${balanced ? "money-pos" : "money-neg"}`} aria-live="polite">
        {formatMoney(differenceCents, { currency })}
      </p>
      <p className="pb-2" style={{ color: "var(--tm-ms-text-muted)" }}>
        When all transactions are cleared, the difference should be zero. If not, you can make
        an adjustment later.
      </p>
      <div className="flex justify-end gap-2">
        <button className="aero-btn default" type="button" onClick={onNextFromClearing}>
          Next &gt;
        </button>
        <button className="aero-btn" type="button" onClick={onPostpone}>
          Postpone
        </button>
      </div>
    </>
  );
}

/** The clearing stage as one strip: the difference, live, with Next and
 *  Postpone — the register below it is where the work happens. */
function ClearingBar({ accountName, currency, lastStatement, differenceCents, onNextFromClearing, onPostpone }: Props) {
  const balanced = differenceCents === 0;
  return (
    <>
      <span className="font-bold" style={{ color: "var(--tm-ms-text-heading)" }} title={`Balancing ${accountName}`}>
        Balance Account
      </span>
      <span className="tm-text-muted">
        Click the <strong>C</strong> column (or press Ctrl+M) on each transaction that is on the statement
        {lastStatement ? ` ending ${formatDateUS(lastStatement.statement_date)}` : ""}.
      </span>
      <span className="flex-1" />
      <span>
        Difference:{" "}
        <strong className={balanced ? "money-pos" : "money-neg"} aria-live="polite" aria-label="Difference">
          {formatMoney(differenceCents, { currency })}
        </strong>
      </span>
      <button className="aero-btn default !py-0" type="button" onClick={onNextFromClearing}>
        Next &gt;
      </button>
      <button className="aero-btn !py-0" type="button" onClick={onPostpone}>
        Postpone
      </button>
    </>
  );
}

function Unbalanced({ categories, differenceCents, onUnbalancedChoice }: Props) {
  const [choice, setChoice] = useState<"back" | "auto" | "adjust">("auto");
  const [category, setCategory] = useState("");
  return (
    <>
      <h2 className="font-bold pb-2" style={{ color: "var(--tm-ms-text-heading)" }}>
        Your account doesn&apos;t balance with your statement.
      </h2>
      <p className="pb-2">
        A statement transaction may not have been cleared here, or a transaction cleared here
        may not appear on your statement. Alternatively, a cleared transaction may have an
        incorrect amount.
      </p>
      <p className="font-bold pb-1">What do you want to do?</p>
      <label className="flex items-center gap-2 py-0.5">
        <input
          type="radio"
          name="unbalanced"
          checked={choice === "back"}
          onChange={() => setChoice("back")}
        />
        Go back to balancing the account.
      </label>
      <label className="flex items-center gap-2 py-0.5">
        <input
          type="radio"
          name="unbalanced"
          checked={choice === "auto"}
          onChange={() => setChoice("auto")}
        />
        Use AutoReconcile to help find the error.
      </label>
      <label className="flex items-center gap-2 py-0.5">
        <input
          type="radio"
          name="unbalanced"
          checked={choice === "adjust"}
          onChange={() => setChoice("adjust")}
        />
        Automatically adjust the account balance.
      </label>
      <div className="pl-6 pt-1">
        <div style={{ color: choice === "adjust" ? undefined : "var(--tm-ms-text-muted)" }}>
          Adjustment: {formatAccountingBare(adjustmentForDifference(differenceCents))}
        </div>
        <label className="flex items-center gap-2 pt-1">
          <span style={{ width: 80 }}>Category:</span>
          <CategorySelect
            className="aero-field flex-1"
            label="Adjustment category"
            categories={categories}
            disabled={choice !== "adjust"}
            value={category}
            onChange={setCategory}
          />
        </label>
      </div>
      <div className="flex justify-end gap-2 pt-3">
        <button
          className="aero-btn default"
          type="button"
          onClick={() => void onUnbalancedChoice(choice, category || null)}
        >
          Next &gt;
        </button>
        {/* Money disables Cancel here — you must choose one of the three. */}
        <button className="aero-btn" type="button" disabled>
          Cancel
        </button>
      </div>
    </>
  );
}

function Balanced({ accountName, lastStatement, onFinish }: Props) {
  const [dontShow, setDontShow] = useState(false);
  return (
    <>
      <h2 className="font-bold pb-2" style={{ color: "var(--tm-ms-text-heading)" }}>
        Balanced!
      </h2>
      <p className="pb-4">
        You have balanced your &apos;{accountName}&apos; account through{" "}
        {lastStatement ? formatDateUS(lastStatement.statement_date) : "this statement"}.
      </p>
      <label className="flex items-center gap-2 pb-2">
        <input
          type="checkbox"
          checked={dontShow}
          onChange={(e) => setDontShow(e.target.checked)}
        />
        Don&apos;t show me this again
      </label>
      <div className="flex justify-end gap-2">
        <button
          className="aero-btn default"
          type="button"
          onClick={() => void onFinish(dontShow)}
        >
          Finish
        </button>
        <button className="aero-btn" type="button" disabled>
          Cancel
        </button>
      </div>
    </>
  );
}
