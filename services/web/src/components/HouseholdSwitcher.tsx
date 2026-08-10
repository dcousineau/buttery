import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronsUpDown, Home } from "lucide-react";
import { useHydratedSession } from "#/lib/auth-client";
import { resolveOnboarding } from "#/server/household/onboarding";
import { Button } from "#/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import type { OnboardingVerdict } from "#/server/household/onboarding";

/**
 * Active-household indicator + switcher for the app chrome (§8, deliverable 3).
 * Shows the active household name and opens the picker/management surface.
 *
 * Fetching `resolveOnboarding()` here also RE-VALIDATES the active pointer on
 * every page (the header renders everywhere): the resolver clears a stale/removed
 * pointer as a side effect, backing the §8 "re-validated on every authenticated
 * request" guarantee even on screens that don't otherwise touch the household.
 */
export default function HouseholdSwitcher() {
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
        // Swallow (e.g. an unauthenticated redirect) — the switcher just hides.
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const verdict = state && state.userId === userId ? state.verdict : null;
  if (!userId || !verdict) return null;

  // No active household yet (onboarding). Nothing to indicate.
  if (verdict.kind === "onboard") return null;

  if (verdict.kind === "pick") {
    return (
      <Button variant="outline" size="sm" render={<Link to="/households/switch" />} nativeButton={false}>
        <Home data-icon="inline-start" aria-hidden="true" />
        Choose household
      </Button>
    );
  }

  // Active: unambiguous indicator + dropdown to manage or switch.
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="sm" className="max-w-44" title={`Active household: ${verdict.name}`}>
            <Home data-icon="inline-start" aria-hidden="true" />
            <span className="truncate">{verdict.name}</span>
            <ChevronsUpDown data-icon="inline-end" aria-hidden="true" className="opacity-70" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Active household</DropdownMenuLabel>
          <DropdownMenuItem render={<Link to="/households" />}>Manage household</DropdownMenuItem>
          <DropdownMenuItem render={<Link to="/households/switch" />}>Switch household</DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem render={<Link to="/onboarding" />}>Join or create another</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
