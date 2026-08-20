import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { UserPlus } from "lucide-react";
import { dismissInviteNudge } from "#/lib/api";
import { cn } from "#/lib/utils";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";

/**
 * The pantry's one-time "there's nobody else in here" nudge (onboarding→pantry
 * plan §6) — the follow-through on onboarding's promise that you can invite the
 * rest of the house the minute the household exists.
 *
 * It is a **first-run action**, not part of either pantry state, which is why
 * the route renders it above both the empty-box welcome and the overview: a
 * household of one is worth fixing whether or not the box has recipes in it.
 *
 * The route decides *whether* to render this at all — the server answers "one
 * live member, not yet dismissed" in the loader. This component owns only the
 * dismissal, and owns it optimistically: the card hides the moment "Not now" is
 * pressed and a failed write just leaves it hidden for the session. Nothing is
 * lost if the POST never lands (the nudge comes back next load), and blocking a
 * dismissal on the network would be a worse trade than re-asking.
 *
 * The primary action points at `/households`, which is where the invite form
 * lives — the one place onboarding is still allowed to send someone.
 */
export function InviteYourHouseCard({ householdId, className }: { householdId: string; className?: string }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  function onNotNow() {
    setDismissed(true);
    void dismissInviteNudge(householdId).catch(() => {
      // Optimistic on purpose — see the note above. A failure leaves the card
      // hidden for this session and the nudge returns on the next load.
    });
  }

  return (
    <Card className={cn("border-primary/40", className)}>
      <CardContent className="flex flex-col gap-4 pt-4 sm:flex-row sm:items-start">
        <UserPlus aria-hidden="true" className="mt-0.5 size-6 flex-none" />
        <div className="min-w-0 flex-1">
          <h2 className="display-title m-0 text-lg leading-tight text-foreground">Nobody else is in here yet</h2>
          <p className="mt-1.5 mb-0 max-w-[42rem] text-sm text-pretty text-muted-foreground">
            Buttery is better with the rest of the house in it — send them an invite and everything you add shows up for them too.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button render={<Link to="/households" />} nativeButton={false}>
              <UserPlus data-icon="inline-start" aria-hidden="true" />
              Invite someone
            </Button>
            <Button variant="ghost" onClick={onNotNow}>
              Not now
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
