// Shares and prices in millionths (§41). The backend stores `shares_micro`
// (shares x 1,000,000) and `price_micro` (dollars x 1,000,000) as i64; this
// is the frontend's exact arithmetic on them — BigInt, never a float, so a
// 401(k)'s 12.3456 shares at 34.5678 comes out to the cent the backend gets.

export const MICRO = 1_000_000;

/** "12.3456" → 12345600. Up to six decimals; more are refused (null), as is
 *  anything that is not a plain decimal number. */
export function parseMicro(input: string): number | null {
  const s = input.trim().replace(/,/g, "");
  const m = /^(-)?(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) return null;
  const frac = m[3] ?? "";
  if (frac.length > 6) return null;
  const whole = BigInt(m[2] || "0");
  const part = BigInt((frac + "000000").slice(0, 6));
  const v = whole * BigInt(MICRO) + part;
  const n = Number(m[1] ? -v : v);
  return Number.isSafeInteger(n) ? n : null;
}

/** 12345600 → "12.3456"; whole numbers print without a point. */
export function formatShares(micro: number): string {
  const neg = micro < 0;
  const a = Math.abs(micro);
  const whole = Math.floor(a / MICRO);
  const frac = a % MICRO;
  let s = frac === 0 ? `${whole}` : `${whole}.${String(frac).padStart(6, "0").replace(/0+$/, "")}`;
  if (neg) s = `-${s}`;
  return s;
}

/** A price to two places, or as many as it has up to six (a fund NAV at
 *  34.5678, a money-market unit at 1.000123) — §72: every stored digit is
 *  shown, so an edit round-trips exactly. */
export function formatPrice(micro: number | null | undefined): string {
  if (micro === null || micro === undefined) return "";
  const neg = micro < 0;
  const a = Math.abs(micro);
  const whole = Math.floor(a / MICRO);
  let frac = String(a % MICRO).padStart(6, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  const s = `${whole.toLocaleString("en-US")}.${frac}`;
  return neg ? `-${s}` : s;
}

/** a * b / c, rounded half away from zero — the backend's `mul_div`. */
export function mulDiv(a: number, b: number, c: number): number {
  if (c === 0) return 0;
  const n = BigInt(a) * BigInt(b);
  const d = BigInt(c);
  let q = n / d;
  const r = n % d;
  const twice = r < 0n ? -r * 2n : r * 2n;
  const dd = d < 0n ? -d : d;
  if (twice >= dd) q += (n < 0n) !== (d < 0n) ? -1n : 1n;
  return Number(q);
}

/**
 * shares x price → cents. `rounding` is the file's choice (§79): "nearest"
 * (half away from zero, the default) or "down" (truncate, as some brokers do).
 * Mirrors `lots::value_cents_rounded`.
 */
export function valueCents(sharesMicro: number, priceMicro: number, rounding: "nearest" | "down" = "nearest"): number {
  if (rounding === "down") return Number((BigInt(sharesMicro) * BigInt(priceMicro)) / 10_000_000_000n);
  return mulDiv(sharesMicro, priceMicro, 10_000_000_000);
}

/** The per-file setting key behind `valueCents`'s rounding (Settings → Holding values). */
export const HOLDING_ROUNDING_KEY = "holding_rounding";

/** cents / shares → price in micro-dollars; null when there are no shares. */
export function priceFrom(grossCents: number, sharesMicro: number): number | null {
  if (sharesMicro <= 0) return null;
  return mulDiv(grossCents, 10_000_000_000, sharesMicro);
}

/** Money's labels for the activities. */
export const ACTIVITY_LABELS: [string, string][] = [
  ["buy", "Buy"],
  ["sell", "Sell"],
  ["dividend", "Dividend"],
  ["interest", "Interest"],
  ["ltcg_dist", "L-T Cap Gains Dist"],
  ["stcg_dist", "S-T Cap Gains Dist"],
  ["reinvest_dividend", "Reinvest Dividend"],
  ["reinvest_interest", "Reinvest Interest"],
  ["reinvest_ltcg", "Reinvest L-T CG Dist"],
  ["reinvest_stcg", "Reinvest S-T CG Dist"],
  ["add_shares", "Add Shares"],
  ["remove_shares", "Remove Shares"],
  ["return_of_capital", "Return of Capital"],
  ["split", "Split"],
];

export function activityLabel(a: string | null | undefined): string {
  return ACTIVITY_LABELS.find(([k]) => k === a)?.[1] ?? "";
}

/** §91 — the cash entries an investment account needs, offered in the same
 *  Activity list as the share ones because that is where a user looks for
 *  them. Money's 401(k) register lists Contribution beside Buy; ours had the
 *  capability (the "New cash entry" button since §41) but nowhere anybody
 *  found it. A 401(k) whose statements download only 90 days at a time
 *  had no manual way to enter a Contribution.
 *
 *  Each one is a plain transaction in the investment account's cash — the
 *  same row §90's import writes beside a purchase — so the categories match
 *  the importer's exactly. */
export interface CashActivity {
  key: string;
  label: string;
  payee: string;
  /** Category path, created if it does not exist. Empty = leave it blank. */
  category: string;
  kind: "income" | "expense";
  /** Which box the amount belongs in. */
  side: "deposit" | "payment";
}

export const CASH_ACTIVITIES: CashActivity[] = [
  { key: "cash_contribution", label: "Contribution", payee: "Contribution", category: "Retirement Contributions", kind: "income", side: "deposit" },
  {
    key: "cash_employer",
    label: "Employer Contribution",
    payee: "Employer Contribution",
    category: "Retirement Contributions : Employer Match",
    kind: "income",
    side: "deposit",
  },
  { key: "cash_deposit", label: "Deposit (cash in)", payee: "", category: "", kind: "income", side: "deposit" },
  { key: "cash_withdrawal", label: "Withdrawal (cash out)", payee: "Withdrawal", category: "Retirement Income : Plan Withdrawal", kind: "income", side: "payment" },
  { key: "cash_fee", label: "Fee", payee: "Fee", category: "Investment Fees", kind: "expense", side: "payment" },
];

export function cashActivity(key: string): CashActivity | undefined {
  return CASH_ACTIVITIES.find((c) => c.key === key);
}

export const SHARE_ACTIVITIES = new Set(["buy", "sell", "reinvest_dividend", "reinvest_interest", "reinvest_ltcg", "reinvest_stcg", "add_shares", "remove_shares"]);
export const INCOME_ACTIVITIES = new Set(["dividend", "interest", "ltcg_dist", "stcg_dist", "reinvest_dividend", "reinvest_interest", "reinvest_ltcg", "reinvest_stcg"]);
export const CLOSING_ACTIVITIES = new Set(["sell", "remove_shares"]);

/** What an activity does to cash, mirrored from the backend so the form can
 *  say "Cash: −1,504.95" before saving. */
export function cashEffect(activity: string, grossCents: number, commissionCents: number): number {
  switch (activity) {
    case "buy":
      return -(grossCents + commissionCents);
    case "sell":
    case "dividend":
    case "interest":
    case "ltcg_dist":
    case "stcg_dist":
    case "return_of_capital":
      return grossCents - commissionCents;
    default:
      return 0;
  }
}

/** Held more than one year on `sold` (ISO dates). */
export function isLongTerm(acquired: string, sold: string): boolean {
  const a = new Date(`${acquired}T00:00:00`);
  const anniversary = new Date(a.getFullYear() + 1, a.getMonth(), a.getDate());
  return new Date(`${sold}T00:00:00`) > anniversary;
}

/** Money's distribution methods for a sale (Capital Gains Estimator): which
 *  lots the shares come from. `fifo` is the backend's default and sends no
 *  allocations; the others are computed here and sent as specified lots. */
export type LotMethod = "fifo" | "lifo" | "max_gain" | "min_gain" | "specify";

export const LOT_METHODS: [LotMethod, string, string][] = [
  ["fifo", "Oldest first (FIFO)", "The first shares bought are the first sold — the usual default, and the largest gain when the price has been rising."],
  ["lifo", "Newest first (LIFO)", "The last shares bought are the first sold."],
  ["max_gain", "Max gain", "Lowest cost per share first: the largest gain this year."],
  ["min_gain", "Min gain", "Highest cost per share first: the smallest gain (or largest loss) this year."],
  ["specify", "Specify lots", "Pick the shares from each lot yourself."],
];

/** Which lots a sale of `sharesMicro` takes under `method`, as
 *  {lot_id → shares}. Empty for fifo (the backend does it) and for a sale
 *  larger than the holding (the backend reports that). Cost per share is
 *  compared exactly, by cross-multiplying, never as a float. */
export function allocateLots(
  lots: readonly { id: string; shares_micro: number; cost_cents: number; acquired_on: string }[],
  sharesMicro: number,
  method: LotMethod
): Record<string, number> {
  if (method === "fifo" || method === "specify" || sharesMicro <= 0) return {};
  const held = lots.reduce((n, l) => n + l.shares_micro, 0);
  if (sharesMicro > held) return {};
  // cost/share of a vs b: a.cost/a.shares ? b.cost/b.shares  ⇔  a.cost*b.shares ? b.cost*a.shares
  const cheaper = (a: (typeof lots)[number], b: (typeof lots)[number]) => {
    const l = BigInt(a.cost_cents) * BigInt(b.shares_micro);
    const r = BigInt(b.cost_cents) * BigInt(a.shares_micro);
    return l < r ? -1 : l > r ? 1 : 0;
  };
  const order = [...lots].filter((l) => l.shares_micro > 0);
  if (method === "lifo") order.sort((a, b) => b.acquired_on.localeCompare(a.acquired_on));
  if (method === "max_gain") order.sort((a, b) => cheaper(a, b) || a.acquired_on.localeCompare(b.acquired_on));
  if (method === "min_gain") order.sort((a, b) => cheaper(b, a) || a.acquired_on.localeCompare(b.acquired_on));
  const out: Record<string, number> = {};
  let left = sharesMicro;
  for (const l of order) {
    if (left === 0) break;
    const take = Math.min(left, l.shares_micro);
    out[l.id] = take;
    left -= take;
  }
  return out;
}
