// Organize favorites is also where the accounts are put in order: ▲
// and ▼ move a row and hand back the whole arrangement, which every list of
// accounts then follows. `placedFirst` is what those lists sort with.
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import OrganizeFavoritesDialog, { moved } from "./OrganizeFavoritesDialog";
import { placedFirst } from "../lib/accountTypes";
import type { Account } from "../lib/types";

const base: Account = {
  id: "",
  name: "",
  type: "checking",
  balance_cents: 0,
  holdings_value_cents: 0,
  tax_included: true,
  is_favorite: false,
  is_closed: false,
  updated_at: "2026-09-13T00:00:00Z",
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
};
const accounts: Account[] = [
  { ...base, id: "a", name: "Checking", is_favorite: true, sort_order: 0 },
  { ...base, id: "b", name: "Savings", sort_order: 1 },
  { ...base, id: "c", name: "Visa", type: "credit", sort_order: 2 },
  { ...base, id: "z", name: "Old CD", is_closed: true },
];

describe("moved", () => {
  it("moves one id and leaves the rest in order", () => {
    expect(moved(["a", "b", "c"], 1, 0)).toEqual(["b", "a", "c"]);
    expect(moved(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
  });
  it("ignores a move off either end", () => {
    expect(moved(["a", "b"], 0, -1)).toEqual(["a", "b"]);
    expect(moved(["a", "b"], 1, 2)).toEqual(["a", "b"]);
  });
});

describe("placedFirst", () => {
  it("puts placed accounts first in their order and leaves the unplaced to the caller", () => {
    const rows = [{ sort_order: null }, { sort_order: 2 }, { sort_order: 0 }, {}];
    const sorted = [...rows].sort(placedFirst);
    expect(sorted.map((r) => r.sort_order ?? null)).toEqual([0, 2, null, null]);
    expect(placedFirst({}, { sort_order: null })).toBe(0);
  });
});

describe("OrganizeFavoritesDialog", () => {
  it("moves a row down and hands back the whole order, closed accounts last", async () => {
    const onReorder = vi.fn();
    render(<OrganizeFavoritesDialog accounts={accounts} onToggle={vi.fn()} onReorder={onReorder} onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Move Checking up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move Visa down" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Move Old CD/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Move Checking down" }));
    expect(onReorder).toHaveBeenCalledWith(["b", "a", "c", "z"]);
    await userEvent.click(screen.getByRole("button", { name: "Move Visa up" }));
    expect(onReorder).toHaveBeenLastCalledWith(["a", "c", "b", "z"]);
  });

  it("offers no arrows without a handler, and still stars", async () => {
    const onToggle = vi.fn();
    render(<OrganizeFavoritesDialog accounts={accounts} onToggle={onToggle} onClose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /^Move / })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "Savings is a favorite" }));
    expect(onToggle).toHaveBeenCalledWith("b");
  });
});

// No catch, and ▼ could double-send while the first order was written.
describe("A refused write is shown, and the arrows wait for the first one", () => {
  it("disables the arrows while the order is being saved, and shows a refusal in the dialog", async () => {
    let fail!: (e: unknown) => void;
    const onReorder = vi.fn(() => new Promise<void>((_ok, bad) => (fail = bad)));
    render(<OrganizeFavoritesDialog accounts={accounts} onToggle={vi.fn()} onReorder={onReorder} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Move Checking down" }));
    expect(screen.getByRole("button", { name: "Move Checking down" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Move Checking down" }));
    expect(onReorder).toHaveBeenCalledTimes(1);

    await act(async () => fail("the file is read-only"));
    expect(await screen.findByRole("alert")).toHaveTextContent("the file is read-only");
    expect(screen.getByRole("button", { name: "Move Checking down" })).toBeEnabled();
  });

  it("a refused star is shown too", async () => {
    const onToggle = vi.fn(() => Promise.reject("no such account"));
    render(<OrganizeFavoritesDialog accounts={accounts} onToggle={onToggle} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("checkbox", { name: "Savings is a favorite" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("no such account");
  });
});
