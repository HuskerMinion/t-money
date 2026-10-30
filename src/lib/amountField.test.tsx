// A sum typed in an amount box shows its result when the box is left, and
// the calculator can be opened on a box and put its total back.
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { installAmountMath } from "./amountField";
import { registerCommand, resetCommands } from "./commands";
import CalculatorDialog from "../components/CalculatorDialog";
import AmountCalcButton from "../components/AmountCalcButton";

function Form({ onAmount, onMemo }: { onAmount: (v: string) => void; onMemo?: (v: string) => void }) {
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  return (
    <>
      <AmountCalcButton>
        <input
          data-amount
          aria-label="Payment"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            onAmount(e.target.value);
          }}
        />
      </AmountCalcButton>
      <input
        aria-label="Memo"
        value={memo}
        onChange={(e) => {
          setMemo(e.target.value);
          onMemo?.(e.target.value);
        }}
      />
    </>
  );
}

let stop: () => void;
beforeEach(() => {
  stop = installAmountMath();
});
afterEach(() => {
  stop();
  resetCommands();
});

describe("a sum in an amount box", () => {
  it("is worked out when the box is left, and the form hears the result", async () => {
    const onAmount = vi.fn();
    render(<Form onAmount={onAmount} />);
    const box = screen.getByLabelText("Payment");
    await userEvent.type(box, "12.99*4");
    await userEvent.tab();
    expect(box).toHaveValue("51.96");
    expect(onAmount).toHaveBeenLastCalledWith("51.96");
  });

  it("is worked out on Enter", async () => {
    render(<Form onAmount={() => {}} />);
    const box = screen.getByLabelText("Payment");
    await userEvent.type(box, "100+8.5%{Enter}");
    expect(box).toHaveValue("108.50");
  });

  it("leaves a sum that does not work out for the form to refuse", async () => {
    render(<Form onAmount={() => {}} />);
    const box = screen.getByLabelText("Payment");
    await userEvent.type(box, "12/0");
    await userEvent.tab();
    expect(box).toHaveValue("12/0");
  });

  it("never touches a box that is not an amount", async () => {
    render(<Form onAmount={() => {}} />);
    const memo = screen.getByLabelText("Memo");
    await userEvent.type(memo, "7-11");
    await userEvent.tab();
    expect(memo).toHaveValue("7-11");
  });
});

describe("the calculator, opened on an amount box", () => {
  it("the box's button opens it on that box", async () => {
    const onCalc = vi.fn();
    registerCommand("tools.calculator", onCalc);
    render(<Form onAmount={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Calculator" }));
    expect(onCalc).toHaveBeenCalledWith(screen.getByLabelText("Payment"));
  });

  it("starts from the box's amount and puts the total back", async () => {
    const onAmount = vi.fn();
    const onClose = vi.fn();
    render(<Form onAmount={onAmount} />);
    const box = screen.getByLabelText("Payment") as HTMLInputElement;
    fireEvent.change(box, { target: { value: "20.00" } });
    render(<CalculatorDialog target={box} onClose={onClose} />);
    // The box's 20.00 is the first line; times three.
    const entry = screen.getByLabelText("Amount");
    await userEvent.type(entry, "*3");
    await userEvent.click(screen.getByRole("button", { name: "Put in Payment" }));
    expect(box).toHaveValue("60.00");
    expect(onAmount).toHaveBeenLastCalledWith("60.00");
    expect(onClose).toHaveBeenCalled();
  });

  it("Enter finishes the sum, and Enter again on an empty entry puts it in", async () => {
    const onClose = vi.fn();
    render(<Form onAmount={() => {}} />);
    const box = screen.getByLabelText("Payment") as HTMLInputElement;
    render(<CalculatorDialog target={box} onClose={onClose} />);
    const entry = screen.getByLabelText("Amount");
    await userEvent.type(entry, "12.99*4{Enter}");
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.type(entry, "{Enter}");
    expect(box).toHaveValue("51.96");
    expect(onClose).toHaveBeenCalled();
  });

  it("a refused step puts nothing in the box", async () => {
    const onClose = vi.fn();
    render(<Form onAmount={() => {}} />);
    const box = screen.getByLabelText("Payment") as HTMLInputElement;
    fireEvent.change(box, { target: { value: "10" } });
    render(<CalculatorDialog target={box} onClose={onClose} />);
    await userEvent.type(screen.getByLabelText("Amount"), "/0");
    await userEvent.click(screen.getByRole("button", { name: "Put in Payment" }));
    expect(box).toHaveValue("10");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/Cannot divide by zero/)).toBeInTheDocument();
  });
});
