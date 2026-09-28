// The IPC contract: every argument `ipc.ts` sends must be an argument the
// Rust command actually takes.
//
// WHY THIS FILE EXISTS. `set_account_tax_included` took a parameter named
// `id`; `ipc.ts` sent `accountId`. Tauri could not deserialize the call, so
// every attempt to bring a retirement account into the tax reports failed —
// the checkbox on the Taxes tab would not stay ticked, and a 401(k)'s
// withholding could never reach a tax report. It shipped, because both sides
// were tested and neither test could see the other: `ipc.test.ts` asserts
// what the wrapper sends against a MOCK, and the Rust test calls
// `queries::set_account_tax_included` directly, below the command layer. The
// mock agreed with the wrapper and the query agreed with itself.
//
// So this test reads the two real files and compares them. It parses rather
// than executes, which is the only way to check a boundary whose two sides
// are never both present at runtime in any test.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Resolved from the repo root (vitest's cwd), not from import.meta.url —
// under the jsdom/browser transform that URL is not a file: one.
const RS = readFileSync(resolve("src-tauri/src/commands.rs"), "utf8");
const TS = readFileSync(resolve("src/lib/ipc.ts"), "utf8");

function camel(snake: string): string {
  const [head, ...rest] = snake.split("_");
  return head + rest.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

/** Read the balanced (...) that starts at `open`. */
function balanced(src: string, open: number, o = "(", c = ")"): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === o) depth++;
    else if (src[i] === c) {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced ${o} at ${open}`);
}

/** Split on commas that are not inside <>, () or []. */
function topLevelSplit(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "<" || ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ">" || ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.filter((p) => p.trim() !== "");
}

/** Every #[tauri::command] in commands.rs -> the argument names it expects on the wire. */
function rustCommands(): Map<string, Set<string>> {
  const cmds = new Map<string, Set<string>>();
  const attr = /#\[tauri::command(\([^)]*\))?\]/g;
  let m: RegExpExecArray | null;
  while ((m = attr.exec(RS)) !== null) {
    const isCamel = (m[1] ?? "").includes("camelCase");
    const after = RS.slice(m.index + m[0].length);
    const fn = /\bfn\s+(\w+)\s*\(/.exec(after);
    if (!fn) continue;
    const name = fn[1];
    const open = m.index + m[0].length + fn.index + fn[0].length - 1;
    const params = balanced(RS, open);
    const keys = new Set<string>();
    for (const raw of topLevelSplit(params)) {
      const p = raw.trim();
      const colon = p.indexOf(":");
      if (colon < 0) continue;
      const nm = p.slice(0, colon).trim();
      const ty = p.slice(colon + 1);
      // Tauri injects these; they are never sent from the front end.
      if (/\bState\s*<|AppHandle|\bWindow\b/.test(ty)) continue;
      keys.add(isCamel ? camel(nm) : nm);
    }
    cmds.set(name, keys);
  }
  return cmds;
}

/** The keys of the nearest preceding `name: { a: A; b: B }` before `before`. */
function keysOfDeclaredType(name: string, before: number, cmd: string): Set<string> {
  const keys = new Set<string>();
  const decl = new RegExp(`\\b${name}\\s*:\\s*\\{`, "g");
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  const head = TS.slice(0, before);
  while ((m = decl.exec(head)) !== null) last = m;
  expect(last, `ipc.ts passes ${name} to ${cmd} but declares no object type for it`).not.toBeNull();
  const body = balanced(TS, last!.index + last![0].length - 1, "{", "}");
  for (const field of body.split(/[;\n]/)) {
    const f = /^\s*(\w+)\??\s*:/.exec(field);
    if (f) keys.add(f[1]);
  }
  return keys;
}

/**
 * Every `invoke<T>("cmd", ...)` in ipc.ts -> the keys it sends.
 *
 * Three shapes, all checked rather than skipped: no argument at all, an
 * object literal (including `{ ...p }`), and a bare object parameter passed
 * straight through (`invoke("cmd", p)`). The last two are resolved by reading
 * the keys off that parameter's inline type literal — those are the widest
 * commands, so skipping them would leave the biggest holes unguarded.
 */
function tsCalls(): { cmd: string; keys: Set<string>; where: number }[] {
  const out: { cmd: string; keys: Set<string>; where: number }[] = [];
  const call = /invoke<[^>]*>\(\s*"(\w+)"\s*(?:,\s*(\{|\w+))?/g;
  let m: RegExpExecArray | null;
  while ((m = call.exec(TS)) !== null) {
    const cmd = m[1];
    const arg = m[2];
    let keys = new Set<string>();
    if (arg === "{") {
      const open = m.index + m[0].length - 1;
      for (const raw of topLevelSplit(balanced(TS, open, "{", "}"))) {
        const p = raw.trim();
        if (p.startsWith("...")) {
          for (const k of keysOfDeclaredType(p.slice(3).trim(), m.index, cmd)) keys.add(k);
        } else {
          const k = /^(\w+)/.exec(p);
          if (k) keys.add(k[1]);
        }
      }
    } else if (arg) {
      keys = keysOfDeclaredType(arg, m.index, cmd);
    }
    out.push({ cmd, keys, where: m.index });
  }
  return out;
}

describe("the ipc.ts / commands.rs contract", () => {
  const cmds = rustCommands();
  const calls = tsCalls();

  it("finds both sides", () => {
    expect(cmds.size).toBeGreaterThan(100);
    expect(calls.length).toBeGreaterThan(100);
  });

  it("only invokes commands that exist", () => {
    const missing = calls.filter((c) => !cmds.has(c.cmd)).map((c) => c.cmd);
    expect(missing, `ipc.ts invokes commands that commands.rs does not define: ${missing.join(", ")}`).toEqual([]);
  });

  it("sends exactly the arguments each command takes", () => {
    const wrong: string[] = [];
    for (const c of calls) {
      const want = cmds.get(c.cmd);
      if (!want) continue;
      const sent = [...c.keys].sort();
      const expected = [...want].sort();
      if (sent.join(",") !== expected.join(",")) {
        wrong.push(`${c.cmd}: ipc.ts sends [${sent.join(", ")}], commands.rs takes [${expected.join(", ")}]`);
      }
    }
    expect(wrong, `\n${wrong.join("\n")}\n`).toEqual([]);
  });
});
