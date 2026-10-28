// The register request: taken once, by the right account, while fresh.
import { describe, expect, it, vi } from "vitest";
import { onRegisterRequest, requestRegisterAction, takeRegisterAction } from "./registerRequest";

describe("registerRequest", () => {
  it("is taken once, and only by its own account", () => {
    requestRegisterAction({ accountId: "a", action: { kind: "reconcile" } });
    expect(takeRegisterAction("b")).toBeNull();
    expect(takeRegisterAction("a")).toEqual({ kind: "reconcile" });
    expect(takeRegisterAction("a")).toBeNull();
  });

  it("a request nobody took in time is dropped, not run the next time that account opens", () => {
    requestRegisterAction({ accountId: "a", action: { kind: "reconcile" } });
    expect(takeRegisterAction("a", Date.now() + 60_000)).toBeNull();
    expect(takeRegisterAction("a")).toBeNull();
  });

  it("tells whoever is listening, until they stop", () => {
    const heard = vi.fn();
    const stop = onRegisterRequest(heard);
    requestRegisterAction({ accountId: "a", action: { kind: "value" } });
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
    requestRegisterAction({ accountId: "a", action: { kind: "value" } });
    expect(heard).toHaveBeenCalledTimes(1);
    takeRegisterAction("a");
  });
});
