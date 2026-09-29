// The front end's half of undo.
//
// The Rust tests prove that the rows come back. These prove the part the user
// sees: that the menu says what it is about to undo, that it grays itself out
// when there is nothing, and that the cache never gets ahead of the backend.
import { beforeEach, describe, expect, it, vi } from "vitest";

const undoStatusCall = vi.fn();
const undoLastCall = vi.fn();
const redoLastCall = vi.fn();

vi.mock("./ipc", () => ({
  api: {
    undoStatus: () => undoStatusCall(),
    undoLast: () => undoLastCall(),
    redoLast: () => redoLastCall(),
  },
}));

import { buildMenus, menuLeaves } from "./menus";
import { forgetUndo, onUndoChange, redoLast, refreshUndo, undoLast, undoStatus } from "./undo";

const menuData = (undoLabel: string | null, redoLabel: string | null) => ({
  undoLabel,
  redoLabel,
  favoriteAccounts: [],
  savedReports: [],
  recentFiles: [],
  openFile: () => {},
  forgetMissingFiles: () => {},
  openAccount: () => {},
  openReport: () => {},
});

const editItem = (label: string, undoLabel: string | null, redoLabel: string | null) =>
  menuLeaves(buildMenus(menuData(undoLabel, redoLabel))).find((l) => l.command === label);

beforeEach(async () => {
  vi.clearAllMocks();
  undoStatusCall.mockResolvedValue({ undo: null, redo: null });
  await refreshUndo();
  forgetUndo();
});

describe("the undo status cache", () => {
  it("starts empty, so the menu grays out before anything has happened", () => {
    expect(undoStatus()).toEqual({ undo: null, redo: null });
  });

  it("tells its subscribers when the answer changes, and only then", async () => {
    const seen = vi.fn();
    const off = onUndoChange(seen);
    undoStatusCall.mockResolvedValue({ undo: "delete a transaction", redo: null });
    await refreshUndo();
    expect(seen).toHaveBeenCalledTimes(1);
    // The same answer again is not news. A fresh object every poll would
    // re-render the whole shell on a timer.
    await refreshUndo();
    expect(seen).toHaveBeenCalledTimes(1);
    off();
  });

  it("hands back the identical object until something changes", async () => {
    undoStatusCall.mockResolvedValue({ undo: "add a transaction", redo: null });
    await refreshUndo();
    const first = undoStatus();
    await refreshUndo();
    expect(undoStatus()).toBe(first);
  });

  it("a backend that will not answer grays the menu rather than breaking it", async () => {
    undoStatusCall.mockResolvedValue({ undo: "add a transaction", redo: null });
    await refreshUndo();
    undoStatusCall.mockRejectedValue(new Error("no database is open"));
    await expect(refreshUndo()).resolves.toBeUndefined();
    expect(undoStatus()).toEqual({ undo: null, redo: null });
  });

  it("does not call the backend when there is nothing to undo", async () => {
    expect(await undoLast()).toBe(false);
    expect(await redoLast()).toBe(false);
    expect(undoLastCall).not.toHaveBeenCalled();
    expect(redoLastCall).not.toHaveBeenCalled();
  });

  it("takes the new status from the undo itself rather than guessing", async () => {
    undoStatusCall.mockResolvedValue({ undo: "delete a transaction", redo: null });
    await refreshUndo();
    // The backend is the one that knows what is underneath: undoing the last
    // step can reveal an older one, and the label changes with it.
    undoLastCall.mockResolvedValue({ undo: "edit a transaction", redo: "delete a transaction" });
    expect(await undoLast()).toBe(true);
    expect(undoStatus()).toEqual({ undo: "edit a transaction", redo: "delete a transaction" });

    redoLastCall.mockResolvedValue({ undo: "delete a transaction", redo: null });
    expect(await redoLast()).toBe(true);
    expect(undoStatus()).toEqual({ undo: "delete a transaction", redo: null });
  });

  it("forgetting drops the label when a different file is opened", async () => {
    undoStatusCall.mockResolvedValue({ undo: "delete a transaction", redo: "x" });
    await refreshUndo();
    forgetUndo();
    expect(undoStatus()).toEqual({ undo: null, redo: null });
  });

  // An answer that arrives after a newer question must not win.
  const deferred = <T,>() => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  };

  it("ignores a status that lands after the file was switched", async () => {
    const slow = deferred<{ undo: string | null; redo: string | null }>();
    undoStatusCall.mockReturnValueOnce(slow.promise);
    const pending = refreshUndo();
    forgetUndo();
    slow.resolve({ undo: "delete a transaction", redo: null });
    await pending;
    expect(undoStatus()).toEqual({ undo: null, redo: null });
  });

  it("ignores a status that was asked for before an undo and lands after it", async () => {
    undoStatusCall.mockResolvedValue({ undo: "delete a transaction", redo: null });
    await refreshUndo();
    const slow = deferred<{ undo: string | null; redo: string | null }>();
    undoStatusCall.mockReturnValueOnce(slow.promise);
    const pending = refreshUndo();
    undoLastCall.mockResolvedValue({ undo: null, redo: "delete a transaction" });
    expect(await undoLast()).toBe(true);
    slow.resolve({ undo: "delete a transaction", redo: null });
    await pending;
    expect(undoStatus()).toEqual({ undo: null, redo: "delete a transaction" });
  });

  it("an undo the backend refuses returns false instead of throwing, and re-reads the label", async () => {
    undoStatusCall.mockResolvedValue({ undo: "delete a transaction", redo: "add a transaction" });
    await refreshUndo();
    undoLastCall.mockRejectedValue(new Error("no database is open"));
    redoLastCall.mockRejectedValue(new Error("no database is open"));
    undoStatusCall.mockResolvedValue({ undo: null, redo: null });
    await expect(undoLast()).resolves.toBe(false);
    await vi.waitFor(() => expect(undoStatus()).toEqual({ undo: null, redo: null }));
    undoStatusCall.mockResolvedValue({ undo: null, redo: "add a transaction" });
    await refreshUndo();
    undoStatusCall.mockResolvedValue({ undo: null, redo: null });
    await expect(redoLast()).resolves.toBe(false);
    await vi.waitFor(() => expect(undoStatus()).toEqual({ undo: null, redo: null }));
  });
});

// A refusal has words, and the shell needs them: it showed nothing.
describe("A refused undo says why", () => {
  it("hands the backend's message to onError, for a string rejection and an Error alike", async () => {
    undoStatusCall.mockResolvedValue({ undo: "delete a transaction", redo: "add a transaction" });
    await refreshUndo();
    undoLastCall.mockRejectedValue("the transaction it would restore is gone");
    const onError = vi.fn();
    await expect(undoLast(onError)).resolves.toBe(false);
    expect(onError).toHaveBeenCalledWith("the transaction it would restore is gone");

    undoStatusCall.mockResolvedValue({ undo: null, redo: "add a transaction" });
    await refreshUndo();
    redoLastCall.mockRejectedValue(new Error("no database is open"));
    const onRedoError = vi.fn();
    await expect(redoLast(onRedoError)).resolves.toBe(false);
    expect(onRedoError).toHaveBeenCalledWith("no database is open");
  });
});

describe("what the Edit menu says", () => {
  it("names the operation, so you know what you are getting back", () => {
    expect(editItem("edit.undo", "delete a transaction", null)?.label).toBe("Undo delete a transaction");
    expect(editItem("edit.redo", null, "add a transaction")?.label).toBe("Redo add a transaction");
  });

  it("falls back to the bare word when the stack is empty", () => {
    // The item is grayed out in this state — the registry decides that — but
    // it still has to read as something rather than "Undo null".
    expect(editItem("edit.undo", null, null)?.label).toBe("Undo");
    expect(editItem("edit.redo", null, null)?.label).toBe("Redo");
  });

  it("keeps Money's shortcuts", () => {
    expect(editItem("edit.undo", null, null)?.accel).toBe("Ctrl+Z");
    expect(editItem("edit.redo", null, null)?.accel).toBe("Ctrl+Y");
  });
});
