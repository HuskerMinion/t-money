// Plan statement memos — what each line of a 401(k) export means.
//
// A plan administrator writes only the share side: a Buy for every payroll
// contribution with no record of the money arriving, a ShrsOut for the
// quarterly fee, a Buy again for a reinvested dividend. Imported literally
// the cash goes deeply negative and the fees disappear. What tells them apart
// is the memo — and no two administrators word it the same, so the guess is
// shown and the user confirms it.
import { useEffect, useState } from "react";
import Money from "./Money";
import { api } from "../lib/ipc";
import type { ImportMatchPreview, MemoGroup, MemoRule, Treatment } from "../lib/types";

/** A plan that only lets you download 90 days at a time is imported
 *  four times a year, and retyping the same answers each time is the kind of
 *  friction that stops people keeping the account current. The answers are
 *  remembered per account. */
const REMEMBERED = (accountId: string) => `plan.memoRules.${accountId}`;

/** One spelling of the (activity, memo) key, used to build the state and to
 *  read the remembered answers back. Two spellings of it is exactly the bug
 *  that made the remembered rules silently not apply. */
const ruleKey = (activity: string, memo: string) => `${activity}\u0000${memo}`;

interface Props {
  preview: ImportMatchPreview;
  onConfirm: (rules: MemoRule[]) => void;
  onCancel: () => void;
}

const LABEL: Record<Treatment, string> = {
  as_is: "Leave as it is",
  contribution: "Contribution",
  reinvest: "Reinvested dividend",
  fee: "Fee",
  withdrawal: "Withdrawal",
};

const EXPLAIN: Record<Treatment, string> = {
  as_is: "Written exactly as the file says. A buy with no money behind it leaves the cash short.",
  contribution: "The purchase, and a deposit beside it for the same amount — money you earned and never saw.",
  reinvest: "A distribution paid in shares: the income is booked, the shares arrive, no cash moves.",
  fee: "The shares sold to pay it, and the fee as an expense, so it shows in your spending.",
  withdrawal: "The sale, and the money leaving the account beside it.",
};

/** Which treatments want a category, and so a box to name one. */
const NEEDS_CATEGORY: Treatment[] = ["contribution", "fee", "withdrawal"];

export default function PlanMemoDialog({ preview, onConfirm, onCancel }: Props) {
  const [rules, setRules] = useState<Record<string, MemoRule>>(() => {
    const out: Record<string, MemoRule> = {};
    for (const g of preview.memo_groups) {
      out[key(g)] = { memo: g.memo, activity: g.activity, treatment: g.guess, category: g.default_category };
    }
    return out;
  });
  const [remembered, setRemembered] = useState(false);

  // Anything answered for this account before wins over the guess.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const saved = await api.getUiSetting(REMEMBERED(preview.account_id));
        if (!saved || !live) return;
        const saved_rules: MemoRule[] = JSON.parse(saved);
        // Built outside the state updater: calling another setter from inside
        // one is not something React promises to honor.
        const byKey = new Map(saved_rules.map((r) => [ruleKey(r.activity, r.memo), r]));
        setRules((current) => {
          const next = { ...current };
          for (const [k, r] of byKey) {
            if (next[k]) next[k] = { ...next[k], treatment: r.treatment, category: r.category ?? next[k].category };
          }
          return next;
        });
        // Read off the groups, not off the updater: an updater runs when React
        // decides to, which is after this line.
        if (preview.memo_groups.some((g) => byKey.has(ruleKey(g.activity, g.memo)))) setRemembered(true);
      } catch {
        // A setting that will not parse is not worth failing an import over.
      }
    })();
    return () => {
      live = false;
    };
  }, [preview.account_id]);

  // Import stayed live while the answers were being remembered, and
  // the parent starts the import only once that save has answered: a second
  // click in that gap sent a second onConfirm, and the statement in twice.
  const [busy, setBusy] = useState(false);

  async function confirm() {
    if (busy) return;
    setBusy(true);
    const out = Object.values(rules);
    try {
      await api.setUiSetting(REMEMBERED(preview.account_id), JSON.stringify(out));
    } catch {
      // Remembering is a convenience; the import matters more.
    }
    onConfirm(out);
  }

  function key(g: { activity: string; memo: string }) {
    return ruleKey(g.activity, g.memo);
  }

  function set(g: MemoGroup, patch: Partial<MemoRule>) {
    setRules((r) => ({ ...r, [key(g)]: { ...r[key(g)], ...patch } }));
  }

  const anyPaired = Object.values(rules).some((r) => r.treatment !== "as_is");

  return (
    <>
      <div className="tm-dialog-backdrop" onClick={busy ? undefined : onCancel} />
      <div className="tm-dialog" role="dialog" aria-label="What the memos mean" style={{ minWidth: 780, maxWidth: "94vw" }}>
        <div className="tm-dialog-title">What the memos mean — {preview.account_name}</div>
        <div className="tm-dialog-body space-y-3 text-[12px]" style={{ maxHeight: "80vh", overflowY: "auto" }}>
          <div className="tm-text-muted">
            This file records share activity only, the way plan administrators write them. Say what each memo means and the money side
            gets written beside it, so the account&apos;s cash comes out where it should instead of thousands short. Nothing is written
            until you click Import.
          </div>

          <table className="register-table" aria-label="Memos in this file">
            <thead>
              <tr>
                <th>Memo</th>
                <th>The file calls it</th>
                <th className="num">Rows</th>
                <th className="num">Total</th>
                <th>Treat as</th>
                <th>Category</th>
              </tr>
            </thead>
            <tbody>
              {preview.memo_groups.map((g) => {
                const rule = rules[key(g)];
                return (
                  <tr key={key(g)}>
                    <td>{g.memo || <span className="tm-text-muted">(no memo)</span>}</td>
                    <td className="whitespace-nowrap">{g.action}</td>
                    <td className="num">{g.count}</td>
                    <td className="num">
                      <Money cents={g.gross_cents} tone="neutral" />
                    </td>
                    <td>
                      <select
                        className="aero-field"
                        aria-label={`Treat ${g.memo || "(no memo)"} on ${g.action} as`}
                        value={rule.treatment}
                        onChange={(e) => {
                          const treatment = e.target.value as Treatment;
                          set(g, { treatment, category: treatment === g.guess ? g.default_category : defaultFor(treatment) });
                        }}
                      >
                        {g.allowed.map((t) => (
                          <option key={t} value={t}>
                            {LABEL[t]}
                          </option>
                        ))}
                      </select>
                      <div className="tm-text-muted pt-0.5">{EXPLAIN[rule.treatment]}</div>
                    </td>
                    <td>
                      {NEEDS_CATEGORY.includes(rule.treatment) ? (
                        <input
                          className="aero-field"
                          style={{ width: 190 }}
                          aria-label={`Category for ${g.memo || "(no memo)"} on ${g.action}`}
                          value={rule.category ?? ""}
                          placeholder={defaultFor(rule.treatment) ?? ""}
                          onChange={(e) => set(g, { category: e.target.value })}
                        />
                      ) : (
                        <span className="tm-text-muted">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="tm-text-muted">
            A category is created if it does not exist — contributions on the income side, fees on the expense side. Type{" "}
            <code>Parent : Child</code> to put one under another.
            {!anyPaired && " With everything left as it is, this imports exactly as it did before."}
            {remembered && " These are the answers you gave for this account last time."} Whatever you choose is remembered for this
            account, so the next statement arrives already answered.
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button className="aero-btn default" type="button" disabled={busy} onClick={() => void confirm()}>
              {busy ? "Importing…" : "Import"}
            </button>
            <button className="aero-btn" type="button" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function defaultFor(t: Treatment): string | null {
  switch (t) {
    case "contribution":
      return "Retirement Contributions";
    case "fee":
      return "Investment Fees";
    case "withdrawal":
      return "Retirement Income : Plan Withdrawal";
    default:
      return null;
  }
}
