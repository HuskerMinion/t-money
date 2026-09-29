// Categories manager — the tree, and the two operations that
// move existing transactions.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

import CategoriesView, { movesList, treeOf } from "./CategoriesView";
import { useAccountStore } from "../stores/useAccountStore";
import { invokeCalls, resetIpc, setIpcHandlers } from "../test/tauriMock";
import type { Category, MergePreview } from "../lib/types";

function cat(over: Partial<Category> & { id: string; name: string }): Category {
  return {
    parent_id: null,
    kind: "expense",
    tax_line: null,
    full_name: over.name,
    usage_count: 0,
    ...over,
  };
}

/** A merge that touches nothing, for tests to spread over. */
const PREVIEW: MergePreview = {
  transactions: 0,
  splits: 0,
  budgets: 0,
  budgetsFolded: 0,
  payeeRules: 0,
  recurrences: 0,
  children: 0,
  otherLinks: 0,
  blocked: null,
};

const CATS: Category[] = [
  cat({ id: "i-1", name: "Salary", kind: "income", usage_count: 12 }),
  cat({ id: "e-1", name: "Automobile", usage_count: 0 }),
  cat({
    id: "e-2",
    name: "Gasoline",
    parent_id: "e-1",
    full_name: "Automobile : Gasoline",
    usage_count: 7,
  }),
  cat({ id: "e-3", name: "Groceries", usage_count: 40, tax_line: null }),
];

beforeEach(() => {
  resetIpc();
  useAccountStore.setState({ categories: [], selectedAccountId: null, payees: [] });
  setIpcHandlers({ list_categories: () => CATS });
});

describe("treeOf", () => {
  it("nests each parent's children under it, per kind", () => {
    const expense = treeOf(CATS, "expense");
    expect(expense.map((n) => n.parent.id)).toEqual(["e-1", "e-3"]);
    expect(expense[0].children.map((c) => c.id)).toEqual(["e-2"]);
    expect(treeOf(CATS, "income").map((n) => n.parent.id)).toEqual(["i-1"]);
  });
});

describe("CategoriesView", () => {
  it("loads the tree and shows income and expense separately", async () => {
    render(<CategoriesView />);
    await screen.findByText("Salary");
    expect(screen.getByText("Automobile")).toBeInTheDocument();
    // A subcategory is shown by its own name, indented under its parent.
    expect(screen.getByText(/Gasoline/)).toBeInTheDocument();
    expect(invokeCalls.some((c) => c.cmd === "list_categories")).toBe(true);
  });

  it("shows how many lines each category carries", async () => {
    render(<CategoriesView />);
    await screen.findByText("Groceries");
    const row = screen.getByText("Groceries").closest("tr")!;
    expect(within(row).getByText("40")).toBeInTheDocument();
  });

  it("creates a top-level expense category", async () => {
    const created = vi.fn(() => cat({ id: "e-9", name: "Dining" }));
    setIpcHandlers({ list_categories: () => CATS, create_category: created });
    render(<CategoriesView />);
    await screen.findByText("Groceries");

    await userEvent.type(screen.getByLabelText("Category name"), "Dining");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(created).toHaveBeenCalled());
    const call = invokeCalls.find((c) => c.cmd === "create_category")!;
    expect(call.args).toEqual({
      name: "Dining",
      kind: "expense",
      parentId: null,
      taxLine: null,
    });
  });

  it("forces a subcategory to its parent's kind", async () => {
    setIpcHandlers({
      list_categories: () => CATS,
      create_category: () => cat({ id: "i-9", name: "Bonus", kind: "income" }),
    });
    render(<CategoriesView />);
    await screen.findByText("Salary");

    await userEvent.type(screen.getByLabelText("Category name"), "Bonus");
    await userEvent.selectOptions(screen.getByLabelText("Parent category"), "i-1");

    // The type select follows the parent and is locked while one is chosen.
    const kindSelect = screen.getByLabelText("Category type") as HTMLSelectElement;
    expect(kindSelect.value).toBe("income");
    expect(kindSelect).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    const call = await waitFor(
      () => invokeCalls.find((c) => c.cmd === "create_category")!
    );
    expect(call.args).toMatchObject({ kind: "income", parentId: "i-1" });
  });

  it("edits the selected category rather than creating a new one", async () => {
    setIpcHandlers({
      list_categories: () => CATS,
      update_category: () => cat({ id: "e-3", name: "Food" }),
    });
    render(<CategoriesView />);
    await userEvent.click(await screen.findByText("Groceries"));

    const nameBox = screen.getByLabelText("Category name") as HTMLInputElement;
    expect(nameBox.value).toBe("Groceries");
    await userEvent.clear(nameBox);
    await userEvent.type(nameBox, "Food");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    const call = await waitFor(() => invokeCalls.find((c) => c.cmd === "update_category")!);
    expect(call.args).toMatchObject({ id: "e-3", name: "Food" });
  });

  it("states the transaction count and refiles them on delete", async () => {
    setIpcHandlers({ list_categories: () => CATS, delete_category: () => null });
    render(<CategoriesView />);
    await screen.findByText("Groceries");

    const row = screen.getByText("Groceries").closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Delete…" }));

    const dialog = screen.getByRole("dialog", { name: "Delete category" });
    expect(within(dialog).getByText(/40 transaction line\(s\)/)).toBeInTheDocument();

    await userEvent.selectOptions(
      within(dialog).getByLabelText("Reassign transactions to"),
      "e-1"
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    const call = await waitFor(() => invokeCalls.find((c) => c.cmd === "delete_category")!);
    expect(call.args).toEqual({ id: "e-3", reassignTo: "e-1" });
  });

  it("leaves transactions uncategorized when no target is chosen", async () => {
    setIpcHandlers({ list_categories: () => CATS, delete_category: () => null });
    render(<CategoriesView />);
    await screen.findByText("Groceries");
    const row = screen.getByText("Groceries").closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Delete…" }));
    await userEvent.click(
      within(screen.getByRole("dialog", { name: "Delete category" })).getByRole("button", {
        name: "Delete",
      })
    );
    const call = await waitFor(() => invokeCalls.find((c) => c.cmd === "delete_category")!);
    expect(call.args).toEqual({ id: "e-3", reassignTo: null });
  });

  it("will not merge until a destination is chosen", async () => {
    setIpcHandlers({
      list_categories: () => CATS,
      merge_categories: () => null,
      preview_category_merge: () => PREVIEW,
    });
    render(<CategoriesView />);
    await screen.findByText("Groceries");
    const row = screen.getByText("Groceries").closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Merge…" }));

    const dialog = screen.getByRole("dialog", { name: "Merge category" });
    expect(within(dialog).getByRole("button", { name: "Merge" })).toBeDisabled();

    await userEvent.selectOptions(within(dialog).getByLabelText("Merge into"), "e-1");
    // The button names the direction once there is one to name.
    const go = await within(dialog).findByRole("button", { name: /^Merge Groceries into / });
    await userEvent.click(go);

    const call = await waitFor(() => invokeCalls.find((c) => c.cmd === "merge_categories")!);
    expect(call.args).toEqual({ fromId: "e-3", intoId: "e-1" });
  });

  // "Its not intuitive on which way the merge goes."
  it("says which category survives and which one is deleted", async () => {
    setIpcHandlers({
      list_categories: () => CATS,
      merge_categories: () => null,
      preview_category_merge: () => ({ ...PREVIEW, transactions: 214, payeeRules: 2 }),
    });
    render(<CategoriesView />);
    await screen.findByText("Groceries");
    const row = screen.getByText("Groceries").closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Merge…" }));
    const dialog = screen.getByRole("dialog", { name: "Merge category" });
    await userEvent.selectOptions(within(dialog).getByLabelText("Merge into"), "e-1");

    expect(await within(dialog).findByText("emptied, then deleted")).toBeInTheDocument();
    expect(within(dialog).getByText("kept — receives everything")).toBeInTheDocument();
    expect(
      within(dialog).getByText(/214 transactions, 2 payee rules/)
    ).toBeInTheDocument();
  });

  it("swaps the direction without reopening the dialog", async () => {
    setIpcHandlers({
      list_categories: () => CATS,
      merge_categories: () => null,
      preview_category_merge: () => PREVIEW,
    });
    render(<CategoriesView />);
    await screen.findByText("Groceries");
    const row = screen.getByText("Groceries").closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Merge…" }));
    const dialog = screen.getByRole("dialog", { name: "Merge category" });
    await userEvent.selectOptions(within(dialog).getByLabelText("Merge into"), "e-1");

    const before = await within(dialog).findByRole("button", { name: /^Merge Groceries into / });
    expect(before).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("button", { name: "⇄ Swap direction" }));

    await within(dialog).findByRole("button", { name: /into Groceries$/ });
    expect(within(dialog).queryByRole("button", { name: /^Merge Groceries into / })).toBeNull();
  });

  it("refuses a merge the backend would refuse, before the button is pressed", async () => {
    setIpcHandlers({
      list_categories: () => CATS,
      merge_categories: () => null,
      preview_category_merge: () => ({
        ...PREVIEW,
        blocked: "cannot merge: the destination already has subcategories named Fuel.",
      }),
    });
    render(<CategoriesView />);
    await screen.findByText("Groceries");
    const row = screen.getByText("Groceries").closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Merge…" }));
    const dialog = screen.getByRole("dialog", { name: "Merge category" });
    await userEvent.selectOptions(within(dialog).getByLabelText("Merge into"), "e-1");

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent(/subcategories named Fuel/);
    // It says plainly that this cannot be done, and says what to do
    // instead, rather than leaving a grayed button as the only signal.
    expect(alert).toHaveTextContent(/This merge cannot be done/);
    expect(alert).toHaveTextContent(/Swap direction/);
    // And the Merge button is GONE rather than disabled: a disabled button
    // invites a press, and a press that does nothing reads as a broken app.
    expect(within(dialog).queryByRole("button", { name: /^Merge Groceries into / })).toBeNull();
    expect(invokeCalls.find((c) => c.cmd === "merge_categories")).toBeUndefined();
  });

  it("warns when both sides are budgeted for the same month", async () => {
    setIpcHandlers({
      list_categories: () => CATS,
      merge_categories: () => null,
      preview_category_merge: () => ({ ...PREVIEW, budgets: 3, budgetsFolded: 2 }),
    });
    render(<CategoriesView />);
    await screen.findByText("Groceries");
    const row = screen.getByText("Groceries").closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Merge…" }));
    const dialog = screen.getByRole("dialog", { name: "Merge category" });
    await userEvent.selectOptions(within(dialog).getByLabelText("Merge into"), "e-1");

    expect(
      await within(dialog).findByText(/2 months are budgeted on both sides/)
    ).toBeInTheDocument();
  });

  it("offers the standard set prominently when there are no categories", async () => {
    setIpcHandlers({ list_categories: () => [] });
    render(<CategoriesView />);
    const btn = await screen.findByRole("button", { name: "Add standard categories" });
    // The default (primary) styling is the empty-state affordance.
    expect(btn).toHaveClass("default");
    expect(screen.getByText(/You have no categories yet/)).toBeInTheDocument();
  });

  it("keeps the standard-set button available once categories exist", async () => {
    render(<CategoriesView />);
    await screen.findByText("Groceries");
    const btn = screen.getByRole("button", { name: "Add standard categories" });
    expect(btn).not.toHaveClass("default");
    expect(screen.getByText(/Never changes or removes/)).toBeInTheDocument();
  });

  it("reports how many standard categories were added", async () => {
    setIpcHandlers({ list_categories: () => CATS, seed_standard_categories: () => 96 });
    render(<CategoriesView />);
    await screen.findByText("Groceries");
    await userEvent.click(screen.getByRole("button", { name: "Add standard categories" }));
    expect(await screen.findByText("Added 96 standard categories.")).toBeInTheDocument();
  });

  it("says so plainly when nothing was missing", async () => {
    setIpcHandlers({ list_categories: () => CATS, seed_standard_categories: () => 0 });
    render(<CategoriesView />);
    await screen.findByText("Groceries");
    await userEvent.click(screen.getByRole("button", { name: "Add standard categories" }));
    expect(await screen.findByText(/already have the whole standard set/)).toBeInTheDocument();
  });

  // The user's case: "House : Repairs & Maintenance" alongside
  // "Automobile : Repairs & Maintenance". Migration 0015 made names unique per
  // parent rather than globally; this proves the UI path allows it too.
  it("allows the same subcategory name under a different parent", async () => {
    const withAuto: Category[] = [
      ...CATS,
      cat({ id: "e-4", name: "Repairs & Maintenance", parent_id: "e-1",
            full_name: "Automobile : Repairs & Maintenance" }),
      cat({ id: "e-5", name: "House" }),
    ];
    const created = vi.fn(() =>
      cat({ id: "e-6", name: "Repairs & Maintenance", parent_id: "e-5",
            full_name: "House : Repairs & Maintenance" })
    );
    setIpcHandlers({ list_categories: () => withAuto, create_category: created });
    render(<CategoriesView />);
    await screen.findByText("House");

    await userEvent.type(screen.getByLabelText("Category name"), "Repairs & Maintenance");
    await userEvent.selectOptions(screen.getByLabelText("Parent category"), "e-5");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    const call = await waitFor(() => invokeCalls.find((c) => c.cmd === "create_category")!);
    expect(call.args).toMatchObject({ name: "Repairs & Maintenance", parentId: "e-5" });
    expect(screen.queryByText(/already exists/)).not.toBeInTheDocument();
  });

  it("surfaces a backend refusal instead of pretending it worked", async () => {
    setIpcHandlers({
      list_categories: () => CATS,
      create_category: () => {
        throw new Error("a category named 'Groceries' already exists");
      },
    });
    render(<CategoriesView />);
    await screen.findByText("Groceries");
    await userEvent.type(screen.getByLabelText("Category name"), "Groceries");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText(/already exists/)).toBeInTheDocument();
  });
});

describe("movesList", () => {
  it("leaves out everything that is zero", () => {
    expect(movesList({ ...PREVIEW, transactions: 214 })).toEqual(["214 transactions"]);
  });

  it("says one thing singular", () => {
    expect(movesList({ ...PREVIEW, payeeRules: 1, budgets: 1 })).toEqual([
      "1 budgeted month",
      "1 payee rule",
    ]);
  });

  it("is empty when the category has nothing filed under it", () => {
    expect(movesList(PREVIEW)).toEqual([]);
  });
});

describe("Staying where you were working", () => {
  // > "once I made the change it pops back to the top of the categories and
  // >  when I undid it it brought the category back as it should but was at
  // >  the top and I had to scroll to see it again."
  it("gives every row an anchor the view can scroll back to", async () => {
    const { container } = render(<CategoriesView />);
    await waitFor(() =>
      expect(container.querySelectorAll("[data-category-row]").length).toBeGreaterThan(0)
    );
    // Every drawn row carries its id, so revealCategory can find the one the
    // merge just changed instead of leaving the user at the top of the list.
    const ids = [...container.querySelectorAll("[data-category-row]")].map((el) =>
      el.getAttribute("data-category-row")
    );
    expect(ids.every((id) => !!id)).toBe(true);
    expect(ids).toContain("e-1");
  });
});

// G5: "Delete refused but there was no message, it just acted like I
// didn't press the button". The error went to the form behind the backdrop.
describe("A refused delete or merge is answered in its dialog", () => {
  it("shows the delete refusal in red inside the dialog, which stays open", async () => {
    setIpcHandlers({
      list_categories: () => CATS,
      delete_category: () => {
        throw "Salary is an income category and Groceries is an expense category — its transactions cannot be refiled there";
      },
    });
    render(<CategoriesView />);
    await screen.findByText("Salary");
    const row = screen.getByText("Salary").closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Delete…" }));
    const dialog = screen.getByRole("dialog", { name: "Delete category" });
    await userEvent.selectOptions(within(dialog).getByLabelText("Reassign transactions to"), "e-3");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("cannot be refiled there");
    expect(alert).toHaveClass("tm-notice-error");
    expect(screen.getByRole("dialog", { name: "Delete category" })).toBeInTheDocument();
    // Said once, where the button was — not again behind the backdrop.
    expect(screen.getAllByText(/cannot be refiled there/)).toHaveLength(1);

    // Choosing another target is a new question; the old answer goes.
    await userEvent.selectOptions(within(dialog).getByLabelText("Reassign transactions to"), "");
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a merge that fails at the backend inside the merge dialog", async () => {
    setIpcHandlers({
      list_categories: () => CATS,
      preview_category_merge: () => PREVIEW,
      merge_categories: () => {
        throw "the file is locked";
      },
    });
    render(<CategoriesView />);
    await screen.findByText("Groceries");
    const row = screen.getByText("Groceries").closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Merge…" }));
    const dialog = screen.getByRole("dialog", { name: "Merge category" });
    await userEvent.selectOptions(within(dialog).getByLabelText("Merge into"), "e-1");
    await userEvent.click(await within(dialog).findByRole("button", { name: /^Merge Groceries into / }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("the file is locked");
  });
});

// After a merge the form holds the survivor, and success lines stay.
describe("The form after a merge, a create or a delete", () => {
  it("loads the surviving category into the form, so Save cannot rename it to another category's name", async () => {
    let cats = CATS;
    setIpcHandlers({
      list_categories: () => cats,
      merge_categories: () => {
        cats = CATS.filter((c) => c.id !== "e-3");
        return null;
      },
      preview_category_merge: () => PREVIEW,
      update_category: (args) => cat({ id: String(args.id), name: String(args.name) }),
    });
    render(<CategoriesView />);
    await screen.findByText("Salary");
    // Something else is being edited when the merge happens.
    await userEvent.click(screen.getByText("Salary"));
    expect(screen.getByLabelText("Category name")).toHaveValue("Salary");

    const row = screen.getByText("Groceries").closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Merge…" }));
    const dialog = screen.getByRole("dialog", { name: "Merge category" });
    await userEvent.selectOptions(within(dialog).getByLabelText("Merge into"), "e-1");
    await userEvent.click(await within(dialog).findByRole("button", { name: /^Merge Groceries into / }));

    await waitFor(() => expect(screen.getByLabelText("Category name")).toHaveValue("Automobile"));
    expect(screen.getByText("Categories merged.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    const call = await waitFor(() => invokeCalls.find((c) => c.cmd === "update_category")!);
    expect(call.args).toMatchObject({ id: "e-1", name: "Automobile" });
  });

  it("keeps \"Category created.\" on screen after the form empties", async () => {
    setIpcHandlers({
      list_categories: () => CATS,
      create_category: () => cat({ id: "e-9", name: "Pets" }),
    });
    render(<CategoriesView />);
    await screen.findByText("Salary");
    await userEvent.type(screen.getByLabelText("Category name"), "Pets");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText("Category created.")).toBeInTheDocument();
    expect(screen.getByLabelText("Category name")).toHaveValue("");
  });
});
