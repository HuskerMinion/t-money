// §101 — the front end's view of the undo stack.
//
// The stack itself lives in Rust, in `AppState`. This module is the small
// amount of state the UI needs to ask two questions: is there anything to
// undo, and what would it say?
//
// WHY A MODULE AND NOT COMPONENT STATE. The answer changes on every
// transaction write, and those happen in the register, the bill list, the
// investment forms and the importers — none of which know the menu exists.
// The store calls `noteChanged()` after each write it makes; everything that
// displays undo subscribes here. That keeps the menu honest without giving
// every writer a callback to remember.
//
// It is deliberately a cache of the backend's answer rather than a second
// copy of the stack: the labels, the depth and the redo-branch rule are all
// decided in one place, and a UI that got out of step with them would gray
// out a working command or offer a dead one.
import { api } from "./ipc";
import type { UndoStatus } from "./types";

const NOTHING: UndoStatus = { undo: null, redo: null };

let status: UndoStatus = NOTHING;
const listeners = new Set<() => void>();

/** The last answer we had. Synchronous, so `useSyncExternalStore` can use it;
 *  the same object is returned until something actually changes, because a
 *  fresh object every call is an infinite render. */
export function undoStatus(): UndoStatus {
  return status;
}

export function onUndoChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function apply(next: UndoStatus | null | undefined) {
  // Coerced, not trusted. `undefined` and `null` mean the same thing here —
  // nothing to undo — but only one of them is falsy in the way the menu's
  // enabled test reads, and an item that grays itself out on one answer and
  // lights up on the other is exactly the kind of dead menu item §97 exists
  // to make impossible.
  const undo = next?.undo ?? null;
  const redo = next?.redo ?? null;
  if (undo === status.undo && redo === status.redo) return;
  status = { undo, redo };
  for (const l of listeners) l();
}

/** §180 — which request's answer still counts. Every call that will hand a
 *  status to `apply` takes the next number before it awaits, and applies its
 *  answer only if nothing has taken a newer one since. Without it a slow
 *  `undoStatus` sent before an undo — or before `forgetUndo` on a file switch
 *  — lands afterwards and puts back the old file's "Undo delete a
 *  transaction", a menu item that would undo nothing the user can see. */
let latest = 0;

/** Ask the backend again. Never throws: an app that will not render because
 *  the undo label could not be fetched is worse than a grayed-out menu. */
export async function refreshUndo(): Promise<void> {
  const mine = ++latest;
  try {
    const next = await api.undoStatus();
    if (mine === latest) apply(next);
  } catch {
    if (mine === latest) apply(NOTHING);
  }
}

/** Something wrote to the database. Called by the store after the writes that
 *  the backend records — add, edit, delete, void. */
export function noteChanged(): void {
  void refreshUndo();
}

/** Run an undo or redo. §180: never throws — it runs from Ctrl+Z, where a
 *  rejection has nobody to catch it — and a failure reads as "nothing
 *  happened" (false), so the caller does not reload for a step that did not
 *  run. The label is asked for again, since the stack may not be what the
 *  menu last said.
 *
 *  §183 — but "nothing happened" is not the same as "nothing to say". A
 *  refused step (the row it would put back is gone, the file is locked) was
 *  swallowed here and the shell showed nothing, so Ctrl+Z read as a dead key.
 *  The backend's words go to `onError`, for the shell to put in a Notice. */
async function step(call: () => Promise<UndoStatus>, onError?: (message: string) => void): Promise<boolean> {
  const mine = ++latest;
  try {
    const next = await call();
    if (mine === latest) apply(next);
    return true;
  } catch (e) {
    if (mine === latest) void refreshUndo();
    onError?.(e instanceof Error ? e.message : String(e));
    return false;
  }
}

/** Undo, then hand back what the caller must reload. Returns false when there
 *  was nothing to undo (or it failed), which is how a keyboard shortcut
 *  decides whether it swallowed the keystroke. */
export async function undoLast(onError?: (message: string) => void): Promise<boolean> {
  if (!status.undo) return false;
  return step(() => api.undoLast(), onError);
}

export async function redoLast(onError?: (message: string) => void): Promise<boolean> {
  if (!status.redo) return false;
  return step(() => api.redoLast(), onError);
}

/** A different file is a different history — the backend clears its stack on
 *  open, and this drops the label that went with the old one. It also retires
 *  any answer still on its way about the old file (§180). */
export function forgetUndo(): void {
  latest++;
  apply(NOTHING);
}
