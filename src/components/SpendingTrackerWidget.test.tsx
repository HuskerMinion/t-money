// §183 — the Spending Tracker on Home. A load that failed read as a month
// with no spending in it.
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

import SpendingTrackerWidget from "./SpendingTrackerWidget";
import { useBudgetStore } from "../stores/useBudgetStore";

beforeEach(() => {
  useBudgetStore.setState({ month: "2026-09", summary: [], error: null });
});

describe("§183 — the Spending Tracker says when it could not load", () => {
  it("shows the store's error instead of \"No spending recorded\"", () => {
    useBudgetStore.setState({ error: "database is locked" });
    render(<SpendingTrackerWidget onOpenReport={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/September 2026 could not be loaded: database is locked/);
    expect(screen.queryByText(/No spending recorded/)).not.toBeInTheDocument();
  });

  it("an empty month with no error still says so plainly", () => {
    render(<SpendingTrackerWidget onOpenReport={vi.fn()} />);
    expect(screen.getByText("No spending recorded for September 2026.")).toBeInTheDocument();
  });
});
