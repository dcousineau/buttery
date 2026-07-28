// Small display formatters shared across routes. Client-safe.
//
// dayjs powers both formatters (matches the atproto-cron-sync service, which
// already uses dayjs + the duration plugin). Plugins are imported from their
// `.js` subpaths so the same import works under Node's native ESM too.
import dayjs from "dayjs";
import duration from "dayjs/plugin/duration.js";
import relativeTime from "dayjs/plugin/relativeTime.js";

dayjs.extend(duration);
dayjs.extend(relativeTime);

/**
 * Human date for a "published" timestamp: relative for the recent past
 * ("3 days ago"), an absolute date beyond a week. Falls back to the raw string
 * if it can't be parsed.
 */
export function formatPublished(iso: string): string {
  const d = dayjs(iso);
  if (!d.isValid()) return iso;
  const days = dayjs().diff(d, "day");
  if (days >= 7) return d.format("MMM D, YYYY");
  return d.fromNow();
}

/** ISO 8601 duration (PT1H30M) → "1h 30m". Returns the input when unparseable. */
export function formatDuration(iso: string): string {
  if (typeof iso !== "string" || iso[0] !== "P") return iso;
  const d = dayjs.duration(iso);
  const secs = d.asSeconds();
  if (!Number.isFinite(secs) || secs <= 0) return iso;
  const parts = [d.days() * 24 + d.hours() && `${d.days() * 24 + d.hours()}h`, d.minutes() && `${d.minutes()}m`, d.seconds() && `${d.seconds()}s`].filter(Boolean);
  return parts.join(" ") || iso;
}
