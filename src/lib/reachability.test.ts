// Every IPC wrapper must actually be CALLED by the app.
//
// The 2026-08-30 audit found 8 registered commands that no screen could reach:
// `ipc.test.ts` proved they were wrapped, which is exactly why it did not
// catch it. A wrapper is not a feature. This test closes that gap — it fails
// when a wrapper exists that nothing outside `ipc.ts` and the tests calls.
//
// If a genuinely deferred command lands (backend first, UI next sprint), add
// it to KNOWN_UNREACHED with a note, so the debt is visible rather than silent.
import { describe, expect, it } from "vitest";

const ipcSource = Object.values(
  import.meta.glob("./ipc.ts", { query: "?raw", import: "default", eager: true })
) as string[];

const appSources = Object.entries(
  import.meta.glob(["../**/*.ts", "../**/*.tsx"], {
    query: "?raw",
    import: "default",
    eager: true,
  })
) as [string, string][];

/** Wrappers that are deliberately not wired up yet. Keep this empty. */
const KNOWN_UNREACHED: string[] = [];

/** `  someName: (` or `  someName: () =>` at the top level of the api object. */
function wrapperNames(src: string): string[] {
  return [...src.matchAll(/^ {2}(\w+):\s*(?:\(|<)/gm)].map((m) => m[1]);
}

describe("IPC reachability", () => {
  const names = wrapperNames(ipcSource[0] ?? "");

  it("finds the api wrappers to check", () => {
    expect(names.length).toBeGreaterThan(40);
  });

  it("every wrapper is called somewhere outside ipc.ts and the tests", () => {
    const callers = appSources.filter(
      ([path]) =>
        !path.endsWith("/ipc.ts") &&
        !path.includes(".test.") &&
        !path.includes("/test/")
    );
    const haystack = callers.map(([, src]) => src).join("\n");

    const unreached = names.filter(
      (n) => !KNOWN_UNREACHED.includes(n) && !new RegExp(`\\bapi\\s*\\.\\s*${n}\\b`).test(haystack)
    );

    expect(unreached, `unreachable IPC wrappers: ${unreached.join(", ")}`).toEqual([]);
  });
});
