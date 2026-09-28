// §102 — Favorites → Organize favorites…
//
// The Favorites menu lists your starred accounts, and until now the only way
// to change that list was to open each account and star it. This is the one
// place that shows the whole list at once with a tick beside each account,
// which is exactly what Money's dialog of the same name did.
//
// It writes immediately rather than on OK. There is no destructive outcome to
// protect against — a star is a star — and a dialog that batches trivial
// changes behind a confirm invites the "did that take?" reopen.
import { useState } from "react";
import Money from "./Money";
import Notice from "./Notice";
import { accountWorth } from "../lib/accountTypes";
import type { Account } from "../lib/types";

interface Props {
  accounts: readonly Account[];
  /** §183 — may return the write's promise; a rejection is shown here. */
  onToggle: (id: string) => void | Promise<void>;
  /** §169 — the accounts in a new order, the whole list. Omit and the rows
   *  cannot be moved. */
  onReorder?: (ids: string[]) => void | Promise<void>;
  onClose: () => void;
}

/** §169 — `ids` with the one at `from` moved to `to`. Exported for the test. */
export function moved(ids: readonly string[], from: number, to: number): string[] {
  const out = [...ids];
  if (from < 0 || from >= out.length || to < 0 || to >= out.length) return out;
  const [id] = out.splice(from, 1);
  out.splice(to, 0, id);
  return out;
}

export default function OrganizeFavoritesDialog({ accounts, onToggle, onReorder, onClose }: Props) {
  // Closed accounts are left out: a closed account in the Favorites menu is a
  // shortcut to something you are done with.
  //
  // §169 — the rows are in the order the store holds them, which is the
  // order every list of accounts uses; ▲ and ▼ move a row and write the
  // whole arrangement back, so the account bar, the Home page and the
  // Favorites menu all follow. Closed accounts keep their place at the end.
  const open = accounts.filter((a) => !a.is_closed);
  const starred = open.filter((a) => a.is_favorite).length;
  // §183 — one write at a time, and a refusal said here. Neither callback had
  // a catch, and ▼ stayed live while the order was being written: two quick
  // presses each computed a move from the SAME old order, so the second
  // undid the first rather than moving the row twice.
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (write: () => void | Promise<void>) => {
    setSaving(true);
    setError(null);
    try {
      await write();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };
  const move = (id: string, by: -1 | 1) => {
    const openIds = open.map((a) => a.id);
    const from = openIds.indexOf(id);
    const closed = accounts.filter((a) => a.is_closed).map((a) => a.id);
    void run(() => onReorder?.([...moved(openIds, from, from + by), ...closed]));
  };

  return (
    <div className="tm-dialog" role="dialog" aria-label="Organize favorites" style={{ minWidth: 420 }}>
      <div className="tm-dialog-title">Organize Favorites</div>
      <div className="tm-dialog-body">
        <p className="text-[12px] pb-2">
          Starred accounts appear in the Favorites menu and on the Home page.
          {onReorder && " The order here is the order everywhere: the account bar, the Home page and the Favorites menu."}
        </p>
        <div className="tm-fav-list">
          {open.length === 0 ? (
            <div className="text-[12px]" style={{ color: "var(--tm-ms-text-muted)" }}>
              No open accounts.
            </div>
          ) : (
            open.map((a, i) => (
              <div key={a.id} className="tm-fav-row">
                <input
                  type="checkbox"
                  checked={a.is_favorite}
                  disabled={saving}
                  onChange={() => void run(() => onToggle(a.id))}
                  aria-label={`${a.name} is a favorite`}
                />
                <span className="flex-1 truncate">{a.name}</span>
                <span className="tabular-nums">
                  <Money cents={accountWorth(a)} />
                </span>
                {onReorder && (
                  <span className="inline-flex gap-0.5 pl-2">
                    <button
                      type="button"
                      className="aero-btn !py-0 !px-1 text-[11px]"
                      aria-label={`Move ${a.name} up`}
                      title="Move up"
                      disabled={saving || i === 0}
                      onClick={() => move(a.id, -1)}
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      className="aero-btn !py-0 !px-1 text-[11px]"
                      aria-label={`Move ${a.name} down`}
                      title="Move down"
                      disabled={saving || i === open.length - 1}
                      onClick={() => move(a.id, 1)}
                    >
                      ▼
                    </button>
                  </span>
                )}
              </div>
            ))
          )}
        </div>
        {error && (
          <Notice tone="error" boxed className="mt-2">
            {error}
          </Notice>
        )}
        <div className="flex items-center justify-between pt-3">
          <span className="text-[11px]" style={{ color: "var(--tm-ms-text-muted)" }}>
            {starred === 0 ? "Nothing starred" : `${starred} starred`}
          </span>
          <button className="aero-btn" type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
