// The Three-pane look's middle column.
//
// A mail client's shape, and it earns its width for the same reason a mail
// client's does: the list is not a menu you pass through, it is information
// you keep in view. Every balance stays on screen while you work inside one
// account, which is the question people actually have open — "what is the
// state of things" — and which Money's rail could only answer by leaving.
//
// Grouped the way the net-worth report groups: what you can spend, what you
// have invested, what you own, what you owe. Sorted by size within a group,
// because the big ones are the ones you are looking for.
//
// Each row is in its own account's currency; a group total adds accounts
// together, so it is in the home currency at today's rate.
import Money from "./Money";
import ContextMenu, { useContextMenu } from "./ContextMenu";
import { accountWorth, placedFirst } from "../lib/accountTypes";
import { currencyOf, homeName, rateOf, worthHome } from "../lib/currency";
import type { Account } from "../lib/types";

interface Props {
  accounts: Account[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Star or unstar the account. Left out, the item is not offered. */
  onToggleFavorite?: (id: string) => void;
}

const GROUPS: [string, string[]][] = [
  ["Bank and cash", ["checking", "savings", "cash", "bank"]],
  ["Investments", ["investment", "retirement", "employee_stock_option", "watch"]],
  ["Property", ["home", "vehicle", "asset"]],
  ["Owed", ["credit", "line_of_credit", "loan", "mortgage", "home_equity_line_of_credit", "liability"]],
];

export default function AccountsPane({ accounts, selectedId, onSelect, onToggleFavorite }: Props) {
  const ctx = useContextMenu<Account>();
  const open = accounts.filter((a) => !a.is_closed);
  const seen = new Set<string>();

  return (
    <nav className="tm-accounts-pane" aria-label="Accounts">
      {GROUPS.map(([title, kinds]) => {
        // An account that has been placed (Favorites → Organize
        // favorites…) keeps its place; the unplaced sort by size after them,
        // as they always did.
        const rows = open
          .filter((a) => kinds.includes(a.type))
          .sort((a, b) => placedFirst(a, b) || Math.abs(worthHome(b)) - Math.abs(worthHome(a)));
        for (const r of rows) seen.add(r.id);
        if (rows.length === 0) return null;
        const total = rows.reduce((n, a) => n + worthHome(a), 0);
        // A currency with no rate cannot be added in; say so rather than
        // count it as nothing without a word.
        const unrated = rows.filter((a) => rateOf(a) === 0);
        const note = unrated.length
          ? `In ${homeName()}. Leaves out ${unrated.map((a) => a.name).join(", ")} — no rate for ${[...new Set(unrated.map(currencyOf))].join(", ")} (Settings → Currencies).`
          : `In ${homeName()} at today's rates.`;
        return (
          <div key={title}>
            <div className="tm-accounts-group">
              {title} · <span title={note}>
                <Money cents={total} tone="neutral" />
                {unrated.length > 0 && "*"}
              </span>
            </div>
            {rows.map((a) => (
              <Row key={a.id} account={a} active={a.id === selectedId} onSelect={onSelect} onMenu={ctx.open} />
            ))}
          </div>
        );
      })}
      {/* An account whose kind none of the four groups names still has to
          appear — a list of accounts that quietly omits one is worse than no
          list at all. */}
      {open.some((a) => !seen.has(a.id)) && (
        <div>
          <div className="tm-accounts-group">Other</div>
          {open
            .filter((a) => !seen.has(a.id))
            .map((a) => (
              <Row key={a.id} account={a} active={a.id === selectedId} onSelect={onSelect} onMenu={ctx.open} />
            ))}
        </div>
      )}
      {ctx.menu && (
        <ContextMenu
          x={ctx.menu.x}
          y={ctx.menu.y}
          label={`${ctx.menu.target.name} actions`}
          onClose={ctx.close}
          items={[
            { label: "Open register", onSelect: () => onSelect(ctx.menu!.target.id) },
            onToggleFavorite && {
              label: ctx.menu.target.is_favorite ? "Remove from favorites" : "Add to favorites",
              onSelect: () => onToggleFavorite(ctx.menu!.target.id),
            },
          ]}
        />
      )}
    </nav>
  );
}

function Row({
  account,
  active,
  onSelect,
  onMenu,
}: {
  account: Account;
  active: boolean;
  onSelect: (id: string) => void;
  onMenu: (e: React.MouseEvent, a: Account) => void;
}) {
  return (
    <button
      type="button"
      className={`tm-accounts-item${active ? " active" : ""}`}
      aria-current={active ? "true" : undefined}
      onClick={() => onSelect(account.id)}
      onContextMenu={(e) => onMenu(e, account)}
      title={`Open ${account.name}`}
    >
      <span className="tm-accounts-line">
        <span className="truncate">{account.name}</span>
        <Money cents={accountWorth(account)} currency={currencyOf(account)} />
      </span>
      {account.institution && <span className="tm-accounts-sub truncate">{account.institution}</span>}
    </button>
  );
}
