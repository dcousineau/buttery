/**
 * "Does this visitor prefer reduced motion?", as a hook — the one thing §5.6's
 * dice-tumble delay is gated on (meal randomizer plan §5.6, §12: "kept, driven
 * by `prefers-reduced-motion`" — not a hardcoded flag). No existing hook in
 * the repo reads this media feature (grepped `lib/hooks/` and `styles.css`'s
 * own `@media (prefers-reduced-motion: reduce)` block, which is CSS-only and
 * has no JS counterpart), so this is new.
 *
 * Same `useSyncExternalStore` shape as `lib/hooks/use-mobile.ts`: SSR and the
 * first client render both answer `false` (motion allowed) so there is no
 * hydration mismatch, and the real value — which can change mid-session if the
 * OS setting flips — arrives on the commit after, via the media query's
 * `change` event.
 */
import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void): () => void {
  const mql = window.matchMedia(QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}
