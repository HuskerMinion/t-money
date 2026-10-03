// Account Register — Money's "Account register" page for one account.
//
// Rebuilt 2026-08-30 against reference/ms-money-02-account-register.png. The
// previous version was written from memory and had the wrong column model
// (a single signed Amount column, a Category column Money does not show, and
// an invented totals footer).
//
// The grid itself lives in RegisterGrid so the reconcile clearing view
// and the split dialog can reuse it rather than growing a second grid.
import { useEffect, useRef, useState } from "react";
import RegisterGrid, { type RegisterGroup } from "./RegisterGrid";
import { categoryKey } from "./CategoryCombo";
import FindInRegisterDialog from "./FindInRegisterDialog";
import TransactionEditRow, { type TransactionDraft } from "./TransactionEditRow";
import InvestmentEditRow, { type ShareTransferDraft } from "./InvestmentEditRow";
import UpdateHoldingsDialog from "./UpdateHoldingsDialog";
import UpdateValueDialog from "./UpdateValueDialog";
import LoanTermsDialog from "./LoanTermsDialog";
import RecordPaymentDialog from "./RecordPaymentDialog";
import TaxLinePicker from "./TaxLinePicker";
import TmIcon from "./TmIcon";
import Notice from "./Notice";
import DateField from "./DateField";
import ReconcileDialog, { type ReconcileStage, type StatementDraft } from "./ReconcileDialog";
import DuplicatesDialog from "./DuplicatesDialog";
import { adjustmentForDifference, autoReconcile, reconcileDifferenceCents } from "../lib/reconcile";
import { useAccountStore } from "../stores/useAccountStore";
import { formatDateUS, formatMoney, today } from "../lib/format";
import { currencyOf } from "../lib/currency";
import { save } from "@tauri-apps/plugin-dialog";
import { registerCsv } from "../lib/registerCsv";
import {
  applyRegisterView,
  balanceIsMeaningful,
  DATES_OPTIONS,
  DEFAULT_VIEW,
  describeView,
  nextSort,
  SHOW_OPTIONS,
  SORT_OPTIONS,
  type RegisterDates,
  type RegisterShow,
  type RegisterSort,
} from "../lib/registerView";
import { cashActivity as cashActivityFor } from "../lib/shares";
import { useCommand } from "../lib/useCommand";
import { isAmortizable, isValuedAsset, pickableAccounts, registerColumnLabels } from "../lib/accountTypes";
import { api } from "../lib/ipc";
import { samePicks } from "./ClassPicker";
import { noteChanged } from "../lib/undo";
import type { Classification, ClearedState, CommonTransaction, Goal, NewInvestmentTransaction, NewSplit, Security, Statement } from "../lib/types";
import { keys } from "../lib/keys";

/** Money's register views. `view` is the Show
 *  half; dates and sort ride alongside in `viewOpts`. Reconcile drives the
 *  grouped one. */
export type RegisterView = RegisterShow;

/** Fill the viewport with empty rows, as Money does. */
const MIN_ROWS = 24;

export default function AccountRegister() {
  const selectedAccountId = useAccountStore((s) => s.selectedAccountId);
  const accounts = useAccountStore((s) => s.accounts);
  const register = useAccountStore((s) => s.register);
  const registerLoading = useAccountStore((s) => s.registerLoading);
  const loadRegister = useAccountStore((s) => s.loadRegister);
  const categories = useAccountStore((s) => s.categories);
  const loadCategories = useAccountStore((s) => s.loadCategories);
  // Payees drive name completion and the category recall in the entry form.
  const payees = useAccountStore((s) => s.payees);
  const loadPayees = useAccountStore((s) => s.loadPayees);
  const addCategory = useAccountStore((s) => s.addCategory);

  /** Create a category from inside the entry form and return the id to
   *  select. When a top-level category is created WITH a subcategory, the
   *  subcategory is what the transaction gets — filing against the parent
   *  when you just named a child is not what anyone means. */
  async function createCategoryInline(draft: {
    name: string;
    kind: "income" | "expense";
    parentId: string | null;
    childName: string | null;
  }): Promise<string> {
    const parent = await addCategory(draft.name, draft.kind, draft.parentId, null);
    if (draft.parentId === null && draft.childName) {
      const child = await addCategory(draft.childName, draft.kind, parent.id, null);
      return child.id;
    }
    return parent.id;
  }
  const addTransaction = useAccountStore((s) => s.addTransaction);
  const editTransaction = useAccountStore((s) => s.editTransaction);
  const removeTransaction = useAccountStore((s) => s.removeTransaction);

  const [view, setView] = useState<RegisterView>("all");
  const [dates, setDates] = useState<RegisterDates>(DEFAULT_VIEW.dates);
  const [sort, setSort] = useState<RegisterSort>(DEFAULT_VIEW.sort);
  const viewOpts = { show: view, dates, sort };
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [showForms, setShowForms] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addingNew, setAddingNew] = useState(false);
  // Enter on a new transaction opens the NEXT one, as Money's
  // register does: the caret lands in the Date of a fresh entry (today or
  // the last date entered — so Tab moves straight on to the Payee
  // when the date is already right), and Escape closes it. The key forces a
  // fresh form rather than the old one with its fields cleared.
  const [entrySerial, setEntrySerial] = useState(0);
  // After a check is entered the next new transaction offers the next
  // number (deletable); anything else entered in between switches it off.
  const [lastWasCheck, setLastWasCheck] = useState(false);
  // The date of the last transaction entered here; the next new one
  // starts on it (and the entry line shows it) instead of today.
  const [lastEntryDate, setLastEntryDate] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Investment accounts: New opens the investment form; "New cash
  // entry" opens the ordinary one for a contribution or a fee.
  const [newKind, setNewKind] = useState<"investment" | "cash">("investment");
  // A cash entry started from the investment Activity list arrives with
  // its payee and category already chosen.
  const [cashPreset, setCashPreset] = useState<{ payee: string; categoryId: string | null; side: "deposit" | "payment" } | null>(null);
  const [updatingHoldings, setUpdatingHoldings] = useState(false);
  // Find duplicate transactions.
  const [dupesOpen, setDupesOpen] = useState(false);
  // Find in this register — Money's Edit → Find, over the register.
  const [findOpen, setFindOpen] = useState(false);
  // "Mark reconciled through…" — the date, and how many rows it would touch.
  const [reconcileThrough, setReconcileThrough] = useState<string | null>(null);
  const [reconcileCount, setReconcileCount] = useState<number | null>(null);
  // A notice has a tone. A refusal (on a far row, say) and a failed
  // export are errors and draw red; "added to favorites" is not.
  const [notice, setNoticeState] = useState<{ text: string; tone: "info" | "error" } | null>(null);
  // A notice can carry one button: "Remember" on the offer to make a
  // rule from a category you just filed by hand. Cleared with the notice.
  const [noticeAction, setNoticeAction] = useState<{ label: string; run: () => Promise<void> | void } | null>(null);
  // Every new notice drops the old one's button. Only the dismiss
  // path cleared it, so "Saved 12 rows to…" arriving after a rule offer kept
  // a Remember button that would make a rule nobody was being asked about.
  // `offerRule` sets its button AFTER its text, so it still gets one.
  const setNotice = (text: string | null) => {
    setNoticeState(text === null ? null : { text, tone: "info" });
    setNoticeAction(null);
  };
  const setRefusal = (text: string) => {
    setNoticeState({ text, tone: "error" });
    setNoticeAction(null);
  };
  // The open form's save-on-leave hook (TransactionEditRow /
  // InvestmentEditRow set it while mounted).
  const leaveRef = useRef<(() => Promise<"saved" | "clean" | "failed">) | null>(null);

  /** Save whatever form is open before moving on. False = it could not be
   *  saved (the form shows why) and the move should not happen. */
  async function leaveOpenForm(): Promise<boolean> {
    const leave = leaveRef.current;
    if (!leave) return true;
    const r = await leave();
    return r !== "failed";
  }
  // Money's "add / remove a single transaction to a tax line": the
  // row whose tax line is being chosen.
  const [taxLineFor, setTaxLineFor] = useState<string | null>(null);
  const [securities, setSecurities] = useState<Security[]>([]);
  // Savings goals that watch an account: the ones this register's
  // rows, or a transfer out of it, can count toward.
  const [goals, setGoals] = useState<Goal[]>([]);
  const [classifications, setClassifications] = useState<Classification[]>([]);
  const [busy, setBusy] = useState(false);
  // A commit is on its way to the backend. `busy` is state: it grays
  // the Enter button on the next render, and says nothing to a commit that
  // arrives before then or by another road (a keystroke, a save-on-leave).
  const committing = useRef(false);
  // The split lines loaded for the row being edited, tagged with the
  // row they belong to and a token for this load. The lines used to be a bare
  // array, cleared only when the NEXT load answered, and the edit row was
  // keyed on their count: going straight from split A to split B with the same
  // number of lines mounted B's form holding A's lines — and Enter wrote them
  // over B's. Now the lines count only for the row they were loaded for, and
  // the form mounts once that load has answered.
  const [splitsLoad, setSplitsLoad] = useState<{ id: string; token: number; lines: NewSplit[] } | null>(null);
  const splitsToken = useRef(0);
  const editingSplits = splitsLoad && splitsLoad.id === editingId ? splitsLoad.lines : [];
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  // --- reconcile ---
  const [stage, setStage] = useState<ReconcileStage | null>(null);
  const [statement, setStatement] = useState<Statement | null>(null);
  const [lastStatement, setLastStatement] = useState<Statement | null>(null);
  const [autoHint, setAutoHint] = useState<string | null>(null);
  const [reconcileError, setReconcileError] = useState<string | null>(null);
  // Next pressed twice finished the statement once and then asked
  // again, and the second answer ("already balanced") was drawn in red over
  // a reconcile that had worked.
  const finishing = useRef(false);
  // "Mark reconciled through…" and the tax-line dialog are modal; a
  // refusal from either is drawn inside it, not in the strip behind it.
  const [throughError, setThroughError] = useState<string | null>(null);
  const [taxLineError, setTaxLineError] = useState<string | null>(null);
  // Saved entry templates, loaded once per account view.
  const [commons, setCommons] = useState<CommonTransaction[]>([]);
  const reconcileRequest = useAccountStore((s) => s.reconcileRequest);
  const ackReconcileRequest = useAccountStore((s) => s.ackReconcileRequest);
  const pendingRowId = useAccountStore((s) => s.pendingRowId);
  const focusRow = useAccountStore((s) => s.focusRow);

  // A Search result asked for a row: select it once it is on screen,
  // scroll to it, and drop the request so it cannot fire again later.
  useEffect(() => {
    if (!pendingRowId) return;
    if (!register.some((r) => r.id === pendingRowId)) return;
    setSelectedRowId(pendingRowId);
    focusRow(null);
    const el = document.querySelector(`tr[data-row-id="${pendingRowId}"]`);
    if (el && typeof (el as HTMLElement).scrollIntoView === "function") {
      (el as HTMLElement).scrollIntoView({ block: "center" });
    }
  }, [pendingRowId, register, focusRow]);

  const account = accounts.find((a) => a.id === selectedAccountId) ?? null;
  const isInvestment = account?.type === "investment" || account?.type === "retirement";
  // A house or a car is worth what it is worth; its balance is not the
  // sum of anything.
  const isAsset = !!account && isValuedAsset(account.type);
  // A mortgage's columns are Increase / Decrease, not Payment /
  // Deposit. Every other account type is untouched.
  const columnLabels = registerColumnLabels(account?.type ?? "");
  const [valuing, setValuing] = useState(false);
  // A loan's terms, and a payment split into interest, principal and escrow.
  const isLoan = !!account && isAmortizable(account.type);
  const [editingTerms, setEditingTerms] = useState(false);
  const [payingLoan, setPayingLoan] = useState(false);

  useEffect(() => {
    if (selectedAccountId) loadRegister(selectedAccountId);
    setLastWasCheck(false);
    setLastEntryDate(null);
    // A header-click sort is for the question you are asking right now —
    // what did I spend the most on, where is that check. Leaving the register
    // ends the question, so the next account opens in date order with a
    // running balance that means something, every time.
    setSort(DEFAULT_VIEW.sort);
  }, [selectedAccountId, loadRegister]);

  // The register opens at the bottom, where the newest rows and the
  // entry line are — unless a search hit asked for a particular row.
  // Also after balancing ends or the view changes: the grouped
  // clearing view giving way to the full register used to land at the top.
  const registerCount = register.length;
  const balancing = stage !== null;
  useEffect(() => {
    if (pendingRowId) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [selectedAccountId, registerCount, addingNew, pendingRowId, balancing, view]);

  async function loadSecurities() {
    try {
      setSecurities(await api.listSecurities());
    } catch {
      setSecurities([]);
    }
  }
  useEffect(() => {
    if (isInvestment) void loadSecurities();
  }, [isInvestment]);

  // The file's classification axes, for the entry form and the split
  // dialog. A file with none never sees the field.
  async function loadClassifications() {
    try {
      setClassifications(await api.listClassifications());
    } catch {
      setClassifications([]);
    }
  }
  useEffect(() => {
    void loadClassifications();
  }, []);

  async function loadGoals() {
    try {
      setGoals((await api.listGoals()).filter((g) => g.account_id !== null));
    } catch {
      setGoals([]);
    }
  }
  useEffect(() => {
    void loadGoals();
  }, [selectedAccountId]);

  /** The goals a row in this register can be tagged for: those watching
   *  this account, plus — for a transfer — those watching its other side. */
  function goalsFor(transferTo: string | null): Goal[] {
    return goals.filter((g) => g.account_id === selectedAccountId || (transferTo !== null && g.account_id === transferTo));
  }

  /** Write the row's classification values after it is saved, the way
   *  the goal and the tax line are written — one small command rather than a
   *  wider create/update payload, so an import or a scheduled entry that
   *  knows nothing about classifications is unaffected. */
  async function applyClasses(txnId: string, draft: TransactionDraft): Promise<boolean> {
    if (!draft.classes) return false;
    const before = register.find((r) => r.id === txnId)?.classes ?? [];
    if (draft.id && samePicks(before, draft.classes)) return false;
    if (!draft.id && draft.classes.every((c) => !c.value_id)) return false;
    await api.setTransactionClasses(txnId, draft.classes);
    return true;
  }

  async function applyGoal(txnId: string, draft: TransactionDraft): Promise<boolean> {
    if (draft.goal_id === undefined) return false;
    const before = register.find((r) => r.id === txnId)?.goal_id ?? null;
    if ((draft.goal_id ?? null) === before && draft.id) return false;
    if (draft.goal_id === null && before === null) return false;
    await api.setTransactionGoal(txnId, draft.goal_id);
    await loadGoals();
    return true;
  }

  /** Save an investment row (new or edited), then refresh everything the
   *  lots feed: the register, the account's holdings value, the securities'
   *  latest prices. */
  async function commitInvestment(id: string | null, t: NewInvestmentTransaction) {
    if (!selectedAccountId) return;
    setBusy(true);
    try {
      if (id) await api.updateInvestmentTransaction(id, t);
      else {
        await api.createInvestmentTransaction(t);
        setLastEntryDate(t.date);
      }
      await loadRegister(selectedAccountId);
      await useAccountStore.getState().loadAccounts();
      await loadSecurities();
      setEditingId(null);
      setAddingNew(false);
    } finally {
      setBusy(false);
    }
  }

  async function transferShares(t: ShareTransferDraft) {
    if (!selectedAccountId) return;
    setBusy(true);
    try {
      await api.createShareTransfer(t.fromAccountId, t.toAccountId, t.date, t.securityId, t.sharesMicro, t.notes, t.lotAllocations);
      await loadRegister(selectedAccountId);
      await useAccountStore.getState().loadAccounts();
      setEditingId(null);
      setAddingNew(false);
    } finally {
      setBusy(false);
    }
  }

  async function createSecurityInline(name: string): Promise<string> {
    const s = await api.createSecurity(name, "", "stock", null);
    await loadSecurities();
    return s.id;
  }

  // Categories fill the entry form's Category picker.
  useEffect(() => {
    loadCategories();
    loadPayees();
  }, [loadCategories, loadPayees]);

  // What was open when the account changed. Clicking another account in
  // the rail does not remount the register: the store swaps the account and
  // empties its rows in one step, so by the time an effect runs, the form for
  // an existing row has already unmounted (its row is gone) and a new entry's
  // form has re-rendered against the NEW account. Its save-on-leave hook is
  // caught here, during the render that sees the change and before either
  // happens, while it still holds what was typed and the account it was typed
  // for.
  const shownAccount = useRef<{ id: string | null; name: string | null }>({ id: selectedAccountId, name: null });
  const leaveOnSwitch = useRef<{ leave: () => Promise<"saved" | "clean" | "failed">; name: string | null } | null>(null);
  if (shownAccount.current.id !== selectedAccountId) {
    if (leaveRef.current && !leaveOnSwitch.current) {
      leaveOnSwitch.current = { leave: leaveRef.current, name: shownAccount.current.name };
    }
    shownAccount.current = { id: selectedAccountId, name: null };
  }
  shownAccount.current.name = accounts.find((a) => a.id === selectedAccountId)?.name ?? null;

  // Changing account closes any open form, saving it first, as a click
  // on another row does.
  useEffect(() => {
    const pending = leaveOnSwitch.current;
    leaveOnSwitch.current = null;
    // A commit already on its way is that same form being saved; asking it
    // to save again would only be refused as "still saving".
    if (pending && !committing.current) {
      void pending.leave().then((r) => {
        if (r === "failed") {
          setRefusal(
            `The transaction you were entering in ${pending.name ?? "the other account"} could not be saved, so it was not kept.`
          );
        }
      });
    }
    setEditingId(null);
    setAddingNew(false);
    // And a reconcile belongs to the account it was started on. It
    // used to survive the switch: the C clicks marked the new account's rows,
    // and "Automatically adjust" finished the OLD statement with an adjustment
    // sized from the new account's register. Leaving is Postpone once a
    // statement is under way (its cleared marks stay, the header goes, as the
    // Postpone button does) and Cancel before one is — a "resume" offer's
    // statement is not this session's to throw away.
    if (stage === "clearing" || stage === "unbalanced") void postponeReconcile();
    else if (stage !== null) leaveReconcile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAccountId]);

  useEffect(() => {
    let live = true;
    api
      .listCommonTransactions()
      .then((c) => live && setCommons(c))
      // A template menu that cannot load is not worth interrupting entry for.
      .catch(() => live && setCommons([]));
    return () => {
      live = false;
    };
  }, []);

  /** Save the form as a template, then refresh the menu so it appears at once. */
  async function saveCommon(name: string, draft: TransactionDraft) {
    await api.createCommonTransaction({
      name,
      payee: draft.payee,
      category_id: draft.category_id,
      // The form always produces a number; "no fixed amount" is expressed by
      // leaving both amount fields empty, which arrives here as 0.
      amount_cents: draft.amount_cents === 0 ? null : draft.amount_cents,
      check_number: draft.check_number,
      notes: draft.notes,
      splits: draft.splits ?? [],
    });
    setCommons(await api.listCommonTransactions());
  }

  /** Remove a saved template and refresh the menu. */
  async function deleteCommon(id: string) {
    await api.deleteCommonTransaction(id);
    setCommons(await api.listCommonTransactions());
  }

  function useCommon(id: string) {
    // Best-effort ordering hint; never worth failing an entry over.
    void api.touchCommonTransaction(id).catch(() => {});
  }

  // The "Reconcile" rail item raises a one-shot request the register acts on.
  //
  // It MUST be consumed. `reconcileRequest` used to be a counter that was only
  // ever incremented, and this effect — like every effect — also runs on
  // mount. So once the rail item had been clicked even once, the value stayed
  // above zero forever and the wizard reopened on every remount of this
  // component: switching Banking → Bills → Banking, or picking an account
  // after visiting another rail item. Reported as "clicking between the bills
  // and banking tab triggered the reconcile dialog".
  useEffect(() => {
    if (reconcileRequest === 0) return;
    // Consume it either way. An unconsumed request is what made this sticky,
    // and a request that arrives with no account selected should be dropped,
    // not left armed to fire the next time an account is chosen.
    ackReconcileRequest();
    if (selectedAccountId && stage === null) {
      void beginReconcile();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconcileRequest]);

  // "Balanced on:" in the footer comes from the last completed statement.
  useEffect(() => {
    if (!selectedAccountId) {
      setLastStatement(null);
      return;
    }
    let canceled = false;
    api
      .getLastStatement(selectedAccountId)
      .then((st) => !canceled && setLastStatement(st))
      .catch(() => !canceled && setLastStatement(null));
    return () => {
      canceled = true;
    };
  }, [selectedAccountId]);

  // Load the edited transaction's existing split lines so the dialog reopens
  // with them.
  useEffect(() => {
    let canceled = false;
    setSplitsLoad(null);
    if (!editingId) return;
    const token = ++splitsToken.current;
    api
      .listSplits(editingId)
      .then((rows) => {
        if (!canceled) {
          // Every field a line carries, not the three the form draws.
          // `set_splits` REPLACES the whole set on any save — even one that
          // never opened the split dialog — so a field dropped here is a
          // field deleted from the file the next time the date is changed.
          // That is how a split transfer's far row and a line's
          // classification were both being silently thrown away.
          setSplitsLoad({
            id: editingId,
            token,
            lines: rows.map((r) => ({
              category_id: r.category_id,
              description: r.description,
              amount_cents: r.amount_cents,
              transfer_account_id: r.transfer_account_id ?? null,
              classes: (r.classes ?? []).filter((c) => c.value_id).map((c) => ({ ...c })),
            })),
          });
        }
      })
      .catch(() => {
        // No lines to show is still an answer; the form opens without them.
        if (!canceled) setSplitsLoad({ id: editingId, token, lines: [] });
      });
    return () => {
      canceled = true;
    };
  }, [editingId]);

  async function commitDraft(draft: TransactionDraft) {
    if (!selectedAccountId) return;
    // One commit at a time. Throwing (not returning) matters: the form
    // treats a quiet return as saved, and would close or clear itself over
    // what was typed.
    if (committing.current) throw "Still saving the last change — press Enter again in a moment.";
    committing.current = true;
    // The account this form was typed in. A form saved on the way out
    // of an account (the switch above) finishes after the register has moved
    // on, and must not reset the new account's entry state or close a form
    // opened there since.
    const accountId = selectedAccountId;
    const stillHere = () => useAccountStore.getState().selectedAccountId === accountId;
    // What the row was before this edit, for the rule offer below.
    const before = draft.id ? register.find((r) => r.id === draft.id) : undefined;
    setBusy(true);
    try {
      // An existing row changing its nature: the partner row is
      // written (or removed) first, and the ordinary edit below then runs
      // against a row that already is what the form says it is. Balances in
      // the other account moved, so the account list is reloaded.
      if (draft.id && draft.convert === "to_transfer" && draft.transfer_to_account_id) {
        await api.convertToTransfer(draft.id, draft.transfer_to_account_id);
        // Each conversion is its own undo step.
        noteChanged();
        await useAccountStore.getState().loadAccounts();
      } else if (draft.id && draft.convert === "from_transfer") {
        await api.convertFromTransfer(draft.id, draft.category_id);
        noteChanged();
        await useAccountStore.getState().loadAccounts();
      }

      // A transfer is one action that writes two linked rows; it never goes
      // through create_transaction.
      if (draft.transfer_to_account_id && draft.id) {
        // Editing an existing transfer moves BOTH halves, and can move the
        // other half to a different account.
        await useAccountStore
          .getState()
          .editTransfer(
            draft.id,
            draft.date,
            draft.transfer_to_account_id,
            draft.amount_cents,
            draft.notes,
            draft.transfer_amount_cents ?? null
          );
        // "edit a transfer" is an undo step, and the store's
        // `editTransfer` does not say so the way `editTransaction` does.
        noteChanged();
        await applyGoal(draft.id, draft);
        if (await applyClasses(draft.id, draft)) noteChanged();
        await loadRegister(accountId);
        if (stillHere()) {
          setEditingId(null);
          setAddingNew(false);
        }
        return;
      }

      if (draft.transfer_to_account_id) {
        if (stillHere()) {
          setLastWasCheck(false);
          setLastEntryDate(draft.date);
        }
        // A deposit comes FROM the other account. The second amount is the
        // other side's, so for a deposit it is what was sent and this
        // account's amount is what was received.
        const other = draft.transfer_to_account_id;
        const amount = Math.abs(draft.amount_cents);
        const otherAmount = draft.transfer_amount_cents ?? null;
        const created =
          draft.amount_cents > 0
            ? await api.createTransfer(
                other,
                accountId,
                draft.date,
                otherAmount ?? amount,
                draft.notes,
                otherAmount === null ? null : amount
              )
            : await api.createTransfer(accountId, other, draft.date, amount, draft.notes, otherAmount);
        // `created` is the sending half, which for a deposit is the other
        // account's row. Both writes below follow the pair: the goal to the
        // half in the goal's account, the classes to both halves.
        await applyGoal(created.id, draft);
        if (await applyClasses(created.id, draft)) noteChanged();
        await loadRegister(accountId);
        await useAccountStore.getState().loadAccounts();
        if (stillHere()) {
          setEditingId(null);
          setAddingNew(false);
        }
        return;
      }

      // The split lines travel WITH the row, in the same command and
      // the same undo step. They used to be a second call (`set_splits`)
      // after the row was written, which made Enter on a split entry two
      // Ctrl+Zs: the first took the lines off and left the row, and read as
      // undo doing nothing. The backend keeps the order that matters — for
      // an existing row the lines go first, since the parent follows its
      // lines and the edit refuses to move a split row's amount — and a new
      // row whose lines are refused is not left behind.
      let txnId = draft.id;
      if (!txnId && stillHere()) {
        setLastWasCheck(/^\d+$/.test((draft.check_number ?? "").trim()));
        setLastEntryDate(draft.date);
      }
      const splits = draft.splits === null ? undefined : draft.splits;
      if (txnId) {
        await editTransaction({
          id: txnId,
          date: draft.date,
          payee: draft.payee,
          category_id: draft.category_id,
          amount_cents: draft.amount_cents,
          notes: draft.notes,
          check_number: draft.check_number,
          splits,
        });
      } else {
        const created = await addTransaction({
          account_id: accountId,
          date: draft.date,
          payee: draft.payee,
          category_id: draft.category_id,
          amount_cents: draft.amount_cents,
          notes: draft.notes,
          check_number: draft.check_number,
          splits,
        });
        txnId = created.id;
      }
      // These two write AFTER the register has already reloaded:
      // `editTransaction` and `addTransaction` reload inside the store, and
      // the goal and the classification are separate commands that run once
      // the row exists. Whatever they change therefore has to be reloaded
      // AGAIN, or the row on screen is the one from a moment before the tag
      // was written — which is exactly how a classification that saved
      // perfectly well read as one that would not stick.
      const wroteGoal = txnId ? await applyGoal(txnId, draft) : false;
      const wroteClasses = txnId ? await applyClasses(txnId, draft) : false;
      // "change a classification" is a step of its own, after the
      // row's; the menu's label moves on to it.
      if (wroteClasses) noteChanged();
      if (wroteGoal || wroteClasses) {
        await loadRegister(accountId);
      }
      // Learning from an edit: a row that HAD no category (an import
      // the rules did not know) just got one by hand. Offer to remember it.
      if (!stillHere()) return;
      if (draft.id && draft.category_id && !draft.transfer_to_account_id && (draft.splits ?? []).length === 0 && before?.category_id === null) {
        void offerRule(draft.payee, draft.category_id);
      }
      setEditingId(null);
      setAddingNew(false);
    } finally {
      committing.current = false;
      setBusy(false);
    }
  }

  /** "File every X under Y from now on?" with a Remember button that
   *  makes a rule for the payee. Not offered when a rule already covers
   *  the payee: the user chose over it, and a second rule would only shadow
   *  the first. The rule is the payee exactly as written; Banking → Payees
   *  is where it can be broadened to a substring. */
  async function offerRule(payee: string, categoryId: string) {
    const name = payee.trim();
    if (!name) return;
    const rules = await api.listPayeeRules().catch(() => []);
    if (rules.some((r) => r.match_text && name.toLowerCase().includes(r.match_text.toLowerCase()))) return;
    const category = categories.find((c) => c.id === categoryId)?.full_name ?? "that category";
    setNotice(`File every "${name}" under ${category} from now on?`);
    setNoticeAction({
      label: "Remember",
      run: async () => {
        try {
          await api.createPayeeRule(name, name, categoryId);
          setNotice(`Remembered. The rule runs on every import; Tools → Rename payees in existing transactions… applies it to rows already here.`);
        } catch (e) {
          setRefusal(`Could not make the rule: ${e}`);
        }
      },
    });
  }

  // ── Reconcile ────────────────────────────────────────────────────────────

  const differenceCents = statement
    ? reconcileDifferenceCents(
        register,
        statement.starting_balance_cents,
        statement.ending_balance_cents
      )
    : 0;

  async function beginReconcile() {
    if (!selectedAccountId) return;
    const accountId = selectedAccountId;
    // Save-on-leave, as every other way out of a form does. This
    // closed the form outright, and an entry typed but not yet entered was
    // gone the moment Balance was pressed.
    if (!(await leaveOpenForm())) return;
    closeForm();
    setReconcileError(null);
    try {
      // Postpone discards the statement, so normally there is nothing open and
      // this goes straight to the form. An in-progress row only survives a
      // crash mid-reconcile — then offer to resume rather than lose it.
      const open = await api.getOpenStatement(accountId);
      if (useAccountStore.getState().selectedAccountId !== accountId) return;
      setStatement(open);
      setStage(open ? "resume" : "statement");
    } catch (e) {
      setReconcileError(String(e));
    }
  }

  async function submitStatement(draft: StatementDraft) {
    if (!selectedAccountId) return;
    // A refused statement (bad date, a statement already open) used to be an
    // unhandled rejection: the wizard sat there with nothing on screen.
    const accountId = selectedAccountId;
    try {
      const st = await api.startStatement({ accountId, ...draft });
      // The account changed while the statement was being started:
      // it is not this register's to balance.
      if (useAccountStore.getState().selectedAccountId !== accountId) {
        await api.discardStatement(st.id).catch(() => {});
        return;
      }
      setReconcileError(null);
      setStatement(st);
      setStage("clearing");
      setView("unreconciled-grouped");
      await loadRegister(selectedAccountId);
      await useAccountStore.getState().loadAccounts();
    } catch (e) {
      setReconcileError(String(e));
    }
  }

  /** Void or un-void. The row stays; the money leaves every balance.
   *  A voided row is also uncleared — it is not on any statement. */
  async function toggleVoid(id: string) {
    if (!selectedAccountId) return;
    const row = register.find((r) => r.id === id);
    if (!row) return;
    setBusy(true);
    try {
      await api.setVoid(id, !row.is_void);
      // Voiding is undoable too, so the Edit menu has to hear about it.
      noteChanged();
      if (!row.is_void && row.cleared_state !== "") {
        await api.setCleared(id, "");
      }
      await loadRegister(selectedAccountId);
      await useAccountStore.getState().loadAccounts();
    } catch (e) {
      // A refusal (a loan payment's principal row, voided on its own)
      // says where to go instead; it used to vanish as an unhandled rejection
      // and the click simply did nothing. In red, since it is a no.
      setRefusal(String(e));
    } finally {
      setBusy(false);
      setMenu(null);
    }
  }

  /** Toggle a row's cleared mark. This is an EVERYDAY action — Ctrl-M or the
   *  right-click menu, in the ordinary register — not something reconcile owns.
   *  Reconcile only changes how the mark is drawn.
   *
   *  Anything marked goes back to blank; blank becomes "C". That includes an
   *  already-reconciled "R" row: rare, but banks do correct things after a
   *  statement is balanced, and refusing would leave the register permanently
   *  wrong. The next reconcile absorbs the difference — its starting balance
   *  will no longer match the last statement's ending balance, which is
   *  exactly the discrepancy the user is then trying to fix. */
  async function toggleCleared(id: string) {
    if (!selectedAccountId) return;
    const row = register.find((r) => r.id === id);
    // A voided transaction is not on any statement, so it cannot be cleared.
    if (!row || row.is_void) return;
    const next: ClearedState = row.cleared_state === "" ? "C" : "";
    try {
      await api.setCleared(id, next);
      await loadRegister(selectedAccountId);
    } catch (e) {
      // A refused mark was an unhandled rejection: the C click, Ctrl+M
      // and the menu item all simply did nothing.
      setRefusal(String(e));
    }
  }

  function leaveReconcile() {
    setStage(null);
    setStatement(null);
    setAutoHint(null);
    setReconcileError(null);
    setView("all");
  }

  /** Postpone behaves as Cancel: throw the statement header away and start over
   *  next time. The cleared marks stay — they live on the transactions. */
  async function postponeReconcile() {
    const open = statement;
    leaveReconcile();
    if (open) {
      try {
        await api.discardStatement(open.id);
      } catch {
        // Nothing to recover: the user is already out of reconcile mode.
      }
    }
  }

  async function finishReconcile(
    adjustmentCents: number | null,
    adjustmentCategoryId: string | null
  ) {
    if (!statement || !selectedAccountId) return;
    if (finishing.current) return;
    finishing.current = true;
    const accountId = selectedAccountId;
    try {
      await api.finishStatement(statement.id, adjustmentCents, adjustmentCategoryId);
      const last = await api.getLastStatement(accountId);
      if (useAccountStore.getState().selectedAccountId !== accountId) return;
      setLastStatement(last);
      await loadRegister(accountId);
      await useAccountStore.getState().loadAccounts();
      setReconcileError(null);
      setStage("balanced");
    } catch (e) {
      if (useAccountStore.getState().selectedAccountId !== accountId) return;
      setReconcileError(String(e));
      setStage("clearing");
    } finally {
      finishing.current = false;
    }
  }

  function closeForm() {
    setEditingId(null);
    setAddingNew(false);
  }

  /** Double-click, or a click on an already-selected row, opens editing —
   *  Money's register edits in place without needing the toolbar. */
  async function openForEdit(id: string) {
    if (editingId !== id && !(await leaveOpenForm())) return;
    setSelectedRowId(id);
    setAddingNew(false);
    setEditingId(id);
    setShowForms(true);
  }

  /** Contribution / Employer Contribution / Deposit / Withdrawal / Fee
   *  from the investment register's Activity list. Each is an ordinary cash
   *  row in this account — the same row the importer writes beside a
   *  purchase, with the same category — so the form opens seeded and the
   *  only thing left to type is the amount. */
  async function startCashActivity(key: string) {
    const kind = cashActivityFor(key);
    if (!kind) return;
    let categoryId: string | null = null;
    if (kind.category) {
      const [top, child] = kind.category.split(":").map((p) => p.trim());
      const full = child ? `${top} : ${child}` : top;
      // Matched on the normalized spelling, as every category field is.
      const found = categories.find(
        (c) => categoryKey(c.full_name) === categoryKey(full) || (!child && categoryKey(c.name) === categoryKey(top) && !c.parent_id)
      );
      categoryId = found
        ? found.id
        : await createCategoryInline({ name: top, kind: kind.kind, parentId: null, childName: child ?? null });
    }
    setCashPreset({ payee: kind.payee, categoryId, side: kind.side });
    setNewKind("cash");
    setAddingNew(true);
    setShowForms(true);
  }

  async function startNew(kind: "investment" | "cash" = "investment") {
    if (!(await leaveOpenForm())) return;
    setCashPreset(null);
    setNewKind(kind);
    setEditingId(null);
    setAddingNew(true);
    setShowForms(true);
  }

  // The register as shown, to a CSV file.
  async function exportCsv() {
    if (!account) return;
    try {
      const path = await save({ defaultPath: `${account.name.replace(/[\\/:*?"<>|]+/g, " ").trim()} register.csv`, filters: [{ name: "CSV", extensions: ["csv"] }] });
      if (!path) return;
      const rows = applyRegisterView(register, viewOpts, today());
      await api.writeTextFile(path, registerCsv(rows, balanceIsMeaningful(viewOpts)));
      setNotice(`Saved ${rows.length} rows to ${path}`);
    } catch (e) {
      setRefusal(`Could not export: ${e}`);
    }
  }

  /** File → Export → This register to QIF. The command existed in the
   *  menu and nothing served it, so it was grayed out everywhere; the backend
   *  (`export_qif`) has been there since long before the menu was.
   *
   *  Unlike the CSV export this is the WHOLE register, not the filtered view:
   *  a QIF is meant to be re-imported somewhere, and a file that silently
   *  contains only what you happened to be filtering by is a trap. */
  async function exportQif() {
    if (!account) return;
    try {
      const path = await save({
        defaultPath: `${account.name.replace(/[\\/:*?"<>|]+/g, " ").trim()}.qif`,
        filters: [{ name: "QIF", extensions: ["qif"] }],
      });
      if (!path) return;
      // The second number is the voided rows LEFT OUT (`export_qif`
      // returns records written and voids skipped), not prices: a register
      // with three voids reported "and 3 prices".
      const [rows, voided] = await api.exportQif(account.id, path);
      setNotice(
        voided > 0
          ? `Saved ${rows} transaction${rows === 1 ? "" : "s"} to ${path}. ${voided} voided transaction${voided === 1 ? " was" : "s were"} left out.`
          : `Saved ${rows} transaction${rows === 1 ? "" : "s"} to ${path}`
      );
    } catch (e) {
      setRefusal(`Could not export: ${e}`);
    }
  }

  /** Favorites → Add / Remove this account. Each is enabled only when
   *  it would do something, so the pair reads as one truthful statement about
   *  the account you are looking at. */
  async function setFavorite(on: boolean) {
    if (!account) return;
    try {
      await useAccountStore.getState().toggleFavorite(account.id);
      setNotice(on ? `${account.name} added to favorites.` : `${account.name} removed from favorites.`);
    } catch (e) {
      // Refused, it used to vanish as an unhandled rejection.
      setRefusal(`Could not change favorites: ${e}`);
    }
  }

  async function deleteTransaction(id: string) {
    if (!selectedAccountId) return;
    setBusy(true);
    try {
      await removeTransaction(id, selectedAccountId);
      if (selectedRowId === id) setSelectedRowId(null);
      closeForm();
    } catch (e) {
      // The same for a delete that is refused.
      setRefusal(String(e));
    } finally {
      setBusy(false);
      setMenu(null);
    }
  }

  /** Selecting a row selects it — nothing more.
   *
   *  It used to open the edit form immediately whenever "Show transaction
   *  forms" was checked. That made a single click expand the row, which is
   *  too eager: you cannot look at a row, or pick one to clear or delete,
   *  without it unfolding under the cursor. Opening now always takes a
   *  deliberate second action — a second click on the already-selected row,
   *  a double-click, or the Edit button.
   *
   *  Ticking "Show transaction forms" while a row is selected still opens
   *  that row, which is what the toggle is for. */
  async function handleSelect(id: string) {
    // Moving to another row SAVES the open form first, as Money did —
    // a change followed by a click elsewhere is not thrown away. If it
    // cannot be saved the form stays open with its error.
    if (!(await leaveOpenForm())) return;
    setSelectedRowId(id);
    setAddingNew(false);
    // Selecting a different row closes whatever was open. Two expanded rows
    // at once is not a state Money has, and leaving the old one open pushes
    // the register around while you are trying to read it. The form is for
    // the row you are working on, and you are working on this one now.
    setEditingId(null);
  }

  // The view: Show, dates and sort applied to the rows the backend gave us.
  // The grouped reconcile view keeps its own grouping.
  // What the register can do, offered to the menu bar. These are
  // registered here rather than lifted into App because they ARE the
  // register's: Print prints this view, Export CSV exports these rows, Delete
  // deletes the selected row. Leave the register and every one of them grays
  // out, which is how the menu stays honest without being told where you are.
  const hasRow = selectedRowId !== null;
  useCommand("file.print", () => window.print());
  useCommand("file.print.preview", () => window.print());
  useCommand("export.register.csv", () => void exportCsv());
  useCommand("export.register.qif", () => void exportQif(), !!account);
  useCommand("fav.add", () => void setFavorite(true), !!account && !account.is_favorite);
  useCommand("fav.remove", () => void setFavorite(false), !!account && account.is_favorite);
  useCommand("tools.duplicates", () => setDupesOpen(true), stage === null);
  // Ctrl+F with a register on screen finds IN it, over the shell's
  // header search (priority 0); the Budget tab's find-on-page is
  // never mounted at the same time as a register.
  useCommand("edit.find", () => setFindOpen(true), !!account && stage === null, 5);
  // Through `beginReconcile`, like the button: setting the stage
  // directly skipped the check for a statement left open and the open form.
  useCommand("edit.reconcile", () => void beginReconcile(), stage === null);
  useCommand("new.transaction", () => void startNew("cash"));
  useCommand("edit.delete", () => {
    if (selectedRowId) void deleteTransaction(selectedRowId);
  }, hasRow);
  useCommand("edit.void", () => {
    if (selectedRowId) void toggleVoid(selectedRowId);
  }, hasRow);
  useCommand("edit.clear", () => {
    if (selectedRowId) void toggleCleared(selectedRowId);
  }, hasRow);

  const shown = applyRegisterView(register, viewOpts, today());
  const groups: RegisterGroup[] =
    view === "unreconciled-grouped"
      ? groupByDepositsAndWithdrawals(shown)
      : [{ label: null, rows: shown }];

  // The register is a list you walk with the arrow keys, as Money's
  // was. Up and down move the selection through the rows AS SHOWN: the
  // flattened groups, so a grouped or re-sorted register steps in the order
  // on the screen rather than the order in the store.
  //
  // Bound on the window rather than the scroll container on purpose. The
  // container would have to hold focus for a key to reach it, and taking
  // focus on every select is the one thing this must not do — it would pull
  // the caret out of whatever is being typed. So instead the handler asks
  // whether the keystroke belongs to anything else, and stands down if it
  // does: a form open in a row, a dialog or menu on screen, or a caret in any
  // field means the arrows are that thing's, not the list's. Money's own
  // register behaves this way — the arrows work whenever you are not typing.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      // A row is open for editing: every arrow key belongs to the form, down
      // to the payee list picking its next match.
      if (editingId || addingNew) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest?.("input, textarea, select, [contenteditable='true'], [role='dialog'], [role='listbox'], [role='menu']")) return;
      // A dialog or menu open anywhere takes the keys even when focus has not
      // landed inside it yet.
      if (document.querySelector("[role='dialog'], [role='menu']")) return;

      const ordered = groups.flatMap((g) => g.rows);
      if (ordered.length === 0) return;
      const down = e.key === "ArrowDown";
      const at = ordered.findIndex((r) => r.id === selectedRowId);
      const to =
        at < 0
          ? down
            ? 0
            : ordered.length - 1
          : Math.min(ordered.length - 1, Math.max(0, at + (down ? 1 : -1)));
      // Always swallow the key once the register has taken it, or the pane
      // scrolls out from under a selection that did not move at the ends.
      e.preventDefault();
      const next = ordered[to];
      if (!next || next.id === selectedRowId) return;
      // `handleSelect` saves an open form before moving; nothing is open here
      // — the guards above are exactly that condition — so this is the same
      // move without the round trip.
      setSelectedRowId(next.id);
      scrollRef.current
        ?.querySelector(`[data-row-id="${next.id}"]`)
        ?.scrollIntoView?.({ block: "nearest" });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [groups, selectedRowId, editingId, addingNew]);

  // BELOW every hook, not above the menu-bar ones. This used to sit
  // before the `useCommand` block and the arrow-key effect, which is an early
  // return with hooks after it: fine while the account is there on the first
  // render and stays there, and a crash the moment it goes. `reloadAll` —
  // what every importer calls when it finishes — clears the selection first,
  // so finishing a TSP import with a register on screen rendered this
  // component with fewer hooks than the render before it (React #300,
  // "Something on this screen failed to draw"). The bank importers took the
  // same path; the user happened to be on a screen that survives it.
  if (!account) {
    return (
      <section className="aero-card">
        <div className="aero-card-title">
          <span className="inline-flex items-center gap-2">
            <TmIcon name="transactions" size={13} /> Account register
          </span>
        </div>
        <div className="p-6 text-center" style={{ color: "var(--tm-ms-text-muted)" }}>
          Select an account to view its register.
        </div>
      </section>
    );
  }
  const showBalance = balanceIsMeaningful(viewOpts);

  // Money's Ending Balance is the running balance of the last row.
  // Every amount in this register is in the account's own currency.
  const currency = currencyOf(account);
  const endingBalanceCents =
    register.length > 0
      ? register[register.length - 1].running_balance_cents
      : account.balance_cents;

  // The newest appraisal, for the banner above a valued asset. The
  // register is in date order, so the last revaluation row is the current one.
  const lastValuation = [...register].reverse().find((r) => r.is_revaluation && !r.is_void) ?? null;

  return (
    <section className="aero-card">
      <div className="aero-card-title flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2">
          <TmIcon name="transactions" size={13} /> Account register
        </span>
        <span>{account.name}</span>
      </div>
      <div className="tm-print-only" data-print={`${account.name} — ${describeView(viewOpts)}. Printed ${formatDateUS(today())}. Ending balance ${formatMoney(endingBalanceCents, { currency })}.`} />

      {/* View selector — Money's register is driven by a saved view that sets
          filter, grouping and sort together. */}
      <div className="flex items-center gap-2 px-2 py-1 flex-wrap">
        <label htmlFor="register-view">View:</label>
        <select
          id="register-view"
          className="aero-field"
          value={view}
          onChange={(e) => setView(e.target.value as RegisterView)}
        >
          {SHOW_OPTIONS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        <label htmlFor="register-dates">covering</label>
        <select
          id="register-dates"
          className="aero-field"
          value={dates}
          onChange={(e) => setDates(e.target.value as RegisterDates)}
        >
          {DATES_OPTIONS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        {view !== "unreconciled-grouped" && (
          <>
            <label htmlFor="register-sort">sorted by</label>
            <select
              id="register-sort"
              className="aero-field"
              value={sort}
              onChange={(e) => setSort(e.target.value as RegisterSort)}
              title={showBalance ? undefined : "The Balance column only reads in date order, so it is blank in this sort."}
            >
              {SORT_OPTIONS.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </>
        )}
        <span className="tm-text-muted" aria-live="polite">
          {describeView(viewOpts)}
          {(view !== "all" || dates !== "all_dates") && ` — ${shown.length} of ${register.length}`}
        </span>
      </div>

      {/* A house or a car is not a checking account, and its register
          used to look exactly like one: rows, a New button, and "Update
          value…" hidden in the strip along the bottom. Reported as "it just
          looks like another account register … I start a new transaction to
          update value and I don't understand how to update it." So the
          valued-asset register says what it is for at the top, shows what the
          thing is worth right now, and puts the one button that matters where
          you are already looking. */}
      {isAsset && (
        <div className="tm-asset-banner" role="region" aria-label="Value of this asset">
          <div className="flex-1">
            <div>
              <strong>{account.name}</strong> is worth {formatMoney(endingBalanceCents, { currency })}
              {lastValuation ? `, valued on ${formatDateUS(lastValuation.date)}.` : " — its opening value; it has never been revalued."}
            </div>
            <div className="tm-text-muted">
              This account holds what the thing is <em>worth</em>, not what you spend on it. Use{" "}
              <strong>Update value…</strong> and type the new appraisal; the rise or fall is written for
              you and counts in Net worth only — never in spending or income. Fuel, repairs and insurance
              belong in the account you actually paid them from, and mortgage or loan payments in the loan
              account.
            </div>
          </div>
          <button className="aero-btn default" type="button" onClick={() => setValuing(true)}>
            Update value…
          </button>
        </div>
      )}

      {/* While the wizard's dialog is up this strip is under its
          backdrop; the dialog shows the error itself then. */}
      {reconcileError && (stage === null || stage === "clearing") && <Notice tone="error">Reconcile: {reconcileError}</Notice>}
      {notice && (
        <Notice
          tone={notice.tone}
          actions={
            noticeAction && (
              <button
                type="button"
                className="aero-btn default !py-0 !px-2 text-[11px]"
                onClick={() => {
                  const a = noticeAction;
                  setNotice(null);
                  setNoticeAction(null);
                  void a.run();
                }}
              >
                {noticeAction.label}
              </button>
            )
          }
          onDismiss={() => {
            setNotice(null);
            setNoticeAction(null);
          }}
        >
          {notice.text}
        </Notice>
      )}

      {/* While clearing, the balance panel is a strip HERE, above the
          register, so every row stays clickable and the difference is always
          in view. The other stages are still the centered dialog below. */}
      {stage === "clearing" && account && (
        <>
          {/* The hint is a warning: the statement and the register
              disagree and the user has to go and look. */}
          {autoHint && <Notice tone="error">{autoHint}</Notice>}
          <ReconcileDialog
            inline
            accountName={account.name}
            currency={currency}
            stage={stage}
            categories={categories}
            suggestedDate={statement?.statement_date ?? nextStatementDate(lastStatement)}
            suggestedStartingCents={statement?.starting_balance_cents ?? lastStatement?.ending_balance_cents ?? 0}
            lastStatement={statement ?? lastStatement}
            differenceCents={differenceCents}
            onCancel={leaveReconcile}
            onResume={() => setStage("clearing")}
            onStatement={() => {}}
            onNextFromClearing={() => {
              if (finishing.current) return;
              if (differenceCents === 0) void finishReconcile(null, null);
              else setStage("unbalanced");
            }}
            onPostpone={() => void postponeReconcile()}
            onUnbalancedChoice={() => {}}
            onFinish={() => leaveReconcile()}
          />
        </>
      )}

      {/* Ctrl-M marks the selected row cleared, as in Money — bound from the
          menu table now (Edit → Mark as cleared), not here. A shortcut with a
          private listener is a shortcut nothing can print, which is how this
          one stayed invisible; the same mistake F1 once made. The arrow
          keys are bound on the window, not here — the container would have to
          hold focus to hear them, and taking focus is what would pull the
          caret out of an open form. */}
      <div
        ref={scrollRef}
        className="overflow-auto tm-print-open"
        style={{ maxHeight: "52vh" }}
        tabIndex={-1}
      >
        {registerLoading && register.length === 0 ? (
          <div className="p-6 text-center" style={{ color: "var(--tm-ms-text-muted)" }}>
            Loading register…
          </div>
        ) : (
          <RegisterGrid
            groups={groups}
            columnLabels={columnLabels}
            hideBalance={!showBalance}
            selectedId={selectedRowId}
            onSelect={(id) => void handleSelect(id)}
            minRows={MIN_ROWS}
            clearable={stage === "clearing"}
            onToggleCleared={toggleCleared}
            onActivate={(id) => void openForEdit(id)}
            onRowContextMenu={(id, x, y) => setMenu({ id, x, y })}
            onEmptyRowClick={() => void startNew()}
            entryRow
            entryNum={lastWasCheck ? nextCheckNumber(register) : null}
            entryDate={lastEntryDate}
            editingId={editingId}
            investment={isInvestment}
            sort={sort}
            onSortColumn={(c) => setSort(nextSort(c, sort))}
            renderEdit={(r) => r.activity ? (
              <InvestmentEditRow
                key={r.id}
                accountId={account.id}
                leaveRef={leaveRef}
                onToggleCleared={() => void toggleCleared(r.id)}
                row={r}
                securities={securities}
                categories={categories}
                fundingAccounts={pickableAccounts(accounts, [r.funding_account_id]).filter((a) => a.id !== selectedAccountId)}
                onCommit={commitInvestment}
                onTransferShares={transferShares}
                transferTargets={pickableAccounts(accounts, [r.transfer_account_id]).filter((a) => a.id !== selectedAccountId && (a.type === "investment" || a.type === "retirement"))}
                onCancel={closeForm}
                onCreateSecurity={createSecurityInline}
                busy={busy}
              />
            ) : splitsLoad?.id !== r.id ? (
              // The row's own lines are still on their way; the form
              // waits for them rather than mounting on what was there before.
              <tr className="tm-edit-loading" aria-busy="true">
                <td colSpan={isInvestment ? 10 : 9} className="tm-text-muted">
                  Opening…
                </td>
              </tr>
            ) : (
              <TransactionEditRow
                columnLabels={columnLabels}
                key={`${r.id}:${splitsLoad.token}`}
                columns={isInvestment ? 10 : 9}
                goals={goalsFor(r.transfer_account_id)}
                classifications={classifications}
                onToggleCleared={() => void toggleCleared(r.id)}
                leaveRef={leaveRef}
                row={r}
                categories={categories}
                payees={payees}
                onCreateCategory={createCategoryInline}
                initialSplits={editingSplits}
                // Open accounts, plus a closed one this row or its
                // split lines already transfer to (N9).
                transferTargets={pickableAccounts(accounts, [
                  r.transfer_account_id,
                  ...editingSplits.map((l) => l.transfer_account_id),
                ]).filter((a) => a.id !== selectedAccountId)}
                currency={currency}
                onCommit={commitDraft}
                onCancel={closeForm}
                busy={busy}
                commonTransactions={commons}
                onSaveCommon={saveCommon}
                onUseCommon={useCommon}
                onDeleteCommon={deleteCommon}
                onAttachmentsChanged={() => void loadRegister(account.id)}
              />
            )}
            renderNewRow={
              addingNew
                ? () => isInvestment && newKind === "investment" ? (
                    <InvestmentEditRow
                      accountId={account.id}
                      leaveRef={leaveRef}
                      defaultDate={lastEntryDate}
                      securities={securities}
                      categories={categories}
                      fundingAccounts={pickableAccounts(accounts).filter((a) => a.id !== selectedAccountId)}
                      onCommit={commitInvestment}
                      onTransferShares={transferShares}
                      onCashActivity={(key) => void startCashActivity(key)}
                      transferTargets={pickableAccounts(accounts).filter((a) => a.id !== selectedAccountId && (a.type === "investment" || a.type === "retirement"))}
                      onCancel={closeForm}
                      onCreateSecurity={createSecurityInline}
                      busy={busy}
                    />
                  ) : (
                    <TransactionEditRow
                      key={`new:${entrySerial}`}
                      columnLabels={columnLabels}
                      preset={cashPreset}
                      onEntered={() => {
                        // The row just saved; nothing to leave. A preset
                        // (Contribution, Fee…) was for that one row.
                        setCashPreset(null);
                        setEntrySerial((n) => n + 1);
                        setEditingId(null);
                        setAddingNew(true);
                        setShowForms(true);
                      }}
                      columns={isInvestment ? 10 : 9}
                      goals={goals}
                      classifications={classifications}
                      suggestedCheckNumber={lastWasCheck ? nextCheckNumber(register) : null}
                      nextCheckNumber={nextCheckNumber(register)}
                      defaultDate={lastEntryDate}
                      leaveRef={leaveRef}
                      categories={categories}
                      payees={payees}
                      onCreateCategory={createCategoryInline}
                      // A new entry: open accounts only (N9).
                      transferTargets={pickableAccounts(accounts).filter((a) => a.id !== selectedAccountId)}
                      currency={currency}
                      onCommit={commitDraft}
                      onCancel={closeForm}
                      busy={busy}
                      commonTransactions={commons}
                      onSaveCommon={saveCommon}
                      onUseCommon={useCommon}
                      onDeleteCommon={deleteCommon}
                    />
                  )
                : undefined
            }
          />
        )}
      </div>

      {/* Find, over the register. No backdrop: the register stays
          visible and the chosen row scrolls into view behind the window,
          and closing it leaves that row selected. */}
      {findOpen && account && (
        <FindInRegisterDialog
          accountName={account.name}
          currency={currencyOf(account)}
          rows={shown}
          selectedId={selectedRowId}
          onPick={(id) => {
            setSelectedRowId(id);
            scrollRef.current
              ?.querySelector(`[data-row-id="${id}"]`)
              ?.scrollIntoView?.({ block: "center" });
          }}
          onClose={() => setFindOpen(false)}
        />
      )}

      {/* Footer strip. Money shows no per-column totals here — the previous
          deposits/withdrawals/net tfoot was invented. */}
      <div className="register-footer">
        {/* Reads statements.reconciled_on once migration 0010 lands — the
            same value dialog [B] shows as "Last statement reconciled".
            Until then there is nothing to show. */}
        <span>
          Balanced on:{" "}
          {lastStatement?.reconciled_on ? formatDateUS(lastStatement.reconciled_on) : "—"}
        </span>
        <button
          className="aero-btn"
          type="button"
          onClick={() => void beginReconcile()}
          disabled={stage !== null}
        >
          Balance this account
        </button>
        <button
          className="aero-btn"
          type="button"
          disabled={stage !== null}
          title="Mark every transaction on or before a date as reconciled, without a statement — for history brought in already balanced"
          onClick={() => {
            const last = lastStatement?.statement_date ?? register.filter((r) => r.cleared_state === "R").map((r) => r.date).sort().pop() ?? register[register.length - 1]?.date ?? today();
            setReconcileThrough(last);
            setReconcileCount(null);
            setThroughError(null);
          }}
        >
          Mark reconciled through…
        </button>
        <button
          className="aero-btn"
          type="button"
          disabled={stage !== null}
          title="Rows in this account with the same payee and amount on the same day (or within a few days) — what overlapping downloads leave behind"
          onClick={() => setDupesOpen(true)}
        >
          Find duplicates…
        </button>
        <button
          className="aero-btn"
          type="button"
          disabled={stage !== null}
          title={keys("Find a transaction in this register by any field (Ctrl+F)")}
          onClick={() => setFindOpen(true)}
        >
          Find…
        </button>
        <button className="aero-btn" type="button" onClick={() => window.print()} title="Print the register as shown — the view, every row, no buttons">
          Print…
        </button>
        <button
          className="aero-btn"
          type="button"
          title="Save the register as shown to a CSV file for Excel"
          onClick={() => void exportCsv()}
        >
          Export CSV…
        </button>
        <label className="inline-flex items-center gap-1">
          <input
            type="checkbox"
            checked={showForms}
            onChange={(e) => {
              setShowForms(e.target.checked);
              if (!e.target.checked) closeForm();
              else if (selectedRowId) setEditingId(selectedRowId);
            }}
          />
          Show transaction forms
        </label>
        <span className="flex-1" />
        <button
          className="aero-btn"
          type="button"
          onClick={() => void startNew()}
        >
          New
        </button>
        {isInvestment && (
          <button className="aero-btn" type="button" onClick={() => void startNew("cash")} title="A contribution, a fee, a transfer — anything that is only cash">
            New cash entry
          </button>
        )}
        {isInvestment && (
          <button className="aero-btn" type="button" onClick={() => setUpdatingHoldings(true)} title="Type the statement's holdings; the difference becomes Add / Remove Shares rows">
            Update from statement
          </button>
        )}
        {isAsset && (
          <button
            className="aero-btn"
            type="button"
            onClick={() => setValuing(true)}
            title="What it is worth now — counts in net worth, and in no spending or income report"
          >
            Update value…
          </button>
        )}
        {isLoan && (
          <button
            className="aero-btn"
            type="button"
            onClick={() => setPayingLoan(true)}
            title="One transaction split into interest, principal and escrow — the principal reduces this loan"
          >
            Record payment…
          </button>
        )}
        {isLoan && (
          <button
            className="aero-btn"
            type="button"
            onClick={() => setEditingTerms(true)}
            title="Rate, payment, escrow and the amortization schedule — a starting point you can type over"
          >
            Loan terms…
          </button>
        )}
        <button
          className="aero-btn"
          type="button"
          disabled={selectedRowId === null}
          onClick={() => selectedRowId && void openForEdit(selectedRowId)}
        >
          Edit
        </button>
        <button
          className="aero-btn"
          type="button"
          disabled={selectedRowId === null || busy}
          title={keys("Mark the selected transaction cleared, or uncleared (Ctrl+M)")}
          onClick={() => selectedRowId && void toggleCleared(selectedRowId)}
        >
          {register.find((r) => r.id === selectedRowId)?.cleared_state ? "Unclear" : "Mark cleared"}
        </button>
        <button
          className="aero-btn"
          type="button"
          disabled={selectedRowId === null || busy}
          onClick={() => selectedRowId && deleteTransaction(selectedRowId)}
        >
          Delete
        </button>
        {isInvestment ? (
          <span className="font-bold" title="Cash is the register's balance; holdings are at the latest prices">
            Cash: {formatMoney(endingBalanceCents, { currency })} · Holdings: {formatMoney(account.holdings_value_cents, { currency })} · Total:{" "}
            {formatMoney(endingBalanceCents + account.holdings_value_cents, { currency })}
          </span>
        ) : (
          <span className="font-bold">
            Ending Balance: {formatMoney(endingBalanceCents, { currency })}
          </span>
        )}
      </div>

      {valuing && account && (
        <UpdateValueDialog
          account={account}
          onCancel={() => setValuing(false)}
          onDone={() => {
            setValuing(false);
            void useAccountStore.getState().loadAccounts();
            if (selectedAccountId) void loadRegister(selectedAccountId);
          }}
        />
      )}

      {editingTerms && account && (
        <LoanTermsDialog
          account={account}
          onCancel={() => setEditingTerms(false)}
          onDone={() => setEditingTerms(false)}
        />
      )}

      {payingLoan && account && (
        <RecordPaymentDialog
          account={account}
          onCancel={() => setPayingLoan(false)}
          onDone={() => {
            setPayingLoan(false);
            // The payment lands in the funding account and moves three
            // balances, so reload the lot rather than patching one.
            void useAccountStore.getState().loadAccounts();
            if (selectedAccountId) void loadRegister(selectedAccountId);
          }}
        />
      )}

      {dupesOpen && account && selectedAccountId && (
        <DuplicatesDialog
          accountId={selectedAccountId}
          accountName={account.name}
          currency={currencyOf(account)}
          onDelete={(id) => removeTransaction(id, selectedAccountId)}
          onClose={() => setDupesOpen(false)}
        />
      )}

      {reconcileThrough !== null && account && (
        <>
          <div className="tm-dialog-backdrop" onClick={() => setReconcileThrough(null)} />
          <div className="tm-dialog" role="dialog" aria-label="Mark reconciled through a date" style={{ minWidth: 480 }}>
            <div className="tm-dialog-title">Mark reconciled through a date</div>
            <div className="tm-dialog-body space-y-2 text-[12px]">
              <p>
                Every transaction in <strong>{account.name}</strong> dated on or before this day is marked <strong>R</strong> (reconciled),
                as if a statement had been balanced through it. Use it for history brought in already balanced — the balance is right, so the old months need no statement.
              </p>
              <label className="flex items-center gap-2">
                Through
                <DateField
                  label="Reconcile through"
                  value={reconcileThrough}
                  onChange={(v) => {
                    setReconcileThrough(v);
                    setReconcileCount(null);
                  }}
                  width={130}
                />
                <button
                  className="aero-btn"
                  type="button"
                  disabled={!reconcileThrough}
                  onClick={() => {
                    setThroughError(null);
                    void api.reconcileThrough(account.id, reconcileThrough, true).then(setReconcileCount).catch((e) => setThroughError(String(e)));
                  }}
                >
                  Count
                </button>
                {reconcileCount !== null && (
                  <span aria-live="polite" aria-label="Rows to mark">
                    {reconcileCount} transaction{reconcileCount === 1 ? "" : "s"} would be marked
                  </span>
                )}
              </label>
              <p className="tm-text-muted">Rows already marked R are left alone; voided rows are skipped. The next Balance starts from this date.</p>
              {throughError && (
                <Notice tone="error" boxed>
                  {throughError}
                </Notice>
              )}
              <div className="flex justify-end gap-2 pt-1">
                <button
                  className="aero-btn default"
                  type="button"
                  disabled={!reconcileThrough || busy}
                  onClick={async () => {
                    if (!selectedAccountId) return;
                    setBusy(true);
                    setThroughError(null);
                    try {
                      const n = await api.reconcileThrough(account.id, reconcileThrough, false);
                      await loadRegister(selectedAccountId);
                      setNotice(`${n} transaction${n === 1 ? "" : "s"} marked reconciled through ${formatDateUS(reconcileThrough)}.`);
                      setReconcileThrough(null);
                    } catch (e) {
                      setThroughError(String(e));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Mark reconciled
                </button>
                <button className="aero-btn" type="button" onClick={() => setReconcileThrough(null)}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {updatingHoldings && account && (
        <>
          <div className="tm-dialog-backdrop" onClick={() => setUpdatingHoldings(false)} />
          <UpdateHoldingsDialog
            account={account}
            securities={securities}
            onCancel={() => setUpdatingHoldings(false)}
            onDone={async (changes) => {
              setUpdatingHoldings(false);
              await loadRegister(account.id);
              await useAccountStore.getState().loadAccounts();
              // The new rows are the confirmation: select the first one.
              const first = changes.find((c) => c.transaction_id);
              if (first?.transaction_id) setSelectedRowId(first.transaction_id);
            }}
          />
        </>
      )}

      {/* Reconcile wizard. During clearing the dialog STAYS OPEN and the grid
          above switches to the grouped, checkable view. */}
      {stage && stage !== "clearing" && account && (
        <>
          <div className="tm-dialog-backdrop" onClick={leaveReconcile} />
          <ReconcileDialog
            accountName={account.name}
            currency={currency}
            stage={stage}
            categories={categories}
            suggestedDate={statement?.statement_date ?? nextStatementDate(lastStatement)}
            suggestedStartingCents={
              statement?.starting_balance_cents ?? lastStatement?.ending_balance_cents ?? 0
            }
            lastStatement={statement ?? lastStatement}
            differenceCents={differenceCents}
            error={reconcileError}
            onCancel={leaveReconcile}
            onResume={() => {
              setStage("clearing");
              setView("unreconciled-grouped");
            }}
            onStatement={submitStatement}
            onPostpone={() => void postponeReconcile()}
            onNextFromClearing={() => {
              if (finishing.current) return;
              setAutoHint(null);
              if (differenceCents === 0) void finishReconcile(null, null);
              else setStage("unbalanced");
            }}
            onUnbalancedChoice={(choice, categoryId) => {
              if (choice === "back") {
                setStage("clearing");
              } else if (choice === "auto") {
                const hit = autoReconcile(register, differenceCents);
                setAutoHint(
                  hit ? hit.explanation : "No single transaction explains the difference."
                );
                if (hit?.row) setSelectedRowId(hit.row.id);
                setStage("clearing");
              } else {
                void finishReconcile(adjustmentForDifference(differenceCents), categoryId);
              }
            }}
            onFinish={() => leaveReconcile()}
          />
        </>
      )}

      {/* Right-click menu on a register row. */}
      {menu && (
        <>
          <div className="tm-dialog-backdrop" style={{ background: "transparent" }}
               onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div className="tm-context-menu" role="menu" style={{ top: menu.y, left: menu.x }}>
            <button role="menuitem" type="button" onClick={() => { void openForEdit(menu.id); setMenu(null); }}>
              Edit transaction
            </button>
            {(() => {
              const row = register.find((r) => r.id === menu.id);
              if (!row) return null;
              const voidItem = (
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => void toggleVoid(menu.id)}
                  title={
                    row.is_void
                      ? undefined
                      : "Keeps the transaction in the register but removes it from every balance."
                  }
                >
                  {row.is_void ? "Un-void transaction" : "Void transaction"}
                </button>
              );
              if (row.is_void) return voidItem;
              const label =
                row.cleared_state === "R"
                  ? "Unreconcile (was balanced on a statement)"
                  : row.cleared_state === "C"
                    ? "Mark as uncleared"
                    : keys("Mark as cleared (Ctrl+M)");
              return (
                <>
                <button
                  role="menuitem"
                  type="button"
                  title={
                    row.cleared_state === "R"
                      ? "The next reconcile will start from a balance that no longer matches the last statement."
                      : undefined
                  }
                  onClick={() => {
                    void toggleCleared(menu.id);
                    setMenu(null);
                  }}
                >
                  {label}
                </button>
                {row.cleared_state !== "R" && !row.is_void && (
                  <button
                    role="menuitem"
                    type="button"
                    title="Mark this one transaction R without a statement"
                    onClick={() => {
                      void api
                        .setCleared(menu.id, "R")
                        .then(() => {
                          if (selectedAccountId) void loadRegister(selectedAccountId);
                        })
                        // A refusal said nothing at all.
                        .catch((e) => setRefusal(String(e)));
                      setMenu(null);
                    }}
                  >
                    Mark as reconciled
                  </button>
                )}
                {voidItem}
                </>
              );
            })()}
            {(() => {
              const row = register.find((r) => r.id === menu.id);
              if (!row || row.is_void || row.transfer_account_id) return null;
              return (
                <button role="menuitem" type="button" onClick={() => { setTaxLineFor(menu.id); setTaxLineError(null); setMenu(null); }} title="Put this one transaction on a tax line, or take it off its category's">
                  Tax line…
                </button>
              );
            })()}
            <button role="menuitem" type="button" onClick={() => deleteTransaction(menu.id)}>
              Delete transaction
            </button>
          </div>
        </>
      )}

      {taxLineFor && account && (() => {
        const row = register.find((r) => r.id === taxLineFor);
        if (!row) return null;
        const mode = row.tax_line == null ? "category" : row.tax_line === "" ? "none" : "line";
        const apply = async (line: string | null) => {
          setBusy(true);
          setTaxLineError(null);
          try {
            await api.setTransactionTaxLine(row.id, line);
            await loadRegister(account.id);
          } catch (e) {
            // Refused, the radio simply did not move.
            setTaxLineError(String(e));
          } finally {
            setBusy(false);
          }
        };
        return (
          <>
            <div className="tm-dialog-backdrop" onClick={() => setTaxLineFor(null)} />
            <div className="tm-dialog" role="dialog" aria-label="Tax line for this transaction" style={{ width: 460 }}>
              <div className="tm-dialog-title">Tax line — {row.payee}, {formatDateUS(row.date)}</div>
              <div className="tm-dialog-body space-y-2 text-[12px]">
                <p>
                  Tax lines belong to categories; this is the exception for one transaction. {row.category_name ? `Its category is ${row.category_name}.` : "It has no category."}
                </p>
                <label className="flex items-center gap-1">
                  <input type="radio" name="txn-tax" checked={mode === "category"} onChange={() => void apply(null)} disabled={busy} />
                  Whatever its category says (the usual)
                </label>
                <label className="flex items-center gap-1">
                  <input type="radio" name="txn-tax" checked={mode === "none"} onChange={() => void apply("")} disabled={busy} />
                  Not tax-related — leave this one out of the tax reports
                </label>
                <label className="flex items-center gap-1">
                  <input type="radio" name="txn-tax" checked={mode === "line"} onChange={() => void apply(row.tax_line || "Schedule A: Medical and dental expenses")} disabled={busy} />
                  On this line:
                </label>
                <div className="pl-5">
                  <TaxLinePicker value={mode === "line" ? row.tax_line ?? "" : ""} onChange={(line) => void apply(line || null)} label="Tax line for this transaction" disabled={busy} />
                </div>
                {taxLineError && (
                  <Notice tone="error" boxed>
                    {taxLineError}
                  </Notice>
                )}
                <div className="flex justify-end pt-2">
                  <button className="aero-btn default" type="button" onClick={() => setTaxLineFor(null)}>
                    Done
                  </button>
                </div>
              </div>
            </div>
          </>
        );
      })()}
    </section>
  );
}

/** Money offers the next statement one month after the last one. */
function nextStatementDate(last: Statement | null): string {
  const base = last ? new Date(`${last.statement_date}T00:00:00`) : new Date();
  if (last) base.setMonth(base.getMonth() + 1);
  return `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, "0")}-${String(
    base.getDate()
  ).padStart(2, "0")}`;
}

/** Money's reconcile grouping: Deposits / Checks / Other Withdrawals.
 *  A withdrawal whose Num is a check number (digits) is a Check; every
 *  other withdrawal — ATM, EFT, a card swipe — is Other. Rows already
 *  reconciled (`R`) are not on this statement and are left out, which is
 *  what "unreconciled" in the view's name means. Money states an empty group
 *  inline in its header rather than as a row. */
/** The check number to offer next — one past the highest numeric Num
 *  in the account, whatever came between. Null when no check has been
 *  written here. */
export function nextCheckNumber(rows: readonly { check_number?: string | null }[]): string | null {
  let max = -1;
  for (const r of rows) {
    const t = (r.check_number ?? "").trim();
    if (/^\d+$/.test(t)) max = Math.max(max, Number(t));
  }
  return max >= 0 ? String(max + 1) : null;
}

export function groupByDepositsAndWithdrawals(
  rows: readonly { id: string; amount_cents: number; check_number?: string | null; cleared_state?: string }[]
): RegisterGroup[] {
  const all = (rows as RegisterGroup["rows"]).filter((r) => r.cleared_state !== "R");
  const isCheck = (r: { check_number?: string | null }) =>
    /^\d+$/.test((r.check_number ?? "").trim());
  return [
    {
      label: "Deposits",
      emptyNote: "No transactions this period",
      rows: all.filter((r) => r.amount_cents > 0),
    },
    {
      label: "Checks",
      emptyNote: "No transactions this period",
      rows: all.filter((r) => r.amount_cents < 0 && isCheck(r)),
    },
    {
      label: "Other Withdrawals",
      emptyNote: "No transactions this period",
      rows: all.filter((r) => r.amount_cents < 0 && !isCheck(r)),
    },
  ];
}
