// The wizard has to know that a debt is owed, not held.
//
// Reported: a new loan account showed its opening balance as a positive
// number. That was wrong. The wizard stored whatever was typed, so a mortgage opened at 150,000 became a
// $150,000 ASSET — net worth out by twice the mortgage, and every principal
// payment afterwards (a positive amount in a loan account) made the number
// grow instead of shrink.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

import NewAccountWizard from "./NewAccountWizard";
import { invokeCalls, resetIpc, setIpcHandlers, type IpcHandler } from "../test/tauriMock";
import { useFileFormat } from "../lib/region";
import type { ExchangeRate } from "../lib/types";

const CURRENCIES = [
  { code: "USD", name: "US dollar", symbol: "$", decimals: 2 },
  { code: "EUR", name: "Euro", symbol: "€", decimals: 2 },
  { code: "CAD", name: "Canadian dollar", symbol: "CA$", decimals: 2 },
];

function stub(rates: ExchangeRate[] = [], over: Record<string, IpcHandler> = {}) {
  setIpcHandlers({
    list_currencies: () => CURRENCIES,
    list_exchange_rates: () => rates,
    ...over,
  });
}

beforeEach(() => {
  resetIpc();
  stub();
});

/** Walk the wizard to step 3 with a type chosen. */
async function toDetails(category: string, type: string) {
  const onCreate = vi.fn(async () => {});
  render(<NewAccountWizard onCreate={onCreate} onCancel={() => {}} />);
  await userEvent.click(screen.getByRole("radio", { name: category }));
  await userEvent.click(screen.getByRole("button", { name: "Next >" }));
  await userEvent.selectOptions(screen.getByLabelText("Account type"), type);
  await userEvent.click(screen.getByRole("button", { name: "Next >" }));
  return onCreate;
}

describe("New account wizard — opening balance sign", () => {
  it("a mortgage's opening balance is stored as a debt", async () => {
    const onCreate = await toDetails("Other account type (such as loan, asset, or watch accounts)", "mortgage");
    await userEvent.type(screen.getByLabelText("Name:"), "418 Maple Street");
    await userEvent.type(screen.getByLabelText("Amount you owe"), "150000");
    await userEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect(onCreate).toHaveBeenCalledWith("418 Maple Street", "mortgage", -15_000_000, expect.any(String), "USD");
  });

  it("asks what you OWE, and says why, rather than 'Opening balance'", async () => {
    await toDetails("Other account type (such as loan, asset, or watch accounts)", "loan");
    expect(screen.getByText("Amount you owe:")).toBeInTheDocument();
    expect(screen.getByText(/held as a negative balance/)).toBeInTheDocument();
    expect(screen.queryByText("Opening balance:")).not.toBeInTheDocument();
  });

  it("a credit balance on a card can still be said, by typing a negative", async () => {
    // The one case a bare `-Math.abs()` would take away: the card owes you.
    const onCreate = await toDetails("Credit card", "credit");
    await userEvent.type(screen.getByLabelText("Name:"), "Visa");
    await userEvent.type(screen.getByLabelText("Amount you owe"), "-500");
    await userEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect(onCreate).toHaveBeenCalledWith("Visa", "credit", 50_000, expect.any(String), "USD");
  });

  it("a checking account is untouched — what you type is what you have", async () => {
    const onCreate = await toDetails("Banking", "checking");
    await userEvent.type(screen.getByLabelText("Name:"), "Everyday Checking 1234");
    await userEvent.type(screen.getByLabelText("Opening balance"), "1,457.50");
    await userEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect(onCreate).toHaveBeenCalledWith("Everyday Checking 1234", "checking", 145_750, expect.any(String), "USD");
  });

  it("a house is not a debt either", async () => {
    const onCreate = await toDetails("Other account type (such as loan, asset, or watch accounts)", "home");
    await userEvent.type(screen.getByLabelText("Name:"), "27 Birch Lane");
    await userEvent.type(screen.getByLabelText("Opening balance"), "350000");
    await userEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect(onCreate).toHaveBeenCalledWith("27 Birch Lane", "home", 35_000_000, expect.any(String), "USD");
  });
});

describe("New account wizard — currency", () => {
  it("a euro account with no rate yet saves the typed rate, then creates the account in euros", async () => {
    const rates: ExchangeRate[] = [];
    stub(rates, {
      set_exchange_rate: (a) => {
        rates.push({ currency: String(a.currency), date: String(a.date), rate_micro: 1_087_500, source: "manual" });
        return undefined;
      },
    });
    const onCreate = await toDetails("Banking", "savings");
    await userEvent.type(screen.getByLabelText("Name:"), "Paris savings");
    await userEvent.selectOptions(await screen.findByLabelText("Currency"), "EUR");
    expect(screen.getByText("Opening balance (€):")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Opening balance"), "2,000");
    // No rate typed: refused before anything is written.
    await userEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect(screen.getByText(/Enter what 1 EUR is worth in US dollars/)).toBeInTheDocument();
    expect(onCreate).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText("USD per EUR"), "1.0875");
    await userEvent.click(screen.getByRole("button", { name: "Finish" }));
    await vi.waitFor(() => expect(onCreate).toHaveBeenCalled());
    const set = invokeCalls.find((c) => c.cmd === "set_exchange_rate")!;
    expect(set.args).toEqual({ currency: "EUR", date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), rate: "1.0875" });
    expect(onCreate).toHaveBeenCalledWith("Paris savings", "savings", 200_000, set.args.date, "EUR");
  });

  it("a currency that already has a rate asks for none, and says the rate", async () => {
    stub([{ currency: "CAD", date: "2026-09-30", rate_micro: 731_200, source: "fetched" }]);
    const onCreate = await toDetails("Banking", "checking");
    await userEvent.type(screen.getByLabelText("Name:"), "Toronto chequing");
    await userEvent.selectOptions(await screen.findByLabelText("Currency"), "CAD");
    expect(screen.getByText(/1 CAD = 0.7312 USD \(rate of 9\/30\/2026\)/)).toBeInTheDocument();
    expect(screen.queryByLabelText("USD per CAD")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Finish" }));
    await vi.waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate).toHaveBeenCalledWith("Toronto chequing", "checking", 0, expect.any(String), "CAD");
    expect(invokeCalls.some((c) => c.cmd === "set_exchange_rate")).toBe(false);
  });

  it("Get today's rate fetches only when pressed, for that one currency", async () => {
    const rates: ExchangeRate[] = [];
    stub(rates, {
      fetch_exchange_rates: () => {
        rates.push({ currency: "EUR", date: "2026-10-01", rate_micro: 1_090_000, source: "fetched" });
        return { updated: 1, skipped: 0, failures: [] };
      },
    });
    await toDetails("Banking", "savings");
    await userEvent.selectOptions(await screen.findByLabelText("Currency"), "EUR");
    expect(invokeCalls.some((c) => c.cmd === "fetch_exchange_rates")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Get today's rate" }));
    expect(await screen.findByText(/1 EUR = 1.09 USD/)).toBeInTheDocument();
    expect(invokeCalls.find((c) => c.cmd === "fetch_exchange_rates")!.args).toEqual({ currencies: ["EUR"] });
  });

  it("an investment account is kept in dollars, so no currency is offered", async () => {
    await toDetails("Investment", "investment");
    expect(screen.queryByLabelText("Currency")).not.toBeInTheDocument();
  });
});

describe("New account wizard — a file kept in euros", () => {
  beforeEach(() => useFileFormat.getState().setFormat({ home_currency: "EUR", region: "de-DE" }));

  it("starts a new account in the home currency, and reads the region's amounts", async () => {
    const onCreate = await toDetails("Banking", "checking");
    expect((screen.getByLabelText("Currency") as HTMLSelectElement).value).toBe("EUR");
    expect(screen.getByLabelText("Opening balance")).toHaveAttribute("placeholder", "0,00");
    await userEvent.type(screen.getByLabelText("Name:"), "Girokonto");
    await userEvent.type(screen.getByLabelText("Opening balance"), "1.457,50");
    await userEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect(onCreate).toHaveBeenCalledWith("Girokonto", "checking", 145_750, expect.any(String), "EUR");
  });

  it("an investment account is locked to the home currency", async () => {
    const onCreate = await toDetails("Investment", "investment");
    expect(screen.queryByLabelText("Currency")).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Name:"), "Depot");
    await userEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect(onCreate).toHaveBeenCalledWith("Depot", "investment", 0, expect.any(String), "EUR");
  });

  it("asks for a dollar rate in euros, and sends a comma rate as the backend reads it", async () => {
    const rates: ExchangeRate[] = [];
    stub(rates, {
      set_exchange_rate: (a) => {
        rates.push({ currency: String(a.currency), date: String(a.date), rate_micro: 920_000, source: "manual" });
        return undefined;
      },
    });
    const onCreate = await toDetails("Banking", "checking");
    await userEvent.type(screen.getByLabelText("Name:"), "Chase");
    await userEvent.selectOptions(screen.getByLabelText("Currency"), "USD");
    await userEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect(screen.getByText(/Enter what 1 USD is worth in euros/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("EUR per USD"), "0,92");
    await userEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect(invokeCalls.find((c) => c.cmd === "set_exchange_rate")!.args).toMatchObject({ currency: "USD", rate: "0.92" });
    expect(onCreate).toHaveBeenCalledWith("Chase", "checking", 0, expect.any(String), "USD");
  });
});
