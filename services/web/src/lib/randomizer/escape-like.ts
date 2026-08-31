/**
 * Escaping for the randomizer's ingredient-substring filter (meal randomizer
 * plan §4.4). Pure and client-safe — no DB import.
 *
 * Postgres `LIKE`/`ILIKE` treat `%` (any run of characters) and `_` (any one
 * character) as wildcards, with `\` as the default escape character (no
 * `ESCAPE` clause needed for that default, but the caller pins it explicitly
 * with `ESCAPE '\'` anyway, so the intent reads at the call site rather than
 * relying on a database default). Without escaping, a household member who
 * types a literal `%` (a garnish note like "5% milk") would have it silently
 * act as a wildcard and match every ingredient line instead of only the
 * lines that contain a percent sign.
 */

/**
 * Escape `\`, `%` and `_` in `raw` so it can be embedded between the `%`
 * wildcards of an `ILIKE '%' || escaped || '%' ESCAPE '\'` pattern and match
 * only as a literal substring.
 *
 * Order matters: the escape character itself (`\`) is escaped FIRST. Escaping
 * the wildcards before the backslash would double-escape a `\%` the caller's
 * text already contains (from a previous, already-escaped value, or simply
 * two characters a user typed on purpose) into `\\%` — "a literal backslash
 * followed by a wildcard" — instead of the intended "a literal percent sign".
 * Escaping `\` first guarantees every backslash in the output came from this
 * function, not from the input.
 */
export function escapeLikePattern(raw: string): string {
  return raw.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}
