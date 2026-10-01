// Search across accounts: each hit's amount is in its own account's currency.
import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

import SearchResults from "./SearchResults";
import { resetIpc, setIpcHandlers } from "../test/tauriMock";
import { useAccountStore } from "../stores/useAccountStore";
import type { Account, SearchHit } from "../lib/types";

const hit = (over: Partial<SearchHit>): SearchHit => ({
  id: "t-1",
  account_id: "a-chk",
  account_name: "Checking",
  date: "2026-09-02",
  payee: "Cafe",
  category_name: null,
  amount_cents: -1250,
  check_number: null,
  notes: null,
  is_void: false,
  ...over,
});

beforeEach(() => {
  resetIpc();
  useAccountStore.setState({
    accounts: [
      { id: "a-chk", name: "Checking" } as Account,
      { id: "a-eu", name: "Paris Checking", currency: "EUR" } as Account,
    ],
  });
  setIpcHandlers({
    search_transactions: () => [hit({}), hit({ id: "t-2", account_id: "a-eu", account_name: "Paris Checking", amount_cents: -900 })],
  });
});

afterEach(() => useAccountStore.setState({ accounts: [] }));

describe("SearchResults", () => {
  it("writes each hit in its account's currency", async () => {
    render(<SearchResults query="cafe" onOpen={vi.fn()} />);
    const table = await screen.findByRole("table", { name: "Search results" });
    expect(within(table).getByText("($12.50)")).toBeInTheDocument();
    expect(within(table).getByText("(€9.00)")).toBeInTheDocument();
  });
});
