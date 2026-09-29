// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => null),
  save: vi.fn(async () => "C:\\Users\\sam\\Checking.qif"),
}));

import ImportSection from "./ImportSection";
import { invokeCalls, resetIpc, setIpcHandlers } from "../test/tauriMock";
import { useAccountStore } from "../stores/useAccountStore";
import type { Account } from "../lib/types";

const checking: Account = {
  id: "acc-1",
  name: "Checking",
  type: "checking",
  balance_cents: 1_000,
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

beforeEach(() => {
  resetIpc();
  setIpcHandlers({ get_all_accounts: () => [checking], export_qif: () => [12, 1] });
  useAccountStore.setState({ accounts: [checking] });
});

describe("Export an account as QIF", () => {
  it("asks where to save, writes, and reports the counts", async () => {
    render(<ImportSection />);
    const button = screen.getByRole("button", { name: "Export…" });
    expect(button).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText("Account to export"), "acc-1");
    await userEvent.click(button);
    await waitFor(() => expect(invokeCalls).toContainEqual({ cmd: "export_qif", args: { accountId: "acc-1", path: "C:\\Users\\sam\\Checking.qif" } }));
    expect(await screen.findByText(/12 transactions written to C:\\Users\\sam\\Checking.qif \(1 void row left out\)/)).toBeInTheDocument();
  });
});
