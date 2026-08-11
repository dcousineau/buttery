import { createFileRoute } from "@tanstack/react-router";

/**
 * Per-recipe Open Graph card: `GET /recipes/$id/og.png` → a 1200×630 PNG.
 *
 * Social scrapers won't run our app, so `og:image` has to be a real image URL
 * they can fetch anonymously. This renders one on demand from the recipe's own
 * data (title, source, a few facts) instead of shipping a single static card
 * for every link.
 *
 * The filename's trailing underscore — `recipes.$id_.og[.]png` — opts this route
 * out of nesting: without it, TanStack Router would read `/recipes/$id` as a
 * shared parent segment and turn `recipes.$id.tsx` into a layout route that has
 * to render an `<Outlet />`. The underscore keeps the recipe page a leaf and
 * makes this a sibling that happens to share the URL prefix. The `[.]` escape
 * is the usual "this dot is part of the path, not a route separator" marker,
 * same as `oauth-client-metadata[.]json.ts`.
 *
 * Everything server-only (the DB-backed loader, satori/resvg, ioredis) is pulled
 * in with dynamic `import()` inside the handler, matching the other server
 * routes — none of it should be reachable from the client bundle.
 */

/** Cached PNGs live for 30 days; a miss is cheap and a stale key is impossible. */
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30;

/**
 * Cache key for a rendered card. The fingerprint of the *model* is part of the
 * key, so editing a recipe changes the key and the next request simply misses
 * and re-renders. There is deliberately no invalidation path to get wrong —
 * superseded entries just age out on their TTL.
 */
function cacheKey(id: string, fingerprint: string): string {
  return `og:recipe:${id}:${fingerprint}`;
}

/**
 * Read a previously rendered PNG, or null.
 *
 * `getRedis()` throws outright when `REDIS_URL` is unset, which is the normal
 * state of a local dev environment, so both cache helpers treat Redis as a pure
 * optimisation: any missing config or transport error degrades to "render every
 * time" rather than failing the request. `getBuffer` (not `get`) because ioredis
 * decodes replies as UTF-8 strings by default, which would corrupt PNG bytes.
 */
async function readCachedPng(key: string): Promise<Buffer | null> {
  if (!process.env.REDIS_URL) return null;
  try {
    const { getRedis } = await import("#/lib/redis");
    return await getRedis().getBuffer(key);
  } catch (err) {
    console.warn("[og] cache read failed", err);
    return null;
  }
}

/** Store a rendered PNG. Failures are logged and ignored — see `readCachedPng`. */
async function writeCachedPng(key: string, png: Buffer): Promise<void> {
  if (!process.env.REDIS_URL) return;
  try {
    const { getRedis } = await import("#/lib/redis");
    await getRedis().set(key, png, "EX", CACHE_TTL_SECONDS);
  } catch (err) {
    console.warn("[og] cache write failed", err);
  }
}

/**
 * Caching headers shared by the 200 and the 304.
 *
 * The aggressive policy is conditional on the URL carrying a `?v=` token, which
 * the recipe page always stamps on (`recipeOgVersion` — a hash of the very model
 * this image is drawn from). A versioned URL identifies immutable content by
 * construction: edit the recipe and the page emits a *different* URL, so a year
 * of `immutable` costs nothing and there is no purge step to forget. That is what
 * makes a CDN, and every scraper's own cache, hold the card instead of coming
 * back to us — the whole point of generating it once.
 *
 * A bare URL (someone typed it, or an old share predates the token) can't make
 * that promise, so it gets a conservative TTL and revalidates against the ETag.
 * `stale-while-revalidate` + `stale-if-error` keep a shared cache serving the old
 * card while it refreshes, or while we are down, rather than showing a scraper
 * nothing.
 */
const YEAR = 31_536_000;
const IMMUTABLE_CACHE_CONTROL = `public, max-age=${YEAR}, s-maxage=${YEAR}, immutable, stale-while-revalidate=${YEAR}, stale-if-error=${YEAR}`;
const REVALIDATING_CACHE_CONTROL = "public, max-age=300, s-maxage=86400, stale-while-revalidate=604800, stale-if-error=604800";

function imageHeaders(etag: string, versioned: boolean): Record<string, string> {
  return {
    etag,
    "cache-control": versioned ? IMMUTABLE_CACHE_CONTROL : REVALIDATING_CACHE_CONTROL,
    // Nothing here varies by cookie, session or accept header: the card is the
    // same public image for every caller. Said out loud so an intermediary
    // doesn't invent a narrower cache key on its own.
    vary: "Accept-Encoding",
  };
}

/** Does the client already hold this exact card? `If-None-Match` is a list, and
 * an intermediary may have weakened the tag, so compare the entity-tags loosely. */
function matchesEtag(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === "*") return true;
  return ifNoneMatch.split(",").some((candidate) => candidate.trim().replace(/^W\//, "") === etag);
}

async function handler({ request, params }: { request: Request; params: { id: string } }): Promise<Response> {
  const { getRecipe } = await import("#/server/recipes");

  // `params.id` is an atproto rkey: hyphens, dots, tildes and 512 characters are
  // all legal, so there is no shape to validate against — a regex here would
  // reject real ids. The id goes to the loader untouched and the database is the
  // only authority on whether it exists.
  //
  // The one bound worth pre-checking is the loader's own length cap (its abuse
  // guard, not a format check): letting `getRecipe` throw on it would surface as
  // a 500 to a crawler, and "that can't be a recipe" is a 404.
  const id = params.id;
  const recipe = id.length > 0 && id.length <= 512 ? await getRecipe({ data: id }) : null;

  if (!recipe) {
    // A short TTL rather than `no-store`: unknown ids are usually typos or
    // deleted records, but a recipe can also be indexed moments later.
    return new Response("Not found\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=60" },
    });
  }

  const { recipeOgModel, recipeOgFingerprint, recipeOgVersion, renderRecipeOgPng } = await import("#/server/og/recipe-og");
  const model = recipeOgModel(recipe);
  const fingerprint = recipeOgFingerprint(model);
  const etag = `"${fingerprint}"`;

  // Only a token that matches *this* recipe's current model earns the immutable
  // policy. A stale `?v=` from an old share is still a perfectly good request —
  // it just gets the revalidating policy, so the reader sees the updated card
  // rather than being locked to a URL whose content moved on underneath it.
  const versioned = new URL(request.url).searchParams.get("v") === recipeOgVersion(model);

  if (matchesEtag(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers: imageHeaders(etag, versioned) });
  }

  try {
    const key = cacheKey(recipe.id, fingerprint);
    const cached = await readCachedPng(key);
    const png: Buffer = cached ?? (await renderRecipeOgPng(model));
    if (!cached) await writeCachedPng(key, png);

    return new Response(new Uint8Array(png), {
      status: 200,
      headers: {
        ...imageHeaders(etag, versioned),
        "content-type": "image/png",
        "content-length": String(png.byteLength),
      },
    });
  } catch (err) {
    // Rendering is the one genuinely fragile step (font loading, remote hero
    // images, satori choking on odd text). A crawler that gets a 500 caches the
    // failure and shows a bare link, so fall back to the site-wide static card
    // instead: the share still looks intentional, and we get a log line.
    console.warn("[og] render failed, falling back to the static card", err);
    return new Response(null, {
      status: 302,
      headers: { location: "/og-image.png", "cache-control": "public, max-age=60" },
    });
  }
}

export const Route = createFileRoute("/recipes/$id_/og.png")({
  server: {
    handlers: {
      GET: handler,
    },
  },
});
