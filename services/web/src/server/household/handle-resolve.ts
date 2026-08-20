/**
 * atproto handle → DID resolution for BOUND invites (§6.2).
 *
 * The auth plugin already does the REVERSE (DID → handle, via the DID doc's
 * `alsoKnownAs`); minting a bound invite needs the forward direction. There is
 * no `@atproto/identity` / `@atproto/api` in this workspace (only the oauth-*
 * packages), so we resolve best-effort over HTTP:
 *
 *   1. the public Bluesky appview XRPC
 *      `com.atproto.identity.resolveHandle` — authoritative for any handle the
 *      network knows, including handles on custom domains; then
 *   2. a fallback to the handle domain's own `/.well-known/atproto-did`, which
 *      covers accounts the appview hasn't indexed.
 *
 * Returns the DID, or `null` if the handle can't be resolved (caller surfaces a
 * "couldn't resolve that handle" error). Best-effort by design — a bound invite
 * to an unresolvable handle simply can't be created.
 *
 * Both hosts are overridable via `#/lib/atproto/endpoints` so a local dev-env
 * network resolves its own handles: production hits the public appview, dev-env
 * hits its PDS, which serves the same `resolveHandle` endpoint. Without that,
 * every bound invite in local dev fails to resolve — the public appview has
 * never heard of `chef.test`.
 *
 * Server-only (network fetch); not part of the client bundle.
 */

import { handleResolverUrl } from "#/lib/atproto/endpoints";

function normalizeHandle(input: string): string | null {
  const handle = input.trim().replace(/^@/, "").toLowerCase();
  // A handle is a domain — it must contain a dot and no whitespace/slashes.
  if (!handle || !handle.includes(".") || /[\s/]/.test(handle)) return null;
  return handle;
}

export async function resolveHandleToDid(input: string): Promise<string | null> {
  const handle = normalizeHandle(input);
  if (!handle) return null;

  // 1. Appview resolver — the broad, reliable path.
  try {
    const res = await fetch(`${handleResolverUrl()}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`);
    if (res.ok) {
      const body = (await res.json()) as { did?: string };
      if (typeof body.did === "string" && body.did.startsWith("did:")) return body.did;
    }
  } catch {
    // fall through to the well-known fallback
  }

  // 2. Well-known fallback for off-network / not-yet-indexed handles.
  try {
    const res = await fetch(`https://${handle}/.well-known/atproto-did`);
    if (res.ok) {
      const did = (await res.text()).trim();
      if (did.startsWith("did:")) return did;
    }
  } catch {
    // give up — best-effort
  }

  return null;
}
