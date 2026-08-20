import type { PostHog } from "posthog-node";

/**
 * Server-side PostHog for feature-flag evaluation and person identification.
 *
 * This module is server-only: every consumer imports it dynamically inside a
 * server-fn handler so `posthog-node` never lands in the client bundle. The
 * client keeps using `@posthog/react` / `posthog-js` for capture and client-side
 * identify (see `src/routes/__root.tsx`); both sides key the person on the
 * atproto DID so the server writes and client events describe one person.
 *
 * Config comes from runtime env (NOT the `VITE_` client vars): `POSTHOG_PROJECT_TOKEN`
 * and `POSTHOG_HOST`. Talks to PostHog's ingestion host directly — server-to-server,
 * so it skips the client reverse-proxy.
 *
 * PRODUCTION-ONLY, gated on `POSTHOG_ENABLED === "true"` (see {@link isEnabled}).
 * Outside production no client is constructed at all, so nothing is written and no
 * flag is evaluated — note that evaluating a flag is itself a write, since
 * posthog-node captures a `$feature_flag_called` event per evaluation.
 *
 * The `invited` access flag that used to live here is GONE: the post-login
 * waitlist gate was removed and every signed-in user goes straight into the app.
 */

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
 * Capture one server-side product event against the DID-keyed person.
 *
 * The server half of `#/lib/analytics` — same person key (the atproto DID), same
 * production-only gate ({@link isEnabled}), so nothing is written from dev, test,
 * or a staging build. Fire-and-forget and never throws: an analytics failure must
 * not fail the user's write.
 *
 * Used for events the browser cannot honestly emit because only the server knows
 * they happened exactly once — `recipe_import_completed` fires from
 * `finalizeImportSession`, whose idempotency is what makes "one event per import
 * session" true rather than aspirational (plan §13, §7.7).
 *
 * Properties must carry no recipe names, URLs, or ingredient text (§13).
 */
export async function captureServerEvent(did: string, event: string, properties: Record<string, unknown> = {}): Promise<void> {
  const client = await getClient();
  if (!client) return;
  try {
    client.capture({ distinctId: did, event, properties });
  } catch (err) {
    console.warn(`[posthog] capture ${event} failed`, err);
  }
}
