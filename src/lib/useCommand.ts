// Offering a command from a React component.
//
// `useCommand("file.print", print)` means: while this component is mounted and
// `enabled` holds, File → Print works and is not grayed out. When it unmounts,
// or the condition stops holding, the menu item grays itself. Nothing else has
// to be told.
//
// The handler is kept in a ref so a component can re-render freely without
// churning the registry — registering and unregistering on every keystroke
// would make the menu flicker and would wake every listener.
import { useEffect, useRef } from "react";
import { registerCommand, type CommandId } from "./commands";

export function useCommand(
  id: CommandId,
  handler: (arg?: unknown) => void | Promise<void>,
  enabled = true,
  priority = 0
): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    return registerCommand(id, (arg) => ref.current(arg), priority);
  }, [id, enabled, priority]);
}
