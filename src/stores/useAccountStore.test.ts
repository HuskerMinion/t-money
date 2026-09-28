// useAccountStore — the zustand store that keeps account/register state in
// step with the backend. Every backend call is a mocked invoke().
import { beforeEach, describe, expect, it } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

import { useAccountStore } from "./useAccountStore";
import { invokeCalls, resetIpc, setIpcHandlers } from "../test/tauriMock";
import type { Account, NewTransaction, RegisterRow } from "../lib/types";

const checking: Account = {
  id: "acc-1",
  name: "Test Checking",
  type: "checking",
  balance_cents: 150000,
  holdings_value_cents: 0, tax_included: true,
  is_favorite: false,
  is_closed: false,
  updated_at: "2026-08-30T00:00:00Z",
  institution: null,
  account_number: null,
  routing_number: null,
  opened_on: null,
  credit_limit_cents: null,
  contact_phone: null,
  contact_email: null,
  website: null,
  address: null,
  account_notes: null,
};

const row = (over: Partial<RegisterRow> = {}): RegisterRow => ({
  id: "t-1",
  date: "2026-08-30",
  payee: "Grocery Store",
  category_name: "Groceries",
  category_id: "c-1",
  transfer_account_id: null,
  amount_cents: -4250,
  running_balance_cents: 145750,
  is_reconciled: false,
  cleared_state: "",
  check_number: null,
  is_void: false,
  notes: null,
  transfer_account_name: null,
  activity: null,
  security_id: null,
  security_name: null,
  shares_micro: null,
  price_micro: null,
  gross_cents: null,
  commission_cents: 0,
  lot_specified: false,
  goal_id: null,
  goal_name: null,
  ...over,
});

const initial = useAccountStore.getState();

beforeEach(() => {
  resetIpc();
  useAccountStore.setState(initial, true);
});

describe("loading", () => {
  it("loadAccounts stores the result and clears the loading flag", async () => {
    setIpcHandlers({ get_all_accounts: () => [checking] });
    await useAccountStore.getState().loadAccounts();
    const s = useAccountStore.getState();
    expect(s.accounts).toEqual([checking]);
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
  });

  it("loadAccounts captures a backend error instead of throwing", async () => {
    setIpcHandlers({
      get_all_accounts: () => {
        throw new Error("db locked");
      },
    });
    await expect(useAccountStore.getState().loadAccounts()).resolves.toBeUndefined();
    const s = useAccountStore.getState();
    expect(s.error).toContain("db locked");
    expect(s.loading).toBe(false);
    expect(s.accounts).toEqual([]);
  });

  it("loadRegister stores rows and clears registerLoading", async () => {
    setIpcHandlers({ get_register: () => [row()] });
    await useAccountStore.getState().loadRegister("acc-1");
    const s = useAccountStore.getState();
    expect(s.register).toHaveLength(1);
    expect(s.registerLoading).toBe(false);
  });

  it("loadRegister clears registerLoading on failure too", async () => {
    setIpcHandlers({
      get_register: () => {
        throw new Error("boom");
      },
    });
    await useAccountStore.getState().loadRegister("acc-1");
    expect(useAccountStore.getState().registerLoading).toBe(false);
    expect(useAccountStore.getState().error).toContain("boom");
  });
});

describe("selectAccount", () => {
  it("sets the selection and loads that account's register", async () => {
    setIpcHandlers({ get_register: () => [row()] });
    await useAccountStore.getState().selectAccount("acc-1");
    expect(useAccountStore.getState().selectedAccountId).toBe("acc-1");
    expect(invokeCalls).toContainEqual({
      cmd: "get_register",
      args: { accountId: "acc-1" },
    });
  });
});

describe("addAccount", () => {
  it("appends the created account to the list", async () => {
    setIpcHandlers({ create_account: () => checking });
    const created = await useAccountStore.getState().addAccount("Test Checking", "checking", 150000);
    expect(created).toEqual(checking);
    expect(useAccountStore.getState().accounts).toEqual([checking]);
  });
});

describe("toggleFavorite", () => {
  it("flips the flag optimistically and refreshes favorites", async () => {
    useAccountStore.setState({ accounts: [checking] });
    setIpcHandlers({
      set_favorite: () => null,
      get_favorite_accounts: () => [{ ...checking, is_favorite: true }],
    });
    await useAccountStore.getState().toggleFavorite("acc-1");
    expect(useAccountStore.getState().accounts[0].is_favorite).toBe(true);
    expect(useAccountStore.getState().favorites).toHaveLength(1);
    expect(invokeCalls[0]).toEqual({
      cmd: "set_favorite",
      args: { accountId: "acc-1", isFavorite: true },
    });
  });

  it("is a no-op for an unknown account id", async () => {
    await useAccountStore.getState().toggleFavorite("nope");
    expect(invokeCalls).toHaveLength(0);
  });
});

describe("addTransaction", () => {
  const payload: NewTransaction = {
    account_id: "acc-1",
    date: "2026-08-30",
    payee: "Grocery Store",
    category_id: null,
    amount_cents: -4250,
    notes: null,
    check_number: null,
  };

  it("adjusts the account balance by the transaction amount", async () => {
    useAccountStore.setState({ accounts: [checking] });
    setIpcHandlers({
      create_transaction: () => ({ id: "t-1", ...payload, is_reconciled: false }),
      undo_status: () => ({ undo: "add a transaction", redo: null }),
      list_payees: () => [],
    });
    await useAccountStore.getState().addTransaction(payload);
    expect(useAccountStore.getState().accounts[0].balance_cents).toBe(150000 - 4250);
  });

  it("reloads the register when the affected account is selected", async () => {
    useAccountStore.setState({ accounts: [checking], selectedAccountId: "acc-1" });
    setIpcHandlers({
      create_transaction: () => ({ id: "t-1", ...payload, is_reconciled: false }),
      undo_status: () => ({ undo: "add a transaction", redo: null }),
      get_register: () => [row()],
      list_payees: () => [],
    });
    await useAccountStore.getState().addTransaction(payload);
    // list_payees follows every write: the entry form's completion list and
    // category recall read it, so it must not lag a transaction behind (§17).
    // undo_status follows it too: the write is undoable, and the Edit menu's
    // label is stale until it is asked again (§101).
    expect(invokeCalls.map((c) => c.cmd)).toEqual([
      "create_transaction",
      "undo_status",
      "get_register",
      "list_payees",
    ]);
    expect(useAccountStore.getState().register).toHaveLength(1);
  });

  it("skips the register reload when a different account is selected", async () => {
    useAccountStore.setState({ accounts: [checking], selectedAccountId: "acc-2" });
    setIpcHandlers({
      create_transaction: () => ({ id: "t-1", ...payload, is_reconciled: false }),
      undo_status: () => ({ undo: "add a transaction", redo: null }),
      list_payees: () => [],
    });
    await useAccountStore.getState().addTransaction(payload);
    expect(invokeCalls.map((c) => c.cmd)).toEqual(["create_transaction", "undo_status", "list_payees"]);
  });

  it("leaves other accounts' balances alone", async () => {
    const savings: Account = { ...checking, id: "acc-2", name: "Savings", balance_cents: 500000 };
    useAccountStore.setState({ accounts: [checking, savings] });
    setIpcHandlers({
      create_transaction: () => ({ id: "t-1", ...payload, is_reconciled: false }),
      undo_status: () => ({ undo: "add a transaction", redo: null }),
      list_payees: () => [],
    });
    await useAccountStore.getState().addTransaction(payload);
    expect(useAccountStore.getState().accounts[1].balance_cents).toBe(500000);
  });
});

describe("§155 — reloadAll comes back to where the user was", () => {
  it("keeps the selected account and refetches its register", async () => {
    setIpcHandlers({
      get_all_accounts: () => [checking],
      list_categories: () => [],
      list_payees: () => [],
      get_register: () => [row()],
    });
    useAccountStore.setState({ accounts: [checking], selectedAccountId: "acc-1", register: [] });
    await useAccountStore.getState().reloadAll();
    expect(useAccountStore.getState().selectedAccountId).toBe("acc-1");
    expect(useAccountStore.getState().register).toHaveLength(1);
    expect(invokeCalls).toContainEqual({ cmd: "get_register", args: { accountId: "acc-1" } });
  });

  it("drops a selection the reload no longer has (a restore, say)", async () => {
    setIpcHandlers({
      get_all_accounts: () => [],
      list_categories: () => [],
      list_payees: () => [],
    });
    useAccountStore.setState({ accounts: [checking], selectedAccountId: "acc-1" });
    await useAccountStore.getState().reloadAll();
    expect(useAccountStore.getState().selectedAccountId).toBeNull();
    expect(invokeCalls.map((c) => c.cmd)).not.toContain("get_register");
  });
});

// §183 — update_transfer is recorded for undo like every other edit, and the
// store never told the Edit menu.
describe("§183 — editTransfer tells the undo menu", () => {
  it("asks for the undo status again after the write", async () => {
    setIpcHandlers({
      update_transfer: () => null,
      get_all_accounts: () => [checking],
      undo_status: () => ({ undo: "edit a transfer", redo: null }),
    });
    await useAccountStore.getState().editTransfer("t-1", "2026-08-30", "acc-2", 500, null);
    await vi.waitFor(() => expect(invokeCalls.map((c) => c.cmd)).toContain("undo_status"));
  });
});
