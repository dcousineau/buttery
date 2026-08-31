import { describe, expect, it } from "vitest";
import { escapeLikePattern } from "./escape-like";

describe("escapeLikePattern (meal randomizer plan §4.4)", () => {
  it("escapes a literal percent sign", () => {
    expect(escapeLikePattern("5% milk")).toBe("5\\% milk");
  });

  it("escapes a literal underscore", () => {
    expect(escapeLikePattern("all_purpose flour")).toBe("all\\_purpose flour");
  });

  it("escapes a literal backslash", () => {
    expect(escapeLikePattern("a\\b")).toBe("a\\\\b");
  });

  it("escapes the backslash BEFORE the wildcards, so it does not double-escape", () => {
    // If `_`/`%` were escaped first, this input's `\%` would become `\\%`
    // (a literal backslash + wildcard) instead of `\\%` meaning literal `%`... the
    // load-bearing assertion is the exact output below, not the prose.
    expect(escapeLikePattern("\\%")).toBe("\\\\\\%");
  });

  it("passes plain text through unchanged", () => {
    expect(escapeLikePattern("chicken thigh")).toBe("chicken thigh");
  });

  it("handles an empty string", () => {
    expect(escapeLikePattern("")).toBe("");
  });

  it("escapes every occurrence, not just the first", () => {
    expect(escapeLikePattern("%%__")).toBe("\\%\\%\\_\\_");
  });
});
