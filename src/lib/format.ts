// Money + date formatting. All money is integer cents.

/**
 * Format integer cents as a currency string with thousands separators.
 * Negatives use the classic accounting red-paren style: ($1,238.42)
 */
export function formatMoney(cents: number, opts: { parens?: boolean } = {}): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  const intPart = dollars.toLocaleString("en-US");
  const str = `$${intPart}.${rem.toString().padStart(2, "0")}`;
  if (negative) {
    return opts.parens === false ? `-$${intPart}.${rem.toString().padStart(2, "0")}` : `(${str})`;
  }
  return str;
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
 * Parse a user-entered dollar amount to integer cents.
 *
 * Accepts "123.45", "-1,234.56", "$12", and the accounting form "(405.26)"
 * — which is what this app's own formatters produce, and which this used to
 * reject. The reconcile wizard seeded its starting balance with
 * `formatAccountingBare`, so any negative starting balance parsed as `null`,
 * became `$0`, and the statement started from the wrong number.
 *
 * Integer arithmetic on the digit strings: no float multiplication, so
 * "1.005" is refused (three decimals) rather than rounded either way.
 */
export function parseMoneyToCents(input: string): number | null {
  let cleaned = input.replace(/[$,\s]/g, "");
  let negative = false;
  if (/^\(.*\)$/.test(cleaned)) {
    negative = true;
    cleaned = cleaned.slice(1, -1);
  }
  if (cleaned.startsWith("-")) {
    negative = !negative;
    cleaned = cleaned.slice(1);
  }
  if (cleaned === "" || cleaned === ".") return null;
  const m = /^(\d*)(?:\.(\d{0,2}))?$/.exec(cleaned);
  if (!m) return null;
  const dollars = m[1] === "" ? 0 : Number(m[1]);
  const centsStr = (m[2] ?? "").padEnd(2, "0");
  const cents = dollars * 100 + Number(centsStr);
  if (!Number.isSafeInteger(cents)) return null;
  // `-0` is a real JS value and `Object.is(-0, 0)` is false; keep zero plain.
  return negative && cents !== 0 ? -cents : cents;
}

/**
 * "5.875" -> 5_875_000 (§94). A rate is stored in millionths of a percent so
 * a mortgage's 5.875% and a card's 24.99% are both exact integers, for the
 * same reason money is cents: `5.875 / 12` in floating point is not
 * `5.875 / 12`, and interest computed from it drifts a cent at a time.
 *
 * Integer arithmetic on the digit string, like `parseMoneyToCents`. More than
 * six decimals is refused rather than rounded. Negative is refused: a loan at
 * minus three percent is a typo, not a gift.
 */
export function parseRateToMicro(input: string): number | null {
  const cleaned = input.replace(/[%,\s]/g, "");
  if (cleaned === "" || cleaned === ".") return null;
  const m = /^(\d*)(?:\.(\d{0,6}))?$/.exec(cleaned);
  if (!m) return null;
  const whole = m[1] === "" ? 0 : Number(m[1]);
  const frac = (m[2] ?? "").padEnd(6, "0");
  const micro = whole * 1_000_000 + Number(frac);
  return Number.isSafeInteger(micro) ? micro : null;
}

/** 5_875_000 -> "5.875". Trailing zeros trimmed; a whole rate keeps none. */
export function formatRate(micro: number): string {
  const whole = Math.trunc(micro / 1_000_000);
  const frac = String(Math.abs(micro) % 1_000_000).padStart(6, "0").replace(/0+$/, "");
  return frac === "" ? String(whole) : `${whole}.${frac}`;
}

/* --- Register formatting (MS Money conventions) --------------------------
 * Measured from reference/ms-money-02-account-register.png. In the register
 * grid Money shows dates as M/D/YYYY, Payment/Deposit as bare numbers with no
 * currency symbol and no sign, and Balance in accounting parens — also with no
 * currency symbol. The `$` only appears in the footer's Ending Balance.
 * (§6.1a) */

/** "2026-08-30" -> "8/30/2026". Returns the input unchanged if unparseable. */
export function formatDateUS(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d] = m;
  return `${Number(mo)}/${Number(d)}/${y}`;
}

/** Digits only, absolute value: -172332 -> "1,723.32". For Payment/Deposit. */
export function formatAmountBare(cents: number): string {
  const abs = Math.abs(cents);
  return `${Math.floor(abs / 100).toLocaleString("en-US")}.${(abs % 100)
    .toString()
    .padStart(2, "0")}`;
}

/** Accounting style without a currency symbol: -40526 -> "(405.26)". Balance. */
export function formatAccountingBare(cents: number): string {
  const body = formatAmountBare(cents);
  return cents < 0 ? `(${body})` : body;
}
