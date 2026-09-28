// §117 — the screen when no file is open.
//
// File → Close used to mean "go back to T-Money's own database" (§104), on
// the reasoning that a start screen would exist for one purpose. The first
// time that met a real machine it did the one thing it must not: a user had
// the same accounts in their own file and in the app's, so Close swapped one
// for the other and the screen looked completely unchanged. A Close you
// cannot see the result of is worse than no Close at all.
//
// So this screen exists, and "no file open" is now a real state of the app:
// the pool is dropped, the file handle released, and there is exactly one
// thing to do here — pick a file.
import TmIcon from "./TmIcon";

export interface RecentFile {
  path: string;
  name: string;
  exists: boolean;
  /** §134 — this computer holds no key that opens it. Marked rather than
   *  disabled: the file is perfectly openable, it just needs the key pasted
   *  in, and a grayed-out row would say the opposite. */
  needsKey?: boolean;
}

interface Props {
  /** The file that was open a moment ago, offered back as the first thing. */
  lastFile?: { path: string; name: string } | null;
  recents: readonly RecentFile[];
  onOpen: () => void;
  onNew: () => void;
  /** §128 — a new file with three years of demo data in it. Offered HERE
   *  because this is the screen somebody sees the first time they run the
   *  app, and "New file…" hands them an empty register, which is the worst
   *  possible first impression of a program whose whole job is showing you
   *  what your money did. */
  onSample?: () => void;
  onOpenPath: (path: string) => void;
  onForget?: (path: string) => void;
  /** Shown when an open was refused — a file from another machine, a path
   *  that is no longer there. */
  error?: string | null;
}

export default function StartScreen({
  lastFile = null,
  recents,
  onOpen,
  onNew,
  onSample,
  onOpenPath,
  onForget,
  error = null,
}: Props) {
  // The file just closed is already the top recent; showing it twice would
  // read as two different files.
  const rest = recents.filter((r) => !lastFile || r.path !== lastFile.path);
  return (
    <div className="tm-start" role="region" aria-label="No file open">
      <div className="tm-start-card aero-card">
        <div className="aero-card-title">
          <TmIcon name="accounts" size={15} /> No file is open
        </div>
        <div className="p-4">
          <p className="text-[12px] tm-text-muted pb-3">
            Your money is in a file, and none is open right now. Nothing has been changed or lost —
            open one to carry on.
          </p>

          {error && (
            <div className="money-neg text-[12px] pb-3" role="alert">
              {error}
            </div>
          )}

          <div className="flex gap-2 flex-wrap pb-4">
            {lastFile && (
              <button
                type="button"
                className="aero-btn default"
                onClick={() => onOpenPath(lastFile.path)}
                title={lastFile.path}
              >
                Reopen “{lastFile.name}”
              </button>
            )}
            <button type="button" className={lastFile ? "aero-btn" : "aero-btn default"} onClick={onOpen}>
              Open a file…
            </button>
            <button type="button" className="aero-btn" onClick={onNew}>
              New file…
            </button>
            {onSample && (
              <button
                type="button"
                className="aero-btn"
                onClick={onSample}
                title="Creates a new file with three years of invented accounts and transactions. Nothing you already have is touched."
              >
                Sample file…
              </button>
            )}
          </div>

          {rest.length > 0 && (
            <>
              <div className="font-bold text-[12px] pb-1">Recent files</div>
              <ul className="tm-start-recents">
                {rest.map((r) => (
                  <li key={r.path}>
                    <button
                      type="button"
                      className="tm-start-recent"
                      disabled={!r.exists}
                      title={
                        !r.exists
                          ? `${r.path} — not there any more`
                          : r.needsKey
                            ? `${r.path} — needs its master key on this computer`
                            : r.path
                      }
                      onClick={() => onOpenPath(r.path)}
                    >
                      <span className="tm-start-recent-name">
                        {r.name}
                        {r.exists && r.needsKey && (
                          <span className="tm-needs-key" title="This computer has no key for this file — you will be asked to paste it">
                            key needed
                          </span>
                        )}
                      </span>
                      <span className="tm-start-recent-path">{r.exists ? r.path : "missing"}</span>
                    </button>
                    {onForget && !r.exists && (
                      <button
                        type="button"
                        className="tm-start-forget"
                        aria-label={`Forget ${r.name}`}
                        title="Take it off this list"
                        onClick={() => onForget(r.path)}
                      >
                        ✕
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}

          <p className="text-[11px] tm-text-muted pt-4">
            A T-Money file is encrypted, and its key lives in this computer’s credential store. A
            file made on another machine asks for that machine’s key the first time it is opened
            here — paste it once and it is remembered. Get it from the other machine under Tools →
            Settings → Database → Save master key.
          </p>
        </div>
      </div>
    </div>
  );
}
