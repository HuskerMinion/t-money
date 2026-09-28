// §117 — the screen when no file is open; §134 — which of those files this
// computer can actually open.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import StartScreen from "./StartScreen";

const RECENTS = [
  { path: "E:\\Money\\Maple Street.tmny", name: "Maple Street", exists: true, needsKey: false },
  { path: "D:\\FromLaptop\\Household.tmny", name: "Household", exists: true, needsKey: true },
  { path: "E:\\Money\\Old.tmny", name: "Old", exists: false, needsKey: false },
];

const props = {
  recents: RECENTS,
  onOpen: vi.fn(),
  onNew: vi.fn(),
  onOpenPath: vi.fn(),
};

describe("StartScreen", () => {
  // §134 — before the click, not after. The whole reason the flag rides along
  // on the recents list is that clicking a file only to be told it cannot be
  // opened is the experience this section set out to remove.
  it("marks a file this computer has no key for", () => {
    render(<StartScreen {...props} />);
    const row = screen.getByText("Household").closest("li")!;
    expect(within(row).getByText("key needed")).toBeInTheDocument();

    const fine = screen.getByText("Maple Street").closest("li")!;
    expect(within(fine).queryByText("key needed")).toBeNull();
  });

  // Marked, not disabled. The file is perfectly openable — it needs one paste,
  // and a grayed-out row would say the opposite.
  it("still opens the file it marked", async () => {
    const onOpenPath = vi.fn();
    render(<StartScreen {...props} onOpenPath={onOpenPath} />);
    const row = screen.getByText("Household").closest("li")!;
    const btn = within(row).getByRole("button");
    expect(btn).not.toBeDisabled();
    await userEvent.click(btn);
    expect(onOpenPath).toHaveBeenCalledWith("D:\\FromLaptop\\Household.tmny");
  });

  // A missing file is the other thing this list reports, and it is a different
  // thing: that one IS disabled, because there is nothing to open.
  it("keeps missing and key-needed apart", () => {
    render(<StartScreen {...props} />);
    const gone = screen.getByText("Old").closest("li")!;
    expect(within(gone).getByRole("button", { name: /missing/ })).toBeDisabled();
    expect(within(gone).queryByText("key needed")).toBeNull();
  });

  it("says where to get the key from", () => {
    render(<StartScreen {...props} />);
    expect(screen.getByText(/Save master key/)).toBeInTheDocument();
  });
});
