// Settings — database info, encrypted backup/restore, and master-key status.
// Uses the Tauri dialog plugin for native save/open pickers.
import { useEffect, useRef, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import TmIcon from "./TmIcon";
import { api } from "../lib/ipc";
import { useCommand } from "../lib/useCommand";
import { refreshUndo } from "../lib/undo";
import Notice from "./Notice";
import DateField from "./DateField";
import { ZOOM_LEVELS, applyZoom, readZoom, saveZoom } from "../lib/zoom";
import { THEMES, applyTheme, readTheme, saveTheme } from "../lib/theme";
import { applyLook, LOOKS, readLook, saveLook, type Look } from "../lib/layout";
import ThemePreview from "./ThemePreview";
import { useAccountStore } from "../stores/useAccountStore";
import { useBudgetStore } from "../stores/useBudgetStore";
import type { BackupConfig, Currency, DbInfo, ExchangeRate, FileCheck, HoldingRounding, KeyStatus, PriceInterval, PriceStatus } from "../lib/types";
import { formatDate, formatMoney, today } from "../lib/format";
import { formatRate, homeCurrency, homeName, rateForBackend } from "../lib/currency";
import { useFileFormat } from "../lib/region";
import HomeCurrencyPane from "./HomeCurrencyPane";
import BankSyncPane from "./BankSyncPane";
import { HOLDING_ROUNDING_KEY } from "../lib/shares";
import { PRICE_INTERVALS } from "../lib/prices";

/** Vite sets this false in a production bundle, so the Developer card below
 *  is not in the shipped app at all. The backend refuses `seed_demo_data` in
 *  a release build regardless — this is the second of the two locks. */
const IS_DEV = import.meta.env.DEV;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type GroupId = "appearance" | "file" | "money" | "security" | "advanced";

/** The two levels. A group whose only pane is itself draws no second
 *  strip: one tab under one tab is a decoration, not a navigation. */
const GROUPS: { id: GroupId; label: string; panes: { id: string; label: string }[] }[] = [
  {
    id: "appearance",
    label: "Appearance",
    panes: [
      // Text size lives WITH the layout, not beside it. Both answer
      // "how is this app arranged for my eyes"; splitting them meant picking
      // a look, leaving, and coming back for the size of the type in it.
      { id: "look", label: "Looks" },
      { id: "theme", label: "Colors" },
    ],
  },
  {
    id: "file",
    label: "File",
    panes: [
      { id: "database", label: "This file" },
      { id: "backup", label: "Backups" },
      { id: "verify", label: "Verify" },
    ],
  },
  { id: "money", label: "Money", panes: [{ id: "holdings", label: "Holding values" }, { id: "prices", label: "Prices" }, { id: "currencies", label: "Currencies" }, { id: "format", label: "Home currency and region" }, { id: "banksync", label: "Bank sync" }] },
  { id: "security", label: "Security", panes: [{ id: "key", label: "Master key" }] },
  { id: "advanced", label: "Advanced", panes: [{ id: "developer", label: "Developer" }] },
];

const PANE_KEY = "tm.settingsPane";

/** Open Settings ON a pane.
 *
 *  File → Restore from a backup and File → Backup settings are menu items for
 *  things that live inside Settings. Making them open Settings and leave you
 *  to find the right tab is the kind of "technically wired up" that a user
 *  reads as broken, so the caller names the pane and Settings starts there.
 *
 *  It goes through the same remembered-pane key the dialog already uses, so
 *  there is one way in and the choice is remembered afterwards. */
export function aimSettingsAt(group: GroupId, pane: string): void {
  try {
    window.localStorage.setItem(PANE_KEY, `${group}/${pane}`);
  } catch {
    /* not remembered; Settings opens where it was */
  }
}

/** Something the shell asked Settings to DO as it opens: File → Back
 *  up now and Verify this file, chosen while Settings was closed. Held here
 *  and taken exactly once by the next Settings to mount, the same one-way
 *  hand-off `aimSettingsAt` uses for the pane. */
export type SettingsAction = "backup" | "verify";
let pendingAction: SettingsAction | null = null;
export function runInSettings(action: SettingsAction): void {
  pendingAction = action;
}

/** The group and pane last looked at, or the first of each. An id that no
 *  longer exists — a pane renamed between versions — falls back rather than
 *  opening onto nothing. */
function readPane(): { group: GroupId; pane: string } {
  const first = { group: GROUPS[0].id, pane: GROUPS[0].panes[0].id };
  try {
    const [g, p] = (window.localStorage.getItem(PANE_KEY) ?? "").split("/");
    const grp = GROUPS.find((x) => x.id === g);
    if (!grp) return first;
    return { group: grp.id, pane: grp.panes.some((x) => x.id === p) ? p : grp.panes[0].id };
  } catch {
    return first;
  }
}

export default function SettingsView() {
  const [dbInfo, setDbInfo] = useState<DbInfo | null>(null);
  const [zoom, setZoom] = useState<number>(() => readZoom());
  const [themeId, setThemeId] = useState<string>(() => readTheme());
  // How a holding's shares × price is rounded to the cent — a fact
  // about the broker, kept in the file.
  const [rounding, setRounding] = useState<HoldingRounding>("nearest");
  // The price timer and how old the prices are.
  const [priceStatus, setPriceStatus] = useState<PriceStatus | null>(null);
  // Verify this file.
  const [check, setCheck] = useState<FileCheck | null>(null);
  const [checking, setChecking] = useState(false);

  async function verify(repair: boolean) {
    setWhere("verify");
    setChecking(true);
    setError(null);
    try {
      const r = await api.verifyFile(repair);
      setCheck(r);
      if (repair) {
        // A repair empties the undo stack on the Rust side;
        // the Edit menu has to hear it or it names a step that is gone.
        void refreshUndo();
        await useAccountStore.getState().reloadAll();
        setMsg(r.repaired.length ? `Repaired: ${r.repaired.join("; ")}` : "Nothing needed repairing.");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setChecking(false);
    }
  }
  const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lookId, setLookId] = useState(() => readLook());
  // Layered tabs. A wall of nine cards is a wall however it is
  // sorted; two shallow levels turn "where is the backup setting" into two
  // obvious clicks. Top level is the KIND of thing, the level under it is the
  // thing — which is the only split that stays obvious as settings are added.
  // Where you were last. A settings dialog you open twice for the same reason
  // should not make you find the pane twice.
  const [group, setGroup] = useState<GroupId>(() => readPane().group);
  const [pane, setPane] = useState<string>(() => readPane().pane);
  useEffect(() => {
    try {
      window.localStorage.setItem(PANE_KEY, `${group}/${pane}`);
    } catch {
      /* not remembered, still shown */
    }
  }, [group, pane]);
  const at = (g: GroupId, p: string) => group === g && pane === p;
  const openGroup = (g: GroupId) => {
    setGroup(g);
    setPane(GROUPS.find((x) => x.id === g)!.panes[0].id);
  };
  const [msg, setMsg] = useState<string | null>(null);
  // WHICH card the message belongs to. There was one status line at the
  // bottom of the whole page, so the result of a restore — the single most
  // consequential thing on this screen — appeared below the fold, and you had
  // to scroll to find out whether your database had just been replaced.
  // A message now appears against the thing that produced it.
  const [where, setWhere] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Master-key form.
  const [newKey, setNewKey] = useState("");
  const [confirmKey, setConfirmKey] = useState("");
  // The key itself, revealed only on request.
  const [revealed, setRevealed] = useState<string | null>(null);
  // Automatic backup.
  const [backupCfg, setBackupCfg] = useState<BackupConfig | null>(null);
  // Restore: the key of a backup made on ANOTHER machine. Blank = this one's.
  // The command has long accepted this; nothing on screen offered it,
  // so the actual recovery path — new machine, old backup, saved key — was
  // unreachable.
  const [restoreKey, setRestoreKey] = useState("");
  // "Keep N" is edited locally and saved on blur/Enter: saving on every
  // keystroke wrote keep=2 while the user was typing "20", then disabled
  // the field mid-word and swallowed the 0.
  const [keepText, setKeepText] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const [info, key, cfg] = await Promise.all([
        api.getDbInfo(),
        api.getKeyStatus(),
        api.getBackupConfig(),
      ]);
      setDbInfo(info);
      setKeyStatus(key);
      setBackupCfg(cfg);
      const r = await api.getUiSetting(HOLDING_ROUNDING_KEY).catch(() => null);
      setRounding(r === "down" ? "down" : "nearest");
      setPriceStatus(await api.priceStatus().catch(() => null));
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Run what the shell asked for on the way in (File → Back up now,
  // Verify this file). Taken once, so a second mount does not run it again.
  const actionTaken = useRef(false);
  useEffect(() => {
    if (actionTaken.current) return;
    actionTaken.current = true;
    const action = pendingAction;
    pendingAction = null;
    if (action === "backup") void backupNow();
    if (action === "verify") void verify(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function reveal() {
    setWhere("key");
    setError(null);
    try {
      setRevealed(await api.exportMasterKey());
    } catch (e) {
      setError(String(e));
    }
  }

  async function saveKeyToFile() {
    setWhere("key");
    setMsg(null);
    setError(null);
    const path = await save({
      title: "Save your master key",
      defaultPath: "t-money-master-key.txt",
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
    if (!path) return;
    try {
      await api.saveMasterKey(path);
      setMsg(`Key written to ${path}. Keep it somewhere separate from your backups.`);
    } catch (e) {
      setError(String(e));
    }
  }

  async function chooseBackupFolder() {
    setWhere("autobackup");
    const dir = await open({ directory: true, title: "Where should backups go?" });
    if (typeof dir !== "string") return;
    // A new folder is not a new decision about WHETHER to back up.
    // This saved enabled:true every time, so moving the folder turned back on
    // the daily backup the user had switched off. Only the first folder turns
    // it on, which is what the card says choosing one does.
    await saveBackupCfg({ folder: dir, enabled: backupCfg?.folder ? backupCfg.enabled : true });
  }

  /** Make sure there is a folder, asking for one if there is not.
   *
   *  "Back up automatically" and "Back up now" used to be `disabled` until a
   *  folder was set, with nothing on screen saying so — two dead controls that
   *  looked like a broken build. A control the user is meant to press should
   *  ask for what it needs, not sit there grayed out. */
  async function ensureBackupFolder(
    // Which switch the folder is being chosen FOR. There are two of
    // them now, and choosing a folder because you ticked "when I close" must
    // not quietly turn on the daily one as well.
    turnOn: "enabled" | "on_exit" | "neither" = "enabled"
  ): Promise<string | null> {
    // Asked afresh when it has not loaded yet: File → Back up now can
    // run the moment Settings opens (runInSettings), before `load` has
    // answered, and a null here asked for a folder the file already has.
    const current = backupCfg ?? (await api.getBackupConfig().catch(() => null));
    if (current?.folder) return current.folder;
    const dir = await open({ directory: true, title: "Where should backups go?" });
    if (typeof dir !== "string") return null;
    setBusy(true);
    try {
      const cfg = await api.setBackupConfig(
        turnOn === "enabled" ? true : (current?.enabled ?? false),
        turnOn === "on_exit" ? true : (current?.on_exit ?? false),
        dir,
        current?.keep ?? 10
      );
      setBackupCfg(cfg);
      return cfg.folder;
    } catch (e) {
      setError(String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }

  /** A patch rather than four positional arguments.
   *
   *  There are two switches, a folder and a retention count now, and every
   *  caller changing one of them had to restate the other three correctly. One
   *  transposed pair there turns "keep 10" into "enabled false" silently. */
  async function saveBackupCfg(patch: {
    enabled?: boolean;
    onExit?: boolean;
    folder?: string | null;
    keep?: number;
  }) {
    setWhere("autobackup");
    setError(null);
    setBusy(true);
    try {
      setBackupCfg(
        await api.setBackupConfig(
          patch.enabled ?? backupCfg?.enabled ?? false,
          patch.onExit ?? backupCfg?.on_exit ?? false,
          patch.folder !== undefined ? patch.folder : (backupCfg?.folder ?? null),
          patch.keep ?? backupCfg?.keep ?? 10
        )
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  // File → Back up now / Verify, and Tools → Settings' own corner of
  // the menu. The shell serves both too, by opening Settings and
  // handing over the action; while Settings is open it serves them itself, at
  // the higher priority, so the result lands on the pane already on screen.
  useCommand("file.backup", () => void backupNow(), true, 10);
  useCommand("file.verify", () => void verify(false), true, 10);

  async function backupNow() {
    setWhere("autobackup");
    setMsg(null);
    setError(null);
    if (!(await ensureBackupFolder())) return;
    setBusy(true);
    try {
      const path = await api.backupNow();
      setMsg(`Backed up to ${path}.`);
      setBackupCfg(await api.getBackupConfig());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function seedDemo() {
    setWhere("developer");
    setMsg(null);
    setError(null);
    setBusy(true);
    try {
      const s = await api.seedDemoData();
      setMsg(
        `Seeded ${s.transactions} transactions, ${s.transfers} transfers, ` +
          `${s.splits} split lines, ${s.budgets} budgets and ${s.statements} ` +
          `reconciled statement(s) across ${s.accounts} new accounts ` +
          `(${s.account_names.join(", ")}). Open Banking to see them.`
      );
      await load();
      await useAccountStore.getState().reloadAll();
      await useBudgetStore.getState().loadSummary();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function backup() {
    setWhere("database");
    setMsg(null);
    setError(null);
    const path = await save({
      defaultPath: "t-money-backup.db",
      filters: [{ name: "T-Money backup", extensions: ["db"] }],
    });
    if (typeof path !== "string") return; // canceled
    setBusy(true);
    try {
      const bytes = await api.backupDatabase(path);
      setMsg(`Backup written to ${path} (${formatBytes(bytes)}).`);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    setWhere("database");
    setMsg(null);
    setError(null);
    const path = await open({
      multiple: false,
      filters: [{ name: "T-Money backup", extensions: ["db"] }],
    });
    if (typeof path !== "string") return; // canceled
    if (!window.confirm(`Restore from ${path}?\n\nThis REPLACES the current database.`))
      return;
    setBusy(true);
    try {
      await api.restoreDatabase(path, restoreKey.trim() || null);
      setRestoreKey("");
      setMsg(`Restored from ${path}.`);
      // Every step on the undo stack described the database that was
      // just replaced; the backend dropped them and the menu must too.
      void refreshUndo();
      // The restored file has its own home currency and region.
      useFileFormat.getState().setFormat(await api.getFileFormat());
      await load();
      // Every cached row came from the database that was just replaced.
      await useAccountStore.getState().reloadAll();
      await useBudgetStore.getState().loadSummary();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function changeKey(e: React.FormEvent) {
    setWhere("key");
    e.preventDefault();
    setMsg(null);
    setError(null);
    if (newKey.trim().length < 8) {
      setError("Master key must be at least 8 characters.");
      return;
    }
    if (newKey !== confirmKey) {
      setError("Keys do not match.");
      return;
    }
    if (!window.confirm("Change the master key?\n\nThe database is re-encrypted with the new key. Keep the old key safe until you've verified the new one works."))
      return;
    setBusy(true);
    try {
      await api.changeMasterKey(newKey.trim());
      setMsg("Master key updated and database re-encrypted.");
      setNewKey("");
      setConfirmKey("");
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  const panes = GROUPS.find((g) => g.id === group)!.panes;

  return (
    <div className="tm-settings">
      {/* The two levels. The top strip is the kind of thing; the strip
          under it is the thing. A group with one pane draws no second strip:
          one tab under one tab is a decoration, not a navigation. */}
      <div className="tm-settings-tabs" role="tablist" aria-label="Settings sections">
        {GROUPS.filter((g) => g.id !== "advanced" || IS_DEV).map((g) => (
          <button
            key={g.id}
            type="button"
            role="tab"
            aria-selected={group === g.id}
            className={`tm-settings-tab${group === g.id ? " active" : ""}`}
            onClick={() => openGroup(g.id)}
          >
            {g.label}
          </button>
        ))}
      </div>
      {panes.length > 1 && (
        <div className="tm-settings-subtabs" role="tablist" aria-label={`${group} settings`}>
          {panes.map((p) => (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={pane === p.id}
              className={`tm-settings-subtab${pane === p.id ? " active" : ""}`}
              onClick={() => setPane(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}

      <div className="tm-settings-body grid grid-cols-1 gap-4">
      {dbInfo?.scratch_dir && (
        <div
          className="lg:col-span-2 tm-keywarn font-bold"
          role="status"
          aria-label="Scratch database"
        >
          SCRATCH DATABASE — this run is using {dbInfo.scratch_dir}, not your real
          file. Nothing done here touches it or its master key.
        </div>
      )}
      {at("money", "holdings") && (
        <>
          {/* Holding values */}
      <section className="aero-card">
        <div className="aero-card-title flex items-center gap-2">
          <TmIcon name="investments" size={15} /> Holding values — broker's rounding
        </div>
        <div className="p-3 space-y-2 text-[12px]">
          <label className="flex items-center gap-2">
            <span className="text-slate-600">Shares × price, to the cent</span>
            <select
              className="aero-field"
              aria-label="Holding value rounding"
              value={rounding}
              onChange={(e) => {
                const r: HoldingRounding = e.target.value === "down" ? "down" : "nearest";
                const was = rounding;
                setRounding(r);
                // This pane had no status line, so the message and the
                // refusal were both written where nothing showed them, and a
                // refused save left the select saying the new rounding.
                setWhere("holdings");
                setMsg(null);
                setError(null);
                void (async () => {
                  try {
                    await api.setUiSetting(HOLDING_ROUNDING_KEY, r);
                  } catch (err) {
                    setRounding(was);
                    setError(String(err));
                    return;
                  }
                  setMsg(r === "down" ? "Holdings are now valued rounding down, as some brokers do." : "Holdings are now valued to the nearest cent.");
                  await useAccountStore.getState().reloadAll();
                })();
              }}
            >
              <option value="nearest">Round to the nearest cent</option>
              <option value="down">Round down (truncate)</option>
            </select>
          </label>
          <div className="text-slate-500">
            The default for every investment and retirement account in this file. Brokers differ by a cent on
            20.125 shares at $10.07: rounding gives $202.66, some brokers print $202.65. An account at a
            different broker can choose its own under Banking → Accounts → Change details. Cost basis,
            proceeds and cash are never affected.
          </div>
          {where === "holdings" && <StatusLine text={error ?? msg} bad={!!error} />}
        </div>
      </section>
        </>
      )}

      {at("money", "prices") && (
        <>
          {/* The price timer. The app has never fetched anything on
              its own, and the default here keeps that promise: "Only when I
              ask" is off, and the other two ask ONCE a day or a week while
              T-Money is open. Nothing runs when the app is closed, and only
              ticker symbols ever leave the machine. */}
          <section className="aero-card">
            <div className="aero-card-title flex items-center gap-2">
              <TmIcon name="investments" size={15} /> Prices
            </div>
            <div className="p-3 space-y-2 text-[12px]">
              <label className="flex items-center gap-2">
                <span className="text-slate-600">Update prices</span>
                <select
                  className="aero-field"
                  aria-label="How often to update prices"
                  value={priceStatus?.interval ?? "off"}
                  onChange={(e) => {
                    const v = e.target.value as PriceInterval;
                    // Said on this pane, which had no status line. The
                    // select follows `priceStatus`, so a refused save leaves it
                    // on the interval that is actually stored.
                    setWhere("prices");
                    setMsg(null);
                    setError(null);
                    void (async () => {
                      try {
                        await api.setUiSetting("prices.auto", v);
                        setPriceStatus(await api.priceStatus());
                        setMsg(
                          v === "off"
                            ? "Prices will be fetched only when you press Update prices."
                            : `T-Money will fetch prices once a ${v === "daily" ? "day" : "week"} while it is open.`
                        );
                      } catch (err) {
                        setError(String(err));
                      }
                    })();
                  }}
                >
                  {PRICE_INTERVALS.map((i) => (
                    <option key={i.value} value={i.value}>{i.label}</option>
                  ))}
                </select>
              </label>
              <div className="text-slate-500">
                A fetch sends your ticker symbols and nothing else — no amounts, no account names, no
                identity — and a symbol that cannot be priced leaves the holding exactly as it was.
                Nothing is fetched while T-Money is closed.
              </div>
              {priceStatus && (
                <div className="text-slate-600">
                  {priceStatus.with_symbol === 0
                    ? "No security here has a ticker symbol yet, so there is nothing to fetch. Add one on the Investing tab."
                    : (
                      <>
                        {priceStatus.with_symbol} {priceStatus.with_symbol === 1 ? "security" : "securities"} with a symbol
                        {priceStatus.newest_date ? ` · newest price ${priceStatus.newest_date}` : ""}
                        {priceStatus.oldest_date ? ` · oldest ${priceStatus.oldest_date}` : ""}
                        {priceStatus.never_priced > 0 ? ` · ${priceStatus.never_priced} never priced` : ""}
                        {priceStatus.last_auto ? ` · last automatic run ${priceStatus.last_auto.replace("T", " ")}` : " · no automatic run yet"}
                      </>
                    )}
                </div>
              )}
              {where === "prices" && <StatusLine text={error ?? msg} bad={!!error} />}
            </div>
          </section>
        </>
      )}

      {at("money", "currencies") && <CurrenciesPane />}
      {at("money", "format") && <HomeCurrencyPane onCurrencies={() => setPane("currencies")} />}
      {at("money", "banksync") && <BankSyncPane />}

      {at("appearance", "theme") && (
        <>
          {/* Theme */}
      <section className="aero-card">
        <div className="aero-card-title flex items-center gap-2">
          <TmIcon name="settings" size={15} /> Theme
        </div>
        <div className="p-3 text-[12px]">
          <div className="tm-theme-grid" role="radiogroup" aria-label="Theme">
            {THEMES.map((t) => (
              <label key={t.id} className={`tm-theme-choice${themeId === t.id ? " active" : ""}`}>
                <input
                  type="radio"
                  name="theme"
                  value={t.id}
                  checked={themeId === t.id}
                  aria-label={t.label}
                  onChange={() => {
                    setThemeId(t.id);
                    saveTheme(t.id);
                    applyTheme(t.id);
                  }}
                />
                <ThemePreview theme={t} />
                <span className="tm-theme-label">{t.label}</span>
                <span className="tm-theme-blurb">{t.blurb}</span>
              </label>
            ))}
          </div>
          <div className="text-slate-500 pt-2">Applies at once and is remembered on this computer. Money Plus is the measured original.</div>
        </div>
      </section>
        </>
      )}

      {at("appearance", "look") && (
        <>
          {/* Look. Two settings, deliberately: the LOOK is the shape and
          the THEME is the colors, so Sidebar in Evening and Compact in
          Copper are both things you can have. */}
      <section className="aero-card">
        <div className="aero-card-title flex items-center gap-2">
          <TmIcon name="settings" size={15} /> Looks
        </div>
        <div className="p-3 text-[12px]">
          {/* Text size is one line above the looks, not a card beside
              them. It is a single choice; giving it a card of its own took a
              third of the pane away from the thing the pane is for, and left
              the looks in a column half the width they want. */}
          <div className="tm-size-strip">
            <label className="flex items-center gap-2">
              <span className="text-slate-600">Text size</span>
              <select
                className="aero-field"
                aria-label="Text size"
                value={String(zoom)}
                onChange={(e) => {
                  const z = Number(e.target.value);
                  setZoom(z);
                  saveZoom(z);
                  void applyZoom(z);
                }}
              >
                {ZOOM_LEVELS.map((l) => (
                  <option key={l.value} value={String(l.value)}>
                    {l.label} ({Math.round(l.value * 100)}%)
                  </option>
                ))}
              </select>
            </label>
            <span className="text-slate-500">
              Scales the registers, reports and dialogs together. Remembered on this computer.
            </span>
          </div>
          <div className="tm-theme-grid" role="radiogroup" aria-label="Look">
            {LOOKS.map((l) => (
              <label key={l.id} className={`tm-theme-choice${lookId === l.id ? " active" : ""}`}>
                <input
                  type="radio"
                  name="look"
                  value={l.id}
                  checked={lookId === l.id}
                  aria-label={l.label}
                  onChange={() => {
                    setLookId(l.id);
                    saveLook(l.id);
                    applyLook(l.id);
                  }}
                />
                <LookPreview look={l} />
                <span className="tm-theme-label">{l.label}</span>
                <span className="tm-theme-blurb">{l.blurb}</span>
              </label>
            ))}
          </div>
          <div className="text-slate-500 pt-2">
            The look is the shape; the theme above is the color. Money Classic is the default and is what the app was
            built to be.
          </div>
        </div>
      </section>
        </>
      )}



      {at("file", "database") && (
        <>
          {/* Database info */}
      <section className="aero-card">
        <div className="aero-card-title flex items-center gap-2">
          <TmIcon name="settings" size={15} /> Database
        </div>
        <div className="p-3 space-y-2 text-[12px]">
          {dbInfo ? (
            <div className="grid grid-cols-2 gap-y-1 tabular-nums">
              <span className="text-slate-600">Location</span>
              <span className="text-right break-all" title={dbInfo.db_path}>
                {dbInfo.db_path}
              </span>
              <span className="text-slate-600">Size</span>
              <span className="text-right">{formatBytes(dbInfo.size_bytes)}</span>
              <span className="text-slate-600">Encryption</span>
              <span className="text-right">
                {dbInfo.has_key ? (
                  <span className="text-[color:var(--tm-positive)] font-bold">SQLCipher (keyed)</span>
                ) : (
                  <span className="money-neg font-bold">No key</span>
                )}
              </span>
            </div>
          ) : (
            <div className="text-slate-500">Loading…</div>
          )}
          <div className="flex gap-2 pt-2">
            <button className="aero-btn" onClick={backup} disabled={busy}>
              <span className="inline-flex items-center gap-1">
                <TmIcon name="export" size={13} /> Backup…
              </span>
            </button>
            <button className="aero-btn" onClick={restore} disabled={busy}>
              <span className="inline-flex items-center gap-1">
                <TmIcon name="sync" size={13} /> Restore…
              </span>
            </button>
            <button className="aero-btn" onClick={load} disabled={busy}>
              Refresh
            </button>
          </div>
          <label className="flex items-center gap-2 pt-1 text-[12px]">
            <span>Key for a backup from another machine:</span>
            <input
              className="aero-field flex-1 font-mono"
              aria-label="Restore key"
              placeholder="leave blank to use this machine's key"
              autoComplete="off"
              value={restoreKey}
              onChange={(e) => setRestoreKey(e.target.value)}
            />
          </label>
          {where === "database" && <StatusLine text={error ?? msg} bad={!!error} />}
        </div>
      </section>
        </>
      )}

      {at("file", "verify") && (
        <>
          {/* Verify this file */}
      <section className="aero-card">
        <div className="aero-card-title flex items-center gap-2">
          <TmIcon name="settings" size={15} /> Verify this file
        </div>
        <div className="p-3 space-y-2 text-[12px]">
          <div className="text-slate-500">
            Reads the whole file back against itself: SQLite&apos;s own integrity check, every account&apos;s balance
            against the sum of its transactions, transfers missing their other half, splits that do not add up, and
            split lines whose row in the other account no longer matches them. Nothing is changed unless you ask.
          </div>
          <div className="flex gap-2">
            <button className="aero-btn" type="button" onClick={() => void verify(false)} disabled={checking || busy}>
              {checking ? "Checking…" : "Check"}
            </button>
            {check && (check.drift.length > 0 || check.half_transfers.length > 0 || check.split_transfers.length > 0) && (
              <button className="aero-btn" type="button" onClick={() => void verify(true)} disabled={checking || busy} title="Recompute the drifted balances from their rows; unlink transfers whose other half is gone; bring split lines' rows in other accounts back in line where only one answer is possible">
                Repair balances
              </button>
            )}
          </div>
          {check && (
            <div className="space-y-1" role="status" aria-label="File check results">
              <div>
                {check.accounts} accounts, {check.transactions.toLocaleString("en-US")} transactions.{" "}
                {check.integrity.length === 0 && check.foreign_keys.length === 0 && check.drift.length === 0 && check.half_transfers.length === 0 && check.split_mismatch.length === 0 && check.split_transfers.length === 0 ? (
                  <span className="text-[color:var(--tm-positive)] font-bold">Everything checks out.</span>
                ) : null}
              </div>
              {check.integrity.length > 0 && (
                <div className="money-neg">
                  <b>Integrity:</b> {check.integrity.join("; ")} — restore a backup rather than continuing with this file.
                </div>
              )}
              {check.foreign_keys.length > 0 && (
                <div className="money-neg">
                  <b>Broken references:</b> {check.foreign_keys.join("; ")}
                </div>
              )}
              {check.drift.length > 0 && (
                <div>
                  <b className="money-neg">Balances that disagree with their rows:</b>
                  <ul className="list-disc pl-5">
                    {check.drift.map((d) => (
                      <li key={d.account_id}>
                        {d.account_name}: stored {formatMoney(d.stored_cents)}, rows add to {formatMoney(d.computed_cents)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {check.half_transfers.length > 0 && (
                <div>
                  <b className="money-neg">Transfers missing their other half:</b> {check.half_transfers.join("; ")}
                </div>
              )}
              {check.split_mismatch.length > 0 && (
                <div>
                  <b className="money-neg">Splits that do not add up</b> (open each and fix it by hand): {check.split_mismatch.join("; ")}
                </div>
              )}
              {check.split_transfers.length > 0 && (
                <div>
                  <b className="money-neg">Split lines out of step with the other account:</b>
                  <ul className="list-disc pl-5">
                    {check.split_transfers.map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                </div>
              )}
              {check.repaired.length > 0 && (
                <div>
                  <b>Repaired:</b> {check.repaired.join("; ")}
                </div>
              )}
            </div>
          )}
          {where === "verify" && <StatusLine text={error ?? msg} bad={!!error} />}
        </div>
      </section>
        </>
      )}

      {at("security", "key") && (
        <>
          {/* Master key */}
      <section className="aero-card">
        <div className="aero-card-title flex items-center gap-2">
          <TmIcon name="settings" size={15} /> Master Key
        </div>
        <div className="p-3 space-y-2">
          {/* The warning is permanent, not dismissable. It describes a way to
              lose everything that no amount of care with the app prevents. */}
          <div className="tm-keywarn text-[12px]">
            <strong>Save this key somewhere safe.</strong> It is stored only in
            this computer&rsquo;s credential manager. It decrypts your database{" "}
            <em>and every backup of it</em> — so if this Windows profile is lost
            or reinstalled and you have not written the key down, those files
            cannot be opened again by anyone, including you.
          </div>

          <div className="text-[12px] text-slate-600">
            {keyStatus?.has_key
              ? "A master key is stored in the OS keyring."
              : "No master key found."}
          </div>

          {revealed ? (
            <div className="space-y-1">
              <code className="tm-keyvalue">{revealed}</code>
              <div className="flex gap-2">
                <button
                  className="aero-btn"
                  type="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(revealed);
                    setMsg("Key copied to the clipboard.");
                  }}
                >
                  Copy
                </button>
                <button className="aero-btn" type="button" onClick={() => setRevealed(null)}>
                  Hide
                </button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <button className="aero-btn" type="button" onClick={() => void reveal()}>
                Show my key
              </button>
              <button className="aero-btn" type="button" onClick={() => void saveKeyToFile()}>
                <span className="inline-flex items-center gap-1">
                  <TmIcon name="export" size={13} /> Save to a file…
                </span>
              </button>
            </div>
          )}

          <form onSubmit={changeKey} className="space-y-2">
            <label className="block text-[11px] text-slate-600">
              New master key
              <input
                type="password"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                className="mt-1 w-full rounded px-2 py-1 text-[12px] border"
                style={{ borderColor: "var(--tm-ms-card-border)" }}
                placeholder="min 8 characters"
                autoComplete="new-password"
              />
            </label>
            <label className="block text-[11px] text-slate-600">
              Confirm new key
              <input
                type="password"
                value={confirmKey}
                onChange={(e) => setConfirmKey(e.target.value)}
                className="mt-1 w-full rounded px-2 py-1 text-[12px] border"
                style={{ borderColor: "var(--tm-ms-card-border)" }}
                placeholder="repeat the key"
                autoComplete="new-password"
              />
            </label>
            <button className="aero-btn w-full" disabled={busy}>
              {busy ? "Working…" : "Change Master Key"}
            </button>
          </form>
          {where === "key" && <StatusLine text={error ?? msg} bad={!!error} />}
        </div>
      </section>
        </>
      )}

      {at("file", "backup") && (
        <>
          {/* Automatic backup */}
      <section className="aero-card">
        <div className="aero-card-title flex items-center gap-2">
          <TmIcon name="export" size={15} /> Automatic backup
        </div>
        <div className="p-3 space-y-2 text-[12px]">
          <div className="text-slate-600">
            One encrypted copy a day the first time you open T-Money, and — if you
            want it — another every time you close. Backups are encrypted with the
            same master key, so keep a copy of the key somewhere other than the
            backup folder.
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex items-center gap-1">
              <input
                type="checkbox"
                checked={backupCfg?.enabled ?? false}
                disabled={busy}
                onChange={(e) => {
                  // Turning it on without a folder asks for one rather than
                  // refusing: choosing the folder is what turns it on.
                  if (e.target.checked && !backupCfg?.folder) {
                    void ensureBackupFolder("enabled");
                    return;
                  }
                  void saveBackupCfg({ enabled: e.target.checked });
                }}
              />
              Back up automatically
            </label>
            {/* Asked for: a backup on exit.
                The daily one answers "you have not backed up today". This one
                answers the question that matters when the file gets carried
                between machines: is what I just did safe anywhere but here. */}
            <label
              className="inline-flex items-center gap-1"
              title="A copy is written when you close the app or close the file — at most one every 15 minutes, so an evening of opening and closing does not push your older backups out."
            >
              <input
                type="checkbox"
                checked={backupCfg?.on_exit ?? false}
                disabled={busy}
                onChange={(e) => {
                  if (e.target.checked && !backupCfg?.folder) {
                    void ensureBackupFolder("on_exit");
                    return;
                  }
                  void saveBackupCfg({ onExit: e.target.checked });
                }}
              />
              Back up when I close
            </label>
            <button className="aero-btn" type="button" onClick={() => void chooseBackupFolder()}>
              {backupCfg?.folder ? "Change folder…" : "Choose a folder…"}
            </button>
            <label className="inline-flex items-center gap-1">
              Keep
              <input
                className="aero-field w-14"
                type="number"
                min={1}
                aria-label="Backups to keep"
                value={keepText ?? String(backupCfg?.keep ?? 10)}
                onChange={(e) => setKeepText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
                onBlur={() => {
                  if (keepText === null) return;
                  const n = Math.max(1, Math.floor(Number(keepText) || 1));
                  setKeepText(null);
                  if (n !== (backupCfg?.keep ?? 10)) {
                    void saveBackupCfg({ keep: n });
                  }
                }}
              />
              most recent
            </label>
            <button
              className="aero-btn"
              type="button"
              disabled={busy}
              onClick={() => void backupNow()}
            >
              Back up now
            </button>
          </div>
          <div className="text-slate-600">
            {backupCfg?.folder ? (
              <>
                Folder: <code>{backupCfg.folder}</code> ·{" "}
                {backupCfg.last_at
                  ? `last backup ${new Date(backupCfg.last_at).toLocaleString()}`
                  : "no backup taken yet"}
                {backupCfg.existing.length > 0 && (
                  <> · {backupCfg.existing.length} kept</>
                )}
              </>
            ) : (
              <>No folder chosen yet, so nothing is being backed up. Choosing one turns automatic backups on.</>
            )}
          </div>
          {where === "autobackup" && <StatusLine text={error ?? msg} bad={!!error} />}
        </div>
      </section>
        </>
      )}

      {at("advanced", "developer") && (
        <>
          {/* Developer — dev builds only (see IS_DEV). */}
      {IS_DEV && (
        <section className="aero-card">
          <div className="aero-card-title flex items-center gap-2">
            <TmIcon name="settings" size={15} /> Developer
          </div>
          <div className="p-3 space-y-2">
            <div className="text-[12px] text-slate-600">
              Fill the file with a realistic demo set — four accounts, six
              months of transactions, check numbers, transfers, splits,
              budgets and a reconciled statement. It <strong>adds</strong> new
              accounts and never touches what is already here.
            </div>
            <div className="text-[11px] text-slate-500">
              Back up first (above) if this file has anything you want to keep.
              This card and the command behind it exist only in a development
              build.
            </div>
            <button className="aero-btn" onClick={seedDemo} disabled={busy}>
              {busy ? "Working…" : "Seed demo data"}
            </button>
            {where === "developer" && <StatusLine text={error ?? msg} bad={!!error} />}
          </div>
        </section>
      )}
        </>
      )}

      {/* Anything that did not say which card it came from still gets said. */}
      {(msg || error) && where === null && <StatusLine text={error ?? msg} bad={!!error} />}
      </div>
    </div>
  );
}

/** Exchange rates: home-currency units per one unit of each currency, by date. Its own
 *  status line, so a result is said on the pane that produced it. */
function CurrenciesPane() {
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [rates, setRates] = useState<ExchangeRate[] | null>(null);
  const [code, setCode] = useState("");
  const [date, setDate] = useState(() => today());
  const [rateText, setRateText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Rates are quoted in the home currency, so it has none of its own.
  const home = useFileFormat((s) => s.home);
  const foreign = currencies.filter((c) => c.code !== home);
  const pick = code || foreign[0]?.code || "";

  async function reload() {
    setRates(await api.listExchangeRates());
    // Accounts carry today's rate; a changed rate changes their worth at home.
    await useAccountStore.getState().loadAccounts().catch(() => {});
  }

  useEffect(() => {
    (async () => {
      try {
        setCurrencies(await api.listCurrencies());
        setRates(await api.listExchangeRates());
      } catch (e) {
        setError(String(e));
      }
    })();
  }, []);

  async function run(work: () => Promise<string>) {
    setBusy(true);
    setMsg(null);
    setError(null);
    try {
      setMsg(await work());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const add = () =>
    run(async () => {
      if (!rateText.trim()) throw `Enter what 1 ${pick} is worth in ${homeName()}.`;
      // DateField sends "" for text it cannot read.
      if (!date) throw `Type a date the form can read, such as ${formatDate("2026-08-03")}.`;
      await api.setExchangeRate(pick, date, rateForBackend(rateText));
      setRateText("");
      await reload();
      return `Saved: 1 ${pick} = ${rateText.trim()} ${homeCurrency()} from ${formatDate(date)}.`;
    });

  const remove = (r: ExchangeRate) =>
    run(async () => {
      await api.deleteExchangeRate(r.currency, r.date);
      await reload();
      return `Deleted the ${r.currency} rate of ${formatDate(r.date)}.`;
    });

  // Explicit only: the app never fetches a rate on its own.
  const fetchAll = () =>
    run(async () => {
      const s = await api.fetchExchangeRates(foreign.map((c) => c.code));
      await reload();
      const parts = [`${s.updated} updated`];
      for (const f of s.failures) parts.push(f.symbol ? `${f.symbol}: ${f.reason}` : f.reason);
      const text = parts.join(" · ");
      if (s.updated === 0 && s.failures.length > 0) throw text;
      return text;
    });

  // Grouped by currency, newest first.
  const groups = foreign
    .map((c) => ({
      c,
      rows: (rates ?? []).filter((r) => r.currency === c.code).sort((a, b) => b.date.localeCompare(a.date)),
    }))
    .filter((g) => g.rows.length > 0);

  return (
    <section className="aero-card">
      <div className="aero-card-title flex items-center gap-2">
        <TmIcon name="investments" size={15} /> Currencies — exchange rates
      </div>
      <div className="p-3 space-y-2 text-[12px]">
        <div className="text-slate-500">
          An account can be kept in another currency. Totals, net worth and reports are in {homeName()} ({home}): an
          account's money converts at the rate in force on the day — the latest rate on or before it. The home
          currency and the region are set under Home currency and region.
        </div>
        <div className="flex items-center gap-2">
          <button className="aero-btn" type="button" onClick={() => void fetchAll()} disabled={busy || foreign.length === 0}>
            {busy ? "Working…" : "Get today's rates"}
          </button>
          <span className="text-slate-500">Looks up today's rates online. Only the currency codes are sent.</span>
        </div>

        {rates !== null && groups.length === 0 && (
          <div className="text-slate-600">No exchange rates yet. Add one below, or get today's.</div>
        )}
        {groups.map((g) => (
          <table key={g.c.code} className="register-table" aria-label={`${g.c.code} rates`} style={{ tableLayout: "auto" }}>
            <caption className="text-left font-bold py-1">
              {g.c.code} — {g.c.name}
            </caption>
            <thead>
              <tr>
                <th>Date</th>
                <th className="num">{home} per 1 {g.c.code}</th>
                <th>Source</th>
                <th style={{ width: 80 }} />
              </tr>
            </thead>
            <tbody>
              {g.rows.map((r) => (
                <tr key={r.date}>
                  <td>{formatDate(r.date)}</td>
                  <td className="num">{formatRate(r.rate_micro)}</td>
                  <td className="tm-text-muted">{r.source === "fetched" ? "Fetched" : "Typed"}</td>
                  <td>
                    <button
                      type="button"
                      className="aero-btn !py-0 !px-2 text-[11px]"
                      onClick={() => void remove(r)}
                      disabled={busy}
                      aria-label={`Delete the ${r.currency} rate of ${r.date}`}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}

        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <span className="text-slate-600">Add a rate:</span>
          <span>1</span>
          <select className="aero-field" aria-label="Currency" value={pick} onChange={(e) => setCode(e.target.value)}>
            {foreign.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code} — {c.name}
              </option>
            ))}
          </select>
          <span>=</span>
          <input
            className="aero-field"
            style={{ width: 100 }}
            aria-label={`${home} per unit`}
            value={rateText}
            onChange={(e) => setRateText(e.target.value)}
            placeholder={formatRate(1_087_500)}
          />
          <span>{home} from</span>
          <DateField label="Rate date" value={date} onChange={setDate} width={120} />
          <button className="aero-btn" type="submit" disabled={busy || !pick}>
            Add
          </button>
        </form>
        <StatusLine text={error ?? msg} bad={!!error} />
      </div>
    </section>
  );
}

/** A result, shown against the thing that produced it. */
function StatusLine({ text, bad }: { text: string | null; bad: boolean }) {
  if (!text) return null;
  // A refusal is the shared Notice, as it is everywhere else.
  if (bad)
    return (
      <Notice tone="error" boxed className="mt-2">
        {text}
      </Notice>
    );
  return (
    <div
      className="rounded p-2 text-[12px] mt-2"
      role={bad ? "alert" : "status"}
      style={{
        background: bad ? "var(--tm-ms-error-bg)" : "var(--tm-ms-card-body)",
        border: `1px solid ${bad ? "var(--tm-ms-error-border)" : "var(--tm-ms-card-border)"}`,
        color: bad ? "var(--tm-ms-error-text)" : "var(--tm-ms-text)",
      }}
    >
      {text}
    </div>
  );
}

/**
 * A look's shape, drawn as a wireframe.
 *
 * Deliberately not a screenshot: a screenshot would carry a theme's colors
 * and the point of this picker is that a look has none. Gray boxes in the
 * arrangement the look uses say "this is where things will be" without
 * saying anything about what color they will be.
 */
function LookPreview({ look }: { look: Look }) {
  const box = (style: React.CSSProperties, key?: string | number) => (
    <div key={key} style={{ background: "var(--tm-ms-grid-header-rule)", opacity: 0.55, ...style }} />
  );
  const rows = (n: number, top: number, left: number, w: number) =>
    Array.from({ length: n }, (_, i) =>
      box({ position: "absolute", left, top: top + i * 5, width: w, height: 2, opacity: 0.35 }, i)
    );
  return (
    <div
      className="tm-look-preview"
      aria-hidden="true"
      style={{ background: "var(--tm-ms-row)", border: "1px solid var(--tm-ms-card-border)" }}
    >
      {look.structure === "classic" && (
        <>
          {box({ position: "absolute", inset: "0 0 auto 0", height: 9 })}
          {box({ position: "absolute", left: 0, top: 9, bottom: 0, width: 15, opacity: 0.3 })}
          {rows(look.id === "compact" || look.id === "terminal" ? 9 : 5, 14, 19, 40)}
        </>
      )}
      {look.structure === "sidebar" && (
        <>
          {box({ position: "absolute", left: 0, top: 0, bottom: 0, width: 18 })}
          {rows(6, 6, 23, 36)}
        </>
      )}
      {look.structure === "three-pane" && (
        <>
          {box({ position: "absolute", left: 0, top: 0, bottom: 0, width: 7 })}
          {box({ position: "absolute", left: 8, top: 0, bottom: 0, width: 18, opacity: 0.3 })}
          {rows(6, 6, 29, 30)}
        </>
      )}
      {look.structure === "ribbon" && (
        <>
          {box({ position: "absolute", inset: "0 0 auto 0", height: 6 })}
          {box({ position: "absolute", inset: "7px 0 auto 0", height: 13, opacity: 0.3 })}
          {rows(4, 24, 4, 55)}
        </>
      )}
      {look.structure === "documents" && (
        <>
          {[0, 1, 2].map((i) =>
            box({ position: "absolute", left: 2 + i * 15, top: 1, width: 13, height: 7, opacity: i === 0 ? 0.6 : 0.25 }, i)
          )}
          {rows(6, 12, 4, 55)}
        </>
      )}
      {look.structure === "two-up" && (
        <>
          {/* Two registers, the worked one weightier than the watched one. */}
          {box({ position: "absolute", left: 3, top: 3, width: 27, height: 31 })}
          {rows(5, 8, 6, 21)}
          {box({ position: "absolute", left: 33, top: 3, width: 26, height: 31, opacity: 0.4 })}
          {rows(5, 8, 36, 20)}
        </>
      )}
    </div>
  );
}
