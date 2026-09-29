// The investment entry form: what it derives, what it refuses, what it sends.
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

import InvestmentEditRow, { type ShareTransferDraft } from "./InvestmentEditRow";
import type { LeaveResult } from "./TransactionEditRow";
import { resetIpc, setIpcHandlers } from "../test/tauriMock";
import type { Lot, NewInvestmentTransaction, Security } from "../lib/types";

const fund: Security = {
  id: "s-1",
  name: "Total Market",
  symbol: "VTSAX",
  kind: "mutual_fund",
  notes: null,
  updated_at: "",
  last_price_micro: null,
  price_date: null,
  price_source: null,
};

const lots: Lot[] = [
  { id: "lot-1", account_id: "a-1", security_id: "s-1", acquired_on: "2024-01-10", shares_micro: 100_000_000, cost_cents: 100_000, original_shares_micro: 100_000_000, original_cost_cents: 100_000 },
  { id: "lot-2", account_id: "a-1", security_id: "s-1", acquired_on: "2025-06-10", shares_micro: 100_000_000, cost_cents: 200_000, original_shares_micro: 100_000_000, original_cost_cents: 200_000 },
];

function setup(extra: Partial<React.ComponentProps<typeof InvestmentEditRow>> = {}) {
  const onCommit = vi.fn(async (_id: string | null, _t: NewInvestmentTransaction) => {});
  const onTransferShares = vi.fn(async (_t: ShareTransferDraft) => {});
  render(
    <table>
      <tbody>
        <InvestmentEditRow
          accountId="a-1"
          securities={[fund]}
          categories={[]}
          fundingAccounts={[{ id: "a-chk", name: "Checking" } as never]}
          transferTargets={[{ id: "a-ira", name: "Rollover IRA" } as never]}
          onCommit={onCommit}
          onTransferShares={onTransferShares}
          onCancel={() => {}}
          onCreateSecurity={async () => "s-new"}
          {...extra}
        />
      </tbody>
    </table>
  );
  return { onCommit, onTransferShares };
}

beforeEach(() => {
  resetIpc();
  setIpcHandlers({ list_lots: () => lots, get_disposals: () => [] });
});

describe("a buy", () => {
  it("derives the total from quantity x price and previews the cash effect", async () => {
    const { onCommit } = setup();
    await userEvent.click(screen.getByRole("combobox", { name: "Investment" }));
    await userEvent.click(await screen.findByText("Total Market (VTSAX)"));
    await userEvent.type(screen.getByLabelText("Quantity"), "12.3456");
    await userEvent.type(screen.getByLabelText("Price"), "34.5678");
    expect(screen.getByLabelText("Total")).toHaveValue("426.76");
    await userEvent.type(screen.getByLabelText("Commission:"), "4.95");
    expect(screen.getByTitle("What this does to the account's cash")).toHaveTextContent("($431.71)");
    await userEvent.selectOptions(screen.getByLabelText("Pay from:"), "a-chk");
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));
    expect(onCommit).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        activity: "buy",
        security_id: "s-1",
        shares_micro: 12_345_600,
        price_micro: 34_567_800,
        gross_cents: 42_676,
        commission_cents: 495,
        funding_account_id: "a-chk",
        lot_allocations: [],
      })
    );
  });

  it("derives the price when the total is typed instead, and sends no price", async () => {
    const { onCommit } = setup();
    await userEvent.click(screen.getByRole("combobox", { name: "Investment" }));
    await userEvent.click(await screen.findByText("Total Market (VTSAX)"));
    await userEvent.type(screen.getByLabelText("Quantity"), "100");
    await userEvent.type(screen.getByLabelText("Total"), "1234.56");
    expect(screen.getByLabelText("Price")).toHaveValue("12.3456");
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));
    expect(onCommit).toHaveBeenCalledWith(null, expect.objectContaining({ price_micro: null, gross_cents: 123_456, shares_micro: 100_000_000 }));
  });

  it("refuses to send without a security or shares", async () => {
    const { onCommit } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));
    expect(screen.getByText("Pick a security.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("combobox", { name: "Investment" }));
    await userEvent.click(await screen.findByText("Total Market (VTSAX)"));
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));
    expect(screen.getByText("How many shares?")).toBeInTheDocument();
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe("a sale", () => {
  it("lists the open lots and insists the picked lots add up to the sale", async () => {
    const { onCommit } = setup();
    await userEvent.selectOptions(screen.getByLabelText("Activity"), "sell");
    await userEvent.click(screen.getByRole("combobox", { name: "Investment" }));
    await userEvent.click(await screen.findByText("Total Market (VTSAX)"));
    await waitFor(() => expect(screen.getByText(/200 shares held on/)).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Lot method"), "specify");
    const table = screen.getByRole("table", { name: "Open lots" });
    expect(within(table).getAllByRole("row")).toHaveLength(4); // header, two lots, footer
    await userEvent.type(screen.getByLabelText("Quantity"), "150");
    await userEvent.type(screen.getByLabelText("Price"), "30");
    await userEvent.type(screen.getByLabelText("Shares from the lot of 2025-06-10"), "100");
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));
    expect(screen.getByText(/add up to 100 shares; the sale is 150/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Shares from the lot of 2024-01-10"), "50");
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));
    expect(onCommit).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        activity: "sell",
        gross_cents: 450_000,
        lot_allocations: expect.arrayContaining([
          { lot_id: "lot-2", shares_micro: 100_000_000 },
          { lot_id: "lot-1", shares_micro: 50_000_000 },
        ]),
      })
    );
  });

  it("a split takes a ratio and nothing else", async () => {
    const { onCommit } = setup();
    await userEvent.selectOptions(screen.getByLabelText("Activity"), "split");
    await userEvent.click(screen.getByRole("combobox", { name: "Investment" }));
    await userEvent.click(await screen.findByText("Total Market (VTSAX)"));
    expect(screen.getByLabelText("Total")).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Ratio"), "2");
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));
    expect(onCommit).toHaveBeenCalledWith(null, expect.objectContaining({ activity: "split", shares_micro: 2_000_000, gross_cents: 0 }));
  });

  it("Transfer Shares needs a destination and sends both halves as one call", async () => {
    const { onCommit, onTransferShares } = setup();
    await userEvent.selectOptions(screen.getByLabelText("Activity"), "transfer_shares");
    await userEvent.click(screen.getByRole("combobox", { name: "Investment" }));
    await userEvent.click(await screen.findByText("Total Market (VTSAX)"));
    expect(screen.getByLabelText("Total")).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Quantity"), "150");
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));
    expect(screen.getByText("Which account do the shares go to?")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("To account:"), "a-ira");
    await userEvent.selectOptions(screen.getByLabelText("Lot method"), "specify");
    await screen.findByRole("table", { name: "Open lots" });
    await userEvent.type(screen.getByLabelText("Shares from the lot of 2024-01-10"), "100");
    await userEvent.type(screen.getByLabelText("Shares from the lot of 2025-06-10"), "50");
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));
    expect(onTransferShares).toHaveBeenCalledWith({
      fromAccountId: "a-1",
      toAccountId: "a-ira",
      date: expect.any(String),
      securityId: "s-1",
      sharesMicro: 150_000_000,
      notes: null,
      lotAllocations: expect.arrayContaining([
        { lot_id: "lot-1", shares_micro: 100_000_000 },
        { lot_id: "lot-2", shares_micro: 50_000_000 },
      ]),
    });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("Max gain picks the cheapest lot first and sends it as specified lots", async () => {
    const { onCommit } = setup();
    await userEvent.selectOptions(screen.getByLabelText("Activity"), "sell");
    await userEvent.click(screen.getByRole("combobox", { name: "Investment" }));
    await userEvent.click(await screen.findByText("Total Market (VTSAX)"));
    await waitFor(() => expect(screen.getByText(/200 shares held on/)).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText("Quantity"), "120");
    await userEvent.type(screen.getByLabelText("Price"), "30");
    await userEvent.selectOptions(screen.getByLabelText("Lot method"), "min_gain");
    // lot-2 ($20/sh) is dearer than lot-1 ($10/sh): min gain takes lot-2 first.
    expect(screen.getByLabelText("Shares from the lot of 2025-06-10")).toHaveTextContent("100");
    expect(screen.getByLabelText("Shares from the lot of 2024-01-10")).toHaveTextContent("20");
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));
    expect(onCommit).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        lot_allocations: expect.arrayContaining([
          { lot_id: "lot-2", shares_micro: 100_000_000 },
          { lot_id: "lot-1", shares_micro: 20_000_000 },
        ]),
      })
    );
  });
});

// An existing buy opens with, and can change, the account it was paid from.
describe("Pay from on an existing buy", () => {
  it("shows the funding account and sends a changed one", async () => {
    const row = {
      id: "t-buy", date: "2026-03-01", payee: "Fund", category_name: null, category_id: null, transfer_account_id: null, transfer_account_name: null,
      amount_cents: -100_000, running_balance_cents: 0, is_reconciled: false, cleared_state: "", check_number: null, is_void: false, notes: null,
      activity: "buy", security_id: "s-1", security_name: "Fund", shares_micro: 10_000_000, price_micro: 100_000_000, gross_cents: 100_000, commission_cents: 0,
      lot_specified: false, goal_id: null, goal_name: null, tax_line: null, funding_account_id: "a-chk",
    };
    const { onCommit } = setup({ row: row as never, fundingAccounts: [{ id: "a-chk", name: "Checking" }, { id: "a-sav", name: "Savings" }] as never });
    const sel = screen.getByLabelText("Pay from:") as HTMLSelectElement;
    expect(sel.value).toBe("a-chk");
    expect(sel).not.toBeDisabled();
    await userEvent.selectOptions(sel, "a-sav");
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));
    expect(onCommit).toHaveBeenCalledWith("t-buy", expect.objectContaining({ funding_account_id: "a-sav" }));
  });

  it("starts a new entry on the date passed in", () => {
    setup({ defaultDate: "2026-08-14" });
    expect((screen.getByLabelText("Date") as HTMLInputElement).value).toBe("8/14/2026");
  });
});

// Price and total are each the user's once typed; a row can carry both.
describe("price and total kept as typed", () => {
  it("an existing row opens with its stored price and total; changing the price leaves the total alone", async () => {
    const row = {
      id: "t-buy", date: "2026-03-01", payee: "VTSAX", category_name: null, category_id: null, transfer_account_id: null, transfer_account_name: null,
      amount_cents: -42_674, running_balance_cents: 0, is_reconciled: false, cleared_state: "", check_number: null, is_void: false, notes: null,
      activity: "buy", security_id: "s-1", security_name: "VTSAX", shares_micro: 12_345_600, price_micro: 34_567_800, gross_cents: 42_674, commission_cents: 0,
      lot_specified: false, goal_id: null, goal_name: null, tax_line: null, funding_account_id: null,
    };
    const { onCommit } = setup({ row: row as never });
    // Stored values, not gross ÷ shares (which would be 34.5675…).
    expect(screen.getByLabelText("Price")).toHaveValue("34.5678");
    expect(screen.getByLabelText("Total")).toHaveValue("426.74");
    const price = screen.getByLabelText("Price");
    await userEvent.clear(price);
    await userEvent.type(price, "34.569");
    expect(screen.getByLabelText("Total")).toHaveValue("426.74");
    // 12.3456 × 34.569 = 426.775 — the note says so and nothing blocks.
    expect(screen.getByRole("note")).toHaveTextContent("Quantity × price = $426.78; total kept at $426.74.");
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));
    expect(onCommit).toHaveBeenCalledWith("t-buy", expect.objectContaining({ price_micro: 34_569_000, gross_cents: 42_674, shares_micro: 12_345_600 }));
  });

  it("on a new row a typed total stays when the price changes, and clearing it derives again", async () => {
    const { onCommit } = setup();
    await userEvent.click(screen.getByRole("combobox", { name: "Investment" }));
    await userEvent.click(await screen.findByText("Total Market (VTSAX)"));
    await userEvent.type(screen.getByLabelText("Quantity"), "10");
    await userEvent.type(screen.getByLabelText("Price"), "30");
    expect(screen.getByLabelText("Total")).toHaveValue("300.00");
    await userEvent.clear(screen.getByLabelText("Total"));
    await userEvent.type(screen.getByLabelText("Total"), "300.02");
    await userEvent.clear(screen.getByLabelText("Price"));
    await userEvent.type(screen.getByLabelText("Price"), "30.001");
    expect(screen.getByLabelText("Total")).toHaveValue("300.02");
    expect(screen.getByRole("note")).toHaveTextContent("Quantity × price = $300.01; total kept at $300.02.");
    await userEvent.clear(screen.getByLabelText("Total"));
    expect(screen.getByLabelText("Total")).toHaveValue("");
    expect(screen.queryByRole("note")).toBeNull();
    await userEvent.tab();
    expect(screen.getByLabelText("Total")).toHaveValue("300.01");
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));
    expect(onCommit).toHaveBeenCalledWith(null, expect.objectContaining({ price_micro: 30_001_000, gross_cents: 30_001 }));
  });
});

// Income paid in cash can be swept to another account.
describe("Deposit to on income", () => {
  it("a dividend offers Deposit to and sends it; a reinvested one does not", async () => {
    const { onCommit } = setup();
    await userEvent.selectOptions(screen.getByLabelText("Activity"), "dividend");
    await userEvent.click(screen.getByRole("combobox", { name: "Investment" }));
    await userEvent.click(await screen.findByText("Total Market (VTSAX)"));
    await userEvent.type(screen.getByLabelText("Total"), "2.90");
    await userEvent.selectOptions(screen.getByLabelText("Deposit to:"), "a-chk");
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));
    expect(onCommit).toHaveBeenCalledWith(null, expect.objectContaining({ activity: "dividend", gross_cents: 290, funding_account_id: "a-chk" }));
    await userEvent.selectOptions(screen.getByLabelText("Activity"), "reinvest_dividend");
    expect(screen.queryByLabelText("Deposit to:")).not.toBeInTheDocument();
  });
});

describe("cash entries in the Activity list", () => {
  beforeEach(() => resetIpc());

  it("offers Contribution and the other cash kinds beside the share activities", () => {
    setup({ onCashActivity: vi.fn() });
    const activity = screen.getByLabelText("Activity");
    const labels = within(activity).getAllByRole("option").map((o) => o.textContent);
    // The share activities are still first and unchanged.
    expect(labels[0]).toBe("Buy");
    // The user's ask: a way to enter the contribution by hand, where they look
    // for it. The capability already existed as a separate toolbar button
    // nobody found.
    expect(labels).toContain("Contribution");
    expect(labels).toContain("Employer Contribution");
    expect(labels).toContain("Deposit (cash in)");
    expect(labels).toContain("Withdrawal (cash out)");
    expect(labels).toContain("Fee");
  });

  it("hands a cash kind to the register instead of trying to be an activity", async () => {
    const onCashActivity = vi.fn();
    const { onCommit } = setup({ onCashActivity });
    await userEvent.selectOptions(screen.getByLabelText("Activity"), "cash_contribution");
    expect(onCashActivity).toHaveBeenCalledWith("cash_contribution");
    // The form did not try to save a share activity it has no fields for.
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Activity")).toHaveValue("buy");
  });

  it("offers none of them when editing an existing row, or with no handler", () => {
    setup();
    expect(within(screen.getByLabelText("Activity")).queryByText("Contribution")).toBeNull();
  });
});

// Fixes from the code review.
describe("saving once, and lot picks that follow the security", () => {
  const bond: Security = { ...fund, id: "s-2", name: "Bond Index", symbol: "VBTLX" };
  const bondLots: Lot[] = [
    { id: "lot-9", account_id: "a-1", security_id: "s-2", acquired_on: "2023-02-01", shares_micro: 80_000_000, cost_cents: 80_000, original_shares_micro: 80_000_000, original_cost_cents: 80_000 },
  ];

  it("two quick Enters record one buy", async () => {
    let finish: () => void = () => {};
    const onCommit = vi.fn(() => new Promise<void>((r) => (finish = r)));
    setup({ onCommit });
    await userEvent.click(screen.getByRole("combobox", { name: "Investment" }));
    await userEvent.click(await screen.findByText("Total Market (VTSAX)"));
    await userEvent.type(screen.getByLabelText("Quantity"), "10");
    await userEvent.type(screen.getByLabelText("Price"), "30");
    await userEvent.keyboard("{Enter}{Enter}");
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));
    expect(onCommit).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    // Once that save is back, Enter works again.
    await userEvent.click(screen.getByLabelText("Quantity"));
    await userEvent.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it("changing the security drops the picks made against the other one's lots", async () => {
    setIpcHandlers({ list_lots: (a) => (a.securityId === "s-2" ? bondLots : lots), get_disposals: () => [] });
    const { onCommit } = setup({ securities: [fund, bond] });
    await userEvent.selectOptions(screen.getByLabelText("Activity"), "sell");
    await userEvent.click(screen.getByRole("combobox", { name: "Investment" }));
    await userEvent.click(await screen.findByText("Total Market (VTSAX)"));
    await waitFor(() => expect(screen.getByText(/200 shares held on/)).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Lot method"), "specify");
    await userEvent.type(screen.getByLabelText("Quantity"), "50");
    await userEvent.type(screen.getByLabelText("Price"), "10");
    await userEvent.type(screen.getByLabelText("Shares from the lot of 2024-01-10"), "50");
    await userEvent.click(screen.getByRole("combobox", { name: "Investment" }));
    await userEvent.click(await screen.findByText("Bond Index (VBTLX)"));
    await waitFor(() => expect(screen.getByText(/80 shares held on/)).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText("Shares from the lot of 2023-02-01"), "50");
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));
    expect(screen.queryByText(/add up to/)).not.toBeInTheDocument();
    expect(onCommit).toHaveBeenCalledWith(null, expect.objectContaining({ security_id: "s-2", lot_allocations: [{ lot_id: "lot-9", shares_micro: 50_000_000 }] }));
  });

  it("changing the date drops the picks", async () => {
    const { onCommit } = setup({ defaultDate: "2026-08-14" });
    await userEvent.selectOptions(screen.getByLabelText("Activity"), "sell");
    await userEvent.click(screen.getByRole("combobox", { name: "Investment" }));
    await userEvent.click(await screen.findByText("Total Market (VTSAX)"));
    await waitFor(() => expect(screen.getByText(/200 shares held on/)).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Lot method"), "specify");
    await userEvent.type(screen.getByLabelText("Shares from the lot of 2024-01-10"), "50");
    const date = screen.getByLabelText("Date");
    await userEvent.clear(date);
    await userEvent.type(date, "8/15/2026");
    await waitFor(() => expect(screen.getByText(/200 shares held on 8\/15\/2026/)).toBeInTheDocument());
    expect(screen.getByLabelText("Shares from the lot of 2024-01-10")).toHaveValue("");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("an unreadable date is refused, not saved as the last date that parsed", async () => {
    const { onCommit } = setup();
    await userEvent.click(screen.getByRole("combobox", { name: "Investment" }));
    await userEvent.click(await screen.findByText("Total Market (VTSAX)"));
    await userEvent.type(screen.getByLabelText("Quantity"), "10");
    await userEvent.type(screen.getByLabelText("Price"), "30");
    const date = screen.getByLabelText("Date");
    await userEvent.clear(date);
    await userEvent.type(date, "2/29/2027");
    await userEvent.click(screen.getByRole("button", { name: "Enter" }));
    expect(screen.getByText(/The date is missing or unreadable/)).toBeInTheDocument();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("an untouched sale with hand-picked lots is not saved again on leaving", async () => {
    setIpcHandlers({
      list_lots: () => lots,
      get_disposals: () => [{ sell_id: "t-sell", lot_id: "lot-2", account_id: "a-1", security_id: "s-1", acquired_on: "2025-06-10", sold_on: "2026-03-01", shares_micro: 50_000_000, proceeds_cents: 150_000, cost_cents: 100_000, gain_cents: 50_000 }],
    });
    const row = {
      id: "t-sell", date: "2026-03-01", payee: "VTSAX", category_name: null, category_id: null, transfer_account_id: null, transfer_account_name: null,
      amount_cents: 150_000, running_balance_cents: 0, is_reconciled: false, cleared_state: "", check_number: null, is_void: false, notes: null,
      activity: "sell", security_id: "s-1", security_name: "VTSAX", shares_micro: 50_000_000, price_micro: 30_000_000, gross_cents: 150_000, commission_cents: 0,
      lot_specified: true, goal_id: null, goal_name: null, tax_line: null, funding_account_id: null,
    };
    const leaveRef: { current: (() => Promise<LeaveResult>) | null } = { current: null };
    const { onCommit } = setup({ row: row as never, leaveRef });
    await waitFor(() => expect(screen.getByLabelText("Shares from the lot of 2025-06-10")).toHaveValue("50"));
    let result: LeaveResult | undefined;
    await act(async () => {
      result = await leaveRef.current!();
    });
    expect(result).toBe("clean");
    expect(onCommit).not.toHaveBeenCalled();
    // A pick the user does change still counts.
    await userEvent.clear(screen.getByLabelText("Shares from the lot of 2025-06-10"));
    await userEvent.type(screen.getByLabelText("Shares from the lot of 2025-06-10"), "40");
    await userEvent.type(screen.getByLabelText("Shares from the lot of 2024-01-10"), "10");
    await act(async () => {
      result = await leaveRef.current!();
    });
    expect(result).toBe("saved");
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});
