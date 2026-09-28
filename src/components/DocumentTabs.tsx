// §99 — the Document tabs look.
//
// A register per tab, the way a browser does it. The workflow it changes is
// comparison: with two accounts open you switch between them in time rather
// than in space, and you stop losing your place in one to go and check the
// other.
//
// WHAT A TAB IS. Not a second copy of the register — one register, and a tab
// is a remembered account to point it at. That is the honest version of this
// idea at this size: real multi-document would mean a scroll position, a
// selection and an in-progress edit per tab, which is a data model, not a
// look. Tabs are the account list you have actually been using, kept where
// you can reach it.
import type { Account } from "../lib/types";

interface Props {
  /** Accounts opened this session, oldest first. */
  openIds: string[];
  accounts: Account[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}

export default function DocumentTabs({ openIds, accounts, selectedId, onSelect, onClose }: Props) {
  const tabs = openIds.map((id) => accounts.find((a) => a.id === id)).filter((a): a is Account => !!a);
  if (tabs.length === 0) {
    return (
      <div className="tm-doctabs">
        <span className="tm-text-muted" style={{ padding: "6px 4px", fontSize: 11 }}>
          Open an account and it stays here as a tab.
        </span>
      </div>
    );
  }
  return (
    <div className="tm-doctabs" role="tablist" aria-label="Open registers">
      {tabs.map((a) => (
        <span
          key={a.id}
          className={`tm-doctab${a.id === selectedId ? " active" : ""}`}
          role="tab"
          aria-selected={a.id === selectedId}
          tabIndex={0}
          onClick={() => onSelect(a.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onSelect(a.id);
            }
          }}
        >
          <span className="truncate">{a.name}</span>
          <span
            className="tm-doctab-x"
            role="button"
            aria-label={`Close ${a.name}`}
            tabIndex={0}
            // Closing must not also select: a click on the ✕ of a tab you
            // were not on should close that tab and leave you where you are.
            onClick={(e) => {
              e.stopPropagation();
              onClose(a.id);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                onClose(a.id);
              }
            }}
          >
            ✕
          </span>
        </span>
      ))}
    </div>
  );
}
