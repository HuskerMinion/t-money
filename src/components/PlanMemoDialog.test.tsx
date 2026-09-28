// §90 — the memo dialog: the guess is shown per memo, the user can overrule
// it, and the rules come back for the import.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

import { invokeCalls, resetIpc, setIpcHandlers } from "../test/tauriMock";
import PlanMemoDialog from "./PlanMemoDialog";
import type { ImportMatchPreview } from "../lib/types";

const preview: ImportMatchPreview = {
  account_id: "a",
  account_name: "401(k)",
  total_rows: 0,
  duplicates: 0,
  unreadable: 0,
  new_rows: 0,
  window_days: 3,
  uncategorized: [],
  rows: [],
  memo_groups: [
    {
      memo: "EMPLOYEE DEFERRAL",
      action: "Buy",
      activity: "buy",
      count: 24,
      gross_cents: 946_646,
      shares_micro: 0,
      guess: "contribution",
      allowed: ["as_is", "contribution", "reinvest"],
      default_category: "Retirement Contributions",
    },
    {
      memo: "Fees",
      action: "ShrsOut",
      activity: "remove_shares",
      count: 12,
      gross_cents: 18_010,
      shares_micro: 0,
      guess: "fee",
      allowed: ["as_is", "fee"],
      default_category: "Investment Fees",
    },
    {
      memo: "Rebalance",
      action: "Buy",
      activity: "buy",
      count: 3,
      gross_cents: 5_000,
      shares_micro: 0,
      guess: "as_is",
      allowed: ["as_is", "contribution", "reinvest"],
      default_category: null,
    },
  ],
};

describe("PlanMemoDialog (§90)", () => {
  beforeEach(() => {
    resetIpc();
    setIpcHandlers({ get_ui_setting: () => null, set_ui_setting: () => null });
  });

  it("shows each memo with what the file calls it, the guess, and the category it would use", async () => {
    const onConfirm = vi.fn();
    render(<PlanMemoDialog preview={preview} onConfirm={onConfirm} onCancel={vi.fn()} />);
    const dlg = screen.getByRole("dialog", { name: "What the memos mean" });

    expect(within(dlg).getByLabelText("Treat EMPLOYEE DEFERRAL on Buy as")).toHaveValue("contribution");
    expect(within(dlg).getByLabelText("Treat Fees on ShrsOut as")).toHaveValue("fee");
    // A memo that says nothing recognizable is left alone, not guessed at.
    expect(within(dlg).getByLabelText("Treat Rebalance on Buy as")).toHaveValue("as_is");
    expect(within(dlg).getByLabelText("Category for EMPLOYEE DEFERRAL on Buy")).toHaveValue("Retirement Contributions");
    // A share removal cannot be a contribution.
    const fees = within(dlg).getByLabelText("Treat Fees on ShrsOut as");
    expect(within(fees).getAllByRole("option").map((o) => o.textContent)).toEqual(["Leave as it is", "Fee"]);

    await userEvent.click(within(dlg).getByRole("button", { name: "Import" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(onConfirm).toHaveBeenCalledWith([
      { memo: "EMPLOYEE DEFERRAL", activity: "buy", treatment: "contribution", category: "Retirement Contributions" },
      { memo: "Fees", activity: "remove_shares", treatment: "fee", category: "Investment Fees" },
      { memo: "Rebalance", activity: "buy", treatment: "as_is", category: null },
    ]);
  });

  it("takes an overruled treatment and an edited category", async () => {
    const onConfirm = vi.fn();
    render(<PlanMemoDialog preview={preview} onConfirm={onConfirm} onCancel={vi.fn()} />);
    const dlg = screen.getByRole("dialog", { name: "What the memos mean" });

    await userEvent.selectOptions(within(dlg).getByLabelText("Treat Rebalance on Buy as"), "contribution");
    const box = within(dlg).getByLabelText("Category for Rebalance on Buy");
    await userEvent.clear(box);
    await userEvent.type(box, "Retirement Contributions : Employer Match");

    await userEvent.click(within(dlg).getByRole("button", { name: "Import" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(onConfirm.mock.calls[0][0][2]).toEqual({
      memo: "Rebalance",
      activity: "buy",
      treatment: "contribution",
      category: "Retirement Contributions : Employer Match",
    });
  });

  it("remembers the answers per account, so the next 90-day statement arrives answered", async () => {
    // Some plans only allow downloading 90 days at a time, so this file is
    // the fourth of its kind and has been answered three times already.
    setIpcHandlers({
      get_ui_setting: () => JSON.stringify([{ memo: "Rebalance", activity: "buy", treatment: "contribution", category: "Retirement Contributions : Employer Match" }]),
      set_ui_setting: () => null,
    });
    const onConfirm = vi.fn();
    render(<PlanMemoDialog preview={preview} onConfirm={onConfirm} onCancel={vi.fn()} />);
    const dlg = screen.getByRole("dialog", { name: "What the memos mean" });

    await waitFor(() => expect(within(dlg).getByLabelText("Treat Rebalance on Buy as")).toHaveValue("contribution"));
    expect(within(dlg).getByLabelText("Category for Rebalance on Buy")).toHaveValue("Retirement Contributions : Employer Match");
    expect(within(dlg).getByText(/answers you gave for this account last time/)).toBeInTheDocument();
    // The memos it says nothing about keep their guess.
    expect(within(dlg).getByLabelText("Treat Fees on ShrsOut as")).toHaveValue("fee");

    await userEvent.click(within(dlg).getByRole("button", { name: "Import" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    const saved = invokeCalls.find((c) => c.cmd === "set_ui_setting");
    expect(saved?.args.key).toBe("plan.memoRules.a");
    expect(JSON.parse(String(saved?.args.value))).toHaveLength(3);
  });
});

describe("§183 — one Import is one import", () => {
  beforeEach(() => resetIpc());

  it("stays disabled while the answers are being remembered, so a second click does not import twice", async () => {
    let answer: (v: null) => void = () => {};
    setIpcHandlers({
      get_ui_setting: () => null,
      set_ui_setting: () => new Promise<null>((r) => (answer = r)),
    });
    const onConfirm = vi.fn();
    render(<PlanMemoDialog preview={preview} onConfirm={onConfirm} onCancel={vi.fn()} />);
    const dlg = screen.getByRole("dialog", { name: "What the memos mean" });
    await userEvent.click(within(dlg).getByRole("button", { name: "Import" }));
    const busy = within(dlg).getByRole("button", { name: "Importing…" });
    expect(busy).toBeDisabled();
    await userEvent.click(busy);
    answer(null);
    await waitFor(() => expect(onConfirm).toHaveBeenCalled());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(invokeCalls.filter((c) => c.cmd === "set_ui_setting")).toHaveLength(1);
  });
});
