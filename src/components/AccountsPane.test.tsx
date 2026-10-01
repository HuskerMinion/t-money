// @vitest-environment jsdom
// The Three-pane account column: rows in their own currency, group totals in the home currency.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import AccountsPane from "./AccountsPane";
import type { Account } from "../lib/types";
import { useFileFormat } from "../lib/region";

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
