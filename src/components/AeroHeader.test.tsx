// The Settings gear.
//
// jsdom parses no stylesheet, so none of this can prove the gear *looks*
// right — only looking at it can, and this button is a case in point:
// it was invisible for weeks while every test passed. What a test CAN pin is
// the structure that made it invisible, so the same mistake cannot come back
// silently.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import AeroHeader from "./AeroHeader";

function gear() {
  return screen.getByRole("button", { name: "Settings" });
}

describe("the Settings gear", () => {
  it("has an accessible name, not just a tooltip", () => {
    // It is the only unlabeled destination in the header, so the name has to
    // come from aria-label — a `title` alone leaves it findable by hover only.
    render(<AeroHeader active="Home" onTab={vi.fn()} />);
    expect(gear()).toBeInTheDocument();
  });

  it("is not an .aero-tab", () => {
    // The whole bug: .aero-tab paints a dark gradient plate, and the gear's
    // body fills from --tm-icon-primary, which is navy by default. Dark on
    // dark — "a tiny dot in a dark square".
    render(<AeroHeader active="Home" onTab={vi.fn()} />);
    expect(gear().className).not.toMatch(/\baero-tab\b/);
    expect(gear().className).toMatch(/\baero-gear\b/);
  });

  it("renders the settings glyph, tinted by the button rather than the icon", () => {
    // The tint lives on .aero-gear as custom properties, which inherit into
    // the <use> shadow tree — so nothing on the icon can out-specify them.
    // jsdom cannot see the color; what it can see is that the gear
    // carries no competing icon class of its own.
    render(<AeroHeader active="Home" onTab={vi.fn()} />);
    const svg = gear().querySelector("svg");
    expect(svg?.querySelector("use")?.getAttribute("href")).toBe("#tm-settings");
    expect(svg?.getAttribute("class")).not.toMatch(/tm-icon--/);
  });

  it("marks itself active when Settings is the current tab", () => {
    const { rerender } = render(<AeroHeader active="Home" onTab={vi.fn()} />);
    expect(gear().className).not.toMatch(/\bactive\b/);
    rerender(<AeroHeader active="Settings" onTab={vi.fn()} />);
    expect(gear().className).toMatch(/\bactive\b/);
  });

  it("navigates to Settings when clicked", async () => {
    const onTab = vi.fn();
    render(<AeroHeader active="Home" onTab={onTab} />);
    await userEvent.click(gear());
    expect(onTab).toHaveBeenCalledWith("Settings");
  });

  it("is not one of the labeled nav tabs", () => {
    // Settings lives outside the TABS row by design; if it ever joins it, the
    // styling above stops being the right answer.
    render(<AeroHeader active="Home" onTab={vi.fn()} />);
    const tabs = screen
      .getAllByRole("button")
      .filter((b) => b.className.includes("aero-tab"))
      .map((b) => b.textContent);
    expect(tabs).not.toContain("Settings");
    expect(tabs.length).toBeGreaterThan(4);
  });
});

// The light/dark button read the theme once, so a theme picked in
// Settings left it offering the wrong switch.
describe("The light/dark button follows Settings", () => {
  it("changes its label when a dark theme is applied elsewhere, and back", async () => {
    const { applyTheme, THEMES } = await import("../lib/theme");
    const darkTheme = THEMES.find((t) => t.dark)!;
    applyTheme("money");
    render(<AeroHeader active="Home" onTab={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Switch to the dark theme" })).toBeInTheDocument();
    applyTheme(darkTheme.id);
    await waitFor(() => expect(screen.getByRole("button", { name: "Switch to the light theme" })).toBeInTheDocument());
    applyTheme("money");
    await waitFor(() => expect(screen.getByRole("button", { name: "Switch to the dark theme" })).toBeInTheDocument());
  });
});
