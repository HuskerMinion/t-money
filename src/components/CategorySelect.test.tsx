// The shared category picker: full names, the income/expense filter that
// drives every picker in Money, and the type-ahead
// behavior it inherits from CategoryCombo.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import CategorySelect, { categoryItems, ofKind } from "./CategorySelect";
import type { Category } from "../lib/types";

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

const categories: Category[] = [
  cat({ id: "i-1", name: "Salary", kind: "income" }),
  cat({ id: "e-1", name: "Groceries" }),
  cat({ id: "e-2", name: "Gasoline", parent_id: "e-9", full_name: "Automobile : Gasoline" }),
];

/** Open the list without choosing and return the category labels it offers.
 *  The list always carries a "(none)" row of its own; these tests are about
 *  which categories are on offer, so it is dropped here. */
async function openedLabels(label = "Category") {
  await userEvent.click(screen.getByLabelText(label));
  const options = await screen.findAllByRole("option");
  return options.map((o) => o.textContent).filter((t) => t !== "(none)");
}

describe("ofKind", () => {
  it("splits the tree by kind", () => {
    expect(ofKind(categories, "income").map((c) => c.id)).toEqual(["i-1"]);
    expect(ofKind(categories, "expense").map((c) => c.id)).toEqual(["e-1", "e-2"]);
  });
});

describe("categoryItems", () => {
  it("uses the full 'Parent : Child' name, not the bare one", () => {
    const labels = categoryItems(categories).map((i) => i.label);
    expect(labels).toContain("Automobile : Gasoline");
    expect(labels).not.toContain("Gasoline");
  });

  it("groups income and expense when no kind is given", () => {
    const items = categoryItems(categories);
    expect(items.find((i) => i.value === "i-1")?.group).toBe("Income");
    expect(items.find((i) => i.value === "e-1")?.group).toBe("Expense");
  });

  it("offers one flat, ungrouped list when the kind is already decided", () => {
    // The spent/received answer has already made the choice, so a heading
    // that can only say one thing is noise.
    const items = categoryItems(categories, "expense");
    expect(items.map((i) => i.value)).toEqual(["e-1", "e-2"]);
    expect(items.every((i) => i.group === undefined)).toBe(true);
  });

  it("offers only income categories when kind=income", () => {
    expect(categoryItems(categories, "income").map((i) => i.value)).toEqual(["i-1"]);
  });
});

describe("<CategorySelect />", () => {
  it("is a text field you can type into, not a native select", () => {
    // A native select only jumps by first letter, which is useless
    // against a list where everything reads "Parent : Child".
    render(
      <CategorySelect categories={categories} value="" onChange={vi.fn()} label="Category" />
    );
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Category")).toHaveProperty("tagName", "INPUT");
  });

  it("filters on any part of the name, not just the first letter", async () => {
    render(
      <CategorySelect categories={categories} value="" onChange={vi.fn()} label="Category" />
    );
    const box = screen.getByLabelText("Category");
    await userEvent.click(box);
    await userEvent.type(box, "gas");
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent).filter((t) => t !== "(none)")).toEqual([
      "Automobile : Gasoline",
    ]);
  });

  it("reports the chosen id, not the event", async () => {
    const onChange = vi.fn();
    render(
      <CategorySelect categories={categories} value="" onChange={onChange} label="Category" />
    );
    await openedLabels();
    await userEvent.click(screen.getByRole("option", { name: "Groceries" }));
    expect(onChange).toHaveBeenCalledWith("e-1");
  });

  it("shows the chosen category's full name", () => {
    render(
      <CategorySelect categories={categories} value="e-2" onChange={vi.fn()} label="Category" />
    );
    expect(screen.getByLabelText("Category")).toHaveValue("Automobile : Gasoline");
  });

  it("hides income categories when kind=expense", async () => {
    render(
      <CategorySelect
        categories={categories}
        value=""
        onChange={vi.fn()}
        kind="expense"
        label="Category"
      />
    );
    const labels = await openedLabels();
    expect(labels).toContain("Groceries");
    expect(labels).not.toContain("Salary");
  });

  it("offers + Add only when a handler is given", async () => {
    const onAddNew = vi.fn();
    const { unmount } = render(
      <CategorySelect
        categories={categories}
        value=""
        onChange={vi.fn()}
        label="Category"
        onAddNew={onAddNew}
      />
    );
    const box = screen.getByLabelText("Category");
    await userEvent.click(box);
    await userEvent.type(box, "Daycare");
    expect(await screen.findByText(/Add "Daycare"/)).toBeInTheDocument();
    unmount();

    render(
      <CategorySelect categories={categories} value="" onChange={vi.fn()} label="Category" />
    );
    const plain = screen.getByLabelText("Category");
    await userEvent.click(plain);
    await userEvent.type(plain, "Daycare");
    expect(screen.queryByText(/Add "Daycare"/)).not.toBeInTheDocument();
  });
});
