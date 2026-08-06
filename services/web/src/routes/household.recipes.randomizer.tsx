import { createFileRoute } from "@tanstack/react-router";
import { getRandomizerPool } from "#/server/randomizer";
import { Randomizer } from "#/components/recipes/Randomizer";

/**
 * The randomizer child route (plan `2026-08-03-meal-randomizer` §6):
 * `/household/recipes/randomizer`, a sibling of `$id` under the recipes shell.
 * Renders in the ledger's right pane via the layout's `<Outlet/>`, reusing its
 * mounted `RecipeLedger` / `RecipesViewContext` / toast queue — no standalone
 * route, no duplicated loader/session-guard logic. The layout's own loader
 * (`/household/recipes`) already gates through `requireActiveHousehold`, so
 * this loader — like `$id`'s — just fetches its data straight through the
 * household-scoped server function.
 *
 * Loads the box pool with no filters as the initial paint; the client owns
 * filter refetches, the draw/re-roll/no-repeat logic, and corpus widening
 * (plan §5).
 */
export const Route = createFileRoute("/household/recipes/randomizer")({
  loader: () => getRandomizerPool({ data: { source: "box" } }),
  component: RandomizerRoute,
});

function RandomizerRoute() {
  const initial = Route.useLoaderData();
  return <Randomizer initial={initial} />;
}
