// The small calculator button inside an amount box: the register's Payment
// and Deposit, a split line's amount. It opens Tools → Calculator on the box
// (the same as Ctrl+K in it), which starts from the box's amount and puts
// the total back. It shows while the pointer is over the box or the box has
// the caret, so a column of amounts does not wear a column of buttons.
//
// Wrap the box: <AmountCalcButton><input data-amount …/></AmountCalcButton>.
import type { ReactNode } from "react";
import { runCommand } from "../lib/commands";
import { isAmountField } from "../lib/amountField";

interface Props {
  children: ReactNode;
  /** No button: the box is read-only (a split's total, a transfer's far side). */
  off?: boolean;
}

export default function AmountCalcButton({ children, off = false }: Props) {
  return (
    <span className="tm-amountfield">
      {children}
      {!off && (
        <button
          type="button"
          className="tm-amountfield-btn"
          tabIndex={-1}
          aria-label="Calculator"
          title="Calculator (Ctrl+K). You can also type a sum in the box, such as 12.99*4."
          // Keep the caret in the box: leaving it would work out a half-typed sum.
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            const box = e.currentTarget.parentElement?.querySelector("input");
            if (isAmountField(box)) runCommand("tools.calculator", box);
          }}
        >
          <svg viewBox="0 0 10 12" width="9" height="11" aria-hidden="true">
            <rect x="0.5" y="0.5" width="9" height="11" rx="1" fill="none" stroke="currentColor" />
            <rect x="2" y="2" width="6" height="2.5" fill="currentColor" />
            <rect x="2" y="6" width="1.6" height="1.4" fill="currentColor" />
            <rect x="4.2" y="6" width="1.6" height="1.4" fill="currentColor" />
            <rect x="6.4" y="6" width="1.6" height="1.4" fill="currentColor" />
            <rect x="2" y="8.6" width="1.6" height="1.4" fill="currentColor" />
            <rect x="4.2" y="8.6" width="1.6" height="1.4" fill="currentColor" />
            <rect x="6.4" y="8.6" width="1.6" height="1.4" fill="currentColor" />
          </svg>
        </button>
      )}
    </span>
  );
}
