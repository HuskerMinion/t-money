// Settings → Money → Bank sync: what each state offers, what may be linked,
// and that SimpleFIN's own messages reach the screen. (The credential never
// reaches the frontend at all: no command returns it.)
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));
const eventHandlers = new Map<string, (e: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (e: { payload: unknown }) => void) => {
    eventHandlers.set(name, cb);
    return Promise.resolve(() => eventHandlers.delete(name));
  },
}));

import BankSyncPane, { daysAgoIso, fillable, guessType } from "./BankSyncPane";
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
    currency_missing: false,
    currency_confirmed: null,
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
const brokerage = acct("a-brk", "Brokerage", { type: "investment", holdings_value_cents: 6_151_763 });
const k401 = acct("a-401", "401(k)", { type: "retirement", holdings_value_cents: 0 });
const euro = acct("a-eur", "Euro", { currency: "EUR" });
const closed = acct("a-old", "Old", { is_closed: true });

describe("fillable", () => {
  it("offers open accounts in the same currency that nothing else fills, and no account holding shares", () => {
    const all = [sf("A", "Everyday", { account_id: "a-sav" }), sf("B", "Other")];
    const names = (s: SimplefinAccount) => fillable(s, [checking, savings, brokerage, k401, euro, closed], all).map((a) => a.name);
    // The 401(k) holds no shares, so its balance can come from the bank.
    expect(names(all[1])).toEqual(["Checking", "401(k)"]);
    // Its own link stays offered.
    expect(names(all[0])).toEqual(["Checking", "Savings", "401(k)"]);
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

// Issue #3: make the T-Money account from the bank's, and link it.
describe("New account… from a SimpleFIN account", () => {
  function stubNew() {
    let s = status({ accounts: [sf("A", "Everyday Checking", { currency: "USD" })] });
    setIpcHandlers({
      simplefin_status: () => s,
      create_account: (args) => acct("a-new", args.name as string, { type: args.accountType as Account["type"] }),
      simplefin_link: (args) => {
        s = status({ accounts: [sf("A", "Everyday Checking", { account_id: args.accountId as string, account_name: "Everyday Checking" })] });
        return s;
      },
      get_all_accounts: () => [savings],
      list_payees: () => [],
      list_categories: () => [],
    });
  }

  beforeEach(() => {
    resetIpc();
    useAccountStore.setState({ accounts: [savings] });
    // One fixed day, so a run across midnight cannot move the default date.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 10, 22, 12) });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("guesses the kind from the bank's name", () => {
    expect(guessType("Visa Signature")).toBe("credit");
    expect(guessType("Rewards Card")).toBe("credit");
    expect(guessType("Credit Union Checking")).toBe("checking");
    expect(guessType("Home Equity Line of Credit")).toBe("line_of_credit");
    expect(guessType("Discover Online Savings")).toBe("savings");
    expect(guessType("High Yield Savings")).toBe("savings");
    expect(guessType("Auto Loan")).toBe("loan");
    expect(guessType("Everyday Checking")).toBe("checking");
  });

  it("dates the opening balance before the first fetch", () => {
    expect(daysAgoIso(89, new Date(2026, 10, 22))).toBe("2026-08-25");
  });

  it("creates the account in the bank's currency, then links it", async () => {
    stubNew();
    render(<BankSyncPane />);
    const pick = await screen.findByLabelText("T-Money account for Everyday Checking");
    fireEvent.change(pick, { target: { value: "__new__" } });
    const form = await screen.findByRole("form", { name: "New account for Everyday Checking" });
    expect(screen.getByDisplayValue("Everyday Checking")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "1,250.00" } });
    fireEvent.submit(form);
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "simplefin_link")).toBe(true));
    expect(invokeCalls.find((c) => c.cmd === "create_account")?.args).toEqual({
      name: "Everyday Checking",
      accountType: "checking",
      openingBalanceCents: 125_000,
      openedOn: "2026-08-25",
      currency: "USD",
    });
    expect(invokeCalls.find((c) => c.cmd === "simplefin_link")?.args).toEqual({ sfId: "A", accountId: "a-new" });
    await waitFor(() => expect(screen.queryByRole("form", { name: /New account for/ })).toBeNull());
  });

  it("a card's balance is what is owed, stored negative", async () => {
    stubNew();
    render(<BankSyncPane />);
    fireEvent.change(await screen.findByLabelText("T-Money account for Everyday Checking"), { target: { value: "__new__" } });
    const form = await screen.findByRole("form", { name: "New account for Everyday Checking" });
    fireEvent.change(screen.getByDisplayValue("Checking"), { target: { value: "credit" } });
    expect(screen.getByText("Amount you owe")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "250" } });
    fireEvent.submit(form);
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "create_account")).toBe(true));
    expect(invokeCalls.find((c) => c.cmd === "create_account")?.args).toMatchObject({ accountType: "credit", openingBalanceCents: -25_000 });
  });

  it("a failed link closes the form, so a retry cannot make a second account", async () => {
    stubNew();
    setIpcHandlers({
      simplefin_status: () => status({ accounts: [sf("A", "Everyday Checking")] }),
      create_account: (args) => acct("a-new", args.name as string),
      simplefin_link: () => {
        throw "the file was switched";
      },
      get_all_accounts: () => [savings],
      list_payees: () => [],
      list_categories: () => [],
    });
    render(<BankSyncPane />);
    fireEvent.change(await screen.findByLabelText("T-Money account for Everyday Checking"), { target: { value: "__new__" } });
    fireEvent.submit(await screen.findByRole("form", { name: "New account for Everyday Checking" }));
    expect(await screen.findByText("the file was switched")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: /New account for/ })).toBeNull();
    expect(invokeCalls.filter((c) => c.cmd === "create_account")).toHaveLength(1);
  });

  it("a currency with no rate says where to add one", async () => {
    stubNew();
    setIpcHandlers({
      simplefin_status: () => status({ accounts: [sf("A", "Everyday Checking")] }),
      create_account: () => {
        throw "There is no exchange rate for CAD yet. Enter one first, so this account's money can be counted in USD.";
      },
      get_all_accounts: () => [savings],
      list_payees: () => [],
      list_categories: () => [],
    });
    render(<BankSyncPane />);
    fireEvent.change(await screen.findByLabelText("T-Money account for Everyday Checking"), { target: { value: "__new__" } });
    fireEvent.submit(await screen.findByRole("form", { name: "New account for Everyday Checking" }));
    expect(await screen.findByText(/Money → Currencies at the top of this window, then try again/)).toBeInTheDocument();
    expect(screen.getByRole("form", { name: /New account for/ })).toBeInTheDocument();
  });

  it("Cancel makes nothing", async () => {
    stubNew();
    render(<BankSyncPane />);
    fireEvent.change(await screen.findByLabelText("T-Money account for Everyday Checking"), { target: { value: "__new__" } });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: /New account for/ })).toBeNull();
    expect(invokeCalls.some((c) => c.cmd === "create_account")).toBe(false);
  });
});

// Issue #4: SimpleFIN 401(k)s — a blank currency, and balance-only accounts.
describe("A SimpleFIN account with no currency", () => {
  beforeEach(() => {
    resetIpc();
    useAccountStore.setState({ accounts: [checking, k401] });
  });

  it("asks which currency, home first, and never assumes one", async () => {
    let s = status({ accounts: [sf("A", "Plan", { currency: null, currency_missing: true }), sf("P", "Points", { currency: null })] });
    setIpcHandlers({
      simplefin_status: () => s,
      simplefin_confirm_currency: (args) => {
        s = status({ accounts: [sf("A", "Plan", { currency: args.currency as string, currency_missing: true, currency_confirmed: args.currency as string }), sf("P", "Points", { currency: null })] });
        return s;
      },
      list_currencies: () => [
        { code: "EUR", name: "Euro", symbol: "€", decimals: 2 },
        { code: "USD", name: "US dollar", symbol: "$", decimals: 2 },
      ],
      get_all_accounts: () => [checking, k401],
    });
    render(<BankSyncPane />);
    const pick = (await screen.findByLabelText("Currency for Plan")) as HTMLSelectElement;
    await waitFor(() => expect(pick.options.length).toBe(3));
    expect([...pick.options].map((o) => o.value)).toEqual(["", "USD", "EUR"]);
    // Nothing to link until a currency is chosen.
    expect(screen.queryByLabelText("T-Money account for Plan")).toBeNull();
    // A custom unit is said plainly, and offers nothing.
    expect(screen.getByText("Not a currency T-Money keeps")).toBeInTheDocument();
    expect(screen.queryByLabelText("Currency for Points")).toBeNull();

    fireEvent.change(pick, { target: { value: "USD" } });
    await waitFor(() => expect(invokeCalls.find((c) => c.cmd === "simplefin_confirm_currency")?.args).toEqual({ sfId: "A", currency: "USD" }));
    expect(await screen.findByLabelText("T-Money account for Plan")).toBeInTheDocument();
    expect(screen.getByText(/SimpleFIN gave no currency; you chose USD/)).toBeInTheDocument();
  });
});

describe("Balance-only accounts", () => {
  beforeEach(() => {
    resetIpc();
    useAccountStore.setState({ accounts: [savings] });
  });

  it("guesses a retirement or investment account from the bank's name", () => {
    expect(guessType("Acme 401(k) Plan")).toBe("retirement");
    expect(guessType("Roth IRA")).toBe("retirement");
    expect(guessType("Individual Brokerage")).toBe("investment");
    expect(guessType("Everyday Checking")).toBe("checking");
  });

  it("a new retirement account takes no opening balance: the bank's comes on each fetch", async () => {
    let s = status({ accounts: [sf("R", "Acme 401(k) Plan")] });
    setIpcHandlers({
      simplefin_status: () => s,
      create_account: (args) => acct("a-new", args.name as string, { type: args.accountType as Account["type"], holdings_value_cents: 0 }),
      simplefin_link: (args) => {
        s = status({ accounts: [sf("R", "Acme 401(k) Plan", { account_id: args.accountId as string, account_name: "Acme 401(k) Plan" })] });
        return s;
      },
      get_all_accounts: () => [savings],
      list_currencies: () => [],
    });
    render(<BankSyncPane />);
    fireEvent.change(await screen.findByLabelText("T-Money account for Acme 401(k) Plan"), { target: { value: "__new__" } });
    const form = await screen.findByRole("form", { name: "New account for Acme 401(k) Plan" });
    expect(screen.getByDisplayValue("Retirement")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("0.00")).toBeNull();
    expect(screen.getByText(/Each fetch sets its balance to the bank's/)).toBeInTheDocument();
    fireEvent.submit(form);
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "simplefin_link")).toBe(true));
    expect(invokeCalls.find((c) => c.cmd === "create_account")?.args).toMatchObject({ accountType: "retirement", openingBalanceCents: 0, currency: "USD" });
  });
});
