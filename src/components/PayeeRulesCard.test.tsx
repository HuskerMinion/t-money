// §84 / §171 — rename rules. §183: an amount limit that is not an amount is
// refused, and Apply to existing tells the Edit menu.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

import PayeeRulesCard from "./PayeeRulesCard";
import { invokeCalls, resetIpc, setIpcHandlers } from "../test/tauriMock";
import { useAccountStore } from "../stores/useAccountStore";

const rule = { id: "r-1", match_text: "NETFLIX", payee_name: "Netflix", category_id: null, category_name: null, created_at: "" };

describe("PayeeRulesCard (§183)", () => {
  beforeEach(() => {
    resetIpc();
    useAccountStore.setState({ accounts: [] });
    setIpcHandlers({
      list_payee_rules: () => [rule],
      create_payee_rule: () => rule,
      apply_payee_rules: () => 3,
      undo_status: () => ({ undo: "rename payees", redo: null }),
    });
  });

  it("refuses an amount limit it cannot read instead of saving the rule with no limit", async () => {
    render(<PayeeRulesCard categories={[]} />);
    const card = await screen.findByRole("region", { name: "Payee rename rules" });
    await userEvent.type(within(card).getByLabelText("Contains"), "AMAZON");
    await userEvent.type(within(card).getByLabelText("Call it"), "Amazon");
    await userEvent.type(within(card).getByLabelText("Amount at least"), "5,OO");
    await userEvent.click(within(card).getByRole("button", { name: "Add rule" }));
    expect(await within(card).findByText(/"5,OO" is not an amount/)).toBeInTheDocument();
    expect(invokeCalls.some((c) => c.cmd === "create_payee_rule")).toBe(false);

    await userEvent.clear(within(card).getByLabelText("Amount at least"));
    await userEvent.type(within(card).getByLabelText("Amount at most"), "twenty");
    await userEvent.click(within(card).getByRole("button", { name: "Add rule" }));
    expect(await within(card).findByText(/"twenty" is not an amount/)).toBeInTheDocument();
    expect(invokeCalls.some((c) => c.cmd === "create_payee_rule")).toBe(false);
    // What was typed is still there to fix.
    expect(within(card).getByLabelText("Contains")).toHaveValue("AMAZON");
  });

  it("Apply to existing asks for the undo label once the rows are renamed", async () => {
    const onApplied = vi.fn();
    render(<PayeeRulesCard categories={[]} onApplied={onApplied} />);
    const card = await screen.findByRole("region", { name: "Payee rename rules" });
    await waitFor(() => expect(within(card).getByRole("button", { name: "Apply to existing transactions" })).toBeEnabled());
    await userEvent.click(within(card).getByRole("button", { name: "Apply to existing transactions" }));
    await waitFor(() => expect(onApplied).toHaveBeenCalledWith(3));
    const cmds = invokeCalls.map((c) => c.cmd);
    expect(cmds.indexOf("undo_status")).toBeGreaterThan(cmds.indexOf("apply_payee_rules"));
  });
});
