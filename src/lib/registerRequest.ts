// An account's register, opened to do one thing: right-click an account in a
// list → Balance this account…, Update value…, Loan terms…, or a holding →
// Buy… / Sell….
//
// Those dialogs and forms belong to the register, which is not mounted while
// the list is on screen. So the request is parked here, the `nav.account`
// command opens the register, and the register takes the request once that
// account has loaded. Same shape as scheduleDraft.ts.

export type RegisterAction =
  | { kind: "reconcile" }
  | { kind: "value" }
  | { kind: "terms" }
  | { kind: "buy" | "sell"; securityId: string };

export interface RegisterRequest {
  accountId: string;
  action: RegisterAction;
}

/** How long a request waits to be taken. Opening the register takes a
 *  moment; a request nobody took (the account was gone) must not start a
 *  reconcile the next time that account happens to be opened, hours later. */
const TTL_MS = 5000;

let pending: (RegisterRequest & { at: number }) | null = null;
const listeners = new Set<() => void>();

export function requestRegisterAction(req: RegisterRequest): void {
  pending = { ...req, at: Date.now() };
  // A register already open on this account does not remount, so it is
  // told rather than waiting for an account change that never comes.
  for (const l of listeners) l();
}

/** Hear about new requests while mounted; returns the unsubscribe. */
export function onRegisterRequest(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The parked action for this account, taken once. A request for another
 *  account is left alone (and replaced by the next one); a stale one is
 *  dropped. */
export function takeRegisterAction(accountId: string, now = Date.now()): RegisterAction | null {
  if (pending && now - pending.at > TTL_MS) pending = null;
  if (!pending || pending.accountId !== accountId) return null;
  const a = pending.action;
  pending = null;
  return a;
}
