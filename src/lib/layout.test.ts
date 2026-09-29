// @vitest-environment jsdom
// Looks. The rules worth holding: Money Classic is the default and
// never moves, a look sets no color of its own, and every look names a
// structure the shell knows how to arrange.
import { beforeEach, describe, expect, it } from "vitest";
import { applyLook, DEFAULT_LOOK, LOOKS, lookById, readLook, saveLook, structureOf } from "./layout";
import { THEMES } from "./theme";

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-look");
  document.documentElement.removeAttribute("data-structure");
});

describe("looks", () => {
  it("Money Classic is first and is what you get without choosing", () => {
    // Not a preference the app can drift away from: it is what T-Money is
    // for, and a new look must be something you go and pick.
    expect(LOOKS[0].id).toBe("classic");
    expect(DEFAULT_LOOK).toBe("classic");
    expect(readLook()).toBe("classic");
  });

  it("offers fourteen of them, each with a distinct id and a real blurb", () => {
    expect(LOOKS).toHaveLength(14);
    expect(new Set(LOOKS.map((l) => l.id)).size).toBe(14);
    for (const l of LOOKS) {
      expect(l.label.length, l.id).toBeGreaterThan(2);
      expect(l.blurb.length, l.id).toBeGreaterThan(20);
    }
  });

  it("and fourteen themes, so the two choices are independent", () => {
    expect(THEMES).toHaveLength(14);
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(14);
  });

  it("a look sets a shape, never a color", () => {
    // The whole reason looks and themes are separate settings. A look that
    // carried its own palette would make ten looks times ten themes a hundred
    // things to check instead of twenty.
    for (const l of LOOKS) {
      expect(Object.keys(l), l.id).toEqual(
        expect.arrayContaining(["id", "label", "blurb", "structure"])
      );
      expect(l).not.toHaveProperty("tokens");
    }
  });

  it("puts the look and its structure on the element, classic included", () => {
    // `classic` sets the attribute rather than clearing it: a look that is the
    // absence of an attribute is a look no stylesheet can name.
    applyLook("classic");
    expect(document.documentElement.getAttribute("data-look")).toBe("classic");
    expect(document.documentElement.getAttribute("data-structure")).toBe("classic");

    applyLook("terminal");
    expect(document.documentElement.getAttribute("data-look")).toBe("terminal");
    // Terminal is a restyle of the classic arrangement, not a new one.
    expect(document.documentElement.getAttribute("data-structure")).toBe("classic");

    applyLook("three-pane");
    expect(document.documentElement.getAttribute("data-structure")).toBe("three-pane");
  });

  it("remembers the choice and ignores one it does not recognize", () => {
    saveLook("card");
    expect(readLook()).toBe("card");
    window.localStorage.setItem("tm.look", "no-such-look");
    expect(readLook()).toBe("classic");
  });

  it("falls back to Money Classic for an unknown id rather than throwing", () => {
    expect(lookById("nonsense").id).toBe("classic");
    expect(structureOf("nonsense")).toBe("classic");
  });

  it("names only structures the shell knows how to arrange", () => {
    const known = ["classic", "sidebar", "three-pane", "ribbon", "documents", "two-up"];
    for (const l of LOOKS) expect(known, `${l.id} wants "${l.structure}"`).toContain(l.structure);
  });

  it("a look that suggests a theme names one that exists", () => {
    for (const l of LOOKS.filter((x) => x.suggestsTheme)) {
      expect(THEMES.map((t) => t.id), l.id).toContain(l.suggestsTheme);
    }
  });
});
