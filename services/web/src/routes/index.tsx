import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { BookOpenText, CalendarRange, CookingPot, Dices, FolderLock, ShoppingBasket, UtensilsCrossed } from "lucide-react";
import { authClient } from "../lib/auth-client";
import { clearPendingInvite, readPendingInvite } from "../lib/household/pending-invite";
import { normalizeRecipeRef } from "../lib/atproto/recipe-exchange";
import { fetchRecipe } from "../lib/atproto/recipes";
import { listRecentRecipes } from "../lib/recipes-browse";
import { formatDuration, formatPublished } from "../lib/format";
import ButterStick from "../components/ButterStick";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import { Separator } from "#/components/ui/separator";
import { Spinner } from "#/components/ui/spinner";
import type { FormEvent } from "react";
import type { RecipeResult } from "../lib/atproto/recipes";
import type { RecipeCardData } from "../lib/recipes-browse";

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): { auth_error?: string } => (typeof search.auth_error === "string" ? { auth_error: search.auth_error } : {}),
  loader: () => listRecentRecipes(),
  component: App,
});

/**
 * Resume a logged-out invite after the atproto OAuth round-trip (§15). The
 * callback always lands on "/", so if a pending-invite token was stashed before
 * sign-in and a session now exists, forward to the acceptance route. Renders
 * nothing.
 */
function PendingInviteResume() {
  const { data: session, isPending } = authClient.useSession();
  const navigate = useNavigate();
  useEffect(() => {
    if (isPending || !session) return;
    const token = readPendingInvite();
    if (!token) return;
    clearPendingInvite();
    void navigate({ to: "/invite/$token", params: { token } });
  }, [isPending, session, navigate]);
  return null;
}

function App() {
  const recipes = Route.useLoaderData();
  return (
    <div className="page-wrap px-4 pt-10 pb-8 sm:pt-14">
      <PendingInviteResume />
      <section className="rise-in flex flex-col items-start gap-8 sm:flex-row sm:items-center">
        <div className="min-w-0">
          <Badge variant="secondary" className="mb-4">
            A social recipe box on the open web
          </Badge>
          <h1 className="display-title m-0 max-w-2xl text-4xl leading-[1.08] text-foreground sm:text-6xl">
            Good recipes,
            <br />
            spread <span className="text-primary">generously.</span>
          </h1>
          <p className="mt-5 max-w-xl text-base text-muted-foreground sm:text-lg">
            <strong className="text-foreground">but·ter·y</strong> <em>(noun)</em> — a pantry; a room where the good stuff is kept. Buttery keeps your recipes on your own atproto
            account, ready to share with friends — and big and bright on the counter while you cook.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Button size="lg" render={<Link to="/login" />} nativeButton={false}>
              Sign in with atproto
            </Button>
            <Button size="lg" variant="outline" render={<a href="#features" />} nativeButton={false}>
              What's cooking
            </Button>
          </div>
        </div>
        <ButterStick label="A pop-art stick of butter" className="w-52 shrink-0 self-center sm:w-64" />
      </section>

      <div className="mt-12 grid gap-6 lg:grid-cols-2">
        <RecipeLookupCard />
      </div>

      <RecentRecipes recipes={recipes} />

      <section id="features" className="mt-16">
        <h2 className="display-title m-0 text-2xl text-foreground sm:text-3xl">What's in the pantry</h2>
        <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <FeatureCard
            icon={<CookingPot />}
            title="Cook mode"
            highlight
            blurb="The whole point. Recipes rendered huge and glare-proof for the counter — no sleep, no scrolling with buttery thumbs."
          />
          <FeatureCard icon={<FolderLock />} title="Private collections" blurb="Sort recipes into shelves only you (or your chosen few) can open." />
          <FeatureCard icon={<ShoppingBasket />} title="Shopping lists" blurb="Pick recipes, get one consolidated list for the store." />
          <FeatureCard icon={<CalendarRange />} title="Meal planner" blurb="Lay the week out on the table before it starts." />
          <FeatureCard icon={<Dices />} title="Randomizer" blurb="Can't decide? Roll the dice, dinner picks itself." />
          <FeatureCard icon={<BookOpenText />} title="Yours, portably" blurb="Recipes live in your PDS as atproto records. Leave anytime and take the whole pantry." />
        </div>
      </section>
    </div>
  );
}

function RecentRecipes({ recipes }: { recipes: RecipeCardData[] }) {
  if (recipes.length === 0) return null;
  return (
    <section className="mt-16">
      <div className="flex items-end justify-between gap-4">
        <h2 className="display-title m-0 text-2xl text-foreground sm:text-3xl">Fresh from the pantry</h2>
        <p className="m-0 hidden text-sm text-muted-foreground sm:block">The latest recipes shared on the network</p>
      </div>
      <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {recipes.map((recipe) => (
          <RecipeCard key={recipe.id} recipe={recipe} />
        ))}
      </div>
    </section>
  );
}

function RecipeCard({ recipe }: { recipe: RecipeCardData }) {
  return (
    <Card className="group/recipe overflow-hidden p-0 transition-transform hover:-translate-y-0.5">
      <Link to="/recipes/$id" params={{ id: recipe.id }} className="flex h-full flex-col no-underline">
        <div className="aspect-[4/3] w-full overflow-hidden border-b-2 border-border bg-muted">
          {recipe.imageUrl ? (
            <img
              src={recipe.imageUrl}
              alt={recipe.imageAlt ?? recipe.name}
              loading="lazy"
              className="h-full w-full object-cover transition-transform duration-300 group-hover/recipe:scale-[1.03]"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-muted-foreground">
              <UtensilsCrossed className="size-10" aria-hidden />
            </div>
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2 p-4">
          <h3 className="m-0 line-clamp-2 text-base leading-snug font-bold text-foreground">{recipe.name}</h3>
          {recipe.description ? <p className="m-0 line-clamp-2 text-sm text-muted-foreground">{recipe.description}</p> : null}
          <div className="mt-auto flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 pt-1 text-xs text-muted-foreground">
            {recipe.publishedBy ? <span className="truncate font-semibold text-foreground">{recipe.publishedBy}</span> : null}
            {recipe.app ? (
              <span className="truncate">
                via <span className="font-medium text-foreground">{recipe.app}</span>
              </span>
            ) : null}
            {recipe.publishedAt ? (
              <>
                <span aria-hidden>·</span>
                <time dateTime={recipe.publishedAt}>{formatPublished(recipe.publishedAt)}</time>
              </>
            ) : null}
          </div>
        </div>
      </Link>
    </Card>
  );
}

function FeatureCard({ icon, title, blurb, highlight }: { icon: React.ReactNode; title: string; blurb: string; highlight?: boolean }) {
  return (
    <Card className={highlight ? "bg-secondary text-secondary-foreground" : undefined}>
      <CardHeader>
        <CardTitle role="heading" aria-level={3} className="flex items-center gap-2.5 font-bold [&_svg]:size-5 [&_svg]:shrink-0">
          {icon}
          {title}
          {highlight ? (
            <Badge variant="outline" className="ml-auto text-[0.6rem] tracking-wide uppercase">
              priority
            </Badge>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className={`m-0 text-sm ${highlight ? "text-secondary-foreground" : "text-muted-foreground"}`}>{blurb}</p>
      </CardContent>
    </Card>
  );
}

function RecipeLookupCard() {
  const [ref, setRef] = useState("");
  const [recipe, setRecipe] = useState<RecipeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!ref.trim()) return;
    setError(null);
    setPending(true);
    try {
      setRecipe(await fetchRecipe(await normalizeRecipeRef(ref)));
    } catch (err) {
      setRecipe(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="display-title text-xl">
          Fetch a recipe
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit}>
          <FieldGroup>
            <Field data-invalid={error ? true : undefined}>
              <FieldLabel htmlFor="recipe-ref">Recipe id, recipe.exchange URL, or AT-URI</FieldLabel>
              <Input
                id="recipe-ref"
                type="text"
                value={ref}
                onChange={(e) => setRef(e.target.value)}
                placeholder="01JMTK16MTE4AVXYSSTGB5B1TR"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "recipe-ref-error" : undefined}
              />
            </Field>
          </FieldGroup>
          <Button type="submit" variant="secondary" disabled={pending} className="mt-4">
            {pending ? <Spinner data-icon="inline-start" /> : null}
            {pending ? "Fetching…" : "Fetch"}
          </Button>
          {error && (
            <p id="recipe-ref-error" role="alert" className="mt-3 mb-0 text-sm font-semibold text-destructive">
              {error}
            </p>
          )}
        </form>

        {recipe && <RecipeView recipe={recipe} />}
      </CardContent>
    </Card>
  );
}

function RecipeView({ recipe }: { recipe: RecipeResult }) {
  const r = recipe.value;
  const meta = [
    r.recipeCategory && `Category: ${r.recipeCategory}`,
    r.recipeCuisine && `Cuisine: ${r.recipeCuisine}`,
    r.recipeYield && `Yield: ${r.recipeYield}`,
    r.prepTime && `Prep: ${formatDuration(r.prepTime)}`,
    r.cookTime && `Cook: ${formatDuration(r.cookTime)}`,
    r.totalTime && `Total: ${formatDuration(r.totalTime)}`,
  ].filter(Boolean) as Array<string>;

  return (
    <article className="mt-6">
      <Separator className="mb-5" />
      <h3 className="mb-2 text-xl font-bold">{r.name}</h3>
      <p className="mb-1 text-xs text-muted-foreground">
        <code className="break-all">{recipe.uri}</code>
      </p>
      <p className="mb-4 text-sm text-muted-foreground">{r.text}</p>

      {meta.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {meta.map((m) => (
            <Badge key={m} variant="outline">
              {m}
            </Badge>
          ))}
        </div>
      )}

      <h4 className="mb-2 text-sm font-bold">Ingredients</h4>
      <ul className="mb-4 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        {r.ingredients.map((ing, i) => (
          <li key={i}>{ing}</li>
        ))}
      </ul>

      <h4 className="mb-2 text-sm font-bold">Instructions</h4>
      <ol className="m-0 list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
        {r.instructions.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
    </article>
  );
}
