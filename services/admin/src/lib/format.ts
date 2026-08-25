/**
 * Display helpers. Everything crossing the wire from a server function is
 * already an ISO string (Postgres `timestamptz` → `Date` → `toISOString`), so
 * these all take strings and none of them parse anything ambiguous.
 */

/** Absolute local time, second precision. The admin never shows a bare date. */
export function absoluteTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

/**
 * "3 min ago". Paired with `absoluteTime` in a `title=` attribute at every call
 * site — relative time answers "is this stale", absolute time answers "when
 * exactly", and an operator triaging a sweep needs both.
 */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.round((then - Date.now()) / 1000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 7],
    ["week", 4.35],
    ["month", 12],
    ["year", Number.POSITIVE_INFINITY],
  ];
  let value = seconds;
  for (const [unit, size] of units) {
    if (Math.abs(value) < size) return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(Math.round(value), unit);
    value = value / size;
  }
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(Math.round(value), "year");
}

/** `did:plc:abcdefghijklmnop` → `did:plc:abcd…mnop`. */
export function shortDid(did: string | null | undefined): string {
  if (!did) return "—";
  if (did.length <= 24) return did;
  return `${did.slice(0, 16)}…${did.slice(-4)}`;
}

/** A CID or rev, shortened to something a human can compare at a glance. */
export function shortHash(value: string | null | undefined): string {
  if (!value) return "—";
  if (value.length <= 14) return value;
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

/** `1234` → `1,234`, and null → `—`. */
export function count(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : value.toLocaleString();
}

/** Milliseconds as `1.4s` / `2m 03s`, for sweep durations. */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
