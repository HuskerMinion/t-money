// The wizard has to know that a debt is owed, not held.
//
// Reported: a new loan account showed its opening balance as a positive
// number. That was wrong. The wizard stored whatever was typed, so a mortgage opened at 150,000 became a
// $150,000 ASSET — net worth out by twice the mortgage, and every principal
// payment afterwards (a positive amount in a loan account) made the number
// grow instead of shrink.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import NewAccountWizard from "./NewAccountWizard";

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
    expect(onCreate).toHaveBeenCalledWith("418 Maple Street", "mortgage", -15_000_000, expect.any(String));
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
    expect(onCreate).toHaveBeenCalledWith("Visa", "credit", 50_000, expect.any(String));
  });

  it("a checking account is untouched — what you type is what you have", async () => {
    const onCreate = await toDetails("Banking", "checking");
    await userEvent.type(screen.getByLabelText("Name:"), "Everyday Checking 1234");
    await userEvent.type(screen.getByLabelText("Opening balance"), "1,457.50");
    await userEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect(onCreate).toHaveBeenCalledWith("Everyday Checking 1234", "checking", 145_750, expect.any(String));
  });

  it("a house is not a debt either", async () => {
    const onCreate = await toDetails("Other account type (such as loan, asset, or watch accounts)", "home");
    await userEvent.type(screen.getByLabelText("Name:"), "27 Birch Lane");
    await userEvent.type(screen.getByLabelText("Opening balance"), "350000");
    await userEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect(onCreate).toHaveBeenCalledWith("27 Birch Lane", "home", 35_000_000, expect.any(String));
  });
});
