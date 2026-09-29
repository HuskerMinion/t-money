// The typed date field: what it tells the form while the text
// does not read as a date.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import DateField, { parseTypedDate } from "./DateField";

function Harness({ initial, onValue, onInvalid }: { initial: string; onValue: (v: string) => void; onInvalid?: (b: boolean) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <DateField
        value={value}
        onChange={(v) => {
          setValue(v);
          onValue(v);
        }}
        onInvalid={onInvalid}
      />
      <input aria-label="Next" />
    </>
  );
}

function setup(initial = "2026-08-03") {
  const values: string[] = [];
  const onInvalid = vi.fn();
  render(<Harness initial={initial} onValue={(v) => values.push(v)} onInvalid={onInvalid} />);
  const field = screen.getByLabelText("Date") as HTMLInputElement;
  return { field, values, onInvalid, last: () => values[values.length - 1] };
}

describe("parseTypedDate", () => {
  it("refuses a day the month does not have", () => {
    expect(parseTypedDate("2/29/2027")).toBeNull();
    expect(parseTypedDate("2/29/20")).toBe("2020-02-29");
  });
});

describe("DateField", () => {
  it("a date that stops parsing sends \"\", not the last partial date", async () => {
    // 2/29/2027 passes through 2/29/20 on the way, which IS a date
    // (2020-02-29). That partial used to be what the form saved.
    const s = setup();
    await userEvent.clear(s.field);
    await userEvent.type(s.field, "2/29/2027");
    expect(s.values).toContain("2020-02-29");
    expect(s.last()).toBe("");
    await userEvent.tab();
    expect(s.field).toHaveAttribute("aria-invalid", "true");
    expect(s.last()).toBe("");
    expect(s.onInvalid).toHaveBeenLastCalledWith(true);
  });

  it("fixing the text sends the date and clears the red", async () => {
    const s = setup();
    await userEvent.clear(s.field);
    await userEvent.type(s.field, "2/29/2027");
    await userEvent.tab();
    await userEvent.click(s.field);
    await userEvent.clear(s.field);
    await userEvent.type(s.field, "2/28/2027");
    expect(s.last()).toBe("2027-02-28");
    await userEvent.tab();
    expect(s.field).not.toHaveAttribute("aria-invalid");
    expect(s.field).toHaveValue("2/28/2027");
    expect(s.onInvalid).toHaveBeenLastCalledWith(false);
  });

  it("a year left off is still the year of the date being changed", async () => {
    const s = setup("2024-05-01");
    await userEvent.clear(s.field);
    await userEvent.type(s.field, "8/3");
    expect(s.last()).toBe("2024-08-03");
  });

  it("a field emptied and left keeps the date it had, and shows it", async () => {
    const s = setup();
    await userEvent.clear(s.field);
    await userEvent.type(s.field, "9");
    await userEvent.clear(s.field);
    await userEvent.tab();
    expect(s.last()).toBe("2026-08-03");
    expect(s.field).toHaveValue("8/3/2026");
    expect(s.field).not.toHaveAttribute("aria-invalid");
  });

  it("+ steps from the date it had, even after unreadable text", async () => {
    const s = setup();
    await userEvent.clear(s.field);
    await userEvent.type(s.field, "8/");
    expect(s.last()).toBe("");
    await userEvent.keyboard("+");
    expect(s.last()).toBe("2026-08-04");
    expect(s.field).toHaveValue("8/4/2026");
  });

  it("read-only takes no typing", async () => {
    const onChange = vi.fn();
    render(<DateField value="2026-08-03" onChange={onChange} readOnly />);
    const field = screen.getByLabelText("Date");
    await userEvent.type(field, "+T9");
    expect(onChange).not.toHaveBeenCalled();
    expect(field).toHaveValue("8/3/2026");
  });
});
