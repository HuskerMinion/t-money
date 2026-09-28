// §93 — Update value: you type what it is worth, not what it changed by.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

import UpdateValueDialog from "./UpdateValueDialog";
import { invokeCalls, resetIpc, setIpcHandlers } from "../test/tauriMock";
import type { Account } from "../lib/types";

const truck = {
  id: "a-truck",
  name: "Pickup",
  type: "vehicle",
  balance_cents: 1_100_000,
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

describe("UpdateValueDialog (§93)", () => {
  beforeEach(() => {
    resetIpc();
    setIpcHandlers({ set_account_value: () => null });
  });

  it("starts at what it is worth now and previews the change as you type", async () => {
    render(<UpdateValueDialog account={truck} onDone={vi.fn()} onCancel={vi.fn()} />);
    const dlg = screen.getByRole("dialog", { name: "Update value" });

    const box = within(dlg).getByLabelText("It is now worth");
    expect(box).toHaveValue("11,000.00");
    expect(within(dlg).getByText(/No change/)).toBeInTheDocument();

    await userEvent.clear(box);
    await userEvent.type(box, "9000");
    // The user says what it is worth; the fall is worked out for them.
    expect(within(dlg).getByText(/writes a fall of/)).toBeInTheDocument();
    expect(within(dlg).getByText("$2,000.00")).toBeInTheDocument();
  });

  it("sends the value, not the difference", async () => {
    const onDone = vi.fn();
    render(<UpdateValueDialog account={truck} onDone={onDone} onCancel={vi.fn()} />);
    const dlg = screen.getByRole("dialog", { name: "Update value" });

    const box = within(dlg).getByLabelText("It is now worth");
    await userEvent.clear(box);
    await userEvent.type(box, "9000");
    await userEvent.type(within(dlg).getByLabelText("Note"), "KBB private party");
    await userEvent.click(within(dlg).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const call = invokeCalls.find((c) => c.cmd === "set_account_value");
    expect(call?.args.accountId).toBe("a-truck");
    expect(call?.args.valueCents).toBe(900_000);
    expect(call?.args.notes).toBe("KBB private party");
  });

  it("says what a revaluation counts in, so nobody looks for it in spending", () => {
    render(<UpdateValueDialog account={truck} onDone={vi.fn()} onCancel={vi.fn()} />);
    const dlg = screen.getByRole("dialog", { name: "Update value" });
    expect(within(dlg).getByText(/not income and not spending/)).toBeInTheDocument();
  });
});

describe("§183 — Update value and the Edit menu", () => {
  beforeEach(() => {
    resetIpc();
    setIpcHandlers({ set_account_value: () => null, undo_status: () => ({ undo: "update a value", redo: null }) });
  });

  it("asks for the undo label again once the value is written", async () => {
    const onDone = vi.fn();
    render(<UpdateValueDialog account={truck} onDone={onDone} onCancel={vi.fn()} />);
    const dlg = screen.getByRole("dialog", { name: "Update value" });
    const box = within(dlg).getByLabelText("It is now worth");
    await userEvent.clear(box);
    await userEvent.type(box, "9000");
    await userEvent.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const cmds = invokeCalls.map((c) => c.cmd);
    expect(cmds.indexOf("undo_status")).toBeGreaterThan(cmds.indexOf("set_account_value"));
  });
});
