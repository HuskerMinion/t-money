// Arithmetic in an amount box.
//
// A receipt has three numbers on it and the register wants one. Money let
// you type the sum into the field; so does this: "12.99*4", "45+12.50-3",
// "100+8.5%", "(120+35)/3". The box works it out when you leave it or press
// Enter, and a form that saves first reads the same sum (`parseMoneyToCents`
// falls back to this), so the order the two happen in never matters.
//
// Each number is read the region's way ("12,50*2" in Germany), may carry a
// currency mark, and may have up to six decimals, so a tax rate like 8.875%
// can be typed as it is printed.
// Inside, the sum is a JS number in currency units, because 10/3 is not a
// whole number of cents; the result is rounded to the cent once, half away
// from zero, at the end.
//
// PERCENT means what a till means: after + or − it is a percentage OF what
// came before (100+8.5% is 108.50, 100-20% is 80.00); after × or ÷ it is the
// plain fraction (200*15% is 30.00). A bare "15%" is not an amount.
//
// Parentheses group. A lone number in them is the accounting negative, as
// it is on its own: a reconcile box seeded "(405.26)" with "-20" typed after
// it is -425.26. "(120+35)/3" is a group.

/** Characters that make text a sum rather than a number. A leading "-" or a
 *  pair of accounting parentheses alone do not. */
const OPERATOR = /[+*/×÷−%]|.-|\(.*\).|.\(/;

/** Longer than any sum anyone types. A pasted page of "(((" or "---" would
 *  otherwise recurse past the stack, or keep the regex below busy. */
const MAX_LENGTH = 200;

/** Reads one unsigned number; `rate` when a % follows it, so it can be read
 *  as a rate is ("8.875%" is never eight thousand, even in Germany). */
type Operand = (s: string, rate: boolean) => number | null;

type Tok = { k: "num"; v: number } | { k: "op"; v: string } | { k: "%" } | { k: "(" } | { k: ")" };

/** Does this text look like a sum? Only then is it worth evaluating. */
export function looksLikeSum(text: string): boolean {
  return text.length <= MAX_LENGTH && OPERATOR.test(text.replace(/\s/g, ""));
}

function tokenize(text: string, operand: Operand): Tok[] | null {
  const s = text.replace(/\s/g, "");
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "+" || c === "-" || c === "−") {
      out.push({ k: "op", v: c === "+" ? "+" : "-" });
      i++;
    } else if (c === "*" || c === "×") {
      out.push({ k: "op", v: "*" });
      i++;
    } else if (c === "/" || c === "÷") {
      out.push({ k: "op", v: "/" });
      i++;
    } else if (c === "%") {
      out.push({ k: "%" });
      i++;
    } else if (c === "(" || c === ")") {
      out.push({ k: c });
      i++;
    } else {
      let j = i;
      while (j < s.length && !"+-−*×/÷%()".includes(s[j])) j++;
      const v = operand(s.slice(i, j), s[j] === "%");
      if (v === null) return null;
      out.push({ k: "num", v });
      i = j;
    }
  }
  return out;
}

/** A value, and whether it was written as a percentage. */
interface Val {
  v: number;
  pct: boolean;
}

/**
 * Work out a typed sum, in cents, or null when it is not one: a stray
 * operator, an unreadable number, a division by zero, a bare percentage.
 * `operand` reads one unsigned number, in currency units.
 */
export function evalAmount(text: string, operand: Operand): number | null {
  if (text.length > MAX_LENGTH) return null;
  const read = tokenize(text, operand);
  if (!read || read.length === 0) return null;
  const toks: Tok[] = read;
  let at = 0;
  const peek = () => toks[at];
  const isOp = (t: Tok | undefined, ...ops: string[]) => t?.k === "op" && ops.includes(t.v);

  function primary(): Val | null {
    const t = toks[at++];
    let val: Val | null = null;
    if (t?.k === "num") val = { v: t.v, pct: false };
    else if (t?.k === "(" && toks[at]?.k === "num" && toks[at + 1]?.k === ")") {
      val = { v: -(toks[at] as { v: number }).v, pct: false };
      at += 2;
    } else if (t?.k === "(") {
      const inner = expr();
      if (!inner || inner.pct || toks[at++]?.k !== ")") return null;
      val = { v: inner.v, pct: false };
    } else return null;
    if (peek()?.k === "%") {
      at++;
      val = { v: val.v, pct: true };
    }
    return val;
  }

  function unary(): Val | null {
    if (isOp(peek(), "-", "+")) {
      const neg = (toks[at++] as { v: string }).v === "-";
      const u = unary();
      return u && { v: neg ? -u.v : u.v, pct: u.pct };
    }
    return primary();
  }

  function term(): Val | null {
    let left = unary();
    while (left && isOp(peek(), "*", "/")) {
      const op = (toks[at++] as { v: string }).v;
      const right = unary();
      if (!right) return null;
      // A percentage inside a product is the fraction it names.
      const l = left.pct ? left.v / 100 : left.v;
      const r = right.pct ? right.v / 100 : right.v;
      if (op === "/" && r === 0) return null;
      left = { v: op === "*" ? l * r : l / r, pct: false };
    }
    return left;
  }

  function expr(): Val | null {
    let left = term();
    while (left && isOp(peek(), "+", "-")) {
      const op = (toks[at++] as { v: string }).v;
      const right = term();
      if (!right || left.pct) return null;
      // After + or −, a percentage is a share of what came before.
      const r = right.pct ? (left.v * right.v) / 100 : right.v;
      left = { v: op === "+" ? left.v + r : left.v - r, pct: false };
    }
    return left;
  }

  const result = expr();
  if (!result || result.pct || at !== toks.length || !Number.isFinite(result.v)) return null;
  // Rounded once, to the cent, half away from zero. toFixed first so a float
  // like 1.005 * 100 = 100.49999… lands on the cent it was written as.
  const raw = Number((Math.abs(result.v) * 100).toFixed(6));
  const cents = Math.round(raw);
  if (!Number.isSafeInteger(cents)) return null;
  return result.v < 0 && cents !== 0 ? -cents : cents;
}
