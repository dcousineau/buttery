/**
 * Best-effort friendly name for the atproto service a user's PDS lives on.
 *
 * atproto has no canonical "service" field — accounts just live on a PDS host.
 * We recognise the two hosts Buttery users are known to come from (Bluesky's
 * managed hosting and Blacksky) and otherwise fall back to the bare hostname,
 * which is honest rather than wrong. Purely cosmetic; never used for authz.
 */
export function serviceNameFromPds(pds: string | null | undefined): string | null {
  if (!pds) return null;

  let host: string;
  try {
    host = new URL(pds).host.toLowerCase();
  } catch {
    // Not a URL — best-effort: treat the raw value as a host if it looks like one.
    host = pds.trim().toLowerCase();
    if (!host) return null;
  }

  // Bluesky's managed PDS: the marketing host `bsky.social` and the per-shard
  // `*.host.bsky.network` entryway endpoints DID docs actually point at.
  if (host === "bsky.social" || host.endsWith(".host.bsky.network")) return "Bluesky";
  if (host.includes("blacksky")) return "Blacksky";

  // Self-hosted / unknown: the hostname is the most honest label we have. Drop a
  // leading `www.` for tidiness.
  return host.replace(/^www\./, "");
}
