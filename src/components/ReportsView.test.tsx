// The Reports page keeps the report it is showing.
//
// The viewer is stubbed: what is under test is ReportsView's own state — which
// spec is open, and what makes it change — not the report engine.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));
vi.mock("./ReportViewer", async (importOriginal) => {
  const real = await importOriginal<typeof import("./ReportViewer")>();
  return {
    ...real,
    default: function StubViewer(props: React.ComponentProps<typeof real.default>) {
      const { spec, onSpec, onSave } = props;
      return (
        <div>
          <h1>{spec.savedName ?? spec.kind}</h1>
          <div data-testid="accounts">{spec.accountIds.join(",")}</div>
          <div data-testid="saved-id">{spec.savedId ?? ""}</div>
          {props.customizeOnOpen && <div>Customize panel is showing</div>}
          <button type="button" onClick={() => onSpec({ ...spec, accountIds: ["a-2"] })}>
            Customize
          </button>
          <button
            type="button"
            onClick={() =>
              void onSave(real.savedFromSpec(spec, "Mine")).then((stored) =>
                onSpec({ ...spec, savedId: stored.id, savedName: stored.name })
              )
            }
          >
            Save
          </button>
        </div>
      );
    },
  };
});

import ReportsView, { specFor, type ReportOpen } from "./ReportsView";
import { invokeCalls, resetIpc, setIpcHandlers } from "../test/tauriMock";
import { savedFromSpec } from "./ReportViewer";
import type { SavedReport } from "../lib/types";

let saved: SavedReport[];

beforeEach(() => {
  saved = [];
  resetIpc();
  setIpcHandlers({
    list_reports: () => [],
    list_saved_reports: () => [...saved],
    list_categories: () => [],
    get_all_accounts: () => [],
    save_report: (args) => {
      const r = { ...(args.report as SavedReport), id: (args.report as SavedReport).id || `saved-${saved.length + 1}` };
      saved = [...saved.filter((s) => s.id !== r.id), r];
      return r;
    },
  });
});

function view(initialOpen: ReportOpen | null) {
  return <ReportsView initialOpen={initialOpen} onOpenAccount={() => {}} onOpenTransaction={() => {}} />;
}

describe("Saving a favorite does not reset the open report", () => {
  it("keeps a rail report's changes and its new saved id, so the next Save updates it", async () => {
    const open: ReportOpen = { kind: "spending_by_category" };
    render(view(open));
    await screen.findByRole("heading", { name: "spending_by_category" });
    await userEvent.click(screen.getByRole("button", { name: "Customize" }));
    expect(screen.getByTestId("accounts")).toHaveTextContent("a-2");

    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("heading", { name: "Mine" });
    // The favorites reload that follows a save has landed…
    await waitFor(() => expect(invokeCalls.filter((c) => c.cmd === "list_saved_reports").length).toBe(2));
    // …and the report is still the customized, saved one.
    expect(screen.getByTestId("accounts")).toHaveTextContent("a-2");
    expect(screen.getByTestId("saved-id")).toHaveTextContent("saved-1");

    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(invokeCalls.filter((c) => c.cmd === "save_report").length).toBe(2));
    expect(saved).toHaveLength(1);
  });

  it("a favorites reload that lands after a change leaves the change alone", async () => {
    // What reset the viewer was the effect re-running on `favorites`. Hold
    // the reload back until the report has been changed, then let it land.
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => (release = res));
    setIpcHandlers({
      list_reports: () => [],
      list_saved_reports: async () => {
        await gate;
        return [{ ...savedFromSpec(specFor("net_worth"), "Other"), id: "fav-9" }];
      },
      list_categories: () => [],
      get_all_accounts: () => [],
    });
    render(view({ kind: "spending_by_category" }));
    await screen.findByRole("heading", { name: "spending_by_category" });
    await userEvent.click(screen.getByRole("button", { name: "Customize" }));
    expect(screen.getByTestId("accounts")).toHaveTextContent("a-2");
    await act(async () => {
      release();
      await gate;
    });
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === "list_saved_reports")).toBe(true));
    expect(screen.getByTestId("accounts")).toHaveTextContent("a-2");
  });

  it("a new opener from the rail still replaces what is open", async () => {
    const { rerender } = render(view({ kind: "spending_by_category" }));
    await screen.findByRole("heading", { name: "spending_by_category" });
    rerender(view({ kind: "net_worth" }));
    expect(await screen.findByRole("heading", { name: "net_worth" })).toBeInTheDocument();
  });

  it("a saved report from the Favorites menu opens once the list is in, and keeps its edits after a save", async () => {
    saved = [{ ...savedFromSpec(specFor("income_and_spending"), "Monthly - Sam"), id: "fav-1" }];
    render(view({ kind: "", savedId: "fav-1" }));
    expect(await screen.findByRole("heading", { name: "Monthly - Sam" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Customize" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(invokeCalls.filter((c) => c.cmd === "list_saved_reports").length).toBe(2));
    expect(screen.getByTestId("accounts")).toHaveTextContent("a-2");
    expect(saved).toHaveLength(1);
  });

  it("tells the shell only the saved report itself, not its stand-in, for Back to come back to", async () => {
    saved = [{ ...savedFromSpec(specFor("income_and_spending"), "Monthly"), id: "fav-1" }];
    const onSpecChange = vi.fn();
    render(<ReportsView initialOpen={{ kind: "", savedId: "fav-1" }} onOpenAccount={() => {}} onOpenTransaction={() => {}} onSpecChange={onSpecChange} />);
    await screen.findByRole("heading", { name: "Monthly" });
    await waitFor(() => expect(onSpecChange).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "income_and_spending" })));
    expect(onSpecChange.mock.calls.every(([s]) => s?.kind !== "")).toBe(true);
  });

  it("says so when the saved report asked for is no longer in the file", async () => {
    await act(async () => {
      render(view({ kind: "", savedId: "gone" }));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("no longer in this file");
  });
});

describe("the gallery menus", () => {
  const items = () => screen.getAllByRole("menuitem").map((i) => i.textContent);

  beforeEach(() => {
    setIpcHandlers({
      list_reports: () => [{ kind: "net_worth", label: "Net worth", group: "Net worth and balances" }],
      list_saved_reports: () => [...saved],
      list_categories: () => [],
      get_all_accounts: () => [],
      save_report: (args) => {
        const r = { ...(args.report as SavedReport), id: (args.report as SavedReport).id || "saved-new" };
        saved = [...saved.filter((s) => s.id !== r.id), r];
        return r;
      },
      delete_saved_report: (args) => {
        saved = saved.filter((s) => s.id !== args.id);
        return null;
      },
    });
  });

  it("a gallery report: Open, Customize…, Add to my favorite reports", async () => {
    render(view(null));
    fireEvent.contextMenu(await screen.findByRole("button", { name: "Net worth" }));
    expect(items()).toEqual(["Open", "Customize…", "Add to my favorite reports"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "Add to my favorite reports" }));
    await waitFor(() => expect(saved.map((s) => s.name)).toEqual(["Net worth"]));
  });

  it("Open opens the report", async () => {
    render(view(null));
    fireEvent.contextMenu(await screen.findByRole("button", { name: "Net worth" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Open" }));
    expect(await screen.findByRole("heading", { name: "net_worth" })).toBeInTheDocument();
  });

  it("Customize… opens the report with its Customize panel already showing", async () => {
    render(view(null));
    fireEvent.contextMenu(await screen.findByRole("button", { name: "Net worth" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Customize…" }));
    expect(await screen.findByRole("heading", { name: "net_worth" })).toBeInTheDocument();
    expect(screen.getByText("Customize panel is showing")).toBeInTheDocument();
  });

  it("plain Open leaves the Customize panel closed", async () => {
    render(view(null));
    fireEvent.contextMenu(await screen.findByRole("button", { name: "Net worth" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Open" }));
    expect(await screen.findByRole("heading", { name: "net_worth" })).toBeInTheDocument();
    expect(screen.queryByText("Customize panel is showing")).toBeNull();
  });

  it("a favorite: Open, Customize…, Rename…, Remove", async () => {
    saved = [{ ...savedFromSpec(specFor("net_worth"), "Mine"), id: "fav-1" }];
    render(view(null));
    fireEvent.contextMenu(await screen.findByRole("button", { name: "Mine" }));
    expect(items()).toEqual(["Open", "Customize…", "Rename…", "Remove from my favorites"]);

    const prompt = vi.spyOn(window, "prompt").mockReturnValue("Renamed");
    await userEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));
    await waitFor(() => expect(saved[0].name).toBe("Renamed"));
    expect(saved[0].id).toBe("fav-1");
    prompt.mockRestore();

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.contextMenu(await screen.findByRole("button", { name: "Renamed" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Remove from my favorites" }));
    await waitFor(() => expect(saved).toHaveLength(0));
    confirm.mockRestore();
  });
});
