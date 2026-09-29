// Navigation: every header tab and every left-rail item goes somewhere real.
//
// Asked for directly ("probably need to test that all links work too") after
// the 2026-09-01 walkthrough. The rail has a history here — it was entirely
// dead once, setting a `side` state that nothing rendered — so this asserts
// each entry point lands on identifiable content, not merely that it does not
// throw.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../src/test/tauriMock"));

import App from "./App";
import { useAccountStore } from "./stores/useAccountStore";
import { useBudgetStore } from "./stores/useBudgetStore";
import { invokeCalls, resetIpc, setIpcHandlers } from "./test/tauriMock";
import { currentMonth } from "./lib/format";
import { shiftMonth } from "./components/BillCalendar";
import { monthTitle } from "./components/SpendingTrackerWidget";
import type { Account } from "./lib/types";

/** Every command answers benignly; these tests care about routing, not data. */
function stubEverything(overrides: Record<string, () => unknown> = {}) {
  setIpcHandlers(
    new Proxy({} as Record<string, () => unknown>, {
      get: (_t, cmd: string) => (args?: Record<string, unknown>) => {
        if (cmd in overrides) return overrides[cmd]();
        if (cmd === "run_report") {
          const kind = String((args?.request as { kind?: string } | undefined)?.kind ?? "spending_by_category");
          return {
            kind,
            title:
              kind === "net_worth" ? "Net worth"
              : kind === "monthly_income_expenses" ? "Monthly income and expenses"
              : kind === "income_and_spending" ? "Income and spending"
              : "Spending by category",
            subtitle: "1/1/2026 through 9/5/2026",
            columns: [{ label: "Category", kind: "text" }, { label: "Total", kind: "money" }],
            rows: [],
            chart: null,
          };
        }
        // The year plan is the Budget tab's front door, so every
        // App-level render asks for it. A bare [] here is not a YearPlan and
        // the screen has nothing to read, which took the whole app down when
        // this test first met it.
        if (cmd === "get_year_plan") {
          const zero = {
            annual_cents: 0, monthly_cents: 0, actual_cents: new Array(12).fill(0),
            actual_to_date: 0, expected_to_date: 0, variance_cents: 0,
          };
          return {
            year: new Date().getFullYear(), months_elapsed: 0,
            income: [], expenses: [],
            income_total: zero, expense_total: zero, net: zero, planned_lines: 0,
          };
        }
        if (cmd === "get_db_info")
          return { db_path: "C:\\db", size_bytes: 1024, has_key: true };
        if (cmd === "get_key_status") return { has_key: true, source: "keyring" };
        if (cmd === "get_open_statement" || cmd === "get_last_statement") return null;
        if (cmd === "list_reports")
          return [
            { group: "Income and expenses", kind: "spending_by_category", label: "Spending by category" },
            { group: "Assets and liabilities", kind: "net_worth", label: "Net worth" },
          ];
        return [];
      },
      has: () => true,
    })
  );
}

beforeEach(() => {
  resetIpc();
  stubEverything();
  useAccountStore.setState({
    accounts: [], favorites: [], transactions: [], register: [],
    categories: [], payees: [], selectedAccountId: null, error: null,
  });
  useBudgetStore.setState({ summary: [], budgets: [] });
});

/** Header tab → something that only that tab renders. */
const TABS: [string, RegExp][] = [
  ["Home", /Favorite Accounts/],
  ["Banking", /Click the account you want to use/],
  ["Bills", /Bills to Pay & income/],
  ["Reports", /View a report/],
  // The card title became month navigation. "Start a budget" appears
  // twice when the month has no budget (toolbar and empty state), which a
  // getByText would choke on — the "show everything" checkbox is always
  // there exactly once.
  ["Budget", /Show every category/],
  ["Investing", /Portfolio/],
  ["Planning", /Savings Goals/],
  ["Taxes", /Tax Line Manager/],
  ["Help", /What the program is, how it is laid out/],
];

describe("header tabs", () => {
  it.each(TABS)("the %s tab renders its own content", async (tab, marker) => {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: tab }));
    // Scope to the content area: several of these strings also appear in the
    // left rail, and matching there would pass even if the tab rendered
    // nothing.
    const main = screen.getByRole("main");
    await waitFor(() => expect(within(main).getByText(marker)).toBeInTheDocument());
  });

  it("marks the clicked tab active", async () => {
    render(<App />);
    const bills = screen.getByRole("button", { name: "Bills" });
    await userEvent.click(bills);
    expect(bills).toHaveClass("active");
    expect(screen.getByRole("button", { name: "Home" })).not.toHaveClass("active");
  });

  // Settings is a pop-up with two levels of tab, not a ninth tab. It
  // opens over whatever you were doing and closes back onto it.
  it("opens Settings as a pop-up over the screen you were on, and closes back onto it", async () => {
    window.localStorage.removeItem("tm.settingsPane");
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: /Settings/i }));
    const dlg = await screen.findByRole("dialog", { name: "Settings" });
    // It lands on Appearance → Look, not on a wall of everything.
    expect(within(dlg).getByRole("tab", { name: "Appearance" })).toHaveAttribute("aria-selected", "true");
    expect(within(dlg).getByRole("radiogroup", { name: "Look" })).toBeInTheDocument();

    // The database lives under File → This file, two obvious clicks away.
    await userEvent.click(within(dlg).getByRole("tab", { name: "File" }));
    await userEvent.click(within(dlg).getByRole("tab", { name: "This file" }));
    await waitFor(() => expect(within(dlg).getByText(/Database/)).toBeInTheDocument());

    await userEvent.click(within(dlg).getByRole("button", { name: "Close settings" }));
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("draws no second strip for a group with only one thing in it", async () => {
    // One tab under one tab is a decoration, not a navigation.
    // The dialog remembers the pane you were last on, so this starts
    // from a clean slate rather than from whatever the test above left.
    window.localStorage.removeItem("tm.settingsPane");
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: /Settings/i }));
    const dlg = await screen.findByRole("dialog", { name: "Settings" });
    expect(within(dlg).getByRole("tablist", { name: "appearance settings" })).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("tab", { name: "Security" }));
    expect(within(dlg).queryByRole("tablist", { name: "security settings" })).not.toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "Show my key" })).toBeInTheDocument();
  });

  // Verify this file: Check reports; Repair is offered only when there is drift.
  it("Settings → Verify this file checks, and offers Repair only for drift", async () => {
    let drift: unknown[] = [];
    stubEverything({
      verify_file: () => ({ integrity: [], foreign_keys: [], drift, half_transfers: [], split_mismatch: [], split_transfers: [], accounts: 3, transactions: 1200, repaired: [] }),
    });
    window.localStorage.removeItem("tm.settingsPane");
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: /Settings/i }));
    const dlg = await screen.findByRole("dialog", { name: "Settings" });
    await userEvent.click(within(dlg).getByRole("tab", { name: "File" }));
    await userEvent.click(within(dlg).getByRole("tab", { name: "Verify" }));
    await userEvent.click(await screen.findByRole("button", { name: "Check" }));
    const status = await screen.findByRole("status", { name: "File check results" });
    expect(status).toHaveTextContent("3 accounts, 1,200 transactions. Everything checks out.");
    expect(screen.queryByRole("button", { name: "Repair balances" })).toBeNull();
    drift = [{ account_id: "a", account_name: "Checking", stored_cents: 70_001, computed_cents: 70_000 }];
    await userEvent.click(screen.getByRole("button", { name: "Check" }));
    await waitFor(() => expect(screen.getByRole("status", { name: "File check results" })).toHaveTextContent("Checking: stored $700.01, rows add to $700.00"));
    expect(screen.getByRole("button", { name: "Repair balances" })).toBeInTheDocument();
    expect(invokeCalls.filter((c) => c.cmd === "verify_file").map((c) => c.args)).toEqual([{ repair: false }, { repair: false }]);
  });
});

/** Rail item label → the header tab it must activate, and what must appear. */
const RAIL: [string, string, RegExp][] = [
  ["Accounts", "Banking", /Click the account you want to use/],
  ["Transactions", "Banking", /Click the account you want to use/],
  ["Payees", "Banking", /Edit payee/],
  ["Bills to Pay", "Bills", /Bills to Pay & income/],
  ["Spending", "Reports", /Spending by category/],
  ["Net Worth", "Reports", /Net worth/],
  ["Income & Expenses", "Reports", /Monthly income and expenses/],
  ["This Month's Report", "Reports", /Income and spending/],
  ["Budgets", "Budget", /Show every category/],
  ["Categories", "Budget", /Standard categories/],
];

describe("left rail", () => {
  it.each(RAIL)(
    "the %s rail item opens the %s tab",
    async (label, tab, marker) => {
      render(<App />);
      const rail = screen.getByRole("complementary", { name: "Money navigation" });
      await userEvent.click(within(rail).getByText(label));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: tab })).toHaveClass("active")
      );
      const main = screen.getByRole("main");
      await waitFor(() => expect(within(main).getByText(marker)).toBeInTheDocument());
    }
  );

  it("Reconcile is a verb — it asks the register to start balancing", async () => {
    // With an account selected: open ITS register and request the wizard.
    // The register is the only consumer of the request, so it has to be
    // mounted or the request sits armed and fires later, unasked.
    const acct: Account = {
      id: "acc-1", name: "Checking", type: "checking", balance_cents: 0, holdings_value_cents: 0, tax_included: true,
      is_favorite: false, is_closed: false, updated_at: "", institution: null,
      account_number: null, routing_number: null, opened_on: null,
      credit_limit_cents: null, contact_phone: null, contact_email: null,
      website: null, address: null, account_notes: null,
    };
    useAccountStore.setState({ accounts: [acct], selectedAccountId: "acc-1" });
    // App reloads accounts on mount; the stub must hand the account back.
    stubEverything({ get_all_accounts: () => [acct] });
    render(<App />);
    const rail = screen.getByRole("complementary", { name: "Money navigation" });
    await userEvent.click(within(rail).getByText("Reconcile"));
    expect(screen.getByRole("button", { name: "Banking" })).toHaveClass("active");
    // The register mounted, consumed the request, and opened the wizard.
    expect(await screen.findByRole("dialog", { name: "Balance Checking" })).toBeInTheDocument();
    expect(useAccountStore.getState().reconcileRequest).toBe(0);
  });

  it("Reconcile with no account selected lands on the list and arms nothing", async () => {
    useAccountStore.setState({ selectedAccountId: null, reconcileRequest: 0 });
    render(<App />);
    const rail = screen.getByRole("complementary", { name: "Money navigation" });
    await userEvent.click(within(rail).getByText("Reconcile"));
    expect(useAccountStore.getState().reconcileRequest).toBe(0);
    expect(screen.getByRole("button", { name: "Banking" })).toHaveClass("active");
  });
});

// Regression, 2026-09-04. Starring an account pinned it to Home, but clicking
// it there called `selectAccount` and nothing else — the selection changed and
// the user stayed on Home, where nothing visibly happened. Selecting an
// account is not the same as going to look at it.
describe("Favorite Accounts open the register", () => {
  const checking: Account = {
    id: "acc-1",
    name: "Demo Checking",
    type: "checking",
    balance_cents: 250000,
    holdings_value_cents: 0, tax_included: true,
    is_favorite: true,
    is_closed: false,
    updated_at: "2026-09-04T00:00:00Z",
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

  /** The account has to arrive through IPC: App loads accounts and favorites
   *  on mount, so anything seeded straight into the store is overwritten by
   *  the stub before the first paint. */
  function withFavorite() {
    setIpcHandlers(
      new Proxy({} as Record<string, () => unknown>, {
        get: (_t, cmd: string) => () => {
          if (cmd === "get_favorite_accounts" || cmd === "get_all_accounts") return [checking];
          if (cmd === "get_account") return checking;
          return [];
        },
        has: () => true,
      })
    );
  }

  it("clicking a favorite lands on that account's register", async () => {
    withFavorite();
    render(<App />);
    await screen.findByRole("button", { name: "Open Demo Checking" });

    await userEvent.click(screen.getByRole("button", { name: "Open Demo Checking" }));

    // The Banking tab, showing the register — not merely a changed selection.
    await waitFor(() =>
      expect(screen.getByText(/Account register/i)).toBeInTheDocument()
    );
    expect(useAccountStore.getState().selectedAccountId).toBe("acc-1");
  });

  it("a favorite row is reachable from the keyboard", async () => {
    // A row that only answers a mouse is not a control.
    withFavorite();
    render(<App />);
    const row = await screen.findByRole("button", { name: "Open Demo Checking" });
    row.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(useAccountStore.getState().selectedAccountId).toBe("acc-1")
    );
  });
});

describe("the account dropdown opens the register", () => {
  // The same bug as the favorites card, in a second place: choosing an
  // account changed the selection and left the user on the account list.
  // Both ways in have to mean the same thing.
  const base = {
    type: "checking" as const,
    holdings_value_cents: 0, tax_included: true,
    is_favorite: false,
    is_closed: false,
    updated_at: "2026-09-04T00:00:00Z",
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
  const cash: Account = { ...base, id: "acc-1", name: "Demo Cash", balance_cents: -3942 };
  const savings: Account = { ...base, id: "acc-2", name: "Demo Savings", balance_cents: 500000 };

  function withAccounts() {
    setIpcHandlers(
      new Proxy({} as Record<string, () => unknown>, {
        get: (_t, cmd: string) => (args: { id?: string } = {}) => {
          if (cmd === "get_all_accounts") return [cash, savings];
          if (cmd === "get_favorite_accounts") return [];
          if (cmd === "get_account") return args.id === "acc-2" ? savings : cash;
          return [];
        },
        has: () => true,
      })
    );
  }

  /** Land on Banking → Account List, the way the rail does. */
  async function openBanking() {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Banking" }));
    await screen.findByLabelText("Account:");
  }

  it("choosing an account from the dropdown lands on its register", async () => {
    withAccounts();
    await openBanking();

    await userEvent.selectOptions(screen.getByLabelText("Account:"), "acc-2");

    // The register itself, not merely a changed selection — the whole
    // complaint was that the screen did not move.
    await waitFor(() =>
      expect(screen.getByText(/Account register/i)).toBeInTheDocument()
    );
    expect(useAccountStore.getState().selectedAccountId).toBe("acc-2");
  });

  it("the account list does the same thing, so the two agree", async () => {
    withAccounts();
    await openBanking();

    // Scope to the content area: the left rail lists the same accounts, and
    // matching there would pass even if the list itself were dead.
    const main = screen.getByRole("main");
    await userEvent.click(await within(main).findByRole("button", { name: "Demo Savings" }));

    await waitFor(() =>
      expect(screen.getByText(/Account register/i)).toBeInTheDocument()
    );
    expect(useAccountStore.getState().selectedAccountId).toBe("acc-2");
  });
});

// The header's Search box had held its own state with nothing reading
// it. Enter runs a search; a hit opens its register with the row selected.
describe("Search", () => {
  const checking: Account = {
    id: "acc-1", name: "Checking", type: "checking", balance_cents: 0, holdings_value_cents: 0, tax_included: true,
    is_favorite: false, is_closed: false, updated_at: "", institution: null,
    account_number: null, routing_number: null, opened_on: null,
    credit_limit_cents: null, contact_phone: null, contact_email: null,
    website: null, address: null, account_notes: null,
  };
  const hit = {
    id: "t-9", account_id: "acc-1", account_name: "Checking", date: "2026-08-14",
    payee: "Banfield Animal Hospital", category_name: "Pets : Vet", amount_cents: -34000,
    check_number: null, notes: "annual shots", is_void: false,
  };
  const row = {
    id: "t-9", date: "2026-08-14", payee: "Banfield Animal Hospital", category_name: "Pets : Vet",
    category_id: "c-1", transfer_account_id: null, amount_cents: -34000,
    running_balance_cents: -34000, is_reconciled: false, cleared_state: "",
    check_number: null, is_void: false, notes: "annual shots", transfer_account_name: null,
  };

  it("Enter in the box shows results, and a result opens the row in its register", async () => {
    stubEverything({
      get_all_accounts: () => [checking],
      get_account: () => checking,
      search_transactions: () => [hit],
      get_register: () => [row],
    });
    render(<App />);
    const box = screen.getByRole("textbox", { name: "Search transactions" });
    await userEvent.type(box, "vet{Enter}");
    expect(invokeCalls.find((c) => c.cmd === "search_transactions")?.args).toMatchObject({
      query: "vet",
      accountId: null,
    });
    const result = await screen.findByRole("row", { name: /Open Banfield Animal Hospital/ });
    expect(result).toHaveTextContent("Pets : Vet");

    await userEvent.click(result);
    await waitFor(() => expect(screen.getByText(/Account register/i)).toBeInTheDocument());
    expect(useAccountStore.getState().selectedAccountId).toBe("acc-1");
    // The row is selected in the register, and the request is spent.
    await waitFor(() =>
      expect(document.querySelector('tr[data-row-id="t-9"]')).toHaveAttribute("aria-selected", "true")
    );
    expect(useAccountStore.getState().pendingRowId).toBeNull();
  });

  it("says so when nothing matches", async () => {
    stubEverything({ search_transactions: () => [] });
    render(<App />);
    await userEvent.type(screen.getByRole("textbox", { name: "Search transactions" }), "zzz{Enter}");
    expect(await screen.findByText(/Nothing matches/)).toBeInTheDocument();
  });
});

// Transactions is the register, not the account list.
describe("rail Transactions", () => {
  it("opens the first account's register when none is selected", async () => {
    const acct: Account = {
      id: "acc-1", name: "Checking", type: "checking", balance_cents: 0, holdings_value_cents: 0, tax_included: true,
      is_favorite: false, is_closed: false, updated_at: "", institution: null,
      account_number: null, routing_number: null, opened_on: null,
      credit_limit_cents: null, contact_phone: null, contact_email: null,
      website: null, address: null, account_notes: null,
    };
    stubEverything({ get_all_accounts: () => [acct], get_account: () => acct });
    render(<App />);
    await screen.findByText("Checking");
    const rail = screen.getByRole("complementary", { name: "Money navigation" });
    await userEvent.click(within(rail).getByText("Transactions"));
    await waitFor(() => expect(screen.getByText(/Account register/i)).toBeInTheDocument());
    expect(useAccountStore.getState().selectedAccountId).toBe("acc-1");
  });

  it("Bills switches to the calendar and back", async () => {
    stubEverything({
      get_occurrences: () => [
        { recurrence_id: "r-1", payee: "Anytown Properties", amount_cents: -145_000, account_id: "acc-1", account_name: "Checking", category_id: null, category_name: null, due_date: "2026-09-01", status: "paid", transaction_id: "t-1", actual_amount_cents: -145_000 },
      ],
    });
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: /^Bills$/ }));
    await screen.findByText(/Bills to Pay & income/);
    await userEvent.click(screen.getByRole("button", { name: "Calendar" }));
    const grid = await screen.findByRole("grid");
    await waitFor(() => expect(within(grid).getByText("Anytown Properties")).toBeInTheDocument());
    expect(invokeCalls.some((c) => c.cmd === "get_occurrences" && /-01$/.test(String(c.args.from)))).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "List" }));
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
  });

  it("the Portfolio page shows the dated returns when something is held", async () => {
    const pos = { account_id: "a-401k", account_name: "TSP", security_id: "s-fund", security_name: "Target Fund", symbol: "TGTF", security_kind: "mutual_fund", shares_micro: 100_000_000, cost_cents: 100_000, price_micro: 14_000_000, price_date: "2026-09-06", value_cents: 140_000, gain_cents: 40_000, lots: [] };
    stubEverything({
      get_portfolio: () => ({ as_of: "2026-09-06", positions: [pos], total_cost_cents: 100_000, total_value_cents: 140_000, cash_cents: 0, problems: [] }),
      get_roi: () => [
        { label: "Past month", from: "2026-08-06", to: "2026-09-06", start_value_cents: 138_000, end_value_cents: 140_000, unrealized_change_cents: 2_000, realized_cents: 0, income_cents: 0, return_cents: 2_000, return_bps: 145 },
        { label: "All time", from: "", to: "2026-09-06", start_value_cents: 0, end_value_cents: 140_000, unrealized_change_cents: 40_000, realized_cents: 6_000, income_cents: 3_000, return_cents: 49_000, return_bps: 4_900 },
      ],
    });
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: /^Investing$/ }));
    const table = await screen.findByRole("table", { name: "Return on investment" });
    expect(within(table).getByText("Past month")).toBeInTheDocument();
    expect(within(table).getByLabelText("Past month return")).toHaveTextContent("1.5%");
    expect(within(table).getByLabelText("All time return")).toHaveTextContent("49.0%");
    expect(within(table).getByText("$490.00")).toBeInTheDocument();
  });

  it("Bills schedules a transfer into a goal's account", async () => {
    const acct = (id: string, name: string, type: Account["type"]): Account => ({ id, name, type, balance_cents: 1_000, holdings_value_cents: 0, tax_included: true, is_favorite: false, is_closed: false, updated_at: "", institution: null, account_number: null, routing_number: null, opened_on: null, credit_limit_cents: null, contact_phone: null, contact_email: null, website: null, address: null, account_notes: null });
    const accts = [acct("a-chk", "Checking", "checking"), acct("a-sav", "Savings", "savings")];
    stubEverything({
      get_all_accounts: () => accts,
      get_cash_forecast: () => ({ account_id: "a-chk", account_name: "Checking", starting_balance_cents: 1_000, low_balance_cents: 1_000, low_date: "2026-09-06", ending_balance_cents: 1_000, points: [] }),
      list_goals: () => [{ id: "g-roof", name: "Roof", target_cents: 1_000_000, saved_cents: 0, deadline: null, notes: null, updated_at: "", account_id: "a-sav", account_name: "Savings", starting_cents: 0, linked_cents: 0, linked_count: 0 }],
      create_recurrence: () => ({ id: "r-new", payee: "Monthly savings", amount_cents: -20_000, account_id: "a-chk", account_name: "Checking", category_id: null, category_name: null, freq: "monthly", interval_n: 1, start_date: "2026-09-15", end_date: null, second_day: null, weekend_rule: "none", notes: null, is_active: true, updated_at: "", transfer_account_id: "a-sav", transfer_account_name: "Savings", goal_id: "g-roof", goal_name: "Roof" }),
    });
    useAccountStore.setState({ accounts: accts });
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: /^Bills$/ }));
    await screen.findByText(/Bills to Pay & income/);
    await userEvent.type(screen.getByLabelText("Payee"), "Monthly savings");
    await userEvent.type(screen.getByLabelText("Amount"), "200");
    // The forecast's account select also lists "Checking"; pick inside the combo's list.
    const accountCombo = screen.getByRole("combobox", { name: "Account" });
    await userEvent.click(accountCombo);
    const listed = (await screen.findAllByRole("option", { name: /Checking/ })).filter((o) => o.tagName !== "OPTION");
    await userEvent.click(listed[0]);
    await userEvent.selectOptions(screen.getByLabelText("Direction"), "transfer");
    // The category field gives way to the receiving account and the goal.
    expect(screen.queryByLabelText("Scheduled category")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("combobox", { name: "Transfer to" }));
    await userEvent.click((await screen.findAllByRole("option", { name: /Savings/ })).filter((o) => o.tagName !== "OPTION")[0]);
    await userEvent.selectOptions(await screen.findByLabelText("Counts toward goal"), "g-roof");
    await userEvent.click(screen.getByRole("button", { name: "Schedule it" }));
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "create_recurrence")).toBe(true));
    const sent = invokeCalls.find((c) => c.cmd === "create_recurrence")!.args.payload as Record<string, unknown>;
    expect(sent).toMatchObject({ payee: "Monthly savings", amount_cents: -20_000, account_id: "a-chk", transfer_account_id: "a-sav", goal_id: "g-roof", category_id: null });
  });
});

// The Spending Tracker pages by month and opens the report behind a line.
describe("the Spending Tracker", () => {
  it("pages months and opens Transactions by Category for a line", async () => {
    const now = currentMonth();
    const summary = [{ category_id: "c-food", category_name: "Food", target_cents: 50_000, spent_cents: 12_345, remaining_cents: 37_655, month_year: now }];
    stubEverything({ get_spending_summary: () => summary });
    useBudgetStore.setState({ month: now, summary });
    render(<App />);
    expect(screen.getByLabelText("Spending month")).toHaveTextContent(monthTitle(now));
    await userEvent.click(screen.getByRole("button", { name: "Previous month" }));
    await waitFor(() => expect(screen.getByLabelText("Spending month")).toHaveTextContent(monthTitle(shiftMonth(now, -1))));
    expect(invokeCalls.filter((c) => c.cmd === "get_spending_summary").pop()!.args).toMatchObject({ month: shiftMonth(now, -1) });
    // Back to this month; the "Today" button only shows while away from it.
    await userEvent.click(screen.getByRole("button", { name: "Today" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Today" })).not.toBeInTheDocument());
    // A line opens the report for that category and month.
    await userEvent.click(screen.getByRole("button", { name: "Food transactions" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Reports" })).toHaveClass("active"));
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "run_report")).toBe(true));
    const req = invokeCalls.filter((c) => c.cmd === "run_report").pop()!.args!.request as Record<string, unknown>;
    expect(req).toMatchObject({ kind: "transactions_by_category", category_ids: ["c-food"] });
    expect(String(req.from)).toMatch(/-01$/);
  });
});

// F1 opens Help on the topic for the tab you were on.
describe("F1", () => {
  it("opens Help for the current tab", async () => {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: /^Bills$/ }));
    await userEvent.keyboard("{F1}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Help" })).toHaveClass("active"));
    expect(screen.getByRole("heading", { name: "Bills and deposits" })).toBeInTheDocument();
  });
});

// A header tab is the tab's start, even when already on it.
describe("clicking the active tab", () => {
  it("takes Reports back to the gallery and Banking back to the account list", async () => {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Reports" }));
    await screen.findByText(/View a report/);
    await userEvent.click(screen.getByRole("button", { name: "Spending by category" }));
    await screen.findByRole("heading", { name: "Spending by category" });
    await userEvent.click(screen.getByRole("button", { name: "Reports" }));
    await waitFor(() => expect(screen.getByText(/View a report/)).toBeInTheDocument());
    // Banking: the rail's Payees item opens the payees screen; the tab goes home.
    const rail = screen.getByRole("complementary", { name: "Money navigation" });
    await userEvent.click(within(rail).getByText("Payees"));
    await waitFor(() => expect(within(screen.getByRole("main")).getByText(/Edit payee/)).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Banking" }));
    await waitFor(() => expect(screen.getByText(/Click the account you want to use/)).toBeInTheDocument());
  });
});


// A shortcut the menu prints must be a shortcut the menu binds.
// Ctrl+M lived in a keydown handler on the register's grid and appeared in no
// menu, so it worked and nothing said so. It is in the Edit menu's table now,
// which is what binds every other accelerator.
describe("Ctrl+M", () => {
  it("is printed beside Edit → Mark as cleared", async () => {
    stubEverything();
    render(<App />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    const item = await screen.findByRole("menuitem", { name: /Mark as cleared/ });
    expect(item).toHaveTextContent("Ctrl+M");
    expect(item).toHaveAttribute("aria-keyshortcuts", "Control+M");
  });
});

// Undo reaches the user through the Edit menu, and the menu's honesty
// depends on two things agreeing: the registry (is anything offering it) and
// the backend's label (what would it undo). These check the pair.
describe("Edit → Undo", () => {
  async function openEdit() {
    const user = userEvent.setup();
    await user.click(screen.getByRole("menuitem", { name: "Edit" }));
    return user;
  }

  it("is grayed out until something undoable has happened", async () => {
    stubEverything({ undo_status: () => ({ undo: null, redo: null }) });
    render(<App />);
    await screen.findByRole("menubar", { name: "Main menu" });
    await openEdit();
    const item = await screen.findByRole("menuitem", { name: /^Undo/ });
    expect(item).toBeDisabled();
    expect(item).toHaveTextContent("Undo");
  });

  it("names what it would undo once the backend has a step", async () => {
    stubEverything({ undo_status: () => ({ undo: "delete a transaction", redo: null }) });
    render(<App />);
    await screen.findByRole("menubar", { name: "Main menu" });
    await openEdit();
    const item = await screen.findByRole("menuitem", { name: /^Undo/ });
    await waitFor(() => expect(item).toBeEnabled());
    expect(item).toHaveTextContent("Undo delete a transaction");
    // Redo stays grayed: undoing is what fills that side, and offering it
    // before then is the dead-menu-item failure in miniature.
    expect(screen.getByRole("menuitem", { name: /^Redo/ })).toBeDisabled();
  });

  it("running it undoes at the backend and reloads what changed", async () => {
    const calls: string[] = [];
    stubEverything({
      undo_status: () => {
        calls.push("status");
        return { undo: "delete a transaction", redo: null };
      },
      undo_last: () => {
        calls.push("undo");
        return { undo: null, redo: "delete a transaction" };
      },
    });
    render(<App />);
    await screen.findByRole("menubar", { name: "Main menu" });
    const user = await openEdit();
    const item = await screen.findByRole("menuitem", { name: /^Undo/ });
    await waitFor(() => expect(item).toBeEnabled());
    await user.click(item);
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "undo_last")).toBe(true));
    // The far side of a transfer can be in another account, so the account
    // list is re-read rather than patched.
    await waitFor(() =>
      expect(invokeCalls.filter((c) => c.cmd === "get_all_accounts").length).toBeGreaterThan(1)
    );
  });
});
