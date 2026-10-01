// The header's Search box, answered.
//
// "Where did that $340 go", "when did I last pay the vet". One query across
// payee, memo, check number, category and amount; scoped to one account or
// all of them; a click opens the row in its register. Money put this front
// and center, and the box had sat in the header holding its own state with
// nothing reading it.
import { useEffect, useState } from "react";
import TmIcon from "./TmIcon";
import Money from "./Money";
import { api } from "../lib/ipc";
import { formatDateUS } from "../lib/format";
import { useAccountStore } from "../stores/useAccountStore";
import { currencyOf } from "../lib/currency";
import type { SearchHit } from "../lib/types";

interface Props {
  query: string;
  /** Open this hit's account register with the row selected. */
  onOpen: (hit: SearchHit) => void;
}

export default function SearchResults({ query, onOpen }: Props) {
  const accounts = useAccountStore((s) => s.accounts);
  const [scope, setScope] = useState<string>("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Each hit is in its own account's currency.
  const currencyFor = (id: string) => {
    const a = accounts.find((x) => x.id === id);
    return a ? currencyOf(a) : undefined;
  };

  useEffect(() => {
    let canceled = false;
    setHits(null);
    setError(null);
    api
      .searchTransactions(query, scope || null)
      .then((h) => {
        if (!canceled) setHits(h);
      })
      .catch((e) => {
        if (!canceled) setError(String(e));
      });
    return () => {
      canceled = true;
    };
  }, [query, scope]);

  return (
    <section className="aero-card">
      <div className="aero-card-title flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2">
          <TmIcon name="search" size={15} /> Search: “{query}”
        </span>
        <label className="inline-flex items-center gap-1 text-[12px] font-normal">
          In:
          <select
            className="aero-field"
            aria-label="Search scope"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          >
            <option value="">All accounts</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && <div className="px-3 py-2 money-neg">{error}</div>}
      {!error && hits === null && <div className="px-3 py-2 text-slate-500">Searching…</div>}
      {hits && hits.length === 0 && (
        <div className="px-3 py-2 text-slate-600">
          Nothing matches. Search looks at the payee, memo, number, category and
          amount — an amount like <code>340</code> or <code>$1,234.56</code> finds
          rows of exactly that size.
        </div>
      )}
      {hits && hits.length > 0 && (
        <div className="overflow-auto">
          <table className="register-table w-full" aria-label="Search results">
            <thead>
              <tr>
                <th>Date</th>
                <th>Account</th>
                <th>Num</th>
                <th>Payee</th>
                <th>Category</th>
                <th className="text-right">Amount</th>
                <th>Memo</th>
              </tr>
            </thead>
            <tbody>
              {hits.map((h) => (
                <tr
                  key={h.id}
                  className={h.is_void ? "voided" : undefined}
                  style={{ cursor: "pointer" }}
                  onClick={() => onOpen(h)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onOpen(h);
                  }}
                  tabIndex={0}
                  aria-label={`Open ${h.payee} on ${formatDateUS(h.date)}`}
                >
                  <td>{formatDateUS(h.date)}</td>
                  <td>{h.account_name}</td>
                  <td>{h.check_number ?? ""}</td>
                  <td>{h.payee}</td>
                  <td>{h.category_name ?? ""}</td>
                  <td className="text-right">
                    <Money cents={h.amount_cents} currency={currencyFor(h.account_id)} />
                  </td>
                  <td>{h.notes ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {hits.length >= 200 && (
            <div className="px-3 py-1 text-[12px] text-slate-600">
              Showing the newest 200. Narrow the search, or pick one account.
            </div>
          )}
        </div>
      )}
    </section>
  );
}
