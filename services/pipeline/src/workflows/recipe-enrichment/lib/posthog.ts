import type { PostHog } from "posthog-node";
import { log } from "#/log.ts";

/**
 * The pipeline's own `posthog-node` client and the fail-closed gate that
 * decides whether `llm-enrich` may call an LLM at all (llm plan L4, §5.1,
 * §9.2).
 *
 * This is a second, independent copy of `services/web/src/lib/posthog-server.ts`'s
 * shape — same `POSTHOG_ENABLED === "true"` allowlist, same lazily-constructed
 * memoized client, same `flushAt: 1`, same fail-closed flag evaluation, same
 * fire-and-forget capture that never throws. It is not imported from there:
 * the pipeline is a separate deployable with its own env and its own
 * `posthog-node` dependency (services/pipeline/package.json), and the two
 * processes have no shared module to put this in even if sharing it were
 * otherwise a good idea. Read that file first if this one is confusing — it
 * is the model, and `isAtprotoPublishEnabled` is the exact idiom
 * {@link isLlmEnrichmentEnabled} copies.
 *
 * `posthog-node` is imported dynamically inside {@link getClient}, never at
 * module top level, so that `run:once` and every other entrypoint that merely
 * imports this module (rather than actually calling it) never pulls the
 * dependency in — the same "everything LLM is lazily imported inside the
 * step" rule the folder doc (plan §4) states for `ai` and the provider SDKs.
 */

/**
 * The PostHog flag that gates one recipe's LLM pass (llm plan L4, §5.1).
 *
 * Evaluated with `distinct_id = recipeId`, never a user id: a rollout
 * percentage on this flag is a deterministic canary over the recipe corpus,
 * not a per-user feature gate. Boolean, created at 0% rollout in PostHog
 * itself (§5.1) — implementing agents do not create it, only reference it.
 */
export const LLM_ENRICHMENT_FLAG = "llm-enrichment-enabled";

/**
 * Whether this process may talk to PostHog at all. Deliberately identical in
 * shape to `posthog-server.ts`'s `isEnabled`: an allowlist, not "is a token
 * present" (a laptop shell running under `railway run` can have a real
 * project token without this process being allowed to use it) and not
 * `NODE_ENV`-based (a future staging deploy must still write nothing unless
 * explicitly opted in).
 */
function isEnabled(): boolean {
  return process.env.POSTHOG_ENABLED === "true";
}

/**
 * Memoized one-shot init of the posthog-node client for this worker process.
 * Resolves to `null` when PostHog is not enabled or not configured, which
 * every caller in this file treats as "PostHog absent" rather than an error
 * — the whole point of L4's fail-closed design is that absence is an
 * ordinary, expected state, not a failure mode.
 */
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
        // `$ai_generation` events are one-per-job, not high-frequency like a
        // browser session — flush each one promptly rather than batching on
        // a long-running worker replica that may be killed between jobs.
        flushAt: 1,
        flushInterval: 10_000,
      });
    })();
  }
  return clientInit;
}

/**
 * Whether `llm-enrich` may spend a model call on `recipeId` (llm plan L4,
 * §9.2 steps 1-2). Fail-closed: the only way this returns `true` is an
 * explicit env override or an explicit `true` flag serve. Every other
 * outcome — no override, no PostHog client, an unreachable flags endpoint, an
 * `undefined` serve, a thrown error — returns `false`, because no PostHog
 * access means no basis for letting a paid model call through.
 *
 * Order matters and is deliberate:
 *
 *   1. **The env override is checked FIRST, before any flag evaluation.**
 *      `LLM_ENRICHMENT_ENABLED=false` skips without ever constructing a
 *      client; `=true` bypasses the flag entirely. This is not just an
 *      optimization — evaluating a PostHog flag captures a
 *      `$feature_flag_called` event *per evaluation* (plan §5.1's note), and
 *      a dev loop running this gate on every local job must not pay for that
 *      quietly on every save. The override short-circuits before the flag
 *      check exists to be reached.
 *   2. With no override, absence of a client (PostHog not enabled, or
 *      enabled but unconfigured) fails closed to `false` — no PostHog means
 *      no LLM call, full stop (L4).
 *   3. Only once a client exists does {@link LLM_ENRICHMENT_FLAG} get
 *      evaluated, keyed on `recipeId` (a corpus canary, not a user gate —
 *      §5.1). `undefined` (flag missing/unreachable) and a thrown error both
 *      resolve to `false`; only an explicit `true` serve lets the call
 *      through.
 */
export async function isLlmEnrichmentEnabled(recipeId: string): Promise<boolean> {
  const override = process.env.LLM_ENRICHMENT_ENABLED;
  if (override === "false") return false;
  if (override === "true") return true;

  const client = await getClient();
  if (!client) return false; // no PostHog → fail closed (no LLM call)
  try {
    const value = await client.isFeatureEnabled(LLM_ENRICHMENT_FLAG, recipeId);
    return value === true; // `undefined` (unreachable / missing) skips the LLM call
  } catch (err) {
    log.warn("llm-enrichment flag eval failed; skipping LLM call", { recipeId, err: String(err) });
    return false;
  }
}

/**
 * Capture one event against the given distinct id. Fire-and-forget and never
 * throws — a capture failure must never fail an `llm-enrich` job, because the
 * DB write it is reporting on already happened (plan §9.2 step 7, §10). A
 * total no-op when there is no client, which is the common case in every
 * environment without `POSTHOG_ENABLED=true`.
 *
 * `lib/capture.ts` is the only caller; it builds `event`/`properties` with
 * pure functions and hands them here. This function does no shaping of its
 * own on purpose — one place decides what an event looks like, one place
 * decides whether it gets sent.
 */
export async function captureEvent(distinctId: string, event: string, properties: Record<string, unknown> = {}): Promise<void> {
  const client = await getClient();
  if (!client) return;
  try {
    client.capture({ distinctId, event, properties });
  } catch (err) {
    log.warn(`llm posthog capture failed: ${event}`, { err: String(err) });
  }
}

/**
 * Flush and close this process's posthog-node client, if one was ever built.
 * Wired into the `recipe-enrichment` workflow's `close` alongside `closeDb`
 * (plan §10) so a draining worker replica flushes its last `$ai_generation`
 * events before the process exits, exactly the way `closeDb` lets the pool
 * stop keeping the event loop alive.
 *
 * Safe to call unconditionally, including when {@link getClient} was never
 * invoked at all (a replica that processed zero `llm-enrich` jobs, or ran
 * entirely with PostHog disabled): `clientInit` is `null` in that case and
 * this returns immediately without importing `posthog-node`.
 */
export async function shutdown(): Promise<void> {
  if (!clientInit) return;
  const client = await clientInit;
  if (!client) return;
  await client.shutdown();
}
