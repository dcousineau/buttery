import { createFileRoute } from "@tanstack/react-router";

/**
 * `GET /api/recipe-image/:recipeId` — a draft's hero, served from our bucket.
 *
 * The read half of the invariant. A published recipe's image is an atproto blob
 * and renders from a CDN (`lib/atproto/images.ts`); everything before publish
 * renders from here. There is deliberately no third case: the detail payload
 * used to fall back to `recipe_pending_image.source_url`, so a private draft's
 * photo was an `<img src>` pointing at the site it was imported from — a
 * hotlink from our page, a referer leak to that host on every view, and an
 * image that vanished the day they moved it. That column is gone.
 *
 * A proxy rather than a presigned URL: the object is private household data, a
 * presigned URL is a bearer token in a query string that outlives the page it
 * was minted for, and this way the bucket needs no public reachability at all.
 * The images are ≤1 MB by the lexicon's cap, so the round trip through the
 * server is bounded by construction.
 *
 * Authorization is the same shape as every other household read: the recipe has
 * to be in the caller's active household's box. An id the caller cannot see is
 * a 404, never a 403 — a 403 would confirm the recipe exists.
 */

function problem(status: number, message: string): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store" },
  });
}

async function handler({ request, params }: { request: Request; params: { recipeId: string } }): Promise<Response> {
  const { getServerSession } = await import("#/server/household/session");
  const { assertMember } = await import("#/server/authz");
  const { readPendingImage } = await import("#/server/recipe-images");
  const { getDb } = await import("#/lib/db");

  const session = await getServerSession(request);
  const did = session?.user.did ?? null;
  if (!did) return problem(401, "Sign in to view this photo.");
  const householdId = session?.session.active_household_id ?? null;
  if (!householdId) return problem(403, "No active household.");

  try {
    await assertMember(did, householdId);
  } catch {
    return problem(403, "You are not a member of this household.");
  }

  // Recipe ids ARE atproto rkeys, so they are never shape-validated — a regex
  // that looks reasonable rejects real ids. The box membership check below is
  // the only thing that decides, and it is a plain equality on an id the
  // database either holds or does not.
  const recipeId = params.recipeId;

  const db = getDb();
  const boxed = await db.selectFrom("household_recipe").select("recipe_id").where("household_id", "=", householdId).where("recipe_id", "=", recipeId).executeTakeFirst();
  if (!boxed) return problem(404, "No photo here.");

  const image = await readPendingImage(db, recipeId);
  if (!image) return problem(404, "No photo here.");

  return new Response(image.bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "content-type": image.mime,
      "content-length": String(image.bytes.byteLength),
      // Private household data — a shared cache must never hold it. The short
      // private max-age keeps a recipe page's own re-renders off the bucket
      // without outliving a photo the user just replaced.
      "cache-control": "private, max-age=300",
      // The bytes are user-supplied and served from our own origin, so pin how
      // they may be interpreted: the sniffed mime and nothing else.
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
    },
  });
}

export const Route = createFileRoute("/api/recipe-image/$recipeId")({
  server: {
    handlers: {
      GET: handler,
    },
  },
});
