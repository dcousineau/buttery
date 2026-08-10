/**
 * Content fingerprint for dedupe, for the recipes that arrive with no source
 * URL. Uses WebCrypto only — no `node:crypto` — so the same module runs in the
 * browser probe and on the server and cannot drift between them.
 */

/**
 * Fold a name or ingredient line down to the text that actually identifies it,
 * so casing, spacing, accents and stray punctuation don't make two copies of
 * the same recipe look different.
 */
export function normalizeLine(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/[^\p{L}\p{N}]+$/u, "");
}

/**
 * Build the exact string that gets hashed. Exported separately so the backfill
 * migration and tests can assert on the pre-hash input rather than on a digest,
 * where a mismatch tells you nothing about which side moved.
 *
 * Ingredients are sorted AFTER normalization so reordering doesn't change the
 * fingerprint; instructions are excluded because step-splitting varies far more
 * than ingredient text; the name is included so two unrelated recipes with a
 * coincidentally identical ingredient set don't collide.
 */
export function contentFingerprintInput(name: string, ingredients: readonly string[]): string {
  // Default (code-unit) sort, never localeCompare — the order must not depend on the host's locale.
  const lines = ingredients
    .map(normalizeLine)
    .filter((line) => line.length > 0)
    .sort();
  return `${normalizeLine(name)}\n${lines.join("\n")}`;
}

/** `"sha256:"`-prefixed digest of {@link contentFingerprintInput}, ready to store as a dedupe key. */
export async function contentFingerprint(name: string, ingredients: readonly string[]): Promise<string> {
  const bytes = new TextEncoder().encode(contentFingerprintInput(name, ingredients));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return `sha256:${hex}`;
}
