import { useEffect, useState } from "react";
import { useHydratedSession } from "#/lib/auth-client";
import { resolveOnboarding } from "#/lib/api";
import type { OnboardingVerdict } from "#/lib/api";

/**
 * The current caller's §5 household verdict, fetched once per session identity.
 * `null` while it is loading, when signed out, or when the fetch failed (e.g. an
 * unauthenticated redirect) — consumers render nothing in that case.
 *
 * Fetching `resolveOnboarding()` from the app chrome (the `UserMenu`, which
 * renders on every page) also RE-VALIDATES the active pointer on every page: the
 * resolver clears a stale/removed pointer as a side effect, backing the §8
 * "re-validated on every authenticated request" guarantee even on screens that
 * don't otherwise touch the household.
 */
export function useOnboardingVerdict(): OnboardingVerdict | null {
  const { data: session } = useHydratedSession();
  const userId = session?.user.id ?? null;
  // Tag the fetched verdict with the userId it belongs to, so a stale/removed
  // session is cleared by DERIVING null at render (below) rather than a
  // synchronous setState inside the effect (which triggers cascading renders).
  const [state, setState] = useState<{ userId: string; verdict: OnboardingVerdict } | null>(null);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    resolveOnboarding()
      .then((v) => {
        if (!cancelled) setState({ userId, verdict: v });
      })
      .catch(() => {
        // Swallow (e.g. an unauthenticated redirect) — consumers just hide.
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (!userId) return null;
  return state && state.userId === userId ? state.verdict : null;
}
