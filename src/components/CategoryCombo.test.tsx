// The type-ahead category field (§17). A native <select> only jumps by first
// letter, which is useless when every entry reads "Automobile : Fuel".
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import CategoryCombo, { filterItems, type ComboItem } from "./CategoryCombo";

const ITEMS: ComboItem[] = [
  { value: "i-1", label: "Salary", group: "Income" },
  { value: "e-1", label: "Groceries", group: "Expense" },
  { value: "e-2", label: "Automobile : Fuel", group: "Expense" },
  { value: "e-3", label: "Automobile : Insurance", group: "Expense" },
  { value: "t-1", label: "Transfer : Savings", group: "Transfer" },
];

describe("filterItems", () => {
  it("matches any part of the name, not just the start", () => {
    expect(filterItems(ITEMS, "fuel").map((i) => i.value)).toEqual(["e-2"]);
  });

  it("is case-insensitive and matches the parent too", () => {
    expect(filterItems(ITEMS, "AUTO").map((i) => i.value)).toEqual(["e-2", "e-3"]);
  });

  it("returns everything for an empty query", () => {
    expect(filterItems(ITEMS, "   ")).toHaveLength(ITEMS.length);
  });

  // §162 — "Loan : HELOC" is the standard spelling, and a field should
  // recognize the same name however the colon was typed around.
  it("recognizes a name typed without the spaces around the colon", () => {
    expect(filterItems(ITEMS, "Automobile:Fuel").map((i) => i.value)).toEqual(["e-2"]);
    expect(filterItems(ITEMS, "automobile :fuel").map((i) => i.value)).toEqual(["e-2"]);
    expect(filterItems(ITEMS, "Automobile  : Fuel").map((i) => i.value)).toEqual(["e-2"]);
  });

  it("puts the name that is exactly what was typed first", () => {
    const items: ComboItem[] = [
      { value: "e-9", label: "Loan : HELOC Interest", group: "Expense" },
      { value: "e-8", label: "Loan : HELOC", group: "Expense" },
    ];
    expect(filterItems(items, "loan:heloc").map((i) => i.value)).toEqual(["e-8", "e-9"]);
  });

  it("does not offer to add a category that exists under another spelling", async () => {
    const onAddNew = vi.fn();
    const onChange = vi.fn();
    render(<CategoryCombo items={ITEMS} value="" onChange={onChange} label="Category" onAddNew={onAddNew} />);
    const input = screen.getByRole("combobox", { name: "Category" });
    await userEvent.click(input);
    await userEvent.type(input, "automobile:fuel");
    const list = screen.getByRole("listbox");
    expect(within(list).queryByText(/^\+ Add/)).not.toBeInTheDocument();
    // Tab takes the existing one, not a new one.
    await userEvent.tab();
    expect(onChange).toHaveBeenCalledWith("e-2");
    expect(onAddNew).not.toHaveBeenCalled();
  });

  it("categoryKey folds case, colon spacing and runs of spaces", async () => {
    const { categoryKey } = await import("./CategoryCombo");
    expect(categoryKey("Loan:HELOC")).toBe("loan : heloc");
    expect(categoryKey("  loan  :  HELOC  ")).toBe("loan : heloc");
    expect(categoryKey("Home   Repair")).toBe("home repair");
    expect(categoryKey("Loan : HELOC")).toBe(categoryKey("loan:heloc"));
  });
});

describe("CategoryCombo", () => {
  function setup(value = "") {
    const onChange = vi.fn();
    render(
      <CategoryCombo items={ITEMS} value={value} onChange={onChange} label="Category" />
    );
    return { onChange, input: screen.getByRole("combobox", { name: "Category" }) };
  }

  it("shows the selected category when closed", () => {
    setup("e-2");
    expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe(
      "Automobile : Fuel"
    );
  });

  it("narrows the list as you type", async () => {
    const { input } = setup();
    await userEvent.click(input);
    await userEvent.type(input, "insur");
    const list = screen.getByRole("listbox");
    expect(within(list).getByRole("option", { name: "Automobile : Insurance" })).toBeInTheDocument();
    expect(within(list).queryByRole("option", { name: "Groceries" })).not.toBeInTheDocument();
  });

  it("reports the id of the item that was picked", async () => {
    const { onChange, input } = setup();
    await userEvent.click(input);
    await userEvent.type(input, "grocer");
    await userEvent.click(screen.getByRole("option", { name: "Groceries" }));
    expect(onChange).toHaveBeenCalledWith("e-1");
  });

  it("picks the highlighted match on Enter", async () => {
    const { onChange, input } = setup();
    await userEvent.click(input);
    await userEvent.type(input, "fuel");
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("e-2");
  });

  it("moves the highlight with the arrow keys", async () => {
    const { onChange, input } = setup();
    await userEvent.click(input);
    await userEvent.type(input, "auto");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledWith("e-3");
  });

  it("groups Income, Expense and Transfer", async () => {
    const { input } = setup();
    await userEvent.click(input);
    expect(screen.getByText("Income")).toBeInTheDocument();
    expect(screen.getByText("Expense")).toBeInTheDocument();
    expect(screen.getByText("Transfer")).toBeInTheDocument();
  });

  it("offers an explicit (none), so a category can be cleared", async () => {
    const { onChange, input } = setup("e-1");
    await userEvent.click(input);
    await userEvent.click(screen.getByRole("option", { name: "(none)" }));
    expect(onChange).toHaveBeenCalledWith("");
  });

  // Regression: choosing an option calls preventDefault on mousedown to keep
  // focus in the input, so the next click fires no focus event. The list used
  // to stay shut until you clicked away and back — reported as
  // "if I remove the set category when I edit the whole list disappears".
  it("reopens on a second click after something was picked", async () => {
    const { input } = setup("e-1");
    await userEvent.click(input);
    expect(screen.queryByRole("listbox")).not.toBeNull();
    await userEvent.click(screen.getByRole("option", { name: "(none)" }));
    expect(screen.queryByRole("listbox")).toBeNull();
    await userEvent.click(input);
    expect(screen.queryByRole("listbox")).not.toBeNull();
  });

  it("keeps the list visible while you type", async () => {
    const { input } = setup("e-1");
    await userEvent.click(input);
    await userEvent.click(screen.getByRole("option", { name: "(none)" }));
    await userEvent.type(input, "gro");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Groceries" })).toBeInTheDocument();
  });

  // The list is portaled to <body>. The register lives inside an
  // `overflow-auto` wrapper, and an absolutely positioned list was CLIPPED by
  // it: a short filtered list fitted and appeared, the full one did not —
  // which is exactly how the user described it ("I can type something in and
  // if it exists it shows up"). jsdom has no layout, so it could never have
  // caught the clipping; what it CAN pin down is that the list is no longer a
  // descendant of the field, which is what makes clipping impossible.
  it("renders the list outside the field's own subtree", async () => {
    const { input } = setup();
    await userEvent.click(input);
    const list = screen.getByRole("listbox");
    const field = input.closest("div")!;
    expect(field.contains(list)).toBe(false);
    expect(document.body.contains(list)).toBe(true);
  });

  it("shows every item when opened by click, not just filtered ones", async () => {
    const { input } = setup();
    await userEvent.click(input);
    const list = screen.getByRole("listbox");
    for (const item of ITEMS) {
      expect(within(list).getByRole("option", { name: item.label })).toBeInTheDocument();
    }
  });

  it("clicking an option in the portal still selects it", async () => {
    // The outside-click handler has to know about the portaled list, or it
    // would close before the click landed.
    const { onChange, input } = setup();
    await userEvent.click(input);
    await userEvent.click(screen.getByRole("option", { name: "Automobile : Fuel" }));
    expect(onChange).toHaveBeenCalledWith("e-2");
  });

  it("says so when nothing matches, rather than showing an empty box", async () => {
    const { input } = setup();
    await userEvent.click(input);
    await userEvent.type(input, "zzzz");
    expect(screen.getByText("No match")).toBeInTheDocument();
  });

  // §183 — Enter chose "(none)" when nothing matched, wiping the category
  // the row had; Tab has always left it alone.
  it("Enter with nothing matching leaves the category alone", async () => {
    const { onChange, input } = setup("e-1");
    await userEvent.click(input);
    await userEvent.type(input, "zzzz{Enter}");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText("No match")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect((input as HTMLInputElement).value).toBe("Groceries");
  });

  it("Enter with nothing matching offers to add it, when adding is on offer", async () => {
    const onAddNew = vi.fn();
    const onChange = vi.fn();
    render(<CategoryCombo items={ITEMS} value="e-1" onChange={onChange} label="Category" onAddNew={onAddNew} />);
    const input = screen.getByRole("combobox", { name: "Category" });
    await userEvent.click(input);
    await userEvent.type(input, "Pets{Enter}");
    expect(onAddNew).toHaveBeenCalledWith("Pets");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Enter with nothing matching does not reach the row behind it", async () => {
    const onRowKey = vi.fn();
    render(
      <div onKeyDown={onRowKey}>
        <CategoryCombo items={ITEMS} value="e-1" onChange={() => {}} label="Category" />
      </div>
    );
    const input = screen.getByRole("combobox", { name: "Category" });
    await userEvent.click(input);
    await userEvent.type(input, "zzzz");
    onRowKey.mockClear();
    await userEvent.keyboard("{Enter}");
    expect(onRowKey).not.toHaveBeenCalled();
  });

  it("Escape closes without choosing and restores the shown value", async () => {
    const { onChange, input } = setup("e-1");
    await userEvent.click(input);
    await userEvent.type(input, "auto");
    await userEvent.keyboard("{Escape}");
    expect(onChange).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe("Groceries");
  });

  it("tabbing through the field leaves its value alone", async () => {
    // Focus opens the list with the FULL set; Tab used to commit item 0
    // ("Salary"), so passing through Category re-filed the transaction.
    const { onChange, input } = setup("e-2");
    await userEvent.tab(); // focus lands on the combobox
    expect(document.activeElement).toBe(input);
    await userEvent.tab(); // and straight on
    expect(onChange).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe("Automobile : Fuel");
  });

  it("Tab still commits a typed match", async () => {
    const { onChange, input } = setup("e-2");
    await userEvent.click(input);
    await userEvent.type(input, "grocer");
    await userEvent.tab();
    expect(onChange).toHaveBeenCalledWith("e-1");
  });

  it("opens with the current choice highlighted, so Enter keeps it", async () => {
    const { onChange, input } = setup("e-3");
    await userEvent.click(input);
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("e-3");
  });

  it("scrolls the list to the category the row already has (§117.2)", async () => {
    // Reported: with a full chart of accounts, clicking a row filed under
    // "Loan : HELOC Interest" opened the list at the top — the highlight was
    // right, but it was somewhere off-screen below, which reads as the field
    // having forgotten what it holds.
    const scrolls: { el: unknown; arg: { block?: string } }[] = [];
    const spy = vi.fn(function (this: unknown, arg: { block?: string }) {
      scrolls.push({ el: this, arg });
    });
    // jsdom has no scrollIntoView at all; give it one for the length of the
    // test, which is also what proves the component calls it.
    (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = spy;
    try {
      const { input } = setup("e-2");
      await userEvent.click(input);
      const options = await screen.findAllByRole("option");
      const fuel = options.find((o) => o.textContent === "Automobile : Fuel")!;
      expect(fuel).toHaveClass("active");
      // …and THAT element is the one that was scrolled to.
      expect(scrolls.some((s) => s.el === fuel)).toBe(true);
      expect(scrolls.every((s) => s.arg.block === "nearest")).toBe(true);
    } finally {
      delete (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });
});
