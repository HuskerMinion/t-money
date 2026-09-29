// @vitest-environment jsdom
// The two things that make a bulk edit safe to press.
//
// The apply itself has long worked. What is under test is the gate: that
// you see every row before it happens, that unticking one really leaves it
// alone, and that the dialog says the change is undoable — because a bulk edit
// over ten years of history is only ever pressed by someone who believes both.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

import ApplyPayeeRulesDialog from "./ApplyPayeeRulesDialog";
import { invokeCalls, resetIpc, setIpcHandlers } from "../test/tauriMock";
import type { PayeeRuleChange } from "../lib/types";

const change = (over: Partial<PayeeRuleChange> = {}): PayeeRuleChange => ({
  transaction_id: "t-1",
  account_name: "Everyday Checking 1234",
  date: "2026-08-02",
  amount_cents: -1549,
  payee: "NETFLIX.COM 866-579-7172 CA",
  new_payee: "Netflix",
  category_name: null,
  new_category_name: "Streaming",
  new_category_id: "c-streaming",
  rule_id: "r-netflix",
  match_text: "netflix",
  ...over,
});

let plan: PayeeRuleChange[] = [];

beforeEach(() => {
  resetIpc();
  plan = [
    change(),
    change({ transaction_id: "t-2", date: "2026-09-02", payee: "NETFLIX.COM 866-579-7172 CA" }),
    change({
      transaction_id: "t-3",
      payee: "AMAZON.COM*2K3 AMZN.COM/BILL",
      new_payee: "Amazon",
      rule_id: "r-amazon",
      match_text: "amazon",
      amount_cents: -6120,
      category_name: "Household",
      new_category_name: "Household",
      new_category_id: null,
    }),
  ];
  setIpcHandlers({
    preview_payee_rules: () => plan,
    apply_payee_rules: () => plan.length,
  });
});

function open(onApplied = vi.fn()) {
  render(<ApplyPayeeRulesDialog onClose={vi.fn()} onApplied={onApplied} />);
  return { user: userEvent.setup(), onApplied };
}

describe("ApplyPayeeRulesDialog", () => {
  it("shows every row with what it says now, grouped by the rule that claimed it", async () => {
    open();
    await screen.findByText(/3 transactions would change/);
    // Both halves of the change: the name it has, and the name it would get.
    expect(screen.getAllByText("NETFLIX.COM 866-579-7172 CA")).toHaveLength(2);
    expect(screen.getByText(/“netflix”/)).toBeInTheDocument();
    expect(screen.getByText(/“amazon”/)).toBeInTheDocument();
    // Grouping is what makes a rule matching too widely obvious.
    expect(screen.getByLabelText("All 2 rows matching netflix")).toBeChecked();
  });

  it("changes nothing on its own", async () => {
    open();
    await screen.findByText(/3 transactions would change/);
    expect(invokeCalls.some((c) => c.cmd === "apply_payee_rules")).toBe(false);
  });

  it("says the change is undoable, because that is why anyone presses it", async () => {
    open();
    await screen.findByText(/would change/);
    expect(screen.getByText(/Ctrl\+Z/)).toBeInTheDocument();
  });

  it("sends only the rows left ticked", async () => {
    const { user } = open();
    await screen.findByText(/3 transactions would change/);
    await user.click(screen.getByLabelText("Rename NETFLIX.COM 866-579-7172 CA on 2026-09-02"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Rename 2" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Rename 2" }));

    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "apply_payee_rules")).toBe(true));
    const args = invokeCalls.find((c) => c.cmd === "apply_payee_rules")!.args as {
      transactionIds: string[];
    };
    expect(args.transactionIds).toEqual(["t-1", "t-3"]);
  });

  it("a rule's whole group can be turned off at once", async () => {
    const { user } = open();
    await screen.findByText(/3 transactions would change/);
    await user.click(screen.getByLabelText("All 2 rows matching netflix"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Rename 1" })).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Rename 1" }));
    const args = invokeCalls.find((c) => c.cmd === "apply_payee_rules")!.args as {
      transactionIds: string[];
    };
    expect(args.transactionIds).toEqual(["t-3"]);
  });

  it("shows a category being FILLED IN, and one that is being left alone", async () => {
    open();
    await screen.findByText(/3 transactions would change/);
    const rows = screen.getAllByRole("row");
    const netflix = rows.find((r) => within(r).queryByText(/NETFLIX/));
    // Empty → Streaming reads as a change...
    expect(netflix?.textContent).toContain("Streaming");
    const amazon = rows.find((r) => within(r).queryByText(/AMAZON/));
    // ...where a category already chosen is shown as it is, with no arrow.
    expect(amazon?.textContent).toContain("Household");
    expect(amazon?.textContent).not.toContain("→");
  });

  it("with nothing to do it says so instead of offering an empty list", async () => {
    plan = [];
    open();
    await screen.findByText(/Nothing to change/);
    expect(screen.getByRole("button", { name: /^Rename 0$/ })).toBeDisabled();
  });
});

describe("Two rules with the same text", () => {
  it("shows each rule's rows under its own heading", async () => {
    // Two rules may share their text when their conditions differ.
    plan = [
      change(),
      change({ transaction_id: "t-9", rule_id: "r-netflix-big", new_payee: "Netflix Premium", amount_cents: -2299 }),
    ];
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    open();
    expect(await screen.findByText("Netflix Premium")).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox", { name: /^All 1 rows matching netflix$/ })).toHaveLength(2);
    expect(spy.mock.calls.some((c) => String(c[0]).includes("same key"))).toBe(false);
    spy.mockRestore();
  });
});
