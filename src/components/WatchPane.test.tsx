// §126 — the watched register. §183: it has to follow the main pane's writes.
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

import WatchPane from "./WatchPane";
import { invokeCalls, resetIpc, setIpcHandlers } from "../test/tauriMock";
import type { Account, RegisterRow } from "../lib/types";

function acct(id: string, name: string, balance_cents: number): Account {
  return {
    id,
    name,
    type: "checking",
    balance_cents,
    holdings_value_cents: 0,
    tax_included: true,
    is_favorite: false,
    is_closed: false,
    updated_at: "",
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
  } as Account;
}

function row(id: string, amount_cents: number, running_balance_cents: number): RegisterRow {
  return {
    id,
    date: "2026-09-01",
    payee: "Transfer Money",
    category_name: null,
    category_id: null,
    transfer_account_id: null,
    amount_cents,
    running_balance_cents,
    is_reconciled: false,
    cleared_state: "",
    check_number: null,
    is_void: false,
    notes: null,
    transfer_account_name: null,
    activity: null,
    security_id: null,
    security_name: null,
    shares_micro: null,
    price_micro: null,
    gross_cents: null,
    commission_cents: 0,
    lot_specified: false,
    goal_id: null,
    goal_name: null,
  } as RegisterRow;
}

describe("WatchPane (§126, §183)", () => {
  beforeEach(() => {
    resetIpc();
    localStorage.setItem("tm.twoup.account", "acc-sav");
  });

  it("reloads the watched register when the main pane writes, not only when it switches accounts", async () => {
    let rows = [row("t-1", 10_000, 10_000)];
    setIpcHandlers({ get_register: () => rows });
    const checking = acct("acc-chk", "Checking", 50_000);
    const savings = acct("acc-sav", "Savings", 10_000);
    const { rerender } = render(<WatchPane accounts={[checking, savings]} workingId="acc-chk" onWork={vi.fn()} />);
    expect(await screen.findByText(/Ending Balance/)).toHaveTextContent("$100.00");

    // A transfer entered in Checking lands in Savings; the store reloads the
    // account list (a new array), and the working account has not changed.
    rows = [...rows, row("t-2", 2_500, 12_500)];
    rerender(<WatchPane accounts={[{ ...checking, balance_cents: 47_500 }, { ...savings, balance_cents: 12_500 }]} workingId="acc-chk" onWork={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/Ending Balance/)).toHaveTextContent("$125.00"));
    expect(invokeCalls.filter((c) => c.cmd === "get_register").length).toBe(2);
  });
});
