// Payees manager (§10.3 item 8) — rename, merge, and the delete guard.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

import PayeesView from "./PayeesView";
import { describeConditions } from "./PayeeRulesCard";
import { useAccountStore } from "../stores/useAccountStore";
import { invokeCalls, resetIpc, setIpcHandlers } from "../test/tauriMock";
import { forgetUndo, undoStatus } from "../lib/undo";
import type { Account, Category, Payee } from "../lib/types";

const CATS: Category[] = [
  {
    id: "c-1",
    name: "Groceries",
    parent_id: null,
    kind: "expense",
    tax_line: null,
    full_name: "Groceries",
    usage_count: 4,
  },
];

const PAYEES: Payee[] = [
  {
    id: "p-1",
    name: "Kroger",
    last_category_id: "c-1",
    last_category_name: "Groceries",
    usage_count: 14,
    updated_at: "2026-08-30T00:00:00Z",
    last_amount_cents: null,
  },
  {
    id: "p-2",
    name: "KROGER #442",
    last_category_id: null,
    last_category_name: null,
    usage_count: 3,
    updated_at: "2026-08-30T00:00:00Z",
    last_amount_cents: null,
  },
  {
    id: "p-3",
    name: "Typo Payee",
    last_category_id: null,
    last_category_name: null,
    usage_count: 0,
    updated_at: "2026-08-30T00:00:00Z",
    last_amount_cents: null,
  },
];

beforeEach(() => {
  resetIpc();
  useAccountStore.setState({ payees: [], categories: [], selectedAccountId: null });
  setIpcHandlers({ list_payees: () => PAYEES, list_categories: () => CATS });
});

// §84 — rename rules live on the Payees page.
describe("Rename rules (§84)", () => {
  it("lists rules, adds one, and applies them to the file", async () => {
    let rules: unknown[] = [{ id: "r-1", match_text: "NETFLIX", payee_name: "Netflix", category_id: null, category_name: null, created_at: "" }];
    setIpcHandlers({
      list_payees: () => PAYEES,
      list_categories: () => CATS,
      list_payee_rules: () => rules,
      create_payee_rule: (args) => {
        rules = [...rules, { id: "r-2", match_text: args.matchText, payee_name: args.payeeName, category_id: args.categoryId, category_name: null, created_at: "" }];
        return rules[rules.length - 1];
      },
      apply_payee_rules: () => 7,
      get_favorite_accounts: () => [],
      get_all_accounts: () => [],
    });
    render(<PayeesView />);
    const card = await screen.findByRole("region", { name: "Payee rename rules" });
    expect(within(card).getByText("NETFLIX")).toBeInTheDocument();
    await userEvent.type(within(card).getByLabelText("Contains"), "AMAZON");
    await userEvent.type(within(card).getByLabelText("Call it"), "Amazon");
    await userEvent.click(within(card).getByRole("button", { name: "Add rule" }));
    await waitFor(() => expect(within(card).getByText("Amazon")).toBeInTheDocument());
    expect(invokeCalls.find((c) => c.cmd === "create_payee_rule")?.args).toEqual({ matchText: "AMAZON", payeeName: "Amazon", categoryId: null, minCents: null, maxCents: null, memoContains: null, accountId: null });
    await userEvent.click(within(card).getByRole("button", { name: "Apply to existing transactions" }));
    await waitFor(() => expect(within(card).getByRole("status")).toHaveTextContent("Changed 7 transactions."));
  });

  // §171 — a rule can be narrowed by amount, memo and account; the card
  // sends the conditions in cents (absolute), and shows them on the row.
  it("adds a rule with conditions and describes them on the row", async () => {
    const checking = { id: "acc-1", name: "Checking", type: "checking", is_closed: false } as unknown as Account;
    let rules: unknown[] = [];
    setIpcHandlers({
      list_payees: () => PAYEES,
      list_categories: () => CATS,
      list_payee_rules: () => rules,
      create_payee_rule: (args) => {
        rules = [{ id: "r-9", match_text: args.matchText, payee_name: args.payeeName, category_id: args.categoryId, category_name: null, created_at: "", min_cents: args.minCents, max_cents: args.maxCents, memo_contains: args.memoContains, account_id: args.accountId, account_name: args.accountId ? "Checking" : null }];
        return rules[0];
      },
      get_favorite_accounts: () => [],
      get_all_accounts: () => [checking],
    });
    useAccountStore.setState({ accounts: [checking] });
    render(<PayeesView />);
    const card = await screen.findByRole("region", { name: "Payee rename rules" });
    await userEvent.type(within(card).getByLabelText("Contains"), "AMAZON");
    await userEvent.type(within(card).getByLabelText("Call it"), "Amazon");
    await userEvent.type(within(card).getByLabelText("Amount at least"), "5");
    await userEvent.type(within(card).getByLabelText("Amount at most"), "-20.00");
    await userEvent.type(within(card).getByLabelText("Memo contains"), "prime");
    await userEvent.selectOptions(within(card).getByLabelText("Rule account"), "acc-1");
    await userEvent.click(within(card).getByRole("button", { name: "Add rule" }));
    await waitFor(() => expect(within(card).getByText("Amazon")).toBeInTheDocument());
    expect(invokeCalls.find((c) => c.cmd === "create_payee_rule")?.args).toEqual({
      matchText: "AMAZON",
      payeeName: "Amazon",
      categoryId: null,
      minCents: 500,
      maxCents: 2000,
      memoContains: "prime",
      accountId: "acc-1",
    });
    expect(within(card).getByText('$5.00 to $20.00 · memo has "prime" · in Checking')).toBeInTheDocument();
    // The fields are cleared for the next rule.
    expect(within(card).getByLabelText("Memo contains")).toHaveValue("");
  });

  it("describes a one-sided amount range in words", () => {
    const base = { id: "r", match_text: "X", payee_name: "X", category_id: null, category_name: null, created_at: "" };
    expect(describeConditions({ ...base, min_cents: 1000, max_cents: null, memo_contains: null, account_id: null, account_name: null })).toBe("at least $10.00");
    expect(describeConditions({ ...base, min_cents: null, max_cents: 1000, memo_contains: null, account_id: null, account_name: null })).toBe("at most $10.00");
    expect(describeConditions({ ...base, min_cents: null, max_cents: null, memo_contains: null, account_id: null, account_name: null })).toBe("");
  });
});

describe("PayeesView", () => {
  it("lists payees with their default category and transaction count", async () => {
    render(<PayeesView />);
    const row = (await screen.findByText("Kroger")).closest("tr")!;
    expect(within(row).getByText("Groceries")).toBeInTheDocument();
    expect(within(row).getByText("14")).toBeInTheDocument();
  });

  it("filters by name", async () => {
    render(<PayeesView />);
    await screen.findByText("Typo Payee");
    await userEvent.type(screen.getByLabelText("Find payee"), "kro");
    expect(screen.getByText("Kroger")).toBeInTheDocument();
    expect(screen.queryByText("Typo Payee")).not.toBeInTheDocument();
  });

  it("renames the selected payee", async () => {
    setIpcHandlers({
      list_payees: () => PAYEES,
      list_categories: () => CATS,
      update_payee: () => PAYEES[0],
    });
    render(<PayeesView />);
    await userEvent.click(await screen.findByText("Kroger"));

    const nameBox = screen.getByLabelText("Payee name") as HTMLInputElement;
    expect(nameBox.value).toBe("Kroger");
    await userEvent.clear(nameBox);
    await userEvent.type(nameBox, "Kroger Fuel Center");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    const call = await waitFor(() => invokeCalls.find((c) => c.cmd === "update_payee")!);
    expect(call.args).toEqual({
      id: "p-1",
      name: "Kroger Fuel Center",
      lastCategoryId: "c-1",
    });
  });

  it("cannot edit until a payee is chosen", async () => {
    render(<PayeesView />);
    await screen.findByText("Kroger");
    expect(screen.getByLabelText("Payee name")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("refuses to delete a payee that transactions still use", async () => {
    render(<PayeesView />);
    const used = (await screen.findByText("Kroger")).closest("tr")!;
    expect(within(used).getByRole("button", { name: "Delete" })).toBeDisabled();

    const unused = screen.getByText("Typo Payee").closest("tr")!;
    expect(within(unused).getByRole("button", { name: "Delete" })).toBeEnabled();
  });

  it("deletes an unused payee", async () => {
    setIpcHandlers({
      list_payees: () => PAYEES,
      list_categories: () => CATS,
      delete_payee: () => null,
    });
    render(<PayeesView />);
    const row = (await screen.findByText("Typo Payee")).closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Delete" }));
    const call = await waitFor(() => invokeCalls.find((c) => c.cmd === "delete_payee")!);
    expect(call.args).toEqual({ id: "p-3" });
  });

  it("merges a duplicate payee into the real one", async () => {
    setIpcHandlers({
      list_payees: () => PAYEES,
      list_categories: () => CATS,
      merge_payees: () => PAYEES[0],
    });
    render(<PayeesView />);
    const dupe = (await screen.findByText("KROGER #442")).closest("tr")!;
    await userEvent.click(within(dupe).getByRole("button", { name: "Merge…" }));

    const dialog = screen.getByRole("dialog", { name: "Merge payee" });
    expect(within(dialog).getByText(/3 transaction\(s\)/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Merge" })).toBeDisabled();

    await userEvent.selectOptions(within(dialog).getByLabelText("Merge into payee"), "p-1");
    await userEvent.click(within(dialog).getByRole("button", { name: "Merge" }));

    const call = await waitFor(() => invokeCalls.find((c) => c.cmd === "merge_payees")!);
    expect(call.args).toEqual({ fromId: "p-2", intoId: "p-1" });
  });

  // §186 — "I merged Best Buy into Chewy … CTRL+Z did not undo it." The
  // backend records both writes now; the Edit menu only hears about it if
  // the undo status is asked for again AFTER the write.
  const lastCall = (cmd: string) => invokeCalls.reduce((last, c, i) => (c.cmd === cmd ? i : last), -1);

  it("re-reads the undo status after a merge, so Edit offers Undo merge payees", async () => {
    forgetUndo();
    setIpcHandlers({
      list_payees: () => PAYEES,
      list_categories: () => CATS,
      merge_payees: () => PAYEES[0],
      undo_status: () => ({ undo: "merge payees", redo: null }),
    });
    render(<PayeesView />);
    const dupe = (await screen.findByText("KROGER #442")).closest("tr")!;
    await userEvent.click(within(dupe).getByRole("button", { name: "Merge…" }));
    const dialog = screen.getByRole("dialog", { name: "Merge payee" });
    await userEvent.selectOptions(within(dialog).getByLabelText("Merge into payee"), "p-1");
    await userEvent.click(within(dialog).getByRole("button", { name: "Merge" }));

    await waitFor(() => expect(lastCall("merge_payees")).toBeGreaterThan(-1));
    await waitFor(() => expect(lastCall("undo_status")).toBeGreaterThan(lastCall("merge_payees")));
    await waitFor(() => expect(undoStatus().undo).toBe("merge payees"));
  });

  it("re-reads the undo status after a rename", async () => {
    forgetUndo();
    setIpcHandlers({
      list_payees: () => PAYEES,
      list_categories: () => CATS,
      update_payee: () => PAYEES[0],
      undo_status: () => ({ undo: "rename a payee", redo: null }),
    });
    render(<PayeesView />);
    await userEvent.click(await screen.findByText("Kroger"));
    await userEvent.clear(screen.getByLabelText("Payee name"));
    await userEvent.type(screen.getByLabelText("Payee name"), "Kroger Fuel Center");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(lastCall("update_payee")).toBeGreaterThan(-1));
    await waitFor(() => expect(lastCall("undo_status")).toBeGreaterThan(lastCall("update_payee")));
    await waitFor(() => expect(undoStatus().undo).toBe("rename a payee"));
  });

  it("re-reads the undo status after deleting a payee", async () => {
    forgetUndo();
    setIpcHandlers({
      list_payees: () => PAYEES,
      list_categories: () => CATS,
      delete_payee: () => null,
      undo_status: () => ({ undo: "delete a payee", redo: null }),
    });
    render(<PayeesView />);
    const row = (await screen.findByText("Typo Payee")).closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(lastCall("delete_payee")).toBeGreaterThan(-1));
    await waitFor(() => expect(lastCall("undo_status")).toBeGreaterThan(lastCall("delete_payee")));
    await waitFor(() => expect(undoStatus().undo).toBe("delete a payee"));
  });

  it("shows the backend's refusal when a rename collides", async () => {
    setIpcHandlers({
      list_payees: () => PAYEES,
      list_categories: () => CATS,
      update_payee: () => {
        throw new Error("a payee named 'KROGER #442' already exists — merge them instead");
      },
    });
    render(<PayeesView />);
    await userEvent.click(await screen.findByText("Kroger"));
    await userEvent.clear(screen.getByLabelText("Payee name"));
    await userEvent.type(screen.getByLabelText("Payee name"), "KROGER #442");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/merge them instead/)).toBeInTheDocument();
  });
});

describe("adding a payee by hand (§37.4)", () => {
  const MADE: Payee = {
    id: "p-9",
    name: "City Water",
    last_category_id: null,
    last_category_name: null,
    usage_count: 0,
    updated_at: "2026-09-04T00:00:00Z",
    last_amount_cents: null,
  };

  it("creates the payee and selects it, so its category can be set", async () => {
    // Setting up a payee and its default category BEFORE the first
    // transaction is most of the reason to add one by hand, so landing on
    // the edit form is part of the feature, not a nicety.
    let created = false;
    setIpcHandlers({
      list_payees: () => (created ? [...PAYEES, MADE] : PAYEES),
      list_categories: () => CATS,
      create_payee: () => {
        created = true;
        return MADE;
      },
    });
    render(<PayeesView />);
    await screen.findByText("Kroger");

    await userEvent.type(screen.getByLabelText("New payee name"), "City Water");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    const call = await waitFor(() => invokeCalls.find((c) => c.cmd === "create_payee")!);
    expect(call.args).toEqual({ name: "City Water", lastCategoryId: null });

    const nameBox = await waitFor(
      () => screen.getByLabelText("Payee name") as HTMLInputElement
    );
    expect(nameBox.value).toBe("City Water");
  });

  it("will not send an empty name", async () => {
    render(<PayeesView />);
    await screen.findByText("Kroger");
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
  });

  it("shows the backend's refusal rather than pretending it worked", async () => {
    // A duplicate is refused by `queries::create_payee`; silently returning
    // the existing row would look like success and drop the user's input.
    setIpcHandlers({
      list_payees: () => PAYEES,
      list_categories: () => CATS,
      create_payee: () => {
        throw new Error('there is already a payee called "Kroger"');
      },
    });
    render(<PayeesView />);
    await screen.findByText("Kroger");

    await userEvent.type(screen.getByLabelText("New payee name"), "kroger");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(screen.getByText(/already a payee called/i)).toBeInTheDocument()
    );
  });
});

// §183 — the edit form after a merge, and where a refused merge is shown.
describe("§183 — merging the payee being edited", () => {
  it("loads the survivor into the form, so Save cannot rename it back to the merged-away name", async () => {
    let payees = PAYEES;
    setIpcHandlers({
      list_payees: () => payees,
      list_categories: () => CATS,
      merge_payees: () => {
        payees = PAYEES.filter((p) => p.id !== "p-2");
        return PAYEES[0];
      },
      update_payee: (args) => ({ ...PAYEES[0], name: String(args.name) }),
    });
    render(<PayeesView />);
    await userEvent.click(await screen.findByText("KROGER #442"));
    expect(screen.getByLabelText("Payee name")).toHaveValue("KROGER #442");

    const dupe = screen.getByText("KROGER #442").closest("tr")!;
    await userEvent.click(within(dupe).getByRole("button", { name: "Merge…" }));
    const dialog = screen.getByRole("dialog", { name: "Merge payee" });
    await userEvent.selectOptions(within(dialog).getByLabelText("Merge into payee"), "p-1");
    await userEvent.click(within(dialog).getByRole("button", { name: "Merge" }));

    await waitFor(() => expect(screen.getByLabelText("Payee name")).toHaveValue("Kroger"));
    expect(screen.getByText("Payees merged.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const call = await waitFor(() => invokeCalls.find((c) => c.cmd === "update_payee")!);
    expect(call.args).toMatchObject({ id: "p-1", name: "Kroger" });
  });

  it("shows a refused merge inside the dialog", async () => {
    setIpcHandlers({
      list_payees: () => PAYEES,
      list_categories: () => CATS,
      merge_payees: () => {
        throw new Error("the file is locked");
      },
    });
    render(<PayeesView />);
    const dupe = (await screen.findByText("KROGER #442")).closest("tr")!;
    await userEvent.click(within(dupe).getByRole("button", { name: "Merge…" }));
    const dialog = screen.getByRole("dialog", { name: "Merge payee" });
    await userEvent.selectOptions(within(dialog).getByLabelText("Merge into payee"), "p-1");
    await userEvent.click(within(dialog).getByRole("button", { name: "Merge" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("the file is locked");
  });
});
