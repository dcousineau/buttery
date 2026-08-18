import { useState } from "react";
import { CloudOff, RefreshCw } from "lucide-react";
import { useRouter, type ErrorComponentProps } from "@tanstack/react-router";
import { Button } from "#/components/ui/button";
import { isOffline } from "#/lib/api";

/**
 * The `errorComponent` for the offline-capable routes (offline plan §4.1, §4.4).
 *
 * An offline route only renders what has actually been cached. Open
 * `/household/plan` on a phone that has never opened the planner, with no
 * signal, and `ensureQueryData` has nothing to resolve from and nothing to fetch
 * — so the loader rejects and the router falls through to its **default** error
 * boundary. Which is to say: a bare "Something went wrong!" and a Show Error
 * button, on a page with no header, no sidebar, and no way back. (Exactly what
 * it did, in a browser, before this component existed.)
 *
 * That is the wrong answer twice over. Nothing went wrong — the app is working
 * as designed, it simply does not have this week saved — and a dead end is a
 * poor place to leave someone standing in a shop.
 *
 * So: when the failure is the network, say so in the app's own voice and offer
 * the one action that helps (try again, once there is signal). Anything else is
 * re-thrown, because a real bug must not be disguised as a connectivity blip —
 * that is how a broken query becomes a "flaky offline mode" nobody can
 * reproduce.
 *
 * **"Try again" runs `router.invalidate()`, not the `reset` the router hands
 * this component.** `reset` is `CatchBoundary.reset`, and all it does is
 * `setState({ error: null })` — the *match* is untouched and still in `error`
 * status, so on the very next render `MatchInner` reaches `throw match.error`
 * again, synchronously, and the same boundary catches the same error. Nothing
 * re-runs, nothing re-fetches: the button was a permanent no-op, and it was a
 * no-op in precisely the moment it is reached for, with signal restored and a
 * shopping list still not on screen. `invalidate()` is the one that means it —
 * it flips matches in `error` status back to `pending` and re-runs their
 * loaders, and the resulting new match object also trips the boundary's own
 * `getResetKey`, so the error state clears without touching `reset` at all.
 */
export function OfflineRouteError({ error }: ErrorComponentProps) {
  const router = useRouter();
  const [retrying, setRetrying] = useState(false);

  if (!isOffline(error)) throw error;

  function retry(): void {
    setRetrying(true);
    // On success this component unmounts as the boundary resets, so the
    // `finally` lands on nothing — which is fine, and the alternative (leaving
    // the button spinning) is worse when the retry fails and the user wants
    // another go a minute later, further into the car park.
    void router.invalidate().finally(() => setRetrying(false));
  }

  return (
    <div className="flex h-full min-h-[60svh] flex-col items-center justify-center gap-3 px-6 text-center">
      <CloudOff className="size-10 text-muted-foreground" aria-hidden="true" />
      <div>
        <h2 className="display-title m-0 text-lg text-foreground">Not saved for offline yet</h2>
        <p className="mt-1 mb-0 max-w-prose text-sm text-muted-foreground">
          This page hasn't been open on this device since it was last online, so there's nothing stored to show. Open it once with a connection and it'll be here next time.
        </p>
      </div>
      <Button size="sm" variant="outline" onClick={retry} disabled={retrying}>
        <RefreshCw data-icon="inline-start" aria-hidden="true" />
        {retrying ? "Trying…" : "Try again"}
      </Button>
    </div>
  );
}
