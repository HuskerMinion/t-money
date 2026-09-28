import { describe, expect, it } from "vitest";
import { isFinding, matchGroups } from "./findOnPage";

const g = (parent: string, ...children: string[]) => ({
  parent: { name: parent },
  children: children.map((name) => ({ name })),
});
const GROUPS = [g("Bills", "Electricity", "Heating oil", "Water"), g("Food", "Groceries"), g("Heating oil delivery")];

describe("§156 — Find on this page", () => {
  it("matches a child and shows it under its parent with only the matching siblings", () => {
    const out = matchGroups(GROUPS, "heat");
    expect(out.map((x) => x.parent.name)).toEqual(["Bills", "Heating oil delivery"]);
    expect(out[0].children.map((c) => c.name)).toEqual(["Heating oil"]);
  });

  it("keeps every child when the parent itself matches", () => {
    const out = matchGroups(GROUPS, "bills");
    expect(out).toHaveLength(1);
    expect(out[0].children.map((c) => c.name)).toEqual(["Electricity", "Heating oil", "Water"]);
  });

  it("is case-insensitive and ignores surrounding spaces", () => {
    expect(matchGroups(GROUPS, "  WATER ")[0].children.map((c) => c.name)).toEqual(["Water"]);
  });

  it("an empty query is not a find", () => {
    expect(matchGroups(GROUPS, "   ")).toEqual(GROUPS);
    expect(isFinding("   ")).toBe(false);
    expect(isFinding("w")).toBe(true);
  });

  it("nothing matching is an empty list, not everything", () => {
    expect(matchGroups(GROUPS, "mortgage")).toEqual([]);
  });
});
