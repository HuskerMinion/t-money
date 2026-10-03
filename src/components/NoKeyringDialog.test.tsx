// No keyring running: say so, and let the person keep a key themselves —
// but only once they say they have saved it.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn().mockResolvedValue(null) }));

import NoKeyringDialog, { keyFileText, newMasterKey } from "./NoKeyringDialog";
import { keyFromPaste } from "./KeyPromptDialog";
import { keyProblem, noKeyring, withoutSentinel } from "../lib/keyError";

describe("a key the person keeps", () => {
  it("is 64 hex characters, new each time, and the key box reads its file back", () => {
    const a = newMasterKey();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(newMasterKey()).not.toBe(a);
    expect(keyFromPaste(keyFileText(a))).toBe(a);
  });
});

describe("the error tokens", () => {
  it("tell no keyring apart, alone or with NEEDS_KEY", () => {
    const create = "NO_KEYRING: no keyring is running on this computer";
    const open = "NEEDS_KEY: NO_KEYRING: Money needs its master key typed in";
    expect([noKeyring(create), keyProblem(create)]).toEqual([true, null]);
    expect([noKeyring(open), keyProblem(open)]).toEqual([true, "needs"]);
    expect(noKeyring("NEEDS_KEY: Money was not created on this computer")).toBe(false);
    expect(withoutSentinel(open)).toBe("Money needs its master key typed in");
  });
});

describe("the words for each platform's key store", () => {
  it("send a Mac to the Keychain, Windows to Credential Manager, Linux to a keyring", async () => {
    const { keyStoreWords, platform } = await import("../lib/keyStore");
    expect(platform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15")).toBe("mac");
    expect(platform("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/140")).toBe("windows");
    expect(platform("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15")).toBe("linux");
    expect(keyStoreWords("mac").fix).toMatch(/unlock/i);
    expect(keyStoreWords("mac").fix).not.toMatch(/GNOME/);
    expect(keyStoreWords("windows").title).toMatch(/Credential Manager/);
    expect(keyStoreWords("linux").fix).toMatch(/GNOME Keyring or KWallet/);
  });
});

describe("NoKeyringDialog", () => {
  it("explains the fix, and creates with a kept key only once it is saved", () => {
    const onCreate = vi.fn();
    render(<NoKeyringDialog fileName="Household" onCreate={onCreate} onCancel={vi.fn()} />);
    expect(screen.getByText(/GNOME Keyring or KWallet/)).toBeInTheDocument();
    // The key is not shown until asked for.
    expect(screen.queryByLabelText("New master key")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Keep the key myself instead…" }));
    const key = (screen.getByLabelText("New master key") as HTMLInputElement).value;
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const create = screen.getByRole("button", { name: "Create Household" });
    expect(create).toBeDisabled();
    fireEvent.click(screen.getByLabelText("I have saved this key somewhere safe."));
    fireEvent.click(create);
    expect(onCreate).toHaveBeenCalledWith(key);
  });
});
