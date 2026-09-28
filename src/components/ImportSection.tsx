// Import — pick a QIF/OFX statement file and import it into an account.
// Uses the Tauri dialog plugin for the native file picker, then
// import_qif_ofx. Shown as a section inside the Banking tab.
import { useEffect, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import Money from "./Money";
import Notice from "./Notice";
import TmIcon from "./TmIcon";
import { api } from "../lib/ipc";
import { useAccountStore } from "../stores/useAccountStore";
import { refreshUndo } from "../lib/undo";
import type { Category, CsvMapping, ImportMatchPreview, ImportSummary, MemoRule } from "../lib/types";
import CsvImportDialog from "./CsvImportDialog";
import { useCommand } from "../lib/useCommand";
import { runCommand } from "../lib/commands";
import ImportMatchDialog from "./ImportMatchDialog";
import PlanMemoDialog from "./PlanMemoDialog";

export default function ImportSection() {
  const accounts = useAccountStore((s) => s.accounts);
  const loadAccounts = useAccountStore((s) => s.loadAccounts);
  const selectedAccountId = useAccountStore((s) => s.selectedAccountId);
  // §159 — the review's category picker.
  const categories: readonly Category[] = useAccountStore((s) => s.categories);
  const loadCategories = useAccountStore((s) => s.loadCategories);

  const [accountId, setAccountId] = useState<string>("");
  const [filePath, setFilePath] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  // §88: a CSV goes through the mapping dialog instead of straight in.
  const [csvPath, setCsvPath] = useState<string | null>(null);
  // §89: the match review, and the CSV mapping it belongs to (null for QIF/OFX).
  const [preview, setPreview] = useState<ImportMatchPreview | null>(null);
  const [mapping, setMapping] = useState<CsvMapping | null>(null);
  // §90: a plan statement asks what its memos mean first, and the answers
  // travel with the import that follows.
  const [memoPreview, setMemoPreview] = useState<ImportMatchPreview | null>(null);
  const [memoRules, setMemoRules] = useState<MemoRule[]>([]);
  // Money's "Export an account as QIF" (§54).
  const [exportId, setExportId] = useState<string>("");
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  // Default the target account to the currently-selected one.
  useEffect(() => {
    if (selectedAccountId) setAccountId(selectedAccountId);
  }, [selectedAccountId]);

  useEffect(() => {
    if (accounts.length === 0) loadAccounts();
    if (categories.length === 0) void loadCategories();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // §102 — File → Import. All three named the same screen and none of them
  // had an owner, so every one was grayed out. They differ only in which file
  // types the picker offers, which is the whole point of having three items:
  // "Prices only" should not invite you to pick a bank statement.
  useCommand("import.qif", () => void pickFile());
  useCommand("import.csv", () => void pickFile(["csv", "txt"]));
  useCommand("import.prices", () => void pickFile(["csv", "txt", "qif"]));

  async function pickFile(extensions: string[] = ["qif", "ofx", "qfx", "csv", "txt"]) {
    setError(null);
    setResult(null);
    const selected = await open({
      multiple: false,
      filters: [
        { name: extensions.join(", ").toUpperCase(), extensions },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (typeof selected !== "string") return;
    // §155 — the wrong door, shut at the threshold. A tsp.gov export is a
    // .csv, and §152 caught it only after Import CSV… was pressed — then made
    // the user choose the same file again in the right importer:
    //
    // > *"it would make sense that ... when I click the choose file button
    // >  it just goes ahead and launches the TSP importer rather than giving
    // >  me a message after clicking Import CSV and then having to go through
    // >  selecting the file a second time"*
    //
    // So the file is sniffed the moment it is chosen, and a TSP export goes
    // straight to the TSP importer, path and all.
    if (/\.(csv|txt)$/i.test(selected)) {
      try {
        const sniff = await api.previewCsv(selected, null, null);
        if (sniff.looks_like_tsp) {
          runCommand("import.tsp", selected);
          return;
        }
      } catch {
        // Not readable as a CSV here: the ordinary path will say why.
      }
    }
    setFilePath(selected);
  }

  const isCsv = /\.(csv|txt)$/i.test(filePath);

  /// §89: look before writing. Rows that are near misses against what is
  /// already in the account open the review dialog; a file with none of them
  /// imports exactly as it did before, without an extra click.
  async function reviewThenImport(path: string, m: CsvMapping | null, windowDays = 3, rules: MemoRule[] | null = null) {
    setBusy(true);
    setError(null);
    try {
      const p = await api.previewImport(path, accountId, m, windowDays);
      // §90 first: a plan statement's memos decide what its rows even are,
      // which has to be settled before anything else about them.
      if (rules === null && p.memo_groups.length > 0) {
        setMapping(m);
        setMemoPreview(p);
        return;
      }
      const memo = rules ?? memoRules;
      // §159 — rows with nothing to file them under are a reason to look
      // too, not only near misses.
      if (p.rows.length === 0 && p.uncategorized.length === 0) {
        // Nothing to decide. With no memo rules either, this is the same call
        // the import made before §89.
        if (memo.length === 0) {
          await afterImport(m ? await api.importCsv(path, accountId, m) : await api.importQifOfx(path, accountId));
        } else {
          await afterImport(await api.importWithDecisions(path, accountId, m, [], memo));
        }
      } else {
        setMapping(m);
        setPreview(p);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function afterImport(summary: ImportSummary) {
    setResult(summary);
    // Refresh balances (import mutates the account balance) — and the
    // register, if the account being imported into is the one on screen,
    // and the payee list the import just added to.
    await loadAccounts();
    const store = useAccountStore.getState();
    if (store.selectedAccountId === accountId) await store.loadRegister(accountId);
    await store.loadPayees();
    // §183 — and the categories. A CSV's category column, a plan memo's
    // "Retirement Contributions" and a QIF's category lines all create the
    // ones that are not there yet, and the pickers everywhere else read this
    // list: without the reload the new ones could not be chosen until the
    // file was opened again.
    await store.loadCategories();
    // §132 — an import empties the undo stack on the Rust side, because it
    // cannot itself be undone and leaving older steps there means Ctrl+Z
    // reaches PAST the import and takes back something unrelated. Read the
    // status back so the Edit menu grays out to match.
    await refreshUndo();
  }

  async function doImport(e: React.FormEvent) {
    e.preventDefault();
    if (!accountId || !filePath) {
      setError("Choose an account and a QIF, OFX or CSV file.");
      return;
    }
    setError(null);
    setResult(null);
    if (isCsv) {
      setCsvPath(filePath);
      return;
    }
    await reviewThenImport(filePath, null);
  }

  async function doExport() {
    setExportMsg(null);
    setExportError(null);
    const acct = accounts.find((a) => a.id === exportId);
    if (!acct) return;
    const path = await save({
      title: `Export ${acct.name} as QIF`,
      defaultPath: `${acct.name.replace(/[\\/:*?"<>|]/g, "_")}.qif`,
      filters: [{ name: "Quicken Interchange Format", extensions: ["qif"] }],
    });
    if (!path) return;
    setBusy(true);
    try {
      const [records, voided] = await api.exportQif(acct.id, path);
      setExportMsg(`${records} ${records === 1 ? "transaction" : "transactions"} written to ${path}${voided ? ` (${voided} void ${voided === 1 ? "row" : "rows"} left out)` : ""}.`);
    } catch (err) {
      setExportError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
    <section className="aero-card">
      <div className="aero-card-title flex items-center gap-2">
        <TmIcon name="export" size={15} /> Import QIF / OFX / CSV
      </div>
      <form onSubmit={doImport} className="p-3 space-y-2">
        <label className="block text-[11px] text-slate-600">
          Target account
          <select
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            className="mt-1 w-full rounded px-2 py-1 text-[12px] border"
            style={{ borderColor: "var(--tm-ms-card-border)" }}
          >
            <option value="">— select an account —</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>

        <div className="flex items-center gap-2">
          <button
            type="button"
            className="aero-btn shrink-0"
            onClick={() => void pickFile()}
          >
            <span className="inline-flex items-center gap-1">
              <TmIcon name="search" size={13} /> Choose file…
            </span>
          </button>
          <span className="text-[11px] text-slate-500 truncate" title={filePath}>
            {filePath ? filePath.split(/[\\/]/).pop() : "No file selected"}
          </span>
        </div>

        <button className="aero-btn w-full" type="submit" disabled={busy}>
          {busy ? "Importing…" : isCsv ? "Import CSV…" : "Import"}
        </button>
        {error && (
          <Notice tone="error" boxed>
            {error}
          </Notice>
        )}

        {result && (
          <div
            className="rounded p-2 text-[12px]"
            style={{ background: "var(--tm-ms-card-body)", border: "1px solid var(--tm-ms-card-border)" }}
          >
            <div className="font-bold mb-1">
              Imported into {result.account_name}
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 tabular-nums">
              <span>Imported</span>
              <span className="text-right">{result.imported}</span>
              {(result.investments ?? 0) > 0 && (
                <>
                  <span>Investment rows (buys, sells, income…)</span>
                  <span className="text-right">{result.investments}</span>
                </>
              )}
              {(result.securities_created ?? 0) > 0 && (
                <>
                  <span>New securities</span>
                  <span className="text-right">{result.securities_created}</span>
                </>
              )}
              {(result.transfers_linked ?? 0) > 0 && (
                <>
                  <span>Transfers linked to other accounts</span>
                  <span className="text-right">{result.transfers_linked}</span>
                </>
              )}
              {(result.matched ?? 0) > 0 && (
                <>
                  <span>Matched to transactions you already had</span>
                  <span className="text-right">{result.matched}</span>
                </>
              )}
              {(result.user_skipped ?? 0) > 0 && (
                <>
                  <span>Left out at your say-so</span>
                  <span className="text-right">{result.user_skipped}</span>
                </>
              )}
              <span>Duplicates skipped</span>
              <span className="text-right">{result.duplicates}</span>
              <span>Other skipped</span>
              <span className="text-right">{result.skipped}</span>
              <span className="font-bold">Balance change</span>
              <span className="text-right">
                <Money cents={result.balance_delta_cents} />
              </span>
            </div>
            {(result.notes ?? []).length > 0 && (
              <ul className="mt-1 text-[11px] tm-text-muted">
                {result.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </form>
    </section>
    {/* §183 — the dialogs sit OUTSIDE the form. Inside it, Enter in any of
        their fields (a plan memo's category, a category picker) was the
        form's implicit submission, and started the import over again from
        under the dialog that was still asking about it. */}
    {csvPath && accountId && (
      <CsvImportDialog
        path={csvPath}
        accountId={accountId}
        accountName={accounts.find((a) => a.id === accountId)?.name ?? ""}
        onCancel={() => setCsvPath(null)}
        onImported={(summary) => {
          setCsvPath(null);
          void afterImport(summary);
        }}
        onConfirm={(m) => {
          setCsvPath(null);
          void reviewThenImport(filePath, m);
        }}
      />
    )}
    {memoPreview && (
      <PlanMemoDialog
        preview={memoPreview}
        onCancel={() => setMemoPreview(null)}
        onConfirm={(rules) => {
          setMemoPreview(null);
          setMemoRules(rules);
          void reviewThenImport(filePath, mapping, 3, rules);
        }}
      />
    )}
    {preview && (
      <ImportMatchDialog
        path={filePath}
        accountId={accountId}
        mapping={mapping}
        memoRules={memoRules}
        preview={preview}
        categories={categories}
        onWindowChange={(days) => {
          setPreview(null);
          void reviewThenImport(filePath, mapping, days);
        }}
        onCancel={() => setPreview(null)}
        onImported={(summary) => {
          setPreview(null);
          void afterImport(summary);
        }}
      />
    )}
    <section className="aero-card mt-4">
      <div className="aero-card-title flex items-center gap-2">
        <TmIcon name="export" size={15} /> Export an account as QIF
      </div>
      <div className="p-3 space-y-2">
        <label className="block text-[11px] text-slate-600">
          Account
          <select
            aria-label="Account to export"
            value={exportId}
            onChange={(e) => setExportId(e.target.value)}
            className="mt-1 w-full rounded px-2 py-1 text-[12px] border"
            style={{ borderColor: "var(--tm-ms-card-border)" }}
          >
            <option value="">— select an account —</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <button className="aero-btn w-full" type="button" disabled={busy || !exportId} onClick={() => void doExport()}>
          Export…
        </button>
        <div className="text-[11px] tm-text-muted">
          Every transaction in the account, with categories, memos, cleared marks, splits and transfers, in the file Quicken and Money read. Void rows are left out.
        </div>
        {exportMsg && <div className="text-[11px]">{exportMsg}</div>}
        {exportError && (
          <Notice tone="error" boxed>
            {exportError}
          </Notice>
        )}
      </div>
    </section>
    </>
  );
}
