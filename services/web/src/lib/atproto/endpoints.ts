/**
 * The two atproto network endpoints this app resolves identity against, each
 * overridable so the whole stack can be pointed at a local `@atproto/dev-env`
 * network instead of the real atmosphere.
 *
 * Both default to production, so an unset environment behaves exactly as the
 * hardcoded values they replaced. The override names are the ones already in
 * `.env.example` and already honoured by `oauth-node.ts` (`plcDirectoryUrl`) and
 * `services/atproto-cron-sync/src/identity.ts` — this module exists so the
 * remaining call sites stop each hardcoding `https://plc.directory` and
 * `https://public.api.bsky.app` privately.
 *
 * Why it matters beyond tidiness: with the PLC hardcoded, a dev-env account's
 * DID document is looked up in the *public* directory, which has never heard of
 * it. The lookup fails, `alsoKnownAs` is never read, and every local account
 * signs in with `handle: null` and `name` falling back to the bare DID — so any
 * screen that shows a handle shows a DID instead.
 *
 * Server-only values (`process.env`), so only import this from server code.
 */

/** Trailing slashes trimmed: plc.directory and dev-env's PLC both take `/<did>`. */
function trimSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Where DID documents are resolved. Dev-env: `http://localhost:2582`. */
export function plcDirectoryUrl(): string {
  return trimSlashes(process.env.ATPROTO_PLC_URL ?? "https://plc.directory");
}

/**
 * The XRPC host answering `com.atproto.identity.resolveHandle`. Production is
 * the public appview; dev-env sets this to its PDS (`http://localhost:2583`),
 * which serves the same endpoint for the accounts it hosts.
 */
export function handleResolverUrl(): string {
  return trimSlashes(process.env.ATPROTO_HANDLE_RESOLVER ?? "https://public.api.bsky.app");
}

/**
 * The DID-document URL for a DID, or `null` for a method we cannot resolve.
 * `did:plc:` goes to the (overridable) directory; `did:web:` is self-describing
 * and has no directory to override.
 */
export function didDocumentUrl(did: string): string | null {
  if (did.startsWith("did:plc:")) return `${plcDirectoryUrl()}/${did}`;
  if (did.startsWith("did:web:")) {
    const host = did.slice("did:web:".length).split(":").join("/");
    return `https://${decodeURIComponent(host)}/.well-known/did.json`;
  }
  return null;
}
