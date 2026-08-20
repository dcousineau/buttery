import { describe, expect, it } from "vitest";
import { COLLECTION_DESCRIPTION_MAX_BYTES, COLLECTION_NAME_MAX_BYTES, collectionDescription, collectionName } from "./collections";

/**
 * The length validators (collections plan §8/§9).
 *
 * These caps are the lexicon's, in the lexicon's unit: atproto counts a string's
 * `maxLength` in **UTF-8 bytes**, so the interesting cases are all multi-byte.
 * A validator that counted JS characters would accept a 100-emoji name here and
 * then watch the PDS reject the record at publish time — the one failure mode
 * that cannot be surfaced anywhere near where it was caused.
 *
 * Pure, so no database and no session: these are the schema objects the server
 * functions validate with, exercised directly.
 */

/** A string of exactly `bytes` bytes, built from a 4-byte character. */
function emoji(count: number): string {
  return "😀".repeat(count);
}

describe("collectionName", () => {
  it("accepts a plain name and trims it", () => {
    expect(collectionName.parse("  Weeknights  ")).toBe("Weeknights");
  });

  it("rejects a name that is empty after trimming", () => {
    expect(collectionName.safeParse("   ").success).toBe(false);
  });

  it("accepts exactly the byte cap and rejects one byte over", () => {
    expect(collectionName.parse("a".repeat(COLLECTION_NAME_MAX_BYTES))).toHaveLength(COLLECTION_NAME_MAX_BYTES);
    expect(collectionName.safeParse("a".repeat(COLLECTION_NAME_MAX_BYTES + 1)).success).toBe(false);
  });

  it("counts UTF-8 bytes, not characters", () => {
    // 25 four-byte emoji = 100 bytes = exactly the cap, in 25 characters.
    expect(collectionName.safeParse(emoji(COLLECTION_NAME_MAX_BYTES / 4)).success).toBe(true);
    expect(collectionName.safeParse(emoji(COLLECTION_NAME_MAX_BYTES / 4 + 1)).success).toBe(false);
  });

  it("measures after trimming, so surrounding whitespace never costs the author a character", () => {
    expect(collectionName.safeParse(`  ${"a".repeat(COLLECTION_NAME_MAX_BYTES)}  `).success).toBe(true);
  });

  it("bounds a hostile input long before it is trimmed", () => {
    expect(collectionName.safeParse(" ".repeat(1_000_000)).success).toBe(false);
  });
});

describe("collectionDescription", () => {
  it("accepts a description and trims it", () => {
    expect(collectionDescription.parse("  quick ones  ")).toBe("quick ones");
  });

  it("turns an empty description into null, so the record omits the field", () => {
    expect(collectionDescription.parse("")).toBeNull();
    expect(collectionDescription.parse("   ")).toBeNull();
  });

  it("accepts exactly the byte cap and rejects one byte over", () => {
    expect(collectionDescription.safeParse("a".repeat(COLLECTION_DESCRIPTION_MAX_BYTES)).success).toBe(true);
    expect(collectionDescription.safeParse("a".repeat(COLLECTION_DESCRIPTION_MAX_BYTES + 1)).success).toBe(false);
  });

  it("counts UTF-8 bytes, not characters", () => {
    expect(collectionDescription.safeParse(emoji(COLLECTION_DESCRIPTION_MAX_BYTES / 4)).success).toBe(true);
    expect(collectionDescription.safeParse(emoji(COLLECTION_DESCRIPTION_MAX_BYTES / 4 + 1)).success).toBe(false);
  });
});
