/**
 * The fail-closed gate that decides whether `llm-enrich` may call an LLM at
 * all (llm plan L4, §9.2).
 *
 * ── WAS A POSTHOG FLAG, IS NOW AN ENV VAR ─────────────────────────────────
 *
 * This used to read the PostHog flag `llm-enrichment-enabled`, keyed on
 * `recipeId` so a rollout percentage acted as a deterministic canary over the
 * corpus, with `LLM_ENRICHMENT_ENABLED` as a dev-only override on top. Both
 * halves are gone; the env var is the whole gate now.
 *
 * The flag bought a graduated rollout at the cost of a network round trip and
 * a `$feature_flag_called` capture on the hot path of every single
 * `llm-enrich` job, on a queue whose whole job is to run once per recipe over
 * the entire corpus. Nothing here is user-facing: no session, no experiment,
 * no cohort — the "canary" was a percentage of rows, which `--limit` and
 * `--max` on `backfill` already express directly and without a flag service in
 * the loop. A backend kill switch that an operator flips in the Railway UI is
 * what this actually is, so that is what it now looks like.
 *
 * PostHog is still where the generations, costs and disagreement events land.
 * It just no longer decides whether the call happens.
 *
 * ── STILL FAIL-CLOSED ─────────────────────────────────────────────────────
 *
 * The variable defaults to `"false"` in `plugins/env.ts`, so unset means
 * disabled — a service deployed without ever hearing of this variable spends
 * no tokens. Only an explicit opt-in returns `true`; anything unrecognized
 * (empty, `"maybe"`, a typo) reads as disabled rather than as an error,
 * because the failure mode of guessing wrong here is a paid model call the
 * operator did not ask for.
 *
 * Case- and spelling-tolerant on the accepting side only: Railway's UI is a
 * plain text box, and `True` from a human meant to enable this. The tolerance
 * runs one way — no spelling of "off" is needed, since everything that is not
 * an accepted "on" is already off.
 */

const ENABLED_VALUES = new Set(["true", "1", "yes", "on"]);

/** Whether `llm-enrich` may spend a model call. Fail-closed: unset ⇒ `false`. */
export function isLlmEnrichmentEnabled(value: string | undefined): boolean {
  return ENABLED_VALUES.has((value ?? "").trim().toLowerCase());
}
