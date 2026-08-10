import { Link } from "@tanstack/react-router";
import { ArrowLeft, CookingPot } from "lucide-react";
import { Button } from "#/components/ui/button";

/**
 * The router's `defaultNotFoundComponent` — what any unmatched URL renders,
 * inside whatever layout the nearest matched route established.
 *
 * Configuring one is what keeps a 404 from being a dev-server outage: with no
 * component set the router warns on every not-found, and the devtools console
 * pipe echoes that warning between client and server until the heap is gone.
 *
 * Deliberately generic about the destination — this catches marketing URLs and
 * app URLs alike, so it points at `/`, which itself redirects a signed-in
 * caller onward to `/household`.
 */
export function NotFound() {
  return (
    <div className="page-wrap px-4 py-20 text-center">
      <CookingPot className="mx-auto size-12 text-muted-foreground" aria-hidden />
      <h1 className="display-title mt-6 text-3xl text-foreground">Nothing on this shelf</h1>
      <p className="mt-3 text-muted-foreground">That page doesn't exist. Check the link, or head back and start again.</p>
      <Button className="mt-6" render={<Link to="/" />} nativeButton={false}>
        <ArrowLeft data-icon="inline-start" />
        Back to Buttery
      </Button>
    </div>
  );
}
