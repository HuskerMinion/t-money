// Budget / spending UI state, synchronized with the Rust backend.
import { create } from "zustand";
import { api } from "../lib/ipc";
import { currentMonth } from "../lib/format";
import type { Budget, CategoryBudget } from "../lib/types";

interface BudgetState {
  month: string;
  summary: CategoryBudget[];
  loading: boolean;
  error: string | null;

  loadSummary: (month?: string) => Promise<void>;
  setMonth: (month: string) => Promise<void>;
  setBudget: (categoryId: string, targetCents: number) => Promise<void>;
  removeBudget: (id: string) => Promise<void>;
  /** Budgets for the current month, for the manager's edit/delete list. */
  budgets: Budget[];
  loadBudgets: () => Promise<void>;
}

let latestSummary = 0;

export const useBudgetStore = create<BudgetState>((set, get) => ({
  month: currentMonth(),
  summary: [],
  budgets: [],
  loading: false,
  error: null,

  loadSummary: async (month) => {
    const m = month ?? get().month;
    // §183 — which request's answer still counts. Stepping ‹ › quickly sends
    // one summary per month, and a slow reply for the month you left used to
    // land last and put its figures under the new month's heading.
    const mine = ++latestSummary;
    set({ loading: true, error: null, month: m });
    try {
      const summary = await api.getSpendingSummary(m);
      if (mine !== latestSummary) return;
      set({ summary, loading: false });
    } catch (e) {
      if (mine !== latestSummary) return;
      // The old month's rows go too: an error over last month's figures reads
      // as this month's figures with a warning.
      set({ summary: [], error: String(e), loading: false });
    }
  },

  setMonth: async (month) => {
    await get().loadSummary(month);
  },

  setBudget: async (categoryId, targetCents) => {
    await api.setBudget(categoryId, targetCents, get().month);
    await get().loadSummary();
    await get().loadBudgets();
  },

  removeBudget: async (id) => {
    await api.deleteBudget(id);
    await get().loadSummary();
    await get().loadBudgets();
  },

  loadBudgets: async () => {
    try {
      const budgets = await api.listBudgets(get().month);
      set({ budgets });
    } catch (e) {
      set({ error: String(e) });
    }
  },
}));
