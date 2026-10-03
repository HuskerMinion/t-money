// On a Mac the menu is the system's: the in-window bar draws nothing and
// hands the same table to the native menu instead.
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const applyMacMenu = vi.fn(() => Promise.resolve());
vi.mock("../lib/macMenu", () => ({ applyMacMenu: (...a: unknown[]) => applyMacMenu(...(a as [])) }));
vi.mock("../lib/keyStore", async (orig) => ({ ...(await orig<typeof import("../lib/keyStore")>()), platform: () => "mac" }));

import MenuBar from "./MenuBar";
import { buildMenus } from "../lib/menus";

const menus = buildMenus({
  favoriteAccounts: [],
  savedReports: [],
  openAccount: () => {},
  openReport: () => {},
  recentFiles: [],
  openFile: () => {},
  undoLabel: null,
  redoLabel: null,
  forgetMissingFiles: () => {},
});

describe("MenuBar on a Mac", () => {
  it("draws no bar and builds the native menu from the same table", () => {
    render(<MenuBar menus={menus} />);
    expect(screen.queryByRole("menubar")).toBeNull();
    expect(applyMacMenu).toHaveBeenCalledWith(menus);
  });
});
