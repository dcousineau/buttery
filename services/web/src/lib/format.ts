// Small display formatters shared across routes. Client-safe.
//
// dayjs powers both formatters (matches the atproto-sync workflow, which
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

/**
 * ISO 8601 duration (PT1H30M) → "1h 30m", or `null` when there is nothing to
 * show — unparseable input, or a duration of zero (`PT0S`, common in recipes
 * published to the network).
 *
 * Every caller renders this straight into a meta row, so the nullable return is
 * what stops a duration with no duration in it reaching the page as a time.
 */
export function formatDuration(iso: string | null | undefined): string | null {
  if (typeof iso !== "string" || iso[0] !== "P") return null;
  const d = dayjs.duration(iso);
  const secs = d.asSeconds();
  if (!Number.isFinite(secs) || secs <= 0) return null;
  const parts = [d.days() * 24 + d.hours() && `${d.days() * 24 + d.hours()}h`, d.minutes() && `${d.minutes()}m`, d.seconds() && `${d.seconds()}s`].filter(Boolean);
  return parts.join(" ") || null;
}
