import { createFileRoute, Link } from "@tanstack/react-router";
import { Compass, Settings2 } from "lucide-react";
import { requireActiveHousehold } from "#/lib/household/onboarding";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { seo } from "#/lib/seo";

/**
 * The logged-in landing (`/pantry`). This is where sign-in and the wordmark drop
 * an authenticated user with an active household — the sidebar-navved home of the
 * app, distinct from the public marketing page at `/`.
 *
 * The loader gates through {@link requireActiveHousehold}: an active-household
 * caller renders this overview; a multi-membership caller is redirected to the
 * picker (`/households/switch`), and a caller with no membership to onboarding.
 *
 * Placeholder for now — this becomes the household overview (recent activity,
 * shelves, planner-at-a-glance) as those features land.
 */
export const Route = createFileRoute("/pantry")({
  loader: () => requireActiveHousehold(),
  head: () => ({ meta: seo({ title: "Your pantry · Buttery", description: "Your household's home in Buttery." }) }),
  component: PantryPage,
});

function PantryPage() {
  const { name } = Route.useLoaderData();
  return (
    <div className="page-wrap px-4 pt-10 pb-12 sm:pt-14">
      <div className="rise-in flex flex-col gap-6">
        <header className="flex flex-col items-start">
          <Badge variant="secondary" className="mb-3">
            {name}
          </Badge>
          <h1 className="display-title m-0 text-3xl leading-[1.1] text-foreground sm:text-4xl">Your pantry</h1>
          <p className="mt-3 mb-0 max-w-xl text-sm text-muted-foreground sm:text-base">
            This is the home for <strong className="text-foreground">{name}</strong>. It'll become your overview — recent recipes, shelves, and what's on the menu — as those
            features land. For now, the shelves are still being stocked.
          </p>
        </header>

        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={2} className="display-title flex items-center gap-2 text-lg">
              <Compass aria-hidden="true" className="size-5" />
              Overview coming soon
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col items-start gap-4">
            <p className="m-0 text-sm text-muted-foreground">Once recipes, collections, and the meal planner are live, this page will pull them together at a glance.</p>
            <Button variant="outline" render={<Link to="/households" />} nativeButton={false}>
              <Settings2 data-icon="inline-start" aria-hidden="true" />
              Manage household
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
