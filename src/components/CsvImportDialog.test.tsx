// §88 — the CSV mapping dialog: guess shown, correction re-previews, Import sends the mapping.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

import CsvImportDialog from "./CsvImportDialog";
import { invokeCalls, resetIpc, setIpcHandlers } from "../test/tauriMock";
import type { CsvMapping, CsvPreview } from "../lib/types";
import { registerCommand } from "../lib/commands";

const headers = ["Date", "Description", "Withdrawal", "Deposit", "Balance"];
const rows = [
  ["9/3/2026", "FRESH MARKET", "42.50", "", "957.50"],
  ["9/4/2026", "Paycheck", "", "1,500.00", "2457.50"],
];
const guess: CsvMapping = { date: 0, payee: 1, amount: null, debit: 2, credit: 3, memo: null, check_number: null, category: null, date_order: "auto", negate: false, has_header: true };

function previewFor(m: CsvMapping): CsvPreview {
  const sign = m.negate ? -1 : 1;
  return {
    delimiter: ",",
    headers,
    rows,
    total_rows: 2,
    mapping: m,
    looks_like_tsp: false,
    looks_like_brokerage: false,
    parsed: rows.map((r) => ({ date: "2026-09-0" + r[0][2], payee: r[1], amount_cents: sign * (r[2] ? -Math.round(Number(r[2]) * 100) : Math.round(Number(r[3].replace(",", "")) * 100)), error: null })),
  };
}

describe("CsvImportDialog", () => {
  beforeEach(() => resetIpc());

  it("shows the guessed mapping and the rows, re-previews on a change, and imports with the mapping", async () => {
    setIpcHandlers({
      preview_csv: (args) => previewFor((args.mapping as CsvMapping | null) ?? guess),
      import_csv: () => ({ account_id: "a", account_name: "Checking", imported: 2, skipped: 0, duplicates: 0, balance_delta_cents: 145_750, investments: 0, securities_created: 0, transfers_linked: 0, notes: [] }),
    });
    const onImported = vi.fn();
    render(<CsvImportDialog path="bank.csv" accountId="a" accountName="Checking" onImported={onImported} onCancel={vi.fn()} />);
    const dlg = await screen.findByRole("dialog", { name: "Import CSV" });
    expect(within(dlg).getByLabelText("Date")).toHaveValue("0");
    expect(within(dlg).getByLabelText("Debit / Withdrawal")).toHaveValue("2");
    const how = within(dlg).getByRole("table", { name: "How the first rows read" });
    expect(within(how).getAllByRole("row")[1]).toHaveTextContent("9/3/2026FRESH MARKET$42.50");
    await userEvent.click(within(dlg).getByLabelText(/Flip the signs/));
    await waitFor(() => expect(within(within(dlg).getByRole("table", { name: "How the first rows read" })).getAllByRole("row")[1]).toHaveTextContent("FRESH MARKET$42.50"));
    expect(invokeCalls.filter((c) => c.cmd === "preview_csv").length).toBe(2);
    await userEvent.click(within(dlg).getByRole("button", { name: "Import" }));
    await waitFor(() => expect(onImported).toHaveBeenCalled());
    expect(invokeCalls.find((c) => c.cmd === "import_csv")?.args).toEqual({ path: "bank.csv", accountId: "a", mapping: { ...guess, negate: true } });
  });

  it("will not import without a date and an amount shape", async () => {
    setIpcHandlers({ preview_csv: () => previewFor({ ...guess, date: null, parsed: [] } as never) });
    render(<CsvImportDialog path="x.csv" accountId="a" accountName="Checking" onImported={vi.fn()} onCancel={vi.fn()} />);
    const dlg = await screen.findByRole("dialog", { name: "Import CSV" });
    await waitFor(() => expect(within(dlg).getByText(/Choose the Date column/)).toBeInTheDocument());
    expect(within(dlg).getByRole("button", { name: "Import" })).toBeDisabled();
  });
});

// §165 — which table is the bank's and which is T-Money's is SAID, and the
// second one shows every field the mapping writes.
describe("the two tables say what they are (§165)", () => {
  beforeEach(() => resetIpc());

  it("labels the file as the bank's and the reading as what will be written, with the mapped extras", async () => {
    const withCat: CsvMapping = { ...guess, category: 4, memo: 1, check_number: null };
    setIpcHandlers({
      preview_csv: (args) => {
        const m = (args.mapping as CsvMapping | null) ?? withCat;
        const p = previewFor(m);
        p.parsed = p.parsed.map((r, i) => ({ ...r, category: i === 0 ? "Transfer" : null, memo: r.payee }));
        return p;
      },
    });
    render(<CsvImportDialog path="bank.csv" accountId="a" accountName="Checking" onImported={vi.fn()} onCancel={vi.fn()} />);
    const dlg = await screen.findByRole("dialog", { name: "Import CSV" });
    expect(within(dlg).getByText("1. From the bank — the file as it is")).toBeInTheDocument();
    expect(within(dlg).getByText("2. Into T-Money — what will be written to Checking")).toBeInTheDocument();
    const how = within(dlg).getByRole("table", { name: "How the first rows read" });
    const heads = within(how).getAllByRole("columnheader").map((h) => h.textContent);
    expect(heads).toEqual(["Date", "Payee", "Payment", "Deposit", "Category", "Memo"]);
    const body = within(how).getAllByRole("row");
    expect(body[1]).toHaveTextContent("Transfer");
    expect(body[2]).toHaveTextContent("(none — a payee rule may fill it in)");
  });

  it("shows only the columns the mapping has", async () => {
    setIpcHandlers({ preview_csv: (args) => previewFor((args.mapping as CsvMapping | null) ?? guess) });
    render(<CsvImportDialog path="bank.csv" accountId="a" accountName="Checking" onImported={vi.fn()} onCancel={vi.fn()} />);
    const dlg = await screen.findByRole("dialog", { name: "Import CSV" });
    const how = within(dlg).getByRole("table", { name: "How the first rows read" });
    expect(within(how).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Date", "Payee", "Payment", "Deposit"]);
  });
});

// §132 — the wrong door. A tsp.gov export is a .csv, so it lands here, and
// this importer reads one signed amount per row: right balance, no fund, no
// units, no price, and every row named after the account. A user did exactly
// that and had to restore from a backup.
// §175 — the first hour: a Fidelity history is the other file people try
// to bring in through the bank importer.
describe("a brokerage history (§175)", () => {
  it("shuts the door and says to use the broker's QIF/OFX through Investing", async () => {
    setIpcHandlers({ preview_csv: () => ({ ...previewFor(guess), looks_like_brokerage: true }) });
    render(<CsvImportDialog path="E:/Downloads/History_for_Account_X12345678.csv" accountId="acc-1" accountName="Checking" onImported={vi.fn()} onCancel={vi.fn()} />);
    const warning = await screen.findByRole("alert");
    expect(warning).toHaveTextContent(/brokerage or retirement plan history/);
    expect(warning).toHaveTextContent(/QIF, OFX or QFX/);
    expect(screen.queryByRole("button", { name: "Import" })).not.toBeInTheDocument();
    expect(screen.queryByText(/First line is column names/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });
});

describe("a file that has a reader of its own (§132)", () => {
  it("says so before the mapping table, and names the menu item that can read it", async () => {
    setIpcHandlers({ preview_csv: () => ({ ...previewFor(guess), looks_like_tsp: true }) });
    render(
      <CsvImportDialog
        path="E:/Downloads/tsp-activity.csv"
        accountId="acc-1"
        accountName="TSP"
        onImported={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    const warning = await screen.findByRole("alert");
    expect(warning).toHaveTextContent(/This is a TSP activity detail file/);
    expect(warning).toHaveTextContent(/no fund, no units, no price/);

    // §152 — the door is SHUT, not signposted. There is no mapping table
    // to fill in and no Import button to press: the only way forward is the
    // importer that can actually read the file.
    expect(screen.queryByLabelText("Date")).toBeNull();
    expect(screen.queryByRole("button", { name: "Import" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open the TSP importer" })).toBeInTheDocument();
  });

  it("hands the TSP file to the importer that can read it", async () => {
    const onCancel = vi.fn();
    const ran: string[] = [];
    const handed: unknown[] = [];
    registerCommand("import.tsp", (arg) => {
      ran.push("import.tsp");
      handed.push(arg);
    });
    setIpcHandlers({ preview_csv: () => ({ ...previewFor(guess), looks_like_tsp: true }) });
    render(
      <CsvImportDialog
        path="E:/Downloads/tsp-activity.csv"
        accountId="acc-1"
        accountName="TSP"
        onImported={vi.fn()}
        onCancel={onCancel}
      />
    );
    await userEvent.click(await screen.findByRole("button", { name: "Open the TSP importer" }));
    expect(onCancel).toHaveBeenCalled();
    expect(ran).toEqual(["import.tsp"]);
    // §155 — and the file goes with it, so it is not chosen a second time.
    expect(handed).toEqual(["E:/Downloads/tsp-activity.csv"]);
  });

  it("says nothing for an ordinary bank export", async () => {
    setIpcHandlers({ preview_csv: () => previewFor(guess) });
    render(
      <CsvImportDialog
        path="E:/Downloads/august.csv"
        accountId="acc-1"
        accountName="Checking"
        onImported={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    await screen.findByText(/Say which column is which/);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("§183 — a slow preview does not undo a newer choice", () => {
  beforeEach(() => resetIpc());

  it("drops the answer to an older change when a newer one has already come back", async () => {
    const waiting: Array<{ m: CsvMapping; answer: () => void }> = [];
    setIpcHandlers({
      preview_csv: (args) => {
        const m = (args.mapping as CsvMapping | null) ?? guess;
        // The first read (the guess) answers at once; the two changes wait.
        if (!args.mapping) return previewFor(m);
        return new Promise((resolve) => waiting.push({ m, answer: () => resolve(previewFor(m)) }));
      },
    });
    render(<CsvImportDialog path="bank.csv" accountId="a" accountName="Checking" onImported={vi.fn()} onCancel={vi.fn()} />);
    const dlg = await screen.findByRole("dialog", { name: "Import CSV" });
    await waitFor(() => expect(within(dlg).getByLabelText("Date")).toHaveValue("0"));
    await userEvent.selectOptions(within(dlg).getByLabelText("Memo"), "4");
    await userEvent.selectOptions(within(dlg).getByLabelText("Memo"), "1");
    await waitFor(() => expect(waiting).toHaveLength(2));
    // The newer change answers first, then the older one arrives late.
    waiting[1].answer();
    await waitFor(() => expect(within(dlg).getByLabelText("Memo")).toHaveValue("1"));
    waiting[0].answer();
    await new Promise((r) => setTimeout(r, 20));
    expect(within(dlg).getByLabelText("Memo")).toHaveValue("1");
  });
});
