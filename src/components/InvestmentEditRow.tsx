// The investment register's entry form — Money's "Buy / Sell / Dividend
// / Reinvest…" form, in place in the grid like TransactionEditRow.
//
// The form owns what the user knows: the activity, the security, how many
// shares, the price OR the total, a commission, where the money came from
// or went, and — for a sale — which lots. It never owns the cash effect:
// that is derived by the backend from the activity (a buy can only ever
// take cash), and the form only previews it.
//
// Quantity, price and total are three numbers with one relationship — until
// the user says otherwise. A field the user has not typed in is derived from
// the other two and shown grayed; typing in it makes it the user's own, and
// from then on it is kept as typed. So on a new row "quantity, price" fills
// the total and "quantity, total" fills the price, as before; but a row can
// also carry BOTH a typed price and a typed total that do not multiply out
// exactly, which is what a broker's confirmation looks like: the NAV to
// four or six places, the total to the cent. An existing row opens
// with both as stored. Clearing a field hands it back to derivation. What
// was typed is what is sent; the backend derives whatever was not.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import CategoryCombo, { type ComboItem } from "./CategoryCombo";
import { api } from "../lib/ipc";
import { formatAmountBare, formatDateUS, formatMoney, parseMoneyToCents, today } from "../lib/format";
import {
  ACTIVITY_LABELS,
  CASH_ACTIVITIES,
  cashActivity,
  CLOSING_ACTIVITIES,
  LOT_METHODS,
  allocateLots,
  type LotMethod,
  INCOME_ACTIVITIES,
  SHARE_ACTIVITIES,
  cashEffect,
  formatPrice,
  formatPriceInput,
  formatShares,
  isLongTerm,
  parseMicro,
  priceFrom,
  valueCents,
} from "../lib/shares";
import { currentRegion } from "../lib/region";
import DateField from "./DateField";
import type { LeaveResult } from "./TransactionEditRow";
import type {
  Account,
  Category,
  InvestmentActivity,
  Lot,
  LotAllocation,
  NewInvestmentTransaction,
  RegisterRow,
  Security,
} from "../lib/types";

export interface ShareTransferDraft {
  fromAccountId: string;
  toAccountId: string;
  date: string;
  securityId: string;
  sharesMicro: number;
  notes: string | null;
  lotAllocations: LotAllocation[];
}

interface Props {
  accountId: string;
  /** Editing this row; omit for a new entry. */
  row?: RegisterRow | null;
  /** The C cell toggles the open row's cleared mark. */
  onToggleCleared?: () => void;
  /** A new entry starts on the last date entered, not today. */
  defaultDate?: string | null;
  /** Save-on-leave, as TransactionEditRow. */
  leaveRef?: React.MutableRefObject<(() => Promise<LeaveResult>) | null>;
  securities: readonly Security[];
  categories: readonly Category[];
  /** Bank accounts a buy can be paid from / a sale swept to. */
  fundingAccounts: readonly Account[];
  onCommit: (id: string | null, t: NewInvestmentTransaction) => Promise<void>;
  /** Transfer Shares: both halves in one call. */
  onTransferShares: (t: ShareTransferDraft) => Promise<void>;
  /** The user picked one of the cash entries from the Activity list —
   *  a contribution, a fee, a withdrawal. The register swaps this form for
   *  the ordinary transaction form, seeded for that kind. */
  onCashActivity?: (key: string) => void;
  /** Other investment accounts, for Transfer Shares. */
  transferTargets?: readonly Account[];
  onCancel: () => void;
  /** Create a security mid-entry; resolves to its id. */
  onCreateSecurity: (name: string) => Promise<string>;
  busy?: boolean;
  columns?: number;
}

const COLUMNS = 10;

/** An amount to put in a box: no thousands marks, the region's decimal
 *  mark ("1234.56", "1234,56"). */
function amountInput(cents: number): string {
  return formatAmountBare(cents).split(currentRegion().group).join("");
}

export default function InvestmentEditRow({
  accountId,
  row = null,
  securities,
  categories,
  fundingAccounts,
  onCommit,
  onTransferShares,
  onCashActivity,
  transferTargets = [],
  onCancel,
  onCreateSecurity,
  busy = false,
  columns = COLUMNS,
  onToggleCleared,
  defaultDate = null,
  leaveRef,
}: Props) {
  const [date, setDate] = useState(row?.date ?? defaultDate ?? today());
  const [activity, setActivity] = useState<InvestmentActivity | "transfer_shares">(row?.activity ?? "buy");
  const [securityId, setSecurityId] = useState(row?.security_id ?? "");
  const [shares, setShares] = useState(row?.shares_micro ? formatShares(row.shares_micro) : "");
  const [price, setPrice] = useState(row?.price_micro ? formatPriceInput(row.price_micro) : "");
  const [total, setTotal] = useState(row?.gross_cents ? amountInput(row.gross_cents) : "");
  // Which of price / total the user owns (see the header comment). A field
  // the user has just emptied stays empty while it has focus — the derived
  // number comes back when the field is left — so backspacing to retype
  // does not fight the derivation.
  const [typed, setTyped] = useState<{ price: boolean; total: boolean }>({ price: !!row?.price_micro, total: !!row?.gross_cents });
  const [emptied, setEmptied] = useState<{ price: boolean; total: boolean }>({ price: false, total: false });
  const [commission, setCommission] = useState(row?.commission_cents ? formatAmountBare(row.commission_cents) : "");
  const [categoryId, setCategoryId] = useState(row?.category_id ?? "");
  const [notes, setNotes] = useState(row?.notes ?? "");
  // An existing buy/sell opens with the account its cash came from or
  // went to, and can change it.
  const [funding, setFunding] = useState(row?.funding_account_id ?? "");
  // Transfer Shares: the account the shares go to.
  const [toAccount, setToAccount] = useState("");
  // Money's distribution methods: FIFO is the backend's own; LIFO,
  // Max gain and Min gain are computed here from the open lots and sent as
  // specified lots; Specify is the user's own picks.
  const [lotMode, setLotMode] = useState<LotMethod>(row?.lot_specified ? "specify" : "fifo");
  const [lots, setLots] = useState<Lot[]>([]);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  // Hand-picked shares belong to the lots of ONE security on ONE
  // date. They were kept when either changed: the old picks no longer had a
  // row in the lot table, still counted toward "Picked", and the sale was
  // refused with a total nobody could see to fix.
  function changeSecurity(id: string) {
    if (id !== securityId) setPicked({});
    setSecurityId(id);
  }
  function changeDate(next: string) {
    if (next !== date) setPicked({});
    setDate(next);
  }

  const isTransfer = activity === "transfer_shares";
  const needsShares = SHARE_ACTIVITIES.has(activity) || isTransfer;
  const isIncome = INCOME_ACTIVITIES.has(activity);
  const isClosing = CLOSING_ACTIVITIES.has(activity) || isTransfer;
  const isSplit = activity === "split";
  // Income paid in cash can be swept to another account too — a
  // dividend that lands in checking is one entry, not a dividend plus a
  // transfer. Reinvested forms move no cash, so they cannot.
  const isFundable = activity === "buy" || activity === "sell" || activity === "dividend" || activity === "interest" || activity === "ltcg_dist" || activity === "stcg_dist" || activity === "return_of_capital";

  const sharesMicro = needsShares || isSplit ? parseMicro(shares) : null;
  const priceMicro = parseMicro(price);
  const totalCents = parseMoneyToCents(total);
  const commissionCents = commission.trim() ? parseMoneyToCents(commission) : 0;

  // The derived numbers, for display and for what is sent: a total from a
  // typed price, a price from a typed total — only for the field the user
  // does not own.
  const derivedTotal = useMemo(
    () => (needsShares && sharesMicro !== null && sharesMicro > 0 && !typed.total && typed.price && priceMicro !== null ? valueCents(sharesMicro, priceMicro) : null),
    [needsShares, sharesMicro, typed, priceMicro]
  );
  const derivedPrice = useMemo(
    () => (needsShares && sharesMicro !== null && sharesMicro > 0 && !typed.price && typed.total && totalCents !== null ? priceFrom(totalCents, sharesMicro) : null),
    [needsShares, sharesMicro, typed, totalCents]
  );
  // Both typed and they do not multiply out: say so, do not block. A
  // broker's total is the cash that moved; its price is the NAV; neither
  // is wrong.
  const mismatchCents = useMemo(() => {
    if (!needsShares || sharesMicro === null || sharesMicro <= 0 || !typed.price || !typed.total || priceMicro === null || totalCents === null) return null;
    const product = valueCents(sharesMicro, priceMicro);
    return product === totalCents ? null : product;
  }, [needsShares, sharesMicro, typed, priceMicro, totalCents]);

  const grossCents: number | null = isSplit ? 0 : typed.total ? totalCents : derivedTotal;
  const cash = grossCents !== null && commissionCents !== null ? cashEffect(activity, grossCents, commissionCents) : null;

  // Open lots for a sale, as of its date. Editing a sale: its own shares are
  // still "in" the lots at that date, so the list is right for it too.
  useEffect(() => {
    if (!isClosing || !securityId || !date) {
      setLots([]);
      return;
    }
    let live = true;
    api
      .listLots(accountId, securityId, date)
      .then((l) => live && setLots(l))
      .catch(() => live && setLots([]));
    return () => {
      live = false;
    };
  }, [isClosing, securityId, date, accountId]);

  // Editing a sale that specified lots: seed the picker from what it took.
  useEffect(() => {
    if (!row || !CLOSING_ACTIVITIES.has(row.activity ?? "")) return;
    let live = true;
    api
      .getDisposals(row.id)
      .then((d) => {
        if (!live) return;
        const p: Record<string, string> = {};
        for (const x of d) p[x.lot_id] = formatShares(x.shares_micro);
        // These arrive after the form's "as opened" snapshot was
        // taken, so they are what it opened with too; otherwise an untouched
        // sale counted as changed and saved again on leaving.
        openedPicked.current = JSON.stringify(p);
        setPicked(p);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [row]);

  const securityItems: ComboItem[] = securities.map((s) => ({
    value: s.id,
    label: s.symbol ? `${s.name} (${s.symbol})` : s.name,
  }));
  const categoryItems: ComboItem[] = categories
    .filter((c) => c.kind === "income")
    .map((c) => ({ value: c.id, label: c.parent_id ? `${categories.find((p) => p.id === c.parent_id)?.name ?? ""} : ${c.name}` : c.name }));

  const pickedTotal = Object.values(picked).reduce((n, v) => n + (parseMicro(v) ?? 0), 0);
  // A preset's picks, shown in the table read-only and sent on Enter.
  const preset = useMemo(
    () => (isClosing && lotMode !== "fifo" && lotMode !== "specify" && sharesMicro ? allocateLots(lots, sharesMicro, lotMode) : {}),
    [isClosing, lotMode, lots, sharesMicro]
  );

  // The save in progress, as TransactionEditRow: Enter by key was not
  // disabled with the button, so two quick presses recorded a buy twice.
  const inFlight = useRef<Promise<boolean> | null>(null);

  function commit(): Promise<boolean> {
    if (inFlight.current) return inFlight.current;
    const saving = save().finally(() => {
      inFlight.current = null;
    });
    inFlight.current = saving;
    return saving;
  }

  async function save(): Promise<boolean> {
    setError(null);
    if (!securityId) { setError("Pick a security."); return false; }
    // "" is also what DateField sends for a date it cannot read.
    if (!date) { setError("The date is missing or unreadable — type it as 8/3/2026."); return false; }
    if ((needsShares || isSplit) && (sharesMicro === null || sharesMicro <= 0)) {
      { setError(isSplit ? "A split needs a ratio: 2 for a 2-for-1." : "How many shares?"); return false; }
    }
    if (isTransfer && !toAccount) { setError("Which account do the shares go to?"); return false; }
    if (!isSplit && !isTransfer && (grossCents === null || grossCents < 0)) { setError("The total is missing or unreadable."); return false; }
    if (commissionCents === null || commissionCents < 0) { setError("The commission is unreadable."); return false; }
    let lot_allocations: LotAllocation[] = [];
    if (isClosing && lotMode !== "fifo" && lotMode !== "specify") {
      lot_allocations = Object.entries(preset).map(([lot_id, shares_micro]) => ({ lot_id, shares_micro }));
      if (lot_allocations.length === 0 && (sharesMicro ?? 0) > 0) {
        { setError(`Only ${formatShares(lots.reduce((n, l) => n + l.shares_micro, 0))} shares are held on that date.`); return false; }
      }
    }
    if (isClosing && lotMode === "specify") {
      for (const [lot_id, v] of Object.entries(picked)) {
        const n = parseMicro(v);
        if (n === null || n < 0) { setError("A lot's share count is unreadable."); return false; }
        if (n > 0) lot_allocations.push({ lot_id, shares_micro: n });
      }
      if (pickedTotal !== sharesMicro) {
        setError(`The lots you picked add up to ${formatShares(pickedTotal)} shares; the sale is ${formatShares(sharesMicro ?? 0)}.`);
        return false;
      }
    }
    if (isTransfer) {
      try {
        await onTransferShares({
          fromAccountId: accountId,
          toAccountId: toAccount,
          date,
          securityId,
          sharesMicro: sharesMicro ?? 0,
          notes: notes.trim() ? notes.trim() : null,
          lotAllocations: lot_allocations,
        });
      } catch (e) {
        setError(String(e));
        return false;
      }
      return true;
    }
    const t: NewInvestmentTransaction = {
      account_id: accountId,
      date,
      activity,
      security_id: securityId,
      shares_micro: sharesMicro ?? 0,
      price_micro: needsShares && typed.price ? priceMicro : null,
      gross_cents: grossCents ?? 0,
      commission_cents: commissionCents,
      category_id: isIncome && categoryId ? categoryId : null,
      notes: notes.trim() ? notes.trim() : null,
      funding_account_id: isFundable && funding ? funding : null,
      lot_allocations,
    };
    try {
      await onCommit(row?.id ?? null, t);
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    }
  }

  // Save when the register moves on, if anything changed.
  // The picks are compared on their own: a sale's picks load after this
  // first render (see the disposals effect), which sets `openedPicked`.
  const snapshot = () => JSON.stringify([date, activity, securityId, shares, price, total, commission, categoryId, notes, funding, toAccount, lotMode]);
  const opened = useRef<string | null>(null);
  if (opened.current === null) opened.current = snapshot();
  const openedPicked = useRef(JSON.stringify({}));
  const dirty =
    snapshot() !== opened.current ||
    JSON.stringify(picked) !== openedPicked.current ||
    (row === null && (securityId !== "" || shares !== "" || total !== ""));
  useLayoutEffect(() => {
    if (!leaveRef) return;
    leaveRef.current = async () => {
      if (!dirty) return "clean";
      return (await commit()) ? "saved" : "failed";
    };
    return () => {
      if (leaveRef) leaveRef.current = null;
    };
  });


  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) {
      e.preventDefault();
      void commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  }

  return (
    <>
      <tr className="active" onKeyDown={onKeyDown}>
        <td />
        <td />
        <td>
          <DateField value={date} onChange={changeDate} />
        </td>
        <td>
          <select
            className="aero-field w-full"
            aria-label="Activity"
            value={activity}
            onChange={(e) => {
              const v = e.target.value;
              // The cash entries are not activities on this form — they
              // hand the row over to the ordinary transaction form.
              if (onCashActivity && cashActivity(v)) {
                onCashActivity(v);
                return;
              }
              setActivity(v as InvestmentActivity | "transfer_shares");
            }}
            autoFocus
          >
            {ACTIVITY_LABELS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
            {!row && <option value="transfer_shares">Transfer Shares (to another account)</option>}
            {!row && onCashActivity && (
              <optgroup label="Cash — no shares change hands">
                {CASH_ACTIVITIES.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </td>
        <td>
          <CategoryCombo
            items={securityItems}
            value={securityId}
            onChange={changeSecurity}
            label="Investment"
            placeholder="Investment"
            className="aero-field w-full"
            onAddNew={(name) => {
              void onCreateSecurity(name).then(changeSecurity).catch((e) => setError(String(e)));
            }}
          />
        </td>
        <td className="mid">
          {row && onToggleCleared ? (
            <button type="button" className="tm-clear-toggle" aria-label={row.cleared_state ? "Unclear this transaction" : "Clear this transaction"} title="Click to toggle cleared (Ctrl+M)" onClick={onToggleCleared}>
              {row.cleared_state || "·"}
            </button>
          ) : (
            row?.cleared_state ?? ""
          )}
        </td>
        <td>
          <input
            className="aero-field w-full text-right"
            aria-label={isSplit ? "Ratio" : "Quantity"}
            placeholder={isSplit ? "New for 1" : "Quantity"}
            value={shares}
            onChange={(e) => setShares(e.target.value)}
            disabled={!needsShares && !isSplit}
            title={isSplit ? "New shares per old share: 2 for a 2-for-1, 0.5 for a 1-for-2 reverse split" : undefined}
          />
        </td>
        <td>
          <input
            className="aero-field w-full text-right"
            aria-label="Price"
            placeholder="Price"
            value={!typed.price && !emptied.price && derivedPrice !== null ? formatPriceInput(derivedPrice) : price}
            onChange={(e) => {
              const own = e.target.value.trim() !== "";
              setPrice(e.target.value);
              setTyped((t) => ({ ...t, price: own }));
              setEmptied((t) => ({ ...t, price: !own }));
            }}
            onBlur={() => setEmptied((t) => ({ ...t, price: false }))}
            disabled={!needsShares || isTransfer}
            title={!typed.price && derivedPrice !== null ? "From the total ÷ quantity. Type here to set the price yourself (up to six decimals); clear it to go back." : "Up to six decimals. Clear it to derive from the total."}
            style={!typed.price && derivedPrice !== null ? { color: "var(--tm-ms-text-muted)" } : undefined}
          />
        </td>
        <td>
          <input
            className="aero-field w-full text-right"
            aria-label="Total"
            placeholder={isSplit ? "" : isIncome ? "Amount" : "Total"}
            value={!typed.total && !emptied.total && derivedTotal !== null ? amountInput(derivedTotal) : total}
            onChange={(e) => {
              const own = e.target.value.trim() !== "";
              setTotal(e.target.value);
              setTyped((t) => ({ ...t, total: own }));
              setEmptied((t) => ({ ...t, total: !own }));
            }}
            onBlur={() => setEmptied((t) => ({ ...t, total: false }))}
            disabled={isSplit || isTransfer}
            title={!typed.total && derivedTotal !== null ? "From quantity × price. Type here to set the total yourself; clear it to go back." : "Clear it to derive from quantity × price."}
            style={!typed.total && derivedTotal !== null ? { color: "var(--tm-ms-text-muted)" } : undefined}
          />
        </td>
        <td className="num tm-text-muted" title="What this does to the account's cash">
          {cash !== null && !isSplit && !isTransfer ? formatMoney(cash) : ""}
        </td>
      </tr>

      <tr className="active" onKeyDown={onKeyDown}>
        <td colSpan={columns}>
          <div className="flex items-center gap-2 py-1 flex-wrap">
            {isTransfer && (
              <>
                <label htmlFor="inv-to" className="text-right" style={{ width: 90 }}>
                  To account:
                </label>
                <select id="inv-to" className="aero-field" value={toAccount} onChange={(e) => setToAccount(e.target.value)}>
                  <option value="">(choose)</option>
                  {transferTargets.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                <span className="tm-text-muted">The lots move with their dates and cost — nothing is sold.</span>
              </>
            )}
            {mismatchCents !== null && (
              <span className="tm-text-muted" role="note" title="Both are kept as typed. The total is what the cash did; the price is what the shares were valued at.">
                Quantity × price = {formatMoney(mismatchCents)}; total kept at {formatMoney(totalCents ?? 0)}.
              </span>
            )}
            {!isSplit && !isTransfer && (
              <>
                <label htmlFor="inv-commission" className="text-right" style={{ width: 90 }}>
                  Commission:
                </label>
                <input
                  id="inv-commission"
                  className="aero-field text-right"
                  style={{ width: 90 }}
                  value={commission}
                  onChange={(e) => setCommission(e.target.value)}
                  placeholder={`0${currentRegion().decimal}00`}
                />
              </>
            )}
            {isFundable && (
              <>
                <label htmlFor="inv-funding">{activity === "buy" ? "Pay from:" : "Deposit to:"}</label>
                <select id="inv-funding" className="aero-field" value={funding} onChange={(e) => setFunding(e.target.value)}>
                  <option value="">This account's cash</option>
                  {fundingAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                {row && <span className="tm-text-muted">(changing it rewrites the linked cash transfer)</span>}
              </>
            )}
            {isIncome && (
              <>
                <label htmlFor="inv-category">Category:</label>
                <CategoryCombo
                  id="inv-category"
                  items={categoryItems}
                  value={categoryId}
                  onChange={setCategoryId}
                  label="Category"
                  placeholder="(standard for this activity)"
                  style={{ width: 240 }}
                />
              </>
            )}
            <label htmlFor="inv-memo">Memo:</label>
            <input id="inv-memo" className="aero-field flex-1" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          {isClosing && (
            <div className="py-1">
              <div className="flex items-center gap-3">
                <span style={{ width: 90 }} className="text-right">
                  Lots:
                </span>
                <select className="aero-field" aria-label="Lot method" value={lotMode} onChange={(e) => setLotMode(e.target.value as LotMethod)} title={LOT_METHODS.find(([m]) => m === lotMode)?.[2]}>
                  {LOT_METHODS.map(([m, label]) => (
                    <option key={m} value={m}>
                      {label}
                    </option>
                  ))}
                </select>
                {lots.length > 0 && (
                  <span className="tm-text-muted">
                    {formatShares(lots.reduce((n, l) => n + l.shares_micro, 0))} shares held on {formatDateUS(date)}
                  </span>
                )}
              </div>
              {lotMode !== "fifo" && (
                <table className="tm-lot-table" aria-label="Open lots">
                  <thead>
                    <tr>
                      <th>Acquired</th>
                      <th className="num">Held</th>
                      <th className="num">Cost</th>
                      <th className="num">Cost/share</th>
                      <th>Term on sale</th>
                      <th className="num">Sell</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lots.map((l) => (
                      <tr key={l.id}>
                        <td>{formatDateUS(l.acquired_on)}</td>
                        <td className="num">{formatShares(l.shares_micro)}</td>
                        <td className="num">{formatAmountBare(l.cost_cents)}</td>
                        <td className="num">{formatPrice(priceFrom(l.cost_cents, l.shares_micro))}</td>
                        <td>{isLongTerm(l.acquired_on, date) ? "Long-term" : "Short-term"}</td>
                        <td className="num">
                          {lotMode === "specify" ? (
                            <input
                              className="aero-field text-right"
                              style={{ width: 90 }}
                              aria-label={`Shares from the lot of ${l.acquired_on}`}
                              value={picked[l.id] ?? ""}
                              onChange={(e) => setPicked({ ...picked, [l.id]: e.target.value })}
                              onDoubleClick={() => setPicked({ ...picked, [l.id]: formatShares(l.shares_micro) })}
                              title="Double-click for the whole lot"
                            />
                          ) : (
                            <span aria-label={`Shares from the lot of ${l.acquired_on}`}>{preset[l.id] ? formatShares(preset[l.id]) : ""}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {lots.length === 0 && (
                      <tr>
                        <td colSpan={6} className="tm-text-muted">
                          Nothing held in this account on that date.
                        </td>
                      </tr>
                    )}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={5} className="text-right">
                        {lotMode === "specify" ? "Picked" : "Taken"}: {formatShares(lotMode === "specify" ? pickedTotal : Object.values(preset).reduce((n, v) => n + v, 0))} of {sharesMicro !== null ? formatShares(sharesMicro) : "—"}
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              )}
            </div>
          )}
        </td>
      </tr>

      <tr className="active">
        <td colSpan={columns}>
          <div className="flex items-center gap-2 py-1">
            <button className="aero-btn" type="button" onClick={() => void commit()} disabled={busy}>
              Enter
            </button>
            <button className="aero-btn" type="button" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            {error && <span className="money-neg">{error}</span>}
          </div>
        </td>
      </tr>
    </>
  );
}
