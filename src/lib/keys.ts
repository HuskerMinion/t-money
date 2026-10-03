// Shortcuts written the way this computer's keyboard reads them.
//
// T-Money's text says "Ctrl+Z", because that is what Money said and what a
// Windows or Linux keyboard has. On a Mac the same shortcut is ⌘Z (the app
// accepts either key — `accelMatches`), Redo is ⇧⌘Z, and the app quits with
// ⌘Q. One function, applied where text is shown, rather than a second copy of
// every sentence.
import { platform, type Platform } from "./keyStore";

export function keys(text: string, p: Platform = platform()): string {
  if (p !== "mac") return text;
  return text
    .replace(/Tools → Settings…/g, "T-Money → Settings…")
    .replace(/Ctrl\+Y\b/g, "⇧⌘Z")
    .replace(/Alt\+F4\b/g, "⌘Q")
    .replace(/Ctrl\+Shift\+/g, "⇧⌘")
    .replace(/Ctrl\+Alt\+/g, "⌥⌘")
    .replace(/Ctrl\+/g, "⌘");
}
