// Change account details (migration 0010) — the institution/contact record.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));
// §170 — the attachments section uses the system file dialog.
const dialog = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: dialog.open, save: dialog.save }));

import AccountDetailsDialog, { accountSubtitle, maskNumber } from "./AccountDetailsDialog";
import { invokeCalls, resetIpc, setIpcHandlers } from "../test/tauriMock";
import type { Account, Attachment } from "../lib/types";

const account: Account = {
  id: "acc-1",
  name: "Everyday Checking 1234",
  type: "checking",
  balance_cents: 830207,
  holdings_value_cents: 0, tax_included: true,
  is_favorite: true,
  is_closed: false,
  updated_at: "2026-08-30T00:00:00Z",
  institution: "First National",
  account_number: "1234567890",
  routing_number: null,
  opened_on: null,
  credit_limit_cents: null,
  contact_phone: null,
  contact_email: null,
  website: null,
  address: null,
  account_notes: null,
};

describe("maskNumber", () => {
  it("leaves only the last four digits visible", () => {
    expect(maskNumber("1234567890")).toBe("••••••7890");
  });

  it("does not mask a value too short to have a hidden part", () => {
    expect(maskNumber("1234")).toBe("1234");
    expect(maskNumber("")).toBe("");
  });
});

describe("accountSubtitle", () => {
  it("combines type, institution and a masked number", () => {
    expect(accountSubtitle(account)).toBe("Checking · First National · ••••••7890");
  });

  it("omits what is missing", () => {
    expect(accountSubtitle({ ...account, institution: null, account_number: null })).toBe(
      "Checking"
    );
  });
});

describe("<AccountDetailsDialog />", () => {
  it("hides the account number until Show is pressed", async () => {
    render(<AccountDetailsDialog account={account} onSave={vi.fn()} onCancel={vi.fn()} />);
    const field = screen.getByLabelText("Account number:") as HTMLInputElement;
    expect(field.type).toBe("password");
    await userEvent.click(screen.getByRole("button", { name: "Show" }));
    expect((screen.getByLabelText("Account number:") as HTMLInputElement).type).toBe("text");
  });

  it("never offers the balance for editing — it is derived", () => {
    render(<AccountDetailsDialog account={account} onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByLabelText(/Balance:/)).not.toBeInTheDocument();
    expect(screen.getByText(/derived from the register, not edited here/)).toBeInTheDocument();
  });

  it("only offers a credit limit for credit-shaped accounts", async () => {
    render(<AccountDetailsDialog account={account} onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByLabelText("Credit limit:")).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Type:"), "credit");
    expect(screen.getByLabelText("Credit limit:")).toBeInTheDocument();
  });

  it("saves the edited fields, blanking empties to null", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<AccountDetailsDialog account={account} onSave={onSave} onCancel={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Phone:"), "555-0100");
    await userEvent.type(screen.getByLabelText("Website:"), "https://www.firstnational.example");
    await userEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "acc-1",
        institution: "First National",
        contact_phone: "555-0100",
        website: "https://www.firstnational.example",
        contact_email: null,
        address: null,
      })
    );
  });

  // §81: an investment account can round its holding values its own way.
  it("offers Holding values only for investment/retirement accounts and writes a change through its own command", async () => {
    resetIpc();
    setIpcHandlers({ set_account_value_rounding: async () => undefined });
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { unmount } = render(<AccountDetailsDialog account={account} onSave={onSave} onCancel={vi.fn()} />);
    expect(screen.queryByLabelText("Holding value rounding")).toBeNull();
    unmount();
    render(<AccountDetailsDialog account={{ ...account, type: "retirement", value_rounding: null }} onSave={onSave} onCancel={vi.fn()} />);
    const sel = screen.getByLabelText("Holding value rounding") as HTMLSelectElement;
    expect(sel.value).toBe("");
    await userEvent.selectOptions(sel, "down");
    await userEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(onSave).toHaveBeenCalled();
    expect(invokeCalls.filter((c) => c.cmd === "set_account_value_rounding")).toEqual([{ cmd: "set_account_value_rounding", args: { id: "acc-1", rounding: "down" } }]);
  });

  it("refuses to save a blank name", async () => {
    const onSave = vi.fn();
    render(<AccountDetailsDialog account={account} onSave={onSave} onCancel={vi.fn()} />);
    await userEvent.clear(screen.getByLabelText("Name:"));
    await userEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(screen.getByText("Enter a name for the account.")).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("can mark an account closed", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<AccountDetailsDialog account={account} onSave={onSave} onCancel={vi.fn()} />);
    await userEvent.click(screen.getByLabelText("Account is closed"));
    await userEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ is_closed: true }));
  });

  it("surfaces a save failure instead of closing silently", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("database is locked"));
    render(<AccountDetailsDialog account={account} onSave={onSave} onCancel={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(await screen.findByText(/database is locked/)).toBeInTheDocument();
  });
});

// §170, walk step A4 (2026-09-13): "it didn't show the attachments until I
// clicked OK … and when I click remove they don't go away until the pop-up
// is closed and reopened." The panel reloads its list after every add and
// remove, so the open dialog must show the change at once.
describe("attachments on the account (§170, A4)", () => {
  it("lists a file the moment it is attached, and drops it the moment it is removed", async () => {
    resetIpc();
    let list: Attachment[] = [];
    setIpcHandlers({
      list_attachments: () => list,
      add_attachment: (args) => {
        const a: Attachment = { id: `at-${list.length + 1}`, transaction_id: null, account_id: String(args.accountId), name: String(args.path).split("/").pop()!, mime: "application/pdf", size_bytes: 1024, added_at: "2026-09-13T10:00:00" };
        list = [...list, a];
        return a;
      },
      remove_attachment: (args) => {
        list = list.filter((a) => a.id !== args.id);
        return undefined;
      },
    });
    render(<AccountDetailsDialog account={account} onSave={vi.fn()} onCancel={vi.fn()} />);
    await screen.findByText(/Nothing attached yet/);
    dialog.open.mockResolvedValue(["C:/scans/statement.pdf"]);
    await userEvent.click(screen.getByRole("button", { name: "Attach a file…" }));
    await screen.findByRole("button", { name: "Remove statement.pdf" });
    expect(invokeCalls.find((c) => c.cmd === "add_attachment")!.args).toEqual({ transactionId: null, accountId: "acc-1", path: "C:/scans/statement.pdf" });
    await userEvent.click(screen.getByRole("button", { name: "Remove statement.pdf" }));
    await screen.findByText(/Nothing attached yet/);
    expect(screen.queryByRole("button", { name: "Remove statement.pdf" })).not.toBeInTheDocument();
  });
});

// §183 — rounding and "Secured by" were written after `onSave` had already
// reloaded and closed the dialog, so a refusal landed on nothing.
describe("§183 — every write happens before the dialog closes", () => {
  const loan: Account = { ...account, id: "loan-1", name: "Car loan", type: "loan", balance_cents: -1_200_000 };
  const house: Account = { ...account, id: "house-1", name: "House", type: "home", balance_cents: 30_000_000 };

  it("writes Secured by after the details, then calls onSaved", async () => {
    resetIpc();
    const order: string[] = [];
    setIpcHandlers({ set_account_security: async () => void order.push("security") });
    const onSave = vi.fn(async () => void order.push("details"));
    const onSaved = vi.fn(() => void order.push("closed"));
    render(<AccountDetailsDialog account={loan} assets={[house]} onSave={onSave} onSaved={onSaved} onCancel={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText("Secured by"), "house-1");
    await userEvent.click(screen.getByRole("button", { name: "OK" }));
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(order).toEqual(["details", "security", "closed"]);
  });

  it("a refused Secured by keeps the dialog open, with the reason", async () => {
    resetIpc();
    setIpcHandlers({
      set_account_security: async () => {
        throw "a debt is secured on a house, a vehicle or another asset";
      },
    });
    const onSaved = vi.fn();
    render(<AccountDetailsDialog account={loan} assets={[house]} onSave={vi.fn().mockResolvedValue(undefined)} onSaved={onSaved} onCancel={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText("Secured by"), "house-1");
    await userEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/secured on a house/);
    expect(onSaved).not.toHaveBeenCalled();
  });
});
