// The import review: confident pairings are ticked, the user can
// overrule any of them, and Import sends one decision per row.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

import ImportMatchDialog from "./ImportMatchDialog";
import { invokeCalls, resetIpc, setIpcHandlers } from "../test/tauriMock";
import type { ImportMatchPreview, MatchExistingRow } from "../lib/types";

function existing(over: Partial<MatchExistingRow> = {}): MatchExistingRow {
  return {
    id: "t1",
    date: "2026-08-02",
    payee: "Safeway",
    amount_cents: -4_250,
    category_name: "Food : Groceries",
    notes: null,
    check_number: null,
    cleared_state: "",
    has_fitid: false,
    is_transfer: false,
    ...over,
  };
}

const preview: ImportMatchPreview = {
  account_id: "a",
  account_name: "Checking",
  total_rows: 4,
  duplicates: 1,
  unreadable: 0,
  new_rows: 1,
  window_days: 3,
  memo_groups: [],
  uncategorized: [],
  rows: [
    {
      index: 0,
      date: "2026-08-03",
      payee: "SAFEWAY #1234 ANYTOWN US",
      amount_cents: -4_250,
      check_number: null,
      likely: true,
      candidates: [{ existing: existing(), score: 0.83, day_gap: -1, why: "1 day apart, name 85% alike, not cleared yet" }],
    },
    {
      index: 1,
      date: "2026-08-11",
      payee: "GAS STATION 0001",
      amount_cents: -3_110,
      check_number: null,
      likely: false,
      candidates: [
        { existing: existing({ id: "t2", date: "2026-08-09", payee: "Shell", amount_cents: -3_110, category_name: "Auto : Gas" }), score: 0.44, day_gap: -2, why: "2 days apart, a different name" },
      ],
    },
  ],
};

const summary = {
  account_id: "a",
  account_name: "Checking",
  imported: 2,
  skipped: 0,
  duplicates: 1,
  balance_delta_cents: -3_110,
  investments: 0,
  securities_created: 0,
  transfers_linked: 0,
  matched: 1,
  user_skipped: 0,
  notes: [],
};

describe("ImportMatchDialog", () => {
  beforeEach(() => resetIpc());

  it("ticks the confident pairing, leaves the weak one to import, and sends a decision per row", async () => {
    setIpcHandlers({ import_with_decisions: () => summary });
    const onImported = vi.fn();
    render(
      <ImportMatchDialog
        path="bank.qif"
        accountId="a"
        mapping={null}
        preview={preview}
        onWindowChange={vi.fn()}
        onImported={onImported}
        onCancel={vi.fn()}
      />
    );
    const dlg = await screen.findByRole("dialog", { name: "Review matches" });

    // The likely one starts matched; the weak one starts as an import.
    const safeway = within(dlg).getByLabelText("Match SAFEWAY #1234 ANYTOWN US to Safeway on 2026-08-02");
    expect(safeway).toBeChecked();
    const gas = within(dlg).getByLabelText("Match GAS STATION 0001 to Shell on 2026-08-09");
    expect(gas).not.toBeChecked();
    expect(within(dlg).getByText(/1 matched · 2 imported · 0 skipped/)).toBeInTheDocument();

    // The reason is on screen — the user should not have to trust a number.
    expect(within(dlg).getByText(/1 day apart, name 85% alike/)).toBeInTheDocument();

    await userEvent.click(within(dlg).getByRole("button", { name: "Import" }));
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(summary));
    expect(invokeCalls.find((c) => c.cmd === "import_with_decisions")?.args).toEqual({
      path: "bank.qif",
      accountId: "a",
      mapping: null,
      decisions: [
        { index: 0, action: "match", existingId: "t1" },
        { index: 1, action: "new", existingId: null },
      ],
      memoRules: [],
    });
  });

  it("lets the user overrule a tick and skip a row instead", async () => {
    setIpcHandlers({ import_with_decisions: () => ({ ...summary, matched: 0, imported: 1, user_skipped: 1 }) });
    render(
      <ImportMatchDialog
        path="bank.qif"
        accountId="a"
        mapping={null}
        preview={preview}
        onWindowChange={vi.fn()}
        onImported={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    const dlg = await screen.findByRole("dialog", { name: "Review matches" });
    const skips = within(dlg).getAllByLabelText("Skip");
    await userEvent.click(skips[0]);
    expect(within(dlg).getByText(/0 matched · 2 imported · 1 skipped/)).toBeInTheDocument();

    await userEvent.click(within(dlg).getByRole("button", { name: "Import" }));
    await waitFor(() =>
      expect(invokeCalls.find((c) => c.cmd === "import_with_decisions")?.args.decisions).toEqual([
        { index: 0, action: "skip", existingId: null },
        { index: 1, action: "new", existingId: null },
      ])
    );
  });

  it("asks for a wider window without importing anything", async () => {
    const onWindowChange = vi.fn();
    render(
      <ImportMatchDialog
        path="bank.qif"
        accountId="a"
        mapping={null}
        preview={preview}
        onWindowChange={onWindowChange}
        onImported={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    const dlg = await screen.findByRole("dialog", { name: "Review matches" });
    await userEvent.selectOptions(within(dlg).getByLabelText("Date window"), "7");
    expect(onWindowChange).toHaveBeenCalledWith(7);
    expect(invokeCalls.filter((c) => c.cmd === "import_with_decisions")).toHaveLength(0);
  });
});

/** The picker is a type-ahead combobox, not a <select>: focus it, type
 *  enough to filter, then click the option. */
async function pickCategory(dlg: HTMLElement, label: string, option: string) {
  const box = within(dlg).getByLabelText(label);
  await userEvent.click(box);
  await userEvent.type(box, option.split(" : ").pop() ?? option);
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

describe("Rows with no category are asked about", () => {
  beforeEach(() => resetIpc());
  const categories = [
    { id: "c-auto", name: "Automobile", parent_id: null, kind: "expense" as const, tax_line: null, full_name: "Automobile", usage_count: 0 },
    { id: "c-fuel", name: "Fuel", parent_id: "c-auto", kind: "expense" as const, tax_line: null, full_name: "Automobile : Fuel", usage_count: 0 },
  ];
  const withUncat: ImportMatchPreview = {
    ...preview,
    rows: [],
    new_rows: 2,
    uncategorized: [
      { index: 3, date: "2026-08-12", payee: "GAS STATION 0001", amount_cents: -3_110 },
      { index: 4, date: "2026-08-13", payee: "MYSTERY VENDOR", amount_cents: -1_200 },
    ],
  };

  it("lists them, sends the chosen category with the decision, and leaves the rest alone", async () => {
    setIpcHandlers({ import_with_decisions: () => summary });
    const onImported = vi.fn();
    render(
      <ImportMatchDialog
        path="bank.qif"
        accountId="a"
        mapping={null}
        categories={categories}
        preview={withUncat}
        onWindowChange={vi.fn()}
        onImported={onImported}
        onCancel={vi.fn()}
      />
    );
    const dlg = await screen.findByRole("dialog", { name: "Review matches" });
    expect(within(dlg).getByText(/2 of the new rows have no category yet/)).toBeInTheDocument();
    // No near misses: the matching table and its window picker are not drawn.
    expect(within(dlg).queryByLabelText("Date window")).toBeNull();

    await pickCategory(dlg, "Category for GAS STATION 0001", "Automobile : Fuel");
    await userEvent.click(within(dlg).getByRole("button", { name: "Import" }));
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(summary));
    expect(invokeCalls.find((c) => c.cmd === "import_with_decisions")?.args).toEqual({
      path: "bank.qif",
      accountId: "a",
      mapping: null,
      decisions: [{ index: 3, action: "new", existingId: null, categoryId: "c-fuel" }],
      memoRules: [],
    });
    expect(invokeCalls.some((c) => c.cmd === "create_payee_rule")).toBe(false);
  });

  it("makes a payee rule when asked to remember, once the import is in, so the next statement does not ask", async () => {
    setIpcHandlers({ import_with_decisions: () => summary, create_payee_rule: () => ({ id: "r1" }) });
    render(
      <ImportMatchDialog
        path="bank.qif"
        accountId="a"
        mapping={null}
        categories={categories}
        preview={withUncat}
        onWindowChange={vi.fn()}
        onImported={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    const dlg = await screen.findByRole("dialog", { name: "Review matches" });
    // Nothing to remember until a category is chosen.
    expect(within(dlg).getByLabelText("Remember GAS STATION 0001")).toBeDisabled();
    await pickCategory(dlg, "Category for GAS STATION 0001", "Automobile : Fuel");
    await userEvent.click(within(dlg).getByLabelText("Remember GAS STATION 0001"));
    await userEvent.click(within(dlg).getByRole("button", { name: "Import" }));
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "import_with_decisions")).toBe(true));
    const rule = invokeCalls.findIndex((c) => c.cmd === "create_payee_rule");
    const imp = invokeCalls.findIndex((c) => c.cmd === "import_with_decisions");
    expect(rule).toBeGreaterThanOrEqual(0);
    // After, not before: a refused import must not leave rules behind.
    expect(rule).toBeGreaterThan(imp);
    expect(invokeCalls[rule].args).toEqual({ matchText: "GAS STATION 0001", payeeName: "GAS STATION 0001", categoryId: "c-fuel", minCents: null, maxCents: null, memoContains: null, accountId: null });
  });
});

// "remember" made its rules one row at a time BEFORE importing, and the
// backend refuses a second rule for the same text. Two rows from one payee
// aborted the import; a failed import left rules saved, so retries failed too.
describe("Remembering a payee never costs the import", () => {
  beforeEach(() => resetIpc());
  const categories = [
    { id: "c-auto", name: "Automobile", parent_id: null, kind: "expense" as const, tax_line: null, full_name: "Automobile", usage_count: 0 },
    { id: "c-fuel", name: "Fuel", parent_id: "c-auto", kind: "expense" as const, tax_line: null, full_name: "Automobile : Fuel", usage_count: 0 },
  ];
  const twice: ImportMatchPreview = {
    ...preview,
    rows: [],
    new_rows: 2,
    uncategorized: [
      { index: 3, date: "2026-08-12", payee: "GAS STATION 0001", amount_cents: -3_110 },
      { index: 4, date: "2026-08-19", payee: "gas station 0001", amount_cents: -2_900 },
    ],
  };

  function renderTwice(onImported = vi.fn()) {
    render(
      <ImportMatchDialog
        path="bank.qif"
        accountId="a"
        mapping={null}
        categories={categories}
        preview={twice}
        onWindowChange={vi.fn()}
        onImported={onImported}
        onCancel={vi.fn()}
      />
    );
    return onImported;
  }

  async function rememberBoth() {
    const dlg = await screen.findByRole("dialog", { name: "Review matches" });
    await pickCategory(dlg, "Category for GAS STATION 0001", "Automobile : Fuel");
    await userEvent.click(within(dlg).getByLabelText("Remember GAS STATION 0001"));
    await pickCategory(dlg, "Category for gas station 0001", "Automobile : Fuel");
    await userEvent.click(within(dlg).getByLabelText("Remember gas station 0001"));
    await userEvent.click(within(dlg).getByRole("button", { name: "Import" }));
    return dlg;
  }

  it("makes one rule for two rows with the same payee, and the import goes through", async () => {
    let made = 0;
    setIpcHandlers({
      import_with_decisions: () => summary,
      create_payee_rule: () => {
        made++;
        if (made > 1) throw 'there is already a rule for "gas station 0001"';
        return { id: "r1" };
      },
    });
    const onImported = renderTwice();
    await rememberBoth();
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(summary));
    expect(invokeCalls.filter((c) => c.cmd === "create_payee_rule")).toHaveLength(1);
    const decisions = invokeCalls.find((c) => c.cmd === "import_with_decisions")?.args.decisions;
    expect(decisions).toEqual([
      { index: 3, action: "new", existingId: null, categoryId: "c-fuel" },
      { index: 4, action: "new", existingId: null, categoryId: "c-fuel" },
    ]);
  });

  it("treats a rule that already exists as done, not as a failed import", async () => {
    setIpcHandlers({
      import_with_decisions: () => summary,
      create_payee_rule: () => {
        throw 'there is already a rule for "GAS STATION 0001"';
      },
    });
    const onImported = renderTwice();
    await rememberBoth();
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(summary));
  });

  it("saves no rule when the import is refused, so a retry is not refused too", async () => {
    setIpcHandlers({
      import_with_decisions: () => {
        throw "the file could not be read";
      },
      create_payee_rule: () => ({ id: "r1" }),
    });
    const onImported = renderTwice();
    const dlg = await rememberBoth();
    expect(await within(dlg).findByRole("alert")).toHaveTextContent("the file could not be read");
    expect(onImported).not.toHaveBeenCalled();
    expect(invokeCalls.some((c) => c.cmd === "create_payee_rule")).toBe(false);
  });

  it("says in the summary when a rule could not be saved for another reason", async () => {
    setIpcHandlers({
      import_with_decisions: () => summary,
      create_payee_rule: () => {
        throw "that category does not exist";
      },
    });
    const onImported = renderTwice();
    await rememberBoth();
    await waitFor(() => expect(onImported).toHaveBeenCalled());
    expect(onImported.mock.calls[0][0].notes).toEqual(["Could not remember a rule for GAS STATION 0001: that category does not exist"]);
  });
});
