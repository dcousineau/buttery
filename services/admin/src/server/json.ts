/**
 * Normalising database rows for the wire.
 *
 * Server functions are typechecked for serializability, and a `Record<string,
 * unknown>` does not pass — rightly: `pg` hands back `Date` objects for
 * `timestamptz`, strings for `numeric`, and `bigint` for `int8`, none of which
 * survive a round trip unchanged. Rather than widening the boundary type until
 * the compiler stops complaining, every raw row goes through here first.
 *
 * The conversions are chosen so the admin's tables stay *honest* — a `numeric`
 * that Postgres returns as `"1.50"` is shown as `1.50`, not as a float that
 * quietly reprints as `1.5`.
 */

/** Anything that survives the wire unchanged. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * One value, JSON-normalised. `Date` becomes an ISO string (the one timestamp
 * format that cannot be misread), `bigint` becomes a decimal string (an id past
 * 2^53 must not be rounded), `undefined` becomes `null` (a column that is
 * absent and one that is null are the same fact to a reader).
 */
export function toJsonValue(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === "object") {
    // `Buffer`/`Uint8Array` would stringify into something useless. Nothing in
    // the admin's queries selects bytea today; say so loudly if that changes.
    if (ArrayBuffer.isView(value)) return `<${value.byteLength} bytes>`;
    return toJsonRow(value as Record<string, unknown>);
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  // Only `symbol` and `function` reach here, and neither can come out of `pg`.
  // Naming the type rather than stringifying it keeps `[object Object]` and
  // `function () { … }` out of the UI if one ever does.
  return typeof value === "symbol" ? value.toString() : `<${typeof value}>`;
}

/** One row, JSON-normalised. */
export function toJsonRow(row: Record<string, unknown>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(row)) out[key] = toJsonValue(value);
  return out;
}
