// CSV import (§88): look, map, confirm. The backend reads the file and
// guesses which column is which from the header names; this dialog shows the
// first rows under those headers, lets the user correct the guess with a
// select per role, and shows — from the backend, re-read on every change —
// how the first rows come out as date / payee / amount. Import writes
// through the same path as a QIF, so rename rules and dedupe apply.
import { useEffect, useRef, useState } from "react";
import Money from "./Money";
import Notice from "./Notice";
import { api } from "../lib/ipc";
import { runCommand } from "../lib/commands";
import { formatDateUS } from "../lib/format";
import type { CsvMapping, CsvPreview, ImportSummary } from "../lib/types";

interface Props {
  path: string;
  accountId: string;
  accountName: string;
  onImported: (summary: ImportSummary) => void;
  onCancel: () => void;
  /** §89: when given, Import hands the confirmed mapping back instead of
   *  writing, so the match review can run on the rows it produces. */
  onConfirm?: (mapping: CsvMapping) => void;
}

type Role = "date" | "payee" | "amount" | "debit" | "credit" | "memo" | "check_number" | "category";
const ROLES: [Role, string, string][] = [
  ["date", "Date", "required"],
  ["payee", "Payee", "the description"],
  ["amount", "Amount", "one signed column — or use Debit and Credit"],
  ["debit", "Debit / Withdrawal", "money out, unsigned"],
  ["credit", "Credit / Deposit", "money in, unsigned"],
  ["memo", "Memo", ""],
  ["check_number", "Check number", ""],
  ["category", "Category", "as the bank names it"],
];

export default function CsvImportDialog({ path, accountId, accountName, onImported, onCancel, onConfirm }: Props) {
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [mapping, setMapping] = useState<CsvMapping | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = path.split(/[\\/]/).pop() ?? path;

  // §183 — which preview still counts. Every change of a column re-reads the
  // file, and two quick changes can answer out of order: the older reply
  // landing last put its mapping back over the newer choice, so the select
  // showed one column and Import sent another.
  const latest = useRef(0);

  async function load(m: CsvMapping | null, hasHeader: boolean | null) {
    const mine = ++latest.current;
    setError(null);
    try {
      const p = await api.previewCsv(path, hasHeader, m);
      if (mine !== latest.current) return;
      setPreview(p);
      setMapping(p.mapping);
    } catch (e) {
      if (mine === latest.current) setError(String(e));
    }
  }
  useEffect(() => {
    void load(null, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  function set(role: Role, value: string) {
    if (!mapping) return;
    const next: CsvMapping = { ...mapping, [role]: value === "" ? null : Number(value) };
    // One shape or the other.
    if (role === "amount" && next.amount !== null) {
      next.debit = null;
      next.credit = null;
    }
    if ((role === "debit" || role === "credit") && next[role] !== null) next.amount = null;
    setMapping(next);
    void load(next, next.has_header);
  }

  function setOpt(patch: Partial<CsvMapping>) {
    if (!mapping) return;
    const next = { ...mapping, ...patch };
    setMapping(next);
    void load(next, next.has_header);
  }

  const ready = !!mapping && mapping.date !== null && (mapping.amount !== null || mapping.debit !== null || mapping.credit !== null);
  const unreadable = preview?.parsed.filter((r) => r.error).length ?? 0;

  async function doImport() {
    if (!mapping || !ready) return;
    if (onConfirm) {
      onConfirm(mapping);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onImported(await api.importCsv(path, accountId, mapping));
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <>
      <div className="tm-dialog-backdrop" onClick={busy ? undefined : onCancel} />
      <div className="tm-dialog" role="dialog" aria-label="Import CSV" style={{ minWidth: 760, maxWidth: "94vw" }}>
        <div className="tm-dialog-title">
          Import CSV — {file} into {accountName}
        </div>
        <div className="tm-dialog-body space-y-3 text-[12px]" style={{ maxHeight: "78vh", overflowY: "auto" }}>
          {!preview && !error && <div className="tm-text-muted">Reading…</div>}
          {/* §132 — the wrong door. A tsp.gov export is a .csv, so this is
              where it lands, and this importer reads one signed amount per
              row: the balance comes out right and every row is a bare payee
              with no fund, no units and no price. Said BEFORE the mapping
              table, because by the time you are choosing columns you have
              already decided this is the right screen. */}
          {preview?.looks_like_tsp && (
            /* §152 — the wrong door is now SHUT, not signposted.
               > "Why bother with the warning when you can just limit it to
               >  the TSP specific import?"
               §132 put a warning here and left the mapping table and a live
               Import button underneath it, so the only thing standing between
               the user and a bad import was reading a paragraph. Nothing below
               this renders now, and the button that would have done the
               damage is replaced by one that opens the right importer. */
            <div className="tm-merge-blocked" role="alert" style={{ lineHeight: 1.5 }}>
              <div className="tm-merge-blocked-head">This is a TSP activity detail file</div>
              <p>
                This importer reads one signed amount per row. It would bring in the amounts only —
                no fund, no units, no price — and name every row after the account rather than the
                buy or sell it was.
              </p>
              <p>
                The TSP importer reads the funds, works out the units and prices, and asks what
                actually reached your bank for any withdrawal.
              </p>
            </div>
          )}
          {/* §175 — the same shut door for a brokerage or plan history: a
              Fidelity, Schwab or Vanguard export has Symbol and Quantity
              columns, and flat it would be bare cash rows. There is no CSV
              reader for those; the broker's QIF / OFX / QFX download goes
              through Investing → Import. */}
          {preview?.looks_like_brokerage && (
            <div className="tm-merge-blocked" role="alert" style={{ lineHeight: 1.5 }}>
              <div className="tm-merge-blocked-head">This looks like a brokerage or retirement plan history</div>
              <p>
                It has Symbol and Quantity columns. This importer reads one signed amount per row, so every
                buy and sell would arrive as a plain cash entry — no fund, no shares, no price — and the
                holdings would be wrong.
              </p>
              <p>
                Download the account's activity from the broker as QIF, OFX or QFX instead, and bring that in
                through the investment account's <b>Import</b>. It carries the shares and prices.
              </p>
            </div>
          )}
          {preview && mapping && !preview.looks_like_tsp && !preview.looks_like_brokerage && (
            <>
              <div className="tm-text-muted">
                {preview.total_rows.toLocaleString("en-US")} rows; the first {preview.rows.length} are shown. Say which column is which — the guess is from the
                column names. Nothing is written until you click Import.
              </div>

              <div className="flex flex-wrap gap-x-6 gap-y-1">
                {ROLES.map(([role, label, hint]) => (
                  <label key={role} className="inline-flex items-center gap-1" title={hint}>
                    <span style={{ width: 120 }} className="text-right">
                      {label}:
                    </span>
                    <select className="aero-field" aria-label={label} value={mapping[role] === null ? "" : String(mapping[role])} onChange={(e) => set(role, e.target.value)}>
                      <option value="">—</option>
                      {preview.headers.map((h, i) => (
                        <option key={i} value={String(i)}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>

              <div className="flex flex-wrap gap-x-6 gap-y-1 items-center">
                <label className="inline-flex items-center gap-1">
                  <span>Dates read as</span>
                  <select className="aero-field" aria-label="Date order" value={mapping.date_order} onChange={(e) => setOpt({ date_order: e.target.value as CsvMapping["date_order"] })}>
                    <option value="auto">work it out</option>
                    <option value="mdy">month / day / year</option>
                    <option value="dmy">day / month / year</option>
                    <option value="ymd">year-month-day</option>
                  </select>
                </label>
                <label className="inline-flex items-center gap-1">
                  <input type="checkbox" checked={mapping.negate} onChange={(e) => setOpt({ negate: e.target.checked })} />
                  Flip the signs (the file lists charges as positive numbers — most card statements)
                </label>
                <label className="inline-flex items-center gap-1">
                  <input type="checkbox" checked={mapping.has_header} onChange={(e) => setOpt({ has_header: e.target.checked })} />
                  First line is column names
                </label>
              </div>

              {/* §165 — two tables, and each says which it is. The first is
                  the file exactly as the bank wrote it, under the bank's own
                  column names; the second is what T-Money will write into
                  the register from it. They used to sit one above the other
                  with only "How they read" between them, and which was which
                  had to be worked out from the shape of the numbers. */}
              <div>
                <div className="font-bold pb-1">1. From the bank — the file as it is</div>
                <div className="tm-text-muted pb-1">
                  The first {preview.rows.length} rows of {file}, under the bank's own column names. Nothing here is changed.
                </div>
                <div className="overflow-auto" style={{ maxHeight: 220 }}>
                  <table className="register-table" aria-label="First rows of the file">
                    <thead>
                      <tr>
                        {preview.headers.map((h, i) => (
                          <th key={i}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((r, ri) => (
                        <tr key={ri}>
                          {preview.headers.map((_, ci) => (
                            <td key={ci} className="whitespace-nowrap">
                              {r[ci] ?? ""}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {ready && preview.parsed.length > 0 && (
                <div>
                  <div className="font-bold pb-1">2. Into T-Money — what will be written to {accountName}</div>
                  <div className="tm-text-muted pb-1">
                    The same rows as the register will show them, read through the mapping above: the date, the payee,
                    which side the money moved, and the Num, memo and category if a column was chosen for them. A
                    payee rule can still rename a row or fill in its category on the way in. If a column is wrong,
                    change the mapping and this updates. Nothing is written until you click Import.
                  </div>
                  {/* §159 — I1: sized to its content rather than stretched to
                      the dialog's width, which put the date at one edge and
                      the amounts at the other with nothing between. Short
                      columns, read left to right. */}
                  <table
                    className="register-table tm-csv-reads"
                    aria-label="How the first rows read"
                    style={{ tableLayout: "auto", width: "auto", maxWidth: "100%" }}
                  >
                    <thead>
                      <tr>
                        <th style={{ width: 90 }}>Date</th>
                        {mapping.check_number !== null && <th style={{ width: 60 }}>Num</th>}
                        <th>Payee</th>
                        <th className="num" style={{ width: 110 }}>Payment</th>
                        <th className="num" style={{ width: 110 }}>Deposit</th>
                        {mapping.category !== null && <th>Category</th>}
                        {mapping.memo !== null && <th>Memo</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.parsed.map((p, i) =>
                        p.error ? (
                          <tr key={i}>
                            <td colSpan={7} className="money-neg">
                              Row {i + 1}: {p.error} — will be skipped
                            </td>
                          </tr>
                        ) : (
                          <tr key={i}>
                            <td className="whitespace-nowrap">{p.date ? formatDateUS(p.date) : ""}</td>
                            {mapping.check_number !== null && <td>{p.check_number ?? ""}</td>}
                            <td className="tm-csv-payee" title={p.payee ?? ""}>
                              {p.payee}
                            </td>
                            <td className="num">{p.amount_cents !== null && p.amount_cents < 0 ? <Money cents={-p.amount_cents} tone="neutral" /> : ""}</td>
                            <td className="num">{p.amount_cents !== null && p.amount_cents > 0 ? <Money cents={p.amount_cents} tone="neutral" /> : ""}</td>
                            {mapping.category !== null && (
                              <td className="tm-csv-payee" title={p.category ?? ""}>
                                {p.category ?? <span className="tm-text-muted">(none — a payee rule may fill it in)</span>}
                              </td>
                            )}
                            {mapping.memo !== null && (
                              <td className="tm-csv-payee tm-text-muted" title={p.memo ?? ""}>
                                {p.memo ?? ""}
                              </td>
                            )}
                          </tr>
                        )
                      )}
                    </tbody>
                  </table>
                  {unreadable > 0 && (
                    <div className="tm-text-muted pt-1">
                      {unreadable} of the first {preview.parsed.length} cannot be read with this mapping — a heading or a balance line is normal; every row skipped is
                      named after the import.
                    </div>
                  )}
                </div>
              )}
              {!ready && <div className="money-neg">Choose the Date column, and an Amount column or Debit and Credit columns.</div>}
            </>
          )}
          {error && (
            <Notice tone="error" boxed>
              {error}
            </Notice>
          )}
          <div className="flex justify-end gap-2 pt-1">
            {preview?.looks_like_tsp ? (
              <button
                className="aero-btn default"
                type="button"
                onClick={() => {
                  onCancel();
                  // §155 — with the file, so it is not asked for twice.
                  runCommand("import.tsp", path);
                }}
              >
                Open the TSP importer
              </button>
            ) : preview?.looks_like_brokerage ? null : (
              <button className="aero-btn default" type="button" disabled={!ready || busy} onClick={() => void doImport()}>
                {busy ? "Importing…" : "Import"}
              </button>
            )}
            <button className="aero-btn" type="button" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
