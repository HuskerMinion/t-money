import { beforeEach, describe, expect, it } from "vitest";
import { clampRail, loadRailWidth, RAIL_DEFAULT, RAIL_MAX, RAIL_MIN, saveRailWidth } from "./railWidth";

beforeEach(() => window.localStorage.clear());

describe("the rail width", () => {
  it("clamps to a sensible range and survives garbage", () => {
    expect(clampRail(10)).toBe(RAIL_MIN);
    expect(clampRail(9000)).toBe(RAIL_MAX);
    expect(clampRail(300.6)).toBe(301);
    expect(clampRail(NaN)).toBe(RAIL_DEFAULT);
  });
  it("round-trips through storage and defaults when empty", () => {
    expect(loadRailWidth()).toBe(RAIL_DEFAULT);
    saveRailWidth(320);
    expect(loadRailWidth()).toBe(320);
    window.localStorage.setItem("tm.railWidth", "junk");
    expect(loadRailWidth()).toBe(RAIL_DEFAULT);
  });
});
