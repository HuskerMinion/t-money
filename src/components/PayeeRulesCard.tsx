// Payee rename rules (§84) — Money's "when a downloaded payee contains X,
// call it Y and file it under Z". Banks write "NETFLIX.COM 866-579-7172 CA";
// the register should say Netflix, and the subscriptions detector (§60)
// should see one Netflix, not two. Rules run on every import; **Apply to
// existing transactions** runs them over what is already in the file.
import { useEffect, useState } from "react";
import CategorySelect from "./CategorySelect";
import { api } from "../lib/ipc";
import { noteChanged } from "../lib/undo";
import { formatMoney, parseMoneyToCents } from "../lib/format";
import { useAccountStore } from "../stores/useAccountStore";
import type { Category, PayeeRule } from "../lib/types";

interface Props {
  categories: readonly Category[];
  /** Called after Apply changed rows, so the caller can reload payees / registers. */
  onApplied?: (changed: number) => Promise<void> | void;
}

/** §171 — "$5.00 to $20.00 · memo has "prime" · in Visa", or "" when a rule
 *  looks only at the text. */
export function describeConditions(r: PayeeRule): string {
  const parts: string[] = [];
  const lo = r.min_cents ?? null;
  const hi = r.max_cents ?? null;
  if (lo !== null && hi !== null) parts.push(`${formatMoney(lo)} to ${formatMoney(hi)}`);
  else if (lo !== null) parts.push(`at least ${formatMoney(lo)}`);
  else if (hi !== null) parts.push(`at most ${formatMoney(hi)}`);
  if (r.memo_contains) parts.push(`memo has "${r.memo_contains}"`);
  if (r.account_name) parts.push(`in ${r.account_name}`);
  return parts.join(" · ");
}

export default function PayeeRulesCard({ categories, onApplied }: Props) {
  const [rules, setRules] = useState<PayeeRule[]>([]);
  const [matchText, setMatchText] = useState("");
  const [payeeName, setPayeeName] = useState("");
  const [categoryId, setCategoryId] = useState("");
  // §171 — the conditions beyond the text. Empty is "any".
  const [minAmount, setMinAmount] = useState("");
  const [maxAmount, setMaxAmount] = useState("");
  const [memoContains, setMemoContains] = useState("");
  const [accountId, setAccountId] = useState("");
  const accounts = useAccountStore((s) => s.accounts);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setRules(await api.listPayeeRules());
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function add() {
    setError(null);
    setMsg(null);
    // §183 — an amount limit that does not read as an amount is refused, the
    // way every other amount field is. It used to become "any": type "5,OO"
    // (letter O) in "at least" and the rule was saved with no floor at all,
    // matching every Amazon order instead of the ones it was meant for.
    const min = minAmount.trim() ? parseMoneyToCents(minAmount) : null;
    if (minAmount.trim() && min === null) {
      setError(`"${minAmount.trim()}" is not an amount. Leave "Amount at least" empty for any amount.`);
      return;
    }
    const max = maxAmount.trim() ? parseMoneyToCents(maxAmount) : null;
    if (maxAmount.trim() && max === null) {
      setError(`"${maxAmount.trim()}" is not an amount. Leave "at most" empty for any amount.`);
      return;
    }
    setBusy(true);
    try {
      const when = min !== null || max !== null || memoContains.trim() || accountId
        ? { min_cents: min === null ? null : Math.abs(min), max_cents: max === null ? null : Math.abs(max), memo_contains: memoContains.trim() || null, account_id: accountId || null }
        : undefined;
      await api.createPayeeRule(matchText, payeeName, categoryId || null, when);
      setMatchText("");
      setPayeeName("");
      setCategoryId("");
      setMinAmount("");
      setMaxAmount("");
      setMemoContains("");
      setAccountId("");
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(r: PayeeRule) {
    setBusy(true);
    setError(null);
    try {
      await api.deletePayeeRule(r.id);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const n = await api.applyPayeeRules();
      // §183 — "rename payees" is an undo step; the Edit menu has to hear
      // about it, or Undo goes on naming the write before it.
      noteChanged();
      setMsg(n === 0 ? "Nothing in the file needed changing." : `Changed ${n} transaction${n === 1 ? "" : "s"}.`);
      if (n > 0) await onApplied?.(n);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="aero-card" data-payee-rules aria-label="Payee rename rules">
      <div className="aero-card-title flex items-center justify-between gap-2">
        <span>Rename rules</span>
        <button
          className="aero-btn !py-0 !px-2 text-[11px] font-normal"
          type="button"
          onClick={() => void apply()}
          disabled={busy || rules.length === 0}
          title="Run every rule over the transactions already in the file: rename the payee, and set the category where the row has none"
        >
          Apply to existing transactions
        </button>
      </div>
      <div className="p-3 space-y-2 text-[12px]">
        <div className="text-slate-500">
          A downloaded payee that <b>contains</b> the text is filed under the name — and the category, when the download gave
          none. Rules run on every import. A rule with a condition (an amount range, a memo, an account) outranks one
          without; among those, the longest match wins.
        </div>
        {rules.length > 0 && (
          <table className="register-table" aria-label="Rules">
            <thead>
              <tr>
                <th>When the payee contains</th>
                <th>Only when</th>
                <th>Call it</th>
                <th>Category</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id}>
                  <td>{r.match_text}</td>
                  <td className="tm-text-muted">{describeConditions(r)}</td>
                  <td>{r.payee_name}</td>
                  <td>{r.category_name ?? <span className="tm-text-muted">(as downloaded)</span>}</td>
                  <td className="num">
                    <button className="aero-btn !py-0 !px-1.5 text-[11px] money-neg" type="button" onClick={() => void remove(r)} disabled={busy} aria-label={`Delete rule ${r.match_text}`}>
                      Del
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form
          className="flex items-end gap-2 flex-wrap"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <label className="flex flex-col text-[11px]">
            Contains
            <input className="aero-field" value={matchText} onChange={(e) => setMatchText(e.target.value)} placeholder="NETFLIX" style={{ width: 160 }} />
          </label>
          <label className="flex flex-col text-[11px]">
            Call it
            <input className="aero-field" value={payeeName} onChange={(e) => setPayeeName(e.target.value)} placeholder="Netflix" style={{ width: 160 }} />
          </label>
          <span className="flex flex-col text-[11px]" style={{ width: 200 }}>
            Category (optional)
            <CategorySelect className="aero-field" label="Rule category" categories={categories} value={categoryId} onChange={setCategoryId} />
          </span>
          {/* §171 — only when… Each is optional; a rule with a condition
              outranks one without, so Amazon under $20 can be Books while
              Amazon is Household. */}
          <label className="flex flex-col text-[11px]">
            Amount at least
            <input className="aero-field" value={minAmount} onChange={(e) => setMinAmount(e.target.value)} placeholder="any" style={{ width: 90 }} aria-label="Amount at least" />
          </label>
          <label className="flex flex-col text-[11px]">
            at most
            <input className="aero-field" value={maxAmount} onChange={(e) => setMaxAmount(e.target.value)} placeholder="any" style={{ width: 90 }} aria-label="Amount at most" />
          </label>
          <label className="flex flex-col text-[11px]">
            Memo contains
            <input className="aero-field" value={memoContains} onChange={(e) => setMemoContains(e.target.value)} placeholder="any" style={{ width: 120 }} aria-label="Memo contains" />
          </label>
          <label className="flex flex-col text-[11px]">
            In account
            <select className="aero-field" value={accountId} onChange={(e) => setAccountId(e.target.value)} aria-label="Rule account" style={{ width: 150 }}>
              <option value="">any</option>
              {accounts.filter((a) => !a.is_closed).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <button className="aero-btn" type="submit" disabled={busy || !matchText.trim() || !payeeName.trim()}>
            Add rule
          </button>
        </form>
        {msg && <div role="status">{msg}</div>}
        {error && <div className="money-neg">{error}</div>}
      </div>
    </section>
  );
}
