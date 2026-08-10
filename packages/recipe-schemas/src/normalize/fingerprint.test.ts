import { describe, expect, it } from "vitest";
import { contentFingerprint, contentFingerprintInput, normalizeLine } from "./fingerprint.ts";

describe("normalizeLine", () => {
  it("lowercases, collapses whitespace and trims", () => {
    expect(normalizeLine("  2  CUPS   All-Purpose Flour ")).toBe("2 cups all-purpose flour");
    expect(normalizeLine("2\tcups\nflour")).toBe("2 cups flour");
  });

  it("folds diacritics", () => {
    expect(normalizeLine("Crème Brûlée")).toBe("creme brulee");
    expect(normalizeLine("jalapeño")).toBe("jalapeno");
  });

  it("NFKC-folds compatibility forms", () => {
    expect(normalizeLine("ﬁnely diced")).toBe("finely diced");
    expect(normalizeLine("½ cup")).toBe("1⁄2 cup");
  });

  it("drops edge punctuation but keeps interior digits, letters and fraction slashes", () => {
    expect(normalizeLine("(1/2 cup sugar),")).toBe("1/2 cup sugar");
    expect(normalizeLine("—  Salt & pepper.  ")).toBe("salt & pepper");
    expect(normalizeLine("***")).toBe("");
  });
});

describe("contentFingerprintInput", () => {
  it("puts the normalized name first, then normalized ingredients sorted", () => {
    expect(contentFingerprintInput("Brown Butter Cookies", ["2 cups flour", "1 cup Sugar"])).toBe("brown butter cookies\n1 cup sugar\n2 cups flour");
  });

  it("sorts on the normalized line, not the raw one", () => {
    // Raw "  Zest" sorts before "apple" by code unit; normalized it does not.
    expect(contentFingerprintInput("x", ["  Zest of 1 lemon", "apple"])).toBe("x\napple\nzest of 1 lemon");
  });

  it("drops ingredient lines that normalize to nothing", () => {
    expect(contentFingerprintInput("x", ["", "   ", "***", "salt"])).toBe("x\nsalt");
  });
});

describe("contentFingerprint", () => {
  it("is a sha256: prefixed lowercase hex digest", async () => {
    await expect(contentFingerprint("Cookies", ["flour"])).resolves.toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is stable under ingredient reordering", async () => {
    const a = await contentFingerprint("Cookies", ["2 cups flour", "1 cup sugar", "1 tsp salt"]);
    const b = await contentFingerprint("Cookies", ["1 tsp salt", "2 cups flour", "1 cup sugar"]);
    expect(a).toBe(b);
  });

  it("is stable under whitespace and case changes", async () => {
    const a = await contentFingerprint("Brown Butter Cookies", ["2 cups flour", "1 cup sugar"]);
    const b = await contentFingerprint("  brown   butter cookies ", ["2  CUPS  Flour", "1 Cup   SUGAR  "]);
    expect(a).toBe(b);
  });

  it("folds diacritics", async () => {
    const a = await contentFingerprint("Creme Brulee", ["1 cup creme fraiche"]);
    const b = await contentFingerprint("Crème Brûlée", ["1 cup crème fraîche"]);
    expect(a).toBe(b);
  });

  it("changes when the name changes", async () => {
    const a = await contentFingerprint("Cookies", ["2 cups flour"]);
    const b = await contentFingerprint("Biscuits", ["2 cups flour"]);
    expect(a).not.toBe(b);
  });

  it("changes when an ingredient changes", async () => {
    const a = await contentFingerprint("Cookies", ["2 cups flour"]);
    const b = await contentFingerprint("Cookies", ["3 cups flour"]);
    expect(a).not.toBe(b);
  });

  it("hashes exactly contentFingerprintInput, so the migration can reproduce it", async () => {
    const input = contentFingerprintInput("Cookies", ["2 cups flour", "1 cup sugar"]);
    const expected = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));
    let hex = "";
    for (const byte of expected) hex += byte.toString(16).padStart(2, "0");
    await expect(contentFingerprint("Cookies", ["2 cups flour", "1 cup sugar"])).resolves.toBe(`sha256:${hex}`);
  });
});
