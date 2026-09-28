// TransactionEditRow — Money's in-place transaction form (§6.1b).
//
// Modeled on reference/ms-money-03-transaction-form.png. Three stacked bands,
// all on the cream ground (--tm-ms-row-active):
//
//   1. the grid row itself, edited IN ITS OWN COLUMNS
//   2. a second line for the fields the grid does not show: Category, Memo
//   3. a button strip: Common Transactions ▾ | Enter | Split | Cancel
//
// This is not a modal. Money reveals it with the "Show transaction forms"
// checkbox at the foot of the register, and it edits the selected row where it
// sits.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import SplitDialog from "./SplitDialog";
import CategoryCombo, { type ComboItem } from "./CategoryCombo";
import PayeeField from "./PayeeField";
import NewCategoryDialog, { type NewCategoryDraft } from "./NewCategoryDialog";
import DateField from "./DateField";
import AttachmentsPanel from "./AttachmentsPanel";
import Notice from "./Notice";
import { formatAmountBare, parseMoneyToCents, today } from "../lib/format";
import ClassPicker, { picksToSend } from "./ClassPicker";
import type {
  ClassPick,
  Classification,
  Goal,
  Account,
  Category,
  CommonTransaction,
  NewSplit,
  Payee,
  RegisterRow,
} from "../lib/types";

export interface TransactionDraft {
  id: string | null; // null = a new transaction
  date: string; // ISO yyyy-mm-dd
  payee: string;
  category_id: string | null;
  amount_cents: number;
  notes: string | null;
  /** Money's Num column. "" is sent as null by the backend's trim. */
  check_number: string | null;
  /** null = leave splits untouched; [] = clear them; rows = replace them. */
  splits: NewSplit[] | null;
  /** Set when the user picked "Transfer : <Account>" — the save becomes a
   *  create_transfer instead of an ordinary transaction. */
  transfer_to_account_id: string | null;
  /** §164 — an EXISTING row whose transfer-ness the edit changes: a plain
   *  row given "Transfer : <Account>" becomes one (the partner row is
   *  written), or a transfer given a category stops being one (the partner
   *  goes). Undefined when nothing about that changed. */
  convert?: "to_transfer" | "from_transfer";
  /** The savings goal this row counts toward (§46); undefined = leave as is. */
  goal_id?: string | null;
  /** §112: the row's classification values, one per axis. undefined = leave
   *  as they are; an entry with an empty `value_id` clears that axis. */
  classes?: ClassPick[];
}

interface Props {
  /** The row being edited; omit for a new transaction. */
  row?: RegisterRow | null;
  categories: readonly Category[];
  onCommit: (draft: TransactionDraft) => void | Promise<void>;
  onCancel: () => void;
  busy?: boolean;
  /** Existing split lines for this transaction, if any. */
  initialSplits?: readonly NewSplit[];
  /** Other accounts, offered as "Transfer : <Account>" categories. */
  transferTargets?: readonly Account[];
  /** Known payees, for name completion and category recall (§6.1b). */
  payees?: readonly Payee[];
  /** Create a category mid-entry. Resolves to the id to select. Omit to hide
   *  the "+ Add …" option in the category field. */
  onCreateCategory?: (draft: NewCategoryDraft) => Promise<string>;
  /** Saved entry templates, most-used first (§31). */
  commonTransactions?: readonly CommonTransaction[];
  /** Save the current form as a named template. */
  onSaveCommon?: (name: string, draft: TransactionDraft) => Promise<void>;
  /** Note that a template was used, so the menu can order by it. */
  onUseCommon?: (id: string) => void;
  /** Remove a saved template. Omit to hide the remove buttons. */
  onDeleteCommon?: (id: string) => Promise<void>;
  /** The investment register has one more column (§41); a cash entry in
   *  that register pads to fit. */
  columns?: number;
  /** §120: what the two amount boxes are called here. A loan says Increase /
   *  Decrease, because nobody deposits money into a mortgage. */
  columnLabels?: { payment: string; deposit: string };
  /** Goals that watch THIS account, or that a transfer from here can reach
   *  (§46). Empty hides the field. */
  goals?: readonly Goal[];
  /** §61: a Num to start a NEW transaction with (the check after the last
   *  one, offered only while checks are being written). */
  suggestedCheckNumber?: string | null;
  /** §61: what "+" in the Num field fills in — the next check number. */
  nextCheckNumber?: string | null;
  /** §69: the C cell of an open row toggles its cleared mark, so a
   *  transaction can be cleared while it is being looked at. */
  onToggleCleared?: () => void;
  /** §71: a new transaction starts on this date (the last one entered),
   *  not today — a stack of receipts is entered in date order. */
  defaultDate?: string | null;
  /** §73: the register calls this before moving to another row. It saves
   *  the form when something changed ("saved"), does nothing when nothing
   *  did ("clean"), or refuses to leave a form that cannot be saved
   *  ("failed" — the error is shown on the form). */
  leaveRef?: React.MutableRefObject<(() => Promise<LeaveResult>) | null>;
  /** §112: the file's classification axes. Empty hides the pickers, so a
   *  file that never made one sees no new field. */
  classifications?: readonly Classification[];
  /** §91: a new row started from the investment register's Activity list —
   *  Contribution, Fee, Withdrawal — arrives with its payee and category
   *  already filled in, so the only thing left to type is the amount. */
  preset?: { payee: string; categoryId: string | null; side?: "deposit" | "payment" } | null;
  /** §161: called after Enter — the key or the button — has saved the row.
   *  The register uses it on a NEW transaction to open the next one, the way
   *  Money's register moves to the next entry line; a save that happened
   *  because the user clicked elsewhere (§73) does not call it. */
  onEntered?: () => void;
  /** §170: an attachment was added or removed on this row, so the register
   *  can refresh its 📎 count. */
  onAttachmentsChanged?: () => void;
}

export type LeaveResult = "saved" | "clean" | "failed";

const COLUMNS = 9;

/** Seed the form from an existing row, or blank for a new transaction. */
/** Every field the form owns. Declared explicitly, not inferred: the category
 *  was once missing from this shape and nothing complained (§15).
 *  Add a field to the form, and this type makes you seed it. */
interface FormSeed {
  checkNumber: string;
  date: string;
  payee: string;
  payment: string;
  deposit: string;
  notes: string;
  categoryId: string;
}

function seed(
  row?: RegisterRow | null,
  suggestedCheckNumber: string | null = null,
  defaultDate: string | null = null,
  preset: { payee: string; categoryId: string | null; side?: "deposit" | "payment" } | null = null
): FormSeed {
  if (!row) {
    return {
      checkNumber: suggestedCheckNumber ?? "",
      date: defaultDate ?? today(),
      payee: preset?.payee ?? "",
      payment: "",
      deposit: "",
      notes: "",
      categoryId: preset?.categoryId ?? "",
    };
  }
  const isPayment = row.amount_cents < 0;
  return {
    checkNumber: row.check_number ?? "",
    date: row.date,
    payee: row.payee,
    payment: isPayment ? formatAmountBare(row.amount_cents) : "",
    deposit: row.amount_cents > 0 ? formatAmountBare(row.amount_cents) : "",
    notes: row.notes ?? "",
    // Was omitted entirely, so `categoryId` always started empty. Re-opening a
    // transaction showed "(none)" however it was filed, and committing that
    // edit wrote NULL back over the real category.
    // A transfer has no category; its "category" IS the other account, and
    // that is how Money presents it, so seed the combo with the transfer
    // entry (§20). Without this the field opened blank and an edit would
    // have re-pointed the transfer at nothing.
    categoryId: row.transfer_account_id
      ? `transfer:${row.transfer_account_id}`
      : (row.category_id ?? ""),
  };
}

export default function TransactionEditRow({
  row = null,
  categories,
  onCommit,
  onCancel,
  busy = false,
  initialSplits = [],
  transferTargets = [],
  payees = [],
  onCreateCategory,
  commonTransactions = [],
  onSaveCommon,
  onUseCommon,
  onDeleteCommon,
  columns = COLUMNS,
  columnLabels = { payment: "Payment", deposit: "Deposit" },
  goals = [],
  suggestedCheckNumber = null,
  nextCheckNumber = null,
  onToggleCleared,
  defaultDate = null,
  leaveRef,
  preset = null,
  classifications = [],
  onEntered,
  onAttachmentsChanged,
}: Props) {
  const initial = seed(row, suggestedCheckNumber, defaultDate, preset);

  // §123 — where the caret starts.
  //
  // A NEW entry starts in the Date, as Money's register does: the date is the
  // one field on a new row that is a guess (today, or the last one entered),
  // so it is the one you are most likely to change, and typing straight past
  // it with Tab is cheaper than reaching back for it with the mouse. An
  // EXISTING row opens in the Payee — you came to that row to change what is
  // in it, and its date is already right.
  //
  // Clicking into the Payment or Deposit column to start a row still wins
  // over both: that click said which field you meant.
  const startIn: "payment" | "deposit" | "date" | "payee" =
    preset?.side === "payment" ? "payment" : preset?.side === "deposit" ? "deposit" : row ? "payee" : "date";
  const [goalId, setGoalId] = useState<string>(row?.goal_id ?? "");
  // §112: what this row is FOR, one value per axis. A new row starts unset.
  const [classes, setClasses] = useState<ClassPick[]>(row?.classes ? [...row.classes] : []);
  // Money's picker is grouped Income / Expense and shows the full
  // "Parent : Child" name (§6.1e, migration 0014). Transfers share the field,
  // because that is how Money enters one (§10.2 item 5).
  const categoryItems: ComboItem[] = [
    ...categories
      .filter((c) => c.kind === "income")
      .map((c) => ({ value: c.id, label: c.full_name, group: "Income" })),
    ...categories
      .filter((c) => c.kind === "expense")
      .map((c) => ({ value: c.id, label: c.full_name, group: "Expense" })),
    ...transferTargets.map((a) => ({
      value: `transfer:${a.id}`,
      label: `Transfer : ${a.name}`,
      group: "Transfer",
    })),
  ];
  // The Common Transactions menu: null = closed, "" = open, "save" = naming.
  const [commonMenu, setCommonMenu] = useState<null | "list" | "save">(null);
  const [commonName, setCommonName] = useState("");
  // §183 — a template that failed to save or remove says so inside the menu,
  // which is where the user is looking. It was `void`ed and vanished.
  const [commonError, setCommonError] = useState<string | null>(null);
  const commonBtnRef = useRef<HTMLButtonElement>(null);
  const [commonRect, setCommonRect] = useState<DOMRect | null>(null);

  // The menu is portaled to <body> and positioned from the button's viewport
  // rect, for the same reason the category list is (§19.1): this button strip
  // is a row of the register table, which lives inside an `overflow-auto`
  // wrapper with a 52vh cap. An absolutely positioned menu here is CLIPPED by
  // that wrapper — and clipped in the way that hides the bug, since a short
  // list fits inside the visible area and a full one does not.
  useLayoutEffect(() => {
    if (commonMenu === null) return;
    const measure = () => setCommonRect(commonBtnRef.current?.getBoundingClientRect() ?? null);
    measure();
    // Capturing, so the menu follows the register scrolling underneath it.
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [commonMenu]);

  /** Above the button by default — the strip sits low in the register — and
   *  below it when there is no room above. */
  const commonMenuStyle: React.CSSProperties = commonRect
    ? commonRect.top > 240
      ? { left: commonRect.left, bottom: window.innerHeight - commonRect.top + 2 }
      : { left: commonRect.left, top: commonRect.bottom + 2 }
    : { left: -9999, top: -9999 };
  const [checkNumber, setCheckNumber] = useState(initial.checkNumber);
  const [date, setDate] = useState(initial.date);
  const [payee, setPayee] = useState(initial.payee);
  const [payment, setPayment] = useState(initial.payment);
  const [deposit, setDeposit] = useState(initial.deposit);
  const [categoryId, setCategoryId] = useState<string>(initial.categoryId);
  const [notes, setNotes] = useState(initial.notes);
  const [error, setError] = useState<string | null>(null);
  const [showSplit, setShowSplit] = useState(false);
  // §170 — the files attached to this row. Only a SAVED row has an id to
  // attach to; a new entry's button says so and stays disabled.
  const [showAttachments, setShowAttachments] = useState(false);
  const [attachmentCount, setAttachmentCount] = useState<number | null>(row?.attachment_count ?? null);
  // §160 — where the caret goes when the split dialog closes. The dialog
  // unmounts with the button that had focus, and a keydown on <body> never
  // reaches this row's handlers, which is why Enter did nothing after Done.
  // The Memo is the field after Category, which a split has just replaced.
  const memoRef = useRef<HTMLInputElement>(null);
  const returnFocus = useRef(false);
  useEffect(() => {
    if (showSplit || !returnFocus.current) return;
    returnFocus.current = false;
    memoRef.current?.focus();
  }, [showSplit]);
  // The mid-entry "add a category" wizard.
  const [addingCategory, setAddingCategory] = useState<string | null>(null);
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [splits, setSplits] = useState<NewSplit[] | null>(
    initialSplits.length ? [...initialSplits] : null
  );
  const isSplit = (splits?.length ?? 0) > 0;
  // §181 — the far row of a split payment's transfer line (§94): the
  // principal row in the loan register. Its amount, date and category are
  // the payment's line, and `update_transaction` refuses a change to any of
  // them (§178). The refusal used to be the first the user heard of it, after
  // typing a new amount into a form that then would not close; now the form
  // says so up front and does not offer those fields. Payee, Num and memo
  // stay editable — the backend allows them. The refusal stays as the net.
  const farRow = row?.is_split_transfer === true;
  const farTitle = farRow
    ? `Set by the payment in ${row?.split_payment_account_name ?? "another account"} — change it there`
    : undefined;
  // Money expresses a transfer through the Category field: you pick
  // "Transfer : <Account>" and it writes the paired row for you.
  const TRANSFER_PREFIX = "transfer:";
  const transferToAccountId = categoryId.startsWith(TRANSFER_PREFIX)
    ? categoryId.slice(TRANSFER_PREFIX.length)
    : null;

  /** Money offers a known payee's last category when you re-enter it (§6.1b).
   *  Only ever fills a category the user has not chosen, and only on a NEW
   *  transaction — silently re-filing something they are editing would be a
   *  surprise, and this is a suggestion, not a rule. */
  function recallCategoryFor(name: string) {
    if (row) return;
    const match = payees.find(
      (p) => p.name.toLowerCase() === name.trim().toLowerCase()
    );
    if (!match) return;

    // Never overwrite a value the user has already chosen. Recall is a
    // suggestion for an empty field, not a correction of a deliberate one.
    // (Consequence: changing the payee afterwards does not re-suggest. That
    // needs tracking whether the value was auto-filled; not worth the state
    // until somebody asks for it.)
    if (categoryId === "" && match.last_category_id) {
      setCategoryId(match.last_category_id);
    }

    // Money offers the last AMOUNT too, and it is half of why entry there
    // feels fast — most payees are the same figure every month (§17.4).
    // The sign decides the column: a payment goes in Payment, a deposit in
    // Deposit, which is how the user reads it back.
    if (payment === "" && deposit === "" && match.last_amount_cents != null) {
      const cents = match.last_amount_cents;
      if (cents < 0) setPayment(formatAmountBare(cents));
      else if (cents > 0) setDeposit(formatAmountBare(cents));
    }
  }

  /** Money keeps Payment and Deposit as separate fields; the backend stores a
   *  single signed amount. Payment wins if somebody fills in both. */
  function resolveAmountCents(): number | null {
    const p = payment.trim() ? parseMoneyToCents(payment) : null;
    const d = deposit.trim() ? parseMoneyToCents(deposit) : null;
    if (p !== null) return -Math.abs(p);
    if (d !== null) return Math.abs(d);
    return null;
  }

  // §183 — the save in progress, if one is. Enter by key was never
  // disabled the way the button is, so two quick presses (or a press and a
  // click elsewhere, §73) wrote the same new transaction twice. A second
  // request while one is out waits for that one instead of sending another.
  const inFlight = useRef<Promise<boolean> | null>(null);

  function commit(): Promise<boolean> {
    if (inFlight.current) return inFlight.current;
    const saving = save().finally(() => {
      inFlight.current = null;
    });
    inFlight.current = saving;
    return saving;
  }

  async function save(): Promise<boolean> {
    // §183 — DateField sends "" for a date it cannot read, rather than the
    // last one that parsed on the way.
    if (!date) {
      setError("Type a date the form can read, such as 8/3/2026.");
      return false;
    }
    const cents = resolveAmountCents();
    if (cents === null) {
      setError("Enter a Payment or a Deposit amount.");
      return false;
    }
    if (!payee.trim() && transferToAccountId === null) {
      setError("Enter a payee.");
      return false;
    }
    // The split lines ARE the amount. `set_splits` refuses lines that do not
    // sum to the parent, and it runs AFTER the parent is written — so a
    // mismatch used to leave the transaction saved at one amount and the
    // splits at another, and a retry on the still-open form created it
    // twice. Catch it here, before anything is written.
    if (isSplit) {
      const total = splits!.reduce((sum, l) => sum + l.amount_cents, 0);
      if (total !== cents) {
        setError(
          `The split lines total ${formatAmountBare(total)} but the amount is ${formatAmountBare(cents)}. Open the split to change the total.`
        );
        return false;
      }
    }
    // Editing a transfer is allowed (§20) — both halves move together. §164:
    // so is turning an ordinary transaction INTO a transfer, or a transfer
    // back into one. §20.2 refused that as "a different pair of rows", and
    // it is — but an imported row that the bank called a transfer arrives as
    // an ordinary one, and delete-and-re-enter threw away its cleared mark
    // and everything typed on it. The register writes (or removes) the
    // partner row before the ordinary edit runs.
    let convert: TransactionDraft["convert"];
    if (row) {
      const wasTransfer = row.transfer_account_id !== null;
      const isTransfer = transferToAccountId !== null;
      if (!wasTransfer && isTransfer) convert = "to_transfer";
      else if (wasTransfer && !isTransfer) convert = "from_transfer";
    }
    setError(null);
    try {
      // Awaited so a backend rejection surfaces here. Previously this was
      // fire-and-forget, so a failed save looked like the Enter key doing
      // nothing at all.
      await onCommit({
        id: row?.id ?? null,
        date,
        payee: payee.trim(),
        category_id:
          categoryId === "" || transferToAccountId !== null ? null : categoryId,
        amount_cents: cents,
        notes: notes.trim() === "" ? null : notes.trim(),
        check_number: checkNumber.trim() === "" ? null : checkNumber.trim(),
        splits,
        transfer_to_account_id: transferToAccountId,
        convert,
        goal_id: goals.length > 0 ? (goalId || null) : undefined,
        // Every axis is sent, so clearing one clears it rather than leaving
        // the old value in place.
        classes: classifications.length > 0 ? picksToSend(classifications, classes) : undefined,
      });
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    }
  }

  // §73: what the form looked like when it opened, to know whether leaving
  // it should save. A new form with nothing typed is not worth saving.
  const snapshot = () => JSON.stringify([checkNumber, date, payee, payment, deposit, categoryId, notes, goalId, splits, [...classes].sort((a, b) => a.classification_id.localeCompare(b.classification_id)).map((c) => `${c.classification_id}:${c.value_id}`)]);
  const opened = useRef<string | null>(null);
  if (opened.current === null) opened.current = snapshot();
  const dirty = snapshot() !== opened.current || (row === null && (payee.trim() !== "" || payment.trim() !== "" || deposit.trim() !== ""));
  useLayoutEffect(() => {
    if (!leaveRef) return;
    leaveRef.current = async () => {
      if (!dirty) return "clean";
      return (await commit()) ? "saved" : "failed";
    };
    return () => {
      if (leaveRef) leaveRef.current = null;
    };
  });

  /** Fill the form from a saved template.
   *
   *  A template is not a transaction: it carries no date and no account, so
   *  the date the user is entering under is left exactly as it is. Everything
   *  the template does define is applied, including an empty amount — a
   *  template with no fixed amount deliberately leaves those fields alone
   *  rather than zeroing them. */
  function applyCommon(t: CommonTransaction) {
    setPayee(t.payee);
    setCategoryId(t.category_id ?? "");
    setCheckNumber(t.check_number ?? "");
    setNotes(t.notes ?? "");
    if (t.amount_cents != null) {
      const bare = formatAmountBare(t.amount_cents);
      setPayment(t.amount_cents < 0 ? bare : "");
      setDeposit(t.amount_cents > 0 ? bare : "");
    }
    setSplits(t.splits.length ? t.splits.map((l) => ({ ...l })) : null);
    setCommonMenu(null);
    onUseCommon?.(t.id);
  }

  // §183 — a template has a category or split lines, and no account to send
  // money to (`NewCommonTransaction` has no transfer field). A transfer saved
  // as one came back with a blank category — an ordinary payment to nobody.
  const TRANSFER_TEMPLATE_REFUSAL =
    "A transfer can't be saved as a common transaction — a template has no account to transfer to. Choose a category, or enter the transfer as it is.";

  /** Save what is on screen as a named template. */
  async function saveCommon() {
    const name = commonName.trim();
    if (!name || !onSaveCommon) return;
    if (transferToAccountId !== null) {
      setCommonError(TRANSFER_TEMPLATE_REFUSAL);
      return;
    }
    // A template may legitimately have no amount, so an empty form is not an
    // error here the way it is on Enter — it saves as "no fixed amount".
    const cents = resolveAmountCents();
    setCommonError(null);
    try {
      await onSaveCommon(name, {
        id: null,
        date,
        payee: payee.trim(),
        category_id: categoryId === "" ? null : categoryId,
        amount_cents: cents ?? 0,
        notes: notes.trim() === "" ? null : notes.trim(),
        check_number: checkNumber.trim() === "" ? null : checkNumber.trim(),
        splits,
        transfer_to_account_id: null,
      });
    } catch (e) {
      setCommonError(String(e));
      return;
    }
    setCommonName("");
    setCommonMenu(null);
  }

  async function deleteCommon(id: string) {
    if (!onDeleteCommon) return;
    setCommonError(null);
    try {
      await onDeleteCommon(id);
    } catch (e) {
      setCommonError(String(e));
    }
  }

  /** §161 — Enter, by key or by button: save, and if it saved, tell the
   *  register so a new entry can open the next line. */
  function enter() {
    // §183 — a press while the save is still out is the same Enter; it must
    // not open the next line twice either.
    if (inFlight.current) return;
    void commit().then((ok) => {
      if (ok) onEntered?.();
    });
  }

  /** Enter commits, Escape cancels — Money's Enter is the default button. */
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      enter();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  }

  return (
    <>
      {/* 1 — the grid row, edited in its own columns */}
      <tr className="active" onKeyDown={onKeyDown}>
        <td />
        <td />
        <td>
          {/* Money's Num column: free text, and FIRST in the tab order —
              a check is written before it is recorded. The column has
              existed since migration 0011; this field is what finally
              writes it. */}
          <input
            className="aero-field w-full"
            aria-label="Num"
            placeholder="Number"
            autoComplete="off"
            value={checkNumber}
            onChange={(e) => setCheckNumber(e.target.value)}
            // Money's shortcut: "+" fills in the next check number.
            onKeyDown={(e) => {
              if (e.key === "+" && nextCheckNumber) {
                e.preventDefault();
                setCheckNumber(nextCheckNumber);
              }
            }}
            // A transfer's two rows are written by the backend and carry no
            // Num or Payee of their own; a change typed here was saved
            // "successfully" and then not there.
            readOnly={transferToAccountId !== null}
            title={transferToAccountId !== null ? "Not used on a transfer" : nextCheckNumber ? `Type + for the next check number (${nextCheckNumber})` : undefined}
          />
        </td>
        <td>
          <DateField value={date} onChange={setDate} autoFocus={startIn === "date"} readOnly={farRow} title={farTitle} />
        </td>
        <td>
          <PayeeField
            value={payee}
            onChange={(v) => {
              setPayee(v);
              // Recall runs as the name is typed as well as when it settles,
              // so an exact name typed in full fills the category at once.
              recallCategoryFor(v);
            }}
            onSettle={recallCategoryFor}
            payees={payees}
            placeholder={transferToAccountId !== null ? "Transfer Money" : "Payee"}
            readOnly={transferToAccountId !== null}
            title={transferToAccountId !== null ? "A transfer's payee is the other account" : undefined}
            autoFocus={startIn === "payee"}
          />
        </td>
        <td className="mid">
          {row && onToggleCleared ? (
            <button
              type="button"
              className="tm-clear-toggle"
              aria-label={row.cleared_state ? "Unclear this transaction" : "Clear this transaction"}
              title={row.cleared_state ? "Cleared — click to unclear (Ctrl+M)" : "Click to mark cleared (Ctrl+M)"}
              onClick={onToggleCleared}
            >
              {row.cleared_state || "·"}
            </button>
          ) : (
            row?.cleared_state ?? ""
          )}
        </td>
        <td>
          <input
            className="aero-field w-full text-right"
            aria-label={columnLabels.payment}
            autoFocus={startIn === "payment"}
            value={payment}
            onChange={(e) => {
              setPayment(e.target.value);
              if (e.target.value) setDeposit("");
            }}
            placeholder={columnLabels.payment}
            readOnly={isSplit || farRow}
            title={farTitle ?? (isSplit ? "Set by the split lines — open the split to change it" : undefined)}
          />
        </td>
        <td>
          <input
            className="aero-field w-full text-right"
            aria-label={columnLabels.deposit}
            autoFocus={startIn === "deposit"}
            value={deposit}
            onChange={(e) => {
              setDeposit(e.target.value);
              if (e.target.value) setPayment("");
            }}
            placeholder={columnLabels.deposit}
            readOnly={isSplit || farRow}
            title={farTitle ?? (isSplit ? "Set by the split lines — open the split to change it" : undefined)}
          />
        </td>
        <td />
        {columns > COLUMNS && <td />}
      </tr>

      {/* 2 — the fields the grid does not show */}
      <tr className="active" onKeyDown={onKeyDown}>
        <td colSpan={columns}>
          {/* §181 — a refused save says so here, above the fields, in red,
              and the form stays open with what was typed. It was a short
              span in the button strip, easy to miss beside four buttons —
              "prevents edit but no warning or message". */}
          {error && (
            <Notice tone="error" boxed>
              {error}
            </Notice>
          )}
          {farRow && (
            <Notice boxed>
              The amount, date and category belong to the payment in{" "}
              <strong>{row?.split_payment_account_name ?? "another account"}</strong> — change them there. The
              payee, Num and memo can be changed here.
            </Notice>
          )}
          <div className="flex items-center gap-2 py-1">
            <label htmlFor="txn-category" className="text-right" style={{ width: 90 }}>
              Category:
            </label>
            {isSplit ? (
              // A split transaction has no single category — Money shows the
              // field as "Split" and sends you to the dialog to change it.
              <button
                type="button"
                className="aero-field text-left"
                style={{ minWidth: 260 }}
                onClick={() => setShowSplit(true)}
              >
                Split ({splits!.length} categories)
              </button>
            ) : (
              <CategoryCombo
                id="txn-category"
                label="Category:"
                items={categoryItems}
                value={categoryId}
                style={{ minWidth: 260 }}
                disabled={farRow}
                onChange={(next) => {
                  setCategoryId(next);
                  if (next.startsWith(TRANSFER_PREFIX) && !payee.trim()) {
                    setPayee("Transfer Money");
                  }
                }}
                onAddNew={
                  onCreateCategory
                    ? (q) => {
                        setAddError(null);
                        setAddingCategory(q);
                      }
                    : undefined
                }
              />
            )}
          </div>
          <div className="flex items-center gap-2 pb-1">
            <label htmlFor="txn-memo" className="text-right" style={{ width: 90 }}>
              Memo:
            </label>
            <input
              id="txn-memo"
              ref={memoRef}
              className="aero-field"
              style={{ minWidth: 400 }}
              placeholder="Memo"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
            <ClassPicker
              classifications={classifications}
              value={classes}
              onChange={setClasses}
              idPrefix="txn-class"
            />
            {/* §117.3 — this field is the TRANSACTION's value. On a split
                whose lines carry their own, an empty field here means "the
                lines answer for themselves", not "not classified", and the
                difference is invisible unless it is written down. */}
            {isSplit && (row?.line_classes ?? []).some((c) => c.label) && (
              <span className="tm-text-muted">
                (the split lines carry{" "}
                {(row?.line_classes ?? [])
                  .filter((c) => c.label)
                  .map((c) => c.label)
                  .join(", ")}
                {" "}— open Split to change)
              </span>
            )}
            {goals.length > 0 && (
              <>
                <label htmlFor="txn-goal">For goal:</label>
                <select id="txn-goal" className="aero-field" value={goalId} onChange={(e) => setGoalId(e.target.value)} title="Counts this row toward a savings goal that watches the account it lands in">
                  <option value="">(none)</option>
                  {goals.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                      {g.account_name ? ` — ${g.account_name}` : ""}
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>
        </td>
      </tr>

      {/* 3 — the button strip */}
      <tr className="active">
        <td colSpan={columns}>
          <div className="flex items-center gap-2 py-1">
            <button
              ref={commonBtnRef}
              className="aero-btn"
              type="button"
              aria-haspopup="menu"
              aria-expanded={commonMenu !== null}
              onClick={() => {
                setCommonError(null);
                setCommonMenu(commonMenu === null ? "list" : null);
              }}
            >
              Common Transactions ▾
            </button>
            {commonMenu !== null &&
              createPortal(
                <>
                {/* Click anywhere else to dismiss, as a menu should. */}
                  <div
                    className="fixed inset-0 z-10"
                    onMouseDown={() => setCommonMenu(null)}
                  />
                  <ul
                    className="tm-common-menu"
                    role="menu"
                    aria-label="Common transactions"
                    style={commonMenuStyle}
                  >
                  {commonError && (
                    <li>
                      <Notice tone="error" boxed>
                        {commonError}
                      </Notice>
                    </li>
                  )}
                  {commonTransactions.length === 0 && commonMenu === "list" && (
                    <li className="tm-common-empty">
                      Nothing saved yet — fill the form, then “Save this one…”.
                    </li>
                  )}
                  {commonMenu === "list" &&
                    commonTransactions.map((t) => (
                      <li key={t.id} className="tm-common-row">
                        <button
                          type="button"
                          role="menuitem"
                          className="tm-common-item"
                          onClick={() => applyCommon(t)}
                        >
                          <span className="tm-common-name">{t.name}</span>
                          <span className="tm-common-detail">
                            {[
                              t.payee || null,
                              t.splits.length
                                ? `${t.splits.length} split lines`
                                : t.category_name,
                              t.amount_cents == null
                                ? "no fixed amount"
                                : formatAmountBare(t.amount_cents),
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        </button>
                        {onDeleteCommon && (
                          <button
                            type="button"
                            className="tm-common-remove"
                            aria-label={`Remove ${t.name}`}
                            title="Remove this common transaction"
                            onClick={() => void deleteCommon(t.id)}
                          >
                            ×
                          </button>
                        )}
                      </li>
                    ))}
                  {onSaveCommon && commonMenu === "list" && (
                    <li>
                      <button
                        type="button"
                        role="menuitem"
                        className="tm-common-item tm-common-save"
                        onClick={() => {
                          // Said before a name is typed, not after.
                          if (transferToAccountId !== null) {
                            setCommonError(TRANSFER_TEMPLATE_REFUSAL);
                            return;
                          }
                          setCommonError(null);
                          setCommonMenu("save");
                        }}
                      >
                        Save this one…
                      </button>
                    </li>
                  )}
                  {commonMenu === "save" && (
                    <li className="tm-common-saverow">
                      <input
                        className="aero-field"
                        aria-label="Common transaction name"
                        placeholder="Name it, e.g. Rent"
                        autoFocus
                        value={commonName}
                        onChange={(e) => setCommonName(e.target.value)}
                        onKeyDown={(e) => {
                          // The strip's Enter commits the TRANSACTION; this
                          // input must not let that through.
                          e.stopPropagation();
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void saveCommon();
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            setCommonError(null);
                            setCommonMenu(null);
                          }
                        }}
                      />
                      <button
                        className="aero-btn"
                        type="button"
                        disabled={!commonName.trim()}
                        onClick={() => void saveCommon()}
                      >
                        Save
                      </button>
                    </li>
                  )}
                  </ul>
                </>,
                document.body
              )}
            <span className="flex-1" />
            <button className="aero-btn default" type="button" onClick={enter} disabled={busy}>
              Enter
            </button>
            <button
              className="aero-btn"
              type="button"
              onClick={() => setShowSplit(true)}
              disabled={farRow}
              title={farRow ? farTitle : undefined}
            >
              Split
            </button>
            <button
              className="aero-btn"
              type="button"
              disabled={!row}
              title={row ? "Receipts, statements, photos attached to this transaction" : "Enter the transaction first, then attach files to it"}
              onClick={() => setShowAttachments(true)}
            >
              Attachments{attachmentCount ? ` (${attachmentCount})` : ""}
            </button>
            <button className="aero-btn" type="button" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </td>
      </tr>

      {addingCategory !== null && onCreateCategory && (
        <NewCategoryDialog
          initialName={addingCategory}
          categories={categories}
          busy={addBusy}
          error={addError}
          onCancel={() => {
            setAddingCategory(null);
            setAddError(null);
          }}
          onCreate={async (draft) => {
            setAddBusy(true);
            setAddError(null);
            try {
              // Resolves to the id to select — the subcategory when one was
              // added, otherwise the category itself.
              setCategoryId(await onCreateCategory(draft));
              setAddingCategory(null);
            } catch (e) {
              setAddError(String(e));
            } finally {
              setAddBusy(false);
            }
          }}
        />
      )}

      {showAttachments && row && (
        <tr>
          <td colSpan={columns}>
            <div className="tm-dialog-backdrop" onClick={() => setShowAttachments(false)} />
            <div
              className="tm-dialog"
              role="dialog"
              aria-label="Attachments"
              style={{ minWidth: 560 }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setShowAttachments(false);
                }
              }}
            >
              <div className="tm-dialog-title">Attachments — {row.payee}</div>
              <div className="tm-dialog-body">
                <AttachmentsPanel
                  transactionId={row.id}
                  onChanged={(n) => {
                    setAttachmentCount(n);
                    onAttachmentsChanged?.();
                  }}
                />
                <div className="flex justify-end pt-3">
                  <button className="aero-btn default" type="button" onClick={() => setShowAttachments(false)}>
                    Close
                  </button>
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}

      {showSplit && (
        <tr>
          <td colSpan={columns}>
            <div
              className="tm-dialog-backdrop"
              onClick={() => {
                returnFocus.current = true;
                setShowSplit(false);
              }}
            />
            <SplitDialog
              categories={categories}
              classifications={classifications}
              parentClasses={classes}
              // §102 — the same accounts the Category field offers, so a
              // split line can be a transfer exactly as a whole transaction
              // can. `transferTargets` already excludes this account.
              transferTargets={transferTargets}
              parentAmountCents={resolveAmountCents()}
              reconciled={row?.is_reconciled ?? false}
              initialSplits={splits ?? []}
              onCancel={() => {
                returnFocus.current = true;
                setShowSplit(false);
              }}
              onDone={(lines, totalCents) => {
                setSplits(lines);
                returnFocus.current = true;
                setShowSplit(false);
                // The split total IS the transaction amount (§6.1e).
                if (totalCents < 0) {
                  setPayment(formatAmountBare(totalCents));
                  setDeposit("");
                } else if (totalCents > 0) {
                  setDeposit(formatAmountBare(totalCents));
                  setPayment("");
                }
                setCategoryId("");
              }}
            />
          </td>
        </tr>
      )}
    </>
  );
}
