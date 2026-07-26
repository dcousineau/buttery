import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { BookOpenText, CalendarRange, CookingPot, Dices, FolderLock, ShoppingBasket } from "lucide-react";
import { normalizeRecipeRef } from "../lib/atproto/recipe-exchange";
import { fetchRecipe } from "../lib/atproto/recipes";
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

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): { auth_error?: string } => (typeof search.auth_error === "string" ? { auth_error: search.auth_error } : {}),
  component: App,
});

function App() {
  return (
    <div className="page-wrap px-4 pt-10 pb-8 sm:pt-14">
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

/** ISO 8601 duration (PT1H30M) → "1h 30m" */
function formatDuration(iso: string): string {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(iso);
  if (!match) return iso;
  const [, h, m, s] = match;
  return [h && `${h}h`, m && `${m}m`, s && `${s}s`].filter(Boolean).join(" ") || iso;
}
