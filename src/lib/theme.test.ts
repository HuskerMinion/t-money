// @vitest-environment jsdom
// Read the token sheet off disk: the CSS pipeline stubs .css imports in
// tests, and the check here is about the file's text.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PREVIEW_DEFAULTS, THEMES, applyTheme, isDark, readTheme, saveTheme, themeToken, toggleDark } from "./theme";

const tokensCss: string = readFileSync("src/branding/tm-tokens.css", "utf8");


describe("themes (§63)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    applyTheme("money");
  });

  it("only override tokens that exist in tm-tokens.css, and preview defaults are real tokens too", () => {
    for (const t of THEMES) {
      for (const k of Object.keys(t.tokens)) expect(tokensCss, `${t.id} sets --tm-${k}`).toContain(`--tm-${k}:`);
    }
    for (const k of Object.keys(PREVIEW_DEFAULTS)) expect(tokensCss, `preview default --tm-${k}`).toContain(`--tm-${k}:`);
    // Money's preview values are the measured ones.
    expect(tokensCss).toContain(`--tm-ms-row-active: ${PREVIEW_DEFAULTS["ms-row-active"]}`);
  });

  it("applies a theme as inline custom properties and clears them on the way back", () => {
    const root = document.documentElement;
    applyTheme("forest");
    expect(root.style.getPropertyValue("--tm-ms-subnav")).toBe("#2f6b48");
    expect(root.getAttribute("data-theme")).toBeNull();
    applyTheme("evening");
    expect(root.style.getPropertyValue("--tm-ms-row")).toBe("#161e2a");
    expect(root.getAttribute("data-theme")).toBe("dark");
    applyTheme("money");
    expect(root.style.getPropertyValue("--tm-ms-subnav")).toBe("");
    expect(root.style.getPropertyValue("--tm-ms-row")).toBe("");
    expect(root.getAttribute("data-theme")).toBeNull();
  });

  it("remembers the choice and falls back to Money for nonsense", () => {
    expect(readTheme()).toBe("money");
    saveTheme("plum");
    expect(readTheme()).toBe("plum");
    window.localStorage.setItem("tm.theme", "neon");
    expect(readTheme()).toBe("money");
  });

  it("previews with the theme's value or Money's", () => {
    const forest = THEMES.find((t) => t.id === "forest")!;
    expect(themeToken(forest, "ms-subnav")).toBe("#2f6b48");
    expect(themeToken(forest, "ms-row")).toBe("#ffffff");
  });
});

// §87: the header's one-click light/dark.
describe("toggleDark", () => {
  it("goes to Evening and back to the light theme it left", () => {
    window.localStorage.clear();
    saveTheme("forest");
    applyTheme("forest");
    expect(toggleDark()).toBe("evening");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(readTheme()).toBe("evening");
    expect(toggleDark()).toBe("forest");
    expect(document.documentElement.getAttribute("data-theme")).toBeNull();
    expect(isDark("evening")).toBe(true);
    expect(isDark("copper")).toBe(false);
  });
});


// §102 — the bug this locks out.
//
// The menu bar's hover state painted `--tm-ms-tab-active-bot` and hard-coded
// WHITE text on top. That is fine for nine themes and wrong for the tenth:
// High contrast makes the active tab white, so hovering File or Edit painted
// white on white and the label vanished under the pointer until you moved
// off it. Reported from use, not from a test — because there was no test that
// could see it.
//
// A color pair is not a matter of taste, so it does not belong in a
// walkthrough. Every theme that ships is checked here.
const hex = (c: string): [number, number, number] => {
  const h = c.replace("#", "").trim();
  const full = h.length === 3 ? [...h].map((x) => x + x).join("") : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
};
/** WCAG relative luminance. */
const lum = (c: string): number => {
  const [r, g, b] = hex(c).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string): number => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

/** What a token resolves to for a theme: its own value, else the chain the
 *  token sheet declares, else Money's. Mirrors what the browser does. */
function resolved(themeId: string, key: string, fallbackKey?: string): string {
  const theme = THEMES.find((t) => t.id === themeId)!;
  return (
    theme.tokens[key] ??
    (fallbackKey ? theme.tokens[fallbackKey] : undefined) ??
    PREVIEW_DEFAULTS[key] ??
    (fallbackKey ? PREVIEW_DEFAULTS[fallbackKey] : undefined) ??
    "#ffffff"
  );
}

describe("every theme keeps its chrome readable (§102)", () => {
  for (const theme of THEMES) {
    it(`${theme.label}: a hovered menu item can be read`, () => {
      const bg = resolved(theme.id, "ms-chrome-sel", "ms-tab-active-bot");
      const fg = resolved(theme.id, "ms-chrome-sel-text");
      const ratio = contrast(bg, fg);
      expect(
        ratio,
        `${theme.label}: menu hover is ${fg} on ${bg} — ${ratio.toFixed(2)}:1`
      ).toBeGreaterThanOrEqual(4.5);
    });

    it(`${theme.label}: both navigation tabs can be read`, () => {
      const activeBg = resolved(theme.id, "ms-tab-active-bot");
      const activeFg = resolved(theme.id, "ms-tab-active-text");
      const idleBg = resolved(theme.id, "ms-tab-inactive-bot", "ms-tab-inactive-top");
      const idleFg = resolved(theme.id, "ms-tab-text");
      // 3:1 for tab labels — they are bold at 12px and sit on a gradient, so
      // this is the large-text threshold rather than body text's 4.5.
      expect(
        contrast(activeBg, activeFg),
        `${theme.label}: active tab is ${activeFg} on ${activeBg}`
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrast(idleBg, idleFg),
        `${theme.label}: inactive tab is ${idleFg} on ${idleBg}`
      ).toBeGreaterThanOrEqual(3);
    });
  }

  /// §142 — and the thing that keeps it done.
  ///
  /// `tm-tokens.css` is supposed to be the single source for color, and the
  /// reason it matters is that a literal cannot be overridden: three
  /// `text-[#1e7b34]` spans stayed Money's light-theme green on all three
  /// dark themes, where the theme's own --tm-positive is #4fd08a. That is
  /// the §19.2 class exactly — a color nothing looked at.
  ///
  /// Chrome-less files are checked, not just the ones that were wrong: the
  /// point is that the NEXT one cannot be written either.
  it("no component carries a color of its own", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          const hits = readFileSync(full, "utf8").match(/#[0-9a-fA-F]{6}/g);
          if (hits) offenders.push(`${full}: ${[...new Set(hits)].join(", ")}`);
        }
      }
    };
    walk("src/components");
    expect(offenders, "use a --tm-* token from tm-tokens.css, not a literal").toEqual([]);
  });

  /// §142 — the error box was three literals, so it was a light pink card on
  /// a near-black screen. Now it is a token, which means every theme has to
  /// answer for it the way it already answers for the amber warning box.
  it("every theme's error box is readable", () => {
    for (const theme of THEMES) {
      const bg = themeToken(theme, "ms-error-bg");
      const fg = themeToken(theme, "ms-error-text");
      expect(
        contrast(bg, fg),
        `${theme.label}: error text is ${fg} on ${bg}`
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("the token sheet gives the chrome pair a default, so a new theme inherits one", () => {
    expect(tokensCss).toContain("--tm-ms-chrome-sel:");
    expect(tokensCss).toContain("--tm-ms-chrome-sel-text:");
    expect(tokensCss).toContain("--tm-ms-tab-active-text:");
  });
});
