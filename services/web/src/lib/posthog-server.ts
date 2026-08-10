import type { PostHog } from "posthog-node";

/**
 * Server-side PostHog for feature-flag evaluation and person identification.
 *
 * This module is server-only: it is dynamically imported inside the `getGateState`
 * server-fn handler (see `./gate`) so `posthog-node` never lands in the client
 * bundle. The client keeps using `@posthog/react` / `posthog-js` for capture and
 * client-side identify (see `src/routes/__root.tsx`); both sides key the person
 * on the atproto DID so the server writes and client events describe one person.
 *
 * Config comes from runtime env (NOT the `VITE_` client vars): `POSTHOG_PROJECT_TOKEN`
 * and `POSTHOG_HOST`. Talks to PostHog's ingestion host directly — server-to-server,
 * so it skips the client reverse-proxy.
 *
 * PRODUCTION-ONLY, gated on `POSTHOG_ENABLED === "true"` (see {@link isEnabled}).
 * Outside production no client is constructed at all, so nothing is written and no
 * flag is evaluated — note that evaluating a flag is itself a write, since
 * posthog-node captures a `$feature_flag_called` event per evaluation.
 */

/** The PostHog flag that gates the post-login experience. */
export const INVITED_FLAG = "invited";

/**
 * The PostHog flag that gates atproto publishing (writing recipe records to a
 * user's PDS). This is a KILL SWITCH: publishing is allowed ONLY when the flag
 * explicitly serves `true`. Everything else — flag false/undefined, PostHog
 * unreachable, or no PostHog configured (local dev) — BLOCKS the PDS write. This
 * fail-closed direction is deliberate: a missing/erroring flag must never let a
 * public, hard-to-reverse atproto write through by accident.
 */
export const ATPROTO_PUBLISH_FLAG = "atproto-publishing-enabled";

/**
 * Whether this process may talk to PostHog at all — the server half of the gate
 * in `./analytics`. Explicit runtime opt-in, set only by the Railway service
 * definition (`.railway/railway.ts`).
 *
 * Deliberately NOT "is a token present": `pnpm dev` and `pnpm test:db` run through
 * `railway run`, which injects the real production project token into a laptop
 * shell. Deliberately NOT `NODE_ENV !== "production"` either: a future staging
 * deploy runs with `NODE_ENV=production` and must still write nothing. Allowlist,
 * so unset/empty/misspelled all resolve to OFF.
 */
function isEnabled(): boolean {
  return process.env.POSTHOG_ENABLED === "true";
}

/** Memoized one-shot init of the posthog-node client for this server process.
 * Resolves to `null` outside production, or when no project token is configured,
 * which the callers treat as "PostHog absent" rather than an error. */
let clientInit: Promise<PostHog | null> | null = null;

async function getClient(): Promise<PostHog | null> {
  if (!clientInit) {
    clientInit = (async () => {
      if (!isEnabled()) return null; // dev / test / staging → total no-op
      const key = process.env.POSTHOG_PROJECT_TOKEN;
      if (!key) return null; // opted in but not configured
      const { PostHog } = await import("posthog-node");
      return new PostHog(key, {
        host: process.env.POSTHOG_HOST ?? "https://us.i.posthog.com",
        // Identify writes are low-volume; flush each one promptly rather than
        // batching on a long-running server.
        flushAt: 1,
        flushInterval: 10_000,
      });
    })();
  }
  return clientInit;
}

/**
 * True only when explicitly running dev or test. Unknown/unset `NODE_ENV` is NOT
 * dev — an allowlist, not `!== "production"`, so a misconfigured production
 * server can never take a dev-only bypass.
 */
function isDevOrTest(): boolean {
  const env = process.env.NODE_ENV;
  return env === "development" || env === "test";
}

/**
 * Whether the person behind `did` is invited (the `invited` flag serves `true`).
 *
 * Fail direction is deliberately closed: when PostHog is configured but the flag
 * is unreachable or undefined, the gate stays up (returns `false`).
 *
 * DEV/TEST bypasses the gate entirely and never consults PostHog. Local dev signs
 * in through the local atproto dev-env (see services/atproto-dev-env), which mints
 * a brand-new throwaway `did:plc` on every restart — no such DID can be on the
 * invite list, so honoring the flag would lock every local session behind the
 * waitlist screen. It would also be unanswerable: outside production there is no
 * client to ask (see {@link isEnabled}) — `railway run` injects `POSTHOG_PROJECT_TOKEN`
 * locally, but a token is not evidence of production and no longer builds a client.
 *
 * Any other environment (production, or an unset `NODE_ENV`) fails CLOSED, with or
 * without a token, so a missing prod token can't silently open the gate.
 *
 * `personProperties` (e.g. `{ handle }`) are passed for flag targeting only; they
 * are not persisted here — {@link identify} does the durable person write.
 */
export async function isInvited(did: string, personProperties?: Record<string, string>): Promise<boolean> {
  if (isDevOrTest()) return true;

  const client = await getClient();
  if (!client) return false; // configured for prod but no token → fail closed
  try {
    const value = await client.isFeatureEnabled(INVITED_FLAG, did, { personProperties });
    return value === true; // `undefined` (unreachable / missing) fails closed
  } catch (err) {
    console.warn("[posthog] invited flag eval failed; gating", err);
    return false;
  }
}

/**
 * Whether the person behind `did` may publish recipes to their atproto PDS.
 *
 * Fail-closed kill switch (see {@link ATPROTO_PUBLISH_FLAG}): returns `true` ONLY
 * when the flag explicitly serves `true`. A local/server env override
 * (`ATPROTO_PUBLISH_ENABLED=true|false`) wins over PostHog — the escape hatch for
 * dev + emergencies, and the ONLY way to allow publishing outside production, where
 * there is no PostHog client to evaluate the flag. With no override and no client,
 * or on any flag error, publishing is BLOCKED.
 */
export async function isAtprotoPublishEnabled(did: string, personProperties?: Record<string, string>): Promise<boolean> {
  const override = process.env.ATPROTO_PUBLISH_ENABLED;
  if (override === "true") return true;
  if (override === "false") return false;

  const client = await getClient();
  if (!client) return false; // no PostHog → fail closed (no publishing)
  try {
    const value = await client.isFeatureEnabled(ATPROTO_PUBLISH_FLAG, did, { personProperties });
    return value === true; // `undefined` (unreachable / missing) blocks publishing
  } catch (err) {
    console.warn("[posthog] atproto publish flag eval failed; blocking publish", err);
    return false;
  }
}

/**
 * Durably attach person properties (notably `handle`) to the DID-keyed person so
 * PostHog is filterable by handle, not just the opaque DID. Fire-and-forget: the
 * write is queued and flushed asynchronously; failures are logged, never thrown.
 *
 * No-op outside production — dev sign-ins mint throwaway DIDs, and a person row
 * per local restart is exactly the noise the gate exists to keep out.
 */
export async function identify(did: string, properties: Record<string, string>): Promise<void> {
  const client = await getClient();
  if (!client) return;
  try {
    client.identify({ distinctId: did, properties });
  } catch (err) {
    console.warn("[posthog] identify failed", err);
  }
}
