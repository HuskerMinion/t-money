// Money + date formatting. All money is integer cents.
//
// Everything here writes and reads the open file's region (`region.ts`):
// "$1,234.56" in the United States, "1.234,56 €" in Germany, dates as
// 8/30/2026, 30.08.2026 or 2026-08-30.
import { symbolFor } from "./currency";
import { currentRegion, groupDigits, type Region } from "./region";

const NBSP = "\u00a0";

/** A magnitude in hundredths with the region's separators: "1,234.56" /
 *  "1.234,56". */
function numberIn(abs: number, region: Region): string {
  return `${groupDigits(Math.floor(abs / 100), region)}${region.decimal}${(abs % 100).toString().padStart(2, "0")}`;
}

/**
 * Format integer cents as a currency string with thousands separators.
 * Negatives use the classic accounting red-paren style: ($1,238.42)
 *
 * `currency` is the ISO code of the account the amount belongs to; omitted,
 * the amount is in the home currency — which every total across accounts is.
 */
export function formatMoney(cents: number, opts: { parens?: boolean; currency?: string | null } = {}): string {
  const region = currentRegion();
  const n = numberIn(Math.abs(cents), region);
  const sym = symbolFor(opts.currency, region).trim();
  const gap = region.symbol_space || /[A-Z]$/.test(sym) ? NBSP : "";
  const str = region.symbol_after ? `${n}${gap}${sym}` : `${sym}${gap}${n}`;
  if (cents < 0) {
    return opts.parens === false ? `-${str}` : `(${str})`;
  }
  return str;
}

/**
 * A typed number in the region's way, as "1234.56" — group marks gone, the
 * decimal mark a dot — or null when it cannot be one. The one reader behind
 * every money, share, price and rate field, so a field never reads the same
 * text differently from the next.
 *
 * The region's own marks read as the region writes them: "1.234,56" in
 * Germany, "1,234.56" in the US. The other mark is forgiven when it can only
 * be a decimal point — once, with no more digits after it than the field
 * takes: "12.50" in Germany, "12,5" in the US. Thousands groups must be
 * whole: "1.234" is a thousand and more in Germany, "1.2345" and "0.123" are
 * refused for money rather than guessed. A leading minus is kept.
 *
 * `groupsFirst` false (rates): one mark followed by up to `maxDecimals`
 * digits is read as a decimal point even where it is the region's group
 * mark — a rate of 5.875 is never five thousand.
 */
export function normalizeNumber(text: string, region: Region, maxDecimals: number, groupsFirst = true): string | null {
  const s = text.replace(/\s/g, "");
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const d = region.decimal;
  const g = region.group.trim();
  const o = d === "," ? "." : ",";
  const wholeGroups = (t: string, mark: string) => {
    const segs = t.split(mark);
    return segs.length > 1 && /^[1-9]\d{0,2}$/.test(segs[0]) && segs.slice(1).every((x) => /^\d{3}$/.test(x));
  };
  const asDecimal = (t: string, mark: string) => {
    const parts = t.split(mark);
    return parts.length === 2 && parts[1].length >= 1 && parts[1].length <= maxDecimals && /^\d*$/.test(parts[0]) && /^\d+$/.test(parts[1])
      ? `${parts[0]}.${parts[1]}`
      : null;
  };
  let out: string | null;
  if (body.includes(d)) {
    const at = body.indexOf(d);
    let whole = body.slice(0, at);
    const frac = body.slice(at + 1);
    if (frac.includes(d)) return null;
    if (g && whole.includes(g)) {
      if (!wholeGroups(whole, g)) return null;
      whole = whole.split(g).join("");
    }
    out = `${whole}.${frac}`;
  } else if (body.includes(o)) {
    if (!groupsFirst && asDecimal(body, o) !== null) out = asDecimal(body, o);
    else if (o === g && wholeGroups(body, o)) out = body.split(o).join("");
    else out = asDecimal(body, o);
  } else {
    out = body;
  }
  return out === null ? null : `${neg ? "-" : ""}${out}`;
}

/** Remove what is written around an amount: currency codes and symbols,
 *  every kind of space. */
function stripMoneyMarks(input: string): string {
  return input
    .replace(/\b(?:USD|CAD|EUR|GBP|MXN|AUD)\b/gi, "")
    .replace(/(?:US|CA|MX|A)?\$|[€£]/g, "")
    .replace(/\s/g, "");
}

/** Current month as YYYY-MM (local time). */
export function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, "0")}`;
}

/** Today as YYYY-MM-DD (local time). */
export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, "0")}-${d
    .getDate()
    .toString()
    .padStart(2, "0")}`;
}

/**
 * Parse a user-entered amount to integer cents, in the region's way.
 *
 * Accepts "123.45", "-1,234.56", "$12", "1.234,56 €" (in a comma region), and
 * the accounting form "(405.26)"
 * — which is what this app's own formatters produce, and which this used to
 * reject. The reconcile wizard seeded its starting balance with
 * `formatAccountingBare`, so any negative starting balance parsed as `null`,
 * became `$0`, and the statement started from the wrong number.
 *
 * Integer arithmetic on the digit strings: no float multiplication, so
 * "1.005" is refused (three decimals) rather than rounded either way.
 */
export function parseMoneyToCents(input: string): number | null {
  // Any of the currency marks this app writes — "$", "US$", "CA$", "€",
  // "£", "MX$", "A$" — or an ISO code typed beside the number.
  let cleaned = stripMoneyMarks(input);
  let negative = false;
  if (/^\(.*\)$/.test(cleaned)) {
    negative = true;
    cleaned = cleaned.slice(1, -1);
  }
  if (cleaned.startsWith("-")) {
    negative = !negative;
    cleaned = cleaned.slice(1);
  }
  const normalized = normalizeNumber(cleaned, currentRegion(), 2);
  if (normalized === null || normalized === "" || normalized === ".") return null;
  const m = /^(\d*)(?:\.(\d{0,2}))?$/.exec(normalized);
  if (!m) return null;
  const dollars = m[1] === "" ? 0 : Number(m[1]);
  const centsStr = (m[2] ?? "").padEnd(2, "0");
  const cents = dollars * 100 + Number(centsStr);
  if (!Number.isSafeInteger(cents)) return null;
  // `-0` is a real JS value and `Object.is(-0, 0)` is false; keep zero plain.
  return negative && cents !== 0 ? -cents : cents;
}

/**
 * "5.875" -> 5_875_000. A rate is stored in millionths of a percent so
 * a mortgage's 5.875% and a card's 24.99% are both exact integers, for the
 * same reason money is cents: `5.875 / 12` in floating point is not
 * `5.875 / 12`, and interest computed from it drifts a cent at a time.
 *
 * Integer arithmetic on the digit string, like `parseMoneyToCents`. More than
 * six decimals is refused rather than rounded. Negative is refused: a loan at
 * minus three percent is a typo, not a gift.
 */
export function parseRateToMicro(input: string): number | null {
  const cleaned = normalizeNumber(input.replace(/[%\s]/g, ""), currentRegion(), 6, false);
  if (cleaned === null || cleaned === "" || cleaned === ".") return null;
  const m = /^(\d*)(?:\.(\d{0,6}))?$/.exec(cleaned);
  if (!m) return null;
  const whole = m[1] === "" ? 0 : Number(m[1]);
  const frac = (m[2] ?? "").padEnd(6, "0");
  const micro = whole * 1_000_000 + Number(frac);
  return Number.isSafeInteger(micro) ? micro : null;
}

/** 5_875_000 -> "5.875" ("5,875" in a comma region). Trailing zeros
 *  trimmed; a whole rate keeps none. */
export function formatRate(micro: number): string {
  const whole = Math.trunc(micro / 1_000_000);
  const frac = String(Math.abs(micro) % 1_000_000).padStart(6, "0").replace(/0+$/, "");
  return frac === "" ? String(whole) : `${whole}${currentRegion().decimal}${frac}`;
}

/* --- Register formatting (MS Money conventions) --------------------------
 * Measured from reference/ms-money-02-account-register.png. In the register
 * grid Money shows dates as M/D/YYYY, Payment/Deposit as bare numbers with no
 * currency symbol and no sign, and Balance in accounting parens — also with no
 * currency symbol. The `$` only appears in the footer's Ending Balance.
 * */

/** A date the region's way: "2026-08-30" -> "8/30/2026" (the US, unpadded
 *  as Money wrote it), "30.08.2026", "30/08/2026", "2026-08-30". Returns the
 *  input unchanged if unparseable. Named for when it was always the US. */
export function formatDateUS(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d] = m;
  const r = currentRegion();
  const s = r.date_sep;
  if (r.date_order === "mdy") return `${Number(mo)}${s}${Number(d)}${s}${y}`;
  if (r.date_order === "dmy") return `${d}${s}${mo}${s}${y}`;
  return `${y}${s}${mo}${s}${d}`;
}

/** `formatDateUS` under the name it has now: a date in the file's region. */
export const formatDate = formatDateUS;

/** Digits only, absolute value: -172332 -> "1,723.32". For Payment/Deposit. */
export function formatAmountBare(cents: number): string {
  return numberIn(Math.abs(cents), currentRegion());
}

/** A plain number (shares, a count) with the region's separators and up to
 *  `decimals` places, trailing zeros trimmed: 1234.5 -> "1,234.5". `value`
 *  is in units of 10^-decimals, so no float rounding is involved. */
export function formatScaled(value: number, decimals: number): string {
  const r = currentRegion();
  const neg = value < 0;
  const abs = Math.abs(value);
  const scale = 10 ** decimals;
  const whole = Math.floor(abs / scale);
  const frac = String(abs % scale).padStart(decimals, "0").replace(/0+$/, "");
  const body = frac ? `${groupDigits(whole, r)}${r.decimal}${frac}` : groupDigits(whole, r);
  return neg ? `-${body}` : body;
}

/** Accounting style without a currency symbol: -40526 -> "(405.26)". Balance. */
export function formatAccountingBare(cents: number): string {
  const body = formatAmountBare(cents);
  return cents < 0 ? `(${body})` : body;
}
