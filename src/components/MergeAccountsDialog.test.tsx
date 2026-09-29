// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

import MergeAccountsDialog from "./MergeAccountsDialog";
import { invokeCalls, resetIpc, setIpcHandlers } from "../test/tauriMock";
import type { Account, MergeSummary } from "../lib/types";

function acct(id: string, name: string, type: Account["type"], balance_cents: number): Account {
  return {
    id,
    name,
    type,
    balance_cents,
    holdings_value_cents: 0,
    tax_included: true,
    is_favorite: false,
    is_closed: false,
    updated_at: "2026-08-30T00:00:00Z",
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
}

const accounts = [acct("a-sav", "Savings", "savings", 500_000), acct("a-chk", "Checking", "checking", 100_000), acct("a-dup", "Checking (2)", "checking", 8_000)];

const plan: MergeSummary = { moved: 2, duplicates: 1, left_behind: 1, self_transfers: 1, statements: 0, recurrences: 1, goals: 0, balance_cents: -2_000 };

beforeEach(() => {
  resetIpc();
  setIpcHandlers({
    merge_accounts: (args) => (args.afterLast ? { ...plan, moved: 1, left_behind: 2 } : plan),
  });
});

describe("Merge accounts", () => {
  it("offers the same-type account first, previews with a dry run, then merges", async () => {
    const onMerged = vi.fn();
    render(<MergeAccountsDialog from={accounts[2]} accounts={accounts} onCancel={() => {}} onMerged={onMerged} />);
    const into = screen.getByLabelText("Merge into") as HTMLSelectElement;
    expect(into.value).toBe("a-chk");
    expect(into.options[1].value).toBe("a-sav");
    // The dry run ran and the plan is on screen.
    await waitFor(() => expect(screen.getByText(/transactions move/)).toBeInTheDocument());
    const first = invokeCalls.find((c) => c.cmd === "merge_accounts")!.args;
    expect(first).toEqual({ intoId: "a-chk", fromId: "a-dup", afterLast: false, dryRun: true });
    expect(screen.getByText(/1 already there/)).toBeInTheDocument();
    expect(screen.getByText(/1 transfer between the two accounts/)).toBeInTheDocument();
    expect(screen.getByText(/1 bill/)).toBeInTheDocument();
    expect(screen.getByText("($20.00)")).toBeInTheDocument();

    // Switching the mode re-plans.
    await userEvent.click(screen.getByLabelText(/Only transactions after/));
    await waitFor(() => expect(screen.getByText(/2 left behind/)).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "Merge" }));
    await waitFor(() => expect(onMerged).toHaveBeenCalled());
    const calls = invokeCalls.filter((c) => c.cmd === "merge_accounts");
    const real = calls[calls.length - 1].args;
    expect(real).toEqual({ intoId: "a-chk", fromId: "a-dup", afterLast: true, dryRun: false });
    expect(onMerged.mock.calls[0][0].id).toBe("a-chk");
  });

  it("warns when the kept account is a different type", async () => {
    render(<MergeAccountsDialog from={accounts[2]} accounts={accounts} onCancel={() => {}} onMerged={() => {}} />);
    await userEvent.selectOptions(screen.getByLabelText("Merge into"), "a-sav");
    expect(screen.getByText(/is a checking account and Savings is savings/)).toBeInTheDocument();
  });
});
