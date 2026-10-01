// Accounts kept in other currencies.
//
// Every amount is integer hundredths of its ACCOUNT's currency. Anything that
// adds accounts together — a group total, net worth, equity, the debt plan —
// is in the file's home currency (`region.ts`), converted at today's rate
// with the same arithmetic as the backend (`db/queries/fx.rs`): integer only,
// rounded half away from zero, so a total here and the same total in a
// report cannot differ by a cent.

import { accountWorth } from "./accountTypes";
import { currentRegion, homeCurrency, type Region } from "./region";

export { homeCurrency } from "./region";

/** One unit, in millionths. */
export const MICRO = 1_000_000;

/** Mirrors `currency.rs`: the symbol that cannot be mistaken for another
 *  currency's. The backend's list is the authority; this is only how an
 *  amount is written. */
export const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "US$",
  CAD: "CA$",
  EUR: "€",
  GBP: "£",
  MXN: "MX$",
  AUD: "A$",
};

/** The symbol people use at home, used where the region's own currency is
 *  this one: "$" for the Canadian dollar in Canada. */
export const LOCAL_SYMBOLS: Record<string, string> = {
  USD: "$",
  CAD: "$",
  EUR: "€",
  GBP: "£",
  MXN: "$",
  AUD: "$",
};

/** The currency names, for a sentence ("1 GBP = … euros" reads better as
 *  "1 GBP = … EUR"; these are for labels like "Totals are in euros"). */
export const CURRENCY_NAMES: Record<string, string> = {
  USD: "US dollars",
  CAD: "Canadian dollars",
  EUR: "euros",
  GBP: "British pounds",
  MXN: "Mexican pesos",
  AUD: "Australian dollars",
};

/** The home currency's name in a sentence: "US dollars", "euros". */
export function homeName(): string {
  const h = homeCurrency();
  return CURRENCY_NAMES[h] ?? h;
}

/** The symbol `code` is written with in `region`: the local one for the
 *  region's own currency, the unambiguous one for any other. No code means
 *  the home currency. An unknown code is written as itself, so it can never
 *  pass for the home currency. */
export function symbolFor(code: string | null | undefined, region: Region = currentRegion()): string {
  const c = code || homeCurrency();
  if (c === region.currency && LOCAL_SYMBOLS[c]) return LOCAL_SYMBOLS[c];
  return CURRENCY_SYMBOLS[c] ?? `${c} `;
}

interface Kept {
  currency?: string;
  home_rate_micro?: number;
}

/** The account's currency; an account that does not say is in the home one. */
export function currencyOf(a: Kept): string {
  return a.currency || homeCurrency();
}

export function isForeign(a: Kept): boolean {
  return currencyOf(a) !== homeCurrency();
}

/** Today's home-currency units per unit, in millionths. 0 when a foreign
 *  currency has no rate — the caller says so rather than inventing one. */
export function rateOf(a: Kept): number {
  return isForeign(a) ? a.home_rate_micro ?? 0 : MICRO;
}

/** `cents` at `rateMicro`, in home cents. BigInt: a large balance times a
 *  rate in millionths can pass 2^53, where a float would lose the cent. */
export function toHome(cents: number, rateMicro: number): number {
  if (rateMicro === MICRO) return cents;
  const p = BigInt(Math.abs(cents)) * BigInt(rateMicro);
  const v = Number((p + BigInt(MICRO / 2)) / BigInt(MICRO));
  return cents < 0 ? -v : v;
}

/** An account's worth (balance plus holdings) in the home currency, today. */
export function worthHome(a: Kept & { balance_cents: number; holdings_value_cents?: number }): number {
  return toHome(accountWorth(a), rateOf(a));
}

/** A rate in millionths as text, with the region's decimal mark: "1.0875",
 *  "0,054321". */
export function formatRate(micro: number, region: Region = currentRegion()): string {
  const whole = Math.floor(micro / MICRO);
  const frac = String(micro % MICRO).padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}${region.decimal}${frac}` : `${whole}`;
}

/** A rate typed with either decimal mark, as the backend reads it: "1,0875"
 *  -> "1.0875". Separators other than one decimal mark are refused by the
 *  backend, so nothing else is changed here. */
export function rateForBackend(text: string, region: Region = currentRegion()): string {
  const t = text.trim();
  return region.decimal === "," ? t.replace(",", ".") : t;
}
