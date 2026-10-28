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

  it("Escape gives focus back to what had it before the menu opened", () => {
    render(<button type="button">Before</button>);
    const before = screen.getByRole("button", { name: "Before" });
    before.focus();
    setup();
    expect(screen.getByRole("menuitem", { name: "Edit" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(before).toHaveFocus();
  });

  it("Tab closes it and gives focus back the same way", () => {
    render(<button type="button">Before</button>);
    const before = screen.getByRole("button", { name: "Before" });
    before.focus();
    const { onClose } = setup();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Tab" });
    expect(onClose).toHaveBeenCalled();
    expect(before).toHaveFocus();
  });

  it("ArrowUp from the first item wraps to the last enabled one, and Home goes back to the first", () => {
    setup();
    expect(screen.getByRole("menuitem", { name: "Edit" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowUp" });
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Home" });
    expect(screen.getByRole("menuitem", { name: "Edit" })).toHaveFocus();
  });

  it("a menu with every item unavailable takes focus itself, and Escape still closes it", () => {
    const onClose = vi.fn();
    render(<ContextMenu x={1} y={1} onClose={onClose} items={[{ label: "One", onSelect: vi.fn(), disabled: true }, { label: "Two", onSelect: vi.fn(), disabled: true }]} />);
    expect(screen.getByRole("menu")).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
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

function RowsWithInput() {
  const { menu, open, close } = useContextMenu<string>();
  return (
    <>
      <div onContextMenu={(e) => open(e, "row-1")}>
        <span>Row 1</span>
        <input aria-label="Rename" />
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} onClose={close} items={[{ label: `Open ${menu.target}`, onSelect: () => {} }]} />}
    </>
  );
}

describe("useContextMenu", () => {
  it("a right-click in a text box inside the row leaves the webview's own menu alone", () => {
    render(<RowsWithInput />);
    const notPrevented = fireEvent.contextMenu(screen.getByLabelText("Rename"), { clientX: 20, clientY: 30 });
    expect(notPrevented).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
    // The row itself still opens it.
    const prevented = fireEvent.contextMenu(screen.getByText("Row 1"), { clientX: 20, clientY: 30 });
    expect(prevented).toBe(false);
    expect(screen.getByRole("menuitem", { name: "Open row-1" })).toBeInTheDocument();
  });

  it("a right-click opens the menu for what was clicked", () => {
    render(<Rows />);
    fireEvent.contextMenu(screen.getByText("Row 1"), { clientX: 20, clientY: 30 });
    expect(screen.getByRole("menuitem", { name: "Open row-1" })).toBeInTheDocument();
  });
});

describe("selected text and the row's menu", () => {
  function select(node: Node) {
    const range = document.createRange();
    range.selectNodeContents(node);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  }

  it("text selected in the row keeps the webview's Copy", () => {
    render(<RowsWithInput />);
    select(screen.getByText("Row 1"));
    const notPrevented = fireEvent.contextMenu(screen.getByText("Row 1"), { clientX: 20, clientY: 30 });
    expect(notPrevented).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
    window.getSelection()!.removeAllRanges();
  });

  it("text left selected somewhere else does not take the menu away from the row", () => {
    render(<><p>Elsewhere</p><RowsWithInput /></>);
    select(screen.getByText("Elsewhere"));
    const prevented = !fireEvent.contextMenu(screen.getByText("Row 1"), { clientX: 20, clientY: 30 });
    expect(prevented).toBe(true);
    expect(screen.getByRole("menuitem", { name: "Open row-1" })).toBeInTheDocument();
    window.getSelection()!.removeAllRanges();
  });
});
