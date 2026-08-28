import type { PostHog } from "posthog-node";
import { log } from "#/log.ts";

/**
 * The fail-closed gate that decides whether `llm-enrich` may call an LLM at
 * all (llm plan L4, §5.1, §9.2).
 *
 * The client itself is `plugins/posthog.ts`'s now — this file is left with
 * only what is recipe-specific: the flag name, and the gate that reads it.
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
export async function isLlmEnrichmentEnabled(client: PostHog | null, recipeId: string): Promise<boolean> {
  const override = process.env.LLM_ENRICHMENT_ENABLED;
  if (override === "false") return false;
  if (override === "true") return true;

  if (!client) return false; // no PostHog → fail closed (no LLM call)
  try {
    const value = await client.isFeatureEnabled(LLM_ENRICHMENT_FLAG, recipeId);
    return value === true; // `undefined` (unreachable / missing) skips the LLM call
  } catch (err) {
    log.warn("llm-enrichment flag eval failed; skipping LLM call", { recipeId, err: String(err) });
    return false;
  }
}
