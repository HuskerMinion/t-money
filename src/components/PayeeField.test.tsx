// The Payee field completes from history and Tab / Enter take the match.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import PayeeField, { suggestPayees } from "./PayeeField";
import type { Payee } from "../lib/types";

const mk = (id: string, name: string, usage_count: number, cat: string | null = null): Payee => ({
  id, name, usage_count, last_category_id: cat ? "c" : null, last_category_name: cat, updated_at: "", last_amount_cents: null,
});
const payees = [mk("1", "Netflix", 12, "Entertainment"), mk("2", "Net Ten Wireless", 3), mk("3", "Internet - Comcast", 30), mk("4", "Fresh Market", 40)];

describe("suggestPayees", () => {
  it("ranks starts-with over contains, most used first, and offers nothing for nothing", () => {
    expect(suggestPayees(payees, "net").map((p) => p.name)).toEqual(["Netflix", "Net Ten Wireless", "Internet - Comcast"]);
    expect(suggestPayees(payees, "")).toEqual([]);
    expect(suggestPayees(payees, "zzz")).toEqual([]);
  });
});

describe("PayeeField", () => {
  function setup() {
    let value = "";
    const onChange = vi.fn((v: string) => { value = v; rerender(); });
    const onSettle = vi.fn();
    const ui = () => <PayeeField value={value} onChange={onChange} onSettle={onSettle} payees={payees} />;
    const r = render(<div>{ui()}<input aria-label="Next" /></div>);
    const rerender = () => r.rerender(<div>{ui()}<input aria-label="Next" /></div>);
    return { onChange, onSettle, get value() { return value; } };
  }

  it("Tab takes the highlighted match, settles it, and focus moves on", async () => {
    const s = setup();
    await userEvent.type(screen.getByLabelText("Payee"), "net");
    expect(screen.getByRole("option", { name: /Netflix/ })).toHaveAttribute("aria-selected", "true");
    await userEvent.tab();
    expect(s.value).toBe("Netflix");
    expect(s.onSettle).toHaveBeenLastCalledWith("Netflix");
    expect(screen.getByLabelText("Next")).toHaveFocus();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("arrows pick a different match and Enter takes it without leaving the field", async () => {
    const s = setup();
    const field = screen.getByLabelText("Payee");
    await userEvent.type(field, "net{ArrowDown}{Enter}");
    expect(s.value).toBe("Net Ten Wireless");
    expect(field).toHaveFocus();
  });

  it("a name nobody has used stays as typed; Tab through an empty field leaves it empty", async () => {
    const s = setup();
    await userEvent.type(screen.getByLabelText("Payee"), "Brand New Shop");
    expect(screen.queryByRole("listbox")).toBeNull();
    await userEvent.tab();
    expect(s.value).toBe("Brand New Shop");
    expect(s.onSettle).toHaveBeenLastCalledWith("Brand New Shop");
  });

  it("an exact match alone is not offered (nothing to complete)", async () => {
    setup();
    await userEvent.type(screen.getByLabelText("Payee"), "Fresh Market");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  // `open` is true after any keystroke, list or no list, and Escape
  // was swallowed whenever it was: the row's Esc-to-cancel took two presses.
  it("Escape with no list showing reaches the row on the first press", async () => {
    const onRowKey = vi.fn();
    render(
      <div onKeyDown={(e) => onRowKey(e.key)}>
        <PayeeField value="Brand New Shop" onChange={() => {}} payees={payees} />
      </div>
    );
    const field = screen.getByLabelText("Payee");
    await userEvent.type(field, "x");
    expect(screen.queryByRole("listbox")).toBeNull();
    onRowKey.mockClear();
    await userEvent.keyboard("{Escape}");
    expect(onRowKey).toHaveBeenCalledWith("Escape");
  });

  it("Escape with the list showing closes the list and stops there", async () => {
    const onRowKey = vi.fn();
    let value = "";
    const ui = () => (
      <div onKeyDown={(e) => onRowKey(e.key)}>
        <PayeeField value={value} onChange={(v) => { value = v; r.rerender(ui()); }} payees={payees} />
      </div>
    );
    const r = render(ui());
    await userEvent.type(screen.getByLabelText("Payee"), "net");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    onRowKey.mockClear();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onRowKey).not.toHaveBeenCalled();
  });
});
