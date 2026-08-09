import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Clock, CookingPot, UtensilsCrossed, Users } from "lucide-react";
import { lexiconToSchemaOrg } from "@buttery/recipe-schemas/bridge";
import type { SchemaOrgRecipe } from "@buttery/recipe-schemas/schema-org";
import { getRecipe } from "../server/recipes";
import { formatDuration, formatPublished } from "../lib/format";
import { parseServes } from "../lib/recipe-scale";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Separator } from "#/components/ui/separator";
import { CookModeLauncher } from "#/components/recipes/CookModeLauncher";
import type { CookRecipe } from "#/components/recipes/cook/CookMode";
import type { RecipeDetailData } from "../server/recipes";

export const Route = createFileRoute("/recipes/$id")({
  loader: ({ params }) => getRecipe({ data: params.id }),
  head: ({ loaderData }) => ({
    meta: loaderData
      ? [
          { title: `${loaderData.name} · Buttery` },
          // Canonical AT-URI — points parsers at the source record in atproto,
          // independent of this web render. content is the recipe's own at:// URI.
          ...(loaderData.uri ? [{ name: "at:canonical", content: loaderData.uri }] : []),
        ]
      : [{ title: "Recipe not found · Buttery" }],
  }),
  component: RecipePage,
});

function RecipePage() {
  const recipe = Route.useLoaderData();
  if (!recipe) return <NotFound />;
  return <RecipeDetail recipe={recipe} />;
}

function NotFound() {
  return (
    <div className="page-wrap px-4 py-20 text-center">
      <UtensilsCrossed className="mx-auto size-12 text-muted-foreground" aria-hidden />
      <h1 className="display-title mt-6 text-3xl text-foreground">Recipe not found</h1>
      <p className="mt-3 text-muted-foreground">This recipe doesn't exist, isn't public, or hasn't been indexed yet.</p>
      <Button className="mt-6" render={<Link to="/" />} nativeButton={false}>
        <ArrowLeft data-icon="inline-start" />
        Back to the pantry
      </Button>
    </div>
  );
}

// --- schema.org/Recipe structured data ----------------------------------

/**
 * Build a JSON-LD https://schema.org/Recipe document. Emitted alongside the
 * inline microdata so third parties can parse the recipe either way, with no
 * scraping of the human layout.
 *
 * The vocabulary itself — property names, the RestrictedDiet crosswalk, which
 * fields may be omitted — lives in `@buttery/recipe-schemas`, shared with the
 * import parsers so the read and write sides can't drift. All this does is map
 * our rendered read model onto that input.
 */
function buildRecipeLd(recipe: RecipeDetailData): SchemaOrgRecipe {
  const a = recipe.attribution;
  const authorName = a?.displayName ?? a?.author ?? a?.publisher ?? recipe.publishedBy;

  return lexiconToSchemaOrg({
    name: recipe.name,
    description: recipe.description,
    imageUrls: recipe.images.map((i) => i.url),
    // atproto attribution kinds: person/organization/publication/… — the
    // crosswalk types anything that isn't clearly a person as an Organization.
    author: authorName ? { name: authorName, kind: a?.kind, url: a?.url } : null,
    datePublished: recipe.publishedAt,
    // Already ISO-8601 durations (PT1H30M) — exactly schema's expected form.
    prepTime: recipe.prepTime,
    cookTime: recipe.cookTime,
    totalTime: recipe.totalTime,
    recipeYield: recipe.recipeYield,
    cuisine: recipe.cuisine,
    category: recipe.category,
    cookingMethod: recipe.cookingMethod,
    // Diets with no RestrictedDiet member are dropped here; they still ride
    // along in `keywords`.
    dietSlugs: recipe.suitableForDiet,
    keywords: recipe.keywords,
    ingredients: recipe.ingredients,
    instructions: recipe.instructions,
    calories: recipe.calories,
    url: recipe.uri,
  });
}

function RecipeDetail({ recipe }: { recipe: RecipeDetailData }) {
  const hero = recipe.images[0];
  const times = [
    recipe.prepTime && { label: "Prep", value: formatDuration(recipe.prepTime) },
    recipe.cookTime && { label: "Cook", value: formatDuration(recipe.cookTime) },
    recipe.totalTime && { label: "Total", value: formatDuration(recipe.totalTime) },
  ].filter(Boolean) as Array<{ label: string; value: string }>;

  const facets = [recipe.cuisine, recipe.category, recipe.cookingMethod, ...recipe.suitableForDiet].filter(Boolean) as string[];

  return (
    <article className="rise-in page-wrap px-4 pt-8 pb-16" itemScope itemType="https://schema.org/Recipe">
      {/* Machine-readable copy: full schema.org/Recipe as JSON-LD, so parsers
          never have to scrape the human layout. The visible DOM below is also
          tagged with matching microdata itemprops. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(buildRecipeLd(recipe)) }} />
      {recipe.uri ? <link itemProp="url" href={recipe.uri} /> : null}

      <Button variant="ghost" size="sm" render={<Link to="/" />} nativeButton={false} className="mb-6 -ml-2">
        <ArrowLeft data-icon="inline-start" />
        Back to the pantry
      </Button>

      <header className="grid gap-8 lg:grid-cols-[1.1fr_1fr] lg:items-center">
        <div className="order-2 min-w-0 lg:order-1">
          <p className="mb-4 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted-foreground">
            {recipe.publishedBy ? (
              recipe.publisherUrl ? (
                <a href={recipe.publisherUrl} target="_blank" rel="noreferrer noopener" className="font-semibold text-foreground hover:underline">
                  {recipe.publishedBy}
                </a>
              ) : (
                <span className="font-semibold text-foreground">{recipe.publishedBy}</span>
              )
            ) : null}
            {recipe.app ? (
              <span>
                published via{" "}
                {recipe.appUrl ? (
                  <a href={recipe.appUrl} target="_blank" rel="noreferrer noopener" className="font-medium text-foreground hover:underline">
                    {recipe.app}
                  </a>
                ) : (
                  <span className="font-medium text-foreground">{recipe.app}</span>
                )}
              </span>
            ) : null}
            {recipe.publishedAt ? (
              <>
                <span aria-hidden>·</span>
                <time itemProp="datePublished" dateTime={recipe.publishedAt}>
                  {formatPublished(recipe.publishedAt)}
                </time>
              </>
            ) : null}
          </p>
          <h1 className="display-title m-0 text-4xl leading-[1.08] text-foreground sm:text-5xl" itemProp="name">
            {recipe.name}
          </h1>
          {recipe.description ? (
            <p className="mt-4 max-w-prose text-base text-muted-foreground sm:text-lg" itemProp="description">
              {recipe.description}
            </p>
          ) : null}

          {/* Machine values for bits the visible layout formats or merges
              (durations shown as "1h 30m", facets flattened into badges). */}
          {recipe.prepTime ? <meta itemProp="prepTime" content={recipe.prepTime} /> : null}
          {recipe.cookTime ? <meta itemProp="cookTime" content={recipe.cookTime} /> : null}
          {recipe.totalTime ? <meta itemProp="totalTime" content={recipe.totalTime} /> : null}
          {recipe.recipeYield ? <meta itemProp="recipeYield" content={recipe.recipeYield} /> : null}
          {recipe.cuisine ? <meta itemProp="recipeCuisine" content={recipe.cuisine} /> : null}
          {recipe.category ? <meta itemProp="recipeCategory" content={recipe.category} /> : null}
          {recipe.cookingMethod ? <meta itemProp="cookingMethod" content={recipe.cookingMethod} /> : null}
          {recipe.calories != null ? (
            <span itemProp="nutrition" itemScope itemType="https://schema.org/NutritionInformation">
              <meta itemProp="calories" content={`${recipe.calories} calories`} />
            </span>
          ) : null}

          {(times.length > 0 || recipe.recipeYield || recipe.calories != null) && (
            <div className="mt-6 flex flex-wrap gap-x-6 gap-y-3">
              {times.map((t) => (
                <Stat key={t.label} icon={<Clock />} label={t.label} value={t.value} />
              ))}
              {recipe.recipeYield ? <Stat icon={<Users />} label="Yield" value={recipe.recipeYield} /> : null}
              {recipe.calories != null ? <Stat icon={<CookingPot />} label="Calories" value={String(recipe.calories)} /> : null}
            </div>
          )}

          {facets.length > 0 && (
            <div className="mt-5 flex flex-wrap gap-2">
              {facets.map((f) => (
                <Badge key={f} variant="outline" size="xs">
                  {f}
                </Badge>
              ))}
            </div>
          )}

          {/* Cook mode — anyone can run the recipe hands-free (no account needed). */}
          {recipe.instructions.length > 0 && (
            <div className="mt-8">
              <PublicCookMode recipe={recipe} />
            </div>
          )}
        </div>

        <div className="order-1 lg:order-2">
          {hero ? (
            <img itemProp="image" src={hero.url} alt={hero.alt ?? recipe.name} className="aspect-[4/3] w-full rounded-xl border-2 border-border object-cover shadow-pop-md" />
          ) : (
            <div className="flex aspect-[4/3] w-full items-center justify-center rounded-xl border-2 border-border bg-muted text-muted-foreground shadow-pop-md">
              <UtensilsCrossed className="size-14" aria-hidden />
            </div>
          )}
        </div>
      </header>

      <Separator className="my-10" />

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_1.6fr]">
        <section>
          <h2 className="display-title m-0 text-2xl text-foreground">Ingredients</h2>
          {recipe.ingredients.length > 0 ? (
            <ul className="mt-4 space-y-2.5">
              {recipe.ingredients.map((ing, i) => (
                <li key={i} className="flex gap-3 text-base text-foreground" itemProp="recipeIngredient">
                  <span className="mt-2 size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
                  <span className="min-w-0">{ing}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-muted-foreground">No ingredients listed.</p>
          )}
        </section>

        <section>
          <h2 className="display-title m-0 text-2xl text-foreground">Instructions</h2>
          {recipe.instructions.length > 0 ? (
            <ol className="mt-4 space-y-5">
              {recipe.instructions.map((step, i) => (
                <li key={i} className="flex gap-4" itemProp="recipeInstructions" itemScope itemType="https://schema.org/HowToStep">
                  <span
                    className="flex size-8 shrink-0 items-center justify-center rounded-full border-2 border-border bg-secondary text-sm font-bold text-secondary-foreground"
                    aria-hidden
                  >
                    {i + 1}
                  </span>
                  <p className="m-0 min-w-0 pt-1 text-base leading-relaxed text-foreground" itemProp="text">
                    {step}
                  </p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-4 text-muted-foreground">No instructions listed.</p>
          )}
        </section>
      </div>

      {recipe.images.length > 1 && (
        <section className="mt-12">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {recipe.images.slice(1).map((img, i) => (
              <img
                key={i}
                itemProp="image"
                src={img.url}
                alt={img.alt ?? `${recipe.name} photo ${i + 2}`}
                loading="lazy"
                className="aspect-[4/3] w-full rounded-xl border-2 border-border object-cover"
              />
            ))}
          </div>
        </section>
      )}

      {recipe.keywords.length > 0 && (
        <div className="mt-12 flex flex-wrap gap-2">
          {recipe.keywords.map((k) => (
            <Badge key={k} variant="ghost" size="xs" className="border-border" itemProp="keywords">
              {k}
            </Badge>
          ))}
        </div>
      )}

      {(recipe.attribution || recipe.uri) && (
        <footer className="mt-12 rounded-xl border-2 border-border bg-muted/40 p-5 text-sm text-muted-foreground">
          {recipe.attribution && (recipe.attribution.displayName || recipe.attribution.author || recipe.attribution.publisher) ? (
            <p className="m-0" itemProp="author" itemScope itemType={recipe.attribution.kind === "person" ? "https://schema.org/Person" : "https://schema.org/Organization"}>
              <span className="font-semibold text-foreground">Source: </span>
              {recipe.attribution.url ? (
                <a itemProp="url" href={recipe.attribution.url} target="_blank" rel="noreferrer noopener nofollow" className="text-primary underline underline-offset-4">
                  <span itemProp="name">{recipe.attribution.displayName ?? recipe.attribution.author ?? recipe.attribution.publisher}</span>
                </a>
              ) : (
                <span itemProp="name">{recipe.attribution.displayName ?? recipe.attribution.author ?? recipe.attribution.publisher}</span>
              )}
              {recipe.attribution.author && recipe.attribution.displayName ? ` — by ${recipe.attribution.author}` : null}
            </p>
          ) : null}
          {recipe.uri ? (
            <p className="m-0 mt-2">
              <span className="font-semibold text-foreground">Record: </span>
              <code className="break-all">{recipe.uri}</code>
            </p>
          ) : null}
        </footer>
      )}
    </article>
  );
}

/**
 * Cook mode on the public page. No provider to set up: cook mode owns its own
 * scale/units when nothing above it supplies them (`useRecipeScale`), and it
 * needs nothing else from the recipes shell this page does not have.
 * `RecipeDetailData` is adapted to the `CookRecipe` shape (id→recipeId,
 * name→title, yield→serves, ISO→display).
 */
function PublicCookMode({ recipe }: { recipe: RecipeDetailData }) {
  const cook: CookRecipe = {
    recipeId: recipe.id,
    title: recipe.name,
    ingredients: recipe.ingredients,
    instructions: recipe.instructions,
    serves: parseServes(recipe.recipeYield),
    totalTimeDisplay: recipe.totalTime ? formatDuration(recipe.totalTime) : null,
  };
  return <CookModeLauncher recipe={cook} />;
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>
      <span className="text-sm">
        <span className="font-bold text-foreground">{value}</span> <span className="text-muted-foreground">{label}</span>
      </span>
    </div>
  );
}
