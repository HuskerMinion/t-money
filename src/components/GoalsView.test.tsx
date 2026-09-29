// Goals that watch an account: the breakdown, linking, contributing.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

import GoalsView from "./GoalsView";
import { invokeCalls, resetIpc, setIpcHandlers } from "../test/tauriMock";
import { useAccountStore } from "../stores/useAccountStore";
import type { Goal } from "../lib/types";

const roof: Goal = {
  id: "g-roof",
  name: "New Roof",
  target_cents: 1_800_000,
  saved_cents: 700_000,
  deadline: "2027-03-01",
  notes: null,
  updated_at: "",
  account_id: "a-sav",
  account_name: "Savings",
  starting_cents: 640_000,
  linked_cents: 60_000,
  linked_count: 3,
};
const cruise: Goal = { ...roof, id: "g-cruise", name: "Alaska cruise", target_cents: 900_000, saved_cents: 215_000, account_id: null, account_name: null, starting_cents: 215_000, linked_cents: 0, linked_count: 0 };

const accounts = [
  { id: "a-chk", name: "Checking", is_closed: false },
  { id: "a-sav", name: "Savings", is_closed: false },
];

beforeEach(() => {
  resetIpc();
  setIpcHandlers({
    list_goals: () => [cruise, roof],
    get_all_accounts: () => accounts,
    contribute_to_goal: () => ({ ...roof, saved_cents: 720_000, linked_cents: 80_000, linked_count: 4 }),
    update_goal: (a) => ({ ...cruise, account_id: a.accountId ?? null }),
  });
  useAccountStore.setState({ accounts: [] });
});

describe("a goal that watches an account", () => {
  it("shows what it watches and how the number was reached", async () => {
    render(<GoalsView />);
    const row = (await screen.findByText("New Roof")).closest("tr")!;
    expect(within(row).getByText("watches Savings")).toBeInTheDocument();
    expect(within(row).getByTitle(/\$6,400.00 to start \+ \$600.00 from 3 tagged rows in Savings/)).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Contribute…" })).toBeInTheDocument();
    const plain = screen.getByText("Alaska cruise").closest("tr")!;
    expect(within(plain).queryByRole("button", { name: "Contribute…" })).toBeNull();
  });

  it("Contribute… writes a tagged transfer from the chosen account", async () => {
    render(<GoalsView />);
    await screen.findByText("New Roof");
    await userEvent.click(screen.getByRole("button", { name: "Contribute…" }));
    await userEvent.click(screen.getByRole("button", { name: "Move to Savings" }));
    expect(screen.getByText("Pick the account the money comes from.")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("From account"), "a-chk");
    await userEvent.type(screen.getByLabelText("Contribution"), "200");
    await userEvent.click(screen.getByRole("button", { name: "Move to Savings" }));
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "contribute_to_goal")).toBe(true));
    expect(invokeCalls.find((c) => c.cmd === "contribute_to_goal")!.args).toMatchObject({ goalId: "g-roof", fromAccountId: "a-chk", amountCents: 20_000 });
  });

  it("editing offers the account to watch and sends it", async () => {
    render(<GoalsView />);
    await screen.findByText("Alaska cruise");
    await userEvent.click(within(screen.getByText("Alaska cruise").closest("tr")!).getByRole("button", { name: "Edit" }));
    await userEvent.selectOptions(screen.getByLabelText("Watches account"), "a-sav");
    expect(screen.getByText("Starting amount (before the tagged rows)")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "update_goal")).toBe(true));
    expect(invokeCalls.find((c) => c.cmd === "update_goal")!.args).toMatchObject({ id: "g-cruise", accountId: "a-sav", savedCents: 215_000 });
  });
});

describe("Contribute… for one goal, then another", () => {
  it("does not carry the From account into another goal's form", async () => {
    const car: Goal = { ...roof, id: "g-car", name: "New car", account_id: "a-chk", account_name: "Checking" };
    setIpcHandlers({
      list_goals: () => [roof, car],
      get_all_accounts: () => [...accounts, { id: "a-mm", name: "Money market", is_closed: false }],
      contribute_to_goal: () => car,
    });
    render(<GoalsView />);
    const roofRow = (await screen.findByText("New Roof")).closest("tr")!;
    await userEvent.click(within(roofRow).getByRole("button", { name: "Contribute…" }));
    // Checking is the car goal's own account — the one its form leaves out.
    await userEvent.selectOptions(screen.getByLabelText("From account"), "a-chk");
    const carRow = screen.getByText("New car").closest("tr")!;
    await userEvent.click(within(carRow).getByRole("button", { name: "Contribute…" }));
    await userEvent.type(screen.getByLabelText("Contribution"), "50");
    await userEvent.click(screen.getByRole("button", { name: "Move to Checking" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Pick the account the money comes from.");
    expect(invokeCalls.some((c) => c.cmd === "contribute_to_goal")).toBe(false);
  });

  it("shows the goal form's refusal as a refusal", async () => {
    render(<GoalsView />);
    await screen.findByText("New Roof");
    await userEvent.click(screen.getByRole("button", { name: "Add Goal" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a name, target, and saved amount.");
  });
});
