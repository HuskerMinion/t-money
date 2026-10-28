// @vitest-environment jsdom
// The Home favorites card: a right-click offers the account's actions.
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

import FavoriteAccountsWidget from "./FavoriteAccountsWidget";
import { resetIpc } from "../test/tauriMock";
import { useAccountStore } from "../stores/useAccountStore";
import type { Account } from "../lib/types";

const checking: Account = {
  id: "a-1", name: "Checking", type: "checking", balance_cents: 1000, holdings_value_cents: 0, tax_included: true,
  is_favorite: true, is_closed: false, updated_at: "", institution: null, account_number: null,
  routing_number: null, opened_on: null, credit_limit_cents: null, contact_phone: null,
  contact_email: null, website: null, address: null, account_notes: null,
};

beforeEach(() => {
  resetIpc();
  useAccountStore.setState({ favorites: [checking] });
});

describe("the favorite accounts card context menu", () => {
  it("opens the register", async () => {
    const onOpen = vi.fn();
    render(<FavoriteAccountsWidget onOpen={onOpen} />);
    const row = screen.getByRole("button", { name: "Open Checking" });
    fireEvent.contextMenu(row);
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Open register", "Remove from favorites"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "Open register" }));
    expect(onOpen).toHaveBeenCalledWith("a-1");
  });

  it("Shift+F10 or the Menu key (a contextmenu with no pointer position) opens it too", () => {
    render(<FavoriteAccountsWidget />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Open Checking" }), { clientX: 0, clientY: 0 });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Open register", "Remove from favorites"]);
  });

  it("removes the account from favorites", async () => {
    const toggle = vi.fn(async () => {});
    useAccountStore.setState({ toggleFavorite: toggle });
    render(<FavoriteAccountsWidget />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Open Checking" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Remove from favorites" }));
    expect(toggle).toHaveBeenCalledWith("a-1");
  });
});

describe("a favorite that cannot be changed", () => {
  it("says so in the app-wide notice instead of doing nothing", async () => {
    useAccountStore.setState({ toggleFavorite: vi.fn(async () => { throw "database is locked"; }), error: null });
    render(<FavoriteAccountsWidget />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Open Checking" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Remove from favorites" }));
    await vi.waitFor(() => expect(useAccountStore.getState().error).toBe("Could not change favorites: database is locked"));
  });
});
