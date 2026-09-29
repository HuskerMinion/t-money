// Settings panes that failed in silence: the rounding and price-timer
// choices had no status line, and "Change folder…" turned a switched-off
// daily backup back on.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));
const dialog = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: dialog.open, save: dialog.save }));

import SettingsView, { aimSettingsAt } from "./SettingsView";
import { invokeCalls, resetIpc, setIpcHandlers, type IpcHandler } from "../test/tauriMock";

const CFG = { enabled: false, on_exit: false, folder: "D:\\Old", keep: 10, last_at: null, existing: [] };
const PRICES = { with_symbol: 3, newest_date: "2026-09-14", oldest_date: "2026-09-10", never_priced: 0, last_auto: null, interval: "off" };

function stub(over: Record<string, IpcHandler> = {}) {
  setIpcHandlers({
    get_db_info: () => ({ db_path: "C:\\db", size_bytes: 1024, has_key: true }),
    get_key_status: () => ({ has_key: true, source: "keyring" }),
    get_backup_config: () => CFG,
    get_ui_setting: () => null,
    price_status: () => PRICES,
    get_all_accounts: () => [],
    list_categories: () => [],
    list_payees: () => [],
    ...over,
  });
}

beforeEach(() => {
  resetIpc();
  dialog.open.mockReset();
  stub();
});

describe("The Money panes say what happened", () => {
  it("a refused rounding puts the select back and shows the refusal", async () => {
    stub({
      set_ui_setting: () => {
        throw "the file is read-only";
      },
    });
    aimSettingsAt("money", "holdings");
    render(<SettingsView />);
    const select = screen.getByLabelText("Holding value rounding") as HTMLSelectElement;
    await userEvent.selectOptions(select, "down");
    expect(await screen.findByRole("alert")).toHaveTextContent("the file is read-only");
    expect(select.value).toBe("nearest");
  });

  it("a refused price interval is shown on the Prices pane, which counts securities in plain English", async () => {
    stub({
      set_ui_setting: () => {
        throw "the file is read-only";
      },
    });
    aimSettingsAt("money", "prices");
    render(<SettingsView />);
    expect(await screen.findByText(/3 securities with a symbol/)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("How often to update prices"), "daily");
    expect(await screen.findByRole("alert")).toHaveTextContent("the file is read-only");
    expect((screen.getByLabelText("How often to update prices") as HTMLSelectElement).value).toBe("off");
  });
});

describe("Change folder… keeps the backup switch where it was", () => {
  it("moving the folder does not turn a switched-off daily backup back on", async () => {
    stub({ set_backup_config: (args) => ({ ...CFG, enabled: args.enabled, folder: args.folder }) });
    dialog.open.mockResolvedValue("E:\\New");
    aimSettingsAt("file", "backup");
    render(<SettingsView />);
    await userEvent.click(await screen.findByRole("button", { name: "Change folder…" }));
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "set_backup_config")).toBe(true));
    expect(invokeCalls.find((c) => c.cmd === "set_backup_config")!.args).toMatchObject({ enabled: false, folder: "E:\\New" });
  });
});
