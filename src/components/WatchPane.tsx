// The Two-up look's second register.
//
// > *"1. Tiles - remove try to come up with an different option"*
//
// Tiles answered "how am I doing" with a wall of numbers, which is what Home
// already does in a column and does better. This answers a question nothing
// in the app answered: **what does the OTHER account say right now.**
// Reconciling a mortgage against the checking account it is paid from, or
// watching a balance while you work a different register, meant leaving the
// register you were in and coming back.
//
// IT IS A VIEWER, NOT A SECOND EDITOR, AND THAT IS DELIBERATE. One register
// is the one you are working; this one is the one you are watching. The
// register data lives in a single store (`useAccountStore.register`), so a
// genuinely editable second pane would mean two of everything — two loading
// flags, two undo positions, two forms that could each be half-typed when the
// app closes. Two editable registers that disagree about which is "the"
// register is a bug factory, and the thing actually wanted here is to SEE the
// other account. So this fetches its own rows, renders them, and offers one
// button: **Work this one**, which swaps it into the main pane. Watching and
// working stay one click apart and never happen in two places at once.
import { useEffect, useState } from "react";
import RegisterGrid from "./RegisterGrid";
import Money from "./Money";
import { api } from "../lib/ipc";
import { registerColumnLabels } from "../lib/accountTypes";
import type { Account, RegisterRow } from "../lib/types";

/** Remembered like the look and the ribbon are: which account you watch is a
 *  preference about this screen. A webview that refuses localStorage gets an
 *  empty picker, not a broken pane. */
const KEY = "tm.twoup.account";

function readWatched(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

interface Props {
  accounts: Account[];
  /** The account the main pane is on — never offered here, because watching
   *  the register you are already working is two of the same thing. */
  workingId: string | null;
  /** Promote this account into the main pane. */
  onWork: (id: string) => void;
}

export default function WatchPane({ accounts, workingId, onWork }: Props) {
  const [watched, setWatched] = useState(readWatched);
  const [rows, setRows] = useState<RegisterRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = accounts.filter((a) => !a.is_closed && a.id !== workingId);
  // The remembered account can be closed, deleted, or the one now being
  // worked. Fall back rather than hold a picker on a value it cannot show.
  const showing = open.some((a) => a.id === watched) ? watched : "";
  const account = open.find((a) => a.id === showing) ?? null;

  function choose(id: string) {
    setWatched(id);
    try {
      localStorage.setItem(KEY, id);
    } catch {
      // A preference that cannot be saved is still a preference for now.
    }
  }

  // Reload whenever the account changes — and whenever the main pane writes.
  // A watched balance that is quietly stale is worse than no watched balance
  // at all. `workingId` alone did not stand in for a write — it only
  // moves when the main pane switches accounts, so a payment entered in the
  // register left the watched account's rows as they were. `accounts` is
  // reloaded after every write that moves a balance (the store's
  // `loadAccounts`, and the add's in-place bump), and a new array is the
  // signal.
  useEffect(() => {
    if (!showing) {
      setRows([]);
      setError(null);
      return;
    }
    let alive = true;
    setLoading(true);
    api
      .getRegister(showing)
      .then((r) => {
        if (!alive) return;
        setRows(r);
        setError(null);
      })
      .catch((e) => {
        if (alive) {
          setRows([]);
          setError(String(e));
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [showing, workingId, accounts]);

  const ending = rows.length > 0 ? rows[rows.length - 1].running_balance_cents : null;

  return (
    <aside className="tm-watch-pane" aria-label="Second register">
      <div className="tm-watch-head">
        <select
          className="aero-field"
          aria-label="Account to watch"
          value={showing}
          onChange={(e) => choose(e.target.value)}
        >
          <option value="">(choose an account)</option>
          {open.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        {account && (
          <button type="button" className="aero-btn" onClick={() => onWork(account.id)} title="Open this account in the main register">
            Work this one
          </button>
        )}
      </div>

      {error ? (
        <div className="money-neg p-2 text-[12px]">{error}</div>
      ) : !account ? (
        <div className="tm-watch-empty">
          Choose an account to keep beside the one you are working. It is a view — the register on the left is where you type.
        </div>
      ) : (
        <>
          <div className="tm-watch-balance">
            {account.name} · Ending Balance: <Money cents={ending ?? account.balance_cents} tone="neutral" />
            {loading && <span className="tm-text-muted"> · loading…</span>}
          </div>
          <div className="tm-watch-grid">
            <RegisterGrid
              groups={[{ label: null, rows }]}
              columnLabels={registerColumnLabels(account.type)}
              minRows={0}
              investment={account.type === "investment" || account.type === "retirement"}
            />
          </div>
        </>
      )}
    </aside>
  );
}
