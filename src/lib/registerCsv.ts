// A register, as shown, as CSV for Excel. Money's columns — Num, Date,
// Payee, Category (or Transfer : Account), Memo, C, Payment, Deposit, Balance
// — plus the investment fields when a row has them. Amounts are plain
// decimals (no $, no parens) so a spreadsheet reads them as numbers; the
// Balance column is left out when the view's sort makes it meaningless.
//
// Numbers are written the same way in every region — a dot for the decimal
// mark, no thousands marks — so the columns a comma separates stay columns.
import type { RegisterRow } from "./types";

/** A quoted TEXT cell. Excel evaluates a cell that begins with = + - @
 *  (or a tab or carriage return ahead of one) as a formula even inside quotes,
 *  so a payee or memo that came in from a bank's download could run when the
 *  export is opened. The apostrophe makes it text. Amounts never come through
 *  here — they are written bare, so "-12.34" stays a number. */
function q(s: string): string {
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** cents → "-1234.56", integer arithmetic only. */
export function csvCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Millionths → "12.3456", trailing zeros trimmed, at least `minDecimals`
 *  places. Integer arithmetic; the same in every region. */
export function csvMicro(micro: number, minDecimals = 0): string {
  const sign = micro < 0 ? "-" : "";
  const abs = Math.abs(micro);
  let frac = String(abs % 1_000_000).padStart(6, "0").replace(/0+$/, "");
  while (frac.length < minDecimals) frac += "0";
  return `${sign}${Math.floor(abs / 1_000_000)}${frac ? `.${frac}` : ""}`;
}

export function registerCsv(rows: readonly RegisterRow[], withBalance: boolean): string {
  const invest = rows.some((r) => r.activity);
  const head = ["Num", "Date", "Payee", "Category", "Memo", "C", "Payment", "Deposit", ...(withBalance ? ["Balance"] : []), ...(invest ? ["Activity", "Security", "Shares", "Price", "Total", "Commission"] : [])];
  const body = rows.map((r) => {
    const category = r.transfer_account_name ? `Transfer : ${r.transfer_account_name}` : (r.category_name ?? "");
    const payment = r.amount_cents < 0 ? csvCents(-r.amount_cents) : "";
    const deposit = r.amount_cents > 0 ? csvCents(r.amount_cents) : "";
    const cells = [
      q(r.check_number ?? ""),
      r.date,
      q(r.is_void ? `**VOID** ${r.payee}` : r.payee),
      q(category),
      q(r.notes ?? ""),
      r.cleared_state ?? "",
      payment,
      deposit,
      ...(withBalance ? [csvCents(r.running_balance_cents)] : []),
      ...(invest
        ? [
            r.activity ?? "",
            q(r.security_name ?? ""),
            r.shares_micro ? csvMicro(r.shares_micro) : "",
            r.price_micro ? csvMicro(r.price_micro, 2) : "",
            r.gross_cents ? csvCents(r.gross_cents) : "",
            r.commission_cents ? csvCents(r.commission_cents) : "",
          ]
        : []),
    ];
    return cells.join(",");
  });
  return [head.map(q).join(","), ...body].join("\r\n") + "\r\n";
}
