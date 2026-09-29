// The key box, and the paste it has to survive.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import KeyPromptDialog, { keyFromPaste } from "./KeyPromptDialog";

const KEY = "6f3a9c1d4e2b8a7f0c5d3e1a9b7c5d3f2e1a9b7c5d3f2e1a9b7c5d3f2e1a9b7c";

/** Exactly what Settings → Save master key writes, CRLFs and all. */
const KEY_FILE =
  "T-Money master key\r\n\r\n" +
  `${KEY}\r\n\r\n` +
  "This key decrypts your T-Money database and every backup of it.\r\n" +
  "Without it those files cannot be opened by anyone, including you.\r\n" +
  "Keep it somewhere separate from the backups themselves.\r\n";

describe("keyFromPaste", () => {
  it("takes a bare key", () => {
    expect(keyFromPaste(KEY)).toBe(KEY);
  });

  // The case this function exists for: the app told you to save a key file,
  // so the realistic paste is the whole key file.
  it("finds the key inside the file the app told you to save", () => {
    expect(keyFromPaste(KEY_FILE)).toBe(KEY);
  });

  it("survives the whitespace a copy picks up", () => {
    expect(keyFromPaste(`  ${KEY}\n`)).toBe(KEY);
    expect(keyFromPaste(`\r\n${KEY}\r\n`)).toBe(KEY);
  });

  it("normalizes case — the same 32 bytes either way", () => {
    expect(keyFromPaste(KEY.toUpperCase())).toBe(KEY);
  });

  it("refuses anything that is not a 64-character key", () => {
    expect(keyFromPaste("")).toBeNull();
    expect(keyFromPaste("not a key at all")).toBeNull();
    // One character short, and one too long — both must fail, or a truncated
    // paste would be sent to the backend and come back as "wrong key".
    expect(keyFromPaste(KEY.slice(0, 63))).toBeNull();
    expect(keyFromPaste(`${KEY}0`)).toBeNull();
    // Right length, not hex.
    expect(keyFromPaste("z".repeat(64))).toBeNull();
  });
});

describe("KeyPromptDialog", () => {
  const props = {
    fileName: "Maple Street",
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
  };

  it("names the file it is asking about, in the message and on the button", () => {
    render(<KeyPromptDialog {...props} />);
    const d = screen.getByRole("dialog", { name: "Master key needed" });
    // Pinned to the <strong> in the sentence. The confirm button says the
    // file's name too — on purpose, it is how the direction is stated — so a
    // bare substring match finds two elements and throws.
    expect(within(d).getByText("Maple Street", { selector: "strong" })).toBeInTheDocument();
    expect(within(d).getByRole("button", { name: "Open Maple Street" })).toBeInTheDocument();
  });

  it("will not submit until there is a key to submit", async () => {
    render(<KeyPromptDialog {...props} />);
    const d = screen.getByRole("dialog", { name: "Master key needed" });
    expect(within(d).getByRole("button", { name: "Open Maple Street" })).toBeDisabled();

    await userEvent.type(within(d).getByLabelText("Master key"), "nowhere near a key");
    expect(within(d).getByRole("button", { name: "Open Maple Street" })).toBeDisabled();
    expect(within(d).getByText(/No 64-character key in that/)).toBeInTheDocument();
  });

  it("takes the whole key file and hands back just the key", async () => {
    const onSubmit = vi.fn();
    render(<KeyPromptDialog {...props} onSubmit={onSubmit} />);
    const d = screen.getByRole("dialog", { name: "Master key needed" });

    // paste, not type — 300-odd characters through userEvent.type is slow and
    // is not what a person does with a key file anyway.
    await userEvent.click(within(d).getByLabelText("Master key"));
    await userEvent.paste(KEY_FILE);

    expect(within(d).getByText(/Found a key ending/)).toBeInTheDocument();
    await userEvent.click(within(d).getByRole("button", { name: "Open Maple Street" }));
    expect(onSubmit).toHaveBeenCalledWith(KEY);
  });

  it("says so when a key was already tried and refused", () => {
    render(<KeyPromptDialog {...props} wrongKey />);
    const d = screen.getByRole("dialog", { name: "Master key needed" });
    expect(within(d).getByRole("alert")).toHaveTextContent(/does not open this file/);
  });

  it("does not shout about a wrong key before one has been tried", () => {
    render(<KeyPromptDialog {...props} />);
    const d = screen.getByRole("dialog", { name: "Master key needed" });
    expect(within(d).queryByRole("alert")).toBeNull();
  });

  it("cancels", async () => {
    const onCancel = vi.fn();
    render(<KeyPromptDialog {...props} onCancel={onCancel} />);
    const d = screen.getByRole("dialog", { name: "Master key needed" });
    await userEvent.click(within(d).getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });
});
