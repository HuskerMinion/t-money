// The in-place transaction form (§6.1b), on its own. The register's own
// tests drive it through AccountRegister; these pin down what §183 fixed in
// the form itself.
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

import TransactionEditRow, { type LeaveResult, type TransactionDraft } from "./TransactionEditRow";
import { resetIpc } from "../test/tauriMock";
import type { Account, Category, CommonTransaction } from "../lib/types";

const food: Category = { id: "c-food", name: "Food", parent_id: null, kind: "expense", tax_line: null, full_name: "Food", usage_count: 0 };
const savings = { id: "a-sav", name: "Everyday Savings 5678" } as Account;

const template: CommonTransaction = {
  id: "ct-1",
  name: "Rent",
  payee: "Landlord",
  category_id: null,
  category_name: null,
  amount_cents: -120_000,
  check_number: null,
  notes: null,
  usage_count: 1,
  updated_at: "",
  splits: [],
};

function setup(extra: Partial<React.ComponentProps<typeof TransactionEditRow>> = {}) {
  const onCommit = vi.fn(async (_d: TransactionDraft) => {});
  const onCancel = vi.fn();
  render(
    <table>
      <tbody>
        <TransactionEditRow
          categories={[food]}
          transferTargets={[savings]}
          onCommit={onCommit}
          onCancel={onCancel}
          defaultDate="2026-08-03"
          {...extra}
        />
      </tbody>
    </table>
  );
  return { onCommit, onCancel };
}

beforeEach(() => {
  resetIpc();
});

describe("Enter saves once (§183)", () => {
  it("two quick Enters by key write one transaction and open one next line", async () => {
    let finish: () => void = () => {};
    const onCommit = vi.fn((_d: TransactionDraft) => new Promise<void>((r) => (finish = r)));
    const onEntered = vi.fn();
    setup({ onCommit, onEntered });
    await userEvent.type(screen.getByLabelText("Payee"), "Kroger");
    await userEvent.type(screen.getByLabelText("Payment"), "12.34");
    await userEvent.keyboard("{Enter}{Enter}");
    expect(onCommit).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(onEntered).toHaveBeenCalledTimes(1);
  });

  it("leaving while an Enter is still saving waits for that save instead of sending another", async () => {
    let finish: () => void = () => {};
    const onCommit = vi.fn((_d: TransactionDraft) => new Promise<void>((r) => (finish = r)));
    const leaveRef: { current: (() => Promise<LeaveResult>) | null } = { current: null };
    setup({ onCommit, leaveRef });
    await userEvent.type(screen.getByLabelText("Payee"), "Kroger");
    await userEvent.type(screen.getByLabelText("Payment"), "12.34");
    await userEvent.keyboard("{Enter}");
    let result: LeaveResult | undefined;
    await act(async () => {
      const leaving = leaveRef.current!();
      finish();
      result = await leaving;
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(result).toBe("saved");
  });

  it("a failed save can be retried", async () => {
    const onCommit = vi.fn(async (_d: TransactionDraft) => {
      throw new Error("disk full");
    });
    setup({ onCommit });
    await userEvent.type(screen.getByLabelText("Payee"), "Kroger");
    await userEvent.type(screen.getByLabelText("Payment"), "12.34{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
    await userEvent.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledTimes(2);
  });
});

describe("an unreadable date (§183)", () => {
  it("is refused, not saved as the last date that parsed on the way", async () => {
    const { onCommit } = setup();
    const date = screen.getByLabelText("Date");
    await userEvent.clear(date);
    // Passes through 2/29/20, which is a date; 2/29/2027 is not.
    await userEvent.type(date, "2/29/2027");
    await userEvent.type(screen.getByLabelText("Payee"), "Kroger");
    await userEvent.type(screen.getByLabelText("Payment"), "12.34{Enter}");
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Type a date the form can read");
    expect(date).toHaveAttribute("aria-invalid", "true");
  });
});

describe("Common Transactions (§183)", () => {
  async function openMenu() {
    await userEvent.click(screen.getByRole("button", { name: /Common Transactions/ }));
    return screen.findByRole("menu", { name: "Common transactions" });
  }

  it("a template that fails to save says so inside the menu", async () => {
    const onSaveCommon = vi.fn(async () => {
      throw new Error("A common transaction named Rent already exists.");
    });
    setup({ onSaveCommon });
    await userEvent.type(screen.getByLabelText("Payee"), "Landlord");
    const menu = await openMenu();
    await userEvent.click(within(menu).getByRole("menuitem", { name: /Save this one/ }));
    await userEvent.type(screen.getByLabelText("Common transaction name"), "Rent{Enter}");
    expect(onSaveCommon).toHaveBeenCalledTimes(1);
    expect(within(menu).getByRole("alert")).toHaveTextContent("already exists");
    // The name is still there to change.
    expect(screen.getByLabelText("Common transaction name")).toHaveValue("Rent");
  });

  it("a template that fails to remove says so inside the menu", async () => {
    const onDeleteCommon = vi.fn(async () => {
      throw new Error("could not remove it");
    });
    setup({ commonTransactions: [template], onDeleteCommon });
    const menu = await openMenu();
    await userEvent.click(within(menu).getByRole("button", { name: "Remove Rent" }));
    expect(onDeleteCommon).toHaveBeenCalledWith("ct-1");
    expect(await within(menu).findByRole("alert")).toHaveTextContent("could not remove it");
  });

  it("a transfer is refused as a template, before a name is asked for", async () => {
    const onSaveCommon = vi.fn(async () => {});
    setup({ onSaveCommon });
    const category = screen.getByRole("combobox", { name: "Category:" });
    await userEvent.click(category);
    await userEvent.click(await screen.findByText("Transfer : Everyday Savings 5678"));
    const menu = await openMenu();
    await userEvent.click(within(menu).getByRole("menuitem", { name: /Save this one/ }));
    expect(within(menu).getByRole("alert")).toHaveTextContent("A transfer can't be saved as a common transaction");
    expect(screen.queryByLabelText("Common transaction name")).not.toBeInTheDocument();
    expect(onSaveCommon).not.toHaveBeenCalled();
  });
});
