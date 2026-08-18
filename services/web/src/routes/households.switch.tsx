import { useState } from "react";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { Check, Users } from "lucide-react";
import { listMyHouseholds } from "#/lib/api";
import { switchActiveHousehold } from "#/lib/api";
import { errorMessage } from "#/lib/api";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent } from "#/components/ui/card";
import { Spinner } from "#/components/ui/spinner";
import { seo } from "#/lib/seo";
import type { HouseholdSummary } from "#/lib/api";

/** The multi-household picker (§5). Reached from the §5 state machine (2+ live
 * memberships, no active) and from the chrome switcher at any time. */
export const Route = createFileRoute("/households/switch")({
  loader: async () => {
    const households = await listMyHouseholds();
    if (households.length === 0) throw redirect({ to: "/onboarding" });
    return { households };
  },
  head: () => ({ meta: seo({ title: "Choose a household · Buttery", description: "Switch between your households." }) }),
  component: PickerPage,
});

function PickerPage() {
  const { households } = Route.useLoaderData();
  return (
    <div className="page-wrap px-4 pt-10 pb-12 sm:pt-14">
      <div className="rise-in mx-auto flex max-w-xl flex-col gap-6">
        <header className="flex flex-col items-start">
          <Badge variant="secondary" className="mb-3">
            Your households
          </Badge>
          <h1 className="display-title m-0 text-3xl leading-[1.1] text-foreground sm:text-4xl">Choose a household</h1>
          <p className="mt-3 mb-0 text-sm text-muted-foreground sm:text-base">Pick which household to work in. You can switch again anytime from the top bar.</p>
        </header>

        <div className="flex flex-col gap-3">
          {households.map((h) => (
            <PickerCard key={h.id} household={h} />
          ))}
        </div>

        <p className="m-0 text-center text-xs text-muted-foreground">
          Need a new one?{" "}
          <Link to="/onboarding" className="font-semibold text-primary underline underline-offset-4">
            Get started
          </Link>
        </p>
      </div>
    </div>
  );
}

function PickerCard({ household }: { household: HouseholdSummary }) {
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onChoose() {
    setError(null);
    setPending(true);
    try {
      await switchActiveHousehold(household.id);
      await navigate({ to: "/households" });
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-4">
        <div className="min-w-0">
          <p className="m-0 flex items-center gap-2 text-base font-bold text-foreground">
            {household.name}
            <Badge variant={household.role === "owner" ? "secondary" : "outline"}>{household.role}</Badge>
          </p>
          <p className="m-0 flex items-center gap-1 text-sm text-muted-foreground">
            <Users aria-hidden="true" className="size-3.5" />
            {household.memberCount} {household.memberCount === 1 ? "member" : "members"}
          </p>
          {error ? (
            <p role="alert" className="m-0 mt-1 text-sm font-semibold text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <Button onClick={onChoose} disabled={pending}>
          {pending ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" aria-hidden="true" />}
          Enter
        </Button>
      </CardContent>
    </Card>
  );
}
