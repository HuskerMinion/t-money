// @vitest-environment jsdom
// §103 — the dialog's one job is to stop the gross reaching the bank.
//
// The Rust tests cover the arithmetic. These cover the gate: that the Import
// button will not light up while the answers are impossible, and that what it
// finally sends is the net and the date the BANK saw, not the plan's.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));
const picked = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: () => picked() }));

import TspImportDialog from "./TspImportDialog";
import { invokeCalls, resetIpc, setIpcHandlers } from "../test/tauriMock";
import type { Account, TspPaymentSplit } from "../lib/types";

const acct = (id: string, name: string, type: Account["type"]): Account => ({
  id,
  name,
  type,
  balance_cents: 0,
  holdings_value_cents: 0,
  tax_included: true,
  is_favorite: false,
  is_closed: false,
  updated_at: "2026-09-01T00:00:00Z",
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
});

const accounts = [acct("a-tsp", "TSP", "retirement"), acct("a-chk", "Everyday Checking 1234", "checking")];

const PLAN = {
  rows: 1000,
  transactions: 500,
  opening: [
    {
      fund: "S Fund",
      units: "2000.000000",
      nav: "15.0000",
      value_cents: 30_000_00,
      rounding_sliver: null,
      already_held: "0.000000",
      to_add: "2000.000000",
    },
  ],
  open_date: "2022-06-01",
  payments: [{ date: "2026-03-16", gross_cents: 100_000, is_loan: false, needs_split: true }],
  problems: [] as string[],
  funds: ["G Fund", "I Fund", "S Fund"],
};

let plan = PLAN;

beforeEach(() => {
  resetIpc();
  plan = { ...PLAN, problems: [] };
  picked.mockResolvedValue("C:\\Downloads\\tsp.csv");
  setIpcHandlers({
    preview_tsp: () => plan,
    import_tsp: () => ({
      account_id: "a-tsp",
      account_name: "TSP",
      imported: 500,
      skipped: 0,
      duplicates: 0,
      balance_delta_cents: 0,
      investments: 500,
      securities_created: 3,
      transfers_linked: 1,
      matched: 0,
      user_skipped: 0,
      notes: [],
    }),
  });
});

async function openFile() {
  const user = userEvent.setup();
  render(<TspImportDialog accounts={accounts} onClose={vi.fn()} onImported={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "Choose file…" }));
  await screen.findByText("500");
  return user;
}

describe("TspImportDialog (§103)", () => {
  it("shows the collapse and the opening position it worked out", async () => {
    await openFile();
    // The collapse is the thing that makes the file comprehensible.
    expect(screen.getByText(/1,000 rows/)).toBeInTheDocument();
    expect(screen.getByText(/2000.000000 units/)).toBeInTheDocument();
    expect(screen.getByText(/not estimated/i)).toBeInTheDocument();
  });

  it("starts every payment at the gross, which is the answer it wants corrected", async () => {
    await openFile();
    // Comma-grouped as the rest of the app writes amounts; the parser strips
    // them, so it is still a usable starting answer.
    expect(screen.getByLabelText("Received for 2026-03-16")).toHaveValue("1,000.00");
    // Nothing kept back yet — and that is exactly the state that was wrong.
    expect(screen.getByLabelText("Category for 2026-03-16")).toBeDisabled();
  });

  it("will not import while the answers are impossible", async () => {
    const user = await openFile();
    await user.selectOptions(screen.getByLabelText("Plan account"), "a-tsp");
    await user.selectOptions(screen.getByLabelText("Cash account"), "a-chk");
    const net = screen.getByLabelText("Received for 2026-03-16");
    await user.clear(net);
    // More than the plan sold: there is no arrangement of withholding that
    // makes this true.
    await user.type(net, "4000.00");
    await waitFor(() => expect(screen.getByRole("button", { name: "Import" })).toBeDisabled());
  });

  it("sends the net, the bank's date, and the difference as a categorized line", async () => {
    const user = await openFile();
    await user.selectOptions(screen.getByLabelText("Plan account"), "a-tsp");
    await user.selectOptions(screen.getByLabelText("Cash account"), "a-chk");
    const net = screen.getByLabelText("Received for 2026-03-16");
    await user.clear(net);
    await user.type(net, "850.00");
    const posted = screen.getByLabelText("Posted for 2026-03-16");
    await user.clear(posted);
    await user.type(posted, "2026-03-17");

    await waitFor(() => expect(screen.getByRole("button", { name: "Import" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "import_tsp")).toBe(true));
    const args = invokeCalls.find((c) => c.cmd === "import_tsp")!.args as {
      splits: TspPaymentSplit[];
      accountId: string;
      cashAccountId: string;
    };
    expect(args.accountId).toBe("a-tsp");
    expect(args.cashAccountId).toBe("a-chk");
    expect(args.splits).toEqual([
      {
        date: "2026-03-16",
        // The NET, dated when the bank posted it — so the importer can match
        // the deposit already sitting in the register.
        deposits: [{ on: "2026-03-17", amount_cents: 85_000 }],
        // The remainder is left null on purpose: Rust computes it, so the
        // arithmetic is settled in one place.
        lines: [
          {
            category: "Taxes:TSP Federal Withholding",
            amount_cents: null,
            memo: "Tax withheld on TSP distribution",
          },
        ],
      },
    ]);
  });

  it("refuses outright when the file does not add up", async () => {
    plan = { ...PLAN, problems: ["2026-04-01: G Fund would hold -12.5 units"] };
    const user = await openFile();
    await user.selectOptions(screen.getByLabelText("Plan account"), "a-tsp");
    await user.selectOptions(screen.getByLabelText("Cash account"), "a-chk");
    expect(screen.getByText(/would hold -12.5 units/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
  });

  it("says a loan is a loan, and files it as a fee rather than withholding", async () => {
    plan = { ...PLAN, payments: [{ date: "2025-12-31", gross_cents: 1_080_000, is_loan: true, needs_split: true }] };
    await openFile();
    expect(screen.getByText(/a loan, not a distribution/)).toBeInTheDocument();
    expect(screen.getByLabelText("Category for 2025-12-31")).toHaveValue("Bank Charges:Loan fee");
  });
});

describe("§154 — a file that paid nothing out", () => {
  // > *"If there's no money moving from TSP to an account I shouldn't have
  // >  to select where 'Money went to'."*
  it("does not ask where the money went, and imports without a bank account", async () => {
    plan = { ...PLAN, payments: [] };
    const user = await openFile();
    expect(screen.queryByLabelText("Cash account")).toBeNull();
    expect(screen.queryByText("What actually reached the bank")).toBeNull();

    await user.selectOptions(screen.getByLabelText("Plan account"), "a-tsp");
    await waitFor(() => expect(screen.getByRole("button", { name: "Import" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Import" }));

    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "import_tsp")).toBe(true));
    const args = invokeCalls.find((c) => c.cmd === "import_tsp")!.args as {
      accountId: string;
      cashAccountId: string | null;
      splits: TspPaymentSplit[];
    };
    expect(args.accountId).toBe("a-tsp");
    expect(args.cashAccountId).toBeNull();
    expect(args.splits).toEqual([]);
  });

  it("still asks, and still waits for an answer, when the plan paid something out", async () => {
    const user = await openFile();
    expect(screen.getByLabelText("Cash account")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Plan account"), "a-tsp");
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled();
  });
});

describe("§155 — the file handed over, and the shares already there", () => {
  it("opens on a file the CSV door handed it, without asking again", async () => {
    render(
      <TspImportDialog
        accounts={accounts}
        initialPath={"C:\\Downloads\\tsp.csv"}
        onClose={vi.fn()}
        onImported={vi.fn()}
      />
    );
    await screen.findByText("500");
    expect(picked).not.toHaveBeenCalled();
    expect(invokeCalls).toContainEqual({
      cmd: "preview_tsp",
      args: { path: "C:\\Downloads\\tsp.csv", accountId: null },
    });
  });

  it("asks the register again for the chosen account, and says what is already there", async () => {
    setIpcHandlers({
      preview_tsp: (args) => {
        const a = args as { accountId: string | null };
        if (a.accountId !== "a-tsp") return plan;
        return {
          ...plan,
          opening: [{ ...plan.opening[0], already_held: "2000.000000", to_add: "0.000000" }],
        };
      },
    });
    const user = await openFile();
    expect(screen.queryByText(/Already in the register/)).toBeNull();
    await user.selectOptions(screen.getByLabelText("Plan account"), "a-tsp");
    await screen.findByText(/Already in the register on that date — nothing is added/);
    expect(invokeCalls).toContainEqual({
      cmd: "preview_tsp",
      args: { path: "C:\\Downloads\\tsp.csv", accountId: "a-tsp" },
    });
  });

  it("keeps what was typed for a payment when the account changes", async () => {
    const user = await openFile();
    const net = screen.getByLabelText("Received for 2026-03-16");
    await user.clear(net);
    await user.type(net, "850.00");
    await user.selectOptions(screen.getByLabelText("Plan account"), "a-tsp");
    await waitFor(() =>
      expect(invokeCalls.filter((c) => c.cmd === "preview_tsp")).toHaveLength(2)
    );
    expect(screen.getByLabelText("Received for 2026-03-16")).toHaveValue("850.00");
  });
});

describe("§183 — previews that cross, and errors where the buttons are", () => {
  it("a preview for an account no longer chosen does not land over the newer one", async () => {
    const held = { ...PLAN.opening[0], already_held: "100.000000", to_add: "1900.000000" };
    const release: Record<string, () => void> = {};
    setIpcHandlers({
      preview_tsp: (args) => {
        if (args.accountId === null) return plan;
        // The first account's answer is slow; the second's is quick.
        if (args.accountId === "a-tsp") {
          return new Promise((res) => {
            release.tsp = () => res({ ...PLAN, opening: [held] });
          });
        }
        return { ...PLAN, opening: [{ ...PLAN.opening[0], already_held: "2000.000000", to_add: "0.000000" }] };
      },
    });
    const two = [...accounts, acct("a-tsp2", "TSP (spouse)", "retirement")];
    const user = userEvent.setup();
    render(<TspImportDialog accounts={two} onClose={vi.fn()} onImported={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Choose file…" }));
    await screen.findByText("500");
    await user.selectOptions(screen.getByLabelText("Plan account"), "a-tsp");
    await user.selectOptions(screen.getByLabelText("Plan account"), "a-tsp2");
    await screen.findByText("Already in the register on that date — nothing is added.");
    release.tsp();
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText("Already in the register on that date — nothing is added.")).toBeInTheDocument();
    expect(screen.queryByText(/100.000000 already in the register/)).not.toBeInTheDocument();
  });

  it("the account pickers are locked while the import runs, and a refusal shows beside the buttons", async () => {
    let refuse: (e: unknown) => void = () => {};
    setIpcHandlers({
      preview_tsp: () => plan,
      import_tsp: () =>
        new Promise((_, rej) => {
          refuse = rej;
        }),
    });
    const user = await openFile();
    await user.selectOptions(screen.getByLabelText("Plan account"), "a-tsp");
    await user.selectOptions(screen.getByLabelText("Cash account"), "a-chk");
    await waitFor(() => expect(screen.getByRole("button", { name: "Import" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(screen.getByLabelText("Plan account")).toBeDisabled());
    expect(screen.getByLabelText("Cash account")).toBeDisabled();
    refuse("the TSP account already holds these transactions");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("the TSP account already holds these transactions");
    // Outside the scrolling contents, right above Cancel and Import.
    expect(alert.closest("[style*='overflow']")).toBeNull();
    expect(alert.nextElementSibling).toContainElement(screen.getByRole("button", { name: "Import" }));
    expect(screen.getByLabelText("Plan account")).toBeEnabled();
  });
});
