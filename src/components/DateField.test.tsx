// The typed date field: what it tells the form while the text
// does not read as a date.
import { render, screen, waitFor, within } from "@testing-library/react";
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

describe("DateField's calendar", () => {
  it("opens on the field's date and a click picks a day", async () => {
    const s = setup("2026-08-03");
    await userEvent.click(screen.getByRole("button", { name: "Choose date from a calendar" }));
    const cal = screen.getByRole("dialog", { name: "Date calendar" });
    expect(within(cal).getByText("August 2026")).toBeInTheDocument();
    expect(within(cal).getByRole("button", { name: "8/3/2026" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(within(cal).getByRole("button", { name: "8/20/2026" }));
    expect(s.last()).toBe("2026-08-20");
    expect(s.field).toHaveValue("8/20/2026");
    expect(screen.queryByRole("dialog")).toBeNull();
    // Focus goes back to the field, and + steps from the PICKED date.
    await waitFor(() => expect(s.field).toHaveFocus());
    await userEvent.keyboard("+");
    expect(s.last()).toBe("2026-08-21");
  });

  it("is driven by the keyboard: Alt+Down opens, arrows and Page Down move, Enter picks", async () => {
    const s = setup("2026-01-31");
    s.field.focus();
    await userEvent.keyboard("{Alt>}{ArrowDown}{/Alt}");
    const cal = screen.getByRole("dialog", { name: "Date calendar" });
    expect(within(cal).getByRole("button", { name: "1/31/2026" })).toHaveFocus();
    // A month on from Jan 31 is Feb 28, not March 3.
    await userEvent.keyboard("{PageDown}");
    expect(within(cal).getByText("February 2026")).toBeInTheDocument();
    expect(within(cal).getByRole("button", { name: "2/28/2026" })).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}{ArrowDown}{Enter}");
    expect(s.last()).toBe("2026-03-08");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Escape closes without changing the date, and does not reach the form", async () => {
    const onFormKey = vi.fn();
    const values: string[] = [];
    render(
      <div onKeyDown={(e) => onFormKey(e.key)}>
        <Harness initial="2026-08-03" onValue={(v) => values.push(v)} />
      </div>
    );
    const field = screen.getByLabelText("Date");
    field.focus();
    await userEvent.keyboard("{F4}");
    onFormKey.mockClear();
    await userEvent.keyboard("{ArrowRight}{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(values).toEqual([]);
    expect(onFormKey).not.toHaveBeenCalled();
    await waitFor(() => expect(field).toHaveFocus());
  });

  it("a click in the calendar does not reach the row the field sits in", async () => {
    const onRowClick = vi.fn();
    render(
      <div onClick={onRowClick}>
        <DateField value="2026-08-03" onChange={() => {}} />
      </div>
    );
    await userEvent.click(screen.getByRole("button", { name: "Choose date from a calendar" }));
    onRowClick.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(screen.getByText("September 2026")).toBeInTheDocument();
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("Alt+F4 is left for closing T-Money", async () => {
    render(<DateField value="2026-08-03" onChange={() => {}} />);
    screen.getByLabelText("Date").focus();
    await userEvent.keyboard("{Alt>}{F4}{/Alt}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a click on the weekday names keeps the keys working", async () => {
    render(<DateField value="2026-08-03" onChange={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Choose date from a calendar" }));
    await userEvent.click(screen.getByText("Mo"));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not open on a read-only field", async () => {
    render(<DateField value="2026-08-03" onChange={() => {}} readOnly />);
    expect(screen.getByRole("button", { name: "Choose date from a calendar" })).toBeDisabled();
    screen.getByLabelText("Date").focus();
    await userEvent.keyboard("{F4}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
