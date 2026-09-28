// Account UI state, synchronized with the Rust backend via Tauri IPC.
import { create } from "zustand";
import { api } from "../lib/ipc";
import { noteChanged } from "../lib/undo";
import type {
  Account,
  AccountDetails,
  AccountType,
  Category,
  CategoryKind,
  NewTransaction,
  Payee,
  RegisterRow,
  Transaction,
  UpdateTransaction,
} from "../lib/types";

interface AccountState {
  accounts: Account[];
  favorites: Account[];
  transactions: Transaction[];
  register: RegisterRow[];
  categories: Category[];
  registerLoading: boolean;
  selectedAccountId: string | null;
  loading: boolean;
  error: string | null;

  loadAccounts: () => Promise<void>;
  loadFavorites: () => Promise<void>;
  /** Everything, from scratch — after a restore or a seed, when the rows
   *  behind every cached id may have changed or gone. */
  reloadAll: () => Promise<void>;
  loadTransactions: (accountId: string) => Promise<void>;
  loadRegister: (accountId: string) => Promise<void>;
  selectAccount: (id: string) => Promise<void>;
  addAccount: (
    name: string,
    type: AccountType,
    openingBalanceCents: number,
    openedOn?: string
  ) => Promise<Account>;
  toggleFavorite: (accountId: string) => Promise<void>;
  /** §169 — put the accounts in this order everywhere they are listed. */
  reorderAccounts: (ids: string[]) => Promise<void>;
  addTransaction: (payload: NewTransaction) => Promise<Transaction>;
  editTransaction: (payload: UpdateTransaction) => Promise<Transaction>;
  removeTransaction: (id: string, accountId: string) => Promise<void>;
  /** Edit a transfer in place — both halves, including moving the other side
   *  to a different account. */
  editTransfer: (
    id: string,
    date: string,
    otherAccountId: string,
    amountCents: number,
    notes: string | null
  ) => Promise<void>;
  updateAccountDetails: (details: AccountDetails) => Promise<Account>;
  /** Bumped when something outside the register asks to start reconciling
   *  (the "Reconcile" rail item). AccountRegister watches it. */
  /** A one-shot request from the rail's "Reconcile" item. Non-zero means
   *  "open the reconcile wizard once"; the register must call
   *  `ackReconcileRequest` when it acts on it. It is NOT a counter to compare
   *  against — see the bug in §26.1. */
  reconcileRequest: number;
  requestReconcile: () => void;
  /** Clear the request once the register has acted on it. */
  ackReconcileRequest: () => void;
  /** A row the register should select and scroll to once it has loaded —
   *  set by a Search result (§38). Consumed by the register. */
  pendingRowId: string | null;
  focusRow: (id: string | null) => void;
  loadCategories: () => Promise<void>;
  addCategory: (
    name: string,
    kind: CategoryKind,
    parentId?: string | null,
    taxLine?: string | null
  ) => Promise<Category>;
  editCategory: (
    id: string,
    name: string,
    kind: CategoryKind,
    parentId: string | null,
    taxLine: string | null
  ) => Promise<Category>;
  /** `reassignTo` refiles everything that used it; null leaves it orphaned. */
  removeCategory: (id: string, reassignTo: string | null) => Promise<void>;
  mergeCategories: (fromId: string, intoId: string) => Promise<void>;
  /** Add the standard chart. Resolves to how many were created. */
  seedStandardCategories: () => Promise<number>;

  payees: Payee[];
  loadPayees: () => Promise<void>;
  editPayee: (
    id: string,
    name: string,
    lastCategoryId: string | null
  ) => Promise<void>;
  addPayee: (name: string, lastCategoryId: string | null) => Promise<void>;
  mergePayees: (fromId: string, intoId: string) => Promise<void>;
  removePayee: (id: string) => Promise<void>;
}

export const useAccountStore = create<AccountState>((set, get) => ({
  accounts: [],
  favorites: [],
  transactions: [],
  register: [],
  categories: [],
  payees: [],
  reconcileRequest: 0,
  registerLoading: false,
  selectedAccountId: null,
  loading: false,
  error: null,

  loadAccounts: async () => {
    set({ loading: true, error: null });
    try {
      const accounts = await api.getAllAccounts();
      // `favorites` is a second copy of the same rows (same order: both
      // queries sort by name). Every balance change reloads `accounts`, and
      // the Home page reads `favorites` — which used to be loaded once, at
      // mount, so Favorite Accounts showed last session's balances until
      // something unrelated refreshed it.
      set({ accounts, favorites: accounts.filter((a) => a.is_favorite), loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  reloadAll: async () => {
    // §155 — come back to where the user was. This used to clear the selection
    // outright, so finishing a TSP import with the TSP register on screen
    // left "Select an account" and made the user find it again to see what the
    // import did. The account is kept if it still exists after the reload
    // (after a restore it may not), and its register is fetched afresh.
    const keep = get().selectedAccountId;
    set({ register: [], transactions: [] });
    await Promise.all([get().loadAccounts(), get().loadCategories(), get().loadPayees()]);
    if (!keep) return;
    if (get().accounts.some((a) => a.id === keep)) await get().loadRegister(keep);
    else set({ selectedAccountId: null });
  },

  loadFavorites: async () => {
    try {
      const favorites = await api.getFavoriteAccounts();
      set({ favorites });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  loadTransactions: async (accountId) => {
    set({ loading: true, error: null });
    try {
      const transactions = await api.getTransactions(accountId, 200);
      set({ transactions, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  loadRegister: async (accountId) => {
    set({ registerLoading: true, error: null });
    try {
      const register = await api.getRegister(accountId);
      // Two selections in quick succession: a slow reply for the first must
      // not land under the second account's name.
      if (get().selectedAccountId !== null && get().selectedAccountId !== accountId) return;
      set({ register, registerLoading: false });
    } catch (e) {
      set({ error: String(e), registerLoading: false });
    }
  },

  selectAccount: async (id) => {
    if (get().selectedAccountId !== id) set({ selectedAccountId: id, register: [] });
    await get().loadRegister(id);
  },

  addAccount: async (name, type, openingBalanceCents, openedOn) => {
    const account = await api.createAccount(name, type, openingBalanceCents, openedOn);
    set((s) => ({ accounts: [...s.accounts, account] }));
    return account;
  },

  reorderAccounts: async (ids) => {
    await api.setAccountOrder(ids);
    await get().loadAccounts();
  },

  toggleFavorite: async (accountId) => {
    const acc = get().accounts.find((a) => a.id === accountId);
    if (!acc) return;
    await api.setFavorite(accountId, !acc.is_favorite);
    set((s) => ({
      accounts: s.accounts.map((a) =>
        a.id === accountId ? { ...a, is_favorite: !a.is_favorite } : a
      ),
    }));
    await get().loadFavorites();
  },

  updateAccountDetails: async (details) => {
    const updated = await api.updateAccount(details);
    set((s) => ({
      accounts: s.accounts.map((a) => (a.id === updated.id ? updated : a)),
    }));
    await get().loadFavorites();
    return updated;
  },

  pendingRowId: null,
  focusRow: (id) => set({ pendingRowId: id }),

  requestReconcile: () => set((s) => ({ reconcileRequest: s.reconcileRequest + 1 })),
  ackReconcileRequest: () => set({ reconcileRequest: 0 }),

  loadCategories: async () => {
    try {
      const categories = await api.listCategories();
      set({ categories });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  addCategory: async (name, kind, parentId = null, taxLine = null) => {
    const category = await api.createCategory(name, kind, parentId, taxLine);
    // Reload rather than push: the backend computes full_name and orders the
    // tree, and a new subcategory changes where its siblings sort.
    await get().loadCategories();
    return category;
  },

  editCategory: async (id, name, kind, parentId, taxLine) => {
    const category = await api.updateCategory(id, name, kind, parentId, taxLine);
    await get().loadCategories();
    // A rename or a re-file changes what the register shows for every
    // transaction under it.
    const accountId = get().selectedAccountId;
    if (accountId) await get().loadRegister(accountId);
    return category;
  },

  removeCategory: async (id, reassignTo) => {
    await api.deleteCategory(id, reassignTo);
    // §179 — a delete is on the undo stack too now, like the merge below.
    noteChanged();
    await get().loadCategories();
    const accountId = get().selectedAccountId;
    if (accountId) await get().loadRegister(accountId);
  },

  mergeCategories: async (fromId, intoId) => {
    await api.mergeCategories(fromId, intoId);
    // §133 — a merge is on the undo stack now, so the Edit menu has to hear
    // about it like every other write does.
    noteChanged();
    await get().loadCategories();
    const accountId = get().selectedAccountId;
    if (accountId) await get().loadRegister(accountId);
  },

  seedStandardCategories: async () => {
    const created = await api.seedStandardCategories();
    await get().loadCategories();
    return created;
  },

  editTransfer: async (id, date, otherAccountId, amountCents, notes) => {
    await api.updateTransfer(id, date, otherAccountId, amountCents, notes);
    // §183 — the backend records "edit a transfer" like every other edit;
    // without this the Edit menu kept naming the step before it.
    noteChanged();
    // Both halves moved, and possibly between accounts — reload the lot
    // rather than trying to patch two balances locally.
    const accountId = get().selectedAccountId;
    if (accountId) await get().loadRegister(accountId);
    await get().loadAccounts();
  },

  loadPayees: async () => {
    try {
      const payees = await api.listPayees();
      set({ payees });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  editPayee: async (id, name, lastCategoryId) => {
    await api.updatePayee(id, name, lastCategoryId);
    // §186 — a rename is on the undo stack now, like a merge.
    noteChanged();
    await get().loadPayees();
    // The register shows the denormalized payee text, which the rename
    // rewrote — reload it or the old name lingers on screen.
    const accountId = get().selectedAccountId;
    if (accountId) await get().loadRegister(accountId);
  },

  addPayee: async (name, lastCategoryId) => {
    await api.createPayee(name, lastCategoryId);
    await get().loadPayees();
  },

  mergePayees: async (fromId, intoId) => {
    await api.mergePayees(fromId, intoId);
    // §186 — on the undo stack now, like a category merge (§133); without
    // this the Edit menu went on naming the step before the merge.
    noteChanged();
    await get().loadPayees();
    const accountId = get().selectedAccountId;
    if (accountId) await get().loadRegister(accountId);
  },

  removePayee: async (id) => {
    await api.deletePayee(id);
    // §186 — so is deleting an unused payee.
    noteChanged();
    await get().loadPayees();
  },

  /** Edit a transaction in place (§6.1b). The amount may change, so the
   *  account balance and the running-balance register are both refreshed
   *  from the backend rather than patched locally. */
  editTransaction: async (payload) => {
    const txn = await api.updateTransaction(payload);
    // §101: the backend recorded a step for this; the menu's label changes.
    noteChanged();
    const accountId = get().selectedAccountId;
    if (accountId) {
      await get().loadRegister(accountId);
      await get().loadAccounts();
    }
    await get().loadPayees();
    return txn;
  },

  removeTransaction: async (id, accountId) => {
    await api.deleteTransaction(id);
    noteChanged();
    if (get().selectedAccountId === accountId) {
      await get().loadRegister(accountId);
    }
    await get().loadAccounts();
  },

  addTransaction: async (payload) => {
    const txn = await api.createTransaction(payload);
    noteChanged();
    // Refresh the affected account's balance + register (running balance).
    const bump = (a: Account) =>
      a.id === payload.account_id
        ? { ...a, balance_cents: a.balance_cents + payload.amount_cents }
        : a;
    set((s) => ({
      accounts: s.accounts.map(bump),
      favorites: s.favorites.map(bump),
    }));
    if (get().selectedAccountId === payload.account_id) {
      await get().loadRegister(payload.account_id);
    }
    // Every write creates or updates a payee now (§16), so the completion
    // list and the category recall would otherwise be one entry behind.
    await get().loadPayees();
    return txn;
  },
}));
