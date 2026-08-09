/**
 * Small pure text/URL helpers shared by the parsers. No DOM, no network.
 */

/** Collapse whitespace + trim; returns undefined for empty/blank input. */
export function cleanText(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/\s+/g, " ").trim();
  return s.length ? s : undefined;
}

/** First non-empty cleaned string from a value that may be a string or array. */
export function firstString(v: unknown): string | undefined {
  if (Array.isArray(v)) {
    for (const item of v) {
      const s = firstString(item);
      if (s) return s;
    }
    return undefined;
  }
  return cleanText(v);
}

/** Flatten a string | string[] | mixed into a clean, blank-dropped string list. */
export function toStringList(v: unknown): string[] {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : [v];
  const out: string[] = [];
  for (const item of arr) {
    const s = cleanText(typeof item === "string" ? item : undefined);
    if (s) out.push(s);
  }
  return out;
}

/** Resolve a possibly-relative URL against the page URL; undefined if unusable. */
export function absoluteUrl(base: string, maybe: unknown): string | undefined {
  const s = cleanText(maybe);
  if (!s) return undefined;
  try {
    const u = new URL(s, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

/**
 * Split a pasted/HTML text block into non-blank lines. Used by microdata/
 * heuristic fallbacks where ingredients or steps arrive as one blob.
 */
export function splitLines(v: unknown): string[] {
  const s = typeof v === "string" ? v : "";
  return s
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}
