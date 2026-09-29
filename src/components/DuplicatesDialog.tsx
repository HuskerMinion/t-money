// Find duplicate transactions — rows in this account that share a
// date (or a few days), an amount and a payee. Overlapping downloads leave
// these behind when the file carried no ids. Each set is shown with what
// tells the copies apart — cleared mark, category, memo, check number,
// bank id — and the user deletes the one that is the copy. Nothing is
// deleted without a click; a transfer half is flagged (deleting it removes
// both halves, as always).
import { useEffect, useState } from "react";
import Money from "./Money";
import Notice from "./Notice";
import { api } from "../lib/ipc";
import { formatDateUS } from "../lib/format";
import type { DuplicateGroup } from "../lib/types";

interface Props {
  accountId: string;
  accountName: string;
  onDelete: (id: string) => Promise<void>;
  onClose: () => void;
}

export default function DuplicatesDialog({ accountId, accountName, onDelete, onClose }: Props) {
  const [window, setWindow] = useState(0);
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(days: number) {
    setBusy(true);
    setError(null);
    try {
      setGroups(await api.findDuplicates(accountId, days));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load(window);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, window]);

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    try {
      await onDelete(id);
      await load(window);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const total = groups?.reduce((n, g) => n + g.rows.length - 1, 0) ?? 0;

  return (
    <>
      <div className="tm-dialog-backdrop" onClick={onClose} />
      <div className="tm-dialog" role="dialog" aria-label="Find duplicate transactions" style={{ minWidth: 640, maxWidth: "90vw" }}>
        <div className="tm-dialog-title">Find duplicate transactions — {accountName}</div>
        <div className="tm-dialog-body text-[12px]">
          {/* Only the sets scroll. The error and Close used to sit at
              the foot of the scrolling list, so a refused Delete near the top
              of a long one wrote its reason somewhere out of view and read as
              the button doing nothing. */}
          <div className="space-y-2" style={{ maxHeight: "64vh", overflowY: "auto" }}>
            <label className="flex items-center gap-2">
              <span>Same payee and amount, dated</span>
              <select className="aero-field" aria-label="Date window" value={String(window)} onChange={(e) => setWindow(Number(e.target.value))} disabled={busy}>
                <option value="0">the same day</option>
                <option value="3">within 3 days</option>
                <option value="7">within a week</option>
              </select>
            </label>
            {groups === null && !error && <div className="tm-text-muted">Looking…</div>}
            {groups && groups.length === 0 && <div role="status">No duplicates found.</div>}
            {groups && groups.length > 0 && (
              <div role="status" className="tm-text-muted">
                {groups.length} set{groups.length === 1 ? "" : "s"}; {total} possible cop{total === 1 ? "y" : "ies"}. Delete the one that is the copy — usually the
                uncleared one with no memo.
              </div>
            )}
            {groups?.map((g) => (
              <table key={`${g.date}|${g.payee}|${g.amount_cents}`} className="register-table" aria-label={`Duplicates of ${g.payee} on ${formatDateUS(g.date)}`}>
                <thead>
                  <tr>
                    <th colSpan={7}>
                      {g.payee} · <Money cents={g.amount_cents} />
                    </th>
                  </tr>
                  <tr>
                    <th>Date</th>
                    <th>C</th>
                    <th>Num</th>
                    <th>Category</th>
                    <th>Memo</th>
                    <th>Bank id</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {g.rows.map((r) => (
                    <tr key={r.id}>
                      <td>{formatDateUS(r.date)}</td>
                      <td className="mid">{r.cleared_state}</td>
                      <td>{r.check_number ?? ""}</td>
                      <td>{r.is_transfer ? <em>transfer</em> : (r.category_name ?? "")}</td>
                      <td>{r.notes ?? ""}</td>
                      <td className="tm-text-muted">{r.fitid ? "yes" : ""}</td>
                      <td className="num">
                        <button
                          className="aero-btn !py-0 !px-1.5 text-[11px] money-neg"
                          type="button"
                          disabled={busy}
                          onClick={() => void remove(r.id)}
                          title={r.is_transfer ? "This is one half of a transfer — deleting it removes both halves" : "Delete this row"}
                          aria-label={`Delete ${g.payee} ${formatDateUS(r.date)}${r.notes ? ` ${r.notes}` : ""}`}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ))}
          </div>
          {error && (
            <Notice tone="error" boxed className="mt-2">
              {error}
            </Notice>
          )}
          <div className="flex justify-end pt-2">
            <button className="aero-btn" type="button" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
