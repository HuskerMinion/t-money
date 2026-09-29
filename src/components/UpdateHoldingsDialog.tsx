// Money's 401(k) Manager / "Update your shares". The statement says
// what is held on a date; type it in — shares, or the value, with the price
// if the statement gives one — and the app writes an Add Shares or Remove
// Shares row per security for the difference, and records the price. For a
// 401(k) that only sends statements, this is how the register stays honest
// without typing every contribution.
//
// Nothing is computed here beyond what the row needs to be sent: the
// backend works out shares from value ÷ price and reports the change; the
// dialog previews that (a dry run) before it writes.
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/ipc";
import { noteChanged } from "../lib/undo";
import Notice from "./Notice";
import { formatMoney, parseMoneyToCents, today } from "../lib/format";
import { formatPrice, formatShares, parseMicro } from "../lib/shares";
import type { Account, HoldingChange, Position, Security, StatementHolding } from "../lib/types";

interface Props {
  account: Account;
  securities: readonly Security[];
  onCancel: () => void;
  onDone: (changes: HoldingChange[]) => void;
}

interface Line {
  security_id: string;
  shares: string;
  price: string;
  value: string;
}

export function linesToRequest(lines: readonly Line[]): StatementHolding[] {
  return lines
    .filter((l) => l.security_id && (l.shares.trim() || l.value.trim()))
    .map((l) => ({
      security_id: l.security_id,
      shares_micro: l.shares.trim() ? parseMicro(l.shares) : null,
      price_micro: l.price.trim() ? parseMicro(l.price) : null,
      value_cents: l.value.trim() ? parseMoneyToCents(l.value) : null,
    }));
}

export default function UpdateHoldingsDialog({ account, securities, onCancel, onDone }: Props) {
  const [date, setDate] = useState(today());
  const [positions, setPositions] = useState<Position[] | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [plan, setPlan] = useState<HoldingChange[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // What the register says is held on the date: one line per position, the
  // price pre-filled with the latest known so a shares-only statement is a
  // single column of typing.
  useEffect(() => {
    let canceled = false;
    api
      .getPortfolio(account.id, date)
      .then((p) => {
        if (canceled) return;
        setPositions(p.positions);
        setLines((old) => {
          const kept = new Map(old.map((l) => [l.security_id, l]));
          const next = p.positions.map((pos) => kept.get(pos.security_id) ?? { security_id: pos.security_id, shares: "", price: pos.price_micro ? formatPrice(pos.price_micro).replace(/,/g, "") : "", value: "" });
          for (const l of old) if (!p.positions.some((pos) => pos.security_id === l.security_id)) next.push(l);
          return next;
        });
      })
      .catch((e) => {
        if (!canceled) setError(String(e));
      });
    return () => {
      canceled = true;
    };
  }, [account.id, date]);

  const request = useMemo(() => linesToRequest(lines), [lines]);
  const bad = lines.find((l) => (l.shares.trim() && parseMicro(l.shares) === null) || (l.price.trim() && parseMicro(l.price) === null) || (l.value.trim() && parseMoneyToCents(l.value) === null));

  useEffect(() => {
    if (request.length === 0 || bad) {
      setPlan(null);
      return;
    }
    let canceled = false;
    api
      .updateHoldings(account.id, date, request, true)
      .then((p) => {
        if (!canceled) {
          setPlan(p);
          setError(null);
        }
      })
      .catch((e) => {
        if (canceled) return;
        // The last good preview goes with the failure. Kept, it went on
        // showing a change for figures that were no longer the ones typed, and
        // left Update enabled to write what the backend had just refused.
        setPlan(null);
        setError(String(e));
      });
    return () => {
      canceled = true;
    };
  }, [account.id, date, request, bad]);

  function set(i: number, patch: Partial<Line>) {
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  }

  const unused = securities.filter((s) => !lines.some((l) => l.security_id === s.id));
  const planFor = (id: string) => plan?.find((c) => c.security_id === id);
  const changes = plan?.filter((c) => !c.problem && c.delta_micro !== 0).length ?? 0;
  const problems = plan?.filter((c) => c.problem).length ?? 0;

  async function apply() {
    setBusy(true);
    setError(null);
    try {
      const done = await api.updateHoldings(account.id, date, request, false);
      noteChanged(); // The backend cleared the undo stack.
      onDone(done);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <div className="tm-dialog" role="dialog" aria-label="Update holdings from a statement" style={{ width: 720 }}>
      <div className="tm-dialog-title">Update holdings from a statement — {account.name}</div>
      <div className="tm-dialog-body space-y-2 text-[12px]">
        <p>
          Type what the statement says is held. Shares, or the value with the statement's price; the difference from the register becomes an Add Shares or Remove Shares row dated the statement, and the price is recorded. Cash is not touched.
        </p>
        <label className="inline-flex items-center gap-1">
          Statement date
          <input className="aero-field" type="date" aria-label="Statement date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <table className="tm-report-table w-full" aria-label="Statement holdings">
          <thead>
            <tr>
              <th>Investment</th>
              <th className="num">Held now</th>
              <th className="num">Shares on statement</th>
              <th className="num">Price</th>
              <th className="num">Value</th>
              <th className="num">Change</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const sec = securities.find((s) => s.id === l.security_id);
              const pos = positions?.find((p) => p.security_id === l.security_id);
              const c = planFor(l.security_id);
              return (
                <tr key={l.security_id || `new-${i}`}>
                  <td>
                    {sec ? (
                      `${sec.name}${sec.symbol ? ` (${sec.symbol})` : ""}`
                    ) : (
                      <select className="aero-field" aria-label="Add investment" value={l.security_id} onChange={(e) => set(i, { security_id: e.target.value })}>
                        <option value="">Pick an investment…</option>
                        {unused.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                            {s.symbol ? ` (${s.symbol})` : ""}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td className="num">{pos ? formatShares(pos.shares_micro) : "0"}</td>
                  <td className="num">
                    <input className="aero-field text-right" style={{ width: 100 }} aria-label={`Shares of ${sec?.name ?? "new investment"}`} value={l.shares} onChange={(e) => set(i, { shares: e.target.value })} />
                  </td>
                  <td className="num">
                    <input className="aero-field text-right" style={{ width: 90 }} aria-label={`Price of ${sec?.name ?? "new investment"}`} value={l.price} onChange={(e) => set(i, { price: e.target.value })} />
                  </td>
                  <td className="num">
                    <input className="aero-field text-right" style={{ width: 100 }} aria-label={`Value of ${sec?.name ?? "new investment"}`} value={l.value} onChange={(e) => set(i, { value: e.target.value })} placeholder="or the value" />
                  </td>
                  <td className={`num${c?.problem ? " money-neg" : ""}`} aria-label={`Change for ${sec?.name ?? "new investment"}`}>
                    {c?.problem
                      ? c.problem
                      : c
                        ? c.delta_micro === 0
                          ? "no change"
                          : `${c.delta_micro > 0 ? "+" : ""}${formatShares(c.delta_micro)} sh (${formatMoney(c.gross_cents)})`
                        : ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {unused.length > 0 && !lines.some((l) => !l.security_id) && (
          <button type="button" className="tm-link" onClick={() => setLines((ls) => [...ls, { security_id: "", shares: "", price: "", value: "" }])}>
            + Another investment on the statement
          </button>
        )}
        {bad && <div className="money-neg">Shares and prices take up to six decimals; values are dollars and cents.</div>}
        {error && (
          <Notice tone="error" boxed>
            {error}
          </Notice>
        )}
        <div className="flex items-center gap-2 pt-3">
          <span className="tm-text-muted flex-1">
            {plan ? `${changes} ${changes === 1 ? "row" : "rows"} to write${problems ? `, ${problems} ${problems === 1 ? "line needs" : "lines need"} attention` : ""}.` : "Enter the statement's shares or values."}
          </span>
          <button className="aero-btn default" type="button" disabled={busy || !plan || changes === 0 || problems > 0} onClick={() => void apply()}>
            Update
          </button>
          <button className="aero-btn" type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
