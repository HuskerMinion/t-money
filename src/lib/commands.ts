// §97 — the command registry behind the menu bar.
//
// THE PROBLEM A MENU HAS. A menu bar names everything the app can do, but
// almost none of it belongs to the menu: Print and Export CSV belong to the
// register, Update prices belongs to the Portfolio, Back up now belongs to
// Settings. The usual answer is to lift all of that into the shell and pass
// callbacks down, which puts the register's business in App.tsx and leaves
// the menu guessing at whether an item applies right now.
//
// The other usual answer is worse: a menu of items that are always enabled
// and quietly do nothing when they do not apply. MS Money grays out Print
// Preview when there is nothing to preview, and that graying is information —
// it tells you where you are.
//
// So the registry inverts it. Whoever can perform a command REGISTERS it
// while it is mounted and applicable; the menu enables an item exactly when
// something is registered to serve it, and grays it out otherwise. The
// register mounts, Print lights up. You leave the register, Print grays out.
// Nobody had to tell the menu that.
//
// A dead menu item is therefore not possible by construction: an item nothing
// registers is visibly unavailable rather than invisibly broken.

/** Every command the menu can name. Adding one here does not create it —
 *  something has to register a handler before it can be chosen. */
export type CommandId = string;

/** §155 — a command may carry one argument (a file path the CSV door hands
 *  to the TSP importer). Most ignore it. */
type Handler = (arg?: unknown) => void | Promise<void>;

interface Entry {
  handler: Handler;
  /** Higher wins when two things can serve the same command. The register
   *  and a dialog can both offer Delete; the dialog is on top. */
  priority: number;
}

const entries = new Map<CommandId, Entry[]>();
const listeners = new Set<() => void>();

function changed() {
  for (const l of listeners) l();
}

/** Subscribe to availability changes — the menu re-renders on these. */
export function onAvailabilityChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Offer to serve `id` until the returned function is called.
 *
 * Returns the unregister function, which is what a React effect cleanup
 * wants. Registering the same id twice is fine and expected — the highest
 * priority serves it.
 */
export function registerCommand(id: CommandId, handler: Handler, priority = 0): () => void {
  const entry: Entry = { handler, priority };
  const list = entries.get(id);
  if (list) list.push(entry);
  else entries.set(id, [entry]);
  changed();
  return () => {
    const l = entries.get(id);
    if (!l) return;
    const i = l.indexOf(entry);
    if (i >= 0) l.splice(i, 1);
    if (l.length === 0) entries.delete(id);
    changed();
  };
}

/** Can anything serve this right now? The menu grays out everything else. */
export function isCommandAvailable(id: CommandId): boolean {
  return (entries.get(id)?.length ?? 0) > 0;
}

/** Run it, if anything can. Returns whether anything did — a caller that
 *  cares (a keyboard shortcut deciding whether to preventDefault) can ask. */
export function runCommand(id: CommandId, arg?: unknown): boolean {
  const list = entries.get(id);
  if (!list || list.length === 0) return false;
  let best = list[0];
  for (const e of list) if (e.priority >= best.priority) best = e;
  // Handlers may be async. A rejection nobody catches surfaces as an
  // unhandled rejection with no command attached; name the command instead.
  Promise.resolve(best.handler(arg)).catch((err) => {
    console.error(`command "${id}" failed:`, err);
  });
  return true;
}

/** Test seam: forget everything. Never called by the app. */
export function resetCommands(): void {
  entries.clear();
  changed();
}

/** What is registered right now, for tests and for the About box's
 *  "what can this screen do" list. */
export function availableCommands(): CommandId[] {
  return [...entries.keys()].sort();
}
