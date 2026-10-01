// @vitest-environment jsdom
// Recording a payment: the terms propose the split, the statement wins.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

import RecordPaymentDialog from "./RecordPaymentDialog";
import { invokeCalls, resetIpc, setIpcHandlers } from "../test/tauriMock";
import { useAccountStore } from "../stores/useAccountStore";
import type { Account, LoanTerms } from "../lib/types";
import { useFileFormat } from "../lib/region";

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

const terms: LoanTerms = {
  account_id: "a-mtg",
  apr_micro: 6_500_000,
  payment_cents: 112_400,
  escrow_cents: 41_500,
  escrow_account_id: "a-esc",
  escrow_category_id: null,
  interest_category_id: "c-int",
  from_account_id: "a-chk",
  payment_day: 1,
  first_payment_date: "2026-10-01",
  term_months: 360,
  notes: null,
  extra_principal_cents: 0,
};

beforeEach(() => {
  resetIpc();
  useAccountStore.setState({ accounts: [mortgage, checking], categories: [] });
  setIpcHandlers({
    get_loan_terms: () => terms,
    next_loan_payment: () => ({
      date: "2026-10-01",
      payment_cents: 112_400,
      interest_cents: 94_427,
      principal_cents: 17_973,
      escrow_cents: 41_500,
      extra_principal_cents: 0,
      opening_cents: 15_000_000,
      closing_cents: 14_982_027,
    }),
    record_loan_payment: () => "t-new",
  });
});

describe("Record payment", () => {
  it("fills the three parts from the terms and sends exactly what was proposed", async () => {
    const onDone = vi.fn();
    render(<RecordPaymentDialog account={mortgage} onDone={onDone} onCancel={vi.fn()} />);
    const dlg = screen.getByRole("dialog", { name: "Record payment" });

    await waitFor(() => expect(within(dlg).getByLabelText("Interest")).toHaveValue("944.27"));
    expect(within(dlg).getByLabelText("Principal")).toHaveValue("179.73");
    expect(within(dlg).getByLabelText("Escrow")).toHaveValue("415.00");
    expect(within(dlg).getByLabelText("Extra principal")).toHaveValue("0.00");
    expect(within(dlg).getByLabelText("Paid from")).toHaveValue("a-chk");

    await userEvent.click(within(dlg).getByRole("button", { name: "Record" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());

    const call = invokeCalls.find((c) => c.cmd === "record_loan_payment")!;
    expect(call.args.interestCents).toBe(94_427);
    expect(call.args.principalCents).toBe(17_973);
    expect(call.args.escrowCents).toBe(41_500);
    expect(call.args.extraPrincipalCents).toBe(0);
    expect(call.args.accountId).toBe("a-mtg");
    expect(call.args.fromAccountId).toBe("a-chk");
  });

  it("takes the statement's numbers over its own and shows the balance they leave", async () => {
    render(<RecordPaymentDialog account={mortgage} onDone={vi.fn()} onCancel={vi.fn()} />);
    const dlg = screen.getByRole("dialog", { name: "Record payment" });
    await waitFor(() => expect(within(dlg).getByLabelText("Interest")).toHaveValue("944.27"));

    // The bank applied a dollar more interest and raised escrow.
    await userEvent.clear(within(dlg).getByLabelText("Interest"));
    await userEvent.type(within(dlg).getByLabelText("Interest"), "954.27");
    await userEvent.clear(within(dlg).getByLabelText("Escrow"));
    await userEvent.type(within(dlg).getByLabelText("Escrow"), "450.00");

    expect(within(dlg).getByText(/\$1,584\.00/)).toBeInTheDocument();
    expect(within(dlg).getByText(/\$149,820\.27/)).toBeInTheDocument();

    await userEvent.click(within(dlg).getByRole("button", { name: "Record" }));
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "record_loan_payment")).toBe(true));
    const call = invokeCalls.find((c) => c.cmd === "record_loan_payment")!;
    expect(call.args.interestCents).toBe(95_427);
    expect(call.args.escrowCents).toBe(45_000);
    expect(call.args.principalCents).toBe(17_973);
  });

  it("refuses a payment of nothing rather than writing an empty split", async () => {
    render(<RecordPaymentDialog account={mortgage} onDone={vi.fn()} onCancel={vi.fn()} />);
    const dlg = screen.getByRole("dialog", { name: "Record payment" });
    await waitFor(() => expect(within(dlg).getByLabelText("Interest")).toHaveValue("944.27"));

    for (const f of ["Interest", "Principal", "Escrow", "Extra principal"]) {
      await userEvent.clear(within(dlg).getByLabelText(f));
      await userEvent.type(within(dlg).getByLabelText(f), "0");
    }
    await userEvent.click(within(dlg).getByRole("button", { name: "Record" }));

    expect(within(dlg).getByText("A payment of nothing is not a payment.")).toBeInTheDocument();
    expect(invokeCalls.some((c) => c.cmd === "record_loan_payment")).toBe(false);
  });

  it("An extra principal payment is part of the one transaction, not a second one", async () => {
    // A Maple Street payment: the bank shows one $1,800.00 debit, of which
    // $150.00 is principal paid ahead. Once, the only way to record the
    // extra was a second Record payment, and then the register held two rows
    // against a statement holding one.
    setIpcHandlers({
      get_loan_terms: () => ({ ...terms, payment_cents: 100_000, escrow_cents: 65_000, extra_principal_cents: 15_000 }),
      next_loan_payment: () => ({
        date: "2026-10-01",
        payment_cents: 100_000,
        interest_cents: 75_000,
        principal_cents: 25_000,
        escrow_cents: 65_000,
        extra_principal_cents: 15_000,
        opening_cents: 15_000_000,
        closing_cents: 14_960_000,
      }),
      record_loan_payment: () => "t-new",
    });
    const onDone = vi.fn();
    render(<RecordPaymentDialog account={mortgage} onDone={onDone} onCancel={vi.fn()} />);
    const dlg = screen.getByRole("dialog", { name: "Record payment" });

    // The standing amount is proposed — it is not retyped every month.
    await waitFor(() => expect(within(dlg).getByLabelText("Extra principal")).toHaveValue("150.00"));

    // One row in the register, for what the bank shows.
    expect(within(dlg).getByText(/\$1,800\.00/)).toBeInTheDocument();
    // And both principal lines come off the loan: 150,000 - 250.00 - 150.00.
    expect(within(dlg).getByText(/\$149,600\.00/)).toBeInTheDocument();

    await userEvent.click(within(dlg).getByRole("button", { name: "Record" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());

    const calls = invokeCalls.filter((c) => c.cmd === "record_loan_payment");
    expect(calls.length).toBe(1); // one payment, one transaction
    const p = calls[0].args as {
      interestCents: number;
      principalCents: number;
      escrowCents: number;
      extraPrincipalCents: number;
    };
    expect(p.principalCents).toBe(25_000);
    expect(p.extraPrincipalCents).toBe(15_000);
    expect(p.interestCents + p.principalCents + p.escrowCents + p.extraPrincipalCents).toBe(180_000);
  });

  it("A month with nothing extra sends zero, and the extra can be typed over", async () => {
    setIpcHandlers({
      get_loan_terms: () => ({ ...terms, extra_principal_cents: 15_000 }),
      next_loan_payment: () => ({
        date: "2026-10-01",
        payment_cents: 112_400,
        interest_cents: 94_427,
        principal_cents: 17_973,
        escrow_cents: 41_500,
        extra_principal_cents: 15_000,
        opening_cents: 15_000_000,
        closing_cents: 14_952_027,
      }),
      record_loan_payment: () => "t-new",
    });
    render(<RecordPaymentDialog account={mortgage} onDone={vi.fn()} onCancel={vi.fn()} />);
    const dlg = screen.getByRole("dialog", { name: "Record payment" });
    await waitFor(() => expect(within(dlg).getByLabelText("Extra principal")).toHaveValue("150.00"));

    // A tight month: the extra is skipped, and the total follows.
    await userEvent.clear(within(dlg).getByLabelText("Extra principal"));
    await userEvent.type(within(dlg).getByLabelText("Extra principal"), "0");
    expect(within(dlg).getByText(/\$1,539\.00/)).toBeInTheDocument();

    await userEvent.click(within(dlg).getByRole("button", { name: "Record" }));
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "record_loan_payment")).toBe(true));
    expect(invokeCalls.find((c) => c.cmd === "record_loan_payment")!.args.extraPrincipalCents).toBe(0);
  });

  it("says the terms are missing rather than proposing zeroes as if they were the split", async () => {
    setIpcHandlers({ get_loan_terms: () => null });
    render(<RecordPaymentDialog account={mortgage} onDone={vi.fn()} onCancel={vi.fn()} />);
    const dlg = screen.getByRole("dialog", { name: "Record payment" });
    expect(await within(dlg).findByText(/no terms yet/)).toBeInTheDocument();
    expect(invokeCalls.some((c) => c.cmd === "next_loan_payment")).toBe(false);
  });
});

describe("Record payment", () => {
  it("does not preselect a funding account that has been closed, and will not record against it", async () => {
    const closed = { ...checking, is_closed: true };
    useAccountStore.setState({ accounts: [mortgage, closed] });
    render(<RecordPaymentDialog account={mortgage} onDone={vi.fn()} onCancel={vi.fn()} />);
    const dlg = screen.getByRole("dialog", { name: "Record payment" });
    await waitFor(() => expect(within(dlg).getByLabelText("Interest")).toHaveValue("944.27"));
    expect(within(dlg).getByLabelText("Paid from")).toHaveValue("");
    await userEvent.click(within(dlg).getByRole("button", { name: "Record" }));
    expect(within(dlg).getByText("Choose the account the payment comes out of.")).toBeInTheDocument();
    expect(invokeCalls.some((c) => c.cmd === "record_loan_payment")).toBe(false);
  });

  it("tells the Edit menu a payment was recorded", async () => {
    const onDone = vi.fn();
    render(<RecordPaymentDialog account={mortgage} onDone={onDone} onCancel={vi.fn()} />);
    const dlg = screen.getByRole("dialog", { name: "Record payment" });
    await waitFor(() => expect(within(dlg).getByLabelText("Paid from")).toHaveValue("a-chk"));
    await userEvent.click(within(dlg).getByRole("button", { name: "Record" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const cmds = invokeCalls.map((c) => c.cmd);
    expect(cmds.indexOf("undo_status")).toBeGreaterThan(cmds.indexOf("record_loan_payment"));
  });
});

describe("Record payment in another currency", () => {
  it("writes the totals in the loan's currency", async () => {
    render(<RecordPaymentDialog account={{ ...mortgage, currency: "CAD" }} onDone={vi.fn()} onCancel={vi.fn()} />);
    const dlg = screen.getByRole("dialog", { name: "Record payment" });
    await waitFor(() => expect(within(dlg).getByText(/^Total payment/)).toBeInTheDocument());
    expect(within(dlg).getByText("CA$1,539.00")).toBeInTheDocument();
    expect(within(dlg).getByText("CA$150,000.00")).toBeInTheDocument();
  });
});

describe("Record payment in a German file", () => {
  it("proposes 944,27 and takes 1.234,56 typed over it", async () => {
    useFileFormat.getState().setFormat({ home_currency: "EUR", region: "de-DE" });
    render(<RecordPaymentDialog account={mortgage} onDone={vi.fn()} onCancel={vi.fn()} />);
    const dlg = screen.getByRole("dialog", { name: "Record payment" });
    await waitFor(() => expect(within(dlg).getByLabelText("Interest")).toHaveValue("944,27"));
    expect(within(dlg).getByLabelText("Extra principal")).toHaveValue("0,00");

    await userEvent.clear(within(dlg).getByLabelText("Escrow"));
    await userEvent.type(within(dlg).getByLabelText("Escrow"), "1.234,56");
    // 944,27 + 179,73 + 1.234,56.
    expect(within(dlg).getByText("2.358,56 €")).toBeInTheDocument();
    expect(within(dlg).getByText("149.820,27 €")).toBeInTheDocument();

    await userEvent.click(within(dlg).getByRole("button", { name: "Record" }));
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "record_loan_payment")).toBe(true));
    const call = invokeCalls.find((c) => c.cmd === "record_loan_payment")!;
    expect(call.args.escrowCents).toBe(123_456);
    expect(call.args.interestCents).toBe(94_427);
  });
});
