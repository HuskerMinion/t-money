// IPC wrappers: command names and argument keys.
//
// This is the seam where a rename on either side goes unnoticed until
// runtime, so the tests assert the exact `invoke(cmd, args)` shape — the
// camelCase keys Tauri maps onto the snake_case Rust params via
// `#[tauri::command(rename_all = "camelCase")]`.
import { beforeEach, describe, expect, it } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

import { api } from "./ipc";
import libRs from "../../src-tauri/src/lib.rs?raw";
import ipcTs from "./ipc.ts?raw";
import { invokeCalls, resetIpc, setIpcHandlers } from "../test/tauriMock";
import type {
  NewRecurrence, NewTransaction } from "./types";

/** Last invoke() the wrapper made. */
function lastCall() {
  return invokeCalls[invokeCalls.length - 1];
}

beforeEach(() => {
  resetIpc();
  // Every command answers with a benign value; these tests care about the
  // request, not the response.
  setIpcHandlers(
    new Proxy({} as Record<string, () => unknown>, {
      get: () => () => null,
      has: () => true,
    })
  );
});

describe("account commands", () => {
  it("getAllAccounts / getFavoriteAccounts take no args", async () => {
    await api.getAllAccounts();
    expect(lastCall()).toEqual({ cmd: "get_all_accounts", args: {} });
    await api.getFavoriteAccounts();
    expect(lastCall()).toEqual({ cmd: "get_favorite_accounts", args: {} });
  });

  it("createAccount sends camelCase accountType/openingBalanceCents", async () => {
    await api.createAccount("Test Checking", "checking", 150000);
    expect(lastCall()).toEqual({
      cmd: "create_account",
      args: {
        name: "Test Checking",
        accountType: "checking",
        openingBalanceCents: 150000,
        openedOn: null,
      },
    });
  });

  it("createAccount carries the opening date when one is given", async () => {
    await api.createAccount("Test Checking", "checking", 150000, "2026-01-15");
    expect(lastCall()).toMatchObject({
      cmd: "create_account",
      args: { openedOn: "2026-01-15" },
    });
  });

  it("setFavorite sends accountId + isFavorite", async () => {
    await api.setFavorite("acc-1", true);
    expect(lastCall()).toEqual({
      cmd: "set_favorite",
      args: { accountId: "acc-1", isFavorite: true },
    });
  });

  it("updateAccount camelCases every detail field", async () => {
    await api.updateAccount({
      id: "acc-1",
      name: "Everyday Checking 1234",
      account_type: "checking",
      is_closed: false,
      institution: "First National",
      account_number: "1234567890",
      routing_number: "123456780",
      opened_on: "2019-04-01",
      credit_limit_cents: null,
      contact_phone: "555-0100",
      contact_email: null,
      website: "https://www.firstnational.example",
      address: "100 Main St, Springfield",
      account_notes: null,
    });
    expect(lastCall()).toEqual({
      cmd: "update_account",
      args: {
        id: "acc-1",
        name: "Everyday Checking 1234",
        accountType: "checking",
        isClosed: false,
        institution: "First National",
        accountNumber: "1234567890",
        routingNumber: "123456780",
        openedOn: "2019-04-01",
        creditLimitCents: null,
        contactPhone: "555-0100",
        contactEmail: null,
        website: "https://www.firstnational.example",
        address: "100 Main St, Springfield",
        accountNotes: null,
      },
    });
  });

  it("deleteAccount sends a bare id", async () => {
    await api.deleteAccount("acc-1");
    expect(lastCall()).toEqual({ cmd: "delete_account", args: { id: "acc-1" } });
  });
});

describe("transaction + register commands", () => {
  it("getTransactions passes accountId and limit", async () => {
    await api.getTransactions("acc-1", 200);
    expect(lastCall()).toEqual({
      cmd: "get_transactions",
      args: { accountId: "acc-1", limit: 200 },
    });
  });

  it("getTransactions leaves limit undefined when omitted", async () => {
    await api.getTransactions("acc-1");
    expect(lastCall().args).toEqual({ accountId: "acc-1", limit: undefined });
  });

  it("createTransaction nests the snake_case payload struct untouched", async () => {
    const payload: NewTransaction = {
      account_id: "acc-1",
      date: "2026-08-30",
      payee: "Grocery Store",
      category_id: null,
      amount_cents: -4250,
      notes: null,
      check_number: null,
    };
    await api.createTransaction(payload);
    // The payload is a serde struct, not a set of command args — it must NOT
    // be camelCased.
    expect(lastCall()).toEqual({ cmd: "create_transaction", args: { payload } });
  });

  it("getRegister sends accountId", async () => {
    await api.getRegister("acc-1");
    expect(lastCall()).toEqual({ cmd: "get_register", args: { accountId: "acc-1" } });
  });
});

describe("category tree commands (migration 0014)", () => {
  it("createCategory defaults parent and tax line to null", async () => {
    await api.createCategory("Groceries", "expense");
    expect(lastCall()).toEqual({
      cmd: "create_category",
      args: { name: "Groceries", kind: "expense", parentId: null, taxLine: null },
    });
  });

  it("createCategory passes a parent and a tax line when given", async () => {
    await api.createCategory("Gasoline", "expense", "cat-auto", "Schedule C: Car");
    expect(lastCall()).toEqual({
      cmd: "create_category",
      args: {
        name: "Gasoline",
        kind: "expense",
        parentId: "cat-auto",
        taxLine: "Schedule C: Car",
      },
    });
  });

  it("updateCategory sends the whole shape", async () => {
    await api.updateCategory("cat-1", "Fuel", "expense", "cat-auto", null);
    expect(lastCall()).toEqual({
      cmd: "update_category",
      args: {
        id: "cat-1",
        name: "Fuel",
        kind: "expense",
        parentId: "cat-auto",
        taxLine: null,
      },
    });
  });

  it("deleteCategory orphans by default and refiles when told to", async () => {
    await api.deleteCategory("cat-1");
    expect(lastCall()).toEqual({
      cmd: "delete_category",
      args: { id: "cat-1", reassignTo: null },
    });
    await api.deleteCategory("cat-1", "cat-2");
    expect(lastCall()).toEqual({
      cmd: "delete_category",
      args: { id: "cat-1", reassignTo: "cat-2" },
    });
  });

  it("seedStandardCategories takes no args", async () => {
    await api.seedStandardCategories();
    expect(lastCall()).toEqual({ cmd: "seed_standard_categories", args: {} });
  });

  it("mergeCategories sends fromId/intoId", async () => {
    await api.mergeCategories("cat-1", "cat-2");
    expect(lastCall()).toEqual({
      cmd: "merge_categories",
      args: { fromId: "cat-1", intoId: "cat-2" },
    });
  });
});

describe("transfer commands", () => {
  it("updateTransfer sends the edited side's signed amount", async () => {
    await api.updateTransfer("t-1", "2026-09-01", "acc-2", -25000, null);
    expect(lastCall()).toEqual({
      cmd: "update_transfer",
      args: {
        id: "t-1",
        date: "2026-09-01",
        otherAccountId: "acc-2",
        amountCents: -25000,
        notes: null,
      },
    });
  });
});

describe("payee commands", () => {
  it("listPayees takes no args", async () => {
    await api.listPayees();
    expect(lastCall()).toEqual({ cmd: "list_payees", args: {} });
  });

  it("updatePayee sends id/name/lastCategoryId", async () => {
    await api.updatePayee("p-1", "Kroger", "cat-1");
    expect(lastCall()).toEqual({
      cmd: "update_payee",
      args: { id: "p-1", name: "Kroger", lastCategoryId: "cat-1" },
    });
  });

  it("updatePayee can clear the default category", async () => {
    await api.updatePayee("p-1", "Kroger", null);
    expect(lastCall().args).toEqual({ id: "p-1", name: "Kroger", lastCategoryId: null });
  });

  it("mergePayees sends fromId/intoId", async () => {
    await api.mergePayees("p-1", "p-2");
    expect(lastCall()).toEqual({ cmd: "merge_payees", args: { fromId: "p-1", intoId: "p-2" } });
  });

  it("deletePayee sends a bare id", async () => {
    await api.deletePayee("p-1");
    expect(lastCall()).toEqual({ cmd: "delete_payee", args: { id: "p-1" } });
  });
});

describe("budget commands", () => {
  // Keyed by category ID since migration 0014 — the old name-keyed call
  // created a junk category from whatever was typed.
  it("setBudget sends categoryId/targetCents/monthYear", async () => {
    await api.setBudget("cat-1", 40000, "2026-08");
    expect(lastCall()).toEqual({
      cmd: "set_budget",
      args: { categoryId: "cat-1", targetCents: 40000, monthYear: "2026-08" },
    });
  });

  // §139 — the year plan. The mask is a STRING and travels as one: sending
  // twelve booleans would be twelve chances to disagree about which end is
  // January.
  it("getYearPlan sends a numeric year", async () => {
    await api.getYearPlan(2027);
    expect(lastCall()).toEqual({ cmd: "get_year_plan", args: { year: 2027 } });
  });

  it("setBudgetPlan sends categoryId/year/annualCents/months/spread", async () => {
    await api.setBudgetPlan("cat-1", 2027, 120000, "111000000011");
    expect(lastCall()).toEqual({
      cmd: "set_budget_plan",
      args: {
        categoryId: "cat-1",
        year: 2027,
        annualCents: 120000,
        months: "111000000011",
        // §143 — omitted by the caller, sent as "spent" rather than left
        // undefined: the two readings of the mask are far enough apart that
        // the wire should always say which one it means.
        spread: "spent",
      },
    });
  });

  // §143 — and the other reading goes over the same call.
  it("setBudgetPlan carries an aside spread when asked for one", async () => {
    await api.setBudgetPlan("cat-1", 2027, 120000, "100000000000", "aside");
    expect(lastCall()).toEqual({
      cmd: "set_budget_plan",
      args: {
        categoryId: "cat-1",
        year: 2027,
        annualCents: 120000,
        months: "100000000000",
        spread: "aside",
      },
    });
  });

  it("clearBudgetPlan sends categoryId/year", async () => {
    await api.clearBudgetPlan("cat-1", 2027);
    expect(lastCall()).toEqual({
      cmd: "clear_budget_plan",
      args: { categoryId: "cat-1", year: 2027 },
    });
  });

  it("planFromHistory sends the year it reads and the year it is for", async () => {
    await api.planFromHistory(2026, 2027);
    expect(lastCall()).toEqual({ cmd: "plan_from_history", args: { fromYear: 2026, toYear: 2027 } });
  });

  it("applyYearPlan sends the accepted lines and nothing else about them", async () => {
    await api.applyYearPlan(2027, [{ category_id: "c-1", annual_cents: 120000, months: "111000000011" }]);
    expect(lastCall()).toEqual({
      cmd: "apply_year_plan",
      args: { year: 2027, lines: [{ category_id: "c-1", annual_cents: 120000, months: "111000000011" }] },
    });
  });

  it("getSpendingSummary sends the single-word month key", async () => {
    await api.getSpendingSummary("2026-08");
    expect(lastCall()).toEqual({ cmd: "get_spending_summary", args: { month: "2026-08" } });
  });
});

describe("module commands", () => {
  it("createGoal sends targetCents/savedCents", async () => {
    await api.createGoal("Emergency fund", 1000000, 250000, "2027-01-01", null);
    expect(lastCall()).toEqual({
      cmd: "create_goal",
      args: {
        name: "Emergency fund",
        targetCents: 1000000,
        savedCents: 250000,
        deadline: "2027-01-01",
        notes: null,
        accountId: null,
      },
    });
  });

  // The payment wrappers were retired by §32: migration 0019 folded one-off
  // payments into recurrence rules, so there is one list of upcoming money.
  it("createRecurrence nests the rule payload untouched", async () => {
    const payload: NewRecurrence = {
      payee: "Anytown Properties",
      amount_cents: -145000,
      account_id: "acc-1",
      category_id: null,
      freq: "monthly",
      interval_n: 1,
      start_date: "2026-09-01",
      end_date: null,
      second_day: null,
      weekend_rule: "before",
      notes: null,
    };
    await api.createRecurrence(payload);
    // A serde struct, not a set of command args — it must NOT be camelCased.
    expect(lastCall()).toEqual({ cmd: "create_recurrence", args: { payload } });
  });

  it("enterOccurrence camelCases its args", async () => {
    await api.enterOccurrence("r-1", "2026-09-01", "2026-09-02", -14500, "acc-1");
    expect(lastCall()).toEqual({
      cmd: "enter_occurrence",
      args: {
        recurrenceId: "r-1",
        dueDate: "2026-09-01",
        date: "2026-09-02",
        amountCents: -14500,
        accountId: "acc-1",
      },
    });
  });

  it("getCashForecast sends the account and the horizon", async () => {
    await api.getCashForecast("acc-1", 90);
    expect(lastCall()).toEqual({
      cmd: "get_cash_forecast",
      args: { accountId: "acc-1", days: 90, includeDetected: true },
    });
  });

  it("createInvestmentTransaction wraps the row under `transaction` and listLots sends asOf", async () => {
    const t = {
      account_id: "a-1",
      date: "2026-03-01",
      activity: "buy" as const,
      security_id: "s-1",
      shares_micro: 12_500_000,
      price_micro: null,
      gross_cents: 45000,
      commission_cents: 0,
      lot_specified: false,
      goal_id: null,
      goal_name: null,
      category_id: null,
      notes: null,
      funding_account_id: "a-chk",
      lot_allocations: [],
    };
    await api.createInvestmentTransaction(t);
    expect(lastCall()).toEqual({ cmd: "create_investment_transaction", args: { transaction: t } });
    await api.listLots("a-1", "s-1", "2026-03-01");
    expect(lastCall()).toEqual({ cmd: "list_lots", args: { accountId: "a-1", securityId: "s-1", asOf: "2026-03-01" } });
    await api.getPortfolio();
    expect(lastCall()).toEqual({ cmd: "get_portfolio", args: { accountId: null, asOf: null } });
  });

  it("importQifOfx sends filePath + accountId", async () => {
    await api.importQifOfx("E:/statements/aug.qif", "acc-1");
    expect(lastCall()).toEqual({
      cmd: "import_qif_ofx",
      args: { filePath: "E:/statements/aug.qif", accountId: "acc-1" },
    });
  });


  it("createTransfer sends both account ids and a magnitude", async () => {
    await api.createTransfer("acc-1", "acc-2", "2026-08-30", 25000, null);
    expect(lastCall()).toEqual({
      cmd: "create_transfer",
      args: {
        fromAccountId: "acc-1",
        toAccountId: "acc-2",
        date: "2026-08-30",
        amountCents: 25000,
        notes: null,
      },
    });
  });

  it("listSplits sends transactionId", async () => {
    await api.listSplits("t-1");
    expect(lastCall()).toEqual({ cmd: "list_splits", args: { transactionId: "t-1" } });
  });

  it("backup/restore send a bare path — restore may also carry a key", async () => {
    await api.backupDatabase("C:\\b.db");
    expect(lastCall()).toEqual({ cmd: "backup_database", args: { path: "C:\\b.db" } });

    // `key` is null unless the backup came from another machine (§34).
    await api.restoreDatabase("C:\\b.db");
    expect(lastCall()).toEqual({
      cmd: "restore_database",
      args: { path: "C:\\b.db", key: null },
    });

    await api.restoreDatabase("C:\\b.db", "deadbeef");
    expect(lastCall()).toEqual({
      cmd: "restore_database",
      args: { path: "C:\\b.db", key: "deadbeef" },
    });
  });
});

describe("errors", () => {
  it("propagates a rejected invoke to the caller", async () => {
    setIpcHandlers({
      get_all_accounts: () => {
        throw new Error("db locked");
      },
    });
    await expect(api.getAllAccounts()).rejects.toThrow("db locked");
  });
});

describe("coverage of the registered command set", () => {
  // The backend registers its commands in one `generate_handler!` block.
  // Read it and assert ipc.ts wraps exactly that set — this is what catches a
  // command added in Rust but never surfaced to the UI (and vice versa).
  // Sources are pulled in through vite's `?raw` loader (no node:fs), so this
  // test runs the same way in any environment.

  const block = libRs.slice(
    libRs.indexOf("generate_handler!["),
    libRs.indexOf("]", libRs.indexOf("generate_handler!["))
  );
  const registered = [...block.matchAll(/commands::(\w+)/g)].map((m) => m[1]).sort();
  const wrapped = [...ipcTs.matchAll(/invoke<[^>]*>\(\s*"(\w+)"/g)].map((m) => m[1]).sort();

  // 73. The original 56, plus `seed_demo_data` (§24 — registered
  // unconditionally because `generate_handler!` cannot take a `cfg` on an
  // entry, and refused at runtime in release), `refresh_investment_prices`
  // (§27), four for Common Transactions (§31), ten for scheduled bills (§32 —
  // which RETIRED the four one-off payment commands), and five for key
  // recovery and automatic backup (§34), `create_payee` (§37.4), and
  // `search_transactions` (§38), and `list_reports`, `run_report` `get_transaction_account` and the three saved-report commands (§39) — which retired `get_report_summary`.
  // 88 (§41): the four flat-holdings commands retired, twelve for
  // securities, prices, investment transactions, lots and the portfolio.
  // 89 (§45): create_share_transfer. 91 (§46): set_transaction_goal, contribute_to_goal. 92 (§48): set_account_tax_included. 93 (§49): merge_accounts. 94 (§50): update_holdings. 96 (§51): autobudget, apply_autobudget. 97 (§52): get_occurrences. 98 (§53): set_transaction_tax_line. 99 (§54): export_qif. 101 (§55): get_ui_setting, set_ui_setting. 102 (§56): get_roi. 103 (§70): reconcile_through. 104 (§75): fill_symbols_from_names. 105 (§81): set_account_value_rounding. 106 (§83): verify_file. 111 (§84): list/create/delete_payee_rule, apply_payee_rules, find_duplicates. 112 (§85): write_text_file. 114 (§88): preview_csv, import_csv. 116 (§89): preview_import, import_with_decisions. 119 (§93): set_account_value, set_account_security, debts_by_asset. 125 (§94): get_loan_terms, set_loan_terms, clear_loan_terms, loan_schedule, next_loan_payment, record_loan_payment. 129 (§98): current_file, list_recent_files, forget_file, open_file. 132 (§101): undo_status, undo_last, redo_last. 133 (§102): startup_note. 145 (§112): list/create/rename/delete_classification, create/rename/delete_classification_value, set_transaction_classes. 146 (§115): price_status. 147 (§128): create_sample_file. 149 (§129): get_budget_grid, get_budget_starter. 151 (§133): preview_category_merge. 154 (§139): get_year_plan, set_budget_plan, clear_budget_plan. 156 (§141): plan_from_history, apply_year_plan.
  // §148 — 155, down from 156: `set_budget_line` went when the month screen
  // stopped writing. The count only ever goes up by design, so a DROP is
  // worth the sentence.
  // 158: list_split_descriptions (§160), convert_to_transfer and
  // convert_from_transfer (§164), set_account_order (§169) — and set_splits
  // RETIRED in §168, when the lines started traveling in the create and
  // edit payloads and nothing called it any more. 159: get_performance (§172). 164: the five attachment commands (§170).
  it("finds the 164 registered commands", () => {
    expect(registered.length).toBe(164);
    expect(new Set(registered).size).toBe(164);
  });

  it("ipc.ts wraps every registered command and nothing else", () => {
    expect(wrapped).toEqual(registered);
  });
});
