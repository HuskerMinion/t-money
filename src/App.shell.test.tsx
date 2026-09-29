// What a code review found in the shell: refusals that showed nothing,
// a selection left pointing at an account that is gone, a reset that missed
// two fields, and File menu items that were gray almost all the time.
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../src/test/tauriMock"));

import App from "./App";
import { runCommand } from "./lib/commands";
import { forgetUndo } from "./lib/undo";
import { useAccountStore } from "./stores/useAccountStore";
import { useBudgetStore } from "./stores/useBudgetStore";
import { invokeCalls, resetIpc, setIpcHandlers } from "./test/tauriMock";
import type { Account } from "./lib/types";

const account = (id: string, name: string, over: Partial<Account> = {}): Account => ({
  id,
  name,
  type: "checking",
  balance_cents: 250_000,
  holdings_value_cents: 0,
  tax_included: true,
  is_favorite: false,
  is_closed: false,
  updated_at: "",
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
  ...over,
});

const CHECKING = account("a-chk", "Demo Checking");
const SAVINGS = account("a-sav", "Demo Savings");
// Sorts first, and is closed — the rail does not list it.
const OLD = account("a-old", "Aardvark Old Checking", { balance_cents: 0, is_closed: true });

const BACKUP_CFG = { enabled: false, on_exit: false, folder: "D:\\Backups", keep: 10, last_at: null, existing: [] };

function stubEverything(overrides: Record<string, () => unknown> = {}) {
  setIpcHandlers(
    new Proxy({} as Record<string, () => unknown>, {
      get: (_t, cmd: string) => () => {
        if (cmd in overrides) return overrides[cmd]();
        if (cmd === "get_all_accounts") return [CHECKING, SAVINGS];
        if (cmd === "get_db_info") return { db_path: "C:\\db", size_bytes: 1024, has_key: true };
        if (cmd === "get_key_status") return { has_key: true, source: "keyring" };
        if (cmd === "get_backup_config") return BACKUP_CFG;
        if (cmd === "get_open_statement" || cmd === "get_last_statement") return null;
        if (cmd === "debts_by_asset") return {};
        if (cmd === "undo_status") return { undo: null, redo: null };
        if (cmd === "get_ui_setting" || cmd === "price_status") return null;
        return [];
      },
      has: () => true,
    })
  );
}

beforeEach(() => {
  resetIpc();
  forgetUndo();
  stubEverything();
  window.localStorage.removeItem("tm.settingsPane");
  useAccountStore.setState({
    accounts: [CHECKING, SAVINGS], favorites: [], transactions: [], register: [],
    categories: [], payees: [], selectedAccountId: null, pendingRowId: null, error: null,
  });
  useBudgetStore.setState({ summary: [], budgets: [] });
});

describe("A refused undo says why", () => {
  it("shows the backend's refusal in an error notice", async () => {
    stubEverything({
      undo_status: () => ({ undo: "delete a transaction", redo: null }),
      undo_last: () => {
        throw "the account that transaction was in has been deleted";
      },
    });
    render(<App />);
    await screen.findByRole("menubar", { name: "Main menu" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    const item = await screen.findByRole("menuitem", { name: /^Undo/ });
    await waitFor(() => expect(item).toBeEnabled());
    await user.click(item);
    const alert = await screen.findByText(/Could not undo: the account that transaction was in has been deleted/);
    expect(alert.closest("[role=alert]")).not.toBeNull();
  });
});

describe("The account store's error is shown", () => {
  it("a failed account load reads as an error, not an empty file", async () => {
    stubEverything({
      get_all_accounts: () => {
        throw "database is locked";
      },
    });
    render(<App />);
    const text = await screen.findByText("database is locked");
    expect(text.closest("[role=alert]")).not.toBeNull();
    await userEvent.click(within(text.closest("[role=alert]") as HTMLElement).getByRole("button", { name: "Dismiss" }));
    expect(useAccountStore.getState().error).toBeNull();
  });
});

describe("File → Close lets go of everything about the file", () => {
  it("clears favorites and the pending row as well as the accounts", async () => {
    useAccountStore.setState({ favorites: [CHECKING], pendingRowId: "t-42" });
    render(<App />);
    await screen.findByRole("menubar", { name: "Main menu" });
    await act(async () => {
      runCommand("file.close");
    });
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "close_file")).toBe(true));
    const s = useAccountStore.getState();
    expect(s.favorites).toEqual([]);
    expect(s.pendingRowId).toBeNull();
  });
});

describe("An account that is gone is not left selected", () => {
  it("deleting the selected account clears the selection and its register", async () => {
    let deleted = false;
    stubEverything({
      delete_account: () => {
        deleted = true;
        return null;
      },
      get_all_accounts: () => (deleted ? [SAVINGS] : [CHECKING, SAVINGS]),
    });
    useAccountStore.setState({ selectedAccountId: "a-chk" });
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Banking" }));
    await userEvent.click(await screen.findByRole("button", { name: "Account List" }));
    await userEvent.click(await screen.findByRole("button", { name: "Delete Demo Checking" }));
    const dlg = await screen.findByRole("dialog", { name: "Delete account" });
    await userEvent.click(within(dlg).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Delete account" })).toBeNull());
    expect(useAccountStore.getState().selectedAccountId).toBeNull();
    expect(useAccountStore.getState().register).toEqual([]);
  });

  it("rail Transactions with nothing selected opens the first OPEN account", async () => {
    stubEverything({ get_all_accounts: () => [OLD, CHECKING], get_account: () => CHECKING });
    useAccountStore.setState({ accounts: [OLD, CHECKING] });
    render(<App />);
    const rail = screen.getByRole("complementary", { name: "Money navigation" });
    await userEvent.click(within(rail).getByText("Transactions"));
    await waitFor(() => expect(useAccountStore.getState().selectedAccountId).toBe("a-chk"));
  });
});

describe("File → Back up now and Verify work with Settings closed", () => {
  it("are live in the File menu without Settings open", async () => {
    render(<App />);
    await screen.findByRole("menubar", { name: "Main menu" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("menuitem", { name: "File" }));
    expect(screen.getByRole("menuitem", { name: /Back up now/ })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: /Verify this file/ })).toBeEnabled();
  });

  it("Back up now opens Settings on Backups and backs up, into the folder already chosen", async () => {
    stubEverything({ backup_now: () => "D:\\Backups\\t-money-2026-09-15.db" });
    render(<App />);
    await screen.findByRole("menubar", { name: "Main menu" });
    await act(async () => {
      runCommand("file.backup");
    });
    const dlg = await screen.findByRole("dialog", { name: "Settings" });
    expect(within(dlg).getByRole("tab", { name: "Backups" })).toHaveAttribute("aria-selected", "true");
    expect(await within(dlg).findByText(/Backed up to D:\\Backups\\t-money-2026-09-15.db/)).toBeInTheDocument();
    expect(invokeCalls.filter((c) => c.cmd === "backup_now")).toHaveLength(1);
  });

  it("Verify this file opens Settings on Verify and runs the check once", async () => {
    stubEverything({
      verify_file: () => ({ integrity: [], foreign_keys: [], drift: [], half_transfers: [], split_mismatch: [], split_transfers: [], accounts: 2, transactions: 10, repaired: [] }),
    });
    render(<App />);
    await screen.findByRole("menubar", { name: "Main menu" });
    await act(async () => {
      runCommand("file.verify");
    });
    const dlg = await screen.findByRole("dialog", { name: "Settings" });
    expect(await within(dlg).findByRole("status", { name: "File check results" })).toHaveTextContent("Everything checks out.");
    expect(invokeCalls.filter((c) => c.cmd === "verify_file")).toHaveLength(1);
  });
});
