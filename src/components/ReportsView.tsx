// Reports — Money's "View a report" page: My favorites, then the gallery in its
// groups, Monthly reports for the last twelve months, and one viewer for
// whichever report is open.
import { useEffect, useState } from "react";
import ReportViewer, { savedFromSpec, specFromSaved, type ReportSpec } from "./ReportViewer";
import TmIcon from "./TmIcon";
import Notice from "./Notice";
import ContextMenu, { useContextMenu } from "./ContextMenu";
import { api } from "../lib/ipc";
import { today } from "../lib/format";
import { monthRange, monthTitle, recentMonths, resolveRange } from "../lib/reportRanges";
import { useAccountStore } from "../stores/useAccountStore";
import type { ReportGalleryEntry, SavedReport } from "../lib/types";

/** A report to open, optionally scoped and dated (the Taxes tab). */
export interface ReportOpen {
  kind: string;
  categoryIds?: string[];
  accountIds?: string[];
  from?: string;
  to?: string;
  /** Opened from the Taxes tab: only tax-included accounts. */
  taxScope?: boolean;
  /** Favorites → Favorite reports names a SAVED report by id. The saved
   *  row carries the whole spec, so it is resolved here rather than
   *  reconstructed from a kind. */
  savedId?: string;
  /** Only these payees: Payees → Show transactions. */
  payeeIds?: string[];
  /** A RANGE_OPTIONS id, when `from`/`to` are not given ("all_dates"). */
  rangeId?: string;
}

interface Props {
  /** A report to open straight away (the rail's Spending / Net Worth). A
   *  fresh object each time, so the same item twice re-opens it. */
  initialOpen?: ReportOpen | null;
  onOpenAccount: (accountId: string) => void;
  onOpenTransaction: (accountId: string | null, transactionId: string) => void;
  /** A saved report was added, changed or removed — the Favorites menu
   *  lists them too. */
  onSavedReportsChanged?: () => void;
}

/** The range a report opens with. Balances are "as of" and want the whole
 *  year; comparisons want a month; everything else, this year so far. */
export function defaultRangeFor(kind: string): string {
  if (kind.endsWith("_comparison")) return "last_month";
  if (kind === "monthly_budget") return "this_month";
  if (["net_worth_over_time", "account_balance_history", "credit_card_debt", "income_spending_over_time", "monthly_income_expenses", "annual_budget"].includes(kind)) return "last_12_months";
  if (["scheduled_bills", "upcoming_bills"].includes(kind)) return "this_month";
  if (kind === "subscriptions") return "last_24_months";
  return "year_to_date";
}

export function specFor(kind: string, rangeId = defaultRangeFor(kind)): ReportSpec {
  // The rail's "This Month's Report" is Money's monthly report for the
  // current month — Income and spending over exactly that month.
  if (kind === "monthly_report") {
    return { kind: "income_and_spending", rangeId: "custom", range: monthRange(today().slice(0, 7)), accountIds: [], categoryIds: [], compare: null };
  }
  return { kind, rangeId, range: resolveRange(rangeId, today()), accountIds: [], categoryIds: [], compare: null };
}

/** `specFor`, with the scope and dates an opener asked for. */
export function specForOpen(o: ReportOpen): ReportSpec {
  const base = o.rangeId && o.rangeId !== "custom" ? specFor(o.kind, o.rangeId) : specFor(o.kind);
  if (o.from && o.to) {
    base.rangeId = "custom";
    base.range = { from: o.from, to: o.to };
  }
  if (o.payeeIds) base.payeeIds = o.payeeIds;
  if (o.categoryIds) base.categoryIds = o.categoryIds;
  if (o.accountIds) base.accountIds = o.accountIds;
  if (o.taxScope) base.taxScope = true;
  return base;
}

export default function ReportsView({ initialOpen = null, onOpenAccount, onOpenTransaction, onSavedReportsChanged }: Props) {
  const [gallery, setGallery] = useState<ReportGalleryEntry[]>([]);
  const [spec, setSpec] = useState<ReportSpec | null>(initialOpen ? specForOpen(initialOpen) : null);
  // My favorites: saved, named, customized reports, kept in the file.
  const [favorites, setFavorites] = useState<SavedReport[]>([]);
  const [favoritesLoaded, setFavoritesLoaded] = useState(false);
  // A saved report opened from the Favorites menu, still waiting for the
  // saved list to arrive. Null once it has been resolved (or was never asked).
  const [pendingSavedId, setPendingSavedId] = useState<string | null>(initialOpen?.savedId ?? null);
  const [error, setError] = useState<string | null>(null);
  // Open straight into Customize, from the gallery's right-click menu.
  const [customizeFirst, setCustomizeFirst] = useState(false);
  const favMenu = useContextMenu<SavedReport>();
  const galleryMenu = useContextMenu<ReportGalleryEntry>();
  const loadCategories = useAccountStore((s) => s.loadCategories);
  const loadAccounts = useAccountStore((s) => s.loadAccounts);

  async function loadFavorites() {
    try {
      setFavorites(await api.listSavedReports());
      setFavoritesLoaded(true);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    api.listReports().then(setGallery).catch((e) => setError(String(e)));
    void loadFavorites();
    void loadCategories();
    void loadAccounts();
  }, [loadCategories, loadAccounts]);

  // Only a NEW opener resets the viewer. This effect used to depend
  // on `favorites` too, and saving a report reloads favorites: the report
  // on screen was thrown back to the one the rail opened, losing the
  // customizing just saved and the saved id the viewer had been given — so
  // the next Save made a second favorite instead of updating the first.
  useEffect(() => {
    if (!initialOpen) {
      setPendingSavedId(null);
      setSpec(null);
      return;
    }
    // A saved report opened from the Favorites menu. Its spec is in the
    // file, so wait for the saved list rather than guessing at a kind.
    if (initialOpen.savedId) {
      setPendingSavedId(initialOpen.savedId);
      return;
    }
    setPendingSavedId(null);
    setSpec(specForOpen(initialOpen));
  }, [initialOpen]);

  // …and the saved report is resolved once, when the list is there — not
  // again on every later reload of it.
  useEffect(() => {
    if (!pendingSavedId || !favoritesLoaded) return;
    const saved = favorites.find((f) => f.id === pendingSavedId);
    setPendingSavedId(null);
    if (saved) {
      setError(null);
      setSpec(specFromSaved(saved));
    } else {
      setSpec(null);
      setError("That saved report is no longer in this file.");
    }
  }, [pendingSavedId, favorites, favoritesLoaded]);

  function openReport(next: ReportSpec, customize = false) {
    setCustomizeFirst(customize);
    setSpec(next);
  }

  /** Ask for a new name, then store the report under it. The saved row carries
   *  its whole spec, so renaming is a save with the same id. */
  async function renameFavorite(r: SavedReport) {
    const name = window.prompt("Rename this favorite report", r.name)?.trim();
    if (!name || name === r.name) return;
    try {
      await api.saveReport({ ...r, name });
      await loadFavorites();
      onSavedReportsChanged?.();
    } catch (e) {
      setError(`Could not rename it: ${e}`);
    }
  }

  async function removeFavorite(r: SavedReport) {
    if (!window.confirm(`Remove "${r.name}" from My favorites?`)) return;
    try {
      await api.deleteSavedReport(r.id);
      await loadFavorites();
      onSavedReportsChanged?.();
    } catch (e) {
      setError(`Could not remove it from My favorites: ${e}`);
    }
  }

  /** A gallery report, with its usual range, kept under its own name. */
  async function addToFavorites(e: ReportGalleryEntry) {
    try {
      await api.saveReport(savedFromSpec(specFor(e.kind), e.label));
      await loadFavorites();
      onSavedReportsChanged?.();
    } catch (err) {
      setError(`Could not add it to My favorites: ${err}`);
    }
  }

  if (spec) {
    return (
      <ReportViewer
        customizeOnOpen={customizeFirst}
        spec={spec}
        onSpec={setSpec}
        onOpenAccount={onOpenAccount}
        onOpenTransaction={onOpenTransaction}
        onBack={() => {
          setCustomizeFirst(false);
          setSpec(null);
        }}
        onSave={async (r) => {
          const stored = await api.saveReport(r);
          await loadFavorites();
          onSavedReportsChanged?.();
          return stored;
        }}
        onDeleteSaved={async (id) => {
          await api.deleteSavedReport(id);
          await loadFavorites();
          onSavedReportsChanged?.();
        }}
      />
    );
  }

  const groups: string[] = [];
  for (const g of gallery) if (!groups.includes(g.group)) groups.push(g.group);
  const months = recentMonths(today(), 12);

  return (
    <div>
      <h1 className="tm-report-title flex items-center gap-2">
        <TmIcon name="reports" size={20} /> View a report
      </h1>
      {error && (
        <Notice tone="error" boxed className="my-2">
          {error}
        </Notice>
      )}
      {favMenu.menu && (
        <ContextMenu
          x={favMenu.menu.x}
          y={favMenu.menu.y}
          label="Favorite report actions"
          onClose={favMenu.close}
          items={[
            { label: "Open", onSelect: () => openReport(specFromSaved(favMenu.menu!.target)) },
            { label: "Customize…", onSelect: () => openReport(specFromSaved(favMenu.menu!.target), true) },
            { label: "Rename…", separatorBefore: true, onSelect: () => void renameFavorite(favMenu.menu!.target) },
            { label: "Remove from my favorites", onSelect: () => void removeFavorite(favMenu.menu!.target) },
          ]}
        />
      )}
      {galleryMenu.menu && (
        <ContextMenu
          x={galleryMenu.menu.x}
          y={galleryMenu.menu.y}
          label="Report actions"
          onClose={galleryMenu.close}
          items={[
            { label: "Open", onSelect: () => openReport(specFor(galleryMenu.menu!.target.kind)) },
            { label: "Customize…", onSelect: () => openReport(specFor(galleryMenu.menu!.target.kind), true) },
            { label: "Add to my favorite reports", separatorBefore: true, onSelect: () => void addToFavorites(galleryMenu.menu!.target) },
          ]}
        />
      )}
      <div className="tm-report-gallery pt-2">
        <section className="aero-card">
          <div className="aero-card-title">My favorites</div>
          <ul>
            {favorites.length === 0 && (
              <li className="tm-text-muted" style={{ listStyle: "none" }}>
                Open a report, customize it, and choose “Add to my favorite reports”.
              </li>
            )}
            {favorites.map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => openReport(specFromSaved(r))} onContextMenu={(e) => favMenu.open(e, r)}>{r.name}</button>
              </li>
            ))}
          </ul>
        </section>
        {groups.map((g) => (
          <section className="aero-card" key={g}>
            <div className="aero-card-title">{g}</div>
            <ul>
              {gallery.filter((e) => e.group === g).map((e) => (
                <li key={e.kind}>
                  <button type="button" onClick={() => openReport(specFor(e.kind))} onContextMenu={(ev) => galleryMenu.open(ev, e)}>{e.label}</button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <section className="aero-card">
          <div className="aero-card-title">Monthly reports</div>
          <ul>
            {months.map((ym, i) => (
              <li key={ym}>
                <button
                  type="button"
                  onClick={() => setSpec({ ...specFor("income_and_spending", "custom"), range: monthRange(ym) })}
                >
                  Report for {monthTitle(ym)}{i === 0 ? " (in progress)" : ""}
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
