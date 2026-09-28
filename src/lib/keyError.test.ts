// §134 — telling a locked file from a broken one.
import { describe, expect, it } from "vitest";
import { fileNameOf, keyProblem, withoutSentinel } from "./keyError";

describe("keyProblem", () => {
  it("recognizes a file this computer has no key for", () => {
    expect(
      keyProblem(
        "NEEDS_KEY: Maple was not created on this computer — its master key is needed to open it"
      )
    ).toBe("needs");
  });

  it("recognizes a key that does not open the file", () => {
    expect(keyProblem("WRONG_KEY: that key does not open Maple")).toBe("wrong");
  });

  // The important half. Everything that is NOT a key problem must fall
  // through to the banner — offering to take a master key for a path that
  // does not exist is worse than the plain error.
  it("leaves every other failure alone", () => {
    expect(keyProblem("there is no file at E:\\gone.tmny")).toBeNull();
    expect(keyProblem("could not open E:\\x.tmny: disk I/O error")).toBeNull();
    expect(keyProblem(new Error("database is locked"))).toBeNull();
    expect(keyProblem(null)).toBeNull();
    expect(keyProblem("")).toBeNull();
  });
});

describe("withoutSentinel", () => {
  it("hands back a sentence a person can read", () => {
    expect(withoutSentinel("NEEDS_KEY: Maple needs its master key")).toBe(
      "Maple needs its master key"
    );
    expect(withoutSentinel("WRONG_KEY: that key does not open Maple")).toBe(
      "that key does not open Maple"
    );
  });

  it("passes anything else through untouched", () => {
    expect(withoutSentinel("there is no file at E:\\gone.tmny")).toBe(
      "there is no file at E:\\gone.tmny"
    );
  });
});

describe("fileNameOf", () => {
  it("matches what the backend calls the file", () => {
    expect(fileNameOf("E:\\Money\\Maple Street.tmny")).toBe("Maple Street");
    expect(fileNameOf("/home/sam/money/Maple Street.tmny")).toBe("Maple Street");
    expect(fileNameOf("C:\\x\\legacy.db")).toBe("legacy");
  });

  it("copes with no extension and with trailing separators", () => {
    expect(fileNameOf("E:\\Money\\Maple")).toBe("Maple");
    expect(fileNameOf("E:\\Money\\Maple.tmny\\")).toBe("Maple");
  });

  // A dotfile is all name, no extension — slicing at index 0 would leave "".
  it("does not eat a name that starts with a dot", () => {
    expect(fileNameOf("/home/sam/.tmny")).toBe(".tmny");
  });
});
