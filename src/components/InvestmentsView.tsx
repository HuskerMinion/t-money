// Investing — Money's Portfolio page: every holding by account, at the
// latest prices, with the cost basis and gain that the LOTS say, not a
// number anyone typed. A holding opens to show its lots; a security opens
// to its price history. The register is where buys and sells are entered
// (open an investment account); this page is what they add up to.
import { useEffect, useRef, useState } from "react";
import Money from "./Money";
import TmIcon from "./TmIcon";
import Notice from "./Notice";
import { api } from "../lib/ipc";
import { useCommand } from "../lib/useCommand";
import { formatDateUS, formatMoney, today } from "../lib/format";
import { formatPrice, formatShares, isLongTerm, parseMicro, priceFrom, valueCents } from "../lib/shares";
import type { HoldingRounding, Portfolio, Position, PriceStatus, Performance, RoiPeriod, Security, SecurityKind, SecurityPrice } from "../lib/types";
import { isStale, stalenessNote } from "../lib/prices";

interface Props {
  onOpenAccount?: (accountId: string) => void;
}

export const SECURITY_KINDS: [SecurityKind, string][] = [
  ["stock", "Stock"],
  ["mutual_fund", "Mutual fund"],
  ["etf", "ETF"],
  ["bond", "Bond"],
  ["cd", "CD"],
  ["money_market", "Money market"],
  ["other", "Other"],
];

export default function InvestmentsView({ onOpenAccount }: Props) {
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [securities, setSecurities] = useState<Security[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [priceStatus, setPriceStatus] = useState<PriceStatus | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [panel, setPanel] = useState<"none" | "securities">("none");
  const [roi, setRoi] = useState<RoiPeriod[] | null>(null);
  // The two returns Money never had, by period: for every
  // holding, or one fund (`perfFor` is its security id); loaded on its
  // own, after the page, so the holdings never wait for it.
  const [perf, setPerf] = useState<Performance[] | null>(null);
  // Two pickers: the account (every investment account, or one)
  // and the holding (the whole of that, or one security in it). "My TSP is
  // all in the S Fund; I want the whole plan's return AND the fund's."
  const [perfAccount, setPerfAccount] = useState("");
  const [perfFor, setPerfFor] = useState("");
  const [perfSerial, setPerfSerial] = useState(0);
  // A failed performance load is its own state. It used to become an
  // empty list, which read "Nothing held long enough to measure" — a claim
  // about the holdings, made when nothing had been measured at all.
  const [perfError, setPerfError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const [p, s, r] = await Promise.all([api.getPortfolio(), api.listSecurities(), api.getRoi()]);
      setPortfolio(p);
      setSecurities(s);
      setRoi(r);
      setPerfSerial((n) => n + 1);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (perfSerial === 0) return;
    let alive = true;
    setPerf(null);
    setPerfError(null);
    api
      .getPerformance(perfAccount || null, null, perfFor || null)
      .then((f) => {
        if (alive) setPerf(f);
      })
      .catch((e) => {
        if (alive) setPerfError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [perfAccount, perfFor, perfSerial]);

  // How old the prices are. Shown beside the portfolio, because a
  // market value is only as current as the price under it, and this app
  // fetches only when asked.
  async function loadPriceStatus() {
    try {
      setPriceStatus(await api.priceStatus());
    } catch {
      setPriceStatus(null);
    }
  }
  useEffect(() => {
    void loadPriceStatus();
  }, []);

  // The holdings table is where the user looks for a symbol, so it is also
  // where one gets typed (the Securities panel's Edit form does the same
  // thing, three clicks further away). Only the symbol changes; name, type
  // and notes are sent back as they are.
  async function setSymbol(securityId: string, symbol: string) {
    const sec = securities.find((x) => x.id === securityId);
    if (!sec) return;
    setError(null);
    try {
      await api.updateSecurity(sec.id, sec.name, symbol.trim().toUpperCase(), sec.kind, sec.notes);
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  async function refreshPrices(auto = false) {
    setRefreshing(true);
    setMsg(null);
    try {
      const s = await api.refreshInvestmentPrices(auto);
      const parts = [`${s.updated} updated`];
      if (s.skipped) parts.push(`${s.skipped} without a symbol`);
      // A line with no symbol is about the run ("3 more not tried").
      for (const f of s.failures) parts.push(f.symbol ? `${f.symbol}: ${f.reason}` : f.reason);
      setMsg(parts.join(" · "));
      await load();
      await loadPriceStatus();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setRefreshing(false);
    }
  }

  // Tools → Update prices, offered only while the Portfolio is open and
  // there is a symbol to look up.
  useCommand("tools.update.prices", () => void refreshPrices(), !refreshing && securities.length > 0);

  const positions = portfolio?.positions ?? [];
  const totals = portfolio && Array.isArray(portfolio.positions) ? portfolio : null;
  const accounts: { id: string; name: string; rows: Position[] }[] = [];
  for (const p of positions) {
    let a = accounts.find((x) => x.id === p.account_id);
    if (!a) {
      a = { id: p.account_id, name: p.account_name, rows: [] };
      accounts.push(a);
    }
    a.rows.push(p);
  }

  return (
    <div className="grid grid-cols-1 gap-4">
      <section className="aero-card">
        <div className="aero-card-title flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-2">
            <TmIcon name="investments" size={15} /> Portfolio
            {portfolio && <span className="tm-text-muted font-normal">as of {formatDateUS(portfolio.as_of)}</span>}
            {priceStatus && stalenessNote(priceStatus, today()) && (
              <span
                className={isStale(priceStatus, today()) ? "money-neg font-normal" : "tm-text-muted font-normal"}
                title={
                  priceStatus.oldest_date
                    ? `The oldest holding was last priced on ${formatDateUS(priceStatus.oldest_date)}. Prices are fetched only when you ask, or on the schedule in Settings → Prices.`
                    : "Nothing here has ever been priced."
                }
              >
                · {stalenessNote(priceStatus, today())}
              </span>
            )}
          </span>
          <span className="inline-flex gap-2">
            <button className="aero-btn !py-0 !px-2 text-[11px]" type="button" onClick={() => setPanel(panel === "securities" ? "none" : "securities")}>
              {panel === "securities" ? "Hide securities" : "Securities…"}
            </button>
            <button
              className="aero-btn !py-0 !px-2 text-[11px]"
              type="button"
              onClick={() => void refreshPrices()}
              disabled={refreshing || securities.length === 0}
              title="Fetch today's prices. Sends only your ticker symbols."
            >
              {refreshing ? "Fetching…" : "Update prices"}
            </button>
          </span>
        </div>
        <div className="p-2 max-h-[60vh] overflow-y-auto">
          {error && (
            <Notice tone="error" boxed className="mb-2">
              {error}
            </Notice>
          )}
          {msg && <div className="text-[12px] p-2">{msg}</div>}
          {/* Rows the lot engine could not honor — a sale of more shares
              than were held, usually a stray fraction left by an import. They
              must never be hidden, but they are also not news after the first
              read, and a plan with a dozen of them pushed the holdings table
              off the screen. Folded away, with the count still in plain sight. */}
          {(portfolio?.problems ?? []).length > 0 && (
            <details className="tm-notes">
              <summary className="money-neg">
                {portfolio!.problems.length} row{portfolio!.problems.length === 1 ? "" : "s"} the share ledger could not
                honor
              </summary>
              <div className="tm-notes-body">
                {portfolio!.problems.map((p) => (
                  <div key={p} className="text-[12px] money-neg py-1">
                    {p}
                  </div>
                ))}
              </div>
            </details>
          )}
          {totals && positions.length === 0 ? (
            <div className="text-[12px] text-slate-500 p-3 text-center">
              Nothing held. Open an investment or retirement account's register and enter a Buy or Add Shares.
            </div>
          ) : (
            <table className="register-table" aria-label="Holdings">
              <thead>
                <tr>
                  <th>Holding</th>
                  <th>Symbol</th>
                  <th className="num">Shares</th>
                  <th className="num">Last price</th>
                  <th className="num">Cost basis</th>
                  <th className="num">Market value</th>
                  <th className="num">Gain / loss</th>
                  <th className="num">Return</th>
                </tr>
              </thead>
              {accounts.map((a) => {
                const cost = a.rows.reduce((n, r) => n + r.cost_cents, 0);
                const value = a.rows.reduce((n, r) => n + r.value_cents, 0);
                return (
                  <tbody key={a.id}>
                    <tr className="group">
                      <td colSpan={8}>
                        {onOpenAccount ? (
                          <button type="button" className="tm-link" onClick={() => onOpenAccount(a.id)} title="Open the register">
                            {a.name}
                          </button>
                        ) : (
                          a.name
                        )}
                      </td>
                    </tr>
                    {a.rows.map((p) => {
                      const key = `${p.account_id}|${p.security_id}`;
                      const isOpen = open === key;
                      return (
                        <PositionRows key={key} p={p} open={isOpen} onToggle={() => setOpen(isOpen ? null : key)} onSetSymbol={setSymbol} rounding={p.rounding ?? portfolio?.rounding ?? "nearest"} />
                      );
                    })}
                    <tr>
                      <td colSpan={4} className="text-right tm-text-muted">
                        Total {a.name}
                      </td>
                      <td className="num">
                        <Money cents={cost} tone="neutral" />
                      </td>
                      <td className="num">
                        <Money cents={value} tone="neutral" />
                      </td>
                      <td className="num">
                        <Money cents={value - cost} />
                      </td>
                      <td className="num">{pctText(value - cost, cost)}</td>
                    </tr>
                  </tbody>
                );
              })}
              {totals && (
                <tfoot>
                  <tr>
                    <td colSpan={4}>Holdings</td>
                    <td className="num">
                      <Money cents={totals.total_cost_cents} tone="neutral" />
                    </td>
                    <td className="num">
                      <Money cents={totals.total_value_cents} tone="neutral" />
                    </td>
                    <td className="num">
                      <Money cents={totals.total_value_cents - totals.total_cost_cents} />
                    </td>
                    <td className="num">{pctText(totals.total_value_cents - totals.total_cost_cents, totals.total_cost_cents)}</td>
                  </tr>
                  <tr>
                    <td colSpan={5}>Cash in investment accounts</td>
                    <td className="num">
                      <Money cents={totals.cash_cents} tone="neutral" />
                    </td>
                    <td colSpan={2} />
                  </tr>
                  <tr className="font-bold">
                    <td colSpan={5}>Total</td>
                    <td className="num">
                      <Money cents={totals.cash_cents + totals.total_value_cents} tone="neutral" />
                    </td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              )}
            </table>
          )}
        </div>
      </section>

      {panel === "securities" && <SecuritiesPanel securities={securities} onChanged={load} />}

      {/* Performance: what the investments earned (time-weighted,
          the number to hold against a benchmark) and what the investor
          earned (money-weighted, where the timing of the money counts). */}
      {positions.length > 0 && (
        <section className="aero-card">
          <div className="aero-card-title flex items-center justify-between gap-2 flex-wrap">
            <span>Performance</span>
            {/* The account, then the holding within it. Both lists
                are what is actually held. */}
            <span className="flex items-center gap-2 font-normal text-[11px]">
              <select
                className="aero-field !py-0 text-[11px] font-normal"
                aria-label="Performance account"
                value={perfAccount}
                onChange={(e) => {
                  setPerfAccount(e.target.value);
                  setPerfFor("");
                }}
              >
                <option value="">All investment accounts</option>
                {[...new Map(positions.map((p) => [p.account_id, p.account_name])).entries()]
                  .sort((a, b) => a[1].localeCompare(b[1]))
                  .map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
              </select>
              <select className="aero-field !py-0 text-[11px] font-normal" aria-label="Performance holding" value={perfFor} onChange={(e) => setPerfFor(e.target.value)}>
                <option value="">{perfAccount ? "Whole account" : "All holdings"}</option>
                {[...new Map(positions.filter((p) => !perfAccount || p.account_id === perfAccount).map((p) => [p.security_id, p.security_name])).entries()]
                  .sort((a, b) => a[1].localeCompare(b[1]))
                  .map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
              </select>
            </span>
          </div>
          <div className="p-2">
            {perfError && (
              <Notice tone="error" boxed>
                The returns could not be worked out: {perfError}
              </Notice>
            )}
            {perf === null && !perfError && <div className="tm-text-muted text-[12px]">Working out the returns…</div>}
            {perf && perf.length === 0 && <div className="tm-text-muted text-[12px]">Nothing held long enough to measure.</div>}
            {perf && perf.length > 0 && (
            <table className="register-table" aria-label="Performance">
              <thead>
                <tr>
                  <th>Period</th>
                  <th className="num">Start value</th>
                  <th className="num">Money in</th>
                  <th className="num">Money out</th>
                  <th className="num">End value</th>
                  <th className="num">Gain</th>
                  <th className="num">Time-weighted</th>
                  <th className="num">Per year</th>
                  <th className="num">Money-weighted, per year</th>
                </tr>
              </thead>
              <tbody>
                {perf.map((r) => (
                  <tr key={r.label}>
                    <td title={`${formatDateUS(r.from)} through ${formatDateUS(r.to)}${r.flow_days ? ` — money moved on ${r.flow_days} ${r.flow_days === 1 ? "day" : "days"}` : ""}`}>{r.label}</td>
                    <td className="num"><Money cents={r.start_value_cents} tone="neutral" /></td>
                    <td className="num">{r.flows_in_cents ? <Money cents={r.flows_in_cents} tone="neutral" /> : ""}</td>
                    <td className="num">{r.flows_out_cents ? <Money cents={r.flows_out_cents} tone="neutral" /> : ""}</td>
                    <td className="num"><Money cents={r.end_value_cents} tone="neutral" /></td>
                    <td className="num font-bold"><Money cents={r.gain_cents} /></td>
                    <td className="num" aria-label={`${r.label} time-weighted`}>{r.twr_bps === null ? "—" : pctFromBps(r.twr_bps)}</td>
                    <td className="num" aria-label={`${r.label} time-weighted per year`}>{r.twr_annual_bps === null ? "—" : pctFromBps(r.twr_annual_bps)}</td>
                    <td className="num" aria-label={`${r.label} money-weighted per year`}>{r.mwr_annual_bps === null ? "—" : pctFromBps(r.mwr_annual_bps)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            )}
            <div className="text-[11px] tm-text-muted pt-1 space-y-1">
              <div>
                <b>Gain</b> = end value − start value − money in + money out: what the investments themselves made, with your own deposits and withdrawals taken back out.{" "}
                {perfFor
                  ? "For one holding, value is its shares at the day's price, money in is what it cost to buy (and the value of shares moved into it), and money out is what selling it brought (and the value of shares moved out). A fund you move in and out of often shows large money in and money out — every move counts — and that is expected."
                  : "For an account, value is the holdings at the day's price plus cash, and money in and out is what crossed into or out of the account: contributions, transfers, withdrawals. Dividends and fees stay inside the account and are part of the gain."}
              </div>
              <div>
                <b>Time-weighted</b> is the investments' return, as a fund or an index would report it: growth is measured between the days money moved, then chained, so a big deposit the day before a drop does not count against the fund. <b>Money-weighted</b> is your return: one yearly rate that accounts for when your money went in and came out, so it is lower than time-weighted when most of the money arrived late and then fell, and higher when it arrived early and rose. <b>Per year</b> and <b>money-weighted</b> are shown only for periods of a year or more; a month's move made into a yearly rate is not a number to act on.
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Allocation: what kind of thing the money is in. The security
          type comes from Securities…; an imported one starts as Other. */}
      {positions.length > 0 && (() => {
        const labels: Record<string, string> = { stock: "Stocks", etf: "Exchange-traded funds", mutual_fund: "Mutual funds", bond: "Bonds", cd: "CDs", money_market: "Money market", other: "Other" };
        const by = new Map<string, number>();
        for (const p of positions) by.set(p.security_kind, (by.get(p.security_kind) ?? 0) + p.value_cents);
        const cash = portfolio?.cash_cents ?? 0;
        if (cash > 0) by.set("cash", cash);
        const total = [...by.values()].reduce((n, v) => n + v, 0);
        const rows = [...by.entries()].sort((a, b) => b[1] - a[1]);
        return total > 0 ? (
          <section className="aero-card">
            <div className="aero-card-title">Allocation</div>
            <div className="p-2">
              <table className="register-table" aria-label="Allocation" style={{ tableLayout: "auto", width: "auto" }}>
                <thead>
                  <tr>
                    <th>Kind</th>
                    <th className="num" style={{ width: 130 }}>Value</th>
                    <th className="num" style={{ width: 70 }}>Share</th>
                    <th style={{ width: 240 }} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map(([kind, value]) => (
                    <tr key={kind}>
                      <td>{kind === "cash" ? "Cash" : labels[kind] ?? kind}</td>
                      <td className="num"><Money cents={value} tone="neutral" /></td>
                      <td className="num">{pctFromBps(Math.round((value * 10000) / total))}</td>
                      <td>
                        <div style={{ height: 8, width: `${Math.max(1, Math.round((value * 100) / total))}%`, background: "var(--tm-series-1)" }} aria-hidden="true" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="text-[11px] tm-text-muted pt-1">
                By the type set on each security under Securities…; a security brought in by an import starts as Other until you say what it is. The Asset allocation report has the same by account.
              </div>
            </div>
          </section>
        ) : null;
      })()}

      {roi && positions.length > 0 && (
        <section className="aero-card">
          <div className="aero-card-title">Return on investment</div>
          <div className="p-2">
            <table className="register-table" aria-label="Return on investment">
              <thead>
                <tr>
                  <th>Period</th>
                  <th className="num">Value then</th>
                  <th className="num">Price change</th>
                  <th className="num">Realized</th>
                  <th className="num">Income</th>
                  <th className="num">Return</th>
                  <th className="num">%</th>
                </tr>
              </thead>
              <tbody>
                {roi.map((r) => (
                  <tr key={r.label}>
                    <td title={r.from ? `${formatDateUS(r.from)} through ${formatDateUS(r.to)}` : `Through ${formatDateUS(r.to)}`}>{r.label}</td>
                    <td className="num">{r.label === "All time" ? <span className="tm-text-muted">cost</span> : <Money cents={r.start_value_cents} tone="neutral" />}</td>
                    <td className="num">
                      <Money cents={r.unrealized_change_cents} />
                    </td>
                    <td className="num">
                      <Money cents={r.realized_cents} />
                    </td>
                    <td className="num">
                      <Money cents={r.income_cents} />
                    </td>
                    <td className="num font-bold">
                      <Money cents={r.return_cents} />
                    </td>
                    <td className="num" aria-label={`${r.label} return`}>{r.return_bps === null ? "—" : pctFromBps(r.return_bps)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="text-[11px] tm-text-muted pt-1">
              Return = change in unrealized gain + gains realized + dividends and interest, so money put in or taken out is not counted as a return. % is against the value at the start of the period; all time is against everything ever put in.
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

/** Basis points → "1.5%", rounded in integers (145 bps is 1.45%, which a
 *  float would print as 1.4). */
export function pctFromBps(bps: number): string {
  const tenths = Math.round(Math.abs(bps) / 10);
  return `${bps < 0 ? "-" : ""}${Math.floor(tenths / 10)}.${tenths % 10}%`;
}

function pctText(part: number, whole: number): string {
  if (whole === 0) return "";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function PositionRows({
  p,
  open,
  onToggle,
  onSetSymbol,
  rounding,
}: {
  p: Position;
  open: boolean;
  onToggle: () => void;
  onSetSymbol: (securityId: string, symbol: string) => Promise<void>;
  rounding: HoldingRounding;
}) {
  const t = today();
  return (
    <>
      <tr
        onClick={onToggle}
        style={{ cursor: "pointer" }}
        aria-expanded={open}
        title={p.price_date ? `Price from ${formatDateUS(p.price_date)}` : "Never priced — valued at cost"}
      >
        <td>
          {open ? "▾" : "▸"} {p.security_name}
        </td>
        <td className="text-slate-600" onClick={(e) => e.stopPropagation()}>
          <SymbolCell securityName={p.security_name} symbol={p.symbol} onSave={(v) => onSetSymbol(p.security_id, v)} />
        </td>
        <td className="num tabular-nums">{formatShares(p.shares_micro)}</td>
        <td className="num">
          {p.price_micro === null ? (
            <span className="text-slate-400">—</span>
          ) : (
            <span>
              {formatPrice(p.price_micro)}
              {p.price_date && <span className="block text-[10px] text-slate-500">{formatDateUS(p.price_date)}</span>}
            </span>
          )}
        </td>
        <td className="num">
          <Money cents={p.cost_cents} tone="neutral" />
        </td>
        <td className="num">
          <Money cents={p.value_cents} tone="neutral" />
        </td>
        <td className="num">
          <Money cents={p.gain_cents} />
        </td>
        <td className="num">{pctText(p.gain_cents, p.cost_cents)}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={8} style={{ padding: "0 0 6px 24px" }}>
            <table className="tm-lot-table" aria-label={`Lots of ${p.security_name}`}>
              <thead>
                <tr>
                  <th>Acquired</th>
                  <th className="num">Shares</th>
                  <th className="num">Cost</th>
                  <th className="num">Cost / share</th>
                  <th className="num">Value</th>
                  <th className="num">Gain / loss</th>
                  <th>If sold today</th>
                </tr>
              </thead>
              <tbody>
                {p.lots.map((l) => {
                  const value = p.price_micro === null ? l.cost_cents : valueCents(l.shares_micro, p.price_micro, rounding);
                  return (
                    <tr key={l.id}>
                      <td>{formatDateUS(l.acquired_on)}</td>
                      <td className="num">{formatShares(l.shares_micro)}</td>
                      <td className="num">{formatMoney(l.cost_cents)}</td>
                      <td className="num">{formatPrice(priceFrom(l.cost_cents, l.shares_micro))}</td>
                      <td className="num">{formatMoney(value)}</td>
                      <td className="num">
                        <Money cents={value - l.cost_cents} />
                      </td>
                      <td>{isLongTerm(l.acquired_on, t) ? "Long-term" : "Short-term"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * A holding's ticker, editable in place: the text (or "add symbol") is a
 * button; clicking it swaps in a field. Enter or leaving the field saves,
 * Escape puts it back. Clicks here never reach the row, whose own click
 * opens the lots.
 */
function SymbolCell({ securityName, symbol, onSave }: { securityName: string; symbol: string; onSave: (symbol: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(symbol);
  const [busy, setBusy] = useState(false);

  async function commit() {
    const next = value.trim().toUpperCase();
    setEditing(false);
    if (next === symbol) return;
    setBusy(true);
    try {
      await onSave(next);
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <input
        className="aero-field"
        style={{ width: 80, textTransform: "uppercase" }}
        aria-label={`Symbol for ${securityName}`}
        value={value}
        autoFocus
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setValue(symbol);
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <button
      type="button"
      className={symbol ? "tm-link" : "tm-link tm-text-muted"}
      disabled={busy}
      title={symbol ? "Change the ticker symbol" : "Set the ticker symbol — Update prices needs it"}
      onClick={() => {
        setValue(symbol);
        setEditing(true);
      }}
    >
      {symbol || "add symbol"}
    </button>
  );
}

/** The list of securities, with a form and each one's price history. */
function SecuritiesPanel({ securities, onChanged }: { securities: Security[]; onChanged: () => Promise<void> }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [kind, setKind] = useState<SecurityKind>("stock");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pricesFor, setPricesFor] = useState<string | null>(null);
  const [prices, setPrices] = useState<SecurityPrice[]>([]);
  const [priceDate, setPriceDate] = useState(today());
  const [priceText, setPriceText] = useState("");
  // A write in flight. Add/Save could be pressed twice before the
  // first answer, and the second Add made the same security again.
  const [saving, setSaving] = useState(false);
  // Whose price history is on screen, read synchronously. A slow
  // answer for the security clicked first used to land after the one clicked
  // second, putting its prices (and their Del buttons) under the other's name.
  const pricesForRef = useRef<string | null>(null);

  function reset() {
    setEditingId(null);
    setName("");
    setSymbol("");
    setKind("stock");
    setNotes("");
    setError(null);
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      if (editingId) await api.updateSecurity(editingId, name, symbol, kind, notes || null);
      else await api.createSecurity(name, symbol, kind, notes || null);
      reset();
      await onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function remove(s: Security) {
    if (!window.confirm(`Delete security "${s.name}"?`)) return;
    setError(null);
    try {
      await api.deleteSecurity(s.id);
      await onChanged();
    } catch (e) {
      setError(String(e));
    }
  }

  /** Load one security's history, applied only if it is still the one on
   *  screen. Never throws — it runs from a click with nobody to catch it. */
  async function loadPrices(id: string) {
    try {
      const list = await api.listSecurityPrices(id);
      if (pricesForRef.current === id) setPrices(list);
    } catch (e) {
      if (pricesForRef.current === id) setError(String(e));
    }
  }

  async function showPrices(id: string) {
    pricesForRef.current = id;
    setPricesFor(id);
    // The old list goes at once: its rows belong to another security.
    setPrices([]);
    setError(null);
    await loadPrices(id);
  }

  async function addPrice() {
    if (!pricesFor) return;
    const micro = parseMicro(priceText);
    if (micro === null || micro < 0) return setError("The price is unreadable.");
    setError(null);
    try {
      await api.setSecurityPrice(pricesFor, priceDate, micro);
      setPriceText("");
      await loadPrices(pricesFor);
      await onChanged();
    } catch (e) {
      setError(String(e));
    }
  }

  // Money's QIF carries no symbols. When the names ARE the tickers, one
  // click copies them across so "Update prices" has something to fetch.
  const [fillMsg, setFillMsg] = useState<string | null>(null);
  const missing = securities.filter((s) => !s.symbol.trim()).length;
  async function fillSymbols() {
    setError(null);
    try {
      const n = await api.fillSymbolsFromNames();
      setFillMsg(n === 0 ? "No security without a symbol has a name that reads as a ticker." : `Set ${n} symbol${n === 1 ? "" : "s"} from the names.`);
      await onChanged();
    } catch (e) {
      setError(String(e));
    }
  }

  async function removePrice(p: SecurityPrice) {
    try {
      await api.deleteSecurityPrice(p.security_id, p.date);
      await loadPrices(p.security_id);
      await onChanged();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <section className="aero-card">
      <div className="aero-card-title flex items-center justify-between gap-2">
        <span>Securities</span>
        {missing > 0 && (
          <button
            className="aero-btn !py-0 !px-2 text-[11px] font-normal"
            type="button"
            onClick={() => void fillSymbols()}
            title="For each security with no symbol whose name is a ticker (MUB, VTSAX, BRK.B), use the name as the symbol"
          >
            Use names as symbols ({missing} without one)
          </button>
        )}
      </div>
      <div className="p-2 grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div>
          {fillMsg && <div className="text-[12px] p-1">{fillMsg}</div>}
          <table className="register-table" aria-label="Securities">
            <thead>
              <tr>
                <th>Name</th>
                <th>Symbol</th>
                <th>Type</th>
                <th className="num">Last price</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {securities.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td>{s.symbol || "—"}</td>
                  <td>{SECURITY_KINDS.find(([k]) => k === s.kind)?.[1] ?? s.kind}</td>
                  <td className="num" title={s.price_date ? `${formatDateUS(s.price_date)} (${s.price_source})` : undefined}>
                    {formatPrice(s.last_price_micro) || "—"}
                  </td>
                  <td className="num">
                    <span className="inline-flex gap-1">
                      <button className="aero-btn !py-0 !px-1.5 text-[11px]" type="button" onClick={() => void showPrices(s.id)}>
                        Prices
                      </button>
                      <button
                        className="aero-btn !py-0 !px-1.5 text-[11px]"
                        type="button"
                        onClick={() => {
                          setEditingId(s.id);
                          setName(s.name);
                          setSymbol(s.symbol);
                          setKind(s.kind);
                          setNotes(s.notes ?? "");
                        }}
                      >
                        Edit
                      </button>
                      <button className="aero-btn !py-0 !px-1.5 text-[11px] money-neg" type="button" onClick={() => void remove(s)}>
                        Del
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
              {securities.length === 0 && (
                <tr>
                  <td colSpan={5} className="tm-text-muted">
                    None yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <form
            className="flex items-end gap-2 flex-wrap pt-2"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label className="flex flex-col text-[11px]">
              Name
              <input className="aero-field" value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
            <label className="flex flex-col text-[11px]">
              Symbol
              <input className="aero-field" style={{ width: 90 }} value={symbol} onChange={(e) => setSymbol(e.target.value)} />
            </label>
            <label className="flex flex-col text-[11px]">
              Type
              <select className="aero-field" value={kind} onChange={(e) => setKind(e.target.value as SecurityKind)}>
                {SECURITY_KINDS.map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col text-[11px] flex-1">
              Notes
              <input className="aero-field" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>
            <button className="aero-btn" type="submit" disabled={saving}>
              {editingId ? "Save" : "Add"}
            </button>
            {editingId && (
              <button className="aero-btn" type="button" onClick={reset}>
                Cancel
              </button>
            )}
          </form>
          {error && (
            <Notice tone="error" boxed className="mt-1">
              {error}
            </Notice>
          )}
        </div>
        <div>
          {pricesFor ? (
            <>
              <div className="font-bold text-[12px] pb-1">
                Price history — {securities.find((s) => s.id === pricesFor)?.name}
              </div>
              <form
                className="flex items-end gap-2 pb-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void addPrice();
                }}
              >
                <input className="aero-field" type="date" aria-label="Price date" value={priceDate} onChange={(e) => setPriceDate(e.target.value)} />
                <input className="aero-field text-right" style={{ width: 110 }} aria-label="Price" placeholder="Price" value={priceText} onChange={(e) => setPriceText(e.target.value)} />
                <button className="aero-btn" type="submit">
                  Record
                </button>
              </form>
              <table className="register-table" aria-label="Price history">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th className="num">Price</th>
                    <th>Source</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {prices.map((p) => (
                    <tr key={p.date}>
                      <td>{formatDateUS(p.date)}</td>
                      <td className="num">{formatPrice(p.price_micro)}</td>
                      <td className="tm-text-muted">{p.source === "transaction" ? "from a buy/sell" : p.source}</td>
                      <td className="num">
                        <button className="aero-btn !py-0 !px-1.5 text-[11px]" type="button" onClick={() => void removePrice(p)}>
                          Del
                        </button>
                      </td>
                    </tr>
                  ))}
                  {prices.length === 0 && (
                    <tr>
                      <td colSpan={4} className="tm-text-muted">
                        No prices yet — holdings are valued at cost until there is one.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </>
          ) : (
            <div className="tm-text-muted text-[12px] p-2">Pick “Prices” on a security to see or type its price history.</div>
          )}
        </div>
      </div>
    </section>
  );
}
