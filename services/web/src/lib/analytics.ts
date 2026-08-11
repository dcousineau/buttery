import { usePostHog } from "@posthog/react";
import { useMemo } from "react";
import type { PostHog } from "posthog-js";

/**
 * Client-side analytics gate. PostHog is PRODUCTION-ONLY.
 *
 * Every other environment — local dev, `vitest`, CI, and any future staging
 * deploy — is a total no-op: posthog-js is never initialized, no network request
 * is made, no event is captured, and no person is written. Non-production data
 * must never land in the PostHog project.
 *
 * The gate is an explicit build-time opt-in, `VITE_PUBLIC_POSTHOG_ENABLED`, set
 * only by the Railway service definition (see `.railway/railway.ts`). Two things
 * it deliberately is NOT:
 *
 *   - NOT "is a token present". `pnpm dev` runs through `railway run`, which
 *     injects the real production project token into a laptop shell. Token
 *     presence is evidence of nothing.
 *   - NOT `import.meta.env.DEV` / `NODE_ENV`. A staging deploy is a production
 *     build with production `NODE_ENV`; it must still capture nothing.
 *
 * It is an allowlist (`=== "true"`), so unset, misspelled, or empty all resolve
 * to OFF. The server-side half of the same gate is `POSTHOG_ENABLED`, read at
 * runtime by `./posthog-server`.
 *
 * Consequences, accepted deliberately: outside production there is no support
 * widget (PostHog Conversations), no session replay, no surveys, and no feature
 * flags. Both flags Buttery has are already env-driven or dev-bypassed outside
 * production — see `./posthog-server`.
 */

const enabledFlag = import.meta.env.VITE_PUBLIC_POSTHOG_ENABLED === "true";
// `?? ""` rather than leaving these `string | undefined`: empty is already the
// OFF case for the gate below, and it keeps `POSTHOG_CLIENT_CONFIG` a plain
// `{ apiKey: string; host: string }` on the enabled branch.
const token = import.meta.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN ?? "";
const host = import.meta.env.VITE_PUBLIC_POSTHOG_HOST ?? "";

/** Whether this build may talk to PostHog at all. Constant-folded by Vite. */
export const ANALYTICS_ENABLED: boolean = enabledFlag && Boolean(token) && Boolean(host);

/**
 * Credentials for `<PostHogProvider>`, or `null` when analytics is off.
 *
 * The token is exposed ONLY through this gated value — nothing else in the app
 * reads `VITE_PUBLIC_POSTHOG_PROJECT_TOKEN` — so a second provider mounted
 * somewhere else still cannot initialize a live client outside production.
 */
export const POSTHOG_CLIENT_CONFIG: { apiKey: string; host: string } | null = ANALYTICS_ENABLED ? { apiKey: token, host } : null;

/** Log the one misconfiguration the gate cannot fix: opted in, but no credentials. */
if (enabledFlag && !ANALYTICS_ENABLED) {
  console.error(`[posthog] VITE_PUBLIC_POSTHOG_ENABLED is set but ${!token ? "VITE_PUBLIC_POSTHOG_PROJECT_TOKEN" : "VITE_PUBLIC_POSTHOG_HOST"} is unset — analytics is disabled.`);
}

/**
 * Properties that must read as absent rather than as a chainable no-op.
 *
 * `conversations` is the support widget: every caller checks it for existence
 * before driving it, and a truthy stand-in would start those poll loops for a
 * widget that will never appear.
 *
 * The rest are protocol keys that break things when they answer a call they
 * shouldn't. `then` is the dangerous one: a thenable whose `then` never invokes
 * its callback makes `await analytics.posthog` hang forever. `$$typeof` would
 * make React try to render the proxy as an element.
 */
const ABSENT_PROPS = new Set<string>(["conversations", "then", "catch", "finally", "$$typeof", "toJSON", "nodeType"]);

/**
 * Methods that must answer `undefined` instead of returning the chainable proxy.
 *
 * Everything the proxy returns is an object, and every object is truthy — so
 * `if (posthog.isFeatureEnabled("x"))` on a bare chaining proxy reads as ENABLED
 * and fails OPEN. That is backwards for every gate Buttery has (see
 * `./posthog-server`), and it is exactly the shape of call a disabled build is
 * most likely to get wrong. Reads of flags, surveys, identity, and consent all
 * answer `undefined` — falsy, and the same "unknown" the real SDK returns before
 * it has loaded.
 */
const ABSENT_RETURNS = new Set<string>([
  "isFeatureEnabled",
  "getFeatureFlag",
  "getFeatureFlagPayload",
  "getActiveMatchingSurveys",
  "getSurveys",
  "getEarlyAccessFeatures",
  "get_distinct_id",
  "get_property",
  "get_session_id",
  "get_session_replay_url",
  "has_opted_in_capturing",
  "has_opted_out_capturing",
]);

/**
 * A PostHog stand-in where every method is a no-op and every unknown property is
 * another stand-in, so `posthog.anything().chained.deeply()` is inert instead of
 * a `TypeError`. Deliberately shaped like the real client rather than a narrow
 * facade: call sites write ordinary posthog-js and the gate decides whether it
 * does anything, so nothing has to be re-plumbed when a new API is used.
 *
 * Exported for its tests; the app gets it from {@link useAnalytics}.
 */
export function createNoopPostHog(): PostHog {
  // A function target, so the proxy is callable and can trap `apply`.
  const noop: PostHog = new Proxy(function () {} as unknown as PostHog, {
    get(_target, prop) {
      // Symbols cover primitive coercion (`Symbol.toPrimitive`), iteration, and
      // promise/React internals. None of them want a chainable object.
      if (typeof prop === "symbol") return undefined;
      if (ABSENT_PROPS.has(prop)) return undefined;
      if (ABSENT_RETURNS.has(prop)) return () => undefined;
      // `toString`/`valueOf` must yield primitives or coercing the proxy throws.
      if (prop === "toString" || prop === "valueOf") return () => "[posthog disabled]";
      return noop;
    },
    apply() {
      return noop; // chaining: a no-op call hands back the same stand-in
    },
  });
  return noop;
}

/** What the app holds: the PostHog client itself, plus whether it is real. */
export type Analytics = {
  /** The posthog-js client in production; a chainable no-op stand-in everywhere else. */
  posthog: PostHog;
  /** Whether `posthog` is a live client. Use it to skip work that only exists to feed analytics — never as a guard around a capture, which is already inert. */
  enabled: boolean;
};

const DISABLED_ANALYTICS: Analytics = Object.freeze({ posthog: createNoopPostHog(), enabled: false });

/**
 * The app's only handle on PostHog. Outside production it hands back the no-op
 * stand-in, so a capture added anywhere is inert by construction rather than by
 * remembering to guard it.
 *
 * Use this instead of `usePostHog()` everywhere. Without a provider mounted,
 * `usePostHog()` hands back posthog-js's *uninitialized module singleton*: calls
 * no-op today, but they log warnings and the instance is one stray `init()` away
 * from being live.
 */
export function useAnalytics(): Analytics {
  // Called unconditionally — hook order must not depend on the gate. When
  // analytics is off the returned client is discarded.
  const client = usePostHog();
  return useMemo<Analytics>(() => (ANALYTICS_ENABLED ? { posthog: client, enabled: true } : DISABLED_ANALYTICS), [client]);
}
