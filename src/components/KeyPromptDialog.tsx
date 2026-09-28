// §134 — the door finally gets a handle.
//
// > *"I want to open my file on another computer but it requires the key. I
// > think the file open for an existing file needs a way to paste the key in."*
//
// The backend has accepted a key on `open_file` since §98, and the comment in
// `App.tsx` beside the call said in plain words that a file from another
// machine needs its key typed in — while passing `null` every time. Everything
// was built except the box.
//
// WHY THIS ACCEPTS MORE THAN A KEY. Settings → Security → Master key → Save
// to a file… writes a file
// that reads:
//
//     T-Money master key
//
//     6f3a…64 hex characters…c1
//
//     This key decrypts your T-Money database and every backup of it.
//
// The realistic thing a person does on the second computer is open that file,
// select all, copy, and paste. A box that only accepts a bare key rejects the
// exact artifact the app itself told them to keep — so this pulls the key out
// of whatever lands in it. Paste the file, paste the line, paste the key with
// a trailing newline: all the same.
import { useEffect, useRef, useState } from "react";
import Notice from "./Notice";

/** A T-Money key is 32 random bytes, hex-encoded. */
const KEY_RE = /\b[0-9a-fA-F]{64}\b/;

/** §134 — the key inside whatever was pasted, or null.
 *
 *  Exported and pure. The whole-file paste is the case this exists for, and it
 *  is far easier to prove here than through a dialog. Case is normalized
 *  because a key copied out of a document that "helpfully" capitalized it is
 *  still the same 32 bytes.
 */
export function keyFromPaste(text: string): string | null {
  const m = KEY_RE.exec(text ?? "");
  return m ? m[0].toLowerCase() : null;
}

interface Props {
  /** What the user is trying to open — named, because "enter the key" without
   *  saying for what is how the wrong key gets entered. */
  fileName: string;
  /** True when a key was already tried and refused, so the dialog says so
   *  rather than looking like it did nothing. */
  wrongKey?: boolean;
  busy?: boolean;
  onSubmit: (key: string) => void;
  onCancel: () => void;
}

export default function KeyPromptDialog({
  fileName,
  wrongKey = false,
  busy = false,
  onSubmit,
  onCancel,
}: Props) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);

  const key = keyFromPaste(text);
  const typedSomething = text.trim().length > 0;

  return (
    <>
      {/* §183 — not while the file is being opened with the key. */}
      <div className="tm-dialog-backdrop" onClick={() => !busy && onCancel()} />
      <div className="tm-dialog" role="dialog" aria-label="Master key needed">
        <div className="tm-dialog-title">Master key needed</div>
        <div className="tm-dialog-body space-y-2 text-[12px]">
          <p>
            <strong>{fileName}</strong> was not created on this computer, so its key is not
            in this computer’s credential store. Paste it below and it will be remembered
            here.
          </p>

          {wrongKey && (
            <Notice tone="error" boxed>
              That key does not open this file. Check that all 64 characters came across.
            </Notice>
          )}

          <label className="block">
            Master key
            <textarea
              ref={ref}
              className="aero-field mt-1 w-full font-mono"
              aria-label="Master key"
              rows={3}
              spellCheck={false}
              autoComplete="off"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Paste the key, or the whole key file"
            />
          </label>

          {/* Say what was understood, not what the rules are. A person who
              pasted the whole file wants to know the box found the key in it;
              a person one character short wants to know that now and not after
              pressing Open. */}
          <p className="tm-text-muted">
            {key ? (
              <>
                Found a key ending <span className="font-mono">…{key.slice(-8)}</span>.
              </>
            ) : typedSomething ? (
              "No 64-character key in that — paste the key itself, or the whole key file."
            ) : (
              // §183 — the real path. There is no "Database → Save master key";
              // the key lives under Security → Master key (SettingsView).
              "On the other computer: Tools → Settings… → Security → Master key → Save to a file…, or Show my key and copy it."
            )}
          </p>

          <div className="flex justify-end gap-2 pt-3">
            <button
              type="button"
              className="aero-btn default"
              disabled={busy || !key}
              onClick={() => key && onSubmit(key)}
            >
              Open {fileName}
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
