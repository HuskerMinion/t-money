// T-Money main application shell: Aero header + slate sidebar + content area.
// The Home tab shows the dashboard widgets; Banking shows accounts + a
// quick-add transaction form. All data flows through Tauri IPC.
import { useEffect, useState, useSyncExternalStore } from "react";
import { accountWorth } from "./lib/accountTypes";
import { currencyOf } from "./lib/currency";
import AeroHeader, { type Tab } from "./components/AeroHeader";
import MenuBar, { useMenuAccelerators } from "./components/MenuBar";
import { buildMenus } from "./lib/menus";
import { useCommand } from "./lib/useCommand";
import { runCommand } from "./lib/commands";
import { forgetUndo, onUndoChange, redoLast, refreshUndo, undoLast, undoStatus } from "./lib/undo";
import KeyPromptDialog from "./components/KeyPromptDialog";
import NewFileFormatDialog from "./components/NewFileFormatDialog";
import { useFileFormat } from "./lib/region";
import { fileNameOf, keyProblem } from "./lib/keyError";
import AeroSidebar from "./components/AeroSidebar";
import { clampRail, loadRailWidth, RAIL_DEFAULT, RAIL_MAX, RAIL_MIN, saveRailWidth } from "./lib/railWidth";
import FavoriteAccountsWidget from "./components/FavoriteAccountsWidget";
import SpendingTrackerWidget from "./components/SpendingTrackerWidget";
import SubscriptionsWidget from "./components/SubscriptionsWidget";
import HelpView from "./components/HelpView";
import { topicForTab } from "./help/topics";
import AccountRegister from "./components/AccountRegister";
import AccountListView from "./components/AccountListView";
import NewAccountWizard from "./components/NewAccountWizard";
import SearchResults from "./components/SearchResults";
import AccountDetailsDialog from "./components/AccountDetailsDialog";
import MergeAccountsDialog from "./components/MergeAccountsDialog";
import AutobudgetDialog from "./components/AutobudgetDialog";
import ImportSection from "./components/ImportSection";
import PaymentsView from "./components/PaymentsView";
import ReportsView, { type ReportOpen } from "./components/ReportsView";
import TaxesView from "./components/TaxesView";
import InvestmentsView from "./components/InvestmentsView";
import GoalsView from "./components/GoalsView";
import DebtPlannerView from "./components/DebtPlannerView";
import SettingsView, { aimSettingsAt, runInSettings } from "./components/SettingsView";
import CalculatorDialog from "./components/CalculatorDialog";
import TspImportDialog from "./components/TspImportDialog";
import ApplyPayeeRulesDialog from "./components/ApplyPayeeRulesDialog";
import OrganizeFavoritesDialog from "./components/OrganizeFavoritesDialog";
import CategoriesView from "./components/CategoriesView";
import ClassificationsView from "./components/ClassificationsView";
import PayeesView from "./components/PayeesView";
import CategorySelect from "./components/CategorySelect";
import Money from "./components/Money";
import Notice from "./components/Notice";
import { api } from "./lib/ipc";
import { localNow, refreshIsDue } from "./lib/prices";
import type { Account } from "./lib/types";
import { useAccountStore } from "./stores/useAccountStore";
import { useBudgetStore } from "./stores/useBudgetStore";
import { parseMoneyToCents } from "./lib/format";
import { applyZoom, readZoom } from "./lib/zoom";
import { applyTheme, readTheme } from "./lib/theme";
import { applyLook, readLook, structureOf } from "./lib/layout";
import Ribbon from "./components/Ribbon";
import AccountsPane from "./components/AccountsPane";
import DocumentTabs from "./components/DocumentTabs";
import WatchPane from "./components/WatchPane";
import BudgetView from "./components/BudgetView";
import YearPlanView from "./components/YearPlanView";
import StartScreen from "./components/StartScreen";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";

// Map a sidebar item id (or its "More ▶" detail id) to the header tab it
// belongs to. This is what makes the left-rail items actually navigate —
// previously they only set a `side` state that nothing rendered.
function sidebarToTab(id: string): Tab {
  // Payees is a Banking screen in Money (Tools → Categories & Payees), not a
  // Bills one — the rail item lives under Bills, the screen does not.
  if (id === "payees") return "Banking";
  if (id === "bills" || id === "Bills-detail") return "Bills";
  if (id === "spending" || id === "networth" || id === "income-expenses" || id === "monthly-report" || id === "Reports-detail") return "Reports";
  if (id === "budget" || id === "categories" || id === "classifications" || id === "Budget-detail") return "Budget";
  // accounts, transactions, reconcile, Banking-detail → Banking
  return "Banking";
}

/** Which screen inside the Banking tab a rail item opens. */
export type BankingScreen = "list" | "register" | "payees";
/** Which screen inside the Budget tab a rail item opens. */
export type BudgetScreen = "budget" | "categories" | "classifications";

export default function App() {
  const [tab, setTab] = useState<Tab>("Home");
  /** Is ANY file open? False after File → Close, and then the start
   *  screen is what the window contains: no rail, no tabs, nothing that would
   *  query a database that is not there. */
  const [fileOpen, setFileOpen] = useState(true);
  /** The file that was open when it was closed, offered back by name. */
  const [lastFile, setLastFile] = useState<{ path: string; name: string } | null>(null);

  // The Help topic to open — set by F1 (the tab you were on) or left
  // null so the Help tab keeps its place.
  const [helpTopic, setHelpTopic] = useState<string | null>(null);
  const [tabEpoch, setTabEpoch] = useState(0);
  // F1 used to be bound here AND is now printed beside Help → T-Money
  // Help, so the menu's accelerator table owns it. Two handlers for one key
  // is how a shortcut and its label drift apart.
  const [side, setSide] = useState("accounts");
  // Sub-screens live in App so a rail click can open one directly.
  const [bankingScreen, setBankingScreen] = useState<BankingScreen>("list");

  /** Open an account's register — the one path in, used by the left rail and
   *  by the Home tab's Favorite Accounts card.
   *
   *  Selecting an account is not the same as going to look at it: the
   *  favorites card used to call `selectAccount` alone, so clicking a
   *  favorite quietly changed the selection and left the user on Home
   *  wondering why nothing happened. */
  function openAccountRegister(id: string) {
    void selectAccountFromRail(id);
    setSide("accounts");
    setTab("Banking");
    setBankingScreen("register");
  }
  const [budgetScreen, setBudgetScreen] = useState<BudgetScreen>("budget");
  // The header's Search box. A query opens the Search screen; a hit
  // opens its register with the row selected — the same "go and look at
  // it" path every other way into the register uses.
  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  // Which report the Reports tab should open with (rail Spending / Net Worth).
  const [reportOpen, setReportOpen] = useState<ReportOpen | null>(null);
  const setReportKind = (kind: string | null) => setReportOpen(kind ? { kind } : null);
  function runSearch(q: string) {
    setSearchQuery(q);
    setTab("Search");
  }
  function openSearchHit(hit: { id: string; account_id: string }) {
    useAccountStore.getState().focusRow(hit.id);
    openAccountRegister(hit.account_id);
  }
  /** A report row's transaction: find its account, then open the register
   *  on it. Reports carry the transaction id but not its account. */
  async function openTransaction(accountId: string | null, txnId: string) {
    setNavError(null);
    let acct = accountId;
    if (!acct) {
      try {
        const t = await api.getTransactionAccount(txnId);
        acct = t;
      } catch (e) {
        // The row was deleted (or merged away) since the report ran.
        // Returning quietly made the click look dead.
        setNavError(`That transaction could not be opened — it may have been deleted since the report ran. (${String(e)})`);
        return;
      }
    }
    if (!acct) {
      setNavError("That transaction could not be opened — it may have been deleted since the report ran.");
      return;
    }
    useAccountStore.getState().focusRow(txnId);
    openAccountRegister(acct);
  }
  /** A way in that led nowhere (a report row whose transaction is
   *  gone). Shown in the shell, under the menu bar, like the file banner. */
  const [navError, setNavError] = useState<string | null>(null);

  const sidebarAccounts = useAccountStore((s) => s.accounts);
  const [railWidth, setRailWidth] = useState(() => loadRailWidth());
  function setRail(px: number) {
    const w = clampRail(px);
    setRailWidth(w);
    saveRailWidth(w);
  }
  const sidebarSelectedId = useAccountStore((s) => s.selectedAccountId);
  const selectAccountFromRail = useAccountStore((s) => s.selectAccount);
  const loadAccounts = useAccountStore((s) => s.loadAccounts);
  const loadFavorites = useAccountStore((s) => s.loadFavorites);
  const loadSummary = useBudgetStore((s) => s.loadSummary);

  // Initial data load on mount; the remembered text size goes on first.
  useEffect(() => {
    void applyZoom(readZoom());
    applyTheme(readTheme());
    applyLook(readLook());
    loadAccounts();
    loadFavorites();
    loadSummary();
  }, [loadAccounts, loadFavorites, loadSummary]);

  // Sidebar click: remember the item (for highlight) AND navigate to its tab.
  function handleSideSelect(id: string) {
    setSide(id);
    setTab(sidebarToTab(id));
    if (id === "payees") setBankingScreen("payees");
    if (id === "accounts") setBankingScreen("list");
    // "Transactions" is the register, not the account list — the two rail
    // items used to land in the same place. With no
    // account selected yet, the first one is.
    //
    // The first OPEN one. `accounts[0]` is whatever sorts first, and
    // since closed accounts are kept off the rail that could be an account
    // the rail does not even list.
    if (id === "transactions") {
      const st = useAccountStore.getState();
      const first = st.accounts.find((a) => !a.is_closed);
      if (!st.selectedAccountId && first) void st.selectAccount(first.id);
      setBankingScreen(st.selectedAccountId || first ? "register" : "list");
    }
    if (id === "categories") setBudgetScreen("categories");
    if (id === "classifications") setBudgetScreen("classifications");
    if (id === "budget") setBudgetScreen("budget");
    // The rail's report items are specific destinations, not "Reports".
    if (id === "spending") setReportKind("spending_by_category");
    if (id === "networth") setReportKind("net_worth");
    if (id === "income-expenses") setReportKind("monthly_income_expenses");
    if (id === "monthly-report") setReportKind("monthly_report");
    if (id === "Reports-detail") setReportKind(null);
    // "Reconcile" is a verb, not a destination — it starts balancing the
    // selected account rather than just switching tabs. The register is the
    // only thing that consumes the request, so it has to be on screen: with
    // no account selected the rail lands on the Account List instead, and
    // does NOT leave a request armed to pop the wizard open, unasked, the
    // next time any register is opened.
    if (id === "reconcile") {
      if (useAccountStore.getState().selectedAccountId) {
        setBankingScreen("register");
        useAccountStore.getState().requestReconcile();
      } else {
        setBankingScreen("list");
      }
    }
  }

  // The menu bar. The shell serves the commands that ARE the shell:
  // navigation, and the things that live in no particular screen. Everything
  // else is registered by whoever owns it (the register prints, the Portfolio
  // updates prices), which is what lets the menu gray out honestly.
  const favoriteAccounts = useAccountStore((s) => s.favorites);
  const [savedReports, setSavedReports] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    void api
      .listSavedReports()
      .then((rs) => setSavedReports(rs.map((r) => ({ id: r.id, name: r.name }))))
      .catch(() => setSavedReports([]));
  }, []);

  const goTab = (t: Tab) => {
    setReportKind(null);
    setHelpTopic(null);
    setTabEpoch((e) => e + 1);
    setTab(t);
  };

  // Settings is a pop-up now, not a tab: it is a thing you go and do
  // and come back from, and losing the screen you were on to reach it was
  // always the wrong trade.
  const [settingsOpen, setSettingsOpen] = useState(false);
  useCommand("tools.settings", () => setSettingsOpen(true), fileOpen);
  // Escape closes it, the way every other dialog in the app closes. Bound
  // while it is open only, so it never eats an Escape meant for the register.
  useEffect(() => {
    if (!settingsOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setSettingsOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen]);
  /** A menu item for something that lives inside Settings opens
   *  Settings ON that pane. "Opens Settings, now go and find it" is the kind
   *  of wiring a user reads as broken. */
  const openSettingsAt = (group: Parameters<typeof aimSettingsAt>[0], pane: string) => {
    aimSettingsAt(group, pane);
    setSettingsOpen(true);
  };
  useCommand("file.restore", () => openSettingsAt("file", "database"), fileOpen);
  useCommand("file.backup.settings", () => openSettingsAt("file", "backup"), fileOpen);
  // File → Back up now and Verify this file were registered by the
  // Settings screen alone, so they were live only while Settings was already
  // open: gray in the menu and on the ribbon nearly all the time. The shell
  // serves them now by opening Settings on the pane and asking it to run the
  // thing — the result belongs on that pane, beside the controls for it.
  // Settings registers both at a higher priority while it is open.
  useCommand("file.backup", () => {
    runInSettings("backup");
    openSettingsAt("file", "backup");
  }, fileOpen);
  useCommand("file.verify", () => {
    runInSettings("verify");
    openSettingsAt("file", "verify");
  }, fileOpen);

  // Cut / Copy / Paste. These belong to whatever has focus, not to the app —
  // so the menu simply asks the document to do what Ctrl+X already does, and
  // the browser applies it to the focused field. Paste needs the async
  // clipboard because `execCommand("paste")` is refused everywhere for
  // security; it is inserted at the caret rather than replacing the field.
  const focusedField = (): HTMLInputElement | HTMLTextAreaElement | null => {
    const el = document.activeElement;
    return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el : null;
  };
  useCommand("edit.cut", () => {
    document.execCommand("cut");
  });
  useCommand("edit.copy", () => {
    // With nothing selected, copy the focused field's whole value — Money
    // does the same, and an Edit → Copy that silently does nothing is worse
    // than one that copies the obvious thing.
    const f = focusedField();
    if (f && f.selectionStart === f.selectionEnd && f.value) {
      void navigator.clipboard?.writeText(f.value).catch(() => {});
      return;
    }
    document.execCommand("copy");
  });
  useCommand("edit.paste", () => {
    void (async () => {
      const f = focusedField();
      if (!f) return;
      try {
        const text = await navigator.clipboard.readText();
        const start = f.selectionStart ?? f.value.length;
        const end = f.selectionEnd ?? f.value.length;
        // Through the native setter, so React's onChange actually fires —
        // assigning `.value` directly updates the DOM and leaves the
        // component's state behind, which is how a pasted amount ends up
        // visible on screen and absent from the transaction.
        const proto = f instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        setter?.call(f, f.value.slice(0, start) + text + f.value.slice(end));
        f.dispatchEvent(new Event("input", { bubbles: true }));
        f.setSelectionRange(start + text.length, start + text.length);
      } catch {
        /* clipboard refused — nothing to paste */
      }
    })();
  });

  // The New family. Each of these screens registers the same command
  // at a higher priority while it is open, so the menu item does the thing
  // when you are already there and BRINGS you there when you are not. Two
  // owners, one command, nearest wins — which is what the priority in the command
  // registry was for.
  useCommand("new.category", () => {
    setSide("categories");
    setBudgetScreen("categories");
    goTab("Budget");
  }, fileOpen);
  useCommand("new.account", () => {
    setSide("accounts");
    setBankingScreen("list");
    goTab("Banking");
  }, fileOpen);
  useCommand("new.payee", () => {
    setSide("payees");
    setBankingScreen("payees");
    goTab("Banking");
  }, fileOpen);
  useCommand("new.goal", () => goTab("Planning"), fileOpen);
  useCommand("new.recurrence", () => {
    setSide("bills");
    goTab("Bills");
  }, fileOpen);
  useCommand("tools.payee.rules", () => {
    setSide("payees");
    setBankingScreen("payees");
    goTab("Banking");
  }, fileOpen);


  // Two menu items that named nothing: Tools → Calculator and
  // Favorites → Organize favorites. Both are small dialogs owned by the shell,
  // because neither belongs to any one screen.
  const [calcOpen, setCalcOpen] = useState(false);
  const [favOpen, setFavOpen] = useState(false);
  useCommand("tools.calculator", () => setCalcOpen(true));
  // File → Import → TSP activity detail. The shell owns it because it
  // is about a file, not about whatever screen you happen to be on.
  const [tspOpen, setTspOpen] = useState(false);
  // The file, when the CSV door sniffed a tsp.gov export and handed
  // it over: the importer opens ON it rather than asking for it a second time.
  const [tspPath, setTspPath] = useState<string | null>(null);
  const [tspDone, setTspDone] = useState<string | null>(null);
  useCommand(
    "import.tsp",
    (arg) => {
      setTspPath(typeof arg === "string" && arg ? arg : null);
      setTspOpen(true);
    },
    fileOpen
  );
  // The payee rules, run backwards over what is already in the file.
  // The shell owns it because it is about the whole file, not one screen.
  const [rulesOpen, setRulesOpen] = useState(false);
  const [rulesDone, setRulesDone] = useState<string | null>(null);
  useCommand("tools.payee.apply", () => setRulesOpen(true), fileOpen);
  useCommand("fav.organize", () => setFavOpen(true), fileOpen);
  // Escape closes whichever is open, bound only while one is (the rule:
  // never eat an Escape meant for the register).
  useEffect(() => {
    if (!calcOpen && !favOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setCalcOpen(false);
      setFavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [calcOpen, favOpen]);

  const openHelp = (topic: string | null) => {
    goTab("Help");
    setHelpTopic(topic);
  };
  useCommand("help.contents", () => openHelp(topicForTab(tab)));
  useCommand("help.shortcuts", () => openHelp("shortcuts"));
  useCommand("help.about", () => setSettingsOpen(true));
  useCommand("tools.categories", () => {
    setSide("categories");
    setBudgetScreen("categories");
    goTab("Budget");
  }, fileOpen);
  // Tools → Classifications, and File → New → Classification. The
  // screen registers `new.classification` at a higher priority while it is
  // open, so the menu item adds one there and comes here otherwise.
  const openClassifications = () => {
    setSide("classifications");
    setBudgetScreen("classifications");
    goTab("Budget");
  };
  useCommand("tools.classifications", openClassifications, fileOpen);
  useCommand("new.classification", openClassifications, fileOpen);
  useCommand("edit.find", () => {
    const box = document.querySelector<HTMLInputElement>(".tm-header-search");
    box?.focus();
    box?.select();
  }, fileOpen);
  useCommand("file.exit", () => {
    void getCurrentWindow().close();
  });

  // T-Money files. Opening one swaps the database under the whole app,
  // so every store is reloaded and the selection is dropped: an account id
  // from the file you just closed means nothing in the one you just opened.
  const [recentFiles, setRecentFiles] = useState<
    { path: string; name: string; exists: boolean; needsKey: boolean }[]
  >([]);
  /** The file waiting on a key, if one is. `wrong` is set after a key
   *  was tried and refused, so the dialog says so rather than looking like it
   *  ignored the press. */
  const [keyPrompt, setKeyPrompt] = useState<{ path: string; name: string; wrong: boolean } | null>(
    null
  );
  const [fileName, setFileName] = useState<string | null>(null);
  /** The open file's full path — what the start screen offers back. */
  const [filePath, setFilePath] = useState<string>("");
  /** Is this T-Money's own database? File → Close has nothing to do
   *  when it is, and a menu item that grays out says that better than one
   *  that quietly does nothing. */
  const [fileIsDefault, setFileIsDefault] = useState(true);
  const [fileError, setFileError] = useState<string | null>(null);
  // The price timer. It lives here because it must outlive whichever
  // screen is open, and it is the whole of "automatic": a check every half
  // hour WHILE THE APP IS RUNNING, which fetches only when the interval the
  // user chose has actually elapsed. Off by default, so a file that never
  // visits Settings never reaches the network on its own.
  //
  // And a check the moment a FILE is open, not only the moment the
  // app mounts. The check at mount was the "fetch at launch" originally
  // asked for, and since an earlier change it usually ran against nothing: launch lands
  // on the start screen more often than not, the file is opened a moment
  // later by hand, and the first check that saw it was the half-hour tick.
  // Someone who opens the app monthly opened it to a portfolio priced a
  // month ago and waited thirty minutes for it to notice. So the effect
  // follows the file: it starts when one is open, restarts when a different
  // one is opened, and stops when there is none.
  useEffect(() => {
    // `filePath` is empty until `refreshFiles` has asked the backend what is
    // open, and `fileOpen` is optimistically true before that — so waiting
    // for the path is what makes this a check of a KNOWN file, once, rather
    // than one at mount against nothing and another a moment later.
    if (!fileOpen || !filePath) return;
    let stopped = false;
    async function check() {
      try {
        const status = await api.priceStatus();
        // Local time, as the backend stamps `last_auto` — never UTC.
        if (stopped || !refreshIsDue(status, localNow())) return;
        // `auto` stamps the run, so a machine that is offline all week asks
        // once a day rather than every half hour.
        await api.refreshInvestmentPrices(true);
        await useAccountStore.getState().loadAccounts();
      } catch {
        // No network, nothing priced: both are ordinary, and neither is
        // worth interrupting anyone over.
      }
    }
    void check();
    const timer = setInterval(() => void check(), 30 * 60 * 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [fileOpen, filePath]);

  // The open file's home currency and region. Every formatter reads them
  // when it runs, so they are in place before the screens draw, and <main> is
  // keyed on them so a change redraws what is already up.
  const format = useFileFormat((s) => `${s.home}|${s.region.code}`);
  const loadFormat = async (open: boolean) => {
    if (!open) {
      useFileFormat.getState().reset();
      return;
    }
    try {
      useFileFormat.getState().setFormat(await api.getFileFormat());
    } catch (e) {
      // Shown, not swallowed: a euro file drawn in dollars would mislead.
      useFileFormat.getState().reset();
      setFileError(`This file's currency and region could not be read, so amounts show in US dollars: ${String(e)}`);
    }
  };

  const refreshFiles = async () => {
    try {
      const [cur, list] = await Promise.all([api.currentFile(), api.listRecentFiles()]);
      await loadFormat(cur.isOpen !== false);
      setFileName(cur.name);
      setFilePath(cur.path);
      setFileIsDefault(cur.isDefault);
      // Only an explicit `false` closes the shell. A missing field — an older
      // backend, a mock, a response that arrived half-formed — must never be
      // the reason this app hides your accounts behind a start screen.
      const open = cur.isOpen !== false;
      setFileOpen(open);
      setLastFile(open ? null : { path: cur.path, name: cur.name });
      // The file's name belongs in the window title, and nowhere else.
      //
      // It is what every document application does, it costs no screen space
      // in an app whose whole business is dense rows of numbers, and it is
      // where the taskbar and Alt-Tab read from — which is the moment you
      // actually need to know which file you are in, when two are open.
      // Putting it in the chrome would spend a permanent strip of the window
      // on something you look at twice a day.
      void getCurrentWindow()
        .setTitle(!open ? "T-Money — no file open" : cur.isDefault ? "T-Money" : `${cur.name} — T-Money`)
        .catch(() => {
          /* a title we cannot set is not worth an error */
        });
      setRecentFiles(
        list.map((f) => ({ path: f.path, name: f.name, exists: f.exists, needsKey: f.needs_key }))
      );
    } catch {
      /* the file list is a convenience; never block the app on it */
    }
  };
  // A second copy of the app was started, and handed us its file.
  //
  // The single-instance plugin has already swapped the database by the time
  // this arrives; what is left is the same reset every other file change does.
  // It is not `switchTo`, because that would open the file a second time.
  useEffect(() => {
    // `.catch` because `listen` reaches into Tauri's internals: outside the
    // app — a test, a browser preview — it rejects, and an unhandled rejection
    // at mount is noise that hides real ones.
    const stop = listen<{ ok: boolean; error?: string; file?: { name: string } }>(
      "tm://file-opened",
      (e) => {
        void (async () => {
          if (!e.payload.ok) {
            setFileError(e.payload.error ?? "that file could not be opened");
            return;
          }
          setFileError(null);
          leaveFile();
          forgetUndo();
          await loadFile();
        })();
      }
    ).catch(() => null);
    return () => {
      void stop.then((off) => off?.());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void refreshFiles();
    // Did the app fall back to its own database because the file you
    // left it on would not open? Say so, once. A silent fallback is how a
    // week of transactions ends up in the wrong file.
    void api
      .startupNote()
      .then((n) => {
        if (n) setFileError(n);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Swap the database under the whole app.
   *
   *  ORDER MATTERS, and it used to be wrong. The old version opened the new
   *  file first and only then went looking for a neutral screen, so there was
   *  a beat where the register was still mounted, still pointed at an account
   *  id, and the data behind that id had already been replaced. Nothing in
   *  this app should ever be asked to draw a screen belonging to a file that
   *  is no longer open — so we LEAVE first, THEN swap, then load.
   *
   *  And the reset has to be complete. Saved reports, the budget summary and
   *  the open document tabs all live IN the file; each of them was left
   *  behind by the old code, which meant the Favorites menu listed the
   *  previous file's reports and Home showed the previous file's spending. */
  /** Step 1 of any file swap: let go of everything that is about the file
   *  we are leaving, BEFORE it changes underneath us. */
  function leaveFile() {
    // 1) Leave. Every screen that is about one account, one report or one
    //    search is abandoned before the file underneath it changes.
    setSearchQuery(null);
    setReportOpen(null);
    setHelpTopic(null);
    setBankingScreen("list");
    setBudgetScreen("budget");
    setOpenTabs([]);
    setTab("Home");
    // And REMOUNT what is on screen.
    //
    // Everything under <main> is keyed on `tabEpoch`; setting the tab alone
    // leaves those components mounted with the state they loaded from the
    // file you just closed. Reported: a new, empty file opened showing the
    // previous file's Subscriptions, which then vanished the moment you
    // clicked another tab and came back — that is the remount happening
    // late. A widget that fetches its own data (Subscriptions, the Spending
    // Tracker) has to be thrown away, not asked nicely to refresh, because
    // the shell has no idea what any of them cached.
    setTabEpoch((e) => e + 1);
    const store = useAccountStore.getState();
    store.focusRow(null);
    // Synchronously, not via selectAccount() — that fires a register load for
    // an id we are in the middle of abandoning.
    useAccountStore.setState({ selectedAccountId: null, register: [], transactions: [] });
  }

  /** Step 3: load whatever is now open. Everything here lives IN the file. */
  async function loadFile() {
    await loadFormat(true);
    await useAccountStore.getState().reloadAll();
    await useBudgetStore.getState().loadSummary();
    try {
      const rs = await api.listSavedReports();
      setSavedReports(rs.map((r) => ({ id: r.id, name: r.name })));
    } catch {
      setSavedReports([]);
    }
    await refreshFiles();
  }

  async function switchTo(path: string, create: boolean, key?: string, init?: () => Promise<void>) {
    setFileError(null);
    leaveFile();

    // 2) Swap.
    try {
      await api.openFile(path, create, key ?? null);
    } catch (e) {
      // A file from another computer needs its key, and now there is
      // somewhere to put it. This comment used to say exactly that and the
      // call passed `null`, which is how the app spent five sections
      // describing a door it had never fitted a handle to.
      //
      // Only a key problem opens the dialog; anything else is still a banner,
      // because "paste your key" is a useless thing to say about a path that
      // does not exist.
      const problem = keyProblem(e);
      if (problem) {
        setKeyPrompt({ path, name: fileNameOf(path), wrong: problem === "wrong" });
      } else {
        setFileError(String(e));
      }
      // The old file is still open behind us, so reload from it rather than
      // leaving the app looking empty.
      //
      // With nothing open there is nothing to fall back to — the Rust
      // side stayed closed too, so the start screen keeps the error rather
      // than an empty shell pretending a file is there.
      if (fileOpen) await useAccountStore.getState().reloadAll();
      else await refreshFiles();
      return;
    }
    // It opened. Whatever was being asked for is answered.
    setKeyPrompt(null);
    // The backend cleared its undo stack when it swapped the file; drop the
    // label that went with the old one.
    forgetUndo();
    // A new file takes its home currency and region before anything is read.
    if (init) {
      try {
        await init();
      } catch (e) {
        setFileError(String(e));
      }
    }

    // 3) Load the new file. Anything that fails is reported, never thrown at
    //    a render — a fresh file with nothing in it must open cleanly.
    await loadFile();
  }

  /** New, but seeded. The path is chosen the same way; the backend
   *  refuses it if anything is already there, so there is no way to point
   *  this at a real file. */
  async function makeSample() {
    const picked = await saveDialog({
      title: "New sample file with demo data",
      defaultPath: "T-Money Sample.tmny",
      filters: [{ name: "T-Money file", extensions: ["tmny"] }],
    });
    if (typeof picked !== "string") return;
    setFileError(null);
    leaveFile();
    try {
      await api.createSampleFile(picked);
    } catch (e) {
      setFileError(String(e));
      if (fileOpen) await useAccountStore.getState().reloadAll();
      else await refreshFiles();
      return;
    }
    forgetUndo();
    await loadFile();
  }

  useCommand("file.open", async () => {
    const picked = await openDialog({
      title: "Open a T-Money file",
      multiple: false,
      filters: [{ name: "T-Money file", extensions: ["tmny", "db"] }],
    });
    if (typeof picked === "string") await switchTo(picked, false);
  });
  // Close is a swap like any other, so it goes through the same
  // reset. Grayed out when you are already on T-Money's own file: there is
  // nothing to close, and saying so is better than a no-op that looks broken.
  // Close closes. The pool is dropped on the Rust side, so there is
  // nothing left to load: `loadFile` would ask a database that is not there
  // and get NO_FILE back for every call. The screens are torn down first,
  // then the file goes, then the start screen is what is left.
  //
  // It is no longer grayed out on the app's own file: closing that one is
  // exactly as meaningful as closing any other, which is the whole point of
  // the change (an earlier version had it return there instead, and the user could not tell
  // the difference between the two files they had).
  useCommand("file.close", async () => {
    setFileError(null);
    // The shell comes DOWN FIRST, before the await. Tearing it down after
    // the call means every self-fetching widget remounts (the epoch bump)
    // while the file is being closed underneath it, and each one asks a
    // database that is on its way out. Nothing renders, so nothing asks.
    setLastFile({ path: filePath, name: fileName ?? "the file" });
    setFileOpen(false);
    leaveFile();
    // Favorites and the pending row too. `favorites` is a second copy
    // of the accounts (the Home card reads it), and a row id left pending
    // would be "found" in whatever register the next file opens first.
    useAccountStore.setState({
      accounts: [],
      favorites: [],
      categories: [],
      payees: [],
      register: [],
      transactions: [],
      selectedAccountId: null,
      pendingRowId: null,
      error: null,
    });
    // …and the menus that name things IN the file: Favorites lists accounts
    // (they come from the store, cleared above) and saved reports, which do
    // not. A menu still offering "By Category - Sam" with no file open is
    // an item that cannot work.
    setSavedReports([]);
    try {
      await api.closeFile();
    } catch (e) {
      setFileError(String(e));
    }
    forgetUndo();
    // Confirmed from the backend rather than trusting the optimism above: a
    // close that was refused puts the shell back.
    await refreshFiles();
  }, fileOpen);
  useCommand("file.new", async () => {
    const picked = await saveDialog({
      title: "New T-Money file",
      defaultPath: "My Money.tmny",
      filters: [{ name: "T-Money file", extensions: ["tmny"] }],
    });
    if (typeof picked === "string") setNewFile(picked);
  });
  /** The path File → New picked, waiting on its currency and region. */
  const [newFile, setNewFile] = useState<string | null>(null);
  const [newBusy, setNewBusy] = useState(false);
  const createNewFile = async (path: string, f: { home_currency: string; region: string }) => {
    setNewBusy(true);
    try {
      await switchTo(path, true, undefined, async () => {
        // An empty file has no accounts to relabel or keep.
        const now = await api.getFileFormat();
        if (now.home_currency !== f.home_currency) await api.setHomeCurrency(f.home_currency, false);
        if (now.region !== f.region) await api.setRegion(f.region);
      });
    } finally {
      setNewBusy(false);
      setNewFile(null);
    }
  };
  const newFileDialog = newFile && (
    <NewFileFormatDialog
      fileName={fileNameOf(newFile)}
      busy={newBusy}
      onCancel={() => setNewFile(null)}
      onSubmit={(f) => void createNewFile(newFile, f)}
    />
  );
  // A file to look at. Same shape as New, and it lands on a file with
  // three years in it rather than an empty register.
  useCommand("file.sample", makeSample);

  // Undo. The status comes from the backend and is refreshed by the
  // store after every write it makes, so the Edit menu's label is the name of
  // the thing that would actually be undone rather than a bare "Undo".
  const undo = useSyncExternalStore(onUndoChange, undoStatus, undoStatus);
  useEffect(() => {
    void refreshUndo();
  }, []);
  // Undoing changes rows in accounts that may not be the one on screen — the
  // far side of a transfer, the funding row of a buy — so everything is
  // reloaded rather than the current register alone.
  //
  // And the categories, because a merge is undoable now: putting one
  // back restores a row every category picker in the app is holding a stale
  // copy of. The tab epoch goes with it so a screen that fetched its own data
  // — the Budget grid in particular, whose rows ARE categories — refetches
  // instead of showing the merged shape until you leave and come back.
  const afterUndo = async () => {
    const st = useAccountStore.getState();
    await st.loadAccounts();
    await st.loadCategories();
    if (st.selectedAccountId) await st.loadRegister(st.selectedAccountId);
    setTabEpoch((e) => e + 1);
  };
  // A refused step says why. `undoLast` has never thrown, and
  // the shell took its `false` as "nothing happened" and showed nothing, so a
  // refusal from the backend read as Ctrl+Z being a dead key.
  const [undoError, setUndoError] = useState<string | null>(null);
  useCommand(
    "edit.undo",
    async () => {
      setUndoError(null);
      if (await undoLast((m) => setUndoError(`Could not undo: ${m}`))) await afterUndo();
    },
    undo.undo !== null,
  );
  useCommand(
    "edit.redo",
    async () => {
      setUndoError(null);
      if (await redoLast((m) => setUndoError(`Could not redo: ${m}`))) await afterUndo();
    },
    undo.redo !== null,
  );
  // The store has kept an `error` since the beginning and nothing drew
  // it: a register that failed to load was simply an empty register.
  const storeError = useAccountStore((s) => s.error);
  // The key dialog's Open is disabled while the file is being opened;
  // it was never told, so a second press opened the file twice.
  const [keyBusy, setKeyBusy] = useState(false);
  const submitKey = async (path: string, key: string) => {
    setKeyBusy(true);
    try {
      await switchTo(path, false, key);
    } finally {
      setKeyBusy(false);
    }
  };

  const menus = buildMenus({
    undoLabel: undo.undo,
    redoLabel: undo.redo,
    recentFiles,
    openFile: (p) => void switchTo(p, false),
    forgetMissingFiles: () => {
      void (async () => {
        for (const f of recentFiles.filter((x) => !x.exists)) await api.forgetFile(f.path).catch(() => {});
        await refreshFiles();
      })();
    },
    favoriteAccounts: favoriteAccounts.map((a) => ({ id: a.id, name: a.name })),
    savedReports,
    openAccount: openAccountRegister,
    openReport: (id) => {
      setReportOpen({ kind: "saved", savedId: id });
      goTab("Reports");
    },
  });
  useMenuAccelerators(menus);

  // The look decides how the chrome is arranged. Read once and kept in
  // state so Settings can change it without a reload.
  const [look, setLook] = useState(() => readLook());
  useEffect(() => {
    // Settings applies the look to <html> directly; watch for it so the shell
    // rearranges in the same beat rather than on the next navigation.
    const el = document.documentElement;
    const ob = new MutationObserver(() => setLook(el.getAttribute("data-look") ?? "classic"));
    ob.observe(el, { attributes: true, attributeFilter: ["data-look"] });
    return () => ob.disconnect();
  }, []);
  const structure = structureOf(look);

  // Document tabs: the accounts opened this session, oldest first.
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  useEffect(() => {
    if (!sidebarSelectedId) return;
    setOpenTabs((t) => (t.includes(sidebarSelectedId) ? t : [...t, sidebarSelectedId]));
  }, [sidebarSelectedId]);

  // No file open: the menu bar and the start screen, and nothing
  // else. Everything below this line queries a database, so none of it is
  // mounted; the alternative (a shell full of empty panes over a NO_FILE
  // error from every call) is exactly the "failed by showing nothing" that
  // this guard is here to prevent.
  if (!fileOpen) {
    return (
      <div className="h-full flex flex-col">
        <MenuBar menus={menus} />
        <StartScreen
          lastFile={lastFile}
          recents={recentFiles}
          error={fileError}
          onOpen={() => runCommand("file.open")}
          onNew={() => runCommand("file.new")}
          onSample={() => runCommand("file.sample")}
          onOpenPath={(p) => void switchTo(p, false)}
          onForget={(p) => {
            void api.forgetFile(p).then(refreshFiles).catch(() => {});
          }}
        />

        {/* The key box. Rendered in BOTH shells, because the two ways
            to hit this are opening a file from the start screen (nothing open)
            and File → Open from inside a file, and a dialog that only exists
            in one of them is a dead end in the other. */}
        {keyPrompt && (
          <KeyPromptDialog
            fileName={keyPrompt.name}
            wrongKey={keyPrompt.wrong}
            busy={keyBusy}
            onCancel={() => setKeyPrompt(null)}
            onSubmit={(k) => void submitKey(keyPrompt.path, k)}
          />
        )}
        {newFileDialog}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <MenuBar menus={menus} />
      {/* The file banner. `fileError` was set by every failed open and
          rendered nowhere, so a file that would not open failed in silence:
          the app simply stayed on the one it had. */}
      {fileError && (
        <div className="tm-file-banner" role="alert">
          <span>{fileError}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setFileError(null)}>
            ✕
          </button>
        </div>
      )}
      {/* Refusals that belong to the shell rather than to one screen:
          an undo the backend would not run, a way in that led nowhere, and a
          load the account store could not finish. */}
      {undoError && (
        <Notice tone="error" onDismiss={() => setUndoError(null)}>
          {undoError}
        </Notice>
      )}
      {navError && (
        <Notice tone="error" onDismiss={() => setNavError(null)}>
          {navError}
        </Notice>
      )}
      {storeError && (
        <Notice tone="error" onDismiss={() => useAccountStore.setState({ error: null })}>
          {storeError}
        </Notice>
      )}
      {structure === "ribbon" && <Ribbon />}
      <AeroHeader
        showTabs={structure !== "sidebar"}
        active={tab}
        onTab={(t) => {
          // A header tab is the tab's START — its gallery, its account
          // list, its first card — even when you are already on it. The
          // rail's items are the specific screens. Everything under <main>
          // is keyed on `tabEpoch`, so the click remounts the tab's view.
          setReportKind(null);
          setBankingScreen("list");
          setBudgetScreen("budget");
          setHelpTopic(null);
          setTabEpoch((e) => e + 1);
          setTab(t);
        }}
        onSearch={runSearch}
        onSettings={() => setSettingsOpen(true)}
      />
      {structure === "documents" && (
        <DocumentTabs
          openIds={openTabs}
          accounts={sidebarAccounts}
          selectedId={sidebarSelectedId}
          onSelect={openAccountRegister}
          onClose={(id) =>
            setOpenTabs((t) => {
              const next = t.filter((x) => x !== id);
              // Closing the one you are looking at moves you to its
              // neighbor, not to nothing.
              if (id === sidebarSelectedId && next.length > 0) openAccountRegister(next[next.length - 1]);
              return next;
            })
          }
        />
      )}
      {/* The shell row carries a class so a look can rearrange it in
          CSS (Workbench mirrors it) without the shell knowing about looks. */}
      <div className="flex-1 flex min-h-0 tm-shell-row">
        <AeroSidebar
          width={railWidth}
          tabs={structure === "sidebar" ? { active: tab, onTab: goTab } : undefined}
          active={side}
          onSelect={handleSideSelect}
          accounts={sidebarAccounts}
          selectedAccountId={sidebarSelectedId}
          onSelectAccount={openAccountRegister}
        />
        {/* Drag the rail's edge to widen it; double-click to reset. */}
        <div
          className="tm-rail-grip"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the left rail"
          aria-valuenow={railWidth}
          aria-valuemin={RAIL_MIN}
          aria-valuemax={RAIL_MAX}
          tabIndex={0}
          title="Drag to resize · double-click to reset"
          onDoubleClick={() => setRail(RAIL_DEFAULT)}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") setRail(railWidth - 16);
            if (e.key === "ArrowRight") setRail(railWidth + 16);
          }}
          onPointerDown={(e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startW = railWidth;
            const move = (ev: PointerEvent) => setRail(startW + (ev.clientX - startX));
            const up = () => {
              window.removeEventListener("pointermove", move);
              window.removeEventListener("pointerup", up);
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
          }}
        />
        {structure === "three-pane" && (
          <AccountsPane
            accounts={sidebarAccounts}
            selectedId={sidebarSelectedId}
            onSelect={openAccountRegister}
          />
        )}
        <main key={`${tabEpoch}|${format}`} className="flex-1 overflow-y-auto p-4" style={{ background: "var(--tm-ms-content-bg)" }}>
          {tab === "Home" && (
            <Dashboard
              onOpenAccount={openAccountRegister}
              onOpenReport={(o) => {
                setReportOpen({ ...o });
                setTab("Reports");
              }}
            />
          )}
          {tab === "Budget" && (
            <BudgetTab screen={budgetScreen} onScreen={setBudgetScreen} />
          )}
          {tab === "Banking" && (
            <BankingView screen={bankingScreen} onScreen={setBankingScreen} />
          )}
          {tab === "Bills" && <PaymentsView />}
          {tab === "Reports" && (
            <ReportsView
              initialOpen={reportOpen}
              onOpenAccount={openAccountRegister}
              onOpenTransaction={(accountId, txnId) => void openTransaction(accountId, txnId)}
            />
          )}
          {tab === "Investing" && <InvestmentsView onOpenAccount={openAccountRegister} />}
          {tab === "Planning" && (
            <div className="space-y-4">
              <GoalsView />
              <DebtPlannerView />
            </div>
          )}

          {tab === "Help" && <HelpView topic={helpTopic} />}
          {tab === "Search" && searchQuery && (
            <SearchResults query={searchQuery} onOpen={openSearchHit} />
          )}
          {tab === "Taxes" && (
            <TaxesView
              onOpenReport={(o) => {
                setReportOpen({ ...o });
                setTab("Reports");
              }}
            />
          )}
        </main>
        {/* Two-up. Beside the register, not instead of it: the main
            pane stays the one you work, and this is the one you watch. */}
        {structure === "two-up" && (
          <WatchPane
            accounts={sidebarAccounts}
            workingId={sidebarSelectedId}
            onWork={openAccountRegister}
          />
        )}
      </div>

      {rulesOpen && (
        <>
          <div className="tm-dialog-backdrop" onClick={() => setRulesOpen(false)} />
          <ApplyPayeeRulesDialog
            onClose={() => setRulesOpen(false)}
            onApplied={(n) => {
              setRulesOpen(false);
              setRulesDone(
                n === 0
                  ? "Nothing was renamed."
                  : `Renamed ${n} transaction${n === 1 ? "" : "s"}. Ctrl+Z takes it back.`
              );
              void useAccountStore.getState().reloadAll();
              void refreshUndo();
              setTabEpoch((e) => e + 1);
            }}
          />
        </>
      )}

      {rulesDone && (
        <div className="tm-file-banner" role="status">
          <span>{rulesDone}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setRulesDone(null)}>
            ✕
          </button>
        </div>
      )}

      {tspOpen && (
        <>
          <div className="tm-dialog-backdrop" onClick={() => setTspOpen(false)} />
          <TspImportDialog
            accounts={sidebarAccounts}
            initialPath={tspPath}
            onClose={() => setTspOpen(false)}
            onImported={(s) => {
              setTspOpen(false);
              setTspDone(
                `Imported ${s.imported} transactions into ${s.account_name}` +
                  (s.transfers_linked ? `, ${s.transfers_linked} linked to deposits already in your register` : "") +
                  "."
              );
              // `reloadAll` keeps the selected account now, so a
              // register that was on screen stays on screen and shows the
              // import. The import is one undo step; read the
              // status back so the Edit menu offers it.
              void useAccountStore.getState().reloadAll();
              void refreshUndo();
            }}
          />
        </>
      )}

      {tspDone && (
        <div className="tm-file-banner" role="status">
          <span>{tspDone}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setTspDone(null)}>
            ✕
          </button>
        </div>
      )}

      {/* And here too: File → Open from inside a file lands in the same
          place as opening one from the start screen. */}
      {keyPrompt && (
        <KeyPromptDialog
          fileName={keyPrompt.name}
          wrongKey={keyPrompt.wrong}
          busy={keyBusy}
          onCancel={() => setKeyPrompt(null)}
          onSubmit={(k) => void submitKey(keyPrompt.path, k)}
        />
      )}
      {newFileDialog}

      {calcOpen && (
        <>
          <div className="tm-dialog-backdrop" onClick={() => setCalcOpen(false)} />
          <CalculatorDialog onClose={() => setCalcOpen(false)} />
        </>
      )}

      {favOpen && (
        <>
          <div className="tm-dialog-backdrop" onClick={() => setFavOpen(false)} />
          <OrganizeFavoritesDialog
            accounts={sidebarAccounts}
            // Handed back as promises, so a refusal is shown in the
            // dialog rather than dropped as an unhandled rejection.
            onToggle={(id) => useAccountStore.getState().toggleFavorite(id)}
            // The whole arrangement, written back and reloaded.
            onReorder={(ids) => useAccountStore.getState().reorderAccounts(ids)}
            onClose={() => setFavOpen(false)}
          />
        </>
      )}

      {settingsOpen && (
        <>
          <div className="tm-dialog-backdrop" onClick={() => setSettingsOpen(false)} />
          <div className="tm-dialog tm-settings-dialog" role="dialog" aria-modal="true" aria-label="Settings">
            <div className="tm-dialog-title">
              <span>Settings</span>
              <button
                type="button"
                className="tm-settings-close"
                aria-label="Close settings"
                onClick={() => setSettingsOpen(false)}
              >
                ✕
              </button>
            </div>
            <SettingsView />
          </div>
        </>
      )}
    </div>
  );
}

function Dashboard({ onOpenAccount, onOpenReport }: { onOpenAccount: (id: string) => void; onOpenReport: (o: ReportOpen) => void }) {
  // Home reads balances and the month's spending. Both change on every
  // register write, and Home used to load them once at app start.
  const loadAccounts = useAccountStore((s) => s.loadAccounts);
  const loadSummary = useBudgetStore((s) => s.loadSummary);
  useEffect(() => {
    void loadAccounts();
    void loadSummary();
  }, [loadAccounts, loadSummary]);
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
      <FavoriteAccountsWidget onOpen={onOpenAccount} />
      <SpendingTrackerWidget onOpenReport={onOpenReport} />
      <SubscriptionsWidget onOpenReport={onOpenReport} />
    </div>
  );
}

function BankingView({
  screen,
  onScreen,
}: {
  screen: BankingScreen;
  onScreen: (s: BankingScreen) => void;
}) {
  const accounts = useAccountStore((s) => s.accounts);
  const selectedAccountId = useAccountStore((s) => s.selectedAccountId);
  const selectAccount = useAccountStore((s) => s.selectAccount);
  const toggleFavorite = useAccountStore((s) => s.toggleFavorite);

  // Was sharing `amount` with the transaction form — creating an account then
  // silently used whatever was typed as a transaction amount.
  const [showNewAccount, setShowNewAccount] = useState(false);
  // File → New → Account. Banking owns the wizard, so it serves the
  // command at priority 10 while it is on screen; the shell's registration
  // below navigates here first when it is not (command priority).
  useCommand("new.account", () => setShowNewAccount(true), true, 10);
  const [merging, setMerging] = useState<Account | null>(null);
  const bankingView = screen;
  const setBankingView = onScreen;

  /** Open an account's register from inside Banking.
   *
   *  Picking an account is asking to go and work in it. Both ways into it —
   *  the dropdown on this card and a row in the Account List — have to mean
   *  the same thing, and the dropdown did not: it called `selectAccount`
   *  alone, so choosing an account changed the selection and left the user
   *  looking at the list, exactly the way the Home tab's favorites card
   *  used to. Same bug, second place. */
  function openRegister(id: string) {
    void selectAccount(id);
    setBankingView("register");
  }
  const [detailsFor, setDetailsFor] = useState<Account | null>(null);
  const [deleting, setDeleting] = useState<Account | null>(null);
  // A refused delete (split payments still send the account a
  // line) is shown IN the confirm dialog, which stays open. It was written
  // to the status line under the Account List bar, behind the dialog.
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // The star beside the picker had no catch: a refused write was an
  // unhandled rejection and a star that did not change.
  const [starError, setStarError] = useState<string | null>(null);

  const selected = accounts.find((a) => a.id === selectedAccountId) ?? null;

  /** The account on screen is gone (deleted, or merged into another).
   *  The selection pointed at it afterwards, so the sub-nav kept a tab for it
   *  and the register tried to load an account that no longer exists. */
  function forgetIfSelected(id: string) {
    if (useAccountStore.getState().selectedAccountId !== id) return;
    useAccountStore.setState({ selectedAccountId: null, register: [], transactions: [] });
    if (bankingView === "register") setBankingView("list");
  }

  return (
    <div className="grid grid-cols-1 gap-4">
      {/* Account list. Transaction ENTRY lives in the register itself (the
          New button / "Show transaction forms"), exactly as in Money — there
          is deliberately no separate quick-add card, because a second entry
          path with fewer fields is how you end up with uncategorized
          transactions. */}
      <section className="aero-card max-w-2xl">
        <div className="aero-card-title">Accounts</div>
        {/* One account at a time — a dropdown rather than a list that grows
            with every account. The rail lists them all. */}
        <div className="p-3">
          {accounts.length === 0 ? (
            <div className="text-[12px] text-slate-500 text-center pb-2">
              No accounts yet. Use "Set up a new account" below.
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <label htmlFor="account-picker">Account:</label>
              <select
                id="account-picker"
                className="aero-field flex-1"
                value={selectedAccountId ?? ""}
                onChange={(e) => openRegister(e.target.value)}
              >
                <option value="" disabled>
                  Select an account…
                </option>
                {/* Open accounts, as the rail lists them; a closed one
                    only while it is the one on screen (opened from Account
                    List → Show closed accounts), so the picker still says
                    where you are. */}
                {accounts
                  .filter((a) => !a.is_closed || a.id === selectedAccountId)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.is_closed ? `${a.name} (closed)` : a.name}
                    </option>
                  ))}
              </select>
              {selected && (
                <>
                  <button
                    type="button"
                    title="Toggle favorite"
                    onClick={() => {
                      setStarError(null);
                      toggleFavorite(selected.id).catch((e) => setStarError(String(e)));
                    }}
                  >
                    {selected.is_favorite ? "★" : "☆"}
                  </button>
                  <span className="tabular-nums font-bold">
                    <Money cents={accountWorth(selected)} currency={currencyOf(selected)} />
                  </span>
                </>
              )}
            </div>
          )}
          {starError && (
            <Notice tone="error" boxed className="mt-2">
              {starError}
            </Notice>
          )}
        </div>
        {/* "Add a new account" opens Money's two-step wizard. */}
        <div className="px-3 pb-3">
          <button
            type="button"
            className="aero-side-item px-0"
            onClick={() => setShowNewAccount(true)}
          >
            Add a new account
          </button>
        </div>
      </section>

      {/* Account register (MS Money look) for the selected account */}
      {/* Money's Banking sub-nav: the account list, or one account's register. */}
      <div className="aero-subnav flex gap-4">
        <button
          type="button"
          className={bankingView === "list" ? "selected" : ""}
          onClick={() => setBankingView("list")}
        >
          Account List
        </button>
        {selected && (
          <button
            type="button"
            className={bankingView === "register" ? "selected" : ""}
            onClick={() => setBankingView("register")}
          >
            {selected.name}
          </button>
        )}
        {/* Money keeps Payees under Tools → "Categories & Payees"; it is a
            Banking screen, so it belongs on this sub-nav. */}
        <button
          type="button"
          className={bankingView === "payees" ? "selected" : ""}
          onClick={() => setBankingView("payees")}
        >
          Payees
        </button>
      </div>

      {/* Status line for account create / edit / delete — setMsg had no
          rendering at all before, so every one of those confirmations was
          written to state and thrown away. */}
      {msg && (
        <div className="text-[12px]" role="status">
          {msg}
        </div>
      )}

      {bankingView === "payees" ? (
        <PayeesView />
      ) : bankingView === "list" ? (
        <AccountListView
          accounts={accounts}
          onOpen={openRegister}
          onAddAccount={() => setShowNewAccount(true)}
          onEditDetails={async (id) => {
            // Read the account back rather than trusting the list copy — an
            // import or a reconcile may have moved the balance since it loaded.
            try {
              setDetailsFor(await api.getAccount(id));
            } catch {
              setDetailsFor(accounts.find((a) => a.id === id) ?? null);
            }
          }}
          onDeleteAccount={(id) => {
            setDeleteError(null);
            setDeleting(accounts.find((a) => a.id === id) ?? null);
          }}
          onMergeAccount={(id) => setMerging(accounts.find((a) => a.id === id) ?? null)}
        />
      ) : (
        <AccountRegister />
      )}

      {detailsFor && (
        <>
          <div className="tm-dialog-backdrop" onClick={() => setDetailsFor(null)} />
          <AccountDetailsDialog
            account={detailsFor}
            assets={accounts}
            onCancel={() => setDetailsFor(null)}
            onSave={async (details) => {
              await useAccountStore.getState().updateAccountDetails(details);
            }}
            // Closed only once the dialog's own writes (rounding,
            // Secured by) are done too, and reloaded after them: a new
            // rounding changes the holdings value the list shows.
            onSaved={async () => {
              await useAccountStore.getState().loadAccounts();
              setDetailsFor(null);
              setMsg("Account details saved.");
            }}
          />
        </>
      )}

      {/* Deleting an account takes its transactions with it, so the count is
          stated before the button is offered. */}
      {deleting && (
        <>
          {/* Not while the delete is running: closing the dialog then
              lost its refusal, or its "Deleted" line, mid-flight. */}
          <div className="tm-dialog-backdrop" onClick={() => !busy && setDeleting(null)} />
          <div className="tm-dialog" role="dialog" aria-label="Delete account">
            <div className="tm-dialog-title">Delete account</div>
            <div className="tm-dialog-body space-y-2 text-[12px]">
              <p>
                Delete <strong>{deleting.name}</strong>?
              </p>
              <p>
                Every transaction in this account is deleted with it. This cannot
                be undone — take a backup first if you are not sure.
              </p>
              {/* Say the second thing out loud. The stack is emptied
                  because Undo cannot reach past this, and a menu item that
                  silently stops naming your last edit reads like a bug. */}
              <p>Anything Edit → Undo was holding is cleared as well.</p>
              {deleteError && (
                <Notice tone="error" boxed>
                  {deleteError}
                </Notice>
              )}
              <div className="flex justify-end gap-2 pt-3">
                <button
                  className="aero-btn default"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api.deleteAccount(deleting.id);
                      forgetIfSelected(deleting.id);
                      await useAccountStore.getState().loadAccounts();
                      await useAccountStore.getState().loadFavorites();
                      // The delete emptied the stack on the Rust side.
                      // Without this the menu keeps offering a label for a
                      // step the backend has already dropped.
                      void refreshUndo();
                      setMsg(`Deleted "${deleting.name}".`);
                      setDeleting(null);
                    } catch (e) {
                      setDeleteError(String(e));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Delete
                </button>
                <button className="aero-btn" onClick={() => setDeleting(null)} disabled={busy}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {merging && (
        <>
          <div className="tm-dialog-backdrop" onClick={() => setMerging(null)} />
          <MergeAccountsDialog
            from={merging}
            accounts={accounts}
            onCancel={() => setMerging(null)}
            onMerged={async (into, s) => {
              setMerging(null);
              forgetIfSelected(merging.id);
              await useAccountStore.getState().loadAccounts();
              await useAccountStore.getState().loadFavorites();
              // Same as the delete: a merge is not on the undo stack,
              // so the backend emptied it and the menu has to be told.
              void refreshUndo();
              setMsg(`Merged "${merging.name}" into "${into.name}": ${s.moved} moved${s.duplicates ? `, ${s.duplicates} already there` : ""}${s.self_transfers ? `, ${s.self_transfers} self-transfer${s.self_transfers === 1 ? "" : "s"} removed` : ""}.`);
            }}
          />
        </>
      )}

      {showNewAccount && (
        <>
          <div className="tm-dialog-backdrop" onClick={() => setShowNewAccount(false)} />
          <NewAccountWizard
            onCancel={() => setShowNewAccount(false)}
            onCreate={async (name, type, cents, openedOn, currency) => {
              await useAccountStore.getState().addAccount(name, type, cents, openedOn, currency);
              setShowNewAccount(false);
              setMsg("Account created.");
            }}
          />
        </>
      )}

      {/* Import QIF/OFX into the selected account */}
      <div>
        <ImportSection />
      </div>
    </div>
  );
}

/** The Budget tab: the month's budgets, or the Categories manager. */
function BudgetTab({
  screen,
  onScreen,
}: {
  screen: BudgetScreen;
  onScreen: (s: BudgetScreen) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="aero-subnav flex gap-4">
        <button
          type="button"
          className={screen === "budget" ? "selected" : ""}
          onClick={() => onScreen("budget")}
        >
          Budgets
        </button>
        <button
          type="button"
          className={screen === "categories" ? "selected" : ""}
          onClick={() => onScreen("categories")}
        >
          Categories
        </button>
        <button
          type="button"
          className={screen === "classifications" ? "selected" : ""}
          onClick={() => onScreen("classifications")}
        >
          Classifications
        </button>
      </div>
      {screen === "categories" ? <CategoriesView /> : screen === "classifications" ? <ClassificationsView /> : <BudgetScreens />}
    </div>
  );
}

/** Budgets, which is now two ways of looking at one plan.
 *
 *  **Year plan** is where the budget is SET: one annual figure per category
 *  and the months it runs. **This month** is the same plan read as a single
 *  month, which is what the Home tab and the spending tracker show — it is
 *  still the original monthly screen, and it still writes, because the file may hold
 *  monthly budgets that predate the plan.
 *
 *  The year plan opens first. It is the one that answers the question the user
 *  actually asks of this tab, and a screen that asks for twelve decisions
 *  should not be the front door to one that asks for one. */
function BudgetScreens() {
  const [view, setView] = useState<"year" | "month">("year");
  return (
    <div className="grid grid-cols-1 gap-2">
      <div className="flex">
        <button
          type="button"
          className={`aero-btn${view === "year" ? " default" : ""}`}
          aria-pressed={view === "year"}
          onClick={() => setView("year")}
        >
          Year plan
        </button>
        <button
          type="button"
          className={`aero-btn${view === "month" ? " default" : ""}`}
          aria-pressed={view === "month"}
          onClick={() => setView("month")}
        >
          This month
        </button>
      </div>
      {view === "year" ? <YearPlanView /> : <BudgetView />}
    </div>
  );
}

