// §163 — Find, in a register: a window over the register that lists the
// rows matching what was typed in the field chosen, selects the one you
// click, and leaves it selected when it closes.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import FindInRegisterDialog, { findInRegister } from "./FindInRegisterDialog";
import type { RegisterRow } from "../lib/types";

const base: RegisterRow = {
  id: "",
  date: "2026-08-01",
  payee: "",
  category_name: null,
  category_id: null,
  transfer_account_id: null,
  amount_cents: 0,
  running_balance_cents: 0,
  is_reconciled: false,
  cleared_state: "",
  check_number: null,
  is_void: false,
  notes: null,
  transfer_account_name: null,
  activity: null,
  security_id: null,
  security_name: null,
  shares_micro: null,
  price_micro: null,
  gross_cents: null,
  commission_cents: 0,
  lot_specified: false,
  goal_id: null,
  goal_name: null,
};

const rows: RegisterRow[] = [
  { ...base, id: "t-1", date: "2026-07-04", payee: "Fireworks Depot", category_name: "Leisure : Holidays", amount_cents: -34000, check_number: "1041", notes: "Fourth" },
  { ...base, id: "t-2", date: "2026-07-15", payee: "City Power & Light", category_name: "Bills : Electric", amount_cents: -13400 },
  { ...base, id: "t-3", date: "2026-08-01", payee: "Payroll", category_name: "Salary", amount_cents: 340000 },
  { ...base, id: "t-4", date: "2026-08-02", payee: "Transfer Money", transfer_account_name: "Savings", transfer_account_id: "a-2", amount_cents: -34000 },
];

describe("findInRegister", () => {
  it("any field: payee, category, memo, number, amount and date", () => {
    const ids = (q: string) => findInRegister(rows, q, "any").map((r) => r.id);
    expect(ids("power")).toEqual(["t-2"]);
    expect(ids("electric")).toEqual(["t-2"]);
    expect(ids("fourth")).toEqual(["t-1"]);
    expect(ids("1041")).toEqual(["t-1"]);
    // An amount matches its magnitude exactly — payment, deposit or transfer,
    // and not $1,340.00 or $3,400.00.
    expect(ids("340")).toEqual(["t-1", "t-4"]);
    expect(ids("$340.00")).toEqual(["t-1", "t-4"]);
    expect(ids("7/4/2026")).toEqual(["t-1"]);
    expect(ids("2026-08")).toEqual(["t-3", "t-4"]);
    expect(ids("savings")).toEqual(["t-4"]);
  });

  it("a chosen field looks only there", () => {
    expect(findInRegister(rows, "power", "memo")).toEqual([]);
    expect(findInRegister(rows, "power", "payee").map((r) => r.id)).toEqual(["t-2"]);
    expect(findInRegister(rows, "340", "amount").map((r) => r.id)).toEqual(["t-1", "t-4"]);
    expect(findInRegister(rows, "340", "payee")).toEqual([]);
    expect(findInRegister(rows, "transfer", "category").map((r) => r.id)).toEqual(["t-4"]);
  });

  it("nothing typed finds nothing", () => {
    expect(findInRegister(rows, "  ", "any")).toEqual([]);
  });
});

describe("FindInRegisterDialog", () => {
  function open(selectedId: string | null = null) {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<FindInRegisterDialog accountName="Checking" rows={rows} selectedId={selectedId} onPick={onPick} onClose={onClose} />);
    return { onPick, onClose };
  }

  it("lists the matches and picks the one clicked, staying open", async () => {
    const { onPick, onClose } = open();
    const box = screen.getByLabelText("Find:");
    expect(box).toHaveFocus();
    await userEvent.type(box, "340");
    const table = screen.getByRole("table", { name: "Matches" });
    expect(within(table).getAllByRole("row")).toHaveLength(3); // header + 2
    expect(screen.getByText("2 matches")).toBeInTheDocument();
    await userEvent.click(within(table).getByText("Fireworks Depot"));
    expect(onPick).toHaveBeenCalledWith("t-1");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Find in this register" })).toBeInTheDocument();
  });

  it("Enter and Find next step through the matches from the selected one, wrapping", async () => {
    const { onPick } = open("t-1");
    await userEvent.type(screen.getByLabelText("Find:"), "340{Enter}");
    expect(onPick).toHaveBeenLastCalledWith("t-4");
    expect(screen.getByText("2 matches — on 1")).toBeInTheDocument();
  });

  it("the field select narrows where it looks", async () => {
    open();
    await userEvent.type(screen.getByLabelText("Find:"), "power");
    expect(screen.getByText("1 match")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("in"), "Memo");
    expect(screen.getByText("No match")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Matches" })).not.toBeInTheDocument();
  });

  it("Escape and Close close it without changing the selection", async () => {
    const { onPick, onClose } = open("t-2");
    await userEvent.type(screen.getByLabelText("Find:"), "x{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onPick).not.toHaveBeenCalled();
  });
});
