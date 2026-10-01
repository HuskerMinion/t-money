// How the open file writes numbers and dates, and its home currency.
//
// A region fixes the thousands separator, the decimal mark, which side of
// the number the currency symbol goes on, and the order of a date's parts.
// The table is the same as `src-tauri/src/region.rs`, so a figure the
// backend writes into a report and one drawn here look alike. It is explicit
// rather than taken from the browser's locale data: what a file shows should
// not change with the machine it is opened on.
//
// The open file's format lives in `useFileFormat`. The formatters in
// `format.ts` read it when they run; the app re-renders what it shows when it
// changes (see App).

import { create } from "zustand";

export type DateOrder = "mdy" | "dmy" | "ymd";

export interface Region {
  /** BCP 47 tag. */
  code: string;
  name: string;
  /** The currency people there use, written with its local symbol. */
  currency: string;
  group: string;
  decimal: string;
  /** The symbol follows the number ("1.234,56 €"). */
  symbol_after: boolean;
  /** A no-break space between symbol and number. */
  symbol_space: boolean;
  date_order: DateOrder;
  date_sep: string;
}

const NBSP = " ";
const NNBSP = " ";

export const REGIONS: Region[] = [
  { code: "en-US", name: "United States", currency: "USD", group: ",", decimal: ".", symbol_after: false, symbol_space: false, date_order: "mdy", date_sep: "/" },
  { code: "en-CA", name: "Canada (English)", currency: "CAD", group: ",", decimal: ".", symbol_after: false, symbol_space: false, date_order: "ymd", date_sep: "-" },
  { code: "fr-CA", name: "Canada (French)", currency: "CAD", group: NBSP, decimal: ",", symbol_after: true, symbol_space: true, date_order: "ymd", date_sep: "-" },
  { code: "es-MX", name: "Mexico", currency: "MXN", group: ",", decimal: ".", symbol_after: false, symbol_space: false, date_order: "dmy", date_sep: "/" },
  { code: "en-GB", name: "United Kingdom", currency: "GBP", group: ",", decimal: ".", symbol_after: false, symbol_space: false, date_order: "dmy", date_sep: "/" },
  { code: "en-IE", name: "Ireland", currency: "EUR", group: ",", decimal: ".", symbol_after: false, symbol_space: false, date_order: "dmy", date_sep: "/" },
  { code: "de-DE", name: "Germany", currency: "EUR", group: ".", decimal: ",", symbol_after: true, symbol_space: true, date_order: "dmy", date_sep: "." },
  { code: "fr-FR", name: "France", currency: "EUR", group: NNBSP, decimal: ",", symbol_after: true, symbol_space: true, date_order: "dmy", date_sep: "/" },
  { code: "es-ES", name: "Spain", currency: "EUR", group: ".", decimal: ",", symbol_after: true, symbol_space: true, date_order: "dmy", date_sep: "/" },
  { code: "it-IT", name: "Italy", currency: "EUR", group: ".", decimal: ",", symbol_after: true, symbol_space: true, date_order: "dmy", date_sep: "/" },
  { code: "nl-NL", name: "Netherlands", currency: "EUR", group: ".", decimal: ",", symbol_after: false, symbol_space: true, date_order: "dmy", date_sep: "-" },
  { code: "en-AU", name: "Australia", currency: "AUD", group: ",", decimal: ".", symbol_after: false, symbol_space: false, date_order: "dmy", date_sep: "/" },
];

export const DEFAULT_REGION = "en-US";
export const DEFAULT_HOME = "USD";

export function findRegion(code: string | null | undefined): Region {
  return REGIONS.find((r) => r.code === code) ?? REGIONS[0];
}

interface FileFormatState {
  home: string;
  region: Region;
  /** Take the open file's format, as `get_file_format` returns it. */
  setFormat: (f: { home_currency: string; region: string }) => void;
  /** Back to US dollars, United States — no file open, or a test. */
  reset: () => void;
}

export const useFileFormat = create<FileFormatState>((set) => ({
  home: DEFAULT_HOME,
  region: findRegion(DEFAULT_REGION),
  setFormat: (f) => set({ home: f.home_currency || DEFAULT_HOME, region: findRegion(f.region) }),
  reset: () => set({ home: DEFAULT_HOME, region: findRegion(DEFAULT_REGION) }),
}));

/** The open file's home currency. */
export function homeCurrency(): string {
  return useFileFormat.getState().home;
}

/** The open file's region. */
export function currentRegion(): Region {
  return useFileFormat.getState().region;
}

/** A whole number with the region's thousands separator: 1234567 -> "1,234,567". */
export function groupDigits(whole: number | bigint, region: Region = currentRegion()): string {
  const s = String(whole);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += region.group;
    out += s[i];
  }
  return out;
}
