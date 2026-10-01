// The Bills screen's pure helpers.
//
// The screen itself is covered by App.nav.test.tsx; what is worth testing
// directly is how an occurrence's state is PRESENTED, because that is where a
// user-visible lie would live — a bill that says "Due" when the register
// already has it, or one that offers Enter when it has been paid.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

import PaymentsView, { describeRule, describeStatus, isOpen } from "./PaymentsView";
import { resetIpc, setIpcHandlers } from "../test/tauriMock";
import type { Account, Occurrence, Recurrence } from "../lib/types";
import { useFileFormat } from "../lib/region";

function occ(over: Partial<Occurrence> = {}): Occurrence {
  return {
    recurrence_id: "r-1",
    payee: "Anytown Properties",
    amount_cents: -145000,
    account_id: "acc-1",
    account_name: "Checking",
    category_id: null,
    category_name: null,
    due_date: "2026-09-01",
    status: "due",
    transaction_id: null,
    actual_amount_cents: null,
    ...over,
  };
}

describe("describeRule", () => {
  it("names the plain frequencies", () => {
    expect(describeRule({ freq: "monthly", interval_n: 1 })).toBe("Monthly");
    expect(describeRule({ freq: "semi_monthly", interval_n: 1 })).toBe("Twice a month");
    expect(describeRule({ freq: "once", interval_n: 1 })).toBe("Once");
  });

  it("spells out an interval in the right unit", () => {
    expect(describeRule({ freq: "weekly", interval_n: 2 })).toBe("Every 2 weeks");
    expect(describeRule({ freq: "monthly", interval_n: 3 })).toBe("Every 3 months");
    expect(describeRule({ freq: "yearly", interval_n: 2 })).toBe("Every 2 years");
  });
});

describe("describeStatus", () => {
  it("says WHY a matched bill is settled, rather than hiding it", () => {
    // The automatic decision has to be visible: the user never told us this
    // was paid, we inferred it from the register, so the screen says so and
    // the row can be undone.
    expect(describeStatus(occ({ status: "matched" })).label).toBe("Already in register");
  });

  it("distinguishes entered from skipped from overdue", () => {
    expect(describeStatus(occ({ status: "paid" })).label).toBe("Entered");
    expect(describeStatus(occ({ status: "skipped" })).label).toBe("Skipped");
    expect(describeStatus(occ({ status: "overdue" })).label).toBe("Overdue");
    expect(describeStatus(occ({ status: "due" })).label).toBe("Due");
  });

  it("gives overdue and settled rows different tones", () => {
    expect(describeStatus(occ({ status: "overdue" })).tone).toContain("overdue");
    expect(describeStatus(occ({ status: "matched" })).tone).toContain("done");
    expect(describeStatus(occ({ status: "due" })).tone).toBe("");
  });
});

describe("isOpen", () => {
  it("is true only for what is still going to happen", () => {
    expect(isOpen(occ({ status: "due" }))).toBe(true);
    expect(isOpen(occ({ status: "overdue" }))).toBe(true);
  });

  it("is false once something has settled it", () => {
    // A bill paid by hand must stop offering Enter — that is the whole point
    // of matching, and offering Enter would invite a duplicate.
    for (const status of ["paid", "skipped", "matched"] as const) {
      expect(isOpen(occ({ status }))).toBe(false);
    }
  });
});

// N9: "I see Demo Old Checking in the account picker of the Bills
// forecast Next 90 Days."
describe("A closed account on the Bills screen", () => {
  const acct = (id: string, name: string, is_closed = false): Account => ({
    id, name, type: "checking", balance_cents: 0, holdings_value_cents: 0, tax_included: true,
    is_favorite: false, is_closed, updated_at: "", institution: null, account_number: null,
    routing_number: null, opened_on: null, credit_limit_cents: null, contact_phone: null,
    contact_email: null, website: null, address: null, account_notes: null,
  });
  const rule: Recurrence = {
    id: "r-old", payee: "Sweep to old", amount_cents: -5_000, account_id: "a-chk", account_name: "Demo Checking",
    category_id: null, category_name: null, freq: "monthly", interval_n: 1, start_date: "2026-01-01",
    end_date: null, second_day: null, weekend_rule: "none", notes: null, is_active: true, updated_at: "",
    transfer_account_id: "a-old", transfer_account_name: "Demo Old Checking",
  };

  beforeEach(() => {
    resetIpc();
    setIpcHandlers({
      list_recurrences: () => [rule],
      get_upcoming: () => [],
      get_all_accounts: () => [acct("a-chk", "Demo Checking"), acct("a-sav", "Demo Savings"), acct("a-old", "Demo Old Checking", true)],
      list_categories: () => [],
      list_goals: () => [],
      get_ui_setting: () => null,
      get_cash_forecast: () => null,
    });
  });

  it("is not in the forecast's account picker", async () => {
    render(<PaymentsView />);
    const picker = await screen.findByLabelText("Forecast account");
    await waitFor(() => expect(within(picker).getAllByRole("option").length).toBe(2));
    const names = within(picker).getAllByRole("option").map((o) => o.textContent);
    expect(names).toEqual(["Demo Checking", "Demo Savings"]);
  });

  it("a schedule that already transfers to it still shows it when edited", async () => {
    render(<PaymentsView />);
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(await screen.findByLabelText("Transfer to")).toHaveValue("Demo Old Checking (closed)");
  });
});

// What the code review found on the rule form.
describe("The Bills rule form", () => {
  const acct: Account = {
    id: "a-chk", name: "Demo Checking", type: "checking", balance_cents: 0, holdings_value_cents: 0, tax_included: true,
    is_favorite: false, is_closed: false, updated_at: "", institution: null, account_number: null,
    routing_number: null, opened_on: null, credit_limit_cents: null, contact_phone: null,
    contact_email: null, website: null, address: null, account_notes: null,
  };
  const semi: Recurrence = {
    id: "r-semi", payee: "Paycheck", amount_cents: 200_000, account_id: "a-chk", account_name: "Demo Checking",
    category_id: null, category_name: null, freq: "semi_monthly", interval_n: 1, start_date: "2026-01-01",
    end_date: null, second_day: null, weekend_rule: "none", notes: null, is_active: true, updated_at: "",
  };
  let saved: Array<Record<string, unknown>>;

  function stub(extra: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
    saved = [];
    resetIpc();
    setIpcHandlers({
      list_recurrences: () => [semi],
      get_upcoming: () => [],
      get_all_accounts: () => [acct],
      list_categories: () => [],
      list_goals: () => [],
      get_ui_setting: () => null,
      get_cash_forecast: () => null,
      create_recurrence: (args) => {
        saved.push(args.payload as Record<string, unknown>);
        return semi;
      },
      update_recurrence: (args) => {
        saved.push(args.payload as Record<string, unknown>);
        return semi;
      },
      ...extra,
    });
  }

  async function fillNew() {
    render(<PaymentsView />);
    await screen.findByRole("button", { name: "Edit" });
    await userEvent.type(screen.getByLabelText("Payee"), "Rent");
    await userEvent.type(screen.getByLabelText("Amount"), "100");
  }

  it("saves the second day it shows when the rule becomes twice a month", async () => {
    stub();
    await fillNew();
    await userEvent.selectOptions(screen.getByLabelText("Repeats"), "semi_monthly");
    expect(screen.getByLabelText("Second day")).toHaveValue(15);
    await userEvent.click(screen.getByRole("button", { name: "Schedule it" }));
    await waitFor(() => expect(saved.length).toBe(1));
    expect(saved[0].second_day).toBe(15);
    expect(saved[0].freq).toBe("semi_monthly");
  });

  it("shows a twice-a-month rule saved without a second day as blank, and will not save it that way", async () => {
    stub();
    render(<PaymentsView />);
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Second day")).toHaveValue(null);
    expect(screen.getByText(/No second day is set/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("second day");
    expect(saved.length).toBe(0);
    await userEvent.type(screen.getByLabelText("Second day"), "20");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saved.length).toBe(1));
    expect(saved[0].second_day).toBe(20);
  });

  it("lets Every be cleared and retyped, so 3 is 3 and not 13", async () => {
    stub();
    await fillNew();
    const every = screen.getByLabelText("Interval");
    await userEvent.clear(every);
    await userEvent.type(every, "3");
    expect(every).toHaveValue(3);
    await userEvent.click(screen.getByRole("button", { name: "Schedule it" }));
    await waitFor(() => expect(saved.length).toBe(1));
    expect(saved[0].interval_n).toBe(3);
  });

  it("shows a refused save as an error beside the form and keeps what was typed", async () => {
    stub({
      create_recurrence: () => {
        throw new Error("the account is closed");
      },
    });
    await fillNew();
    await userEvent.click(screen.getByRole("button", { name: "Schedule it" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("the account is closed");
    expect(alert.closest("form")).not.toBeNull();
    expect(screen.getByLabelText("Payee")).toHaveValue("Rent");
  });
});

// "I do see a need to be able to edit scheduled things." Editing was
// only reachable from the short list under the form and from the calendar;
// the upcoming list, where the user works, offered Enter and Skip and nothing else.
describe("Editing a schedule from the upcoming list", () => {
  const acct: Account = {
    id: "acc-1", name: "Checking", type: "checking", balance_cents: 0, holdings_value_cents: 0, tax_included: true,
    is_favorite: false, is_closed: false, updated_at: "", institution: null, account_number: null,
    routing_number: null, opened_on: null, credit_limit_cents: null, contact_phone: null,
    contact_email: null, website: null, address: null, account_notes: null,
  };
  const rule = (id: string, payee: string, amount_cents: number): Recurrence => ({
    id, payee, amount_cents, account_id: "acc-1", account_name: "Checking",
    category_id: null, category_name: null, freq: "monthly", interval_n: 1, start_date: "2026-01-01",
    end_date: null, second_day: null, weekend_rule: "none", notes: null, is_active: true, updated_at: "",
  });
  const RENT = rule("r-rent", "Anytown Properties", -145_000);
  const NETFLIX = rule("r-netflix", "Netflix", -1_599);
  let updates: Array<Record<string, unknown>>;
  let entered: number;

  beforeEach(() => {
    updates = [];
    entered = 0;
    resetIpc();
    setIpcHandlers({
      list_recurrences: () => [RENT, NETFLIX],
      get_upcoming: () => [
        occ({ recurrence_id: "r-rent", payee: "Anytown Properties", due_date: "2026-10-01" }),
        occ({ recurrence_id: "r-netflix", payee: "Netflix", amount_cents: -1_599, due_date: "2026-09-12", status: "paid" }),
      ],
      get_all_accounts: () => [acct],
      list_categories: () => [],
      list_goals: () => [],
      get_ui_setting: () => null,
      get_cash_forecast: () => null,
      get_occurrences: () => [],
      enter_occurrence: () => {
        entered += 1;
        return null;
      },
      update_recurrence: (args) => {
        updates.push(args);
        return NETFLIX;
      },
    });
  });

  const rowOf = async (payee: string) => (await screen.findByRole("cell", { name: payee })).closest("tr")!;

  it("puts Edit on every row beside Enter and Skip, and opens that row's schedule in the form", async () => {
    // jsdom has no scrollIntoView; the view calls it only when it exists.
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    onTestFinished(() => {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    });
    render(<PaymentsView />);

    const rent = await rowOf("Anytown Properties");
    expect(within(rent).getByRole("button", { name: "Enter" })).toBeInTheDocument();
    expect(within(rent).getByRole("button", { name: "Skip" })).toBeInTheDocument();
    expect(within(rent).getByRole("button", { name: "Edit the schedule for Anytown Properties" })).toHaveTextContent("Edit");
    // A settled row too: next month's Netflix is still this schedule.
    const netflix = await rowOf("Netflix");
    await userEvent.click(within(netflix).getByRole("button", { name: "Edit the schedule for Netflix" }));

    expect(screen.getByText("Edit scheduled item: Netflix")).toBeInTheDocument();
    const payee = screen.getByLabelText("Payee");
    expect(payee).toHaveValue("Netflix");
    expect(screen.getByLabelText("Amount")).toHaveValue("15.99");
    // Taken to the form, not left to find it.
    expect(payee).toHaveFocus();
    expect(scrolled).toHaveBeenCalled();
    expect(scrolled.mock.contexts[0]).toBe(payee.closest("section"));

    // The title names the schedule it was opened with while a rename is typed.
    await userEvent.clear(payee);
    await userEvent.type(payee, "Netflix Premium");
    expect(screen.getByText("Edit scheduled item: Netflix")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updates.length).toBe(1));
    expect(updates[0].id).toBe("r-netflix");
    expect((updates[0].payload as Record<string, unknown>).payee).toBe("Netflix Premium");
  });

  it("in a German file, opens the amount as 1450,00 and takes 1.234,56", async () => {
    useFileFormat.getState().setFormat({ home_currency: "EUR", region: "de-DE" });
    Element.prototype.scrollIntoView = vi.fn();
    onTestFinished(() => {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    });
    render(<PaymentsView />);
    const rent = await rowOf("Anytown Properties");
    expect(rent).toHaveTextContent("(1.450,00 €)");
    await userEvent.click(within(rent).getByRole("button", { name: "Edit the schedule for Anytown Properties" }));
    const amount = screen.getByLabelText("Amount");
    expect(amount).toHaveValue("1450,00");
    expect(amount).toHaveAttribute("placeholder", "0,00");
    await userEvent.clear(amount);
    await userEvent.type(amount, "1.234,56");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updates.length).toBe(1));
    expect((updates[0].payload as Record<string, unknown>).amount_cents).toBe(-123_456);
  });

  it("opens a row's schedule on a double-click, but not from a double-click on its buttons", async () => {
    render(<PaymentsView />);
    const rent = await rowOf("Anytown Properties");

    await userEvent.dblClick(within(rent).getByRole("button", { name: "Enter" }));
    await waitFor(() => expect(entered).toBeGreaterThan(0));
    expect(screen.queryByText(/^Edit scheduled item/)).not.toBeInTheDocument();

    await userEvent.dblClick(within(await rowOf("Anytown Properties")).getByRole("cell", { name: "Anytown Properties" }));
    expect(screen.getByText("Edit scheduled item: Anytown Properties")).toBeInTheDocument();
    expect(screen.getByLabelText("Payee")).toHaveValue("Anytown Properties");
    expect(screen.getByLabelText("Amount")).toHaveValue("1450.00");
  });
});

describe("Scheduled transfers and other currencies", () => {
  const acct = (id: string, name: string, currency = "USD"): Account => ({
    id, name, type: "checking", balance_cents: 0, holdings_value_cents: 0, tax_included: true,
    is_favorite: false, is_closed: false, updated_at: "", institution: null, account_number: null,
    routing_number: null, opened_on: null, credit_limit_cents: null, contact_phone: null,
    contact_email: null, website: null, address: null, account_notes: null,
    currency, home_rate_micro: currency === "USD" ? 1_000_000 : 1_100_000,
  });
  const sweep: Recurrence = {
    id: "r-sweep", payee: "Sweep", amount_cents: -5_000, account_id: "a-eur", account_name: "Euro checking",
    category_id: null, category_name: null, freq: "monthly", interval_n: 1, start_date: "2026-01-01",
    end_date: null, second_day: null, weekend_rule: "none", notes: null, is_active: true, updated_at: "",
    transfer_account_id: "a-eur2", transfer_account_name: "Euro savings",
  };

  beforeEach(() => {
    resetIpc();
    setIpcHandlers({
      list_recurrences: () => [sweep],
      get_upcoming: () => [occ({ recurrence_id: "r-sweep", payee: "Sweep", amount_cents: -5_000, account_id: "a-eur", account_name: "Euro checking" })],
      get_all_accounts: () => [acct("a-chk", "Demo Checking"), acct("a-eur", "Euro checking", "EUR"), acct("a-eur2", "Euro savings", "EUR")],
      list_categories: () => [],
      list_goals: () => [],
      get_ui_setting: () => null,
      get_cash_forecast: () => null,
    });
  });

  it("offers only accounts in the same currency to transfer to", async () => {
    render(<PaymentsView />);
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const to = await screen.findByLabelText("Transfer to");
    expect(to).toHaveValue("Euro savings");
    await userEvent.clear(to);
    await userEvent.click(to);
    const options = within(screen.getByRole("listbox", { name: "Transfer to options" })).getAllByRole("option").map((o) => o.textContent);
    expect(options.some((t) => t?.includes("Euro savings"))).toBe(true);
    expect(options.some((t) => t?.includes("Demo Checking"))).toBe(false);
  });

  it("shows an upcoming bill in its account's currency", async () => {
    render(<PaymentsView />);
    const row = (await screen.findByRole("cell", { name: "Euro checking" })).closest("tr")!;
    expect(row).toHaveTextContent("(€50.00)");
  });
});
