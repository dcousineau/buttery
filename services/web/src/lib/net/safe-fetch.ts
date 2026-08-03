import { lookup } from "node:dns/promises";

/**
 * SSRF-hardened fetch for user-supplied URLs (recipe scraping today; the
 * standard for ALL user-URL fetches going forward — handle-resolve.ts still
 * fetches without this guard and should adopt it). Pure network: no DB, no
 * caching (see lib/net/recipe-page.ts for the DB-backed cache that wraps this).
 *
 * Guarantees:
 *   - http(s) only.
 *   - Every hop's hostname is DNS-resolved and REJECTED if any address is
 *     private / loopback / link-local / CGNAT / multicast / reserved — this is
 *     what blocks the cloud metadata endpoint (169.254.169.254) and internal
 *     services.
 *   - Redirects are followed MANUALLY (max 5) so each new target is re-validated;
 *     a 3xx to an internal host is caught, not blindly followed.
 *   - Per-request timeout and a hard response-size cap (streamed, so an
 *     unbounded body can't exhaust memory).
 *
 * Known residual: a tiny TOCTOU window between our DNS check and undici's own
 * connect-time resolution (DNS rebinding). Closing it fully needs a pinned
 * connect (undici Agent `lookup`); tracked as hardening follow-up. Documented,
 * not ignored.
 */

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_BYTES = 3_000_000; // 3 MB of HTML is already enormous for a recipe page.
const MAX_REDIRECTS = 5;
const USER_AGENT = "ButteryRecipeBot/1.0 (+https://buttery.recipes)";

export class SafeFetchError extends Error {
  /** Machine-readable reason for the attempt log / caller branching. */
  code: "invalid_url" | "blocked" | "too_large" | "timeout" | "too_many_redirects" | "network";
  httpStatus?: number;
  constructor(code: SafeFetchError["code"], message: string, httpStatus?: number) {
    super(message);
    this.name = "SafeFetchError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface SafeFetchBytesResult {
  finalUrl: string;
  status: number;
  contentType: string | null;
  bytes: Uint8Array;
  byteSize: number;
}

export interface SafeFetchResult {
  finalUrl: string;
  status: number;
  contentType: string | null;
  body: string;
  byteSize: number;
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

/** Fetch a user-supplied URL with SSRF protection, returning the decoded text. */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const raw = await safeFetchBytes(rawUrl, opts);
  return { ...raw, body: new TextDecoder("utf-8").decode(raw.bytes) };
}

/**
 * Same SSRF-guarded fetch as `safeFetch`, but returns the raw bytes — used for
 * binary payloads (an imported recipe's hero image) where UTF-8 decoding would
 * corrupt the content. Callers cap `maxBytes` to the payload's real limit.
 */
export async function safeFetchBytes(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchBytesResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_BYTES;

  let current = parseHttpUrl(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(current.hostname);

    const res = await doFetch(current, timeoutMs);

    // Manual redirect handling — re-validate every hop.
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      res.body?.cancel().catch(() => {});
      if (!location) throw new SafeFetchError("network", `Redirect with no Location (HTTP ${res.status}).`, res.status);
      if (hop === MAX_REDIRECTS) throw new SafeFetchError("too_many_redirects", "Too many redirects.");
      current = parseHttpUrl(new URL(location, current).toString());
      continue;
    }

    if (res.status >= 400) {
      res.body?.cancel().catch(() => {});
      throw new SafeFetchError("network", `The page returned HTTP ${res.status}.`, res.status);
    }

    const { bytes, byteSize } = await readCapped(res, maxBytes);
    return {
      finalUrl: current.toString(),
      status: res.status,
      contentType: res.headers.get("content-type"),
      bytes,
      byteSize,
    };
  }
  // Unreachable (loop returns/throws), but satisfies the type checker.
  throw new SafeFetchError("too_many_redirects", "Too many redirects.");
}

function parseHttpUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SafeFetchError("invalid_url", "That doesn't look like a valid URL.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new SafeFetchError("invalid_url", "Only http and https URLs can be imported.");
  }
  return u;
}

async function doFetch(url: URL, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      redirect: "manual",
      signal: controller.signal,
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
    });
  } catch (err) {
    if (controller.signal.aborted) throw new SafeFetchError("timeout", "The page took too long to respond.");
    throw new SafeFetchError("network", `Couldn't reach the page: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Stream the body, aborting past `maxBytes` so a huge response can't OOM us. */
async function readCapped(res: Response, maxBytes: number): Promise<{ bytes: Uint8Array; byteSize: number }> {
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new SafeFetchError("too_large", "That response is too large to import.");
    return { bytes: buf, byteSize: buf.byteLength };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new SafeFetchError("too_large", "That response is too large to import.");
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return { bytes: buf, byteSize: total };
}

/** Reject a hostname whose DNS resolves to any non-public address. */
async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  // A literal IP still needs checking; lookup() handles both names and literals.
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new SafeFetchError("blocked", "Couldn't resolve that host.");
  }
  if (addresses.length === 0) throw new SafeFetchError("blocked", "Couldn't resolve that host.");
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new SafeFetchError("blocked", "That URL points at a private or internal address.");
    }
  }
}

/** True for loopback / private / link-local / CGNAT / multicast / reserved IPs. */
export function isPrivateIp(ip: string): boolean {
  if (ip.includes(":")) return isPrivateIpv6(ip);
  return isPrivateIpv4(ip);
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // malformed → treat as unsafe
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0/24 IETF
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved + 255.255.255.255
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const addr = ip.toLowerCase().split("%")[0]; // drop zone id
  if (addr === "::1" || addr === "::") return true; // loopback / unspecified
  // IPv4-mapped/compat (::ffff:a.b.c.d or ::a.b.c.d) → check the embedded v4.
  const v4 = /(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (v4) return isPrivateIpv4(v4[1]);
  if (addr.startsWith("fe80")) return true; // link-local
  if (addr.startsWith("fc") || addr.startsWith("fd")) return true; // ULA fc00::/7
  if (addr.startsWith("ff")) return true; // multicast
  if (addr.startsWith("2001:db8")) return true; // documentation
  return false;
}
