// §170 — the attachments panel: lists what is attached, adds through the
// file dialog and a path handed to Rust, opens, saves a copy, removes.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));
const dialog = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: dialog.open, save: dialog.save }));

import AttachmentsPanel, { kindLabel, sizeLabel } from "./AttachmentsPanel";
import { invokeCalls, resetIpc, setIpcHandlers } from "../test/tauriMock";
import type { Attachment } from "../lib/types";

const receipt: Attachment = { id: "at-1", transaction_id: "t-1", account_id: null, name: "receipt.pdf", mime: "application/pdf", size_bytes: 48_213, added_at: "2026-09-13T10:00:00" };
const photo: Attachment = { id: "at-2", transaction_id: "t-1", account_id: null, name: "check.jpg", mime: "image/jpeg", size_bytes: 3_400_000, added_at: "2026-09-13T10:01:00" };

describe("labels", () => {
  it("sizes read as a person would say them", () => {
    expect(sizeLabel(900)).toBe("900 B");
    expect(sizeLabel(48_213)).toBe("47 KB");
    expect(sizeLabel(3_400_000)).toBe("3.2 MB");
    expect(sizeLabel(25 * 1024 * 1024)).toBe("25 MB");
  });
  it("kinds come from the type", () => {
    expect(kindLabel("application/pdf")).toBe("PDF");
    expect(kindLabel("image/jpeg")).toBe("Image");
    expect(kindLabel("application/octet-stream")).toBe("File");
  });
});

describe("AttachmentsPanel (§170)", () => {
  beforeEach(() => {
    resetIpc();
    dialog.open.mockReset();
    dialog.save.mockReset();
  });

  it("lists what is attached, opens one, and saves a copy where the dialog says", async () => {
    setIpcHandlers({
      list_attachments: () => [receipt, photo],
      open_attachment: () => "C:\\Temp\\t-money\\attachments\\at-1\\receipt.pdf",
      save_attachment: () => undefined,
    });
    render(<AttachmentsPanel transactionId="t-1" />);
    const table = await screen.findByRole("table", { name: "Attached files" });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(table.textContent).toContain("receipt.pdf");
    expect(table.textContent).toContain("PDF");
    expect(table.textContent).toContain("47 KB");
    expect(invokeCalls.find((c) => c.cmd === "list_attachments")!.args).toEqual({ transactionId: "t-1", accountId: null });

    await userEvent.click(screen.getByRole("button", { name: "Open receipt.pdf" }));
    expect(invokeCalls.find((c) => c.cmd === "open_attachment")!.args).toEqual({ id: "at-1" });

    dialog.save.mockResolvedValue("C:\\Users\\me\\Desktop\\receipt.pdf");
    await userEvent.click(screen.getByRole("button", { name: "Save a copy of receipt.pdf" }));
    await waitFor(() => expect(invokeCalls.find((c) => c.cmd === "save_attachment")!.args).toEqual({ id: "at-1", path: "C:\\Users\\me\\Desktop\\receipt.pdf" }));
  });

  it("attaches every file picked, by path, and tells the owner the new count", async () => {
    let list: Attachment[] = [];
    setIpcHandlers({
      list_attachments: () => list,
      add_attachment: (args) => {
        const a = { ...receipt, id: `at-${list.length + 1}`, name: String(args.path).split("\\").pop()! };
        list = [...list, a];
        return a;
      },
    });
    const onChanged = vi.fn();
    render(<AttachmentsPanel transactionId="t-1" onChanged={onChanged} />);
    await screen.findByText(/Nothing attached yet/);
    dialog.open.mockResolvedValue(["C:\\scans\\a.pdf", "C:\\scans\\b.pdf"]);
    await userEvent.click(screen.getByRole("button", { name: "Attach a file…" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(2));
    const adds = invokeCalls.filter((c) => c.cmd === "add_attachment").map((c) => c.args);
    expect(adds).toEqual([
      { transactionId: "t-1", accountId: null, path: "C:\\scans\\a.pdf" },
      { transactionId: "t-1", accountId: null, path: "C:\\scans\\b.pdf" },
    ]);
    expect((await screen.findByRole("table", { name: "Attached files" })).textContent).toContain("b.pdf");
  });

  it("removes one and reports the count; an account's list is keyed by account", async () => {
    let list: Attachment[] = [{ ...receipt, transaction_id: null, account_id: "a-1", name: "statement.pdf" }];
    setIpcHandlers({
      list_attachments: () => list,
      remove_attachment: () => {
        list = [];
        return undefined;
      },
    });
    const onChanged = vi.fn();
    render(<AttachmentsPanel accountId="a-1" onChanged={onChanged} />);
    await screen.findByText("statement.pdf");
    expect(invokeCalls.find((c) => c.cmd === "list_attachments")!.args).toEqual({ transactionId: null, accountId: "a-1" });
    await userEvent.click(screen.getByRole("button", { name: "Remove statement.pdf" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(0));
    expect(invokeCalls.find((c) => c.cmd === "remove_attachment")!.args).toEqual({ id: "at-1" });
    await screen.findByText(/Nothing attached yet/);
  });

  it("shows the backend's refusal", async () => {
    setIpcHandlers({
      list_attachments: () => [],
      add_attachment: () => {
        throw new Error("big.iso is 700 MB; attachments are limited to 25 MB");
      },
    });
    render(<AttachmentsPanel transactionId="t-1" />);
    await screen.findByText(/Nothing attached yet/);
    dialog.open.mockResolvedValue("C:\\big.iso");
    await userEvent.click(screen.getByRole("button", { name: "Attach a file…" }));
    await screen.findByText(/limited to 25 MB/);
  });
});

describe("§183 — attachments and the Edit menu, and a partial add", () => {
  beforeEach(() => {
    resetIpc();
    dialog.open.mockReset();
  });

  it("asks for the undo label after an add and a remove", async () => {
    let list: Attachment[] = [];
    setIpcHandlers({
      list_attachments: () => list,
      add_attachment: () => {
        list = [receipt];
        return receipt;
      },
      remove_attachment: () => {
        list = [];
        return undefined;
      },
      undo_status: () => ({ undo: "attach a file", redo: null }),
    });
    render(<AttachmentsPanel transactionId="t-1" />);
    await screen.findByText(/Nothing attached yet/);
    dialog.open.mockResolvedValue("C:\\scans\\receipt.pdf");
    await userEvent.click(screen.getByRole("button", { name: "Attach a file…" }));
    await screen.findByText("receipt.pdf");
    await waitFor(() => expect(invokeCalls.filter((c) => c.cmd === "undo_status").length).toBe(1));
    await userEvent.click(screen.getByRole("button", { name: "Remove receipt.pdf" }));
    await screen.findByText(/Nothing attached yet/);
    await waitFor(() => expect(invokeCalls.filter((c) => c.cmd === "undo_status").length).toBe(2));
  });

  it("when the second of two files is refused, the owner still hears about the first", async () => {
    let list: Attachment[] = [];
    setIpcHandlers({
      list_attachments: () => list,
      add_attachment: (args) => {
        if (String(args.path).endsWith("big.iso")) throw "big.iso is 700 MB; attachments are limited to 25 MB";
        list = [receipt];
        return receipt;
      },
    });
    const onChanged = vi.fn();
    render(<AttachmentsPanel transactionId="t-1" onChanged={onChanged} />);
    await screen.findByText(/Nothing attached yet/);
    dialog.open.mockResolvedValue(["C:\\scans\\receipt.pdf", "C:\\big.iso"]);
    await userEvent.click(screen.getByRole("button", { name: "Attach a file…" }));
    await screen.findByText(/limited to 25 MB/);
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(1));
    expect(screen.getByText("receipt.pdf")).toBeInTheDocument();
  });

  it("a list that cannot be read after a refusal does not tell the owner there is nothing", async () => {
    let fail = false;
    setIpcHandlers({
      list_attachments: () => {
        if (fail) throw "database is locked";
        return [receipt];
      },
      remove_attachment: () => {
        fail = true;
        throw "database is locked";
      },
    });
    const onChanged = vi.fn();
    render(<AttachmentsPanel transactionId="t-1" onChanged={onChanged} />);
    await screen.findByText("receipt.pdf");
    await userEvent.click(screen.getByRole("button", { name: "Remove receipt.pdf" }));
    await screen.findByText(/database is locked/);
    expect(onChanged).not.toHaveBeenCalled();
  });
});
