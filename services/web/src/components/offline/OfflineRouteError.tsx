import { CloudOff, RefreshCw } from "lucide-react";
import type { ErrorComponentProps } from "@tanstack/react-router";
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
 */
export function OfflineRouteError({ error, reset }: ErrorComponentProps) {
  if (!isOffline(error)) throw error;

  return (
    <div className="flex h-full min-h-[60svh] flex-col items-center justify-center gap-3 px-6 text-center">
      <CloudOff className="size-10 text-muted-foreground" aria-hidden="true" />
      <div>
        <h2 className="display-title m-0 text-lg text-foreground">Not saved for offline yet</h2>
        <p className="mt-1 mb-0 max-w-prose text-sm text-muted-foreground">
          This page hasn't been open on this device since it was last online, so there's nothing stored to show. Open it once with a connection and it'll be here next time.
        </p>
      </div>
      <Button size="sm" variant="outline" onClick={reset}>
        <RefreshCw data-icon="inline-start" aria-hidden="true" />
        Try again
      </Button>
    </div>
  );
}
