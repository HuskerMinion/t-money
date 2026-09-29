// @vitest-environment jsdom
// The calculator's arithmetic, which is the only part of it that can
// be wrong in a way you would not notice.
//
// The tape is what makes it checkable by eye; these check the thing the tape
// is reporting. Percent gets its own test because it is the one operation
// people mean differently from what a naive implementation does: on a till,
// "100 + 8.5%" is 8.50, not 0.085.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import CalculatorDialog from "./CalculatorDialog";

function open() {
  render(<CalculatorDialog onClose={vi.fn()} />);
  return userEvent.setup();
}

const total = () => screen.getByLabelText("Tape").parentElement!.textContent ?? "";
const totalRow = () => screen.getByText("Total").parentElement!.textContent ?? "";

describe("CalculatorDialog", () => {
  it("adds a column of amounts, and shows each step on the tape", async () => {
    const user = open();
    const amount = screen.getByLabelText("Amount");
    await user.type(amount, "12.99{Enter}");
    await user.type(amount, "4.50{Enter}");
    await user.type(amount, "1.26{Enter}");
    expect(totalRow()).toContain("18.75");
    // Three lines, so a wrong one can be found rather than guessed at.
    const tape = screen.getByLabelText("Tape");
    expect(within(tape).getAllByText(/\d+\.\d\d/).length).toBeGreaterThanOrEqual(3);
  });

  it("subtracts, multiplies and divides", async () => {
    const user = open();
    const amount = screen.getByLabelText("Amount");
    // 4 items at 12.99
    await user.type(amount, "12.99");
    await user.click(screen.getByRole("button", { name: "×" }));
    await user.type(amount, "4{Enter}");
    expect(totalRow()).toContain("51.96");

    await user.click(screen.getByRole("button", { name: "−" }));
    await user.type(amount, "1.96{Enter}");
    expect(totalRow()).toContain("50.00");

    // Split three ways — the case that cannot stay in whole cents.
    await user.click(screen.getByRole("button", { name: "÷" }));
    await user.type(amount, "3{Enter}");
    expect(totalRow()).toContain("16.67");
  });

  it("takes a percentage OF the running total, the way a receipt means it", async () => {
    const user = open();
    const amount = screen.getByLabelText("Amount");
    await user.type(amount, "100.00{Enter}");
    await user.click(screen.getByRole("button", { name: "+" }));
    await user.type(amount, "8.5");
    await user.click(screen.getByRole("button", { name: "%" }));
    // 8.50, not 0.085 — and it lands in the entry so you can see it before
    // it is applied.
    expect(screen.getByLabelText("Amount")).toHaveValue("8.50");
    await user.click(screen.getByRole("button", { name: "=" }));
    expect(totalRow()).toContain("108.50");
  });

  it("the first number starts the run rather than adding to zero", async () => {
    const user = open();
    await user.type(screen.getByLabelText("Amount"), "25.00{Enter}");
    expect(totalRow()).toContain("25.00");
  });

  it("the keypad types, and backspace and C undo it", async () => {
    const user = open();
    await user.click(screen.getByRole("button", { name: "1" }));
    await user.click(screen.getByRole("button", { name: "2" }));
    await user.click(screen.getByRole("button", { name: "." }));
    await user.click(screen.getByRole("button", { name: "5" }));
    expect(screen.getByLabelText("Amount")).toHaveValue("12.5");
    await user.click(screen.getByRole("button", { name: "Backspace" }));
    expect(screen.getByLabelText("Amount")).toHaveValue("12.");
    // A second decimal point is refused rather than making an unparseable
    // entry that silently does nothing on Enter.
    await user.click(screen.getByRole("button", { name: "." }));
    expect(screen.getByLabelText("Amount")).toHaveValue("12.");
    await user.click(screen.getByRole("button", { name: "C" }));
    expect(screen.getByLabelText("Amount")).toHaveValue("");
    expect(totalRow()).toContain("0.00");
  });

  it("the keyboard's operator keys work as they are printed on the keyboard", async () => {
    const user = open();
    const amount = screen.getByLabelText("Amount");
    await user.type(amount, "10*3");
    // `*` committed the 10 and set ×; the 3 is what is typed now.
    expect(screen.getByLabelText("Amount")).toHaveValue("3");
    await user.type(screen.getByLabelText("Amount"), "{Enter}");
    expect(totalRow()).toContain("30.00");
  });

  it("copies the total as bare digits, ready for an amount field", async () => {
    const user = open();
    // After `open()`: userEvent.setup() installs its own clipboard stub, so a
    // spy defined before it is the one that gets replaced.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await user.type(screen.getByLabelText("Amount"), "1234.56{Enter}");
    await user.click(screen.getByRole("button", { name: "Copy total" }));
    expect(writeText).toHaveBeenCalledWith("1234.56");
  });

  it("copy is dead until there is something to copy", () => {
    open();
    expect(screen.getByRole("button", { name: "Copy total" })).toBeDisabled();
  });
});

describe("Dividing by zero", () => {
  it("is refused: an error, the total unchanged, nothing on the tape, and the division still waiting", async () => {
    const user = open();
    const amount = screen.getByLabelText("Amount");
    await user.type(amount, "50.00{Enter}");
    await user.click(screen.getByRole("button", { name: "÷" }));
    await user.type(amount, "0{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent("Cannot divide by zero.");
    // The ÷ is still pending, so the strip reads "Total ÷".
    expect(document.querySelector(".tm-tape-total")!.textContent).toBe("Total ÷$50.00");
    const tape = screen.getByLabelText("Tape");
    expect(tape.textContent).not.toContain("÷");
    expect(within(tape).getAllByText("$50.00").length).toBe(2);
    // A divisor that works finishes the step and clears the error.
    await user.type(amount, "2{Enter}");
    expect(totalRow()).toContain("25.00");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
