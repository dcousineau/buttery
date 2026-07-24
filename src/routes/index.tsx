import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { authClient } from "../lib/auth-client";
import { normalizeRecipeRef } from "../lib/atproto/recipe-exchange";
import { fetchRecipe } from "../lib/atproto/recipes";
import type { FormEvent } from "react";
import type { RecipeResult } from "../lib/atproto/recipes";

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): { auth_error?: string } => (typeof search.auth_error === "string" ? { auth_error: search.auth_error } : {}),
  component: App,
});

function App() {
  return (
    <main className="page-wrap px-4 pb-8 pt-14">
      <section className="island-shell rise-in rounded-[2rem] px-6 py-10 sm:px-10 sm:py-12">
        <p className="island-kicker mb-3">Buttery</p>
        <h1 className="display-title mb-4 max-w-3xl text-4xl leading-[1.02] font-bold tracking-tight text-[var(--sea-ink)] sm:text-5xl">Recipes on atproto</h1>
        <p className="m-0 max-w-2xl text-base text-[var(--sea-ink-soft)]">
          Sign in with your atproto account and look up recipes stored in the <code>exchange.recipe.recipe</code> lexicon.
        </p>
      </section>

      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        <LoginCard />
        <RecipeLookupCard />
      </div>
    </main>
  );
}

function LoginCard() {
  const { data: session, isPending } = authClient.useSession();
  const { auth_error: authError } = Route.useSearch();
  const [handle, setHandle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!handle.trim()) return;
    setError(null);
    setPending(true);
    const { data, error: signInError } = await authClient.atproto.signIn({
      handle: handle.trim(),
    });
    if (signInError || !data?.url) {
      setError(signInError?.message ?? "Sign-in failed");
      setPending(false);
      return;
    }
    // Hand the browser to the atproto authorization server; it returns to
    // /api/auth/atproto/callback which sets the session cookie.
    window.location.href = data.url;
  }

  return (
    <section className="island-shell rounded-2xl p-6">
      <p className="island-kicker mb-3">Account</p>
      {isPending ? (
        <p className="m-0 text-sm text-[var(--sea-ink-soft)]">Restoring session…</p>
      ) : session ? (
        <div className="space-y-4">
          <p className="m-0 text-sm text-[var(--sea-ink)]">
            Signed in as <code className="break-all">{session.user.name}</code>
          </p>
          <button
            type="button"
            onClick={() => void authClient.signOut()}
            className="rounded-full border border-[rgba(23,58,64,0.2)] bg-white/50 px-5 py-2.5 text-sm font-semibold text-[var(--sea-ink)] transition hover:-translate-y-0.5 hover:border-[rgba(23,58,64,0.35)]"
          >
            Sign out
          </button>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-3">
          <label className="block text-sm font-semibold text-[var(--sea-ink)]">
            Handle
            <input
              type="text"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              placeholder="alice.bsky.social"
              autoComplete="username"
              className="mt-1.5 w-full rounded-xl border border-[var(--line)] bg-white/60 px-4 py-2.5 text-sm font-normal text-[var(--sea-ink)] outline-none focus:border-[rgba(50,143,151,0.6)]"
            />
          </label>
          <button
            type="submit"
            disabled={pending}
            className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-5 py-2.5 text-sm font-semibold text-[var(--lagoon-deep)] transition hover:-translate-y-0.5 hover:bg-[rgba(79,184,178,0.24)] disabled:opacity-50"
          >
            {pending ? "Redirecting…" : "Sign in with atproto"}
          </button>
          {error && <p className="m-0 text-sm text-red-600">{error}</p>}
          {!error && authError && <p className="m-0 text-sm text-red-600">Sign-in was not completed. Try again.</p>}
        </form>
      )}
    </section>
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
    <section className="island-shell rounded-2xl p-6">
      <p className="island-kicker mb-3">Fetch a Recipe</p>
      <form onSubmit={onSubmit} className="space-y-3">
        <label className="block text-sm font-semibold text-[var(--sea-ink)]">
          Recipe id, recipe.exchange URL, or AT-URI
          <input
            type="text"
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            placeholder="01JMTK16MTE4AVXYSSTGB5B1TR"
            className="mt-1.5 w-full rounded-xl border border-[var(--line)] bg-white/60 px-4 py-2.5 text-sm font-normal text-[var(--sea-ink)] outline-none focus:border-[rgba(50,143,151,0.6)]"
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-5 py-2.5 text-sm font-semibold text-[var(--lagoon-deep)] transition hover:-translate-y-0.5 hover:bg-[rgba(79,184,178,0.24)] disabled:opacity-50"
        >
          {pending ? "Fetching…" : "Fetch"}
        </button>
        {error && <p className="m-0 text-sm text-red-600">{error}</p>}
      </form>

      {recipe && <RecipeView recipe={recipe} />}
    </section>
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
    <article className="mt-6 border-t border-[var(--line)] pt-5">
      <h2 className="mb-2 text-xl font-bold text-[var(--sea-ink)]">{r.name}</h2>
      <p className="mb-1 text-xs text-[var(--sea-ink-soft)]">
        <code className="break-all">{recipe.uri}</code>
      </p>
      <p className="mb-4 text-sm text-[var(--sea-ink-soft)]">{r.text}</p>

      {meta.length > 0 && (
        <ul className="mb-4 flex flex-wrap gap-2 pl-0">
          {meta.map((m) => (
            <li key={m} className="list-none rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 py-1 text-xs text-[var(--sea-ink)]">
              {m}
            </li>
          ))}
        </ul>
      )}

      <h3 className="mb-2 text-sm font-semibold text-[var(--sea-ink)]">Ingredients</h3>
      <ul className="mb-4 list-disc space-y-1 pl-5 text-sm text-[var(--sea-ink-soft)]">
        {r.ingredients.map((ing, i) => (
          <li key={i}>{ing}</li>
        ))}
      </ul>

      <h3 className="mb-2 text-sm font-semibold text-[var(--sea-ink)]">Instructions</h3>
      <ol className="m-0 list-decimal space-y-2 pl-5 text-sm text-[var(--sea-ink-soft)]">
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
