import { createFileRoute, Link } from "@tanstack/react-router";
import { AtSign, CalendarRange, Check, CookingPot, Dices, FolderLock, ShoppingBasket, UtensilsCrossed } from "lucide-react";
import { listRecentRecipes, type RecipeCardData, resolveHomeRedirect } from "#/lib/api";
import { MetaRow, PublisherLink } from "#/components/recipes/RecipeMeta";
import { SourceLink } from "#/components/recipes/SourceLink";
import { formatPublished } from "../lib/format";
import ButterStick from "../components/ButterStick";
import AtprotoProviderCycle from "../components/AtprotoProviderCycle";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): { auth_error?: string } => (typeof search.auth_error === "string" ? { auth_error: search.auth_error } : {}),
  // Server-side landing decision (see resolveHomeRedirect): a signed-in caller is
  // routed into the app before this page renders — the OAuth callback lands here,
  // so this is the post-login pivot. Signed-out callers fall through to marketing.
  beforeLoad: () => resolveHomeRedirect(),
  loader: () => listRecentRecipes(),
  component: App,
});

function App() {
  const recipes = Route.useLoaderData();
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
              <AtprotoProviderCycle className="ml-1.5" />
            </Button>
            <Button size="lg" variant="outline" render={<a href="#features" />} nativeButton={false}>
              What's cooking
            </Button>
          </div>
        </div>
        <ButterStick label="A pop-art stick of butter" className="w-52 shrink-0 self-center sm:w-64" />
      </section>

      <RecentRecipes recipes={recipes} />

      <section id="features" className="mt-16">
        <h2 className="display-title m-0 text-2xl text-foreground sm:text-3xl">Stocking the pantry</h2>
        <p className="mt-3 max-w-xl text-sm text-muted-foreground sm:text-base">
          Buttery is still under development. Some of this is already on the shelf and ready to use; the rest is where we&rsquo;re headed.
        </p>
        <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <FeatureCard
            icon={<AtSign />}
            title="Built on atproto"
            status="ready"
            blurb="Recipes live as atproto records in the atmosphere — yours to keep, yours to take anywhere."
          />
          <FeatureCard
            icon={<CookingPot />}
            title="Cook mode"
            status="ready"
            blurb="The whole point. Recipes rendered huge and glare-proof for the counter — no sleep, no scrolling with buttery thumbs."
          />
          <FeatureCard icon={<CalendarRange />} title="Meal planner" status="ready" blurb="Lay the week out on the table before it starts." />
          <FeatureCard
            icon={<ShoppingBasket />}
            title="Shopping list"
            status="ready"
            blurb="Send a recipe or the whole week to one running household list — duplicates merged, grouped by aisle for the store."
          />
          <FeatureCard icon={<Dices />} title="Randomizer" status="development" blurb="Can't decide? Roll the dice, dinner picks itself." />
          <FeatureCard icon={<FolderLock />} title="Private collections" blurb="Sort recipes into collections only you (or your chosen few) can open." />
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
    // The byline sits outside the card-wide link rather than inside it: its
    // source and publisher segments are links of their own, and an anchor cannot
    // nest in an anchor.
    <Card className="group/recipe flex flex-col overflow-hidden p-0 transition-transform hover:-translate-y-0.5">
      <Link to="/recipes/$id" params={{ id: recipe.id }} className="flex flex-1 flex-col no-underline">
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
        <div className="flex min-w-0 flex-1 flex-col gap-2 p-4 pb-2">
          <h3 className="m-0 line-clamp-2 text-base leading-snug font-bold text-foreground">{recipe.name}</h3>
          {recipe.description ? <p className="m-0 line-clamp-2 text-sm text-muted-foreground">{recipe.description}</p> : null}
        </div>
      </Link>
      <MetaRow className="min-w-0 px-4 pb-4 text-xs text-muted-foreground">
        {recipe.source && <SourceLink source={recipe.source} className="min-w-0 truncate" />}
        {recipe.publishedBy && <PublisherLink handle={recipe.publishedBy} url={recipe.publisherUrl} className="min-w-0 truncate" />}
        {recipe.publishedAt && <time dateTime={recipe.publishedAt}>{formatPublished(recipe.publishedAt)}</time>}
      </MetaRow>
    </Card>
  );
}

function FeatureCard({ icon, title, blurb, status = "planned" }: { icon: React.ReactNode; title: string; blurb: string; status?: "ready" | "development" | "planned" }) {
  const ready = status === "ready";
  const label = status === "ready" ? "ready" : status === "development" ? "in development" : "planned";
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={3} className="flex items-center gap-2.5 font-bold [&_svg]:size-5 [&_svg]:shrink-0">
          {icon}
          {title}
          <Badge variant="outline" className="ml-auto gap-1 text-[0.6rem] tracking-wide uppercase [&_svg]:size-3">
            {ready ? <Check aria-hidden /> : null}
            {label}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="m-0 text-sm text-muted-foreground">{blurb}</p>
      </CardContent>
    </Card>
  );
}
