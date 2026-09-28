// §183 — the budget store's month summary. Stepping months quickly sends one
// request per month; only the last one asked for may land.
import { beforeEach, describe, expect, it } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

import { useBudgetStore } from "./useBudgetStore";
import { resetIpc, setIpcHandlers } from "../test/tauriMock";
import type { CategoryBudget } from "../lib/types";

const initial = useBudgetStore.getState();

beforeEach(() => {
  resetIpc();
  useBudgetStore.setState(initial, true);
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const line = (name: string) => ({ category_name: name }) as unknown as CategoryBudget;

describe("§183 — loadSummary ignores a stale reply", () => {
  it("a slow answer for the month you left does not overwrite the month you are on", async () => {
    const slow = deferred<CategoryBudget[]>();
    setIpcHandlers({
      get_spending_summary: (args) => (args.month === "2026-08" ? slow.promise : [line("September")]),
    });
    const first = useBudgetStore.getState().loadSummary("2026-08");
    await useBudgetStore.getState().loadSummary("2026-09");
    slow.resolve([line("August")]);
    await first;
    const s = useBudgetStore.getState();
    expect(s.month).toBe("2026-09");
    expect(s.summary).toEqual([line("September")]);
    expect(s.loading).toBe(false);
  });

  it("a failed load keeps the error and drops the old month's rows", async () => {
    setIpcHandlers({ get_spending_summary: () => [line("August")] });
    await useBudgetStore.getState().loadSummary("2026-08");
    setIpcHandlers({
      get_spending_summary: () => {
        throw new Error("database is locked");
      },
    });
    await useBudgetStore.getState().loadSummary("2026-09");
    const s = useBudgetStore.getState();
    expect(s.error).toContain("database is locked");
    expect(s.summary).toEqual([]);
  });
});
