import { describe, expect, it } from "vitest";
import { ulid } from "./ids";

/**
 * ULID minting for `household.id` / `household_invite.id`. Must match the exact
 * 26-char Crockford-base32 shape the `recipe` layer validates against, so our
 * private ids are indistinguishable in shape from network-sourced rkeys.
 */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe("ulid", () => {
  it("produces a 26-char Crockford-base32 id", () => {
    expect(ulid()).toMatch(ULID_RE);
  });

  it("is unique across many calls", () => {
    const set = new Set(Array.from({ length: 1000 }, () => ulid()));
    expect(set.size).toBe(1000);
  });

  it("is time-prefixed (roughly sortable): later timestamps sort later", () => {
    const early = ulid(1_000_000_000_000);
    const late = ulid(2_000_000_000_000);
    // Compare only the 10-char time prefix; the random suffix is noise.
    expect(early.slice(0, 10) < late.slice(0, 10)).toBe(true);
  });
});
