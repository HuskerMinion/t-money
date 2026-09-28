// AccountRegister + RegisterGrid — Money's column model.
//
// Rewritten 2026-08-30. The previous suite asserted the WRONG column order
// (Date/Description/Category/Check #/Amount/Balance) and so locked in the
// mistake §6.1a documents. These tests assert Money's actual grid, measured
// from reference/ms-money-02-account-register.png.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));
// §183 — the QIF export asks where to save, and the dialog plugin does not
// go through the mocked `invoke`, so it is stood in for here.
const dialog = vi.hoisted(() => ({ save: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: dialog.save, open: dialog.open }));

import { formatDateUS, today } from "../lib/format";
import AccountRegister, {
  nextCheckNumber, groupByDepositsAndWithdrawals } from "./AccountRegister";
import RegisterGrid from "./RegisterGrid";
import { runCommand } from "../lib/commands";
import { useAccountStore } from "../stores/useAccountStore";
import { invokeCalls, resetIpc, setIpcHandlers } from "../test/tauriMock";
import type { Account, Category, NewSplit, RegisterRow } from "../lib/types";

/** The Category field is a type-ahead combobox (§17), not a <select>.
 *  Focus it, type enough to filter, then click the option. */
async function pickCategory(label: string) {
  const box = screen.getByLabelText("Category:");
  await userEvent.click(box);
  await userEvent.type(box, label);
  await userEvent.click(await screen.findByRole("option", { name: label }));
}

/** The split grid's pickers are comboboxes too, since CategorySelect became
 *  an adapter over CategoryCombo (§23). Same shape as pickCategory, but the
 *  label differs per line. */
async function pickIn(label: string, option: string) {
  const box = screen.getByLabelText(label);
  await userEvent.click(box);
  await userEvent.type(box, option);
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

/** Open the list without choosing, to inspect what it offers. */
async function openCategoryList() {
  await userEvent.click(screen.getByLabelText("Category:"));
  return screen.getByRole("listbox", { name: "Category: options" });
}


const checking: Account = {
  id: "acc-1",
  name: "Everyday Checking 1234",
  type: "checking",
  balance_cents: 145750,
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

const deposit: RegisterRow = {
  id: "t-1",
  date: "2026-08-01",
  payee: "Opening Deposit",
  category_name: null,
  category_id: null,
  transfer_account_id: null,
  amount_cents: 150000,
  running_balance_cents: 150000,
  is_reconciled: true,
  cleared_state: "R",
  check_number: null,
  is_void: false,
  notes: "initial funding",
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
};

const withdrawal: RegisterRow = {
  id: "t-2",
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
};

const rows = [deposit, withdrawal];
const initial = useAccountStore.getState();

beforeEach(() => {
  resetIpc();
  useAccountStore.setState(initial, true);
});

/** Body rows that carry data (skips the aria-hidden filler rows). */
function dataRows() {
  return screen
    .getAllByRole("row")
    .filter((r) => !r.classList.contains("filler") && r.querySelector("td"));
}

describe("RegisterGrid — Money's column model (§6.1a)", () => {
  it("renders Money's headers in order, with no Category column", () => {
    render(<RegisterGrid groups={[{ label: null, rows }]} />);
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(["", "", "Num", "Date", "Payee", "C", "Payment", "Deposit", "Balance"]);
    expect(headers).not.toContain("Category");
    expect(headers).not.toContain("Amount");
    expect(headers).not.toContain("Check #");
  });

  it("puts a withdrawal in Payment and leaves Deposit blank", () => {
    render(<RegisterGrid groups={[{ label: null, rows: [withdrawal] }]} />);
    const cells = within(dataRows()[0]).getAllByRole("cell");
    expect(cells[6]).toHaveTextContent("42.50"); // Payment
    expect(cells[7]).toBeEmptyDOMElement(); // Deposit
  });

  it("puts a deposit in Deposit and leaves Payment blank", () => {
    render(<RegisterGrid groups={[{ label: null, rows: [deposit] }]} />);
    const cells = within(dataRows()[0]).getAllByRole("cell");
    expect(cells[6]).toBeEmptyDOMElement(); // Payment
    expect(cells[7]).toHaveTextContent("1,500.00"); // Deposit
  });

  it("formats dates M/D/YYYY, not ISO", () => {
    render(<RegisterGrid groups={[{ label: null, rows: [withdrawal] }]} />);
    const cells = within(dataRows()[0]).getAllByRole("cell");
    expect(cells[3]).toHaveTextContent("8/30/2026");
    expect(cells[3]).not.toHaveTextContent("2026-08-30");
  });

  it("shows Payment/Deposit as bare numbers — no $ and no parens", () => {
    render(<RegisterGrid groups={[{ label: null, rows: [withdrawal] }]} />);
    const payment = within(dataRows()[0]).getAllByRole("cell")[6];
    expect(payment.textContent).toBe("42.50");
  });

  it("shows a reconciled row as R in the C column", () => {
    render(<RegisterGrid groups={[{ label: null, rows }]} />);
    const [first, second] = dataRows();
    expect(within(first).getAllByRole("cell")[5]).toHaveTextContent("R");
    // The unreconciled cell renders an empty <span>, so assert on text.
    expect(within(second).getAllByRole("cell")[5].textContent).toBe("");
  });

  it("renders Balance in accounting parens and red when negative", () => {
    const overdrawn = { ...withdrawal, running_balance_cents: -40526 };
    render(<RegisterGrid groups={[{ label: null, rows: [overdrawn] }]} />);
    const balance = within(dataRows()[0]).getAllByRole("cell")[8];
    expect(balance).toHaveTextContent("(405.26)");
    expect(balance).toHaveClass("money-neg");
  });

  it("leaves a positive Balance unparenthesized and uncolored", () => {
    render(<RegisterGrid groups={[{ label: null, rows: [deposit] }]} />);
    const balance = within(dataRows()[0]).getAllByRole("cell")[8];
    expect(balance).toHaveTextContent("1,500.00");
    expect(balance).not.toHaveClass("money-neg");
  });

  it("draws filler rows down to minRows", () => {
    const { container } = render(
      <RegisterGrid groups={[{ label: null, rows }]} minRows={10} />
    );
    expect(container.querySelectorAll("tr.filler")).toHaveLength(8);
  });

  it("marks the selected row active and reports clicks", async () => {
    const seen: string[] = [];
    render(
      <RegisterGrid
        groups={[{ label: null, rows }]}
        selectedId="t-2"
        onSelect={(id) => seen.push(id)}
      />
    );
    const [first, second] = dataRows();
    expect(second).toHaveClass("active");
    expect(first).not.toHaveClass("active");
    await userEvent.click(first);
    expect(seen).toEqual(["t-1"]);
  });
});

describe("RegisterGrid — grouping (§6.1d)", () => {
  // The view is "Unreconciled transactions … Grouped", so the fixture's
  // already-reconciled opening deposit is not in it; use an uncleared one.
  const openDeposit: RegisterRow = { ...deposit, is_reconciled: false, cleared_state: "" };
  const open = [openDeposit, withdrawal];

  it("renders a group header per group", () => {
    render(<RegisterGrid groups={groupByDepositsAndWithdrawals(open)} />);
    expect(screen.getByText("Deposits")).toBeInTheDocument();
    expect(screen.getByText("Other Withdrawals")).toBeInTheDocument();
  });

  it("states an empty group inline in its own header, Money-style", () => {
    render(<RegisterGrid groups={groupByDepositsAndWithdrawals(open)} />);
    expect(screen.getByText("Checks (No transactions this period)")).toBeInTheDocument();
  });

  it("does not append the empty note to a group that has rows", () => {
    render(<RegisterGrid groups={groupByDepositsAndWithdrawals(open)} />);
    expect(screen.getByText("Deposits").textContent).toBe("Deposits");
  });

  it("routes deposits and withdrawals into the right groups", () => {
    const [deposits, checks, other] = groupByDepositsAndWithdrawals(open);
    expect(deposits.rows.map((r) => r.id)).toEqual(["t-1"]);
    expect(checks.rows).toEqual([]);
    expect(other.rows.map((r) => r.id)).toEqual(["t-2"]);
  });

  it("leaves already-reconciled rows out — they are not on this statement", () => {
    const [deposits] = groupByDepositsAndWithdrawals(rows); // deposit is "R"
    expect(deposits.rows).toEqual([]);
  });

  it("a withdrawal with a check number is a Check; ATM/EFT markers are not", () => {
    const check = { ...withdrawal, id: "t-3", check_number: "1042" };
    const atm = { ...withdrawal, id: "t-4", check_number: "ATM" };
    const [, checks, other] = groupByDepositsAndWithdrawals([check, atm, withdrawal]);
    expect(checks.rows.map((r) => r.id)).toEqual(["t-3"]);
    expect(other.rows.map((r) => r.id)).toEqual(["t-4", "t-2"]);
  });
});

describe("RegisterGrid — reconcile clearing mode (§6.1d)", () => {
  it("renders the C column as a toggle and reports clicks", async () => {
    const toggled: string[] = [];
    const cleared = { ...withdrawal, id: "t-3", cleared_state: "C" as const, payee: "Safeway" };
    render(
      <RegisterGrid
        groups={[{ label: null, rows: [withdrawal, cleared] }]}
        clearable
        onToggleCleared={(id) => toggled.push(id)}
      />
    );
    const clear = screen.getByRole("button", { name: "Clear Grocery Store" });
    expect(clear).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Unclear Safeway" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await userEvent.click(clear);
    expect(toggled).toEqual(["t-2"]);
  });

  it("draws a cleared row as a CHECKMARK in reconcile mode, not the letter C", () => {
    const cleared = { ...withdrawal, cleared_state: "C" as const };
    render(<RegisterGrid groups={[{ label: null, rows: [cleared] }]} clearable onToggleCleared={() => {}} />);
    const cCell = within(dataRows()[0]).getAllByRole("cell")[5];
    expect(cCell).toHaveTextContent("✓");
    expect(cCell).not.toHaveTextContent("C");
  });

  it("draws the same row as the letter C outside reconcile mode", () => {
    // The tick is a VIEW of the stored "C", not a third state — so leaving
    // reconcile (or postponing) shows it as C again.
    const cleared = { ...withdrawal, cleared_state: "C" as const };
    render(<RegisterGrid groups={[{ label: null, rows: [cleared] }]} />);
    const cCell = within(dataRows()[0]).getAllByRole("cell")[5];
    expect(cCell).toHaveTextContent("C");
    expect(cCell).not.toHaveTextContent("✓");
  });

  it("will not offer to unmark an already-reconciled row", () => {
    render(<RegisterGrid groups={[{ label: null, rows: [deposit] }]} clearable onToggleCleared={() => {}} />);
    expect(screen.queryByRole("button", { name: /Unclear/ })).not.toBeInTheDocument();
    expect(within(dataRows()[0]).getAllByRole("cell")[5]).toHaveTextContent("R");
  });

  it("does not select the row when the C toggle is clicked", async () => {
    const selected: string[] = [];
    render(
      <RegisterGrid
        groups={[{ label: null, rows }]}
        clearable
        onSelect={(id) => selected.push(id)}
        onToggleCleared={() => {}}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: "Clear Grocery Store" }));
    expect(selected).toEqual([]);
  });
});

describe("<AccountRegister />", () => {
  it("prompts for a selection when no account is chosen", () => {
    setIpcHandlers({ list_categories: () => [] });
    render(<AccountRegister />);
    expect(screen.getByText("Select an account to view its register.")).toBeInTheDocument();
    // Categories load for the entry form's picker, but no register is fetched.
    expect(invokeCalls.map((c) => c.cmd)).not.toContain("get_register");
  });

  it("loads the register for the selected account on mount", async () => {
    setIpcHandlers({ get_register: () => rows, list_categories: () => [] });
    useAccountStore.setState({ accounts: [checking], selectedAccountId: "acc-1" });
    render(<AccountRegister />);
    await screen.findByRole("table");
    expect(invokeCalls).toContainEqual({ cmd: "get_register", args: { accountId: "acc-1" } });
    expect(screen.getByText("Everyday Checking 1234")).toBeInTheDocument();
  });

  it("shows Ending Balance from the last row's running balance, with a $", async () => {
    setIpcHandlers({ get_register: () => rows, list_categories: () => [] });
    useAccountStore.setState({ accounts: [checking], selectedAccountId: "acc-1" });
    render(<AccountRegister />);
    await screen.findByRole("table");
    expect(screen.getByText("Ending Balance: $1,457.50")).toBeInTheDocument();
  });

  it("shows no per-column totals — Money's footer has none (§6.1a #9)", async () => {
    setIpcHandlers({ get_register: () => rows, list_categories: () => [] });
    useAccountStore.setState({ accounts: [checking], selectedAccountId: "acc-1" });
    render(<AccountRegister />);
    await screen.findByRole("table");
    expect(screen.queryByText(/^\d+ transactions?$/)).not.toBeInTheDocument();
    expect(screen.queryByRole("table")?.querySelector("tfoot")).toBeNull();
  });

  // §40: the View is Show + dates + sort, described in one line.
  it("the View has dates and a sort, and a non-date sort blanks the Balance column", async () => {
    setIpcHandlers({ get_register: () => rows, list_categories: () => [] });
    useAccountStore.setState({ accounts: [checking], selectedAccountId: "acc-1" });
    render(<AccountRegister />);
    await screen.findByRole("table");
    expect(screen.getByText("All transactions covering all dates, Sorted by Date (increasing)")).toBeInTheDocument();
    // Balances show in date order…
    expect(within(dataRows()[1]).getAllByRole("cell")[8]).toHaveTextContent("1,457.50");
    await userEvent.selectOptions(screen.getByLabelText("sorted by"), "payee");
    // …and not in any other order: a running balance out of date order is a lie.
    expect(screen.getByText(/Sorted by Payee/)).toBeInTheDocument();
    for (const r of dataRows()) expect(within(r).getAllByRole("cell")[8]).toHaveTextContent("");
    // Payee order: Grocery Store before Opening Deposit.
    expect(within(dataRows()[0]).getAllByRole("cell")[4]).toHaveTextContent("Grocery Store");
  });

  // §96: asked for the thing every other grid does — click the header.
  it("sorts by a clicked column header, reverses on a second click, and forgets it when the register is left", async () => {
    setIpcHandlers({ get_register: () => rows, list_categories: () => [] });
    useAccountStore.setState({ accounts: [checking], selectedAccountId: "acc-1" });
    const other: Account = { ...checking, id: "acc-2", name: "Everyday Savings 5678" };
    const { rerender } = render(<AccountRegister />);
    await screen.findByRole("table");

    const payeeHeader = () => within(screen.getByRole("columnheader", { name: /^Payee$/ })).getByRole("button");
    await userEvent.click(payeeHeader());
    expect(screen.getByText(/Sorted by Payee \(A–Z\)/)).toBeInTheDocument();
    expect(within(dataRows()[0]).getAllByRole("cell")[4]).toHaveTextContent("Grocery Store");
    // The header says which way it is pointing, for a screen reader too.
    expect(screen.getByRole("columnheader", { name: /Payee/ })).toHaveAttribute("aria-sort", "ascending");

    await userEvent.click(payeeHeader());
    expect(screen.getByText(/Sorted by Payee \(Z–A\)/)).toBeInTheDocument();
    expect(within(dataRows()[0]).getAllByRole("cell")[4]).toHaveTextContent("Opening Deposit");
    expect(screen.getByRole("columnheader", { name: /Payee/ })).toHaveAttribute("aria-sort", "descending");

    // Leaving for another account puts date order back — the sort answered a
    // question about THIS register, and the running balance needs date order.
    act(() => {
      useAccountStore.setState({ accounts: [checking, other], selectedAccountId: "acc-2" });
    });
    rerender(<AccountRegister />);
    await waitFor(() =>
      expect(screen.getByText("All transactions covering all dates, Sorted by Date (increasing)")).toBeInTheDocument()
    );
  });

  it("the View's dates narrow the rows and say how many are shown", async () => {
    setIpcHandlers({ get_register: () => rows, list_categories: () => [] });
    useAccountStore.setState({ accounts: [checking], selectedAccountId: "acc-1" });
    render(<AccountRegister />);
    await screen.findByRole("table");
    // The fixture is dated August 2026; "last year" holds none of it.
    await userEvent.selectOptions(screen.getByLabelText("covering"), "previous_year");
    expect(dataRows()).toHaveLength(0);
    expect(screen.getByText(/0 of 2/)).toBeInTheDocument();
  });

  it("disables Edit and Delete until a row is selected", async () => {
    setIpcHandlers({ get_register: () => rows, list_categories: () => [] });
    useAccountStore.setState({ accounts: [checking], selectedAccountId: "acc-1" });
    render(<AccountRegister />);
    await screen.findByRole("table");
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
    await userEvent.click(dataRows()[0]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
  });

  it("switches to the grouped view from the View dropdown", async () => {
    setIpcHandlers({ get_register: () => rows, list_categories: () => [] });
    useAccountStore.setState({ accounts: [checking], selectedAccountId: "acc-1" });
    render(<AccountRegister />);
    await screen.findByRole("table");
    expect(screen.queryByText(/^Deposits/)).not.toBeInTheDocument();
    await userEvent.selectOptions(
      screen.getByLabelText("View:"),
      "unreconciled-grouped"
    );
    expect(screen.getByText(/^Deposits/)).toBeInTheDocument();
    expect(screen.getByText("Checks (No transactions this period)")).toBeInTheDocument();
  });

  it("has a Show transaction forms toggle (§6.1b's mechanism)", async () => {
    setIpcHandlers({ get_register: () => rows, list_categories: () => [] });
    useAccountStore.setState({ accounts: [checking], selectedAccountId: "acc-1" });
    render(<AccountRegister />);
    await screen.findByRole("table");
    const toggle = screen.getByLabelText("Show transaction forms");
    expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);
    expect(toggle).toBeChecked();
  });
});

describe("in-place transaction form (§6.1b)", () => {
  // Shaped like migration 0014's tree: "Gasoline" is a child of "Automobile",
  // so the picker must show it as "Automobile : Gasoline" (§6.1e).
  const cats: Category[] = [
    {
      id: "c-1",
      name: "Groceries",
      parent_id: null,
      kind: "expense",
      tax_line: null,
      full_name: "Groceries",
      usage_count: 3,
    },
    {
      id: "c-2",
      name: "Gasoline",
      parent_id: "c-0",
      kind: "expense",
      tax_line: null,
      full_name: "Automobile : Gasoline",
      usage_count: 1,
    },
  ];

  // Saved entry templates (§31).
  const commons = [
    {
      id: "ct-1",
      name: "Rent",
      payee: "Anytown Properties",
      category_id: "c-1",
      category_name: "Groceries",
      amount_cents: -145000,
      check_number: "1042",
      notes: null,
      usage_count: 4,
      updated_at: "2026-09-03T00:00:00Z",
      splits: [],
    },
    {
      id: "ct-2",
      name: "Groceries run",
      payee: "Kroger",
      category_id: "c-1",
      category_name: "Groceries",
      amount_cents: null,
      check_number: null,
      notes: null,
      usage_count: 1,
      updated_at: "2026-09-03T00:00:00Z",
      splits: [],
    },
  ];

  beforeEach(() => {
    setIpcHandlers({
      get_register: () => rows,
      list_categories: () => cats,
      list_payees: () => [],
      create_transaction: () => ({ id: "t-3" }),
      list_splits: () => [],
      set_splits: () => [],
      update_transaction: () => ({ id: "t-2" }),
      delete_transaction: () => null,
      get_all_accounts: () => [checking],
      list_common_transactions: () => commons,
      create_common_transaction: () => commons[0],
      touch_common_transaction: () => null,
      delete_common_transaction: () => null,
    });
    useAccountStore.setState({ accounts: [checking], selectedAccountId: "acc-1" });
  });

  it("New opens a blank form with Category and Memo — the fields the grid hides", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    expect(screen.getByLabelText("Date")).toBeInTheDocument();
    expect(screen.getByLabelText("Payee")).toBeInTheDocument();
    expect(screen.getByLabelText("Payment")).toBeInTheDocument();
    expect(screen.getByLabelText("Deposit")).toBeInTheDocument();
    expect(screen.getByLabelText("Category:")).toBeInTheDocument();
    expect(screen.getByLabelText("Memo:")).toBeInTheDocument();
  });

  it("the form carries a date field — entry is not pinned to today", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    // §71: a typed date. Shows M/D/YYYY, takes 7/4, 7/4/26, 7/4/2026 or ISO.
    const date = screen.getByLabelText("Date") as HTMLInputElement;
    expect(date.type).toBe("text");
    await userEvent.clear(date);
    await userEvent.type(date, "7/4/2026");
    expect(date.value).toBe("7/4/2026");
    await userEvent.tab();
    expect(date.value).toBe("7/4/2026");
    // A short form fills in the year; + steps a day; T is today.
    await userEvent.clear(date);
    await userEvent.type(date, "12/25");
    await userEvent.tab();
    expect(date.value).toMatch(/^12\/25\/\d{4}$/);
    await userEvent.click(date);
    await userEvent.keyboard("+");
    expect(date.value).toMatch(/^12\/26\/\d{4}$/);
    await userEvent.keyboard("t");
    await userEvent.tab();
    expect(date.value).toBe(formatDateUS(today()));
    // Nonsense is flagged, not silently accepted.
    await userEvent.clear(date);
    await userEvent.type(date, "13/45");
    await userEvent.tab();
    expect(date).toHaveAttribute("aria-invalid", "true");
  });

  it("offers the loaded categories in the picker", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    const list = await openCategoryList();
    expect(within(list).getByRole("option", { name: "Groceries" })).toBeInTheDocument();
    expect(
      within(list).getByRole("option", { name: "Automobile : Gasoline" })
    ).toBeInTheDocument();
  });

  it("sends a Payment as a negative amount with its category", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    await userEvent.type(screen.getByLabelText("Payee"), "Safeway");
    await userEvent.type(screen.getByLabelText("Payment"), "53.23");
    await pickCategory("Groceries");
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));
    await waitFor(() =>
      expect(invokeCalls.some((c) => c.cmd === "create_transaction")).toBe(true)
    );
    const call = invokeCalls.find((c) => c.cmd === "create_transaction")!;
    const payload = (call.args as { payload: Record<string, unknown> }).payload;
    expect(payload.amount_cents).toBe(-5323);
    expect(payload.payee).toBe("Safeway");
    expect(payload.category_id).toBe("c-1");
  });

  // §61 — the entry line, and check numbers that follow on.
  it("the entry line at the foot of the register starts a new transaction", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    expect(screen.queryByLabelText("Payee")).not.toBeInTheDocument();
    const entry = screen.getByRole("button", { name: "New transaction" });
    expect(entry).toHaveTextContent("Click here to enter a transaction");
    await userEvent.click(entry);
    expect(screen.getByLabelText("Payee")).toBeInTheDocument();
    // The line gives way to the form and comes back when it closes.
    expect(screen.queryByRole("button", { name: "New transaction" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "New transaction" })).toBeInTheDocument();
  });

  // §123 — where the caret lands, and the arrow keys.
  it("a new entry starts in the Date; an existing row opens in the Payee", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");

    await userEvent.click(screen.getByRole("button", { name: "New transaction" }));
    expect(screen.getByLabelText("Date")).toHaveFocus();

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // An existing row is opened to change what is in it, and its date is
    // already right — so that one still starts in the Payee.
    const row = screen.getByText("Grocery Store");
    await userEvent.click(row);
    await userEvent.click(row);
    await waitFor(() => expect(screen.getByLabelText("Payee")).toHaveFocus());
  });

  it("§123: up and down walk the transaction list and stop at the ends", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    const rowOf = (payee: string) => screen.getByText(payee).closest("tr")!;

    // Nothing selected yet: the first Down takes the first row.
    fireEvent.keyDown(window, { key: "ArrowDown" });
    await waitFor(() => expect(rowOf("Opening Deposit")).toHaveAttribute("aria-selected", "true"));

    fireEvent.keyDown(window, { key: "ArrowDown" });
    await waitFor(() => expect(rowOf("Grocery Store")).toHaveAttribute("aria-selected", "true"));

    // The end of the list is the end of the list — it does not wrap around.
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(rowOf("Grocery Store")).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(window, { key: "ArrowUp" });
    await waitFor(() => expect(rowOf("Opening Deposit")).toHaveAttribute("aria-selected", "true"));
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(rowOf("Opening Deposit")).toHaveAttribute("aria-selected", "true");
  });

  it("§123: the arrows belong to the form while one is open, not to the list", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    const rowOf = (payee: string) => screen.getByText(payee).closest("tr")!;

    fireEvent.keyDown(window, { key: "ArrowDown" });
    await waitFor(() => expect(rowOf("Opening Deposit")).toHaveAttribute("aria-selected", "true"));

    // A form open in a row: every arrow key is the form's, down to the payee
    // list picking its next match. The selection must not move underneath it
    // — whether the key arrives at the window or inside one of its fields.
    await userEvent.click(screen.getByRole("button", { name: "New transaction" }));
    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByLabelText("Date"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByLabelText("Payee"), { key: "ArrowDown" });
    expect(rowOf("Opening Deposit")).toHaveAttribute("aria-selected", "true");
  });

  it("offers the next check number after a check, and '+' fills it in", async () => {
    const live = [...rows];
    setIpcHandlers({
      get_register: () => live,
      list_categories: () => cats,
      list_payees: () => [],
      list_splits: () => [],
      list_common_transactions: () => [],
      create_transaction: (args) => {
        const p = (args as { payload: Record<string, unknown> }).payload;
        const made = { ...withdrawal, id: `t-${live.length + 1}`, payee: String(p.payee), check_number: (p.check_number as string | null) ?? null, amount_cents: Number(p.amount_cents) };
        live.push(made);
        return made;
      },
    });
    render(<AccountRegister />);
    await screen.findByRole("table");
    // No check in the register yet: nothing to offer, and "+" does nothing.
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    const num = screen.getByLabelText("Num") as HTMLInputElement;
    expect(num.value).toBe("");
    await userEvent.type(num, "+");
    expect(num.value).toBe("+");
    await userEvent.clear(num);
    await userEvent.type(num, "1041");
    await userEvent.type(screen.getByLabelText("Payee"), "City Power & Light");
    await userEvent.type(screen.getByLabelText("Payment"), "120");
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));
    // §161 — Enter opens the next entry, and it starts with 1042.
    await waitFor(() => expect((screen.getByLabelText("Payee") as HTMLInputElement).value).toBe(""));
    expect((screen.getByLabelText("Num") as HTMLInputElement).value).toBe("1042");
    // Escape closes it; the entry line shows 1042, and New starts with it too.
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByLabelText("Payee")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "New transaction" })).toHaveTextContent("1042");
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    expect((screen.getByLabelText("Num") as HTMLInputElement).value).toBe("1042");
    // Not a check this time: clear it and enter a card swipe…
    await userEvent.clear(screen.getByLabelText("Num"));
    await userEvent.type(screen.getByLabelText("Payee"), "Kroger");
    await userEvent.type(screen.getByLabelText("Payment"), "40");
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));
    await waitFor(() => expect((screen.getByLabelText("Payee") as HTMLInputElement).value).toBe(""));
    // …so the next one is blank, but "+" still knows the next number is 1042.
    expect((screen.getByLabelText("Num") as HTMLInputElement).value).toBe("");
    await userEvent.type(screen.getByLabelText("Num"), "+");
    expect((screen.getByLabelText("Num") as HTMLInputElement).value).toBe("1042");
  });

  it("the next new transaction starts on the date of the last one entered (§71)", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    const date = screen.getByLabelText("Date") as HTMLInputElement;
    await userEvent.clear(date);
    await userEvent.type(date, "7/4/2026");
    await userEvent.type(screen.getByLabelText("Payee"), "Fireworks");
    await userEvent.type(screen.getByLabelText("Payment"), "20");
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));
    // §161 — Enter opens the next entry on that date, with the caret in the
    // Date so Tab moves straight on to the Payee when the date is right.
    await waitFor(() => expect((screen.getByLabelText("Payee") as HTMLInputElement).value).toBe(""));
    expect(invokeCalls.find((c) => c.cmd === "create_transaction")!.args).toMatchObject({ payload: { date: "2026-07-04" } });
    expect((screen.getByLabelText("Date") as HTMLInputElement).value).toBe("7/4/2026");
    expect(screen.getByLabelText("Date")).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByLabelText("Payee")).toHaveFocus();
    // Escape ends the unentered one; the entry line shows the date, and New
    // starts on it too.
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByLabelText("Payee")).not.toBeInTheDocument());
    expect(invokeCalls.filter((c) => c.cmd === "create_transaction")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "New transaction" })).toHaveTextContent("7/4/2026");
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    expect((screen.getByLabelText("Date") as HTMLInputElement).value).toBe("7/4/2026");
  });

  it("Enter on an EXISTING row saves and closes it; nothing new opens (§161)", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.dblClick(dataRows()[1]);
    await userEvent.type(await screen.findByLabelText("Payee"), " Deli{Enter}");
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "update_transaction")).toBe(true));
    await waitFor(() => expect(screen.queryByLabelText("Payee")).not.toBeInTheDocument());
  });

  // §171 — rules that learn: giving a category to a row that had none is
  // how an unknown import gets filed, so the register offers to remember it.
  it("offers to remember the category given to an uncategorized row, and Remember makes the rule (§171)", async () => {
    setIpcHandlers({
      get_register: () => rows,
      list_categories: () => cats,
      list_payees: () => [],
      create_transaction: () => ({ id: "t-3" }),
      list_splits: () => [],
      update_transaction: () => ({ id: "t-2" }),
      get_all_accounts: () => [checking],
      list_common_transactions: () => commons,
      list_payee_rules: () => [],
      create_payee_rule: () => ({ id: "r-1" }),
    });
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.dblClick(dataRows()[0]); // Opening Deposit: no category
    await pickCategory("Groceries");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "update_transaction")).toBe(true));
    const strip = await screen.findByRole("status");
    expect(strip).toHaveTextContent('File every "Opening Deposit" under Groceries from now on?');
    await userEvent.click(within(strip).getByRole("button", { name: "Remember" }));
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "create_payee_rule")).toBe(true));
    expect(invokeCalls.find((c) => c.cmd === "create_payee_rule")!.args).toEqual({ matchText: "Opening Deposit", payeeName: "Opening Deposit", categoryId: "c-1", minCents: null, maxCents: null, memoContains: null, accountId: null });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Remembered."));
  });

  it("does not offer a rule when one already covers the payee, nor when the row already had a category (§171)", async () => {
    setIpcHandlers({
      get_register: () => rows,
      list_categories: () => cats,
      list_payees: () => [],
      create_transaction: () => ({ id: "t-3" }),
      list_splits: () => [],
      update_transaction: () => ({ id: "t-2" }),
      get_all_accounts: () => [checking],
      list_common_transactions: () => commons,
      list_payee_rules: () => [{ id: "r-1", match_text: "opening", payee_name: "Opening Deposit", category_id: "c-1", category_name: "Groceries", created_at: "" }],
    });
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.dblClick(dataRows()[0]);
    await pickCategory("Groceries");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "update_transaction")).toBe(true));
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "list_payee_rules")).toBe(true));
    expect(screen.queryByRole("button", { name: "Remember" })).not.toBeInTheDocument();
    // The withdrawal already has Groceries: re-saving it asks nothing.
    invokeCalls.length = 0;
    await userEvent.dblClick(dataRows()[1]);
    await userEvent.type(await screen.findByLabelText("Payee"), " Deli{Enter}");
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "update_transaction")).toBe(true));
    expect(invokeCalls.some((c) => c.cmd === "list_payee_rules")).toBe(false);
    expect(screen.queryByRole("button", { name: "Remember" })).not.toBeInTheDocument();
  });

  it("Enter still saves after a split — the caret comes back to the form (§160)", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    await userEvent.type(screen.getByLabelText("Payee"), "Walmart");
    await userEvent.type(screen.getByLabelText("Payment"), "42.50");
    await userEvent.click(screen.getByRole("button", { name: "Split" }));
    await pickIn("Category 1", "Groceries");
    await userEvent.type(screen.getByLabelText("Amount 1"), "42.50");
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    // The dialog is gone and the Memo has the caret, so Enter reaches the row.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Memo:")).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "create_transaction")).toBe(true));
  });

  // §73 — moving to another row saves the open form.
  it("clicking another row saves an edited transaction without Enter", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(dataRows()[1]);
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await userEvent.clear(screen.getByLabelText("Payee"));
    await userEvent.type(screen.getByLabelText("Payee"), "Fresh Market");
    await userEvent.click(dataRows()[0]);
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "update_transaction")).toBe(true));
    expect((invokeCalls.find((c) => c.cmd === "update_transaction")!.args as { payload: Record<string, unknown> }).payload.payee).toBe("Fresh Market");
    await waitFor(() => expect(screen.queryByLabelText("Payee")).not.toBeInTheDocument());
  });

  it("an untouched new form just closes; a half-filled one stays open with its error; a filled one is saved", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    // Untouched: nothing written.
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    await userEvent.click(dataRows()[0]);
    await waitFor(() => expect(screen.queryByLabelText("Payee")).not.toBeInTheDocument());
    expect(invokeCalls.some((c) => c.cmd === "create_transaction")).toBe(false);
    // Half-filled: cannot be saved, so it stays.
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    await userEvent.type(screen.getByLabelText("Payee"), "Shell");
    await userEvent.click(dataRows()[0]);
    expect(screen.getByLabelText("Payee")).toBeInTheDocument();
    expect(screen.getByText("Enter a Payment or a Deposit amount.")).toBeInTheDocument();
    expect(invokeCalls.some((c) => c.cmd === "create_transaction")).toBe(false);
    // Filled: saved on the way out.
    await userEvent.type(screen.getByLabelText("Payment"), "40");
    await userEvent.click(dataRows()[0]);
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "create_transaction")).toBe(true));
    expect((invokeCalls.find((c) => c.cmd === "create_transaction")!.args as { payload: Record<string, unknown> }).payload).toMatchObject({ payee: "Shell", amount_cents: -4000 });
  });

  it("sends a Deposit as a positive amount", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    await userEvent.type(screen.getByLabelText("Payee"), "Paycheck");
    await userEvent.type(screen.getByLabelText("Deposit"), "1,200.00");
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));
    await waitFor(() =>
      expect(invokeCalls.some((c) => c.cmd === "create_transaction")).toBe(true)
    );
    const call = invokeCalls.find((c) => c.cmd === "create_transaction")!;
    expect((call.args as { payload: { amount_cents: number } }).payload.amount_cents).toBe(120000);
  });

  // ── the Num column ───────────────────────────────────────────────────
  //
  // `check_number` landed in migration 0011 and RegisterGrid has rendered it
  // ever since, but nothing could write it: the field was a `disabled` stub,
  // so the column was permanently blank. These pin the write path (§23).

  it("sends the Num as check_number", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    await userEvent.type(screen.getByLabelText("Num"), "1042");
    await userEvent.type(screen.getByLabelText("Payee"), "Safeway");
    await userEvent.type(screen.getByLabelText("Payment"), "53.23");
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));
    await waitFor(() =>
      expect(invokeCalls.some((c) => c.cmd === "create_transaction")).toBe(true)
    );
    const call = invokeCalls.find((c) => c.cmd === "create_transaction")!;
    const payload = (call.args as { payload: Record<string, unknown> }).payload;
    expect(payload.check_number).toBe("1042");
  });

  it("accepts free text in Num, not just digits", async () => {
    // Money takes ATM, EFT, DEP, Print — the column is text, and the input
    // must not be type=number or a spinner.
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    const num = screen.getByLabelText("Num") as HTMLInputElement;
    expect(num.type).not.toBe("number");
    await userEvent.type(num, "ATM");
    await userEvent.type(screen.getByLabelText("Payee"), "Cash");
    await userEvent.type(screen.getByLabelText("Payment"), "20.00");
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));
    await waitFor(() =>
      expect(invokeCalls.some((c) => c.cmd === "create_transaction")).toBe(true)
    );
    const call = invokeCalls.find((c) => c.cmd === "create_transaction")!;
    const payload = (call.args as { payload: Record<string, unknown> }).payload;
    expect(payload.check_number).toBe("ATM");
  });

  it("sends null rather than an empty string when Num is left blank", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    await userEvent.type(screen.getByLabelText("Payee"), "Safeway");
    await userEvent.type(screen.getByLabelText("Payment"), "53.23");
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));
    await waitFor(() =>
      expect(invokeCalls.some((c) => c.cmd === "create_transaction")).toBe(true)
    );
    const call = invokeCalls.find((c) => c.cmd === "create_transaction")!;
    const payload = (call.args as { payload: Record<string, unknown> }).payload;
    expect(payload.check_number).toBeNull();
  });

  it("Num is the first field in the form's tab order", async () => {
    // A check is written before it is recorded, so Money starts there:
    // Num → Date → Payee → Category → Payment → Deposit.
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    const form = screen.getByLabelText("Num").closest("tr")!;
    // The date field's hidden picker input is tabIndex -1 and out of the order.
    const inputs = Array.from(form.querySelectorAll("input")).filter((i) => i.tabIndex !== -1);
    expect(inputs[0]).toBe(screen.getByLabelText("Num"));
    expect(inputs[1]).toBe(screen.getByLabelText("Date"));
    expect(inputs[2]).toBe(screen.getByLabelText("Payee"));
  });

  // Regression, 2026-09-03. Selecting a row opened its edit form immediately
  // whenever "Show transaction forms" was checked, so a single click expanded
  // the row — you could not look at a transaction, or pick one to clear or
  // delete, without it unfolding under the cursor (§26.2).
  it("selecting a row does not open its form", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByLabelText("Show transaction forms"));
    await userEvent.click(dataRows()[1]);
    expect(screen.queryByLabelText("Payee")).not.toBeInTheDocument();
  });

  it("a second click on the selected row opens it", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(dataRows()[1]);
    await userEvent.click(dataRows()[1]);
    expect((screen.getByLabelText("Payee") as HTMLInputElement).value).toBe("Grocery Store");
  });

  it("selecting another row collapses the one that was open", async () => {
    // Two expanded rows at once is not a state Money has, and leaving the old
    // one open pushes the register around while you are reading it.
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(dataRows()[1]);
    await userEvent.click(dataRows()[1]);
    expect((screen.getByLabelText("Payee") as HTMLInputElement).value).toBe("Grocery Store");

    await userEvent.click(dataRows()[0]);
    expect(screen.queryByLabelText("Payee")).not.toBeInTheDocument();

    // ...and the newly selected row still opens on its own second click.
    await userEvent.click(dataRows()[0]);
    expect((screen.getByLabelText("Payee") as HTMLInputElement).value).toBe("Opening Deposit");
  });

  // ── Common Transactions (§31) ────────────────────────────────────────
  //
  // The button was a disabled stub from the first version of this form. It is
  // the last piece of Money's entry flow, and the thing that makes entering
  // the same twelve transactions every month cost one pick instead of five
  // fields.

  async function openCommonMenu() {
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    await userEvent.click(screen.getByRole("button", { name: /Common Transactions/ }));
  }

  it("lists the saved templates, most-used first", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await openCommonMenu();
    const items = await screen.findAllByRole("menuitem");
    expect(items[0]).toHaveTextContent("Rent");
    expect(items[1]).toHaveTextContent("Groceries run");
  });

  it("fills the form from a template", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await openCommonMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: /Rent/ }));

    expect((screen.getByLabelText("Payee") as HTMLInputElement).value).toBe("Anytown Properties");
    expect((screen.getByLabelText("Payment") as HTMLInputElement).value).toBe("1,450.00");
    expect((screen.getByLabelText("Num") as HTMLInputElement).value).toBe("1042");
    expect((screen.getByLabelText("Category:") as HTMLInputElement).value).toBe("Groceries");
  });

  it("a template with no fixed amount leaves the amount alone", async () => {
    // "Kroger, Groceries, whatever it came to this week" must not zero the
    // field — that would be worse than leaving it empty.
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    await userEvent.type(screen.getByLabelText("Payment"), "31.20");
    await userEvent.click(screen.getByRole("button", { name: /Common Transactions/ }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Groceries run/ }));

    expect((screen.getByLabelText("Payee") as HTMLInputElement).value).toBe("Kroger");
    expect((screen.getByLabelText("Payment") as HTMLInputElement).value).toBe("31.20");
  });

  it("using a template records that it was used", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await openCommonMenu();
    await userEvent.click(await screen.findByRole("menuitem", { name: /Rent/ }));
    await waitFor(() =>
      expect(invokeCalls.some((c) => c.cmd === "touch_common_transaction")).toBe(true)
    );
  });

  it("saves the current form as a named template", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    await userEvent.type(screen.getByLabelText("Payee"), "Comcast");
    await userEvent.type(screen.getByLabelText("Payment"), "79.99");
    await userEvent.click(screen.getByRole("button", { name: /Common Transactions/ }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Save this one/ }));
    await userEvent.type(screen.getByLabelText("Common transaction name"), "Internet");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(invokeCalls.some((c) => c.cmd === "create_common_transaction")).toBe(true)
    );
    const call = invokeCalls.find((c) => c.cmd === "create_common_transaction")!;
    const payload = (call.args as { payload: Record<string, unknown> }).payload;
    expect(payload.name).toBe("Internet");
    expect(payload.payee).toBe("Comcast");
    expect(payload.amount_cents).toBe(-7999);
  });

  it("naming a template does not commit the transaction", async () => {
    // The button strip's Enter commits; the name field sits inside it, so a
    // stray Enter there would silently save a transaction the user was only
    // trying to name.
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    await userEvent.type(screen.getByLabelText("Payee"), "Comcast");
    await userEvent.type(screen.getByLabelText("Payment"), "79.99");
    await userEvent.click(screen.getByRole("button", { name: /Common Transactions/ }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Save this one/ }));
    await userEvent.type(screen.getByLabelText("Common transaction name"), "Internet{Enter}");

    await waitFor(() =>
      expect(invokeCalls.some((c) => c.cmd === "create_common_transaction")).toBe(true)
    );
    expect(invokeCalls.some((c) => c.cmd === "create_transaction")).toBe(false);
  });

  it("the menu is not inside the register, so nothing can clip it", async () => {
    // §19.1's lesson, applied rather than re-learned. The button strip is a
    // row of the register table, which sits in an overflow-auto wrapper with a
    // 52vh cap — an absolutely positioned menu there is clipped, and clipped
    // in the way that hides the bug: a short list fits, a full one does not.
    // jsdom cannot see clipping, so this pins the property that makes clipping
    // impossible.
    render(<AccountRegister />);
    await screen.findByRole("table");
    await openCommonMenu();
    const menu = await screen.findByRole("menu", { name: "Common transactions" });
    expect(screen.getByRole("table").contains(menu)).toBe(false);
    expect(document.body.contains(menu)).toBe(true);
    // Every template is present, not just the ones that would have fitted.
    expect(await screen.findAllByRole("menuitem")).toHaveLength(3); // 2 + "Save this one…"
  });

  it("a saved template can be removed from the menu", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await openCommonMenu();
    await userEvent.click(await screen.findByRole("button", { name: "Remove Rent" }));
    await waitFor(() =>
      expect(invokeCalls.some((c) => c.cmd === "delete_common_transaction")).toBe(true)
    );
    // Removing must not fill the form from the template it removed.
    expect(screen.queryByDisplayValue("Anytown Properties")).not.toBeInTheDocument();
  });

  it("refuses to commit with no amount", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    await userEvent.type(screen.getByLabelText("Payee"), "Nothing");
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));
    expect(screen.getByText("Enter a Payment or a Deposit amount.")).toBeInTheDocument();
    expect(invokeCalls.some((c) => c.cmd === "create_transaction")).toBe(false);
  });

  it("Edit opens the selected row seeded from its values", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(dataRows()[1]); // the -42.50 Grocery Store row
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect((screen.getByLabelText("Payee") as HTMLInputElement).value).toBe("Grocery Store");
    expect((screen.getByLabelText("Payment") as HTMLInputElement).value).toBe("42.50");
    expect((screen.getByLabelText("Deposit") as HTMLInputElement).value).toBe("");
  });

  it("Edit seeds the Num from the row", async () => {
    // Same shape as the §15 category bug: a field the form forgets to seed
    // is a field an edit silently wipes.
    setIpcHandlers({
      get_register: () => [deposit, { ...withdrawal, check_number: "1042" }],
      list_categories: () => cats,
      list_payees: () => [],
      update_transaction: () => ({ id: "t-2" }),
      list_splits: () => [],
      get_all_accounts: () => [checking],
    });
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(dataRows()[1]);
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect((screen.getByLabelText("Num") as HTMLInputElement).value).toBe("1042");
  });

  // Regression, 2026-09-01. `seed()` never returned a category, so
  // `categoryId` always started "" — re-opening any transaction showed
  // "(none)" however it was filed, and committing that edit wrote NULL back
  // over the real category. Silent data loss on any edit, including one that
  // only touched the amount.
  // §17 — Money offers a known payee's last category when you re-enter it.
  // In short: recognize a common transaction and pre-fill the category
  // with the same one as last time.
  it("recalls a known payee's category on a new transaction", async () => {
    setIpcHandlers({
      get_register: () => rows,
      list_categories: () => cats,
      list_splits: () => [],
      list_payees: () => [
        {
          id: "p-1",
          name: "Netflix",
          last_category_id: "c-1",
          last_category_name: "Groceries",
          usage_count: 9,
          updated_at: "2026-09-01T00:00:00Z",
          last_amount_cents: null,
        },
      ],
    });
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "New" }));

    await userEvent.type(screen.getByLabelText("Payee"), "Netflix");
    await waitFor(() =>
      expect((screen.getByLabelText("Category:") as HTMLInputElement).value).toBe(
        "Groceries"
      )
    );
  });

  it("does not overrule a category the user already chose", async () => {
    setIpcHandlers({
      get_register: () => rows,
      list_categories: () => cats,
      list_splits: () => [],
      list_payees: () => [
        {
          id: "p-1",
          name: "Netflix",
          last_category_id: "c-1",
          last_category_name: "Groceries",
          usage_count: 9,
          updated_at: "2026-09-01T00:00:00Z",
          last_amount_cents: null,
        },
      ],
    });
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "New" }));

    await pickCategory("Automobile : Gasoline");
    await userEvent.type(screen.getByLabelText("Payee"), "Netflix");
    // Recall fills an EMPTY category; it never overwrites a deliberate choice.
    expect((screen.getByLabelText("Category:") as HTMLInputElement).value).toBe(
      "Automobile : Gasoline"
    );
  });

  // §17.4 — Money offers the payee's last AMOUNT as well as its category.
  // Most payees are the same figure every month, and this is half of why
  // entry in Money feels fast.

  const netflix = {
    id: "p-1",
    name: "Netflix",
    last_category_id: "c-1",
    last_category_name: "Groceries",
    usage_count: 9,
    updated_at: "2026-09-01T00:00:00Z",
    last_amount_cents: -1899,
  };

  it("recalls a known payee's last amount into Payment", async () => {
    setIpcHandlers({
      get_register: () => rows,
      list_categories: () => cats,
      list_splits: () => [],
      list_payees: () => [netflix],
    });
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "New" }));

    await userEvent.type(screen.getByLabelText("Payee"), "Netflix");
    await waitFor(() =>
      expect((screen.getByLabelText("Payment") as HTMLInputElement).value).toBe("18.99")
    );
    // A payment is a payment — it must not land in the Deposit column.
    expect((screen.getByLabelText("Deposit") as HTMLInputElement).value).toBe("");
  });

  it("recalls a positive last amount into Deposit", async () => {
    setIpcHandlers({
      get_register: () => rows,
      list_categories: () => cats,
      list_splits: () => [],
      list_payees: () => [{ ...netflix, name: "Paycheck", last_amount_cents: 250000 }],
    });
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "New" }));

    await userEvent.type(screen.getByLabelText("Payee"), "Paycheck");
    await waitFor(() =>
      expect((screen.getByLabelText("Deposit") as HTMLInputElement).value).toBe("2,500.00")
    );
    expect((screen.getByLabelText("Payment") as HTMLInputElement).value).toBe("");
  });

  it("does not overrule an amount the user already typed", async () => {
    // Same rule as the category: recall fills an empty field, it never
    // corrects a deliberate one.
    setIpcHandlers({
      get_register: () => rows,
      list_categories: () => cats,
      list_splits: () => [],
      list_payees: () => [netflix],
    });
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "New" }));

    await userEvent.type(screen.getByLabelText("Payment"), "5.00");
    await userEvent.type(screen.getByLabelText("Payee"), "Netflix");
    expect((screen.getByLabelText("Payment") as HTMLInputElement).value).toBe("5.00");
  });

  it("recalls nothing for a payee with no history", async () => {
    setIpcHandlers({
      get_register: () => rows,
      list_categories: () => cats,
      list_splits: () => [],
      list_payees: () => [{ ...netflix, last_amount_cents: null }],
    });
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "New" }));

    await userEvent.type(screen.getByLabelText("Payee"), "Netflix");
    await waitFor(() =>
      expect((screen.getByLabelText("Category:") as HTMLInputElement).value).toBe("Groceries")
    );
    expect((screen.getByLabelText("Payment") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Deposit") as HTMLInputElement).value).toBe("");
  });

  it("does not recall into a transaction being edited", async () => {
    // Re-filing or re-pricing something the user opened to change would be a
    // surprise; recall is for new entry only.
    setIpcHandlers({
      get_register: () => rows,
      list_categories: () => cats,
      list_splits: () => [],
      list_payees: () => [{ ...netflix, name: "Grocery Store" }],
      update_transaction: () => ({ id: "t-2" }),
      get_all_accounts: () => [checking],
    });
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(dataRows()[1]);
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    // Seeded from the row (-42.50), not from the payee's last amount.
    expect((screen.getByLabelText("Payment") as HTMLInputElement).value).toBe("42.50");
  });

  it("offers known payees for completion", async () => {
    setIpcHandlers({
      get_register: () => rows,
      list_categories: () => cats,
      list_splits: () => [],
      list_payees: () => [
        {
          id: "p-1",
          name: "Netflix",
          last_category_id: null,
          last_category_name: null,
          usage_count: 9,
          updated_at: "2026-09-01T00:00:00Z",
          last_amount_cents: null,
        },
      ],
    });
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    // §82: typing opens the suggestions; Tab takes the highlighted one.
    const input = screen.getByLabelText("Payee") as HTMLInputElement;
    await userEvent.type(input, "net");
    const list = await screen.findByRole("listbox", { name: "Payee suggestions" });
    expect(within(list).getByRole("option", { name: /Netflix/ })).toHaveAttribute("aria-selected", "true");
    await userEvent.tab();
    expect(input.value).toBe("Netflix");
    expect(screen.queryByRole("listbox", { name: "Payee suggestions" })).toBeNull();
  });

  // §18 — typing a category that does not exist offers to create it without
  // abandoning the transaction.
  it("offers to add a category that does not exist", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    const box = screen.getByLabelText("Category:");
    await userEvent.click(box);
    await userEvent.type(box, "Household");
    expect(await screen.findByRole("option", { name: /Add "Household"/ })).toBeInTheDocument();
  });

  it("does not offer to add something that already exists", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    const box = screen.getByLabelText("Category:");
    await userEvent.click(box);
    await userEvent.type(box, "Groceries");
    expect(screen.queryByRole("option", { name: /Add "Groceries"/ })).not.toBeInTheDocument();
  });

  it("creates a top-level category with a subcategory and selects the child", async () => {
    // The store reloads categories after each create, so the fake backend has
    // to actually remember them — otherwise the combo cannot resolve the new
    // id to a label and the assertion would be testing the stub, not the app.
    const live: Category[] = [...cats];
    setIpcHandlers({
      get_register: () => rows,
      list_categories: () => live,
      list_splits: () => [],
      list_payees: () => [],
      create_category: (args) => {
        const made: Category = args.parentId
          ? {
              id: "new-child", name: String(args.name), parent_id: String(args.parentId),
              kind: "expense", tax_line: null,
              full_name: `House : ${String(args.name)}`, usage_count: 0,
            }
          : {
              id: "new-top", name: String(args.name), parent_id: null,
              kind: "expense", tax_line: null,
              full_name: String(args.name), usage_count: 0,
            };
        live.push(made);
        return made;
      },
    });
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    const box = screen.getByLabelText("Category:");
    await userEvent.click(box);
    await userEvent.type(box, "House");
    await userEvent.click(await screen.findByRole("option", { name: /Add "House"/ }));

    await userEvent.type(screen.getByLabelText("Subcategory name"), "Repairs");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    // Two creates: the parent, then the child — and the CHILD is selected,
    // because naming a child is what the user meant to file against.
    await waitFor(() =>
      expect(invokeCalls.filter((c) => c.cmd === "create_category")).toHaveLength(2)
    );
    const [parent, child] = invokeCalls.filter((c) => c.cmd === "create_category");
    expect(parent.args).toMatchObject({ name: "House", parentId: null });
    expect(child.args).toMatchObject({ name: "Repairs", parentId: "new-top" });
    await waitFor(() =>
      expect((screen.getByLabelText("Category:") as HTMLInputElement).value).toBe(
        "House : Repairs"
      )
    );
  });

  it("typing 'Existing : New' adds a subcategory under the existing one", async () => {
    // The reported case: "Other Income : Garage Sale" used to put "Other
    // Income" in the subcategory box and ask for a parent.
    const live: Category[] = [...cats];
    setIpcHandlers({
      get_register: () => rows,
      list_categories: () => live,
      list_splits: () => [],
      list_payees: () => [],
      create_category: (args) => {
        const made: Category = {
          id: "new-child", name: String(args.name), parent_id: String(args.parentId),
          kind: "expense", tax_line: null,
          full_name: `Groceries : ${String(args.name)}`, usage_count: 0,
        };
        live.push(made);
        return made;
      },
    });
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    const box = screen.getByLabelText("Category:");
    await userEvent.click(box);
    await userEvent.type(box, "Groceries : Produce");
    await userEvent.click(await screen.findByRole("option", { name: /Add "Produce" under Groceries/ }));
    expect(screen.getByLabelText("Subcategory of an existing category")).toBeChecked();
    expect((screen.getByLabelText("New category name") as HTMLInputElement).value).toBe("Produce");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(invokeCalls.filter((c) => c.cmd === "create_category")).toHaveLength(1));
    expect(invokeCalls.find((c) => c.cmd === "create_category")!.args).toMatchObject({ name: "Produce", parentId: "c-1" });
    await waitFor(() => expect((screen.getByLabelText("Category:") as HTMLInputElement).value).toBe("Groceries : Produce"));
  });

  it("Edit preselects the transaction's own category", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(dataRows()[1]);
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect((screen.getByLabelText("Category:") as HTMLInputElement).value).toBe("Groceries");
  });

  it("editing something else does NOT wipe the category", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(dataRows()[1]);
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));

    // Change only the memo, the way a user fixing a typo would.
    await userEvent.type(screen.getByLabelText("Memo:"), "corrected");
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));

    const call = await waitFor(
      () => invokeCalls.find((c) => c.cmd === "update_transaction")!
    );
    const payload = call.args.payload as { category_id: string | null };
    expect(payload.category_id).toBe("c-1");
  });

  it("recategorizing saves the new category", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(dataRows()[1]);
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await pickCategory("Automobile : Gasoline");
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));

    const call = await waitFor(
      () => invokeCalls.find((c) => c.cmd === "update_transaction")!
    );
    const payload = call.args.payload as { category_id: string | null };
    expect(payload.category_id).toBe("c-2");
  });

  it("clearing the category to (none) is still respected", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(dataRows()[1]);
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    // Clearing: open the list and take the explicit "(none)" entry.
    await userEvent.click(screen.getByLabelText("Category:"));
    await userEvent.click(await screen.findByRole("option", { name: "(none)" }));
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));

    const call = await waitFor(
      () => invokeCalls.find((c) => c.cmd === "update_transaction")!
    );
    const payload = call.args.payload as { category_id: string | null };
    expect(payload.category_id).toBeNull();
  });

  it("Edit commits through update_transaction, not create", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(dataRows()[1]);
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));
    await waitFor(() =>
      expect(invokeCalls.some((c) => c.cmd === "update_transaction")).toBe(true)
    );
    expect(invokeCalls.some((c) => c.cmd === "create_transaction")).toBe(false);
  });

  it("Cancel closes the form without saving", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Payee")).not.toBeInTheDocument();
    expect(invokeCalls.some((c) => c.cmd === "create_transaction")).toBe(false);
  });

  it("Delete removes the selected transaction", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(dataRows()[1]);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(invokeCalls).toContainEqual({ cmd: "delete_transaction", args: { id: "t-2" } })
    );
  });

  it("Split asks the spent/received question when there is no amount yet", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    await userEvent.click(screen.getByRole("button", { name: "Split" }));
    expect(screen.getByText("Did you spend or receive this money?")).toBeInTheDocument();
  });

  it("Split skips the prompt when the amount already has a sign", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    await userEvent.type(screen.getByLabelText("Payment"), "100.00");
    await userEvent.click(screen.getByRole("button", { name: "Split" }));
    expect(screen.queryByText("Did you spend or receive this money?")).not.toBeInTheDocument();
    expect(
      screen.getByRole("dialog", { name: "Transaction with Multiple Categories" })
    ).toBeInTheDocument();
  });

  it("itemizing sets the transaction amount from the split total (§6.1e)", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    await userEvent.type(screen.getByLabelText("Payee"), "Walmart");
    await userEvent.click(screen.getByRole("button", { name: "Split" }));
    await userEvent.click(screen.getByRole("button", { name: "I spent money" }));

    await pickIn("Category 1", "Groceries");
    await userEvent.type(screen.getByLabelText("Amount 1"), "30.00");
    await pickIn("Category 2", "Automobile : Gasoline");
    await userEvent.type(screen.getByLabelText("Amount 2"), "12.50");
    await userEvent.click(screen.getByRole("button", { name: "Done" }));

    // The split total becomes the parent's Payment amount.
    expect((screen.getByLabelText("Payment") as HTMLInputElement).value).toBe("42.50");
  });

  it("saves splits after the parent transaction exists", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    await userEvent.type(screen.getByLabelText("Payee"), "Walmart");
    await userEvent.click(screen.getByRole("button", { name: "Split" }));
    await userEvent.click(screen.getByRole("button", { name: "I spent money" }));
    await pickIn("Category 1", "Groceries");
    await userEvent.type(screen.getByLabelText("Amount 1"), "30.00");
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));

    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "create_transaction")).toBe(true));
    // §168 — the lines ride in the create itself, one command and one undo
    // step; there is no second call.
    expect(invokeCalls.some((c) => c.cmd === "set_splits")).toBe(false);
    const call = invokeCalls.find((c) => c.cmd === "create_transaction")!;
    expect(call.args).toMatchObject({
      payload: {
        amount_cents: -3000,
        // §102: every line carries `transfer_account_id`, null unless the line
        // is a transfer. Rust defaults it, so an older payload still works.
        splits: [{ category_id: "c-1", transfer_account_id: null, description: null, amount_cents: -3000 }],
      },
    });
  });

  it("re-splitting an existing transaction writes the lines BEFORE the edit (§38)", async () => {
    // `set_splits` is the one call allowed to move a split row's total;
    // `update_transaction` refuses an amount change on a row that has lines.
    // So for an existing row the lines go first, and the edit then carries
    // an amount the row already has.
    setIpcHandlers({
      get_register: () => rows,
      list_categories: () => cats,
      list_payees: () => [],
      list_splits: () => [
        { id: "s-1", transaction_id: "t-2", category_id: "c-1", description: null, amount_cents: -4250, sort_order: 0 },
      ],
      set_splits: () => [],
      update_transaction: () => ({ id: "t-2" }),
      get_all_accounts: () => [checking],
      list_common_transactions: () => [],
    });
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.dblClick(dataRows()[1]);
    await screen.findByLabelText("Payee");
    // The amount is the lines' business now.
    expect(screen.getByLabelText("Payment")).toHaveAttribute("readonly");
    await userEvent.click(screen.getByRole("button", { name: /^Split \(1 categories\)/ }));
    const amt = await screen.findByLabelText("Amount 1");
    await userEvent.clear(amt);
    await userEvent.type(amt, "50.00");
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    // §160 — the lines no longer add up to the $42.50 the row had, so Done
    // asks before it moves the amount.
    await userEvent.click(screen.getByRole("button", { name: /^Change the amount to/ }));
    expect((screen.getByLabelText("Payment") as HTMLInputElement).value).toBe("50.00");
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));

    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "update_transaction")).toBe(true));
    // §168 — the lines ride in the edit itself; the backend writes them
    // first and then the edit, in one undo step.
    expect(invokeCalls.some((c) => c.cmd === "set_splits")).toBe(false);
    expect(invokeCalls.find((c) => c.cmd === "update_transaction")!.args).toMatchObject({
      payload: expect.objectContaining({
        amount_cents: -5000,
        splits: [expect.objectContaining({ category_id: "c-1", amount_cents: -5000 })],
      }),
    });
  });

  it("checking Show transaction forms opens the form on the selected row", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(dataRows()[1]);
    expect(screen.queryByLabelText("Payee")).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Show transaction forms"));
    expect(screen.getByLabelText("Payee")).toBeInTheDocument();
  });
});

describe("classifications in the register (§112)", () => {
  /** The register opens a row on its SECOND click, as Money does. */
  async function openGroceryRow(user: ReturnType<typeof userEvent.setup>) {
    const row = screen.getByText("Grocery Store").closest("tr")!;
    await user.click(row);
    await user.click(row);
    await screen.findByLabelText("Payee");
  }

  // The axis reaches a transaction the way the goal and the tax line do —
  // one small command after the row is saved — so an import or a scheduled
  // entry that knows nothing about classifications is untouched by it.
  const property = {
    id: "cl-prop",
    name: "Property",
    sort_order: 0,
    usage_count: 0,
    values: [
      { id: "v-cos", classification_id: "cl-prop", parent_id: null, name: "Maple", full_name: "Maple", usage_count: 0 },
      { id: "v-lak", classification_id: "cl-prop", parent_id: null, name: "Birch Lane", full_name: "Birch Lane", usage_count: 0 },
    ],
  };

  function handlers(extra: Record<string, unknown> = {}) {
    setIpcHandlers({
      get_register: () => rows,
      list_categories: () => [],
      list_payees: () => [],
      list_splits: () => [],
      set_splits: () => [],
      get_all_accounts: () => [checking],
      list_common_transactions: () => [],
      list_classifications: () => [property],
      set_transaction_classes: () => [],
      update_transaction: () => ({ id: "t-2" }),
      create_transaction: () => ({ id: "t-3" }),
      ...extra,
    });
    useAccountStore.setState({ accounts: [checking], selectedAccountId: "acc-1" });
  }

  it("writes the picked value after the transaction is saved", async () => {
    handlers();
    render(<AccountRegister />);
    const user = userEvent.setup();
    await screen.findByRole("table");
    await openGroceryRow(user);
    await user.selectOptions(await screen.findByLabelText("Property"), "v-cos");
    await user.click(screen.getByRole("button", { name: "Enter" }));
    await waitFor(() =>
      expect(invokeCalls.find((c) => c.cmd === "set_transaction_classes")?.args).toEqual({
        transactionId: "t-2",
        // Every axis is sent, so an axis cleared on the form is cleared in
        // the file rather than left as it was.
        picks: [{ classification_id: "cl-prop", value_id: "v-cos" }],
      })
    );
  });

  it("does not touch the classifications when nothing about them changed", async () => {
    handlers({
      get_register: () => [deposit, { ...withdrawal, classes: [{ classification_id: "cl-prop", value_id: "v-cos", label: "Maple" }] }],
    });
    render(<AccountRegister />);
    const user = userEvent.setup();
    await screen.findByRole("table");
    await openGroceryRow(user);
    expect((await screen.findByLabelText("Property")) as HTMLSelectElement).toHaveValue("v-cos");
    await user.type(screen.getByLabelText(/^Memo/), "milk");
    await user.click(screen.getByRole("button", { name: "Enter" }));
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "update_transaction")).toBe(true));
    expect(invokeCalls.some((c) => c.cmd === "set_transaction_classes")).toBe(false);
  });

  it("keeps a split line's own value when the transaction is edited without opening the split", async () => {
    // A review finding, and it was silent: the register rebuilt each split
    // line from three fields, and `set_splits` REPLACES the whole set on any
    // save — so changing a date on a split transaction deleted every line's
    // classification, and its transfer account with it.
    handlers({
      list_splits: () => [
        { id: "s-1", transaction_id: "t-2", category_id: "c-1", description: "food", amount_cents: -3000, sort_order: 0, transfer_account_id: null, classes: [{ classification_id: "cl-prop", value_id: "v-cos", label: "Maple" }] },
        { id: "s-2", transaction_id: "t-2", category_id: null, description: null, amount_cents: -1250, sort_order: 1, transfer_account_id: "acc-2", classes: [] },
      ],
    });
    render(<AccountRegister />);
    const user = userEvent.setup();
    await screen.findByRole("table");
    await openGroceryRow(user);
    await user.type(screen.getByLabelText(/^Memo/), "receipt");
    await user.click(screen.getByRole("button", { name: "Enter" }));
    // §168 — the lines travel in the edit payload itself.
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "update_transaction")).toBe(true));
    const sent = (invokeCalls.find((c) => c.cmd === "update_transaction")!.args as { payload: { splits: NewSplit[] } }).payload;
    expect(sent.splits[0].classes).toEqual([{ classification_id: "cl-prop", value_id: "v-cos", label: "Maple" }]);
    expect(sent.splits[1].transfer_account_id).toBe("acc-2");
  });

  it("shows what the split lines are classified as when the row itself is not", async () => {
    // §117.3 — reported as "I tagged the principal line and the register
    // shows (none)". It did: the row only ever showed the TRANSACTION's own
    // value, so a mortgage tagged line by line looked untagged.
    handlers({
      get_register: () => [
        deposit,
        { ...withdrawal, classes: [], line_classes: [{ classification_id: "cl-prop", value_id: "v-cos", label: "418 Maple Street" }] },
      ],
    });
    render(<AccountRegister />);
    expect(await screen.findByTitle(/Every split line is classified as "418 Maple Street"/)).toBeInTheDocument();
  });

  it("says so rather than picking one when the lines disagree", async () => {
    handlers({
      get_register: () => [
        deposit,
        { ...withdrawal, classes: [], line_classes: [{ classification_id: "cl-prop", value_id: "", label: "2 values" }] },
      ],
    });
    render(<AccountRegister />);
    expect(await screen.findByTitle(/The split lines carry 2 values/)).toBeInTheDocument();
  });

  it("keeps the transaction's classification when the split dialog is opened and closed in the same edit", async () => {
    // The reported sequence: pick 418 on the transaction, open Split (the
    // lines show "(418 Maple Street)" — the inherited placeholder),
    // press Done, press Enter. Reported as: all of it gone afterwards.
    handlers({
      get_register: () => [deposit, { ...withdrawal, amount_cents: -15000, classes: [] }],
      list_splits: () => [
        { id: "s-1", transaction_id: "t-2", category_id: "c-1", description: "principal", amount_cents: -8000, sort_order: 0, transfer_account_id: null, classes: [] },
        { id: "s-2", transaction_id: "t-2", category_id: "c-1", description: "interest", amount_cents: -7000, sort_order: 1, transfer_account_id: null, classes: [] },
      ],
    });
    render(<AccountRegister />);
    const user = userEvent.setup();
    await screen.findByRole("table");
    await openGroceryRow(user);

    // 1. the transaction's own value
    await user.selectOptions(await screen.findByLabelText("Property"), "v-cos");
    // 2. open the split, and leave every line inheriting
    await user.click(screen.getByRole("button", { name: "Split" }));
    const dialog = await screen.findByRole("dialog", { name: "Transaction with Multiple Categories" });
    expect(within(dialog).getAllByLabelText(/^Property \d/)[0]).toHaveValue("");
    // The brackets mean "this line follows the transaction" — §117.5 says so
    // in words, because "(X)" beside "X" did not.
    expect(
      within(within(dialog).getAllByLabelText(/^Property \d/)[0]).getByRole("option", {
        name: "(same as the transaction — Maple)",
      })
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    // 3. Enter
    await user.click(screen.getByRole("button", { name: "Enter" }));

    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "set_transaction_classes")).toBe(true));
    const sent = invokeCalls.find((c) => c.cmd === "set_transaction_classes")!.args as { picks: { value_id: string }[] };
    expect(sent.picks).toEqual([{ classification_id: "cl-prop", value_id: "v-cos" }]);

    // §117.4 — and the REGISTER must be read again afterwards. The store
    // reloads inside update_transaction, which happens BEFORE this write, so
    // without a second read the row on screen is the one from a moment
    // before the tag existed: no mark, and re-opening the row seeds the form
    // from that stale row as "(none)". The tag was in the file all along,
    // which is why it came back after switching accounts.
    const wrote = invokeCalls.findIndex((c) => c.cmd === "set_transaction_classes");
    expect(invokeCalls.slice(wrote).some((c) => c.cmd === "get_register")).toBe(true);
  });

  it("grays out a classification with no values, and says where to add them", async () => {
    // §117.1 — the shape people get wrong first: a classification per house,
    // instead of one Property classification with the houses in it. The
    // register drew four usable-looking fields with nothing in any of them.
    handlers({ list_classifications: () => [{ ...property, values: [] }] });
    render(<AccountRegister />);
    const user = userEvent.setup();
    await screen.findByRole("table");
    await openGroceryRow(user);
    const field = (await screen.findByLabelText("Property")) as HTMLSelectElement;
    expect(field).toBeDisabled();
    expect(field.options[0].text).toMatch(/no values yet/i);
  });

  it("shows the value on the row, and offers no field at all when the file has none", async () => {
    handlers({
      get_register: () => [deposit, { ...withdrawal, classes: [{ classification_id: "cl-prop", value_id: "v-cos", label: "Maple" }] }],
    });
    const { unmount } = render(<AccountRegister />);
    expect(await screen.findByTitle('Classified as "Maple"')).toBeInTheDocument();
    unmount();

    handlers({ list_classifications: () => [] });
    render(<AccountRegister />);
    const user = userEvent.setup();
    await screen.findByRole("table");
    await openGroceryRow(user);
    expect(await screen.findByLabelText(/^Memo/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Property")).not.toBeInTheDocument();
  });
});

describe("transfers (§10.2 item 5)", () => {
  const savings: Account = { ...checking, id: "acc-2", name: "Everyday Savings 5678", balance_cents: 500000 };

  beforeEach(() => {
    setIpcHandlers({
      get_register: () => rows,
      list_categories: () => [{ id: "c-1", name: "Groceries" }],
      list_payees: () => [],
      list_splits: () => [],
      create_transfer: () => ({ id: "t-9" }),
      create_transaction: () => ({ id: "t-3" }),
      get_all_accounts: () => [checking, savings],
    });
    useAccountStore.setState({
      accounts: [checking, savings],
      selectedAccountId: "acc-1",
    });
  });

  it("offers other accounts as 'Transfer : <Account>' categories", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    const list = await openCategoryList();
    expect(
      within(list).getByRole("option", { name: "Transfer : Everyday Savings 5678" })
    ).toBeInTheDocument();
    // Never offers the account you are already in.
    expect(
      within(list).queryByRole("option", { name: "Transfer : Everyday Checking 1234" })
    ).not.toBeInTheDocument();
  });

  it("fills the payee with 'Transfer Money', as Money does", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    await pickCategory("Transfer : Everyday Savings 5678");
    expect((screen.getByLabelText("Payee") as HTMLInputElement).value).toBe("Transfer Money");
  });

  it("saves through create_transfer, not create_transaction", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    await pickCategory("Transfer : Everyday Savings 5678");
    await userEvent.type(screen.getByLabelText("Payment"), "250.00");
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));

    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "create_transfer")).toBe(true));
    expect(invokeCalls.some((c) => c.cmd === "create_transaction")).toBe(false);
    const call = invokeCalls.find((c) => c.cmd === "create_transfer")!;
    expect(call.args).toMatchObject({
      fromAccountId: "acc-1",
      toAccountId: "acc-2",
      amountCents: 25000, // a magnitude — direction comes from the account ids
    });
  });

  // `cats` lives in the in-place-form describe and is NOT in scope here. The
  // IPC mock's handler is lazy, so referencing it threw inside the call and
  // loadCategories swallowed it — leaving the picker silently empty rather
  // than failing loudly. Own fixture, own scope.
  const transferCats: Category[] = [
    {
      id: "c-1", name: "Groceries", parent_id: null, kind: "expense",
      tax_line: null, full_name: "Groceries", usage_count: 0,
    },
  ];

  // §20 — a transfer sent to the wrong account is editable in place. It used
  // to be read-only, with "delete it and re-enter" as the only recourse, which
  // also threw away the row's reconcile state.
  const transferRow: RegisterRow = {
    ...withdrawal,
    id: "t-7",
    payee: "Transfer Money",
    category_id: null,
    transfer_account_name: "Everyday Savings 5678",
    transfer_account_id: "acc-2",
  };

  function openTransfer() {
    setIpcHandlers({
      get_register: () => [transferRow],
      list_categories: () => transferCats,
      list_payees: () => [],
      list_splits: () => [],
      update_transfer: () => ({ id: "t-7" }),
      get_all_accounts: () => [checking],
    });
  }

  it("opens an existing transfer with the other account preselected", async () => {
    openTransfer();
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.dblClick(dataRows()[0]);
    expect((screen.getByLabelText("Category:") as HTMLInputElement).value).toBe(
      "Transfer : Everyday Savings 5678"
    );
  });

  it("sends the transfer to a different account", async () => {
    openTransfer();
    useAccountStore.setState({
      accounts: [
        checking,
        { ...checking, id: "acc-2", name: "Everyday Savings 5678", balance_cents: 0 },
        { ...checking, id: "acc-3", name: "Vacation Fund", balance_cents: 0 },
      ],
      selectedAccountId: "acc-1",
    });
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.dblClick(dataRows()[0]);
    await pickCategory("Transfer : Vacation Fund");
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));

    const call = await waitFor(() => invokeCalls.find((c) => c.cmd === "update_transfer")!);
    expect(call.args).toMatchObject({ id: "t-7", otherAccountId: "acc-3" });
    // Never a delete-and-recreate: the row keeps its identity.
    expect(invokeCalls.some((c) => c.cmd === "delete_transaction")).toBe(false);
    expect(invokeCalls.some((c) => c.cmd === "create_transfer")).toBe(false);
  });

  it("changes a transfer's amount, keeping the edited side's sign", async () => {
    openTransfer();
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.dblClick(dataRows()[0]);
    const payment = screen.getByLabelText("Payment") as HTMLInputElement;
    await userEvent.clear(payment);
    await userEvent.type(payment, "400.00");
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));

    const call = await waitFor(() => invokeCalls.find((c) => c.cmd === "update_transfer")!);
    // Negative: this side is the one paying out.
    expect(call.args).toMatchObject({ amountCents: -40000, otherAccountId: "acc-2" });
  });

  // §164 — §20.2 refused both of these as "a different pair of rows". They
  // are, and the register now writes or removes the partner row itself,
  // because an imported row the bank called a transfer arrives as an
  // ordinary one and delete-and-re-enter lost its cleared mark.
  it("turns a transfer into an ordinary transaction: the partner goes, then the edit runs", async () => {
    setIpcHandlers({
      get_register: () => [transferRow],
      list_categories: () => transferCats,
      list_payees: () => [],
      list_splits: () => [],
      get_all_accounts: () => [checking],
      list_common_transactions: () => [],
      convert_from_transfer: () => ({ id: "t-7" }),
      update_transaction: () => ({ id: "t-7" }),
    });
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.dblClick(dataRows()[0]);
    await pickCategory("Groceries");
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));

    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "update_transaction")).toBe(true));
    const cmds = invokeCalls.map((c) => c.cmd);
    expect(invokeCalls.find((c) => c.cmd === "convert_from_transfer")!.args).toEqual({ id: "t-7", categoryId: "c-1" });
    expect(cmds.indexOf("convert_from_transfer")).toBeLessThan(cmds.indexOf("update_transaction"));
    expect(cmds).not.toContain("update_transfer");
    expect(cmds).not.toContain("delete_transaction");
  });

  it("turns an ordinary transaction into a transfer: the partner is written, then the transfer edit runs", async () => {
    setIpcHandlers({
      get_register: () => rows,
      list_categories: () => transferCats,
      list_payees: () => [],
      list_splits: () => [],
      get_all_accounts: () => [checking],
      list_common_transactions: () => [],
      convert_to_transfer: () => ({ id: "t-2" }),
      update_transfer: () => ({ id: "t-2" }),
    });
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.dblClick(dataRows()[1]);
    await pickCategory("Transfer : Everyday Savings 5678");
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));

    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "update_transfer")).toBe(true));
    const cmds = invokeCalls.map((c) => c.cmd);
    expect(invokeCalls.find((c) => c.cmd === "convert_to_transfer")!.args).toEqual({ id: "t-2", otherAccountId: "acc-2" });
    expect(cmds.indexOf("convert_to_transfer")).toBeLessThan(cmds.indexOf("update_transfer"));
    // Never delete-and-create: the row keeps its identity and its marks.
    expect(cmds).not.toContain("update_transaction");
    expect(cmds).not.toContain("delete_transaction");
    expect(cmds).not.toContain("create_transfer");
  });
});

describe("register interactions", () => {
  beforeEach(() => {
    setIpcHandlers({
      get_register: () => rows,
      list_categories: () => [],
      list_payees: () => [],
      list_splits: () => [],
      delete_transaction: () => null,
      get_all_accounts: () => [checking],
      list_common_transactions: () => [],
    });
    useAccountStore.setState({ accounts: [checking], selectedAccountId: "acc-1" });
  });

  it("double-clicking a row opens it for editing", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.dblClick(dataRows()[1]);
    expect((screen.getByLabelText("Payee") as HTMLInputElement).value).toBe("Grocery Store");
  });

  it("clicking an already-selected row opens it", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(dataRows()[1]);
    expect(screen.queryByLabelText("Payee")).not.toBeInTheDocument();
    await userEvent.click(dataRows()[1]);
    expect(screen.getByLabelText("Payee")).toBeInTheDocument();
  });

  it("clicking an empty row starts a new transaction", async () => {
    const { container } = render(<AccountRegister />);
    await screen.findByRole("table");
    const filler = container.querySelector("tr.filler")!;
    await userEvent.click(filler);
    expect(screen.getByLabelText("Payee")).toBeInTheDocument();
    expect((screen.getByLabelText("Payee") as HTMLInputElement).value).toBe("");
  });

  it("right-clicking a row opens a menu offering Delete", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    fireEvent.contextMenu(dataRows()[1]);
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Delete transaction" })).toBeInTheDocument();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Delete transaction" }));
    await waitFor(() =>
      expect(invokeCalls).toContainEqual({ cmd: "delete_transaction", args: { id: "t-2" } })
    );
  });

  it("Tax line… on a row takes it out of the tax reports or puts it on a line (§53)", async () => {
    let rowsNow = rows;
    setIpcHandlers({
      get_register: () => rowsNow,
      list_categories: () => [],
      list_payees: () => [],
      get_all_accounts: () => [checking],
      list_common_transactions: () => [],
      set_transaction_tax_line: (args) => {
        rowsNow = rowsNow.map((r) => (r.id === args.transactionId ? { ...r, tax_line: args.taxLine as string | null } : r));
        return null;
      },
    });
    render(<AccountRegister />);
    await screen.findByRole("table");
    fireEvent.contextMenu(dataRows()[1]);
    await userEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Tax line…" }));
    const dlg = screen.getByRole("dialog", { name: "Tax line for this transaction" });
    expect(within(dlg).getByLabelText(/Whatever its category says/)).toBeChecked();
    await userEvent.click(within(dlg).getByLabelText(/Not tax-related/));
    await waitFor(() => expect(invokeCalls).toContainEqual({ cmd: "set_transaction_tax_line", args: { transactionId: "t-2", taxLine: "" } }));
    await waitFor(() => expect(within(dlg).getByLabelText(/Not tax-related/)).toBeChecked());
    expect(screen.getByText("§ not tax-related")).toBeInTheDocument();
    await userEvent.selectOptions(within(dlg).getByLabelText("Tax line for this transaction"), "Schedule A: Medical and dental expenses");
    await waitFor(() => expect(invokeCalls).toContainEqual({ cmd: "set_transaction_tax_line", args: { transactionId: "t-2", taxLine: "Schedule A: Medical and dental expenses" } }));
    await waitFor(() => expect(within(dlg).getByLabelText(/On this line/)).toBeChecked());
    expect(screen.getByText("§ Schedule A: Medical and dental expenses")).toBeInTheDocument();
    await userEvent.click(within(dlg).getByLabelText(/Whatever its category says/));
    await waitFor(() => expect(invokeCalls).toContainEqual({ cmd: "set_transaction_tax_line", args: { transactionId: "t-2", taxLine: null } }));
  });
});

describe("save failures are visible (regression)", () => {
  // A failed save used to be fire-and-forget: the backend rejected, nothing
  // was rendered, and Enter looked like it did nothing at all.
  beforeEach(() => {
    setIpcHandlers({
      get_register: () => rows,
      list_categories: () => [],
      list_payees: () => [],
      list_splits: () => [],
      create_transfer: () => {
        throw new Error("FOREIGN KEY constraint failed");
      },
      create_transaction: () => {
        throw new Error("database is locked");
      },
      get_all_accounts: () => [checking],
    });
    useAccountStore.setState({
      accounts: [
        checking,
        { ...checking, id: "acc-2", name: "Test Savings", balance_cents: 0 },
      ],
      selectedAccountId: "acc-1",
    });
  });

  it("shows the backend error when an ordinary save fails", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    await userEvent.type(screen.getByLabelText("Payee"), "Anything");
    await userEvent.type(screen.getByLabelText("Payment"), "10.00");
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));
    expect(await screen.findByText(/database is locked/)).toBeInTheDocument();
  });

  it("shows the backend error when a transfer fails", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    await pickCategory("Transfer : Test Savings");
    await userEvent.type(screen.getByLabelText("Payment"), "250.00");
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));
    expect(await screen.findByText(/FOREIGN KEY constraint failed/)).toBeInTheDocument();
  });
});

// Regression, 2026-09-03. `reconcileRequest` was a counter that only ever
// went up, and the effect that reads it — like every effect — also runs on
// mount. Once the rail's Reconcile item had been clicked a single time the
// value stayed above zero for the life of the session, so the wizard reopened
// on EVERY remount of the register: Banking → Bills → Banking, or picking an
// account after visiting any other rail item. Reported as "clicking between
// the bills and banking tab triggered the reconcile dialog" (§26.1).
describe("the reconcile request is one-shot", () => {
  const statementRows = rows;

  function mount() {
    setIpcHandlers({
      get_register: () => statementRows,
      list_categories: () => [],
      list_payees: () => [],
      list_splits: () => [],
      get_all_accounts: () => [checking],
      get_open_statement: () => null,
      get_last_statement: () => null,
      start_statement: () => ({ id: "st-1" }),
    });
    useAccountStore.setState({ accounts: [checking], selectedAccountId: "acc-1" });
  }

  it("opens the wizard once when the rail asks", async () => {
    mount();
    useAccountStore.getState().requestReconcile();
    render(<AccountRegister />);
    expect(await screen.findByRole("dialog", { name: /Balance/i })).toBeInTheDocument();
  });

  it("clears the request as soon as it acts on it", async () => {
    mount();
    useAccountStore.getState().requestReconcile();
    render(<AccountRegister />);
    await screen.findByRole("dialog", { name: /Balance/i });
    expect(useAccountStore.getState().reconcileRequest).toBe(0);
  });

  it("does not reopen the wizard when the register remounts", async () => {
    // This is the bug, exactly: ask once, leave, come back.
    mount();
    useAccountStore.getState().requestReconcile();
    const first = render(<AccountRegister />);
    await screen.findByRole("dialog", { name: /Balance/i });
    first.unmount();

    render(<AccountRegister />);
    await screen.findByRole("table");
    expect(screen.queryByRole("dialog", { name: /Balance/i })).not.toBeInTheDocument();
  });

  it("does not open the wizard on a plain mount", async () => {
    mount();
    render(<AccountRegister />);
    await screen.findByRole("table");
    expect(screen.queryByRole("dialog", { name: /Balance/i })).not.toBeInTheDocument();
  });

  it("drops a request that arrives with no account selected", async () => {
    // Left armed, it would have fired the next time an account was chosen —
    // which is the other half of what the user saw.
    mount();
    useAccountStore.setState({ selectedAccountId: null });
    useAccountStore.getState().requestReconcile();
    render(<AccountRegister />);
    await waitFor(() => expect(useAccountStore.getState().reconcileRequest).toBe(0));
    expect(screen.queryByRole("dialog", { name: /Balance/i })).not.toBeInTheDocument();
  });
});

describe("reconcile (§6.1f)", () => {
  const statement = {
    id: "st-1",
    account_id: "acc-1",
    statement_date: "2026-09-09",
    starting_balance_cents: 150000,
    ending_balance_cents: 145750,
    status: "in_progress" as const,
    reconciled_on: null,
    service_charge_cents: null,
    service_charge_category_id: null,
    interest_cents: null,
    interest_category_id: null,
    adjustment_cents: null,
    adjustment_category_id: null,
  };

  function handlers(over: Record<string, () => unknown> = {}) {
    setIpcHandlers({
      get_register: () => rows,
      list_categories: () => [{ id: "c-1", name: "Bank Charges" }],
      list_payees: () => [],
      list_splits: () => [],
      get_all_accounts: () => [checking],
      get_open_statement: () => null,
      get_last_statement: () => null,
      start_statement: () => statement,
      set_cleared: () => null,
      finish_statement: () => ({ ...statement, status: "completed", reconciled_on: "2026-09-09" }),
      ...over,
    });
    useAccountStore.setState({ accounts: [checking], selectedAccountId: "acc-1" });
  }

  it("goes straight to the statement form when nothing is postponed", async () => {
    handlers();
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "Balance this account" }));
    expect(
      await screen.findByText("Enter the following information from your bank statement")
    ).toBeInTheDocument();
  });

  it("shows the resume dialog when a statement was postponed (§6.1f A)", async () => {
    handlers({ get_open_statement: () => statement });
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "Balance this account" }));
    expect(await screen.findByText(/previously began the process of balancing/)).toBeInTheDocument();
    expect(screen.getByText(/including all the transactions you marked as cleared/)).toBeInTheDocument();
  });

  it("requires an ending balance before continuing", async () => {
    handlers();
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "Balance this account" }));
    await userEvent.click(await screen.findByRole("button", { name: "Next >" }));
    expect(screen.getByText("Enter the ending balance from your statement.")).toBeInTheDocument();
    expect(invokeCalls.some((c) => c.cmd === "start_statement")).toBe(false);
  });

  it("switches the register into the grouped clearing view", async () => {
    handlers();
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "Balance this account" }));
    await userEvent.type(screen.getByLabelText("Ending balance:"), "1457.50");
    await userEvent.click(screen.getByRole("button", { name: "Next >" }));

    expect(await screen.findByText("Balance Account")).toBeInTheDocument();
    // Grouped view, and the C column became clickable. (The fixture's only
    // deposit is already reconciled, so its group states that inline.)
    expect(screen.getByText(/^Deposits/)).toBeInTheDocument();
    expect(screen.getByText("Checks (No transactions this period)")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Clear / }).length).toBeGreaterThan(0);
  });

  it("clearing is a strip above the register, not a dialog over it, so rows stay clickable (§69)", async () => {
    handlers();
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "Balance this account" }));
    await userEvent.type(screen.getByLabelText("Ending balance:"), "1457.50");
    await userEvent.click(screen.getByRole("button", { name: "Next >" }));
    const bar = await screen.findByRole("region", { name: /^Balance / });
    expect(bar).toHaveTextContent("Balance Account");
    expect(within(bar).getByLabelText("Difference")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.querySelector(".tm-dialog-backdrop")).toBeNull();
    // A row can be selected and opened for editing while balancing; its C cell still toggles.
    const grocery = screen.getAllByRole("row").find((r) => r.textContent?.includes("Grocery Store"))!;
    await userEvent.click(grocery);
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await userEvent.click(screen.getByRole("button", { name: "Clear this transaction" }));
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "set_cleared")).toBe(true));
    expect(screen.getByRole("region", { name: /^Balance / })).toBeInTheDocument();
  });

  it("writes each cleared mark immediately, so Postpone keeps them", async () => {
    handlers();
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "Balance this account" }));
    await userEvent.type(screen.getByLabelText("Ending balance:"), "1457.50");
    await userEvent.click(screen.getByRole("button", { name: "Next >" }));
    await screen.findByText("Balance Account");

    await userEvent.click(screen.getAllByRole("button", { name: /^Clear / })[0]);
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "set_cleared")).toBe(true));
    const call = invokeCalls.find((c) => c.cmd === "set_cleared")!;
    expect(call.args).toMatchObject({ clearedState: "C" });
  });

  it("offers the doesn't-balance choices when the difference is not zero", async () => {
    handlers();
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "Balance this account" }));
    await userEvent.type(screen.getByLabelText("Ending balance:"), "999.99");
    await userEvent.click(screen.getByRole("button", { name: "Next >" }));
    await screen.findByText("Balance Account");
    await userEvent.click(screen.getByRole("button", { name: "Next >" }));

    expect(
      await screen.findByText("Your account doesn't balance with your statement.")
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Use AutoReconcile to help find the error.")).toBeChecked();
    // Money disables Cancel here — you must pick one of the three.
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(invokeCalls.some((c) => c.cmd === "finish_statement")).toBe(false);
  });

  it("the adjustment category is disabled until that option is chosen", async () => {
    handlers();
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "Balance this account" }));
    await userEvent.type(screen.getByLabelText("Ending balance:"), "999.99");
    await userEvent.click(screen.getByRole("button", { name: "Next >" }));
    await screen.findByText("Balance Account");
    await userEvent.click(screen.getByRole("button", { name: "Next >" }));

    expect(screen.getByLabelText("Adjustment category")).toBeDisabled();
    await userEvent.click(screen.getByLabelText("Automatically adjust the account balance."));
    expect(screen.getByLabelText("Adjustment category")).toBeEnabled();
  });

  it("finishes straight to Balanced! when the difference is already zero", async () => {
    // Statement matches the register exactly: starting 1500.00, nothing cleared,
    // ending 1500.00.
    handlers({
      start_statement: () => ({
        ...statement,
        starting_balance_cents: 150000,
        ending_balance_cents: 150000,
      }),
    });
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "Balance this account" }));
    await userEvent.type(screen.getByLabelText("Ending balance:"), "1500.00");
    await userEvent.click(screen.getByRole("button", { name: "Next >" }));
    await screen.findByText("Balance Account");
    await userEvent.click(screen.getByRole("button", { name: "Next >" }));

    expect(await screen.findByText("Balanced!")).toBeInTheDocument();
    expect(screen.getByLabelText("Don't show me this again")).toBeInTheDocument();
    expect(invokeCalls.some((c) => c.cmd === "finish_statement")).toBe(true);
  });

  it("Finish returns to the ordinary register view", async () => {
    handlers({
      start_statement: () => ({ ...statement, ending_balance_cents: 150000 }),
    });
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "Balance this account" }));
    await userEvent.type(screen.getByLabelText("Ending balance:"), "1500.00");
    await userEvent.click(screen.getByRole("button", { name: "Next >" }));
    await screen.findByText("Balance Account");
    await userEvent.click(screen.getByRole("button", { name: "Next >" }));
    await screen.findByText("Balanced!");
    await userEvent.click(screen.getByRole("button", { name: "Finish" }));

    expect(screen.queryByText("Balanced!")).not.toBeInTheDocument();
    expect(screen.queryByText("Deposits")).not.toBeInTheDocument();
  });
});

describe("everyday cleared marks (Ctrl+M / right-click)", () => {
  // Clearing is NOT reconcile-only. You mark transactions as they clear the
  // bank; reconcile later just renders those marks as checkmarks.
  beforeEach(() => {
    setIpcHandlers({
      get_register: () => rows,
      list_categories: () => [],
      list_payees: () => [],
      list_splits: () => [],
      get_all_accounts: () => [checking],
      get_last_statement: () => null,
      set_cleared: () => null,
    });
    useAccountStore.setState({ accounts: [checking], selectedAccountId: "acc-1" });
  });

  // §69 — clearing while a row is open, and from the toolbar.
  it("an open row's C cell toggles its cleared mark", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(dataRows()[1]);
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Payee")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear this transaction" }));
    await waitFor(() =>
      expect(invokeCalls).toContainEqual({ cmd: "set_cleared", args: { transactionId: "t-2", clearedState: "C" } })
    );
    // The form is still open — clearing did not close it.
    expect(screen.getByLabelText("Payee")).toBeInTheDocument();
  });

  it("the toolbar's Mark cleared button works on the selected row", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(dataRows()[1]);
    await userEvent.click(screen.getByRole("button", { name: "Mark cleared" }));
    await waitFor(() =>
      expect(invokeCalls).toContainEqual({ cmd: "set_cleared", args: { transactionId: "t-2", clearedState: "C" } })
    );
  });

  // §70 — reconciling by hand: one row from the menu, or everything through a date.
  it("right-click offers Mark as reconciled on a row that is not R", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    fireEvent.contextMenu(dataRows()[1]);
    await userEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Mark as reconciled" }));
    await waitFor(() =>
      expect(invokeCalls).toContainEqual({ cmd: "set_cleared", args: { transactionId: "t-2", clearedState: "R" } })
    );
  });

  it("Mark reconciled through… counts first, then marks, and says how many", async () => {
    setIpcHandlers({
      get_register: () => rows,
      list_categories: () => [],
      list_payees: () => [],
      list_splits: () => [],
      get_all_accounts: () => [checking],
      get_last_statement: () => null,
      reconcile_through: (args) => ((args as { dryRun: boolean }).dryRun ? 7 : 7),
    });
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "Mark reconciled through…" }));
    const dialog = screen.getByRole("dialog", { name: "Mark reconciled through a date" });
    // Defaults to the last statement date, else the newest R row's date (the fixture's deposit), else the newest row.
    expect((within(dialog).getByLabelText("Reconcile through") as HTMLInputElement).value).toBe("2026-08-01");
    await userEvent.clear(within(dialog).getByLabelText("Reconcile through"));
    await userEvent.type(within(dialog).getByLabelText("Reconcile through"), "2026-08-30");
    await userEvent.click(within(dialog).getByRole("button", { name: "Count" }));
    await waitFor(() => expect(within(dialog).getByLabelText("Rows to mark")).toHaveTextContent("7 transactions would be marked"));
    expect(invokeCalls.filter((c) => c.cmd === "reconcile_through").pop()!.args).toEqual({ accountId: "acc-1", through: "2026-08-30", dryRun: true });
    await userEvent.click(within(dialog).getByRole("button", { name: "Mark reconciled" }));
    await waitFor(() => expect(invokeCalls).toContainEqual({ cmd: "reconcile_through", args: { accountId: "acc-1", through: "2026-08-30", dryRun: false } }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("7 transactions marked reconciled through 8/30/2026."));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("right-click offers Mark as cleared on an unmarked row", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    fireEvent.contextMenu(dataRows()[1]); // the uncleared Grocery Store row
    const menu = screen.getByRole("menu");
    await userEvent.click(
      within(menu).getByRole("menuitem", { name: "Mark as cleared (Ctrl+M)" })
    );
    await waitFor(() =>
      expect(invokeCalls).toContainEqual({
        cmd: "set_cleared",
        args: { transactionId: "t-2", clearedState: "C" },
      })
    );
  });

  it("right-click offers Mark as uncleared on a cleared row", async () => {
    setIpcHandlers({
      get_register: () => [{ ...withdrawal, cleared_state: "C" }],
      list_categories: () => [],
      list_payees: () => [],
      list_splits: () => [],
      get_all_accounts: () => [checking],
      get_last_statement: () => null,
      set_cleared: () => null,
    });
    render(<AccountRegister />);
    await screen.findByRole("table");
    fireEvent.contextMenu(dataRows()[0]);
    await userEvent.click(
      within(screen.getByRole("menu")).getByRole("menuitem", { name: "Mark as uncleared" })
    );
    await waitFor(() =>
      expect(invokeCalls).toContainEqual({
        cmd: "set_cleared",
        args: { transactionId: "t-2", clearedState: "" },
      })
    );
  });

  it("allows unreconciling an R row — rare, but corrections happen", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    fireEvent.contextMenu(dataRows()[0]); // the "R" opening deposit
    const item = within(screen.getByRole("menu")).getByRole("menuitem", {
      name: "Unreconcile (was balanced on a statement)",
    });
    expect(item).toBeEnabled();
    await userEvent.click(item);
    await waitFor(() =>
      expect(invokeCalls).toContainEqual({
        cmd: "set_cleared",
        args: { transactionId: "t-1", clearedState: "" },
      })
    );
  });

  // §102 — Ctrl+M is bound from the menu table now (Edit → Mark as cleared),
  // not by a private listener on the grid, so what the register owes is the
  // COMMAND. The key itself is checked where it is bound, in App.nav.
  it("Mark as cleared unreconciles an R row too, so it stays consistent", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(dataRows()[0]);
    runCommand("edit.clear");
    await waitFor(() =>
      expect(invokeCalls).toContainEqual({
        cmd: "set_cleared",
        args: { transactionId: "t-1", clearedState: "" },
      })
    );
  });

  it("Mark as cleared toggles the selected row without entering reconcile", async () => {
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(dataRows()[1]);
    runCommand("edit.clear");
    await waitFor(() =>
      expect(invokeCalls).toContainEqual({
        cmd: "set_cleared",
        args: { transactionId: "t-2", clearedState: "C" },
      })
    );
    // Never touched a statement.
    expect(invokeCalls.some((c) => c.cmd === "start_statement")).toBe(false);
  });
});

describe("Postpone is Cancel", () => {
  const statement = {
    id: "st-1",
    account_id: "acc-1",
    statement_date: "2026-09-09",
    starting_balance_cents: 150000,
    ending_balance_cents: 145750,
    status: "in_progress" as const,
    reconciled_on: null,
    service_charge_cents: null,
    service_charge_category_id: null,
    interest_cents: null,
    interest_category_id: null,
    adjustment_cents: null,
    adjustment_category_id: null,
  };

  it("discards the statement and leaves reconcile, keeping the marks", async () => {
    setIpcHandlers({
      get_register: () => rows,
      list_categories: () => [],
      list_payees: () => [],
      list_splits: () => [],
      get_all_accounts: () => [checking],
      get_open_statement: () => null,
      get_last_statement: () => null,
      start_statement: () => statement,
      discard_statement: () => null,
      set_cleared: () => null,
    });
    useAccountStore.setState({ accounts: [checking], selectedAccountId: "acc-1" });
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "Balance this account" }));
    await userEvent.type(screen.getByLabelText("Ending balance:"), "1457.50");
    await userEvent.click(screen.getByRole("button", { name: "Next >" }));
    await screen.findByText("Balance Account");

    await userEvent.click(screen.getByRole("button", { name: "Postpone" }));

    await waitFor(() =>
      expect(invokeCalls).toContainEqual({
        cmd: "discard_statement",
        args: { statementId: "st-1" },
      })
    );
    expect(screen.queryByText("Balance Account")).not.toBeInTheDocument();
    // Back to the ordinary register — no grouping.
    expect(screen.queryByText("Deposits")).not.toBeInTheDocument();
    // Cleared marks were never unset.
    expect(invokeCalls.some((c) => c.cmd === "set_cleared")).toBe(false);
  });

  it("surfaces a failure to start reconcile instead of hanging", async () => {
    setIpcHandlers({
      get_register: () => rows,
      list_categories: () => [],
      list_payees: () => [],
      list_splits: () => [],
      get_all_accounts: () => [checking],
      get_last_statement: () => null,
      get_open_statement: () => {
        throw new Error("no such command: get_open_statement");
      },
    });
    useAccountStore.setState({ accounts: [checking], selectedAccountId: "acc-1" });
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "Balance this account" }));
    expect(await screen.findByText(/Reconcile: /)).toBeInTheDocument();
  });
});

describe("a reconciled transaction can still be removed", () => {
  // The motivating case is fraud: a charge that was reconciled and later
  // reversed by the bank did not happen. If the register cannot be made to say
  // so, it is lying about the account. Deleting an "R" row is therefore
  // allowed, exactly like unreconciling one.
  it("deletes an R row without complaint", async () => {
    setIpcHandlers({
      get_register: () => rows,
      list_categories: () => [],
      list_payees: () => [],
      list_splits: () => [],
      get_all_accounts: () => [checking],
      get_last_statement: () => null,
      delete_transaction: () => null,
    });
    useAccountStore.setState({ accounts: [checking], selectedAccountId: "acc-1" });
    render(<AccountRegister />);
    await screen.findByRole("table");

    await userEvent.click(dataRows()[0]); // the reconciled opening deposit
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(invokeCalls).toContainEqual({
        cmd: "delete_transaction",
        args: { id: "t-1" },
      })
    );
  });
});

describe("voiding a transaction (§6.1h)", () => {
  // Money's void: the row stays with its date, payee and original amount, but
  // stops counting. The fraud case — a reversed charge did not happen, but you
  // want the evidence it was there.
  const voided: RegisterRow = {
    ...withdrawal,
    id: "t-9",
    payee: "Fraudulent Charge",
    is_void: true,
    cleared_state: "",
  };

  function handlers(rowsIn: RegisterRow[]) {
    setIpcHandlers({
      get_register: () => rowsIn,
      list_categories: () => [],
      list_payees: () => [],
      list_splits: () => [],
      get_all_accounts: () => [checking],
      get_last_statement: () => null,
      set_void: () => null,
      set_cleared: () => null,
    });
    useAccountStore.setState({ accounts: [checking], selectedAccountId: "acc-1" });
  }

  it("offers Void on a normal row", async () => {
    handlers(rows);
    render(<AccountRegister />);
    await screen.findByRole("table");
    fireEvent.contextMenu(dataRows()[1]);
    await userEvent.click(
      within(screen.getByRole("menu")).getByRole("menuitem", { name: "Void transaction" })
    );
    await waitFor(() =>
      expect(invokeCalls).toContainEqual({ cmd: "set_void", args: { id: "t-2", isVoid: true } })
    );
  });

  it("clears any cleared mark when voiding — a void is on no statement", async () => {
    handlers([{ ...withdrawal, cleared_state: "C" }]);
    render(<AccountRegister />);
    await screen.findByRole("table");
    fireEvent.contextMenu(dataRows()[0]);
    await userEvent.click(
      within(screen.getByRole("menu")).getByRole("menuitem", { name: "Void transaction" })
    );
    await waitFor(() =>
      expect(invokeCalls).toContainEqual({
        cmd: "set_cleared",
        args: { transactionId: "t-2", clearedState: "" },
      })
    );
  });

  it("offers Un-void on a voided row, and nothing about clearing", async () => {
    handlers([voided]);
    render(<AccountRegister />);
    await screen.findByRole("table");
    fireEvent.contextMenu(dataRows()[0]);
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Un-void transaction" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: /Mark as cleared/ })).not.toBeInTheDocument();
  });

  it("keeps the amount visible and tags the row VOID", async () => {
    handlers([voided]);
    render(<AccountRegister />);
    await screen.findByRole("table");
    const cells = within(dataRows()[0]).getAllByRole("cell");
    expect(cells[4]).toHaveTextContent("Fraudulent Charge");
    expect(cells[4]).toHaveTextContent("VOID");
    // The original amount is still on screen — that is the point of voiding.
    expect(cells[6]).toHaveTextContent("42.50");
    expect(dataRows()[0]).toHaveClass("voided");
  });

  it("will not let a voided row be cleared with Ctrl+M", async () => {
    handlers([voided]);
    render(<AccountRegister />);
    await screen.findByRole("table");
    await userEvent.click(dataRows()[0]);
    await userEvent.keyboard("{Control>}m{/Control}");
    expect(invokeCalls.some((c) => c.cmd === "set_cleared")).toBe(false);
  });
});

describe("nextCheckNumber (§61)", () => {
  it("is one past the highest numeric Num, whatever came between", () => {
    expect(nextCheckNumber([])).toBeNull();
    expect(nextCheckNumber([{ check_number: "ATM" }, { check_number: null }])).toBeNull();
    expect(nextCheckNumber([{ check_number: "1041" }, { check_number: "EFT" }, { check_number: " 1039 " }, { check_number: null }])).toBe("1042");
  });
});

// §118 — a house or a car reads as a value, not as a checking account.
describe("a valued asset's register says what it is for (§93/§118)", () => {
  const home: Account = {
    ...checking,
    id: "acc-home",
    name: "27 Birch Lane",
    type: "home",
    balance_cents: 35000000,
  };
  const valuation: RegisterRow = {
    ...deposit,
    id: "t-val",
    date: "2026-06-15",
    payee: "Increase in value",
    amount_cents: 2500000,
    running_balance_cents: 35000000,
    notes: "Zillow",
    is_revaluation: true,
  };

  beforeEach(() => {
    setIpcHandlers({
      get_register: () => [valuation],
      list_categories: () => [],
      list_payees: () => [],
      list_splits: () => [],
      get_all_accounts: () => [home],
      list_common_transactions: () => [],
      list_classifications: () => [],
    });
    useAccountStore.setState({ accounts: [home], selectedAccountId: "acc-home" });
  });

  it("states what it is worth, when it was valued, and how to change it", async () => {
    render(<AccountRegister />);
    const banner = await screen.findByRole("region", { name: "Value of this asset" });
    expect(within(banner).getByText(/is worth \$350,000\.00/)).toBeInTheDocument();
    expect(within(banner).getByText(/valued on 6\/15\/2026/)).toBeInTheDocument();
    // The point a user could not find: this is not a transaction you type.
    expect(within(banner).getByText(/what the thing is/)).toBeInTheDocument();
    expect(within(banner).getByRole("button", { name: "Update value…" })).toBeInTheDocument();
  });

  it("the banner's button opens the same Update value dialog as the footer", async () => {
    render(<AccountRegister />);
    const banner = await screen.findByRole("region", { name: "Value of this asset" });
    await userEvent.click(within(banner).getByRole("button", { name: "Update value…" }));
    expect(await screen.findByRole("dialog", { name: "Update value" })).toBeInTheDocument();
  });

  it("an ordinary account gets no banner — nothing there is appraised", async () => {
    setIpcHandlers({ get_register: () => rows, list_categories: () => [], get_all_accounts: () => [checking] });
    useAccountStore.setState({ accounts: [checking], selectedAccountId: "acc-1" });
    render(<AccountRegister />);
    await screen.findByRole("table");
    expect(screen.queryByRole("region", { name: "Value of this asset" })).not.toBeInTheDocument();
  });
});

// §120 — a mortgage's register does not say "Deposit".
describe("a debt's register columns say Increase and Decrease (§120)", () => {
  const mortgage: Account = {
    ...checking,
    id: "acc-mtg",
    name: "418 Maple Street",
    type: "mortgage",
    balance_cents: -18_500_000,
  };
  const principal: RegisterRow = {
    ...deposit,
    id: "t-p",
    date: "2026-09-01",
    payee: "Summit Home Loans",
    amount_cents: 83_455,
    running_balance_cents: -18_400_000,
    cleared_state: "",
    is_reconciled: false,
    notes: null,
  };

  function mount(account: Account, rows: RegisterRow[]) {
    setIpcHandlers({
      get_register: () => rows,
      list_categories: () => [],
      list_payees: () => [],
      list_splits: () => [],
      get_all_accounts: () => [account],
      list_common_transactions: () => [],
      list_classifications: () => [],
      get_loan_terms: () => null,
    });
    useAccountStore.setState({ accounts: [account], selectedAccountId: account.id });
    render(<AccountRegister />);
  }

  it("heads the columns Increase and Decrease, so a principal payment is not a deposit", async () => {
    mount(mortgage, [principal]);
    const table = await screen.findByRole("table");
    expect(within(table).getByRole("columnheader", { name: /Increase/ })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: /Decrease/ })).toBeInTheDocument();
    expect(within(table).queryByRole("columnheader", { name: /Deposit/ })).not.toBeInTheDocument();
  });

  it("the entry boxes agree with the headings", async () => {
    mount(mortgage, [principal]);
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    expect(await screen.findByLabelText("Decrease")).toBeInTheDocument();
    expect(screen.getByLabelText("Increase")).toBeInTheDocument();
    expect(screen.queryByLabelText("Deposit")).not.toBeInTheDocument();
  });

  it("a checking account still says Payment and Deposit — this changed nothing else", async () => {
    mount(checking, rows);
    const table = await screen.findByRole("table");
    expect(within(table).getByRole("columnheader", { name: /Payment/ })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: /Deposit/ })).toBeInTheDocument();
    expect(within(table).queryByRole("columnheader", { name: /Increase/ })).not.toBeInTheDocument();
  });

  it("nor does a credit card change — Money calls those Charge and Payment, a separate fix", async () => {
    mount({ ...checking, id: "acc-visa", name: "Visa", type: "credit" }, rows);
    const table = await screen.findByRole("table");
    expect(within(table).getByRole("columnheader", { name: /Deposit/ })).toBeInTheDocument();
    expect(within(table).queryByRole("columnheader", { name: /Increase/ })).not.toBeInTheDocument();
  });
});

describe("§154 — the register survives losing its account", () => {
  // `reloadAll` — what every importer calls when it finishes — clears the
  // selection before it fetches. The "select an account" return used to sit
  // ABOVE the menu-bar hooks and the arrow-key effect, so a register that was
  // on screen when a TSP import finished rendered with fewer hooks than the
  // render before it: React #300, "Something on this screen failed to draw".
  it("falls back to the prompt when the selection is cleared under it, rather than crashing", async () => {
    setIpcHandlers({ get_register: () => rows, list_categories: () => [] });
    useAccountStore.setState({ accounts: [checking], selectedAccountId: "acc-1" });
    render(<AccountRegister />);
    await screen.findByRole("table");

    act(() => {
      useAccountStore.setState({ selectedAccountId: null, register: [], transactions: [] });
    });
    expect(screen.getByText("Select an account to view its register.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

// §181 — what the walk of §178 found: refusals looked like info, the far row's
// form stayed open with nothing said, and a closed account was still offered.
describe("§181 — refusals read as refusals, and closed accounts stay out", () => {
  const far: RegisterRow = {
    ...deposit,
    id: "t-far",
    date: "2026-03-01",
    payee: "Summit Home Loans",
    amount_cents: 80_000,
    is_reconciled: false,
    cleared_state: "",
    notes: null,
    is_split_transfer: true,
    split_payment_account_name: "Demo Checking",
  };
  const refusal =
    "this row belongs to a split in Demo Checking (Summit Home Loans, 03/01/2026) — edit the payment to change its amount, date or category";

  function mount(rowsIn: RegisterRow[], over: Record<string, () => unknown> = {}, accounts: Account[] = [checking]) {
    setIpcHandlers({
      get_register: () => rowsIn,
      list_categories: () => [],
      list_payees: () => [],
      list_splits: () => [],
      get_all_accounts: () => accounts,
      get_last_statement: () => null,
      ...over,
    });
    useAccountStore.setState({ accounts, selectedAccountId: "acc-1" });
    render(<AccountRegister />);
  }

  it("G2 — a refused void is a red alert, not the cream info strip", async () => {
    mount([far], {
      set_void: () => {
        throw refusal;
      },
    });
    await screen.findByRole("table");
    fireEvent.contextMenu(dataRows()[0]);
    await userEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Void transaction" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("this row belongs to a split in Demo Checking");
    expect(alert).toHaveClass("tm-notice", "tm-notice-error");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("G3 — a far row's form says where its amount lives, and does not offer it", async () => {
    mount([far]);
    await screen.findByRole("table");
    await userEvent.dblClick(dataRows()[0]);
    const note = await screen.findByRole("status");
    expect(note).toHaveTextContent("The amount, date and category belong to the payment in Demo Checking");
    expect(note).not.toHaveClass("tm-notice-error");
    expect(screen.getByLabelText("Deposit")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("Payment")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("Date")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("Category:")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Split" })).toBeDisabled();
    // What the backend allows stays editable.
    expect(screen.getByLabelText(/^Memo/)).not.toHaveAttribute("readonly");
    expect(screen.getByLabelText("Num")).not.toHaveAttribute("readonly");
  });

  it("G3 — a refused save shows in red on the form, keeps what was typed, and Esc still leaves", async () => {
    mount([far], {
      update_transaction: () => {
        throw refusal;
      },
    });
    await screen.findByRole("table");
    await userEvent.dblClick(dataRows()[0]);
    const memo = await screen.findByLabelText(/^Memo/);
    await userEvent.type(memo, "principal");
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("edit the payment to change its amount, date or category");
    expect(alert).toHaveClass("tm-notice-error");
    // Still open, still holding the memo.
    expect(screen.getByLabelText(/^Memo/)).toHaveValue("principal");
    expect(screen.getByRole("button", { name: "Enter" })).toBeInTheDocument();

    fireEvent.keyDown(screen.getByLabelText(/^Memo/), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Enter" })).not.toBeInTheDocument());
  });

  it("B2 — AutoReconcile's hint is a warning", async () => {
    mount(rows, {
      get_open_statement: () => null,
      start_statement: () => ({
        id: "st-1",
        account_id: "acc-1",
        statement_date: "2026-09-09",
        starting_balance_cents: 150000,
        ending_balance_cents: 99999,
        status: "in_progress",
        reconciled_on: null,
        service_charge_cents: null,
        service_charge_category_id: null,
        interest_cents: null,
        interest_category_id: null,
        adjustment_cents: null,
        adjustment_category_id: null,
      }),
      set_cleared: () => null,
    });
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "Balance this account" }));
    await userEvent.type(screen.getByLabelText("Ending balance:"), "999.99");
    await userEvent.click(screen.getByRole("button", { name: "Next >" }));
    await screen.findByText("Balance Account");
    await userEvent.click(screen.getByRole("button", { name: "Next >" }));
    await screen.findByText("Your account doesn't balance with your statement.");
    await userEvent.click(screen.getByRole("button", { name: "Next >" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveClass("tm-notice-error");
    expect(alert.textContent).toMatch(/\S/);
  });

  describe("N9 — a closed account is not a transfer target for new work", () => {
    const savings: Account = { ...checking, id: "acc-2", name: "Everyday Savings 5678", balance_cents: 0 };
    const old: Account = { ...checking, id: "acc-3", name: "Demo Old Checking", balance_cents: 0, is_closed: true };

    it("a new entry's Category field offers the open account and not the closed one", async () => {
      mount(rows, {}, [checking, savings, old]);
      await screen.findByRole("table");
      await userEvent.click(screen.getByRole("button", { name: "New" }));
      const list = await openCategoryList();
      expect(within(list).getByRole("option", { name: "Transfer : Everyday Savings 5678" })).toBeInTheDocument();
      expect(within(list).queryByRole("option", { name: "Transfer : Demo Old Checking" })).not.toBeInTheDocument();
    });

    it("a transfer written before the close still opens with its account, and offers it", async () => {
      const toOld: RegisterRow = {
        ...withdrawal,
        id: "t-old",
        payee: "Transfer Money",
        category_id: null,
        transfer_account_id: "acc-3",
        transfer_account_name: "Demo Old Checking",
      };
      mount([toOld], {}, [checking, savings, old]);
      await screen.findByRole("table");
      await userEvent.dblClick(dataRows()[0]);
      expect((screen.getByLabelText("Category:") as HTMLInputElement).value).toBe("Transfer : Demo Old Checking");
      const list = await openCategoryList();
      expect(within(list).getByRole("option", { name: "Transfer : Demo Old Checking" })).toBeInTheDocument();
    });
  });
});

describe("§183 — the register's review fixes", () => {
  const savings: Account = { ...checking, id: "acc-2", name: "Everyday Savings 5678", balance_cents: 0 };
  const statement = {
    id: "st-1",
    account_id: "acc-1",
    statement_date: "2026-09-09",
    starting_balance_cents: 150000,
    ending_balance_cents: 145750,
    status: "in_progress" as const,
    reconciled_on: null,
    service_charge_cents: null,
    service_charge_category_id: null,
    interest_cents: null,
    interest_category_id: null,
    adjustment_cents: null,
    adjustment_category_id: null,
  };
  const cats: Category[] = [
    { id: "c-1", name: "Groceries", parent_id: null, kind: "expense", tax_line: null, full_name: "Groceries", usage_count: 3 },
    { id: "c-2", name: "Hardware", parent_id: null, kind: "expense", tax_line: null, full_name: "Hardware", usage_count: 1 },
  ];

  function mount(over: Record<string, (args: Record<string, unknown>) => unknown> = {}, rowsIn: RegisterRow[] = rows) {
    setIpcHandlers({
      get_register: () => rowsIn,
      list_categories: () => cats,
      list_payees: () => [],
      list_splits: () => [],
      get_all_accounts: () => [checking, savings],
      list_common_transactions: () => [],
      get_open_statement: () => null,
      get_last_statement: () => null,
      start_statement: () => statement,
      set_cleared: () => null,
      discard_statement: () => null,
      finish_statement: () => ({ ...statement, status: "completed", reconciled_on: "2026-09-09" }),
      ...over,
    });
    useAccountStore.setState({ accounts: [checking, savings], selectedAccountId: "acc-1" });
    render(<AccountRegister />);
  }

  /** What the rail does: the store swaps the account and empties the rows in
   *  one step; the register is not remounted. */
  function switchTo(id: string) {
    act(() => {
      useAccountStore.setState({ selectedAccountId: id, register: [] });
    });
  }

  async function toClearing(ending = "1457.50") {
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "Balance this account" }));
    await userEvent.type(screen.getByLabelText("Ending balance:"), ending);
    await userEvent.click(screen.getByRole("button", { name: "Next >" }));
    await screen.findByRole("region", { name: /^Balance / });
  }

  it("item 1 — switching accounts mid-reconcile postpones it; nothing carries over to the other account", async () => {
    mount();
    await toClearing();
    switchTo("acc-2");
    await waitFor(() => expect(invokeCalls).toContainEqual({ cmd: "discard_statement", args: { statementId: "st-1" } }));
    expect(screen.queryByRole("region", { name: /^Balance / })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Clear / })).not.toBeInTheDocument();
    expect(screen.queryByText(/^Deposits/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Balance this account" })).toBeEnabled();
    expect(invokeCalls.some((c) => c.cmd === "finish_statement")).toBe(false);
  });

  it("item 1 — a transaction half-typed when the account changes is saved to the account it was typed in", async () => {
    mount({ create_transaction: () => ({ id: "t-9" }) });
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    await userEvent.type(screen.getByLabelText("Payee"), "Hardware Store");
    await userEvent.type(screen.getByLabelText("Payment"), "12.00");
    switchTo("acc-2");
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "create_transaction")).toBe(true));
    const payload = (invokeCalls.find((c) => c.cmd === "create_transaction")!.args as { payload: Record<string, unknown> }).payload;
    expect(payload).toMatchObject({ account_id: "acc-1", payee: "Hardware Store", amount_cents: -1200 });
    await waitFor(() => expect(screen.queryByLabelText("Payee")).not.toBeInTheDocument());
  });

  it("item 1 — one that cannot be saved says so rather than vanishing", async () => {
    mount();
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    await userEvent.type(screen.getByLabelText("Payee"), "Hardware Store"); // no amount
    switchTo("acc-2");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The transaction you were entering in Everyday Checking 1234 could not be saved");
    expect(invokeCalls.some((c) => c.cmd === "create_transaction")).toBe(false);
  });

  it("item 2 — going straight from one split row to another opens the second with its OWN lines", async () => {
    const other: RegisterRow = { ...withdrawal, id: "t-3", date: "2026-08-31", payee: "Hardware Store", category_id: null, category_name: null, amount_cents: -1000, running_balance_cents: 144750 };
    const line = (id: string, txn: string, category_id: string, amount_cents: number) => ({ id, transaction_id: txn, category_id, description: null, amount_cents, sort_order: 0 });
    // B's lines are held back until the test lets them go, so B's form is
    // asked to open while A's lines are still what the register last loaded.
    let releaseB: () => void = () => {};
    mount(
      {
        list_splits: (args) =>
          args.transactionId === "t-2"
            ? [line("s-a", "t-2", "c-1", -4250)]
            : new Promise((res) => {
                releaseB = () => res([line("s-b", "t-3", "c-2", -1000)]);
              }),
        update_transaction: () => ({ id: "t-3" }),
      },
      [deposit, withdrawal, other]
    );
    await screen.findByRole("table");
    await userEvent.dblClick(dataRows()[1]);
    await screen.findByRole("button", { name: /^Split \(1 categories\)/ });
    // The row menu's Edit goes from A to B without closing A first.
    fireEvent.contextMenu(document.querySelector('tr[data-row-id="t-3"]')!);
    await userEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Edit transaction" }));
    await waitFor(() => expect(invokeCalls.filter((c) => c.cmd === "list_splits").length).toBe(2));
    // Nothing is offered to type into until B's lines are here.
    expect(screen.queryByLabelText("Payee")).not.toBeInTheDocument();
    await act(async () => releaseB());
    const payee = await screen.findByLabelText("Payee");
    expect(payee).toHaveValue("Hardware Store");
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "update_transaction")).toBe(true));
    expect(invokeCalls.find((c) => c.cmd === "update_transaction")!.args).toMatchObject({
      payload: expect.objectContaining({ id: "t-3", splits: [expect.objectContaining({ category_id: "c-2", amount_cents: -1000 })] }),
    });
  });

  it("item 3 — Enter twice while the first save is on its way writes one row", async () => {
    let finish: () => void = () => {};
    mount({
      create_transaction: () =>
        new Promise((res) => {
          finish = () => res({ id: "t-9" });
        }),
    });
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "New" }));
    await userEvent.type(screen.getByLabelText("Payee"), "Hardware Store");
    await userEvent.type(screen.getByLabelText("Payment"), "12.00");
    const box = screen.getByLabelText("Payment");
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(invokeCalls.filter((c) => c.cmd === "create_transaction").length).toBe(1));
    await act(async () => finish());
    expect(invokeCalls.filter((c) => c.cmd === "create_transaction").length).toBe(1);
  });

  it("item 5 — a refused statement is shown inside the wizard, not behind it", async () => {
    mount({
      start_statement: () => {
        throw "a statement is already open for this account";
      },
    });
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "Balance this account" }));
    await userEvent.type(screen.getByLabelText("Ending balance:"), "1457.50");
    await userEvent.click(screen.getByRole("button", { name: "Next >" }));
    const dialog = screen.getByRole("dialog", { name: /^Balance / });
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("a statement is already open for this account");
    expect(alert).toHaveClass("tm-notice-error");
    // Only the one, in the dialog.
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("item 6 — a service charge or interest that is not an amount is refused, not dropped", async () => {
    mount();
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "Balance this account" }));
    await userEvent.type(screen.getByLabelText("Ending balance:"), "1457.50");
    const charge = screen.getByLabelText("Service charge:");
    const interest = screen.getByLabelText("Interest earned:");
    await userEvent.type(charge, "12.OO");
    await userEvent.click(screen.getByRole("button", { name: "Next >" }));
    expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent('"12.OO" is not an amount');
    await userEvent.clear(charge);
    await userEvent.type(interest, "abc");
    await userEvent.click(screen.getByRole("button", { name: "Next >" }));
    expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent('"abc" is not an amount');
    expect(invokeCalls.some((c) => c.cmd === "start_statement")).toBe(false);
  });

  it("item 5 — Mark reconciled through… shows its refusal in its own dialog", async () => {
    mount({
      reconcile_through: () => {
        throw "that date is in the future";
      },
    });
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "Mark reconciled through…" }));
    const dialog = screen.getByRole("dialog", { name: "Mark reconciled through a date" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Mark reconciled" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("that date is in the future");
    await userEvent.click(within(dialog).getByRole("button", { name: "Count" }));
    await waitFor(() => expect(invokeCalls.filter((c) => c.cmd === "reconcile_through").length).toBe(2));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("that date is in the future");
  });

  it("item 8 — the QIF export message counts the voided rows left out, not prices", async () => {
    dialog.save.mockResolvedValueOnce("C:\\Users\\me\\checking.qif");
    mount({ export_qif: () => [41, 3] });
    await screen.findByRole("table");
    act(() => runCommand("export.register.qif"));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Saved 41 transactions to C:\\Users\\me\\checking.qif. 3 voided transactions were left out."
    );
    expect(screen.getByRole("status")).not.toHaveTextContent("prices");
  });

  it("item 9 — a refused cleared mark, a refused Mark as reconciled and a refused favorite all say so", async () => {
    mount({
      set_cleared: () => {
        throw "this row is on a statement being balanced elsewhere";
      },
      set_favorite: () => {
        throw "database is locked";
      },
    });
    await screen.findByRole("table");
    await userEvent.click(dataRows()[1]);
    await userEvent.click(screen.getByRole("button", { name: "Mark cleared" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("this row is on a statement being balanced elsewhere");

    await userEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Dismiss" }));
    fireEvent.contextMenu(dataRows()[1]);
    await userEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Mark as reconciled" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("this row is on a statement being balanced elsewhere");

    await userEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Dismiss" }));
    act(() => runCommand("fav.add"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not change favorites: database is locked");
  });

  it("item 9 — a refused tax line is shown in the tax-line dialog", async () => {
    mount({
      set_transaction_tax_line: () => {
        throw "no such tax line";
      },
    });
    await screen.findByRole("table");
    fireEvent.contextMenu(dataRows()[1]);
    await userEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Tax line…" }));
    const dlg = screen.getByRole("dialog", { name: "Tax line for this transaction" });
    await userEvent.click(within(dlg).getByLabelText(/Not tax-related/));
    expect(await within(dlg).findByRole("alert")).toHaveTextContent("no such tax line");
  });

  it("item 10 — Next pressed twice finishes the statement once, with no red 'already balanced'", async () => {
    let done: () => void = () => {};
    let calls = 0;
    mount({
      start_statement: () => ({ ...statement, ending_balance_cents: 150000 }),
      finish_statement: () => {
        calls += 1;
        if (calls > 1) throw "this statement is already balanced";
        return new Promise((res) => {
          done = () => res({ ...statement, status: "completed", reconciled_on: "2026-09-09" });
        });
      },
    });
    await toClearing("1500.00");
    const next = within(screen.getByRole("region", { name: /^Balance / })).getByRole("button", { name: "Next >" });
    fireEvent.click(next);
    fireEvent.click(next);
    await act(async () => done());
    expect(await screen.findByText("Balanced!")).toBeInTheDocument();
    expect(calls).toBe(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("item 10 — Edit → Balance account checks for a statement left open, like the button", async () => {
    mount({ get_open_statement: () => statement });
    await screen.findByRole("table");
    act(() => runCommand("edit.reconcile"));
    expect(await screen.findByText(/previously began the process of balancing/)).toBeInTheDocument();
    expect(invokeCalls.some((c) => c.cmd === "get_open_statement")).toBe(true);
  });

  it("item 11 — a later notice does not keep an earlier notice's Remember button", async () => {
    mount({
      update_transaction: () => ({ id: "t-1" }),
      list_payee_rules: () => [],
      set_favorite: () => null,
      get_favorite_accounts: () => [],
    });
    await screen.findByRole("table");
    await userEvent.dblClick(dataRows()[0]); // Opening Deposit: no category
    await pickCategory("Groceries");
    await userEvent.keyboard("{Enter}");
    const strip = await screen.findByRole("status");
    expect(within(strip).getByRole("button", { name: "Remember" })).toBeInTheDocument();
    act(() => runCommand("fav.add"));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Everyday Checking 1234 added to favorites."));
    expect(screen.queryByRole("button", { name: "Remember" })).not.toBeInTheDocument();
  });
});
