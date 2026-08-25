import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, UtensilsCrossed } from "lucide-react";
import * as z from "zod";
import { useSuspenseQuery } from "@tanstack/react-query";
import { householdRecipeQuery } from "#/lib/api";
import { OfflineRouteError } from "#/components/offline/OfflineRouteError";
import { Button } from "#/components/ui/button";
import { DetailPane } from "#/components/recipes/DetailPane";
import { EnrichmentDebugPanel } from "#/components/recipes/EnrichmentDebugPanel";

/**
 * The recipe detail child route (plan §5.1). Renders in the ledger's right pane
 * on desktop and full-screen on mobile. Authorization is box membership (not
 * `visibility='public'`), so it can render a recipe whose source has since gone
 * unavailable, from cache. Deep-linkable and readable (path-based, not a query).
 *
 * `?cook` opens cook mode immediately (meal planner §7.5). Nothing inside the
 * app points here any more — the planner opens the apron over the week instead —
 * but the URL is the app's only way to link straight into cook mode from
 * outside, so it stays. It is `.catch()`-guarded like every other search param
 * in the app: a mangled value renders the plain page rather than throwing a
 * route error.
 *
 * Bare `?cook` is the form to hand out — a flag that is either present or not,
 * with no value to get wrong. The union accepts the spelt-out variants too,
 * because a link written by hand is as likely to say `=1` or `=true`, and each
 * costs one member.
 *
 * Every member is a shape the router can actually hand us. Search values are
 * decoded and then JSON-parsed, so bare `?cook` arrives as `""`, `?cook=1` as
 * the number `1`, `?cook=true` as `true` — and a union that missed one would
 * silently drop it (and, because the parsed search is what the URL is rebuilt
 * from, quietly strip the param too). That rebuild is also why the address bar
 * shows `?cook=true` for a moment on any of the spellings before the param is
 * consumed: search is re-serialized from the parsed value, not echoed back.
 */
const searchSchema = z.object({
  cook: z
    .union([z.boolean(), z.literal(""), z.literal(1), z.literal("1"), z.literal("true")])
    .transform((value) => value !== false)
    .optional()
    .catch(undefined),
});

export const Route = createFileRoute("/household/recipes/$id")({
  validateSearch: searchSchema,
  /**
   * Offline-capable (§4.1). The parent layout route has already resolved the
   * active household, so `context.householdId` is available here without a
   * second round trip — and it has to be, because a query key needs a partition
   * before the query can even be looked up in IndexedDB.
   */
  loader: ({ context, params }) => context.queryClient.ensureQueryData(householdRecipeQuery(context.householdId, params.id)),
  errorComponent: OfflineRouteError,
  component: RecipeDetailRoute,
});

function RecipeDetailRoute() {
  const { id } = Route.useParams();
  const { householdId } = Route.useRouteContext();
  // The hook rather than the loader's return value, on purpose: an unobserved
  // query gets no refetch-on-reconnect, no invalidation and no gc protection,
  // which is exactly the machinery this route needs offline (§4.1).
  const { data: recipe } = useSuspenseQuery(householdRecipeQuery(householdId, id));
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  if (!recipe) return <NotInBox />;
  // Key by recipeId so switching recipes remounts the pane (resets favorite,
  // scroll, and the note editor without any setState-in-effect).
  return (
    <>
      <DetailPane
        key={recipe.recipeId}
        recipe={recipe}
        autoOpenCook={search.cook === true}
        // Drop the param once cook mode has been closed, so the deep link is
        // consumed exactly once and a reload does not re-enter the apron.
        onCookModeClosed={() => void navigate({ search: (prev) => ({ ...prev, cook: undefined }), replace: true })}
      />
      {/* Dev-only enrichment diagnostics (recipe-enrichment plan §10, D16).
        `import.meta.env.DEV` is the CLIENT half of the double gate — a
        production build never ships this branch at all. The server half
        (`getRecipeEnrichmentDebug` refusing outside dev) is what actually
        matters; this is only the reason nobody sees it who isn't looking.
        Rendered as a fixed, non-modal overlay rather than composed into
        `DetailPane` (out of scope to edit here) — `--z-banner` is the
        "pinned page furniture, never urgent" layer (styles.css), which is
        exactly what a diagnostic panel is. */}
      {import.meta.env.DEV && (
        <div className="pointer-events-none fixed inset-x-3 bottom-3 z-(--z-banner) flex justify-end lg:inset-x-auto lg:right-3">
          <div className="pointer-events-auto max-h-[60vh] w-full overflow-auto lg:w-96">
            <EnrichmentDebugPanel recipeId={recipe.recipeId} />
          </div>
        </div>
      )}
    </>
  );
}

function NotInBox() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <UtensilsCrossed className="size-10 text-muted-foreground" aria-hidden="true" />
      <div>
        <h2 className="display-title m-0 text-lg text-foreground">Not in your box</h2>
        <p className="mt-1 mb-0 text-sm text-muted-foreground">This recipe isn't on your household's shelf. Add it from the public collection to read it here.</p>
      </div>
      <Button size="sm" variant="outline" render={<Link to="/household/recipes" />} nativeButton={false}>
        <ArrowLeft data-icon="inline-start" aria-hidden="true" />
        Back to the shelf
      </Button>
    </div>
  );
}
