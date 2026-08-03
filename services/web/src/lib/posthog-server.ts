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
 */

/** The PostHog flag that gates the post-login experience. */
export const INVITED_FLAG = "invited";

/** Memoized one-shot init of the posthog-node client for this server process.
 * Resolves to `null` when no project token is configured (local dev), which the
 * callers treat as "PostHog absent" rather than an error. */
let clientInit: Promise<PostHog | null> | null = null;

async function getClient(): Promise<PostHog | null> {
  if (!clientInit) {
    clientInit = (async () => {
      const key = process.env.POSTHOG_PROJECT_TOKEN;
      if (!key) return null; // local dev without PostHog wired up
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
 * Whether the person behind `did` is invited (the `invited` flag serves `true`).
 *
 * Fail direction is deliberately closed: when PostHog is configured but the flag
 * is unreachable or undefined, the gate stays up (returns `false`). The single
 * exception is local dev with no `POSTHOG_PROJECT_TOKEN` — there we return `true`
 * so the app isn't gated locally, mirroring the old coming-soon behavior.
 *
 * `personProperties` (e.g. `{ handle }`) are passed for flag targeting only; they
 * are not persisted here — {@link identify} does the durable person write.
 */
export async function isInvited(did: string, personProperties?: Record<string, string>): Promise<boolean> {
  const client = await getClient();
  if (!client) return true; // no PostHog locally → never gate dev
  try {
    const value = await client.isFeatureEnabled(INVITED_FLAG, did, { personProperties });
    return value === true; // `undefined` (unreachable / missing) fails closed
  } catch (err) {
    console.warn("[posthog] invited flag eval failed; gating", err);
    return false;
  }
}

/**
 * Durably attach person properties (notably `handle`) to the DID-keyed person so
 * PostHog is filterable by handle, not just the opaque DID. Fire-and-forget: the
 * write is queued and flushed asynchronously; failures are logged, never thrown.
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
