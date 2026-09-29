// Telling a locked file from a broken one.
//
// `open_file` fails for three different reasons and they want three different
// responses: the path is wrong (say so), the file is damaged (say so), or this
// computer simply has no key for it (ASK for one). Only the third is a door
// with a handle, and the UI has to know which it is looking at.
//
// The backend answers with a token first — `NEEDS_KEY: …` / `WRONG_KEY: …` —
// and the sentence for the human after it. Branching on the token rather than
// on the sentence is the point: a message is one reword away from a dialog
// that quietly stops appearing, and nothing would fail loudly when it did.
// The tokens are declared in `commands.rs` beside `NO_FILE`.

export type KeyProblem = "needs" | "wrong";

/** Which key problem an open failed with, or null if it was not one. */
export function keyProblem(err: unknown): KeyProblem | null {
  const s = String(err ?? "");
  if (s.includes("NEEDS_KEY")) return "needs";
  if (s.includes("WRONG_KEY")) return "wrong";
  return null;
}

/** The same error with the token taken off, for anywhere that just shows it. */
export function withoutSentinel(err: unknown): string {
  return String(err ?? "").replace(/\b(NEEDS_KEY|WRONG_KEY):\s*/, "");
}

/** What a file is called, from its path — the last segment without its
 *  extension, matching what `files::display_name` produces on the Rust side.
 *  Both separators, because a path typed on one platform can be read on the
 *  other. */
export function fileNameOf(path: string): string {
  const last = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  const dot = last.lastIndexOf(".");
  return dot > 0 ? last.slice(0, dot) : last;
}
