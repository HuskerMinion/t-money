// A thumbnail of the app in a theme: header, tabs, subnav, rail, a
// card with a little chart, and a register with a selected row — drawn
// from the theme's own tokens, so the swatch is a true preview.
import { themeToken, type Theme } from "../lib/theme";

interface Props {
  theme: Theme;
  width?: number;
}

export default function ThemePreview({ theme, width = 220 }: Props) {
  const t = (k: string) => themeToken(theme, k);
  const h = Math.round(width * 0.62);
  const bars = [["series-1", 0.9], ["series-2", 0.55], ["series-4", 0.7], ["series-7", 0.35]] as const;
  return (
    <div
      className="tm-theme-preview"
      aria-hidden="true"
      style={{ width, height: h, background: t("ms-content-bg"), border: `1px solid ${t("ms-card-border")}`, display: "flex", flexDirection: "column", overflow: "hidden", borderRadius: 3 }}
    >
      {/* header + tabs */}
      <div style={{ height: "18%", background: `linear-gradient(180deg, ${t("ms-toolbar-top")}, ${t("ms-tabstrip-top")})`, display: "flex", alignItems: "flex-end", gap: 2, padding: "0 6px" }}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} style={{ width: "13%", height: "55%", background: i === 1 ? t("ms-tab-active-bot") : t("ms-tab-inactive-top"), borderRadius: "2px 2px 0 0" }} />
        ))}
      </div>
      <div style={{ height: "8%", background: t("ms-subnav"), display: "flex", alignItems: "center", paddingLeft: 8, gap: 6 }}>
        <div style={{ width: "10%", height: "40%", background: t("ms-subnav-selected") }} />
        <div style={{ width: "8%", height: "40%", background: "rgba(255,255,255,0.5)" }} />
      </div>
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* rail */}
        <div style={{ width: "24%", background: t("ms-rail-left"), borderRight: `1px solid ${t("ms-rail-divider")}`, padding: 4 }}>
          {[0.7, 0.5, 0.6, 0.4].map((w, i) => (
            <div key={i} style={{ width: `${w * 100}%`, height: 3, marginBottom: 4, background: i === 0 ? t("ms-text-link") : t("ms-rail-divider") }} />
          ))}
        </div>
        {/* content */}
        <div style={{ flex: 1, padding: 5, display: "flex", flexDirection: "column", gap: 4, minHeight: 0 }}>
          <div style={{ border: `1px solid ${t("ms-card-border")}`, background: t("ms-card-body"), flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            <div style={{ height: 6, background: t("ms-card-hdr-top") }} />
            <div style={{ flex: 1, display: "flex", alignItems: "flex-end", gap: 3, padding: "3px 6px" }}>
              {bars.map(([k, f]) => (
                <div key={k} style={{ flex: 1, height: `${f * 100}%`, background: t(k) }} />
              ))}
            </div>
          </div>
          <div style={{ border: `1px solid ${t("ms-grid-line")}`, background: t("ms-row"), flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            <div style={{ height: 5, background: t("ms-grid-header"), borderBottom: `1px solid ${t("ms-grid-header-rule")}` }} />
            {[0, 1, 2, 3].map((i) => (
              <div key={i} style={{ flex: 1, background: i === 2 ? t("ms-row-active") : i % 2 ? t("ms-row-alt") : t("ms-row"), borderBottom: `1px solid ${t("ms-grid-line")}`, display: "flex", alignItems: "center", gap: 4, padding: "0 4px" }}>
                <div style={{ width: "40%", height: 2, background: t("ms-text") }} />
                <div style={{ marginLeft: "auto", width: "15%", height: 2, background: i === 1 ? t("negative") : t("ms-text") }} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
