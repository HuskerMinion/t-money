// No keyring is running, and a new file is being made.
//
// T-Money keeps each file's key in the computer's keyring. Windows and macOS
// always have one; Linux has one on GNOME and KDE desktops but not everywhere
// (a minimal desktop, a server, WSL). There the backend answers NO_KEYRING
// rather than make up a key it could not keep — a key held only in memory
// would lock the person out of their new file the moment T-Money closed.
//
// So this says what is missing and how to fix it, and offers the other way:
// keep the key yourself. The key is made here, shown once, saved or copied,
// and only then is the file created with it. It is asked for each time the
// file is opened.
import { useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import Notice from "./Notice";
import { api } from "../lib/ipc";
import { keyStoreWords } from "../lib/keyStore";

/** A new key: 32 random bytes, hex — the same shape the backend makes. */
export function newMasterKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The key file, written the way Settings → Security → Save to a file
 *  writes it, so the key box reads it back the same way. */
export function keyFileText(key: string): string {
  return [
    "T-Money master key",
    "",
    key,
    "",
    "This key decrypts your T-Money database and every backup of it.",
    "Without it those files cannot be opened by anyone, including you.",
    "Keep it somewhere separate from the backups themselves.",
    "",
  ].join("\r\n");
}

interface Props {
  fileName: string;
  busy?: boolean;
  /** Create the file with this key, which the person keeps. */
  onCreate: (key: string) => void;
  onCancel: () => void;
}

export default function NoKeyringDialog({ fileName, busy = false, onCreate, onCancel }: Props) {
  const [ownKey, setOwnKey] = useState(false);
  // State, not a memo: React may drop a memo, and this key must not change
  // once it has been shown.
  const [key] = useState(() => newMasterKey());
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    first.current?.focus();
  }, []);
  const [kept, setKept] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const words = keyStoreWords();

  async function saveToFile() {
    setError(null);
    const path = await save({
      title: "Save the master key",
      defaultPath: `${fileName} master key.txt`,
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
    if (!path) return;
    try {
      await api.writeTextFile(path, keyFileText(key));
      setNote(`Key written to ${path}. Keep it somewhere separate from your backups.`);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <>
      <div className="tm-dialog-backdrop" onClick={() => !busy && onCancel()} />
      <div
        className="tm-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={words.title}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !busy) onCancel();
        }}
      >
        <div className="tm-dialog-title">{words.title}</div>
        <div className="tm-dialog-body space-y-2 text-[12px]">
          <p>
            T-Money keeps each file&rsquo;s key in {words.missing}, so <strong>{fileName}</strong> was not created.
          </p>
          <p>{words.fix}</p>

          {!ownKey ? (
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className="aero-btn" ref={first} onClick={() => setOwnKey(true)}>
                Keep the key myself instead…
              </button>
              <button type="button" className="aero-btn default" onClick={onCancel}>
                Close
              </button>
            </div>
          ) : (
            <div className="space-y-2 pt-1" aria-label="Keep the key yourself">
              <p>
                Then this is the file&rsquo;s key. T-Money will not keep it: you will be asked for it every time you
                open <strong>{fileName}</strong>, and <strong>without it the file cannot be opened by anyone</strong>,
                including you.
              </p>
              <input
                className="tm-keyvalue block w-full font-mono"
                aria-label="New master key"
                readOnly
                value={key}
                onFocus={(e) => e.currentTarget.select()}
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  className="aero-btn"
                  onClick={() => {
                    setError(null);
                    Promise.resolve(navigator.clipboard?.writeText(key)).then(
                      () => setNote("Key copied to the clipboard."),
                      () => setError("The key could not be copied. Select it above and copy it, or save it to a file.")
                    );
                  }}
                >
                  Copy
                </button>
                <button type="button" className="aero-btn" onClick={() => void saveToFile()}>
                  Save to a file…
                </button>
              </div>
              {note && <div className="tm-text-muted">{note}</div>}
              {error && <Notice tone="error">{error}</Notice>}
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={kept} onChange={(e) => setKept(e.target.checked)} />
                I have saved this key somewhere safe.
              </label>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  className="aero-btn default"
                  disabled={busy || !kept}
                  onClick={() => onCreate(key)}
                >
                  Create {fileName}
                </button>
                <button type="button" className="aero-btn" onClick={onCancel} disabled={busy}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
