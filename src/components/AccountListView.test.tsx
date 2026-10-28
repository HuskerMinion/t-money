// @vitest-environment jsdom
// The account list: each balance in its own currency, equity in the home currency.
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

import AccountListView from "./AccountListView";
import { resetIpc, setIpcHandlers } from "../test/tauriMock";
import type { Account } from "../lib/types";
import { useFileFormat } from "../lib/region";

function acct(id: string, name: string, type: Account["type"], balance_cents: number, over: Partial<Account> = {}): Account {
  return {
    id, name, type, balance_cents, holdings_value_cents: 0, tax_included: true,
    is_favorite: false, is_closed: false, updated_at: "", institution: null, account_number: null,
    routing_number: null, opened_on: null, credit_limit_cents: null, contact_phone: null,
    contact_email: null, website: null, address: null, account_notes: null, ...over,
  };
}

const noop = () => {};

beforeEach(() => {
  resetIpc();
  // What is owed comes from the backend in the home currency.
  setIpcHandlers({ debts_by_asset: () => ({ "a-flat": 10_000_000 }) });
});

describe("the account list", () => {
  it("shows a euro account's balance in euros", async () => {
    render(
      <AccountListView
        accounts={[acct("a-eur", "Euro checking", "checking", 123_456, { currency: "EUR", home_rate_micro: 1_100_000 })]}
        onOpen={noop} onAddAccount={noop} onEditDetails={noop} onDeleteAccount={noop} onMergeAccount={noop}
      />
    );
    await act(async () => {}); // the owed amounts arrive
    expect(screen.getByRole("button", { name: "Euro checking" }).closest("tr")).toHaveTextContent("€1,234.56");
  });

  it("works out a foreign house's equity in the home currency and says so", async () => {
    render(
      <AccountListView
        accounts={[acct("a-flat", "Flat", "home", 30_000_000, { currency: "EUR", home_rate_micro: 1_100_000 })]}
        onOpen={noop} onAddAccount={noop} onEditDetails={noop} onDeleteAccount={noop} onMergeAccount={noop}
      />
    );
    // €300,000 at 1.10 is $330,000; less $100,000 owed.
    expect(await screen.findByText(/equity/)).toHaveTextContent("less $100,000.00 owed = $230,000.00 equity in US dollars");
    expect(screen.getByRole("button", { name: "Flat" }).closest("tr")).toHaveTextContent("€300,000.00");
  });
});

describe("the account row context menu", () => {
  function setup(over: Partial<Account> = {}) {
    const fns = { onOpen: vi.fn(), onEditDetails: vi.fn(), onDeleteAccount: vi.fn(), onMergeAccount: vi.fn(), onToggleFavorite: vi.fn() };
    render(<AccountListView accounts={[acct("a-1", "Checking", "checking", 1000, over)]} onAddAccount={noop} {...fns} />);
    const row = screen.getByRole("button", { name: "Checking" }).closest("tr")!;
    expect(row).toHaveAttribute("tabindex", "0");
    fireEvent.contextMenu(row);
    return fns;
  }

  it("offers the account's actions in order", async () => {
    setup();
    await act(async () => {});
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Open register", "Account details…", "Add to favorites", "Merge…", "Delete account…",
    ]);
  });

  it.each([
    ["Open register", "onOpen"],
    ["Account details…", "onEditDetails"],
    ["Add to favorites", "onToggleFavorite"],
    ["Merge…", "onMergeAccount"],
    ["Delete account…", "onDeleteAccount"],
  ] as const)("%s calls the right handler with the account", async (label, fn) => {
    const fns = setup();
    await userEvent.click(screen.getByRole("menuitem", { name: label }));
    expect(fns[fn]).toHaveBeenCalledWith("a-1");
  });

  it("offers to remove a favorite", () => {
    setup({ is_favorite: true });
    expect(screen.getByRole("menuitem", { name: "Remove from favorites" })).toBeTruthy();
  });
});

describe("a file in euros, written the German way", () => {
  it("writes a dollar house as US$ and its equity in euros", async () => {
    useFileFormat.getState().setFormat({ home_currency: "EUR", region: "de-DE" });
    render(
      <AccountListView
        accounts={[acct("a-flat", "House", "home", 30_000_000, { currency: "USD", home_rate_micro: 900_000 })]}
        onOpen={noop} onAddAccount={noop} onEditDetails={noop} onDeleteAccount={noop} onMergeAccount={noop}
      />
    );
    // US$300.000 at 0,90 is 270.000 €; less 100.000 € owed.
    expect(await screen.findByText(/equity/)).toHaveTextContent("less 100.000,00 € owed = 170.000,00 € equity in euros");
    expect(screen.getByRole("button", { name: "House" }).closest("tr")).toHaveTextContent("300.000,00 US$");
  });
});
