// @vitest-environment jsdom
// A split line can be a transfer.
//
// The database column, the Rust `NewSplit` and the ledger have carried this
// for some time, and no user could ever produce one: this dialog's picker offered
// categories only, so the feature existed everywhere except where someone
// could reach it. A user found it by looking for it and not finding it.
//
// The shape being locked down: ONE field holds either a category or an
// account, spelled "Transfer : Name", exactly as the register's own category
// field has always done it.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

import SplitDialog from "./SplitDialog";
import { resetIpc, setIpcHandlers } from "../test/tauriMock";
import { categoryItems, transferTargetOf, transferValue } from "./CategorySelect";
import type { Account, Category, Classification, NewSplit } from "../lib/types";

const cat = (id: string, name: string, kind: "income" | "expense"): Category => ({
  id,
  name,
  parent_id: null,
  kind,
  tax_line: null,
  full_name: name,
  usage_count: 0,
});

const account = (id: string, name: string): Account => ({
  id,
  name,
  type: "savings",
  balance_cents: 0,
  holdings_value_cents: 0,
  tax_included: true,
  is_favorite: false,
  is_closed: false,
  updated_at: "2026-09-01T00:00:00Z",
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

const categories = [cat("c-food", "Food", "expense"), cat("c-pay", "Salary", "income")];
const accounts = [account("a-sav", "Everyday Savings 5678"), account("a-vac", "Vacation Fund")];

describe("the transfer spelling", () => {
  it("round-trips an account id through the picker's value", () => {
    expect(transferTargetOf(transferValue("a-sav"))).toBe("a-sav");
    // A category id is not a transfer, and must never be read as one.
    expect(transferTargetOf("c-food")).toBeNull();
    expect(transferTargetOf("")).toBeNull();
  });

  it("puts the accounts after the categories, in their own group", () => {
    const items = categoryItems(categories, "expense", accounts);
    expect(items.map((i) => i.label)).toEqual([
      "Food",
      "Transfer : Everyday Savings 5678",
      "Transfer : Vacation Fund",
    ]);
    expect(items[items.length - 1].group).toBe("Transfer");
  });

  it("offers no transfers at all when a picker is not given any", () => {
    // A budget target or a payee's default category cannot be a transfer, and
    // offering one there would be a menu item that cannot work (the menu rule,
    // one layer down).
    expect(categoryItems(categories, "expense").every((i) => !i.value.startsWith("transfer:"))).toBe(true);
  });
});

const property: Classification = {
  id: "cl-prop",
  name: "Property",
  sort_order: 0,
  usage_count: 0,
  values: [
    { id: "v-cos", classification_id: "cl-prop", parent_id: null, name: "Maple", full_name: "Maple", usage_count: 0 },
    { id: "v-lak", classification_id: "cl-prop", parent_id: null, name: "Birch Lane", full_name: "Birch Lane", usage_count: 0 },
  ],
};

describe("classifications on a split line", () => {
  // The case the whole axis exists for: one receipt, two houses. A picker
  // that only reached whole transactions would lose this, which is where
  // clones of Money's classifications usually give up.
  function open(props: Partial<React.ComponentProps<typeof SplitDialog>> = {}) {
    const onDone = vi.fn();
    render(
      <SplitDialog
        categories={categories}
        transferTargets={accounts}
        parentAmountCents={-9_000}
        classifications={[property]}
        onDone={onDone}
        onCancel={vi.fn()}
        {...props}
      />
    );
    return onDone;
  }

  it("gives each line its own value, and sends every axis so a cleared one clears", async () => {
    const onDone = open();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Property 1"), "v-cos");
    await user.type(screen.getByLabelText("Amount 1"), "60.00");
    await user.selectOptions(screen.getByLabelText("Property 2"), "v-lak");
    await user.type(screen.getByLabelText("Amount 2"), "30.00");
    await user.click(screen.getByRole("button", { name: "Done" }));

    const [lines] = onDone.mock.calls[0] as [NewSplit[], number];
    expect(lines.map((l) => l.amount_cents)).toEqual([-6000, -3000]);
    expect(lines[0].classes).toEqual([{ classification_id: "cl-prop", value_id: "v-cos" }]);
    expect(lines[1].classes).toEqual([{ classification_id: "cl-prop", value_id: "v-lak" }]);
  });

  it("shows what a line inherits from the transaction rather than a bare (none)", () => {
    open({ parentClasses: [{ classification_id: "cl-prop", value_id: "v-cos" }] });
    const empty = within(screen.getByLabelText("Property 1")).getByRole("option", {
      name: "(same as the transaction — Maple)",
    });
    expect(empty).toBeInTheDocument();
    // …and a line that keeps it sends an empty value, which is what "follow
    // the transaction" means in the database.
    expect((screen.getByLabelText("Property 1") as HTMLSelectElement).value).toBe("");
  });

  it("re-opens a split showing the value each line already carries", () => {
    open({
      initialSplits: [
        { category_id: "c-food", description: null, amount_cents: -6000, classes: [{ classification_id: "cl-prop", value_id: "v-lak", label: "Birch Lane" }] },
      ],
    });
    expect((screen.getByLabelText("Property 1") as HTMLSelectElement).value).toBe("v-lak");
  });

  it("grays out an axis that has no values, and says where to add them", () => {
    // A classification with no values is a question with no answers.
    // One classification per value, rather than one classification with the
    // values IN it, left every register field empty with no hint of what was
    // wrong.
    open({ classifications: [{ ...property, values: [] }] });
    const field = screen.getByLabelText("Property 1") as HTMLSelectElement;
    expect(field).toBeDisabled();
    expect(within(field).getByRole("option", { name: "(no values yet)" })).toBeInTheDocument();
  });

  it("shows no classification column at all when the file has none", () => {
    open({ classifications: [] });
    expect(screen.queryByLabelText("Property 1")).not.toBeInTheDocument();
  });
});

describe("SplitDialog", () => {
  function open(initialSplits: NewSplit[] = [], onDone = vi.fn()) {
    render(
      <SplitDialog
        categories={categories}
        transferTargets={accounts}
        parentAmountCents={-10_000}
        initialSplits={initialSplits}
        onDone={onDone}
        onCancel={vi.fn()}
      />
    );
    return onDone;
  }

  it("offers the accounts in the category field", async () => {
    open();
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Category 1"));
    const list = await screen.findByRole("listbox");
    expect(within(list).getByText("Transfer : Everyday Savings 5678")).toBeInTheDocument();
    expect(within(list).getByText("Food")).toBeInTheDocument();
  });

  it("hands back a transfer line as an account, not a category", async () => {
    const onDone = open();
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Category 1"));
    await user.click(await screen.findByText("Transfer : Vacation Fund"));
    await user.type(screen.getByLabelText("Amount 1"), "40.00");
    await user.click(screen.getByRole("button", { name: "Done" }));
    // The line is not the whole $100.00, so Done asks first.
    await user.click(screen.getByRole("button", { name: /^Change the amount to/ }));

    const [lines] = onDone.mock.calls[0] as [NewSplit[], number];
    expect(lines).toHaveLength(1);
    // Both fields matter: the account is set AND the category is cleared. A
    // line carrying both would be a transfer that is also filed under a
    // category, which is two different claims about the same money.
    expect(lines[0].transfer_account_id).toBe("a-vac");
    expect(lines[0].category_id).toBeNull();
    expect(lines[0].amount_cents).toBe(-4000);
  });

  it("still hands back an ordinary category line as a category", async () => {
    const onDone = open();
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Category 1"));
    await user.click(await screen.findByText("Food"));
    await user.type(screen.getByLabelText("Amount 1"), "60.00");
    await user.click(screen.getByRole("button", { name: "Done" }));
    await user.click(screen.getByRole("button", { name: /^Change the amount to/ }));

    const [lines] = onDone.mock.calls[0] as [NewSplit[], number];
    expect(lines[0].category_id).toBe("c-food");
    expect(lines[0].transfer_account_id).toBeNull();
  });

  it("re-opens an existing transfer line showing what it is", () => {
    // Stored as an account id; it has to come back as "Transfer : …" rather
    // than as an empty category, or editing a split would silently drop it.
    open([
      { category_id: null, transfer_account_id: "a-sav", description: null, amount_cents: -4000 },
    ]);
    expect(screen.getByLabelText("Category 1")).toHaveValue("Transfer : Everyday Savings 5678");
  });
});

// What a morning of real entry asked of this dialog.
describe("SplitDialog", () => {
  beforeEach(() => {
    resetIpc();
    setIpcHandlers({ list_split_descriptions: () => [{ name: "Milk", usage_count: 3 }, { name: "Mints", usage_count: 1 }] });
  });

  function open(props: Partial<React.ComponentProps<typeof SplitDialog>> = {}) {
    const onDone = vi.fn();
    const onCancel = vi.fn();
    render(
      <SplitDialog
        categories={categories}
        transferTargets={accounts}
        parentAmountCents={-10_000}
        onDone={onDone}
        onCancel={onCancel}
        {...props}
      />
    );
    return { onDone, onCancel };
  }

  it("shows the amount entered, the lines' total, and the difference — 0.00 when they agree", async () => {
    open();
    const user = userEvent.setup();
    expect(screen.getByLabelText("Transaction amount")).toHaveTextContent("($100.00)");
    await user.type(screen.getByLabelText("Amount 1"), "60.00");
    expect(screen.getByLabelText("Split total")).toHaveTextContent("($60.00)");
    expect(screen.getByLabelText("Difference")).toHaveTextContent("($40.00)");
    await user.type(screen.getByLabelText("Amount 2"), "40.00");
    expect(screen.getByLabelText("Difference")).toHaveTextContent("$0.00");
  });

  it("shows only the total when the transaction has no amount yet", async () => {
    open({ parentAmountCents: null });
    await userEvent.setup().click(screen.getByRole("button", { name: "I spent money" }));
    expect(screen.queryByLabelText("Transaction amount")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Difference")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Split total")).toBeInTheDocument();
  });

  it("Enter is Done, and lines that add up need no confirmation", async () => {
    const { onDone } = open();
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Category 1"));
    await user.click(await screen.findByText("Food"));
    await user.type(screen.getByLabelText("Amount 1"), "100.00{Enter}");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone.mock.calls[0][1]).toBe(-10_000);
  });

  it("Escape is Cancel", async () => {
    const { onDone, onCancel } = open();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Amount 1"), "5{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("a total that differs from the amount entered is confirmed first, and Go back keeps editing", async () => {
    const { onDone } = open();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Amount 1"), "60.00{Enter}");
    expect(onDone).not.toHaveBeenCalled();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("The lines total ($60.00), but the transaction amount is ($100.00)");
    expect(alert).not.toHaveTextContent("reconciled");
    await user.click(screen.getByRole("button", { name: "Go back" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    // Enter again, and Enter on the confirmation says yes.
    await user.type(screen.getByLabelText("Amount 1"), "{Enter}");
    await user.keyboard("{Enter}");
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone.mock.calls[0][1]).toBe(-6_000);
  });

  // The banner held the lines from the first Done, and its answer
  // wrote those even after the grid below it had been fixed.
  it("a line fixed after the confirmation appeared is what Done writes", async () => {
    const { onDone } = open();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Amount 1"), "60.00{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent("The lines total ($60.00)");
    // The grid is still editable: add the missing line, then Enter.
    await user.type(screen.getByLabelText("Amount 2"), "40.00");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone.mock.calls[0][1]).toBe(-10_000);
    expect(onDone.mock.calls[0][0]).toHaveLength(2);
  });

  it("a change that still does not add up asks again, about the new total", async () => {
    const { onDone } = open();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Amount 1"), "60.00{Enter}");
    await user.type(screen.getByLabelText("Amount 2"), "30.00{Enter}");
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("The lines total ($90.00)");
    await user.click(screen.getByRole("button", { name: /^Change the amount to/ }));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone.mock.calls[0][1]).toBe(-9_000);
  });

  // An amount Done could not read counted as an empty line and
  // dropped out of the split without a word.
  it("refuses a line whose amount is not an amount, and marks it", async () => {
    const { onDone } = open();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Amount 1"), "90.00");
    await user.type(screen.getByLabelText("Amount 2"), "1O.00");
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Amount 2")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Amount 1")).not.toHaveAttribute("aria-invalid");
    expect(screen.getByRole("alert")).toHaveTextContent("The amount on line 2, “1O.00”, is not an amount.");
    // No confirmation about a total that leaves the bad line out.
    expect(screen.queryByText("The lines do not add up to the amount entered")).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText("Amount 2"));
    await user.type(screen.getByLabelText("Amount 2"), "10.00");
    expect(screen.getByLabelText("Amount 2")).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone.mock.calls[0][1]).toBe(-10_000);
  });

  it("refuses three decimal places rather than dropping the line", async () => {
    const { onDone } = open();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Amount 1"), "12.345{Enter}");
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Amount 1")).toHaveAttribute("aria-invalid", "true");
  });

  it("says when the transaction was reconciled, and by how much the next reconcile will be out", async () => {
    open({ reconciled: true });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Amount 1"), "60.00");
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.getByRole("alert")).toHaveTextContent("already been reconciled");
    expect(screen.getByRole("alert")).toHaveTextContent("out by $40.00");
  });

  it("completes a description from descriptions used before", async () => {
    open();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Description 1"), "Mi");
    const list = await screen.findByRole("listbox", { name: "Description 1 suggestions" });
    expect(within(list).getByText("Milk")).toBeInTheDocument();
    expect(within(list).getByText("Mints")).toBeInTheDocument();
    await user.click(within(list).getByText("Milk"));
    expect(screen.getByLabelText("Description 1")).toHaveValue("Milk");
  });
});
