// Two things from earlier walkthroughs, in the shell rather than
// in one component:
//
// - N9: "I see Demo Old Checking … The rail (left bar) also shows it at the
//   bottom of the list with a 0.00 balance." A closed account is off the rail
//   and the Banking picker, and Account List → Show closed accounts finds it.
// - G7: "message should be red and … in the pop-up window, not in the
//   background just below Account List bar". A refused delete is shown inside
//   the confirm dialog, which stays open.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../src/test/tauriMock"));

import App from "./App";
import { useAccountStore } from "./stores/useAccountStore";
import { useBudgetStore } from "./stores/useBudgetStore";
import { resetIpc, setIpcHandlers } from "./test/tauriMock";
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
const HELOC = account("a-heloc", "Demo HELOC", { type: "home_equity_line_of_credit", balance_cents: -900_000 });
const OLD = account("a-old", "Demo Old Checking", { balance_cents: 0, is_closed: true });

function stubEverything(overrides: Record<string, () => unknown> = {}) {
  setIpcHandlers(
    new Proxy({} as Record<string, () => unknown>, {
      get: (_t, cmd: string) => () => {
        if (cmd in overrides) return overrides[cmd]();
        if (cmd === "get_all_accounts") return [CHECKING, HELOC, OLD];
        if (cmd === "get_db_info") return { db_path: "C:\\db", size_bytes: 1024, has_key: true };
        if (cmd === "get_key_status") return { has_key: true, source: "keyring" };
        if (cmd === "get_open_statement" || cmd === "get_last_statement") return null;
        if (cmd === "debts_by_asset") return {};
        if (cmd === "undo_status") return { undo: null, redo: null };
        return [];
      },
      has: () => true,
    })
  );
}

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
    accounts: [CHECKING, HELOC, OLD], favorites: [], transactions: [], register: [],
    categories: [], payees: [], selectedAccountId: null, error: null,
  });
  useBudgetStore.setState({ summary: [], budgets: [] });
});

describe("N9: a closed account stays out of the way", () => {
  it("is not on the rail, nor in the Banking account picker", async () => {
    await openAccountList();
    const rail = screen.getByRole("complementary", { name: "Money navigation" });
    await waitFor(() => expect(within(rail).getByText("Demo Checking")).toBeInTheDocument());
    expect(within(rail).queryByText("Demo Old Checking")).not.toBeInTheDocument();

    const picker = screen.getByLabelText("Account:");
    const names = within(picker).getAllByRole("option").map((o) => o.textContent);
    expect(names).toContain("Demo Checking");
    expect(names.some((n) => n?.includes("Demo Old Checking"))).toBe(false);
  });

  it("Account List hides it until Show closed accounts is ticked, then opens it", async () => {
    await openAccountList();
    expect(screen.queryByRole("button", { name: "Demo Old Checking" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Show closed accounts (1)"));
    const link = screen.getByRole("button", { name: "Demo Old Checking" });
    expect(link.closest("td")).toHaveTextContent("(closed)");

    await userEvent.click(link);
    await waitFor(() => expect(useAccountStore.getState().selectedAccountId).toBe("a-old"));
    // The picker still says where you are while you are in it.
    const picker = await screen.findByLabelText("Account:");
    expect(within(picker).getByRole("option", { name: "Demo Old Checking (closed)" })).toBeInTheDocument();
  });
});

describe("G7: a refused account delete is shown in its dialog", () => {
  it("in red, inside the dialog, which stays open", async () => {
    const refusal =
      "Demo HELOC cannot be deleted: 12 split payments send a line to it from another account. Take those lines out of their splits first, or mark the account closed in its details instead.";
    stubEverything({
      delete_account: () => {
        throw refusal;
      },
    });
    await openAccountList();
    await userEvent.click(await screen.findByRole("button", { name: "Delete Demo HELOC" }));
    const dlg = await screen.findByRole("dialog", { name: "Delete account" });
    await userEvent.click(within(dlg).getByRole("button", { name: "Delete" }));

    const alert = await within(dlg).findByRole("alert");
    expect(alert).toHaveTextContent("12 split payments send a line to it");
    expect(alert).toHaveClass("tm-notice-error");
    expect(screen.getByRole("dialog", { name: "Delete account" })).toBeInTheDocument();
    // Not written to the status line behind the dialog as well.
    expect(screen.queryAllByText(/cannot be deleted/)).toHaveLength(1);

    // Cancel, and a second try starts clean.
    await userEvent.click(within(dlg).getByRole("button", { name: "Cancel" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete Demo HELOC" }));
    const again = await screen.findByRole("dialog", { name: "Delete account" });
    expect(within(again).queryByRole("alert")).not.toBeInTheDocument();
  });
});
