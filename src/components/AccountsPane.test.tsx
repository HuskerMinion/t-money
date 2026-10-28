// @vitest-environment jsdom
// The Three-pane account column: rows in their own currency, group totals in the home currency.
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import AccountsPane from "./AccountsPane";
import type { Account } from "../lib/types";
import { useFileFormat } from "../lib/region";
import { registerCommand, resetCommands } from "../lib/commands";

function acct(id: string, name: string, balance_cents: number, over: Partial<Account> = {}): Account {
  return {
    id, name, type: "checking", balance_cents, holdings_value_cents: 0, tax_included: true,
    is_favorite: false, is_closed: false, updated_at: "", institution: null, account_number: null,
    routing_number: null, opened_on: null, credit_limit_cents: null, contact_phone: null,
    contact_email: null, website: null, address: null, account_notes: null, ...over,
  };
}

describe("the accounts pane", () => {
  it("shows a euro account in euros and adds it to the group total in dollars", () => {
    const accounts = [
      acct("a-chk", "Checking", 100_000),
      acct("a-eur", "Euro savings", 50_000, { type: "savings", currency: "EUR", home_rate_micro: 1_100_000 }),
    ];
    render(<AccountsPane accounts={accounts} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: /Euro savings/ })).toHaveTextContent("€500.00");
    // $1,000.00 + €500.00 at 1.10 = $1,550.00.
    const total = screen.getByTitle("In US dollars at today's rates.");
    expect(total).toHaveTextContent("$1,550.00");
  });

  it("leaves a currency with no rate out of the total, and says so", () => {
    const accounts = [
      acct("a-chk", "Checking", 100_000),
      acct("a-gbp", "Pound account", 70_000, { currency: "GBP", home_rate_micro: 0 }),
    ];
    render(<AccountsPane accounts={accounts} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: /Pound account/ })).toHaveTextContent("£700.00");
    const total = screen.getByTitle(/Leaves out Pound account — no rate for GBP/);
    expect(total).toHaveTextContent("$1,000.00*");
  });
});

describe("the account context menu", () => {
  it("opens the register or toggles the favorite", async () => {
    const onSelect = vi.fn();
    const onToggleFavorite = vi.fn();
    render(<AccountsPane accounts={[acct("a-chk", "Checking", 100)]} selectedId={null} onSelect={onSelect} onToggleFavorite={onToggleFavorite} />);
    const row = screen.getByRole("button", { name: /Checking/ });
    fireEvent.contextMenu(row);
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Open register", "Balance this account…", "Add to favorites"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "Open register" }));
    expect(onSelect).toHaveBeenCalledWith("a-chk");
    fireEvent.contextMenu(row);
    await userEvent.click(screen.getByRole("menuitem", { name: "Add to favorites" }));
    expect(onToggleFavorite).toHaveBeenCalledWith("a-chk");
  });
});

describe("the account context menu's register actions", () => {
  beforeEach(() => resetCommands());

  it.each([
    ["checking", ["Balance this account…"], { kind: "reconcile" }],
    ["home", ["Update value…"], { kind: "value" }],
    ["mortgage", ["Balance this account…", "Loan terms…"], { kind: "terms" }],
  ] as const)("a %s account offers %j and sends the action to its register", async (type, labels, action) => {
    const nav = vi.fn();
    const off = registerCommand("nav.account", nav);
    render(<AccountsPane accounts={[acct("a-1", "Thing", 100, { type })]} selectedId={null} onSelect={() => {}} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: /Thing/ }));
    const shown = screen.getAllByRole("menuitem").map((i) => i.textContent);
    for (const l of labels) expect(shown).toContain(l);
    for (const l of ["Balance this account…", "Update value…", "Loan terms…"]) {
      if (!(labels as readonly string[]).includes(l)) expect(shown).not.toContain(l);
    }
    await userEvent.click(screen.getByRole("menuitem", { name: labels[labels.length - 1] }));
    expect(nav).toHaveBeenCalledWith({ accountId: "a-1", action });
    off();
  });
});

describe("a file in euros, written the German way", () => {
  it("totals in euros and writes a dollar account as US$", () => {
    useFileFormat.getState().setFormat({ home_currency: "EUR", region: "de-DE" });
    const accounts = [
      acct("a-chk", "Girokonto", 123_456),
      acct("a-usd", "Dollar account", 100_000, { type: "savings", currency: "USD", home_rate_micro: 900_000 }),
    ];
    render(<AccountsPane accounts={accounts} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: /Girokonto/ })).toHaveTextContent("1.234,56 €");
    expect(screen.getByRole("button", { name: /Dollar account/ })).toHaveTextContent("1.000,00 US$");
    // 1.234,56 € + US$1.000,00 at 0,90 = 2.134,56 €.
    const total = screen.getByTitle("In euros at today's rates.");
    expect(total).toHaveTextContent("2.134,56 €");
  });
});
