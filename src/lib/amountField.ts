// The amount boxes that take a sum (amountMath.ts) show its result once you
// leave the box or press Enter: type "12.99*4", Tab, and the box says 51.96.
//
// One listener for the whole app rather than a handler in each of the forms:
// an amount box opts in with a `data-amount` attribute and nothing else. The
// result goes in the way typing does (the input's own value setter, then an
// `input` event), so the form's onChange sees it like any other keystroke.
// A form that saves on that same Enter reads the sum through
// `parseMoneyToCents` anyway, so the order never matters.
//
// Only marked boxes: a payee of "7-11" or a memo of "1/2 of dinner" is text.
import { formatAmountTyped, parseMoneyToCents } from "./format";
import { looksLikeSum } from "./amountMath";

export const AMOUNT_FIELD = "input[data-amount]";

/** Is this a box that takes a sum and can be written to now? */
export function isAmountField(el: unknown): el is HTMLInputElement {
  return el instanceof HTMLInputElement && el.matches(AMOUNT_FIELD) && !el.readOnly && !el.disabled;
}

/** Put `text` in a React-controlled input as if it had been typed. */
export function typeInto(el: HTMLInputElement, text: string): void {
  if (el.value === text) return;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter) setter.call(el, text);
  else el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Replace a sum in the box with its result. Returns whether it did. Text
 *  that is not a sum, or a sum that does not work out, is left for the form
 *  to refuse in its own words. */
export function settleAmountField(el: HTMLInputElement): boolean {
  if (!isAmountField(el) || !looksLikeSum(el.value)) return false;
  const cents = parseMoneyToCents(el.value);
  if (cents === null) return false;
  typeInto(el, formatAmountTyped(cents));
  return true;
}

/** Listen app-wide; returns the function that stops. Capture phase, so the
 *  box shows the result before the form's own Enter handler runs. */
export function installAmountMath(target: Window = window): () => void {
  const onLeave = (e: FocusEvent) => {
    if (isAmountField(e.target)) settleAmountField(e.target);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.altKey && !e.ctrlKey && !e.metaKey && isAmountField(e.target)) settleAmountField(e.target);
  };
  target.addEventListener("focusout", onLeave, true);
  target.addEventListener("keydown", onKey, true);
  return () => {
    target.removeEventListener("focusout", onLeave, true);
    target.removeEventListener("keydown", onKey, true);
  };
}
