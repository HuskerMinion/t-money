// Mock module for `@tauri-apps/api/core`.
//
// Tests opt in with:
//   vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));
// then drive it with `setIpcHandlers({ get_register: () => [...] })`.
//
// Unhandled commands reject, so a test that forgets to stub something fails
// loudly instead of silently receiving `undefined`.
import { vi } from "vitest";

export type IpcHandler = (args: Record<string, unknown>) => unknown;

let handlers: Record<string, IpcHandler> = {};

/** Replace the command handler table. Call in `beforeEach`. */
export function setIpcHandlers(next: Record<string, IpcHandler>): void {
  handlers = next;
}

/** Every invoke() the code under test made, in order. */
export const invokeCalls: Array<{ cmd: string; args: Record<string, unknown> }> = [];

export function resetIpc(): void {
  handlers = {};
  invokeCalls.length = 0;
  invoke.mockClear();
}

export const invoke = vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
  invokeCalls.push({ cmd, args });
  const h = handlers[cmd];
  if (!h) throw new Error(`unmocked IPC command: ${cmd}`);
  return h(args);
});
