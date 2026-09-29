// The writes that cannot be undone must empty the undo stack.
//
// An earlier change established the rule and applied it to the four import commands. The
// two operations named alongside imports — deleting an account and
// merging two accounts — were left standing, which is the same bug in the
// same shape: Ctrl+Z afterwards does not take back the delete (nothing can),
// it reaches PAST it and takes back the edit you made before it, while the
// delete stays.
//
// The backend half is one call to `undo_stack_invalidated` and has no unit
// test, for the usual reason: it lives in the command layer, where
// `State<AppState>` is not constructible. It is walkthrough step **I4**.
//
// What IS testable is the half that has broken before: the frontend must ask
// the backend again afterwards. The undo label is cached in `lib/undo.ts`, so
// a backend that emptied its stack and a menu that was never told leaves an
// Undo item still naming a step that no longer exists. That is what this
// asserts — an `undo_status` call AFTER the write, not merely one somewhere,
// because the app makes one on mount.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../src/test/tauriMock"));

import App from "./App";
import { useAccountStore } from "./stores/useAccountStore";
import { useBudgetStore } from "./stores/useBudgetStore";
import { invokeCalls, resetIpc, setIpcHandlers } from "./test/tauriMock";
import type { Account } from "./lib/types";

const account = (id: string, name: string): Account => ({
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
});

const CHECKING = account("a-chk", "Demo Checking");
const SAVINGS = account("a-sav", "Demo Savings");

/** Every command answers benignly; these tests care about one call order. */
function stubEverything(overrides: Record<string, () => unknown> = {}) {
  setIpcHandlers(
    new Proxy({} as Record<string, () => unknown>, {
      get: (_t, cmd: string) => () => {
        if (cmd in overrides) return overrides[cmd]();
        if (cmd === "get_all_accounts") return [CHECKING, SAVINGS];
        if (cmd === "get_db_info") return { db_path: "C:\\db", size_bytes: 1024, has_key: true };
        if (cmd === "get_key_status") return { has_key: true, source: "keyring" };
        if (cmd === "get_open_statement" || cmd === "get_last_statement") return null;
        if (cmd === "debts_by_asset") return {};
        // The stack has something on it until one of these writes runs; the
        // label is what the menu would show, and what must stop being shown.
        if (cmd === "undo_status") return { undo: "Undo edit a transaction", redo: null };
        return [];
      },
      has: () => true,
    })
  );
}

/** Where in the call log a command last appeared, or -1. Order is the whole
 *  point here: `undo_status` runs on mount too, so "it was called" proves
 *  nothing. */
function lastCall(cmd: string): number {
  return invokeCalls.reduce((last, c, i) => (c.cmd === cmd ? i : last), -1);
}

/** Banking → Account List, which is where both buttons live. */
async function openAccountList() {
  render(<App />);
  await userEvent.click(screen.getByRole("button", { name: "Banking" }));
  await userEvent.click(await screen.findByRole("button", { name: "Account List" }));
  await screen.findByText(/Click the account you want to use/);
}

beforeEach(() => {
  resetIpc();
  stubEverything();
  useAccountStore.setState({
    accounts: [CHECKING, SAVINGS], favorites: [], transactions: [], register: [],
    categories: [], payees: [], selectedAccountId: null, error: null,
  });
  useBudgetStore.setState({ summary: [], budgets: [] });
});

describe("A write that cannot be undone invalidates what came before", () => {
  it("re-reads the undo status after deleting an account", async () => {
    stubEverything({ delete_account: () => null });
    await openAccountList();

    await userEvent.click(await screen.findByRole("button", { name: "Delete Demo Checking" }));
    const dlg = await screen.findByRole("dialog", { name: "Delete account" });
    // The dialog says the second consequence out loud, not only the first.
    expect(within(dlg).getByText(/was holding is cleared as well/)).toBeInTheDocument();

    await userEvent.click(within(dlg).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(lastCall("delete_account")).toBeGreaterThan(-1));
    await waitFor(() =>
      expect(lastCall("undo_status")).toBeGreaterThan(lastCall("delete_account"))
    );
  });

  it("re-reads the undo status after merging one account into another", async () => {
    const summary = {
      moved: 12, duplicates: 0, self_transfers: 0, left_behind: 1,
      statements: 0, recurrences: 0, goals: 0, balance_cents: 500_000,
    };
    stubEverything({ merge_accounts: () => summary });
    await openAccountList();

    await userEvent.click(await screen.findByRole("button", { name: "Merge Demo Checking" }));
    const dlg = await screen.findByRole("dialog", { name: "Merge accounts" });
    // The dry run has to land before Merge is live — it is what the button
    // is waiting on, and clicking early would assert nothing.
    await within(dlg).findByLabelText("What will happen");

    await userEvent.click(within(dlg).getByRole("button", { name: "Merge" }));

    await waitFor(() => expect(lastCall("merge_accounts")).toBeGreaterThan(-1));
    await waitFor(() =>
      expect(lastCall("undo_status")).toBeGreaterThan(lastCall("merge_accounts"))
    );
  });
});
