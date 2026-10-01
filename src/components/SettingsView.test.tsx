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
import { useFileFormat } from "../lib/region";

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

// Money → Currencies: the exchange rates, by hand or fetched on request.
describe("Currencies pane", () => {
  const CURRENCIES = [
    { code: "USD", name: "US dollar", symbol: "$", decimals: 2 },
    { code: "EUR", name: "Euro", symbol: "€", decimals: 2 },
    { code: "CAD", name: "Canadian dollar", symbol: "CA$", decimals: 2 },
  ];
  type Rate = { currency: string; date: string; rate_micro: number; source: "manual" | "fetched" };
  let rates: Rate[];

  function stubRates(over: Record<string, IpcHandler> = {}) {
    stub({
      list_currencies: () => CURRENCIES,
      list_exchange_rates: () => rates,
      ...over,
    });
  }

  beforeEach(() => {
    rates = [
      { currency: "EUR", date: "2026-09-01", rate_micro: 1_080_000, source: "manual" },
      { currency: "EUR", date: "2026-09-30", rate_micro: 1_087_500, source: "fetched" },
    ];
    aimSettingsAt("money", "currencies");
  });

  it("lists rates by currency, newest first", async () => {
    stubRates();
    render(<SettingsView />);
    const table = await screen.findByRole("table", { name: "EUR rates" });
    const rows = table.querySelectorAll("tbody tr");
    expect(rows[0]).toHaveTextContent("9/30/2026");
    expect(rows[0]).toHaveTextContent("1.0875");
    expect(rows[0]).toHaveTextContent("Fetched");
    expect(rows[1]).toHaveTextContent("9/1/2026");
    expect(rows[1]).toHaveTextContent("1.08");
    // The currency is the table's caption; the first column is just "Date".
    expect(table.querySelector("caption")).toHaveTextContent("EUR — Euro");
    expect(Array.from(table.querySelectorAll("thead th")).map((th) => th.textContent)).toEqual(["Date", "USD per 1 EUR", "Source", ""]);
    expect(screen.queryByRole("table", { name: "CAD rates" })).not.toBeInTheDocument();
    expect(screen.getByText(/in US dollars/)).toBeInTheDocument();
  });

  it("adds a rate", async () => {
    stubRates({
      set_exchange_rate: (a) => {
        rates.push({ currency: String(a.currency), date: String(a.date), rate_micro: 731_200, source: "manual" });
        return undefined;
      },
    });
    render(<SettingsView />);
    await screen.findByRole("table", { name: "EUR rates" });
    await userEvent.selectOptions(screen.getByLabelText("Currency"), "CAD");
    await userEvent.type(screen.getByLabelText("USD per unit"), "0.7312");
    await userEvent.clear(screen.getByLabelText("Rate date"));
    await userEvent.type(screen.getByLabelText("Rate date"), "10/1/2026");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByRole("table", { name: "CAD rates" })).toHaveTextContent("0.7312");
    expect(invokeCalls.find((c) => c.cmd === "set_exchange_rate")!.args).toEqual({ currency: "CAD", date: "2026-10-01", rate: "0.7312" });
    expect(screen.getByRole("status")).toHaveTextContent("Saved: 1 CAD = 0.7312 USD from 10/1/2026.");
  });

  it("in a German file the rate date is typed and shown day first", async () => {
    useFileFormat.getState().setFormat({ home_currency: "USD", region: "de-DE" });
    stubRates();
    render(<SettingsView />);
    await screen.findByRole("table", { name: "EUR rates" });
    const field = screen.getByLabelText("Rate date");
    await userEvent.clear(field);
    await userEvent.type(field, "1.10.2026");
    await userEvent.tab();
    expect(field).toHaveValue("01.10.2026");
    expect(field).toHaveAttribute("placeholder", "DD.MM.YYYY");
  });

  it("a refused delete is shown and the rate stays", async () => {
    stubRates({
      delete_exchange_rate: () => {
        throw "An account is kept in EUR; it needs at least one rate.";
      },
    });
    render(<SettingsView />);
    await userEvent.click(await screen.findByRole("button", { name: "Delete the EUR rate of 2026-09-30" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("it needs at least one rate");
    expect(screen.getByRole("table", { name: "EUR rates" })).toHaveTextContent("9/30/2026");
  });

  it("deletes a rate", async () => {
    stubRates({
      delete_exchange_rate: (a) => {
        rates = rates.filter((r) => !(r.currency === a.currency && r.date === a.date));
        return undefined;
      },
    });
    render(<SettingsView />);
    await userEvent.click(await screen.findByRole("button", { name: "Delete the EUR rate of 2026-09-01" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Deleted the EUR rate of 9/1/2026.");
    expect(screen.getByRole("table", { name: "EUR rates" })).not.toHaveTextContent("9/1/2026");
  });

  it("fetches only when asked, and says what happened", async () => {
    stubRates({
      fetch_exchange_rates: () => ({ updated: 1, skipped: 0, failures: [{ symbol: "CAD", reason: "no quote" }] }),
    });
    render(<SettingsView />);
    await screen.findByRole("table", { name: "EUR rates" });
    expect(invokeCalls.some((c) => c.cmd === "fetch_exchange_rates")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Get today's rates" }));
    expect(await screen.findByRole("status")).toHaveTextContent("1 updated · CAD: no quote");
    expect(invokeCalls.find((c) => c.cmd === "fetch_exchange_rates")!.args).toEqual({ currencies: ["EUR", "CAD"] });
  });
});

// A file kept in euros: rates are quoted in euros, so the euro has none.
describe("Currencies pane in a euro file", () => {
  const CURRENCIES = [
    { code: "USD", name: "US dollar", symbol: "US$", decimals: 2 },
    { code: "EUR", name: "Euro", symbol: "€", decimals: 2 },
  ];

  it("offers the other currencies, asks for euros per unit, and sends a comma rate as a dot", async () => {
    useFileFormat.getState().setFormat({ home_currency: "EUR", region: "de-DE" });
    const rates = [{ currency: "USD", date: "2026-09-30", rate_micro: 920_000, source: "fetched" as const }];
    stub({
      list_currencies: () => CURRENCIES,
      list_exchange_rates: () => rates,
      set_exchange_rate: () => undefined,
    });
    aimSettingsAt("money", "currencies");
    render(<SettingsView />);
    const table = await screen.findByRole("table", { name: "USD rates" });
    expect(table).toHaveTextContent("EUR per 1 USD");
    expect(table).toHaveTextContent("30.09.2026");
    expect(table).toHaveTextContent("0,92");
    expect(screen.queryByRole("option", { name: /^EUR/ })).not.toBeInTheDocument();
    expect(screen.getByText(/in euros \(EUR\)/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("EUR per unit"), "0,93");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "set_exchange_rate")).toBe(true));
    expect(invokeCalls.find((c) => c.cmd === "set_exchange_rate")!.args).toMatchObject({ currency: "USD", rate: "0.93" });
  });
});

// Money → Home currency and region.
describe("Home currency and region pane", () => {
  const acct = (id: string, currency: string) => ({
    id,
    name: id,
    type: "checking",
    balance_cents: 0,
    holdings_value_cents: 0,
    is_favorite: false,
    is_closed: false,
    currency,
  });

  beforeEach(() => aimSettingsAt("money", "format"));

  it("a new region redraws amounts and dates its way", async () => {
    useFileFormat.getState().setFormat({ home_currency: "EUR", region: "en-IE" });
    stub({ set_region: (a) => ({ home_currency: "EUR", region: String(a.region) }) });
    render(<SettingsView />);
    const preview = screen.getByLabelText("Region preview");
    expect(preview).toHaveTextContent("€1,234.56");
    expect(preview).toHaveTextContent("30/08/2026");
    await userEvent.selectOptions(screen.getByLabelText("Region"), "de-DE");
    await waitFor(() => expect(preview).toHaveTextContent("1.234,56 €"));
    expect(preview).toHaveTextContent("30.08.2026");
    expect(invokeCalls.find((c) => c.cmd === "set_region")!.args).toEqual({ region: "de-DE" });
    expect(useFileFormat.getState().region.code).toBe("de-DE");
  });

  it("a new home currency needs a choice, and relabel sends relabel", async () => {
    stub({
      set_home_currency: (a) => ({ home_currency: String(a.currency), region: "en-US" }),
      get_all_accounts: () => [acct("Checking", "EUR")],
      list_exchange_rates: () => [],
    });
    render(<SettingsView />);
    await userEvent.selectOptions(screen.getByLabelText("New home currency"), "EUR");
    const change = screen.getByRole("button", { name: "Change home currency" });
    // No answer is assumed: either one guessed wrong changes every balance.
    expect(change).toBeDisabled();
    await userEvent.click(screen.getByRole("radio", { name: /already in EUR — relabel them/ }));
    await userEvent.click(change);
    await waitFor(() => expect(useFileFormat.getState().home).toBe("EUR"));
    expect(invokeCalls.find((c) => c.cmd === "set_home_currency")!.args).toEqual({ currency: "EUR", relabel: true });
    expect(invokeCalls.some((c) => c.cmd === "get_all_accounts")).toBe(true);
    expect(await screen.findByText(/no amount was changed/)).toBeInTheDocument();
    expect(screen.queryByText(/There is no rate in EUR/)).not.toBeInTheDocument();
  });

  it("keeping the old currency says which rates are missing, and points to Currencies", async () => {
    stub({
      set_home_currency: (a) => ({ home_currency: String(a.currency), region: "en-US" }),
      get_all_accounts: () => [acct("Checking", "USD"), acct("Konto", "EUR")],
      list_exchange_rates: () => [],
      list_currencies: () => [],
    });
    render(<SettingsView />);
    await userEvent.selectOptions(screen.getByLabelText("New home currency"), "EUR");
    await userEvent.click(screen.getByRole("radio", { name: /Keep them in USD and convert at a rate/ }));
    await userEvent.click(screen.getByRole("button", { name: "Change home currency" }));
    expect(await screen.findByText(/There is no rate in EUR for USD yet/)).toBeInTheDocument();
    expect(invokeCalls.find((c) => c.cmd === "set_home_currency")!.args).toEqual({ currency: "EUR", relabel: false });
    await userEvent.click(screen.getByRole("button", { name: "Open Currencies" }));
    expect(await screen.findByRole("button", { name: "Get today's rates" })).toBeInTheDocument();
  });

  it("a refusal is shown and the home currency stays", async () => {
    stub({
      set_home_currency: () => {
        throw "An investment account is kept in USD; it must be in the home currency.";
      },
    });
    render(<SettingsView />);
    await userEvent.selectOptions(screen.getByLabelText("New home currency"), "EUR");
    await userEvent.click(screen.getByRole("radio", { name: /Keep them in USD/ }));
    await userEvent.click(screen.getByRole("button", { name: "Change home currency" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("it must be in the home currency");
    expect(useFileFormat.getState().home).toBe("USD");
  });
});
