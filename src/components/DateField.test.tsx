// The typed date field: what it tells the form while the text
// does not read as a date.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import DateField, { parseTypedDate } from "./DateField";
import { useFileFormat } from "../lib/region";

interface HarnessProps {
  initial: string;
  onValue: (v: string) => void;
  onInvalid?: (b: boolean) => void;
  optional?: boolean;
  commitOnLeave?: boolean;
}

function Harness({ initial, onValue, onInvalid, optional, commitOnLeave }: HarnessProps) {
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
        optional={optional}
        commitOnLeave={commitOnLeave}
      />
      <input aria-label="Next" />
    </>
  );
}

function setup(initial = "2026-08-03", extra: { optional?: boolean; commitOnLeave?: boolean } = {}) {
  const values: string[] = [];
  const onInvalid = vi.fn();
  render(<Harness initial={initial} onValue={(v) => values.push(v)} onInvalid={onInvalid} {...extra} />);
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

  it("an optional date emptied and left is no date", async () => {
    const s = setup("2026-08-03", { optional: true });
    await userEvent.clear(s.field);
    await userEvent.tab();
    expect(s.last()).toBe("");
    expect(s.field).toHaveValue("");
    expect(s.field).not.toHaveAttribute("aria-invalid");
  });

  it("an optional date starts empty and takes a typed date", async () => {
    const s = setup("", { optional: true });
    expect(s.field).toHaveValue("");
    await userEvent.type(s.field, "9/15/2026");
    await userEvent.tab();
    expect(s.last()).toBe("2026-09-15");
  });

  it("commit-on-leave tells the form nothing until the field is left", async () => {
    const s = setup("2026-08-03", { commitOnLeave: true });
    await userEvent.clear(s.field);
    await userEvent.type(s.field, "7/1/2026");
    expect(s.values).toEqual([]);
    await userEvent.tab();
    expect(s.values).toEqual(["2026-07-01"]);
  });

  it("commit-on-leave commits on Enter, and keeps the date for unreadable text", async () => {
    const s = setup("2026-08-03", { commitOnLeave: true });
    await userEvent.clear(s.field);
    await userEvent.type(s.field, "7/1/2026{Enter}");
    expect(s.values).toEqual(["2026-07-01"]);
    await userEvent.clear(s.field);
    await userEvent.type(s.field, "7/1/202");
    await userEvent.tab();
    expect(s.values).toEqual(["2026-07-01"]);
    expect(s.field).toHaveAttribute("aria-invalid", "true");
    expect(s.onInvalid).toHaveBeenLastCalledWith(true);
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

describe("DateField in a German file", () => {
  it("shows and asks for the date day first", () => {
    useFileFormat.getState().setFormat({ home_currency: "EUR", region: "de-DE" });
    const s = setup();
    expect(s.field).toHaveValue("03.08.2026");
    expect(s.field).toHaveAttribute("placeholder", "DD.MM.YYYY");
    expect(s.field).toHaveAttribute("title", "Type a date (3.8, 3.8.26 or 03.08.2026). + and − step a day; T is today.");
  });

  it("asks for M/D/YYYY in a US file", () => {
    const s = setup();
    expect(s.field).toHaveAttribute("placeholder", "M/D/YYYY");
    expect(s.field).toHaveAttribute("title", "Type a date (8/3, 8/3/26 or 8/3/2026). + and − step a day; T is today.");
  });
});

describe("DateField where dates are written with a dash", () => {
  it("types a Canadian date in full, and - still steps back from a selected field", async () => {
    useFileFormat.getState().setFormat({ home_currency: "CAD", region: "en-CA" });
    const { field, last } = setup("2026-08-03");
    await userEvent.clear(field);
    await userEvent.type(field, "2026-09-15");
    await userEvent.tab();
    expect(last()).toBe("2026-09-15");
    field.focus();
    field.select();
    await userEvent.keyboard("-");
    expect(last()).toBe("2026-09-14");
  });

  it("reads a short year-first date with a one-digit day", () => {
    useFileFormat.getState().setFormat({ home_currency: "CAD", region: "en-CA" });
    expect(parseTypedDate("26-8-3")).toBe("2026-08-03");
    expect(parseTypedDate("26-08-3")).toBe("2026-08-03");
    useFileFormat.getState().setFormat({ home_currency: "EUR", region: "nl-NL" });
    expect(parseTypedDate("15-09-2026")).toBe("2026-09-15");
    expect(parseTypedDate("15-09-202")).toBeNull();
  });
});
