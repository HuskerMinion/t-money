// FavoriteAccountsWidget — modular dashboard card listing favorite accounts
// with their balances (red-paren negatives).
import MarketWatermark from "./MarketWatermark";
import Money from "./Money";
import { accountWorth } from "../lib/accountTypes";
import TmIcon from "./TmIcon";
import { useAccountStore } from "../stores/useAccountStore";

const TYPE_ICON: Record<string, string> = {
  checking: "accounts",
  savings: "goals",
  credit: "payments",
  cash: "transactions",
};

interface Props {
  /** Open the account's register. Selecting alone is not enough: the card used
   *  to call `selectAccount` and leave the user on Home, where nothing visibly
   *  happened. */
  onOpen?: (id: string) => void;
}

export default function FavoriteAccountsWidget({ onOpen }: Props) {
  const favorites = useAccountStore((s) => s.favorites);
  const selectAccount = useAccountStore((s) => s.selectAccount);

  function open(id: string) {
    if (onOpen) onOpen(id);
    else selectAccount(id);
  }

  return (
    /* The watermark belongs to the CARD, not to the list inside it.
       It was on the scrolling rows container, so it covered only as much of
       the card as the rows happened to occupy — and it scrolled with them.
       On the section it spans the title band and the rows, which is what
       "behind the card" means. */
    <section className="aero-card tm-watermarked">
      <MarketWatermark />
      <div className="aero-card-title flex items-center justify-between">
        <span>Favorite Accounts</span>
        <span className="text-[10px] font-normal text-slate-500">
          {favorites.length} shown
        </span>
      </div>
      <div className="p-2 tm-home-scroll">
        {favorites.length === 0 ? (
          <div className="text-[12px] text-slate-500 p-3 text-center">
            No favorite accounts yet. Star an account to pin it here.
          </div>
        ) : (
          <table className="w-full text-[12px]">
            <tbody>
              {favorites.map((a) => (
                <tr
                  key={a.id}
                  className="cursor-pointer hover:bg-blue-50/60"
                  role="button"
                  tabIndex={0}
                  aria-label={`Open ${a.name}`}
                  title={`Open ${a.name}`}
                  onClick={() => open(a.id)}
                  onKeyDown={(e) => {
                    // A row that only responds to a mouse is not a control.
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      open(a.id);
                    }
                  }}
                >
                  <td className="py-1 pr-2">
                    <span className="mr-1 inline-flex align-middle">
                      <TmIcon name={TYPE_ICON[a.type] ?? "accounts"} size={15} />
                    </span>
                    {a.name}
                  </td>
                  <td className="py-1 text-right font-medium tabular-nums">
                    <Money cents={accountWorth(a)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
