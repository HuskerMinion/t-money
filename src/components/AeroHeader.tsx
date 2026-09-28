// Glossy ocean-blue Aero header with the MS Money Plus navigation tabs.
import { useEffect, useState } from "react";
import logoMark from "../assets/branding/tm-logo-mark-compact.svg";
import TmIcon from "./TmIcon";
import { isDark, readTheme, toggleDark } from "../lib/theme";

const TABS = [
  "Home",
  "Banking",
  "Bills",
  "Reports",
  "Budget",
  "Investing",
  "Planning",
  "Taxes",
  "Help",
] as const;

export type Tab = (typeof TABS)[number] | "Settings" | "Search";

interface AeroHeaderProps {
  active: Tab;
  onTab: (tab: Tab) => void;
  /** Enter, or the magnifier, in the Search box (§38). */
  onSearch?: (query: string) => void;
  /** §99: false when the look navigates somewhere else — the Sidebar look
   *  puts the tabs in the rail, Tiles puts them on the wall. The header keeps
   *  the brand and the search box either way, because those belong to the app
   *  rather than to a way of getting around it. */
  showTabs?: boolean;
  /** §100: the gear opens the Settings pop-up rather than navigating to a
   *  tab — you come back from settings, you do not travel to them. */
  onSettings?: () => void;
}

export default function AeroHeader({ active, onTab, onSearch, showTabs = true, onSettings }: AeroHeaderProps) {
  const [query, setQuery] = useState("");
  const [dark, setDark] = useState(() => isDark(readTheme()));
  // §183 — follow a theme chosen in Settings, not only this button. The
  // state was read once, so picking Evening in Settings left the button
  // offering "Switch to the dark theme" over an app that already was.
  // `applyTheme` marks a dark theme on <html>, which is the one place every
  // way of changing it agrees on — the same watch App keeps for the look.
  useEffect(() => {
    const el = document.documentElement;
    const ob = new MutationObserver(() => setDark(el.getAttribute("data-theme") === "dark"));
    ob.observe(el, { attributes: true, attributeFilter: ["data-theme"] });
    return () => ob.disconnect();
  }, []);
  function submit() {
    const q = query.trim();
    if (q) onSearch?.(q);
  }
  return (
    <header className="aero-header flex items-stretch gap-2 px-3 pt-2 pb-0 select-none">
      {/* Brand */}
      <div className="flex items-center gap-2 pr-3">
        <img
          src={logoMark}
          alt="T-Money"
          className="h-7 w-7"
          style={{ filter: "drop-shadow(0 1px 1px rgba(0,0,0,.35))" }}
        />
        <div className="leading-tight">
          <div className="text-white font-bold text-[15px]" style={{ textShadow: "0 1px 1px rgba(0,0,0,.4)" }}>
            T-Money
          </div>
          <div className="text-[10px]" style={{ color: "var(--tm-sky-tint)" }}>Personal Finance</div>
        </div>
      </div>

      {/* Nav tabs */}
      <nav className="flex items-end gap-1 flex-1" hidden={!showTabs}>
        {TABS.map((t) => (
          <button
            key={t}
            className={`aero-tab ${active === t ? "active" : ""}`}
            onClick={() => onTab(t)}
          >
            {t}
          </button>
        ))}
      </nav>

      {/* §87: light / dark, one click. Settings → Theme still picks among all. */}
      <button
        className="aero-gear self-center"
        type="button"
        onClick={() => setDark(isDark(toggleDark()))}
        title={dark ? "Switch to the light theme" : "Switch to the dark theme (Evening)"}
        aria-label={dark ? "Switch to the light theme" : "Switch to the dark theme"}
        aria-pressed={dark}
        style={{ fontSize: 16, lineHeight: 1 }}
      >
        {dark ? "\u2600" : "\u263E"}
      </button>

      {/* Settings gear */}
      <button
        className={`aero-gear self-center ${active === "Settings" ? "active" : ""}`}
        onClick={() => (onSettings ? onSettings() : onTab("Settings"))}
        title="Settings"
        aria-label="Settings"
      >
        <TmIcon name="settings" size={19} />
      </button>

      {/* Search. The colors are tokens, not literals: this box had a
          hard-coded near-white ground and no `color` at all, so under the
          Evening theme it inherited that theme's light text and typed
          characters came out white on white — you could search, you just
          could not read what you had typed (§96). */}
      <div className="flex items-center pb-1">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="Search"
          aria-label="Search transactions"
          className="tm-header-search w-40 rounded-l px-2 py-1 text-[12px] outline-none"
        />
        <button className="tm-header-search-go rounded-r px-2 py-1 text-[12px]" type="button" aria-label="Search" onClick={submit}>
          <TmIcon name="search" size={14} />
        </button>
      </div>
    </header>
  );
}
