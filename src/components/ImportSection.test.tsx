// @vitest-environment jsdom
// §183 — the Import card and the dialogs it opens.
//
// The review dialogs were drawn inside the card's <form>, so Enter in one of
// their fields was the form's implicit submission and started the import over
// from under the dialog still asking about it. And an import that created
// categories left the pickers without them until the file was reopened.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: async () => "C:/Users/sam/plan.qif",
  save: async () => null,
}));

import ImportSection from "./ImportSection";
import { invokeCalls, resetIpc, setIpcHandlers } from "../test/tauriMock";
import { useAccountStore } from "../stores/useAccountStore";
import type { Account, ImportMatchPreview } from "../lib/types";

const plan401k: Account = {
  id: "acc-401k",
  name: "401(k)",
  type: "retirement",
  balance_cents: 0,
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

const empty: ImportMatchPreview = {
  account_id: "acc-401k",
  account_name: "401(k)",
  total_rows: 2,
  duplicates: 0,
  unreadable: 0,
  new_rows: 2,
  window_days: 3,
  uncategorized: [],
  rows: [],
  memo_groups: [],
};

const withMemos: ImportMatchPreview = {
  ...empty,
  memo_groups: [
    {
      memo: "EMPLOYEE DEFERRAL",
      action: "Buy",
      activity: "buy",
      count: 2,
      gross_cents: 50_000,
      shares_micro: 0,
      guess: "contribution",
      allowed: ["as_is", "contribution"],
      default_category: "Retirement Contributions",
    },
  ],
};

const summary = {
  account_id: "acc-401k",
  account_name: "401(k)",
  imported: 2,
  skipped: 0,
  duplicates: 0,
  balance_delta_cents: 0,
  investments: 2,
  securities_created: 0,
  transfers_linked: 0,
  matched: 0,
  user_skipped: 0,
  notes: [],
};

beforeEach(() => {
  resetIpc();
  useAccountStore.setState({ accounts: [plan401k], selectedAccountId: null, categories: [] });
});

async function chooseAndImport() {
  render(<ImportSection />);
  await userEvent.selectOptions(screen.getByLabelText("Target account"), "acc-401k");
  await userEvent.click(screen.getByRole("button", { name: /Choose file/ }));
  await screen.findByText("plan.qif");
  await userEvent.click(screen.getByRole("button", { name: "Import" }));
}

describe("§183 — the Import card", () => {
  it("does not start the import again when Enter is pressed in a dialog's field", async () => {
    setIpcHandlers({
      get_all_accounts: () => [plan401k],
      list_categories: () => [],
      preview_import: () => withMemos,
      get_ui_setting: () => null,
      set_ui_setting: () => null,
    });
    await chooseAndImport();
    const dlg = await screen.findByRole("dialog", { name: "What the memos mean" });
    const box = within(dlg).getByLabelText("Category for EMPLOYEE DEFERRAL on Buy");
    await userEvent.type(box, " : Match{Enter}");
    // The dialog is still asking, and the file was read once.
    expect(screen.getByRole("dialog", { name: "What the memos mean" })).toBeInTheDocument();
    expect(invokeCalls.filter((c) => c.cmd === "preview_import")).toHaveLength(1);
  });

  it("reloads the categories after an import, since an import can create them", async () => {
    setIpcHandlers({
      get_all_accounts: () => [plan401k],
      list_categories: () => [],
      list_payees: () => [],
      undo_status: () => ({ undo: null, redo: null }),
      preview_import: () => empty,
      import_qif_ofx: () => summary,
    });
    await chooseAndImport();
    expect(await screen.findByText("Imported into 401(k)")).toBeInTheDocument();
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "undo_status")).toBe(true));
    const imported = invokeCalls.findIndex((c) => c.cmd === "import_qif_ofx");
    expect(invokeCalls.slice(imported).some((c) => c.cmd === "list_categories")).toBe(true);
  });
});
