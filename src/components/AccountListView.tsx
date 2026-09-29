// Account list — Money's grouped account index.
//
// "Click the account you want to use." Accounts are links, grouped under Bank /
// Credit / Investment / Other, with collapsible group headers. Closed accounts
// render grayed, and only once "Show closed accounts" is ticked.
import { Fragment, useEffect, useState } from "react";
import Money from "./Money";
import { ACCOUNT_GROUPS, accountWorth, groupFor, isValuedAsset, labelFor, placedFirst, type AccountGroup } from "../lib/accountTypes";
import { maskNumber } from "./AccountDetailsDialog";
import { api } from "../lib/ipc";
import type { Account } from "../lib/types";

interface Props {
  accounts: readonly Account[];
  onOpen: (id: string) => void;
  onAddAccount: () => void;
  onEditDetails: (id: string) => void;
  /** Money's "Delete account" — removes the account AND its transactions,
   *  so the caller confirms before this fires. */
  onDeleteAccount: (id: string) => void;
  /** Money's "Merge duplicate accounts": fold this one into another. */
  onMergeAccount: (id: string) => void;
}

export default function AccountListView({
  accounts,
  onOpen,
  onAddAccount,
  onEditDetails,
  onDeleteAccount,
  onMergeAccount,
}: Props) {
  const [collapsed, setCollapsed] = useState<Partial<Record<AccountGroup, boolean>>>({});
  // N9: "A closed account stays out of the way … and Account List →
  // show closed finds it." Closed accounts are left off the rail and every
  // picker; this is the one place they are still reached from, with their
  // registers and the transfers they hold intact. Off by default, and the
  // box says how many are hidden, so a list that looks short explains itself.
  const [showClosed, setShowClosed] = useState(false);
  const closedCount = accounts.filter((a) => a.is_closed).length;
  // What is owed against each asset, for the equity line under it.
  const [debts, setDebts] = useState<Record<string, number>>({});
  useEffect(() => {
    let live = true;
    void api
      .debtsByAsset()
      .then((d) => {
        if (live) setDebts(d);
      })
      .catch(() => {
        // The list is still a list without it.
      });
    return () => {
      live = false;
    };
  }, [accounts]);

  const byGroup = new Map<AccountGroup, Account[]>();
  for (const g of ACCOUNT_GROUPS) byGroup.set(g, []);
  for (const a of accounts) {
    if (a.is_closed && !showClosed) continue;
    byGroup.get(groupFor(a.type))!.push(a);
  }
  // Placed accounts keep their place; the rest by name after them.
  for (const list of byGroup.values()) list.sort((x, y) => placedFirst(x, y) || x.name.localeCompare(y.name));

  return (
    <section className="aero-card">
      <div className="aero-card-title">Accounts</div>
      <div className="px-3 pt-2 flex items-center gap-4 flex-wrap">
        <p className="flex-1">Click the account you want to use.</p>
        {closedCount > 0 && (
          <label className="inline-flex items-center gap-1">
            <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
            Show closed accounts ({closedCount})
          </label>
        )}
      </div>
      <table className="register-table" style={{ tableLayout: "auto" }}>
        <thead>
          <tr>
            <th>Account ▲</th>
            <th style={{ width: 220 }}>Institution</th>
            <th className="num" style={{ width: 140 }}>
              Balance
            </th>
            <th style={{ width: 150 }} />
          </tr>
        </thead>
        <tbody>
          {ACCOUNT_GROUPS.map((g) => {
            const list = byGroup.get(g)!;
            if (list.length === 0) return null;
            const isCollapsed = collapsed[g] ?? false;
            return (
              <Fragment key={g}>
                <tr
                  className="group"
                  onClick={() => setCollapsed((c) => ({ ...c, [g]: !isCollapsed }))}
                  style={{ cursor: "pointer" }}
                >
                  <td colSpan={4}>
                    {isCollapsed ? "⊞" : "⊟"} {g}
                  </td>
                </tr>
                {!isCollapsed &&
                  list.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <button
                          type="button"
                          className="aero-side-item px-0"
                          style={{
                            color: a.is_closed
                              ? "var(--tm-ms-text-muted)"
                              : "var(--tm-ms-text-link)",
                          }}
                          onClick={() => onOpen(a.id)}
                          title={labelFor(a.type)}
                        >
                          {a.name}
                        </button>
                        {a.is_closed && <span className="tm-text-muted"> (closed)</span>}
                      </td>
                      <td style={{ color: "var(--tm-ms-text-muted)" }}>
                        {[a.institution, a.account_number ? maskNumber(a.account_number) : null]
                          .filter(Boolean)
                          .join(" · ")}
                      </td>
                      <td className="num">
                        <Money cents={accountWorth(a)} />
                        {/* A house with a mortgage on it is worth the
                            difference to you. Both accounts are already in net
                            worth, so this is a reading of them, not a third
                            number. */}
                        {isValuedAsset(a.type) && (debts[a.id] ?? 0) !== 0 && (
                          <div className="tm-text-muted" style={{ fontSize: "0.9em" }}>
                            less <Money cents={debts[a.id]} tone="neutral" /> owed ={" "}
                            <Money cents={accountWorth(a) - debts[a.id]} tone="neutral" /> equity
                          </div>
                        )}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="aero-btn"
                          onClick={() => onEditDetails(a.id)}
                        >
                          Details
                        </button>{" "}
                        <button
                          type="button"
                          className="aero-btn"
                          aria-label={`Merge ${a.name}`}
                          title="Merge this account into another (a duplicate)"
                          onClick={() => onMergeAccount(a.id)}
                        >
                          Merge
                        </button>{" "}
                        <button
                          type="button"
                          className="aero-btn"
                          aria-label={`Delete ${a.name}`}
                          onClick={() => onDeleteAccount(a.id)}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      <div className="register-footer">
        <button className="aero-btn" type="button" onClick={onAddAccount}>
          Add a new account
        </button>
      </div>
    </section>
  );
}
