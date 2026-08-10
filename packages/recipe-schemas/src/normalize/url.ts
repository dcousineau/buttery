/**
 * Source-URL normalization for dedupe. Pure and dependency-free so the client
 * probe and the server write path compute byte-identical keys — the server
 * recomputes and never trusts the client's value, which only works if the two
 * implementations are literally the same code.
 */

/**
 * Params that carry no resource identity on ANY host, so they are safe to drop
 * globally. `utm_` is matched as a prefix; the rest are exact, case-insensitive.
 */
const GLOBAL_TRACKING_PARAMS: ReadonlySet<string> = new Set(["fbclid", "gclid", "dclid", "msclkid", "mc_cid", "mc_eid", "_ga", "igshid", "si", "ref", "ref_src", "ref_source"]);

/**
 * Params that are junk on the hosts that mint them but ordinary semantics
 * elsewhere (`?action=print`, `?source=archive`). Scoping them per host keeps
 * the primary dedupe key from collapsing genuinely distinct URLs onto one key:
 * a false positive silently skips a recipe, a false negative just shows a
 * dismissable duplicate. Exported so it can be asserted on and extended.
 */
export const HOST_SCOPED_TRACKING_PARAMS: ReadonlyArray<{ readonly host: string; readonly params: readonly string[] }> = [
  // Matched case-insensitively, so NYT's `pgType` is listed lowercased.
  { host: "nytimes.com", params: ["action", "module", "region", "pgtype", "rank", "source"] },
];

/** RFC 3986 unreserved set: these decode to themselves, so encoding them is never meaningful. */
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/** `host` is the scope itself or a subdomain of it — `cooking.nytimes.com` matches `nytimes.com`. */
function hostInScope(host: string, scope: string): boolean {
  return host === scope || host.endsWith(`.${scope}`);
}

/** Params dropped for this host: the global set plus whatever the host is known to mint. */
function droppedParamNames(host: string): ReadonlySet<string> {
  const dropped = new Set(GLOBAL_TRACKING_PARAMS);
  for (const scope of HOST_SCOPED_TRACKING_PARAMS) {
    if (hostInScope(host, scope.host)) for (const name of scope.params) dropped.add(name);
  }
  return dropped;
}

/**
 * Decode only percent-escapes whose byte is unreserved. Decoding the whole path
 * would make `/a%2Fb` and `/a/b` the same key, and they are not the same
 * resource; unreserved-only still gets `%2D` → `-` with no collapse risk.
 * Surviving escapes are uppercased so `%2f` and `%2F` land on one key.
 */
function decodeUnreserved(path: string): string {
  return path.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex: string) => {
    const char = String.fromCharCode(Number.parseInt(hex, 16));
    return UNRESERVED.test(char) ? char : `%${hex.toUpperCase()}`;
  });
}

/**
 * Normalize a recipe's source URL into a stable dedupe key, or null when the
 * input can't identify a web resource. Scheme is dropped entirely: http and
 * https are the same recipe.
 */
export function normalizeSourceUrl(raw: string | null | undefined): string | null {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  // WHATWG parsing already drops the default port and lowercases the hostname.
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (!host) return null;
  const authority = url.port ? `${host}:${url.port}` : host;

  const dropped = droppedParamNames(host);
  const params: Array<[string, string]> = [];
  for (const [name, value] of url.searchParams) {
    const lower = name.toLowerCase();
    if (lower.startsWith("utm_") || dropped.has(lower)) continue;
    params.push([name, value]);
  }
  // Sort by name then value so param order in the source URL is not identity.
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));

  let path = decodeUnreserved(url.pathname).replace(/\/{2,}/g, "/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

  const query = new URLSearchParams(params).toString();
  // The fragment is never part of the key.
  return query ? `${authority}${path}?${query}` : `${authority}${path}`;
}
