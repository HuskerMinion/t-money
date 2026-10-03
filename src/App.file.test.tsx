// @vitest-environment jsdom
// Opening a file must not leave the window blank.
//
// The reported failure: File → New created the file correctly and left a white
// window with no menu, recoverable only by closing it. There was no error
// boundary in the app at all, so any thrown render anywhere produced exactly
// that. These lock down both halves — the boundary that keeps the window, and
// the swap that stops anything being asked to draw a file that is gone.
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("./test/tauriMock"));
const savePicked = vi.fn();
const openPicked = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: () => openPicked(),
  save: () => savePicked(),
}));
const setTitle = vi.fn().mockResolvedValue(undefined);
const eventHandlers = new Map<string, (e: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (e: { payload: unknown }) => void) => {
    eventHandlers.set(name, cb);
    return Promise.resolve(() => eventHandlers.delete(name));
  },
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ close: vi.fn(), setTitle: (t: string) => setTitle(t) }),
}));

import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { runCommand } from "./lib/commands";
import { useAccountStore } from "./stores/useAccountStore";
import { useFileFormat } from "./lib/region";
import { invokeCalls, resetIpc, setIpcHandlers } from "./test/tauriMock";

const acct = {
  id: "acc-1",
  name: "Everyday Checking 1234",
  type: "checking",
  balance_cents: 150000,
  holdings_value_cents: 0,
  tax_included: true,
  is_favorite: true,
  is_closed: false,
  updated_at: "2026-09-01T00:00:00Z",
  institution: null,
  account_number: null,
  routing_number: null,
  opened_on: null,
  credit_limit_cents: null,
  contact_phone: null,
  contact_email: null,
  website: null,
  address: null,
  account_notes: null,
};

const registerRow = {
  id: "t-1",
  date: "2026-09-01",
  payee: "Kroger",
  category_name: "Food",
  category_id: "c-1",
  transfer_account_id: null,
  amount_cents: -4250,
  running_balance_cents: 145750,
  is_reconciled: false,
  cleared_state: "",
  check_number: null,
  is_void: false,
  notes: null,
  transfer_account_name: null,
  activity: null,
  security_id: null,
  security_name: null,
  shares_micro: null,
  price_micro: null,
  gross_cents: null,
  commission_cents: 0,
  lot_specified: false,
  goal_id: null,
  goal_name: null,
};

/** The new file is empty; the old one has an account, a report and spending. */
let swapped = false;
let openFails = false;
/** Whether the app is on its own database, which is what decides
 *  File → Close. */
let onOwnFile = true;
/** Whether File → Close has left the app with no file open. */
let closed = false;
/** The open file's home currency and region. */
let fileFormat = { home_currency: "USD", region: "en-US" };
/** What the price timer sees. Off by default, as in the app. */
let priceStatus: Record<string, unknown> = {
  with_symbol: 0,
  newest_date: null,
  oldest_date: null,
  never_priced: 0,
  last_auto: null,
  interval: "off",
};

function stub() {
  setIpcHandlers(
    new Proxy({} as Record<string, () => unknown>, {
      get: (_t, cmd: string) => () => {
        if (cmd === "open_file") {
          if (openFails) throw new Error("there is no key stored for New.tmny");
          swapped = true;
          closed = false;
          return { path: "E:\\New.tmny", name: "New", isDefault: false, scratch: false, isOpen: true };
        }
        if (cmd === "get_file_format") {
          if (closed) throw new Error("NO_FILE: no file is open");
          return fileFormat;
        }
        if (cmd === "set_home_currency") return (fileFormat = { ...fileFormat, home_currency: "EUR" });
        if (cmd === "set_region") return (fileFormat = { ...fileFormat, region: "de-DE" });
        if (cmd === "current_file")
          return { path: "E:\\x.tmny", name: swapped ? "New" : "Sam", isDefault: onOwnFile, scratch: false, isOpen: !closed };
        if (cmd === "close_file") {
          // The file is CLOSED. `path`/`name` are what was open, so
          // the start screen can offer it back.
          closed = true;
          return { path: "E:\\x.tmny", name: "Sam", isDefault: onOwnFile, scratch: false, isOpen: false };
        }
        if (cmd === "run_report")
          return { kind: "spending_by_category", title: "Spending", subtitle: "", columns: [], rows: [], chart: null };
        if (cmd === "get_all_accounts" || cmd === "get_favorite_accounts") return swapped ? [] : [acct];
        if (cmd === "get_register") {
          if (swapped) throw new Error("no such account in this file");
          return [registerRow];
        }
        if (cmd === "list_saved_reports")
          return swapped ? [] : [{ id: "r-1", name: "By Category - Sam", kind: "spending_by_category" }];
        if (cmd === "get_spending_summary")
          return swapped ? [] : [{ category_id: "c-1", category_name: "Food", spent_cents: 4250, target_cents: 0 }];
        // Both answer as Rust does: nothing with no file open (NO_FILE), and
        // an automatic fetch stamps `last_auto`, so the next check is not due.
        if (cmd === "price_status") {
          if (closed) throw new Error("NO_FILE: no file is open");
          return priceStatus;
        }
        if (cmd === "refresh_investment_prices") {
          priceStatus = { ...priceStatus, last_auto: new Date().toISOString() };
          return { fetched: 2, failed: [] };
        }
        if (cmd === "get_db_info") return { db_path: "C:\\db", size_bytes: 1024, has_key: true };
        if (cmd === "get_key_status") return { has_key: true, source: "keyring" };
        if (cmd === "undo_status") return { undo: null, redo: null };
        if (cmd === "get_open_statement" || cmd === "get_last_statement") return null;
        if (cmd === "list_reports") return [];
        return [];
      },
      has: () => true,
    })
  );
}

beforeEach(() => {
  resetIpc();
  swapped = false;
  openFails = false;
  onOwnFile = true;
  closed = false;
  fileFormat = { home_currency: "USD", region: "en-US" };
  priceStatus = { with_symbol: 0, newest_date: null, oldest_date: null, never_priced: 0, last_auto: null, interval: "off" };
  setTitle.mockClear();
  stub();
  window.localStorage.clear();
});

describe("opening a file from inside the app", () => {
  async function newFileFromTheRegister() {
    savePicked.mockResolvedValue("E:\\New.tmny");
    render(<App />);
    await screen.findByRole("menubar", { name: "Main menu" });
    // Be where a user is when they reach for File → New: inside a register,
    // on an account that is about to stop existing.
    await useAccountStore.getState().selectAccount("acc-1");
    await act(async () => {
      runCommand("file.new");
    });
    await userEvent.click(await screen.findByRole("button", { name: "Create file" }));
  }

  it("keeps the app on screen — menu, header and all", async () => {
    await newFileFromTheRegister();
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "open_file")).toBe(true));
    // The whole point: a menu bar is still there afterwards.
    expect(screen.getByRole("menubar", { name: "Main menu" })).toBeInTheDocument();
    await waitFor(() => expect(useAccountStore.getState().selectedAccountId).toBeNull());
  });

  it("lets go of the old account BEFORE the file changes underneath it", async () => {
    await newFileFromTheRegister();
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "open_file")).toBe(true));
    const swap = invokeCalls.findIndex((c) => c.cmd === "open_file");
    // No register read for the old account can appear after the swap — that
    // is a screen drawing a file that is no longer open.
    const lateRegister = invokeCalls
      .slice(swap)
      .filter((c) => c.cmd === "get_register" && (c.args as { accountId?: string })?.accountId === "acc-1");
    expect(lateRegister).toEqual([]);
  });

  it("re-reads everything that lives IN the file", async () => {
    await newFileFromTheRegister();
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "open_file")).toBe(true));
    const swap = invokeCalls.findIndex((c) => c.cmd === "open_file");
    const after = invokeCalls.slice(swap).map((c) => c.cmd);
    // Accounts were always reloaded; saved reports and the spending summary
    // were not, so the Favorites menu listed the previous file's reports and
    // Home showed the previous file's spending.
    await waitFor(() => expect(after.length).toBeGreaterThan(0));
    for (const cmd of ["get_all_accounts", "list_saved_reports", "get_spending_summary"]) {
      await waitFor(() =>
        expect(invokeCalls.slice(swap).some((c) => c.cmd === cmd)).toBe(true)
      );
    }
  });

  it("a file it cannot open leaves the one you had open, loaded", async () => {
    openFails = true;
    await newFileFromTheRegister();
    // The message is shown and the old file's accounts come back — an app
    // that empties itself on a failed open looks exactly like data loss.
    await waitFor(() => expect(useAccountStore.getState().accounts).toHaveLength(1));
    expect(screen.getByRole("menubar", { name: "Main menu" })).toBeInTheDocument();
  });
});

describe("closing and remounting", () => {
  it("remounts what is on screen, so no widget keeps the old file's data", async () => {
    // Reported: a new, empty file opened still showing the previous file's
    // Subscriptions, which vanished the moment you clicked another tab and
    // came back. Everything under <main> is keyed on an epoch; the swap set
    // the tab without bumping it, so widgets that fetch their own data were
    // never thrown away. The observable consequence is that they fetch
    // AGAIN after the swap.
    savePicked.mockResolvedValue("E:\\New.tmny");
    render(<App />);
    await screen.findByRole("menubar", { name: "Main menu" });
    await act(async () => {
      runCommand("file.new");
    });
    await userEvent.click(await screen.findByRole("button", { name: "Create file" }));
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "open_file")).toBe(true));
    const swap = invokeCalls.findIndex((c) => c.cmd === "open_file");
    // The Home widgets run reports; a remount is what makes them ask again.
    await waitFor(() =>
      expect(invokeCalls.slice(swap).some((c) => c.cmd === "run_report")).toBe(true)
    );
  });

  it("File → Close is available on the app's own file too", async () => {
    // An earlier version grayed this out on T-Money's own database, because Close meant
    // "go back to it". Now Close means closed, and closing the app's own
    // file is exactly as meaningful as closing any other.
    onOwnFile = true;
    render(<App />);
    await screen.findByRole("menubar", { name: "Main menu" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("menuitem", { name: "File" }));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Close file" })).toBeEnabled());
  });

  it("closing leaves NO file open, and the start screen instead of the shell", async () => {
    // The bug this replaces: a user had the same accounts in their own file and
    // in the app's, so the old Close swapped one for the other and the screen
    // looked identical. Close has to be visible.
    onOwnFile = false;
    render(<App />);
    await screen.findByRole("menubar", { name: "Main menu" });
    await act(async () => {
      runCommand("file.close");
    });
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "close_file")).toBe(true));

    // The shell is gone — no rail, no tabs — and the start screen is what is
    // left, offering the file back by name.
    expect(await screen.findByRole("region", { name: "No file open" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Reopen “Sam”/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reports" })).not.toBeInTheDocument();
    await waitFor(() => expect(setTitle).toHaveBeenCalledWith("T-Money — no file open"));

    // And nothing asks the database anything afterwards: there is nothing to
    // ask. A shell that kept querying would fill the screen with NO_FILE.
    const at = invokeCalls.findIndex((c) => c.cmd === "close_file");
    const after = invokeCalls.slice(at + 1).map((c) => c.cmd);
    expect(after.filter((c) => c === "get_all_accounts" || c === "run_report" || c === "get_register")).toEqual([]);
  });

  it("the start screen opens a recent file, and puts the app back", async () => {
    onOwnFile = false;
    render(<App />);
    await screen.findByRole("menubar", { name: "Main menu" });
    await act(async () => {
      runCommand("file.close");
    });
    const reopen = await screen.findByRole("button", { name: /Reopen “Sam”/ });
    await act(async () => {
      reopen.click();
    });
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "open_file")).toBe(true));
    // Back to the shell, and the accounts are loaded from the file.
    await waitFor(() => expect(screen.queryByRole("region", { name: "No file open" })).not.toBeInTheDocument());
  });
});

describe("the file's home currency and region", () => {
  it("File → New asks for both, and sets them on the new file before anything is read", async () => {
    savePicked.mockResolvedValue("E:\Haushalt.tmny");
    render(<App />);
    await screen.findByRole("menubar", { name: "Main menu" });
    await act(async () => {
      runCommand("file.new");
    });
    const dialog = await screen.findByRole("dialog", { name: "New file" });
    expect(dialog).toHaveTextContent("Haushalt");
    // Nothing is made until the dialog is answered.
    expect(invokeCalls.some((c) => c.cmd === "open_file")).toBe(false);
    // The region follows the currency until it is picked by hand.
    await userEvent.selectOptions(screen.getByLabelText("Home currency"), "EUR");
    expect((screen.getByLabelText("Region") as HTMLSelectElement).value).toBe("de-DE");
    await userEvent.selectOptions(screen.getByLabelText("Region"), "de-DE");
    expect(screen.getByLabelText("Region preview")).toHaveTextContent("1.234,56 €");
    await userEvent.click(screen.getByRole("button", { name: "Create file" }));
    await waitFor(() => expect(useFileFormat.getState().region.code).toBe("de-DE"));
    await waitFor(() =>
      expect(invokeCalls.slice(invokeCalls.findIndex((c) => c.cmd === "set_region")).some((c) => c.cmd === "list_categories")).toBe(true)
    );
    const cmds = invokeCalls.map((c) => c.cmd);
    const open = cmds.indexOf("open_file");
    const home = invokeCalls.findIndex((c) => c.cmd === "set_home_currency");
    expect(open).toBeGreaterThan(-1);
    expect(home).toBeGreaterThan(open);
    expect(invokeCalls[home].args).toEqual({ currency: "EUR", relabel: false });
    expect(invokeCalls.find((c) => c.cmd === "set_region")!.args).toEqual({ region: "de-DE" });
    // Before the accounts of the new file are read.
    // Before the new file is loaded. (Widgets on screen may ask earlier;
    // <main> is keyed on the format, so they are drawn again once it is set.)
    expect(cmds.indexOf("list_categories", open)).toBeGreaterThan(cmds.indexOf("set_region"));
    expect(useFileFormat.getState().home).toBe("EUR");
  });

  it("asks on the start screen too, when no file is open", async () => {
    closed = true;
    onOwnFile = false;
    savePicked.mockResolvedValue("E:\New.tmny");
    render(<App />);
    await screen.findByRole("region", { name: "No file open" });
    await userEvent.click(screen.getByRole("button", { name: /New file/ }));
    expect(await screen.findByRole("dialog", { name: "New file" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Create file" }));
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "open_file")).toBe(true));
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "set_home_currency")).toBe(false));
    await waitFor(() => expect(screen.queryByRole("region", { name: "No file open" })).not.toBeInTheDocument());
  });

  it("Cancel makes no file", async () => {
    savePicked.mockResolvedValue("E:\New.tmny");
    render(<App />);
    await screen.findByRole("menubar", { name: "Main menu" });
    await act(async () => {
      runCommand("file.new");
    });
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "New file" })).not.toBeInTheDocument();
    expect(invokeCalls.some((c) => c.cmd === "open_file")).toBe(false);
  });

  it("the sample file is not asked about", async () => {
    savePicked.mockResolvedValue("E:\Sample.tmny");
    render(<App />);
    await screen.findByRole("menubar", { name: "Main menu" });
    await act(async () => {
      runCommand("file.sample");
    });
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "create_sample_file")).toBe(true));
    expect(screen.queryByRole("dialog", { name: "New file" })).not.toBeInTheDocument();
    expect(invokeCalls.some((c) => c.cmd === "set_home_currency" || c.cmd === "set_region")).toBe(false);
  });

  it("an open file's format is loaded, and closing the file puts the default back", async () => {
    fileFormat = { home_currency: "EUR", region: "de-DE" };
    onOwnFile = false;
    render(<App />);
    await screen.findByRole("menubar", { name: "Main menu" });
    await waitFor(() => expect(useFileFormat.getState().region.code).toBe("de-DE"));
    // The rail draws the balance the file's way.
    expect(await screen.findAllByText(/1\.500,00/)).not.toHaveLength(0);
    await act(async () => {
      runCommand("file.close");
    });
    await screen.findByRole("region", { name: "No file open" });
    expect(useFileFormat.getState().home).toBe("USD");
    expect(useFileFormat.getState().region.code).toBe("en-US");
  });
});

describe("the window title", () => {
  it("names the file you are in, so the taskbar and Alt-Tab say which", async () => {
    onOwnFile = false;
    render(<App />);
    await screen.findByRole("menubar", { name: "Main menu" });
    await waitFor(() => expect(setTitle).toHaveBeenCalledWith("Sam — T-Money"));
  });

  it("says just T-Money on the app's own file, because there is nothing to distinguish", async () => {
    onOwnFile = true;
    render(<App />);
    await screen.findByRole("menubar", { name: "Main menu" });
    await waitFor(() => expect(setTitle).toHaveBeenCalledWith("T-Money"));
  });
});

describe("a second copy handing us its file", () => {
  it("resets to the file the other copy opened, without opening it twice", async () => {
    render(<App />);
    await screen.findByRole("menubar", { name: "Main menu" });
    const before = invokeCalls.filter((c) => c.cmd === "open_file").length;

    // The plugin has already swapped the database in Rust; the event is the
    // frontend's only cue.
    await act(async () => {
      eventHandlers.get("tm://file-opened")?.({
        payload: { ok: true, file: { name: "Testing Money" } },
      });
    });

    await waitFor(() =>
      expect(invokeCalls.some((c) => c.cmd === "get_spending_summary")).toBe(true)
    );
    expect(
      invokeCalls.filter((c) => c.cmd === "open_file").length,
      "the file is already open — opening it again would be a second swap"
    ).toBe(before);
  });

  it("shows the reason in the banner when that file would not open", async () => {
    render(<App />);
    await screen.findByRole("menubar", { name: "Main menu" });
    await act(async () => {
      eventHandlers.get("tm://file-opened")?.({
        payload: { ok: false, error: "no master key for this file is stored on this machine" },
      });
    });
    expect(await screen.findByText(/no master key/)).toBeInTheDocument();
  });

  it("asks for the key when the double-clicked file needs one, without the token", async () => {
    render(<App />);
    await screen.findByRole("menubar", { name: "Main menu" });
    await act(async () => {
      eventHandlers.get("tm://file-opened")?.({
        payload: {
          ok: false,
          path: "/home/sam/Money/Household.tmny",
          error: "NEEDS_KEY: NO_KEYRING: Household needs its master key typed in, because no keyring is running",
        },
      });
    });
    expect(await screen.findByRole("dialog", { name: "Master key needed" })).toBeInTheDocument();
    expect(screen.getByText(/Paste the key you saved when you made this file/)).toBeInTheDocument();
    expect(screen.queryByText(/NEEDS_KEY|NO_KEYRING/)).toBeNull();
  });
});

describe("the error boundary", () => {
  function Bang(): JSX.Element {
    throw new Error("holdings_value_cents of undefined");
  }

  it("shows what happened instead of a blank window", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Bang />
      </ErrorBoundary>
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("failed to draw");
    // The two things a user needs: their file is fine, and a way back.
    expect(alert).toHaveTextContent(/not damaged/i);
    expect(screen.getByRole("button", { name: /reload/i })).toBeInTheDocument();
    // And the one thing I need: the actual error.
    expect(alert).toHaveTextContent("holdings_value_cents of undefined");
    spy.mockRestore();
  });

  it("stays out of the way when nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>the register</p>
      </ErrorBoundary>
    );
    expect(screen.getByText("the register")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("Prices are fetched when a file opens, not only when the app does", () => {
  const stale = () => ({
    with_symbol: 2,
    newest_date: "2026-08-01",
    oldest_date: "2026-08-01",
    never_priced: 0,
    last_auto: "2026-08-01T09:00:00",
    interval: "daily",
  });
  const fetches = () => invokeCalls.filter((c) => c.cmd === "refresh_investment_prices").length;

  it("does nothing on the start screen, and fetches the moment a file is opened", async () => {
    // Launch on the start screen: there is no file to price.
    closed = true;
    onOwnFile = false;
    priceStatus = stale();
    render(<App />);
    await screen.findByRole("region", { name: "No file open" });
    expect(fetches()).toBe(0);

    // Open the file. Its last fetch is a month old on a daily setting, so it
    // is due — and the first check must not wait for the half-hour tick.
    const reopen = await screen.findByRole("button", { name: /Reopen “Sam”/ });
    await act(async () => {
      reopen.click();
    });
    await waitFor(() => expect(fetches()).toBe(1));
    expect(invokeCalls.find((c) => c.cmd === "refresh_investment_prices")?.args).toEqual({ auto: true });
  });

  it("checks again for a different file, and not for one that is up to date", async () => {
    onOwnFile = false;
    priceStatus = stale();
    render(<App />);
    await screen.findByRole("menubar", { name: "Main menu" });
    // Launched with a file open: the check at mount, as first built.
    await waitFor(() => expect(fetches()).toBe(1));

    // Close, then open another file whose prices were fetched today.
    priceStatus = { ...stale(), last_auto: new Date().toISOString() };
    await act(async () => {
      runCommand("file.close");
    });
    const reopen = await screen.findByRole("button", { name: /Reopen “Sam”/ });
    await act(async () => {
      reopen.click();
    });
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "open_file")).toBe(true));
    // The check ran (price_status was asked again)…
    await waitFor(() => expect(invokeCalls.filter((c) => c.cmd === "price_status").length).toBeGreaterThanOrEqual(2));
    // …and fetched nothing, because nothing was due.
    expect(fetches()).toBe(1);
  });

  it("never fetches while the setting is off, whatever opens", async () => {
    onOwnFile = false;
    render(<App />);
    await screen.findByRole("menubar", { name: "Main menu" });
    await act(async () => {
      runCommand("file.close");
    });
    const reopen = await screen.findByRole("button", { name: /Reopen “Sam”/ });
    await act(async () => {
      reopen.click();
    });
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "open_file")).toBe(true));
    expect(fetches()).toBe(0);
  });
});
