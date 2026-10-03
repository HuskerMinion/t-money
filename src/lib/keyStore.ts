// What this computer calls the place T-Money keeps its keys, and what to do
// when it cannot be reached. Windows has Credential Manager and macOS the
// Keychain, and both are always there — unreachable means locked or broken,
// rarely. Linux has a keyring on GNOME and KDE desktops but not on every
// system, and there the fix is to start one.

export interface KeyStoreWords {
  /** "the Keychain", "Credential Manager", "a keyring" — as it reads mid-sentence. */
  name: string;
  /** The dialog's title when it cannot be reached. */
  title: string;
  /** Why the key could not be kept, after "T-Money keeps each file's key in …". */
  missing: string;
  /** The usual fix. */
  fix: string;
}

export type Platform = "mac" | "windows" | "linux";

/** The platform the app is running on, from the web view's own report. */
export function platform(ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent): Platform {
  if (/Mac OS X|Macintosh/i.test(ua)) return "mac";
  if (/Windows/i.test(ua)) return "windows";
  return "linux";
}

export function keyStoreWords(p: Platform = platform()): KeyStoreWords {
  switch (p) {
    case "mac":
      return {
        name: "the Keychain",
        title: "The Keychain can't be reached",
        missing: "the macOS Keychain, and it can't be reached right now — it may be locked",
        fix: "The usual fix: unlock it (open Keychain Access, or sign out and back in), then try again and T-Money will keep the key there.",
      };
    case "windows":
      return {
        name: "Credential Manager",
        title: "Credential Manager can't be reached",
        missing: "Windows Credential Manager, and it can't be reached right now",
        fix: "The usual fix: sign out of Windows and back in, then try again and T-Money will keep the key there.",
      };
    default:
      return {
        name: "a keyring",
        title: "No keyring is running",
        missing: "this computer's keyring, and no keyring is running",
        fix: "The usual fix: start or install one. GNOME Keyring or KWallet comes with most Linux desktops; once it is running, try again and T-Money will keep the key there.",
      };
  }
}
