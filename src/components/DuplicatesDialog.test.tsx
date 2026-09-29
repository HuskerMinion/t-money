// The duplicate finder lists sets and deletes only what is clicked.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

import DuplicatesDialog from "./DuplicatesDialog";
import { invokeCalls, resetIpc, setIpcHandlers } from "../test/tauriMock";

describe("DuplicatesDialog", () => {
  beforeEach(() => resetIpc());

  it("shows the sets for the chosen window and deletes the clicked row", async () => {
    let rows = [
      { id: "t-1", date: "2026-09-02", cleared_state: "R", category_name: "Streaming", notes: "statement", fitid: "F1", check_number: null, is_transfer: false },
      { id: "t-2", date: "2026-09-04", cleared_state: "", category_name: null, notes: null, fitid: null, check_number: null, is_transfer: false },
    ];
    setIpcHandlers({
      find_duplicates: (args) => (args.windowDays === 0 ? [] : rows.length > 1 ? [{ date: "2026-09-02", payee: "Netflix", amount_cents: -1549, rows }] : []),
    });
    const onDelete = vi.fn(async (id: string) => {
      rows = rows.filter((r) => r.id !== id);
    });
    render(<DuplicatesDialog accountId="a-1" accountName="Checking" onDelete={onDelete} onClose={vi.fn()} />);
    expect(await screen.findByRole("status")).toHaveTextContent("No duplicates found.");
    await userEvent.selectOptions(screen.getByLabelText("Date window"), "3");
    const table = await screen.findByRole("table", { name: "Duplicates of Netflix on 9/2/2026" });
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    await userEvent.click(within(table).getByRole("button", { name: "Delete Netflix 9/4/2026" }));
    expect(onDelete).toHaveBeenCalledWith("t-2");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("No duplicates found."));
    expect(invokeCalls.filter((c) => c.cmd === "find_duplicates").map((c) => c.args.windowDays)).toEqual([0, 3, 3]);
  });
});

describe("A refused delete", () => {
  beforeEach(() => resetIpc());

  it("is shown beside Close, outside the scrolling list", async () => {
    const rows = [
      { id: "t-1", date: "2026-09-02", cleared_state: "R", category_name: null, notes: null, fitid: null, check_number: null, is_transfer: false },
      { id: "t-2", date: "2026-09-02", cleared_state: "", category_name: null, notes: null, fitid: null, check_number: null, is_transfer: false },
    ];
    setIpcHandlers({ find_duplicates: () => [{ date: "2026-09-02", payee: "Netflix", amount_cents: -1549, rows }] });
    const onDelete = vi.fn(async () => {
      throw "this row belongs to a split in Demo Checking";
    });
    render(<DuplicatesDialog accountId="a-1" accountName="Checking" onDelete={onDelete} onClose={vi.fn()} />);
    const table = await screen.findByRole("table", { name: "Duplicates of Netflix on 9/2/2026" });
    await userEvent.click(within(table).getAllByRole("button", { name: /^Delete Netflix/ })[1]);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("this row belongs to a split in Demo Checking");
    expect(alert.closest("[style*='overflow']")).toBeNull();
    expect(alert.nextElementSibling).toContainElement(screen.getByRole("button", { name: "Close" }));
  });
});
