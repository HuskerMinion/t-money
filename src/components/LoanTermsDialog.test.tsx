// @vitest-environment jsdom
// Loan terms: the schedule previews before it is saved, and the escrow
// destination is not allowed to be left blank.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

import LoanTermsDialog from "./LoanTermsDialog";
import { invokeCalls, resetIpc, setIpcHandlers } from "../test/tauriMock";
import { useAccountStore } from "../stores/useAccountStore";
import type { Account, LoanPeriod, LoanTerms } from "../lib/types";

function acct(id: string, name: string, type: string, balance: number): Account {
  return {
    id,
    name,
    type,
    balance_cents: balance,
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

const mortgage = acct("a-mtg", "Mortgage", "mortgage", -15_000_000);
const checking = acct("a-chk", "Checking", "checking", 500_000);
const escrowAcct = acct("a-esc", "Escrow", "asset", 120_000);

const period = (over: Partial<LoanPeriod> = {}): LoanPeriod => ({
  date: "2026-10-01",
  payment_cents: 112_400,
  interest_cents: 94_427,
  principal_cents: 17_973,
  escrow_cents: 41_500,
  extra_principal_cents: 0,
  opening_cents: 15_000_000,
  closing_cents: 14_982_027,
  ...over,
});

beforeEach(() => {
  resetIpc();
  useAccountStore.setState({ accounts: [mortgage, checking, escrowAcct], categories: [] });
  vi.useRealTimers();
});

describe("Loan terms", () => {
  it("previews the schedule from the typed terms without saving anything", async () => {
    setIpcHandlers({
      get_loan_terms: () => null,
      loan_schedule: () => [period(), period({ date: "2026-11-01", interest_cents: 94_335, principal_cents: 18_065 })],
    });
    render(<LoanTermsDialog account={mortgage} onDone={vi.fn()} onCancel={vi.fn()} />);
    const dlg = screen.getByRole("dialog", { name: "Loan terms" });

    await userEvent.type(within(dlg).getByLabelText("Interest rate %"), "6.5");
    await userEvent.clear(within(dlg).getByLabelText("Payment (P&I)"));
    await userEvent.type(within(dlg).getByLabelText("Payment (P&I)"), "1124.00");

    const table = await within(dlg).findByRole("table", { name: "Amortization schedule" }, { timeout: 3000 });
    expect(within(table).getByText("944.27")).toBeInTheDocument();
    expect(within(table).getByText("179.73")).toBeInTheDocument();
    // Payment plus escrow is what actually leaves the account.
    expect(within(table).getAllByText("1,539.00").length).toBe(2);

    // The rate went over as an exact integer of millionths, and nothing was saved.
    const previews = invokeCalls.filter((c) => c.cmd === "loan_schedule");
    const preview = previews[previews.length - 1];
    expect((preview.args.terms as LoanTerms).apr_micro).toBe(6_500_000);
    expect((preview.args.terms as LoanTerms).payment_cents).toBe(112_400);
    expect(invokeCalls.some((c) => c.cmd === "set_loan_terms")).toBe(false);
  });

  it("will not save an escrow amount with nowhere to go", async () => {
    setIpcHandlers({ get_loan_terms: () => null, loan_schedule: () => [period()] });
    render(<LoanTermsDialog account={mortgage} onDone={vi.fn()} onCancel={vi.fn()} />);
    const dlg = screen.getByRole("dialog", { name: "Loan terms" });

    await userEvent.type(within(dlg).getByLabelText("Interest rate %"), "6.5");
    await userEvent.clear(within(dlg).getByLabelText("Payment (P&I)"));
    await userEvent.type(within(dlg).getByLabelText("Payment (P&I)"), "1124.00");
    await userEvent.clear(within(dlg).getByLabelText("Escrow each month"));
    await userEvent.type(within(dlg).getByLabelText("Escrow each month"), "415.00");
    await userEvent.click(within(dlg).getByRole("button", { name: "Save" }));

    expect(within(dlg).getByText(/Say where the escrow part goes/)).toBeInTheDocument();
    expect(invokeCalls.some((c) => c.cmd === "set_loan_terms")).toBe(false);

    await userEvent.selectOptions(within(dlg).getByLabelText("Escrow account"), "a-esc");
    await userEvent.click(within(dlg).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "set_loan_terms")).toBe(true));
    const saved = invokeCalls.find((c) => c.cmd === "set_loan_terms")!.args.terms as LoanTerms;
    expect(saved.escrow_cents).toBe(41_500);
    expect(saved.escrow_account_id).toBe("a-esc");
    expect(saved.escrow_category_id).toBeNull();
  });

  it("loads the terms that are already there and offers to remove them", async () => {
    const stored: LoanTerms = {
      account_id: "a-mtg",
      apr_micro: 6_500_000,
      payment_cents: 112_400,
      escrow_cents: 41_500,
      escrow_account_id: "a-esc",
      escrow_category_id: null,
      interest_category_id: null,
      from_account_id: "a-chk",
      payment_day: 1,
      first_payment_date: "2026-10-01",
      term_months: 360,
      notes: null,
      extra_principal_cents: 0,
    };
    setIpcHandlers({ get_loan_terms: () => stored, loan_schedule: () => [period()], clear_loan_terms: () => null });
    render(<LoanTermsDialog account={mortgage} onDone={vi.fn()} onCancel={vi.fn()} />);
    const dlg = screen.getByRole("dialog", { name: "Loan terms" });

    await waitFor(() => expect(within(dlg).getByLabelText("Interest rate %")).toHaveValue("6.5"));
    expect(within(dlg).getByLabelText("Payment (P&I)")).toHaveValue("1,124.00");
    expect(within(dlg).getByLabelText("Usually paid from")).toHaveValue("a-chk");

    await userEvent.click(within(dlg).getByRole("button", { name: "Remove terms" }));
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "clear_loan_terms")).toBe(true));
  });

  it("A standing extra principal payment is saved with the terms and shown in the schedule", async () => {
    setIpcHandlers({
      get_loan_terms: () => null,
      loan_schedule: () => [
        period({ payment_cents: 100_000, interest_cents: 75_000, principal_cents: 25_000, escrow_cents: 65_000, extra_principal_cents: 15_000, closing_cents: 14_960_000 }),
      ],
      set_loan_terms: () => null,
    });
    render(<LoanTermsDialog account={mortgage} onDone={vi.fn()} onCancel={vi.fn()} />);
    const dlg = screen.getByRole("dialog", { name: "Loan terms" });

    await userEvent.type(within(dlg).getByLabelText("Interest rate %"), "6.5");
    await userEvent.clear(within(dlg).getByLabelText("Payment (P&I)"));
    await userEvent.type(within(dlg).getByLabelText("Payment (P&I)"), "1000.00");
    await userEvent.clear(within(dlg).getByLabelText("Escrow each month"));
    await userEvent.type(within(dlg).getByLabelText("Escrow each month"), "650.00");
    await userEvent.clear(within(dlg).getByLabelText("Extra principal each month"));
    await userEvent.type(within(dlg).getByLabelText("Extra principal each month"), "150.00");
    await userEvent.selectOptions(within(dlg).getByLabelText("Escrow account"), "a-esc");

    // The schedule counts it: the payment column is the whole $1,800.00, and
    // the balance falls by both principal lines.
    const table = await within(dlg).findByRole("table", { name: "Amortization schedule" }, { timeout: 3000 });
    expect(within(table).getByText("1,800.00")).toBeInTheDocument();
    expect(within(table).getByText("150.00")).toBeInTheDocument();
    expect(within(table).getByText("149,600.00")).toBeInTheDocument();

    await userEvent.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "set_loan_terms")).toBe(true));
    const saved = invokeCalls.find((c) => c.cmd === "set_loan_terms")!.args.terms as LoanTerms;
    expect(saved.extra_principal_cents).toBe(15_000);
    // The extra is on TOP of the payment, not folded into it.
    expect(saved.payment_cents).toBe(100_000);
  });

  it("says so when the payment never covers the interest", async () => {
    setIpcHandlers({
      get_loan_terms: () => null,
      loan_schedule: () => [period({ payment_cents: 10_000, interest_cents: 10_000, principal_cents: 0, closing_cents: 15_000_000 })],
    });
    render(<LoanTermsDialog account={mortgage} onDone={vi.fn()} onCancel={vi.fn()} />);
    const dlg = screen.getByRole("dialog", { name: "Loan terms" });
    await userEvent.type(within(dlg).getByLabelText("Interest rate %"), "6.5");
    await userEvent.clear(within(dlg).getByLabelText("Payment (P&I)"));
    await userEvent.type(within(dlg).getByLabelText("Payment (P&I)"), "100.00");

    expect(await within(dlg).findByText(/does not cover the interest/, undefined, { timeout: 3000 })).toBeInTheDocument();
  });
});
