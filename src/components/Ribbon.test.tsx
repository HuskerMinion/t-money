// The ribbon collapses to an icon strip and comes back on a click.
//
// The point of the collapsed state is that it is a TOOLBAR, not a stub: the
// space comes back without the commands going with it. So the test that
// matters is not "does it get shorter" but "does New transaction still run
// from it".
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import Ribbon from "./Ribbon";
import { registerCommand } from "../lib/commands";

beforeEach(() => {
  localStorage.clear();
});

describe("Ribbon", () => {
  it("collapses to icons that still run their commands, and expands again", async () => {
    const ran = vi.fn();
    const off = registerCommand("new.transaction", ran);
    render(<Ribbon />);

    // Expanded: the groups are named, which is the whole point of a ribbon.
    expect(screen.getByText("Enter")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Hide ribbon/ }));

    // The labels and group names go; the commands do not.
    expect(screen.queryByText("Enter")).not.toBeInTheDocument();
    const newTxn = screen.getByRole("button", { name: "New transaction" });
    await userEvent.click(newTxn);
    expect(ran).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: /Show ribbon/ }));
    expect(screen.getByText("Enter")).toBeInTheDocument();
    off();
  });

  it("remembers the choice, because rows you got back you want back tomorrow", async () => {
    const { unmount } = render(<Ribbon />);
    await userEvent.click(screen.getByRole("button", { name: /Hide ribbon/ }));
    expect(localStorage.getItem("tm.ribbon.collapsed")).toBe("1");
    unmount();

    render(<Ribbon />);
    expect(screen.getByRole("button", { name: /Show ribbon/ })).toBeInTheDocument();
    expect(screen.queryByText("Enter")).not.toBeInTheDocument();
  });

  it("a command with no icon is left out of the strip rather than drawn wrong", async () => {
    render(<Ribbon />);
    // Void is text-only in the full ribbon: the sprite has nothing honest for
    // it, and an icon that is read as something else is worse than no button.
    expect(screen.getByRole("button", { name: "Void" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Hide ribbon/ }));
    expect(screen.queryByRole("button", { name: "Void" })).not.toBeInTheDocument();
  });
});

// The ribbon read the registry while rendering and never subscribed,
// so a command registered after it drew stayed gray.
describe("The ribbon follows the registry live", () => {
  it("lights a button up when its command is registered, and grays it when it goes", () => {
    localStorage.setItem("tm.ribbon.collapsed", "0");
    render(<Ribbon />);
    const print = screen.getByRole("button", { name: /Print…/ });
    expect(print).toBeDisabled();
    let off = () => {};
    act(() => {
      off = registerCommand("file.print", vi.fn());
    });
    expect(screen.getByRole("button", { name: /Print…/ })).toBeEnabled();
    act(() => off());
    expect(screen.getByRole("button", { name: /Print…/ })).toBeDisabled();
  });
});
