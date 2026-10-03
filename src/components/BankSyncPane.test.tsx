// Settings → Money → Bank sync: what each state offers, what may be linked,
// and that SimpleFIN's own messages reach the screen. (The credential never
// reaches the frontend at all: no command returns it.)
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));
const eventHandlers = new Map<string, (e: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (e: { payload: unknown }) => void) => {
    eventHandlers.set(name, cb);
    return Promise.resolve(() => eventHandlers.delete(name));
  },
}));

import BankSyncPane, { fillable } from "./BankSyncPane";
import { invokeCalls, resetIpc, setIpcHandlers } from "../test/tauriMock";
import { useAccountStore } from "../stores/useAccountStore";
import type { Account, SimplefinAccount, SimplefinStatus } from "../lib/types";

function acct(id: string, name: string, extra: Partial<Account> = {}): Account {
  return { id, name, type: "checking", balance_cents: 0, is_closed: false, currency: "USD", ...extra } as Account;
}

function sf(sf_id: string, name: string, extra: Partial<SimplefinAccount> = {}): SimplefinAccount {
  return {
    sf_id,
    name,
    org: "Example Bank",
    currency: "USD",
    balance_cents: 123_456,
    balance_date: "2026-10-02",
    account_id: null,
    account_name: null,
    synced_through: null,
    ...extra,
  };
}

function status(extra: Partial<SimplefinStatus> = {}): SimplefinStatus {
  return { connected: true, server: "bridge.example.org", accounts: [], requests_today: 2, daily_limit: 20, messages: [], ...extra };
}

const checking = acct("a-chk", "Checking");
const savings = acct("a-sav", "Savings", { type: "savings" });
const brokerage = acct("a-brk", "Brokerage", { type: "investment" });
const euro = acct("a-eur", "Euro", { currency: "EUR" });
const closed = acct("a-old", "Old", { is_closed: true });

describe("fillable", () => {
  it("offers open cash accounts in the same currency that nothing else fills", () => {
    const all = [sf("A", "Everyday", { account_id: "a-sav" }), sf("B", "Other")];
    const names = (s: SimplefinAccount) => fillable(s, [checking, savings, brokerage, euro, closed], all).map((a) => a.name);
    expect(names(all[1])).toEqual(["Checking"]);
    // Its own link stays offered.
    expect(names(all[0])).toEqual(["Checking", "Savings"]);
    expect(names(sf("C", "Euro side", { currency: "EUR" }))).toEqual(["Euro"]);
  });
});

describe("ProgressBar", () => {
  it("fills as the backend names each account, and says which", async () => {
    const { ProgressBar } = await import("./BankSyncPane");
    render(<ProgressBar progress={{ label: "Importing Savings (2 of 3)…", share: 0.5 }} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByText("Importing Savings (2 of 3)…")).toBeInTheDocument();
  });

  it("turns events into words", async () => {
    resetIpc();
    let release: (v: unknown) => void = () => {};
    setIpcHandlers({
      simplefin_status: () => status({ accounts: [sf("A", "Everyday", { account_id: "a-chk", account_name: "Checking" })] }),
      simplefin_sync: () => new Promise((r) => (release = r)),
    });
    render(<BankSyncPane />);
    fireEvent.click(await screen.findByRole("button", { name: "Get bank transactions" }));
    await waitFor(() => expect(eventHandlers.has("tm://simplefin-progress")).toBe(true));
    act(() => eventHandlers.get("tm://simplefin-progress")!({ payload: { done: 1, total: 3, account: "Savings" } }));
    expect(screen.getByRole("progressbar")).toHaveAccessibleName("Importing Savings (2 of 3)…");
    release({ lines: [], messages: [], unlinked: 0, from: "2026-07-07", to: "2026-10-03" });
  });
});

describe("BankSyncPane", () => {
  beforeEach(() => {
    resetIpc();
    useAccountStore.setState({ accounts: [checking, savings], selectedAccountId: null });
  });

  it("asks for a setup token when not connected, and clears it after", async () => {
    let s = status({ connected: false, server: null });
    setIpcHandlers({
      simplefin_status: () => s,
      simplefin_connect: () => {
        s = status({ accounts: [sf("A", "Everyday"), sf("P", "Points", { currency: null, balance_cents: null })] });
        return { ...s, messages: ["Example Bank needs you to sign in again."] };
      },
    });
    render(<BankSyncPane />);
    const box = await screen.findByLabelText("SimpleFIN setup token");
    fireEvent.change(box, { target: { value: "  dG9rZW4=  " } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText("bridge.example.org");
    expect(invokeCalls.find((c) => c.cmd === "simplefin_connect")?.args).toEqual({ setupToken: "dG9rZW4=" });
    expect(screen.queryByLabelText("SimpleFIN setup token")).toBeNull();
    expect(screen.getByLabelText("T-Money account for Everyday")).toBeInTheDocument();
    // The server's message is shown, and an account in a currency T-Money
    // cannot keep is listed but cannot be linked.
    expect(screen.getByText(/SimpleFIN says: Example Bank needs you to sign in again\./)).toBeInTheDocument();
    expect(screen.getByText("Not a currency T-Money keeps")).toBeInTheDocument();
    expect(screen.queryByLabelText("T-Money account for Points")).toBeNull();
  });

  it("keeps the pasted token when connecting fails", async () => {
    setIpcHandlers({
      simplefin_status: () => status({ connected: false, server: null }),
      simplefin_connect: () => {
        throw "No file is open.";
      },
    });
    render(<BankSyncPane />);
    const box = await screen.findByLabelText("SimpleFIN setup token");
    fireEvent.change(box, { target: { value: "dG9rZW4=" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText("No file is open.");
    expect(screen.getByLabelText("SimpleFIN setup token")).toHaveValue("dG9rZW4=");
  });

  it("links an account and fetches, then shows what came in", async () => {
    let s = status({ accounts: [sf("A", "Everyday")] });
    setIpcHandlers({
      simplefin_status: () => s,
      simplefin_link: (args) => {
        s = status({ accounts: [sf("A", "Everyday", { account_id: args.accountId as string, account_name: "Checking" })] });
        return s;
      },
      // A moment, as a real fetch takes, so the bar can be seen.
      simplefin_sync: () =>
        new Promise((r) => setTimeout(() => r({
        lines: [{ sf_name: "Everyday", account_id: "a-chk", account_name: "Checking", imported: 3, matched: 2, duplicates: 1, bank_balance_cents: 123_456, balance_cents: 120_000, error: null, note: null }],
        messages: ["Example Bank needs you to sign in again."],
        unlinked: 0,
        from: "2026-07-07",
        to: "2026-10-03",
      }), 30)),
      get_all_accounts: () => [checking, savings],
      list_payees: () => [],
      list_categories: () => [],
      undo_status: () => ({ undo: "get bank transactions", redo: null }),
    });
    render(<BankSyncPane />);
    const get = await screen.findByRole("button", { name: "Get bank transactions" });
    expect(get).toBeDisabled();
    fireEvent.change(screen.getByLabelText("T-Money account for Everyday"), { target: { value: "a-chk" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Get bank transactions" })).toBeEnabled());
    expect(invokeCalls.find((c) => c.cmd === "simplefin_link")?.args).toEqual({ sfId: "A", accountId: "a-chk" });
    fireEvent.click(screen.getByRole("button", { name: "Get bank transactions" }));
    // Waiting on SimpleFIN: a bar with no value yet, and words for it.
    const waiting = await screen.findByRole("progressbar");
    expect(waiting).toHaveAccessibleName(/Asking SimpleFIN for 1 account/);
    expect(waiting).not.toHaveAttribute("aria-valuenow");
    const result = await screen.findByLabelText("Bank sync result");
    // Done: the bar is gone.
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(result).toHaveTextContent("3 new, 2 matched to ones you entered, 1 already there.");
    expect(result).toHaveTextContent("The bank says $1,234.56; T-Money says $1,200.00.");
    expect(result).toHaveTextContent("SimpleFIN says: Example Bank needs you to sign in again.");
  });

  it("stops offering requests once the day's are spent, and disconnects only on a second click", async () => {
    let s = status({ accounts: [sf("A", "Everyday", { account_id: "a-chk", account_name: "Checking" })], requests_today: 20 });
    setIpcHandlers({
      simplefin_status: () => s,
      simplefin_disconnect: () => {
        s = status({ connected: false, server: null });
        return s;
      },
    });
    render(<BankSyncPane />);
    expect(await screen.findByRole("button", { name: "Get bank transactions" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Check for new accounts" })).toBeDisabled();
    expect(screen.getByText(/as many as T-Money makes/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(invokeCalls.some((c) => c.cmd === "simplefin_disconnect")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Yes, disconnect" }));
    await screen.findByLabelText("SimpleFIN setup token");
  });
});
