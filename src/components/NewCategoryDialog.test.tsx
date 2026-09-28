// The mid-entry "add a category" wizard (§18).
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import NewCategoryDialog from "./NewCategoryDialog";
import type { Category } from "../lib/types";

function cat(over: Partial<Category> & { id: string; name: string }): Category {
  return {
    parent_id: null, kind: "expense", tax_line: null,
    full_name: over.name, usage_count: 0, ...over,
  };
}
const CATS: Category[] = [
  cat({ id: "e-1", name: "Automobile" }),
  cat({ id: "i-1", name: "Wages & Salary", kind: "income" }),
  cat({ id: "e-2", name: "Fuel", parent_id: "e-1", full_name: "Automobile : Fuel" }),
];

function setup(initialName = "House") {
  const onCreate = vi.fn();
  render(
    <NewCategoryDialog
      initialName={initialName}
      categories={CATS}
      onCancel={vi.fn()}
      onCreate={onCreate}
    />
  );
  return { onCreate };
}

describe("NewCategoryDialog", () => {
  it("prefills the name from what was typed", () => {
    setup("Household");
    expect((screen.getByLabelText("New category name") as HTMLInputElement).value).toBe(
      "Household"
    );
  });

  it("splits 'Parent : Child' typing into the two fields", () => {
    setup("House : Repairs & Maintenance");
    expect((screen.getByLabelText("New category name") as HTMLInputElement).value).toBe("House");
    expect((screen.getByLabelText("Subcategory name") as HTMLInputElement).value).toBe(
      "Repairs & Maintenance"
    );
  });

  it("opens in subcategory mode when the parent half already exists", async () => {
    const { onCreate } = setup("automobile : Tires");
    expect(screen.getByLabelText("Subcategory of an existing category")).toBeChecked();
    expect((screen.getByLabelText("Parent category") as HTMLSelectElement).value).toBe("e-1");
    expect((screen.getByLabelText("New category name") as HTMLInputElement).value).toBe("Tires");
    expect(screen.getByText(/Will be created as/)).toHaveTextContent("Automobile : Tires");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onCreate).toHaveBeenCalledWith({ name: "Tires", kind: "expense", parentId: "e-1", childName: null });
  });

  it("carries the typed halves across when the placement is switched by hand", async () => {
    setup("House : Repairs");
    // House is not a category yet, so it opens as a new top level with a subcategory…
    expect(screen.getByLabelText("New top-level category")).toBeChecked();
    // …and switching to "subcategory of an existing category" keeps "Repairs" as the name.
    await userEvent.click(screen.getByLabelText("Subcategory of an existing category"));
    expect((screen.getByLabelText("New category name") as HTMLInputElement).value).toBe("Repairs");
    expect((screen.getByLabelText("Parent category") as HTMLSelectElement).value).toBe("");
    await userEvent.click(screen.getByLabelText("New top-level category"));
    expect((screen.getByLabelText("New category name") as HTMLInputElement).value).toBe("Repairs");
    // Back from a chosen parent restores parent : child.
    await userEvent.click(screen.getByLabelText("Subcategory of an existing category"));
    await userEvent.selectOptions(screen.getByLabelText("Parent category"), "e-1");
    await userEvent.click(screen.getByLabelText("New top-level category"));
    expect((screen.getByLabelText("New category name") as HTMLInputElement).value).toBe("Automobile");
    expect((screen.getByLabelText("Subcategory name") as HTMLInputElement).value).toBe("Repairs");
  });

  it("creates a top-level category on its own", async () => {
    const { onCreate } = setup("House");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onCreate).toHaveBeenCalledWith({
      name: "House", kind: "expense", parentId: null, childName: null,
    });
  });

  it("creates a top-level category together with a subcategory", async () => {
    const { onCreate } = setup("House");
    await userEvent.type(screen.getByLabelText("Subcategory name"), "Repairs & Maintenance");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onCreate).toHaveBeenCalledWith({
      name: "House", kind: "expense", parentId: null, childName: "Repairs & Maintenance",
    });
  });

  it("adds a subcategory to an existing parent", async () => {
    const { onCreate } = setup("Repairs & Maintenance");
    await userEvent.click(screen.getByLabelText("Subcategory of an existing category"));
    await userEvent.selectOptions(screen.getByLabelText("Parent category"), "e-1");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onCreate).toHaveBeenCalledWith({
      name: "Repairs & Maintenance", kind: "expense", parentId: "e-1", childName: null,
    });
  });

  it("takes the kind from the chosen parent", async () => {
    const { onCreate } = setup("Bonus");
    await userEvent.click(screen.getByLabelText("Subcategory of an existing category"));
    await userEvent.selectOptions(screen.getByLabelText("Parent category"), "i-1");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "income", parentId: "i-1" })
    );
  });

  it("will not submit a subcategory with no parent chosen", async () => {
    setup("Repairs");
    await userEvent.click(screen.getByLabelText("Subcategory of an existing category"));
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });

  it("will not submit an empty name", async () => {
    setup("House");
    await userEvent.clear(screen.getByLabelText("New category name"));
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });

  it("shows a backend refusal verbatim", () => {
    render(
      <NewCategoryDialog
        initialName="Fuel"
        categories={CATS}
        error="a category named 'Fuel' already exists"
        onCancel={vi.fn()}
        onCreate={vi.fn()}
      />
    );
    expect(screen.getByText(/already exists/)).toBeInTheDocument();
  });
});
