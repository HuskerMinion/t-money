// File → New asks two things the file keeps for good: the currency its
// totals are in, and how it writes numbers and dates. Asked after the path is
// picked and before the file is made, so Cancel leaves nothing behind.
//
// The Sample file is not asked: its demo data is in US dollars.
import { useState } from "react";
import { CURRENCY_NAMES, symbolFor } from "../lib/currency";
import { REGIONS, findRegion, groupDigits, type Region } from "../lib/region";

/** The region a currency is most likely used in: the first one whose own
 *  currency it is. USD -> United States, EUR -> Ireland. */
export function regionFor(currency: string): Region {
  // The euro is used in many regions; Germany is the one most people
  // choosing it will want. Every other currency has one obvious region.
  if (currency === "EUR") return findRegion("de-DE");
  return REGIONS.find((r) => r.currency === currency) ?? findRegion(null);
}

/** 1234.56 in `currency`, written the way `region` writes it — before the
 *  region is the file's, so not through `formatMoney`. */
export function sampleAmount(region: Region, currency: string): string {
  const n = `${groupDigits(1234, region)}${region.decimal}56`;
  const sym = symbolFor(currency, region).trim();
  const gap = region.symbol_space || /[A-Z]$/.test(sym) ? " " : "";
  return region.symbol_after ? `${n}${gap}${sym}` : `${sym}${gap}${n}`;
}

/** August 30, 2026 the way `region` writes it. */
export function sampleDate(region: Region): string {
  const s = region.date_sep;
  if (region.date_order === "mdy") return `8${s}30${s}2026`;
  if (region.date_order === "dmy") return `30${s}08${s}2026`;
  return `2026${s}08${s}30`;
}

export const HOME_CHOICES = Object.keys(CURRENCY_NAMES);

interface Props {
  fileName: string;
  busy?: boolean;
  onSubmit: (f: { home_currency: string; region: string }) => void;
  onCancel: () => void;
}

export default function NewFileFormatDialog({ fileName, busy = false, onSubmit, onCancel }: Props) {
  const [home, setHome] = useState("USD");
  const [region, setRegion] = useState("en-US");
  // The region follows the currency until it is picked by hand.
  const [regionPicked, setRegionPicked] = useState(false);
  const r = findRegion(region);

  return (
    <>
      <div className="tm-dialog-backdrop" onClick={() => !busy && onCancel()} />
      <div className="tm-dialog" role="dialog" aria-label="New file">
        <div className="tm-dialog-title">New file — {fileName}</div>
        <div className="tm-dialog-body space-y-2 text-[12px]">
          <label className="block">
            Home currency
            <select
              className="aero-field mt-1 w-full"
              aria-label="Home currency"
              value={home}
              onChange={(e) => {
                setHome(e.target.value);
                if (!regionPicked) setRegion(regionFor(e.target.value).code);
              }}
            >
              {HOME_CHOICES.map((c) => (
                <option key={c} value={c}>
                  {c} — {CURRENCY_NAMES[c]}
                </option>
              ))}
            </select>
          </label>
          <p className="tm-text-muted">
            Totals, net worth, budgets and reports are in this currency. An account can still be kept in
            another one.
          </p>
          <label className="block">
            Region
            <select
              className="aero-field mt-1 w-full"
              aria-label="Region"
              value={region}
              onChange={(e) => {
                setRegion(e.target.value);
                setRegionPicked(true);
              }}
            >
              {REGIONS.map((x) => (
                <option key={x.code} value={x.code}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
          <p className="tm-text-muted" aria-label="Region preview">
            Amounts look like {sampleAmount(r, home)}; dates like {sampleDate(r)}.
          </p>
          <p className="tm-text-muted">Both can be changed later under Settings → Money → Home currency and region.</p>
          <div className="flex justify-end gap-2 pt-3">
            <button
              type="button"
              className="aero-btn default"
              disabled={busy}
              onClick={() => onSubmit({ home_currency: home, region })}
            >
              Create file
            </button>
            <button type="button" className="aero-btn" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
