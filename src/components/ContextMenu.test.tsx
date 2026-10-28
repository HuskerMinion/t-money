// The shared right-click menu.
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ContextMenu, { clampToViewport, keepsBrowserMenu, menuPoint, useContextMenu } from "./ContextMenu";

function setup(extra: Partial<React.ComponentProps<typeof ContextMenu>> = {}) {
  const onClose = vi.fn();
  const edit = vi.fn();
  const del = vi.fn();
  render(
    <ContextMenu
      x={10}
      y={10}
      label="Row actions"
      onClose={onClose}
      items={[
        { label: "Edit", onSelect: edit },
        false,
        { label: "Unavailable", onSelect: vi.fn(), disabled: true },
        { label: "Delete", onSelect: del, separatorBefore: true },
      ]}
      {...extra}
    />
  );
  return { onClose, edit, del };
}

describe("ContextMenu", () => {
  it("lists the items it was given, leaving out the false ones", () => {
    setup();
    const items = screen.getAllByRole("menuitem").map((b) => b.textContent);
    expect(items).toEqual(["Edit", "Unavailable", "Delete"]);
    expect(screen.getByRole("separator")).toBeInTheDocument();
  });

  it("a click runs the item and closes the menu", async () => {
    const { onClose, del } = setup();
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(del).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("opens with the first item focused, and the arrows skip disabled items", () => {
    setup();
    expect(screen.getByRole("menuitem", { name: "Edit" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Edit" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "End" });
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();
  });

  it("Escape closes it without running anything", () => {
    const { onClose, edit, del } = setup();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it("a click outside closes it", () => {
    const { onClose } = setup();
    fireEvent.click(document.querySelector(".tm-dialog-backdrop")!);
    expect(onClose).toHaveBeenCalled();
  });
});

describe("placement", () => {
  it("a menu that would run off the right or bottom edge opens the other way", () => {
    expect(clampToViewport(100, 100, 200, 150, 1000, 800)).toEqual({ x: 100, y: 100 });
    expect(clampToViewport(900, 100, 200, 150, 1000, 800)).toEqual({ x: 700, y: 100 });
    expect(clampToViewport(100, 700, 200, 150, 1000, 800)).toEqual({ x: 100, y: 550 });
  });

  it("Shift+F10 (no pointer position) opens at the row, not the window's corner", () => {
    const el = document.createElement("div");
    el.getBoundingClientRect = () => ({ left: 40, bottom: 120, top: 100, right: 400, width: 360, height: 20, x: 40, y: 100, toJSON: () => ({}) });
    expect(menuPoint({ clientX: 0, clientY: 0, currentTarget: el })).toEqual({ x: 48, y: 120 });
    expect(menuPoint({ clientX: 5, clientY: 6, currentTarget: el })).toEqual({ x: 5, y: 6 });
  });
});

describe("the webview's own menu", () => {
  it("is kept in text boxes and over selected text, and nowhere else", () => {
    const input = document.createElement("input");
    const cell = document.createElement("td");
    expect(keepsBrowserMenu(input, "")).toBe(true);
    expect(keepsBrowserMenu(cell, "")).toBe(false);
    expect(keepsBrowserMenu(cell, "Kroger")).toBe(true);
  });
});

function Rows() {
  const { menu, open, close } = useContextMenu<string>();
  return (
    <>
      <div onContextMenu={(e) => open(e, "row-1")}>Row 1</div>
      {menu && <ContextMenu x={menu.x} y={menu.y} onClose={close} items={[{ label: `Open ${menu.target}`, onSelect: () => {} }]} />}
    </>
  );
}

describe("useContextMenu", () => {
  it("a right-click opens the menu for what was clicked", () => {
    render(<Rows />);
    fireEvent.contextMenu(screen.getByText("Row 1"), { clientX: 20, clientY: 30 });
    expect(screen.getByRole("menuitem", { name: "Open row-1" })).toBeInTheDocument();
  });
});
