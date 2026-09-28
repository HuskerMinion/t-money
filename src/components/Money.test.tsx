// Money — the display component every figure in the app goes through.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Money from "./Money";

describe("<Money />", () => {
  it("renders positives with no tone class", () => {
    render(<Money cents={123842} />);
    const el = screen.getByText("$1,238.42");
    expect(el).toBeInTheDocument();
    expect(el.className).toBe("");
  });

  it("marks negatives red and uses accounting parens", () => {
    render(<Money cents={-4250} />);
    const el = screen.getByText("($42.50)");
    expect(el).toHaveClass("money-neg");
  });

  it("treats zero as non-negative", () => {
    render(<Money cents={0} />);
    expect(screen.getByText("$0.00").className).toBe("");
  });

  it('tone="positive" forces the green class even for a negative', () => {
    render(<Money cents={-100} tone="positive" />);
    expect(screen.getByText("($1.00)")).toHaveClass("money-pos");
  });

  it('tone="neutral" suppresses the red class', () => {
    render(<Money cents={-100} tone="neutral" />);
    expect(screen.getByText("($1.00)").className).toBe("");
  });

  it("appends className without dropping the tone class", () => {
    render(<Money cents={-100} className="text-[13px]" />);
    const el = screen.getByText("($1.00)");
    expect(el).toHaveClass("money-neg");
    expect(el).toHaveClass("text-[13px]");
  });
});
