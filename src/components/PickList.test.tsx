// §118 — the checkbox list that replaced the Ctrl-click multi-selects.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import PickList from "./PickList";

const items = [
  { value: "a", label: "Auto: Fuel" },
  { value: "b", label: "Auto: Repairs" },
  { value: "c", label: "Groceries" },
];

function setup(value: string[] = []) {
  const onChange = vi.fn();
  const view = render(<PickList label="Categories" items={items} value={value} onChange={onChange} />);
  return { onChange, view };
}

describe("PickList", () => {
  it("a click ticks one item and leaves the others alone", async () => {
    const { onChange } = setup(["a"]);
    await userEvent.click(screen.getByRole("checkbox", { name: "Groceries" }));
    // The whole point: "a" survives a plain click, which a <select multiple>
    // would have thrown away.
    expect(onChange).toHaveBeenCalledWith(["a", "c"]);
  });

  it("clicking a ticked item unticks it", async () => {
    const { onChange } = setup(["a", "c"]);
    await userEvent.click(screen.getByRole("checkbox", { name: "Auto: Fuel" }));
    expect(onChange).toHaveBeenCalledWith(["c"]);
  });

  it("the order follows the list, not the order of clicking", async () => {
    const { onChange } = setup(["c"]);
    await userEvent.click(screen.getByRole("checkbox", { name: "Auto: Repairs" }));
    expect(onChange).toHaveBeenCalledWith(["b", "c"]);
  });

  it("All ticks everything and None clears it", async () => {
    const { onChange, view } = setup([]);
    await userEvent.click(screen.getByRole("button", { name: "All" }));
    expect(onChange).toHaveBeenLastCalledWith(["a", "b", "c"]);
    view.rerender(<PickList label="Categories" items={items} value={["a", "b", "c"]} onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "None" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("search narrows the list, and All then means all that are shown", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ value: `v${i}`, label: i < 3 ? `Auto ${i}` : `Other ${i}` }));
    const onChange = vi.fn();
    render(<PickList label="Categories" items={many} value={[]} onChange={onChange} />);
    await userEvent.type(screen.getByRole("searchbox", { name: "Search categories" }), "Auto");
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    await userEvent.click(screen.getByRole("button", { name: "All 3 shown" }));
    expect(onChange).toHaveBeenLastCalledWith(["v0", "v1", "v2"]);
  });

  it("says how many are chosen, so a long list needs no scrolling to read", async () => {
    setup(["a", "b"]);
    expect(within(screen.getByRole("group", { name: "Categories" })).getByText("2 chosen")).toBeInTheDocument();
  });

  it("offers no search box for a short list", () => {
    setup();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  });
});
