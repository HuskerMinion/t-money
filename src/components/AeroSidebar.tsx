// Slate-blue sidebar with grouped navigation and "More ▶" jump links,
// mimicking the MS Money Plus left rail.
import { useState } from "react";
import { accountWorth } from "../lib/accountTypes";
import { currencyOf } from "../lib/currency";
import TmIcon from "./TmIcon";
import Money from "./Money";
import type { Account } from "../lib/types";

interface NavItem {
  id: string;
  label: string;
  icon: string; // T-Money sprite icon name (no "tm-" prefix)
}

interface NavGroup {
  title: string;
  items: NavItem[];
  more?: string; // "More ▶" jump target label
}

const GROUPS: NavGroup[] = [
  {
    title: "Banking",
    items: [
      { id: "accounts", label: "Accounts", icon: "accounts" },
      { id: "transactions", label: "Transactions", icon: "transactions" },
      { id: "reconcile", label: "Reconcile", icon: "sync" },
    ],
    more: "All Banking",
  },
  {
    title: "Bills",
    items: [
      { id: "payees", label: "Payees", icon: "profile" },
      { id: "bills", label: "Bills to Pay", icon: "calendar" },
    ],
    more: "All Bills",
  },
  {
    title: "Reports",
    items: [
      { id: "spending", label: "Spending", icon: "reports" },
      { id: "income-expenses", label: "Income & Expenses", icon: "reports" },
      { id: "networth", label: "Net Worth", icon: "investments" },
      { id: "monthly-report", label: "This Month's Report", icon: "calendar" },
    ],
    more: "All Reports",
  },
  {
    title: "Budget",
    items: [
      { id: "budget", label: "Budgets", icon: "budgeting" },
      { id: "categories", label: "Categories", icon: "filter" },
    ],
    more: "Budget Tools",
  },
];

/** The header's tabs, for the Sidebar look. Kept as a literal rather than
 *  imported from AeroHeader so the rail does not depend on the header it
 *  replaces. */
const SIDEBAR_TABS = ["Home", "Banking", "Bills", "Reports", "Budget", "Investing", "Planning", "Taxes", "Help"] as const;

interface AeroSidebarProps {
  active: string;
  onSelect: (id: string) => void;
  /** Accounts are listed under the "Accounts" rail item, as in Money. */
  accounts?: readonly Account[];
  selectedAccountId?: string | null;
  onSelectAccount?: (id: string) => void;
  /** Rail width in px — the user drags the edge. */
  width?: number;
  /** The Sidebar look has no tab strip, so the tabs live here, above the
   *  rail's own items. Absent for every other look. */
  tabs?: { active: string; onTab: (t: never) => void };
}

export default function AeroSidebar({
  width = 208,
  tabs,
  active,
  onSelect,
  accounts = [],
  selectedAccountId = null,
  onSelectAccount,
}: AeroSidebarProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // The Accounts item expands to the account list; open by default so the
  // accounts are visible the way Money's rail shows them.
  const [accountsOpen, setAccountsOpen] = useState(true);
  // The rail lists OPEN accounts. A closed one sat at the bottom with
  // its $0.00 (N9: "The rail … also shows it at the bottom of the list");
  // closing an account is asking for it to get out of the way. Account List's
  // "Show closed accounts" is where it is still found, as the Three-pane
  // look's account bar already had it.
  const open = accounts.filter((a) => !a.is_closed);

  return (
    <aside
      className="aero-sidebar shrink-0 overflow-y-auto select-none"
      style={{ width }}
      aria-label="Money navigation"
    >
      {/* The Sidebar look's navigation. The tab strip is gone from the
          header, so the tabs are here, above the rail's own items and marked
          off from them: they are different things and looking like one list
          would make the rail's items read as sub-tabs of nothing. */}
      {tabs && (
        <div className="tm-rail-tabs">
          {SIDEBAR_TABS.map((t) => (
            <button
              key={t}
              type="button"
              className={`aero-side-item ${tabs.active === t ? "active" : ""}`}
              onClick={() => (tabs.onTab as (x: string) => void)(t)}
            >
              {t}
            </button>
          ))}
        </div>
      )}
      {GROUPS.map((g) => (
        <div key={g.title}>
          <div className="aero-side-group">{g.title}</div>
          {g.items.map((it) => (
            <div key={it.id}>
              <div
                className={`aero-side-item ${active === it.id ? "active" : ""}`}
                onClick={() => {
                  if (it.id === "accounts") setAccountsOpen((o) => !o);
                  onSelect(it.id);
                }}
              >
                <span className="w-4 flex justify-center">
                  {/* The rail is LIGHT in Money, so icons use the normal
                      --tm-icon-* tones — no inverse treatment. */}
                  <TmIcon name={it.icon} size={16} />
                </span>
                <span>{it.label}</span>
                {it.id === "accounts" && open.length > 0 && (
                  <span className="ml-auto">{accountsOpen ? "▾" : "▸"}</span>
                )}
              </div>

              {/* Accounts nested under the Accounts item. */}
              {it.id === "accounts" && accountsOpen && open.length > 0 && (
                <div className="pb-1">
                  {open.map((a) => (
                    <div
                      key={a.id}
                      className={`aero-side-item pl-8 ${
                        a.id === selectedAccountId ? "active" : ""
                      }`}
                      title={a.name}
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectAccount?.(a.id);
                      }}
                    >
                      <span className="truncate flex-1">{a.name}</span>
                      <span className="tabular-nums" style={{ color: "var(--tm-ms-text)" }}>
                        <Money cents={accountWorth(a)} currency={currencyOf(a)} />
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
          {g.more && (
            <div
              className="aero-side-more"
              onClick={() => setExpanded((e) => ({ ...e, [g.title]: !e[g.title] }))}
            >
              {expanded[g.title] ? "Less ▲" : `More ▶`}
            </div>
          )}
          {g.more && expanded[g.title] && (
            <div className="pl-6 pb-1" style={{ color: "var(--tm-ms-text-link)" }}>
              <div className="py-0.5 cursor-pointer hover:underline" onClick={() => onSelect(`${g.title}-detail`)}>
                {g.more}
              </div>
            </div>
          )}
        </div>
      ))}
    </aside>
  );
}
