import { createFileRoute } from "@tanstack/react-router";
import { requireActiveHousehold } from "#/server/household/onboarding";
import { RecipeForm } from "#/components/recipes/create/RecipeForm";
import { seo } from "#/lib/seo";

/**
 * The full-page recipe create/import form (plan §A5). Lives at
 * `/household/recipes/new`; the recipes master–detail layout hides its ledger for
 * this route so the form renders full width (plan: the form is a full page, not a
 * modal). `?source=<url>` puts the form in import mode with Website attribution
 * locked to that URL (chooser "Import from a URL"; also the Phase C bookmarklet
 * landing target).
 */
export const Route = createFileRoute("/household/recipes/new")({
  validateSearch: (search: Record<string, unknown>): { source?: string; import?: string } => ({
    source: typeof search.source === "string" ? search.source : undefined,
    // Opaque import id (Phase B scrape). The form fetches the cached prefill by
    // id rather than carrying it in the URL.
    import: typeof search.import === "string" ? search.import : undefined,
  }),
  loader: async () => requireActiveHousehold(),
  head: () => ({ meta: seo({ title: "New recipe · Buttery", description: "Add a recipe to your household's box." }) }),
  component: NewRecipePage,
});

function NewRecipePage() {
  const { name } = Route.useLoaderData();
  const { source, import: importId } = Route.useSearch();
  return <RecipeForm householdName={name} sourceUrl={source ?? null} importId={importId ?? null} />;
}
