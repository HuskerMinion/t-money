// The files attached to one transaction or one account: a receipt,
// a statement, a photo of the check. Quicken, Moneydance and Monarch all
// have this and it is the most-used thing T-Money did not.
//
// The bytes never pass through the webview. Add hands Rust a path (from the
// system file dialog) and Rust reads it into the encrypted file; Open writes
// a temp copy and hands it to whatever the OS opens that kind of file with;
// Save as… writes a copy where the save dialog said. So this panel only ever
// holds names, types and sizes.
//
// It writes immediately rather than on OK, the way Organize favorites does:
// attaching a file is not a form you fill in, and on a transaction it is on
// the undo stack like any other edit to the row.
import { useEffect, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { api } from "../lib/ipc";
import { noteChanged } from "../lib/undo";
import type { Attachment } from "../lib/types";

interface Props {
  /** Exactly one of these. */
  transactionId?: string | null;
  accountId?: string | null;
  /** Called after an add or a remove, so a register can refresh its 📎. */
  onChanged?: (count: number) => void;
}

/** "12 KB", "3.4 MB" — enough to know what a backup will carry. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** What the list says a file is, from its type. */
export function kindLabel(mime: string): string {
  if (mime === "application/pdf") return "PDF";
  if (mime.startsWith("image/")) return "Image";
  if (mime.startsWith("text/")) return "Text";
  if (mime.includes("spreadsheet") || mime.includes("excel")) return "Spreadsheet";
  if (mime.includes("word")) return "Document";
  return "File";
}

export default function AttachmentsPanel({ transactionId = null, accountId = null, onChanged }: Props) {
  const [items, setItems] = useState<Attachment[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** The count, or null when the list could not be read — which is not the
   *  same as nothing attached, and must not tell the owner there is none. */
  async function load(): Promise<number | null> {
    try {
      const list = await api.listAttachments(transactionId, accountId);
      setItems(list);
      return list.length;
    } catch (e) {
      setError(String(e));
      return null;
    }
  }
  function tell(n: number | null) {
    if (n !== null) onChanged?.(n);
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactionId, accountId]);

  async function add() {
    setError(null);
    const picked = await open({
      multiple: true,
      title: "Attach a file",
      filters: [
        { name: "Receipts and statements", extensions: ["pdf", "png", "jpg", "jpeg", "gif", "webp", "heic", "txt", "csv", "doc", "docx", "xls", "xlsx"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    const paths = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
    if (paths.length === 0) return;
    setBusy(true);
    try {
      for (const p of paths) await api.addAttachment(transactionId, accountId, p);
      // On a transaction each file is an undo step ("attach a file").
      noteChanged();
      // Reload FIRST, then tell the owner. `onChanged?.(await
      // load())` skipped the load whenever there was no handler: an optional
      // call short-circuits its arguments too, which is why the account
      // dialog (no handler) showed nothing until it was reopened (walk A4).
      tell(await load());
    } catch (e) {
      setError(String(e));
      // The files before the one that failed WERE attached. The list
      // was reloaded but the owner was not told, so the register's 📎 and
      // the count stayed where they were, and Undo still named the write
      // before them.
      noteChanged();
      tell(await load());
    } finally {
      setBusy(false);
    }
  }

  async function remove(a: Attachment) {
    setError(null);
    setBusy(true);
    try {
      await api.removeAttachment(a.id);
      // "remove an attachment" is an undo step on a transaction.
      noteChanged();
      // Reload FIRST, then tell the owner. `onChanged?.(await
      // load())` skipped the load whenever there was no handler: an optional
      // call short-circuits its arguments too, which is why the account
      // dialog (no handler) showed nothing until it was reopened (walk A4).
      tell(await load());
    } catch (e) {
      setError(String(e));
      // Whatever the refusal left behind is what the list and the
      // owner's count should show; reload and tell it, as a success does.
      tell(await load());
    } finally {
      setBusy(false);
    }
  }

  async function openIt(a: Attachment) {
    setError(null);
    try {
      await api.openAttachment(a.id);
    } catch (e) {
      setError(String(e));
    }
  }

  async function saveAs(a: Attachment) {
    setError(null);
    try {
      const path = await save({ defaultPath: a.name, title: "Save a copy of the attachment" });
      if (!path) return;
      await api.saveAttachment(a.id, path);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="tm-attachments text-[12px]" aria-label="Attachments">
      {items === null && !error && <div className="tm-text-muted">Loading…</div>}
      {items && items.length === 0 && (
        <div className="tm-text-muted py-1">Nothing attached yet. A receipt, a statement, a photo of the check — it is kept inside the file, encrypted, and goes with every backup.</div>
      )}
      {items && items.length > 0 && (
        <table className="register-table" aria-label="Attached files" style={{ tableLayout: "auto" }}>
          <thead>
            <tr>
              <th>File</th>
              <th style={{ width: 90 }}>Kind</th>
              <th className="num" style={{ width: 70 }}>Size</th>
              <th style={{ width: 220 }} />
            </tr>
          </thead>
          <tbody>
            {items.map((a) => (
              <tr key={a.id}>
                <td>
                  <button type="button" className="aero-side-item px-0" style={{ color: "var(--tm-ms-text-link)" }} onClick={() => void openIt(a)} title="Open with the program your computer uses for this kind of file">
                    {a.name}
                  </button>
                </td>
                <td className="tm-text-muted">{kindLabel(a.mime)}</td>
                <td className="num tm-text-muted">{sizeLabel(a.size_bytes)}</td>
                <td>
                  <button type="button" className="aero-btn !py-0 !px-2 text-[11px]" onClick={() => void openIt(a)} aria-label={`Open ${a.name}`}>
                    Open
                  </button>{" "}
                  <button type="button" className="aero-btn !py-0 !px-2 text-[11px]" onClick={() => void saveAs(a)} aria-label={`Save a copy of ${a.name}`}>
                    Save as…
                  </button>{" "}
                  <button type="button" className="aero-btn !py-0 !px-2 text-[11px]" onClick={() => void remove(a)} disabled={busy} aria-label={`Remove ${a.name}`}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {error && <div className="money-neg py-1">{error}</div>}
      <div className="pt-2">
        <button type="button" className="aero-btn" onClick={() => void add()} disabled={busy}>
          {busy ? "Working…" : "Attach a file…"}
        </button>
      </div>
    </div>
  );
}
