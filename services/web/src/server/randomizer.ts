import { createServerFn } from "@tanstack/react-start";
import type { Kysely } from "kysely";
import type { DB } from "#/db/types";
import { blobImageUrl } from "#/lib/atproto/images";
import { deriveSource, prettify } from "./recipe-provenance";

/**
 * The meal randomizer's one server function (plan `2026-08-03-meal-randomizer`
 * §4): applies every filter server-side over the household box (or, opt-in,
 * the public corpus) and returns the eligible lightweight pool. The client
 * owns the actual draw / re-roll / no-repeat (§5) — rolls never hit the
 * server.
 *
 * Sibling module to `household-recipes.ts` rather than an addition to it (the
 * plan explicitly allows this) — same auth pattern, same dynamic-import
 * style so this file stays safe to reference from the client bundle.
 */

// --- shared shapes ------------------------------------------------------

export interface RandomizerCard {
  recipeId: string;
  title: string;
  thumbUrl: string | null;
  sourceLabel: string;
  sourceUrl: string | null;
  totalTimeDisplay: string | null;
}

export interface RandomizerFacetOption {
  slug: string;
  label: string;
}

export interface GetRandomizerPoolInput {
  cuisine?: string;
  category?: string;
  maxCookMinutes?: number;
  includeUntimed?: boolean;
  ingredient?: string;
  source?: "box" | "corpus"; // default "box"
}

export interface GetRandomizerPoolResult {
  pool: RandomizerCard[];
  facets: {
    cuisines: RandomizerFacetOption[];
    categories: RandomizerFacetOption[];
  };
  /** true only when `source === "corpus"` and the 200-row cap was hit. */
  cappedAtLimit: boolean;
}

const CORPUS_LIMIT = 200;

// --- helpers ------------------------------------------------------------

/**
 * total_time_seconds → display string ("1h 30m" / "45m"), null for absent.
 * Copied from `household-recipes.ts`'s private `minutesDisplay` (~8 lines,
 * not exported there — duplicating matches that module's own precedent of
 * not sharing `activeContext`/helpers across sibling server modules).
 */
function totalTimeDisplay(totalSeconds: number | null | undefined): string | null {
  if (!totalSeconds || totalSeconds <= 0) return null;
  const minutes = Math.round(totalSeconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

/** Opaque slug-ish string: trimmed, capped defensively, empty → undefined. */
function cleanSlug(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim().slice(0, 100);
  return trimmed.length ? trimmed : undefined;
}

/**
 * Resolve `{ did, householdId }` for a household-scoped handler: the caller
 * DID from the validated session, the active household from the session
 * (never a client argument). Throws `NotAMemberError` when there is no active
 * household. Duplicated from `household-recipes.ts:123-133` — that helper
 * isn't exported there, matching the codebase's own precedent of not sharing
 * it across sibling server modules.
 */
async function activeContext(): Promise<{ did: string; householdId: string }> {
  const { getServerSession } = await import("./household/session");
  const { NotAMemberError } = await import("./household/errors");
  const { redirect } = await import("@tanstack/react-router");
  const session = await getServerSession();
  const did = session?.user.did ?? null;
  if (!did) throw redirect({ to: "/login" });
  const householdId = session?.session.active_household_id ?? null;
  if (!householdId) throw new NotAMemberError();
  return { did, householdId };
}

/** The validator's clamped/coerced output — the shape `computeRandomizerPool` consumes. */
export interface ValidatedRandomizerInput {
  cuisine?: string;
  category?: string;
  maxCookMinutes?: number;
  includeUntimed: boolean;
  ingredient?: string;
  source: "box" | "corpus";
}

/** Validate/clamp raw client input (see plan §4.1). Exported for the DB tests. */
export function validateRandomizerInput(data: GetRandomizerPoolInput): ValidatedRandomizerInput {
  const cuisine = cleanSlug(data?.cuisine);
  const category = cleanSlug(data?.category);
  const maxCookMinutesRaw = Number(data?.maxCookMinutes);
  const maxCookMinutes = data?.maxCookMinutes != null && Number.isFinite(maxCookMinutesRaw) && maxCookMinutesRaw > 0 ? maxCookMinutesRaw : undefined;
  const includeUntimed = Boolean(data?.includeUntimed);
  const ingredient = typeof data?.ingredient === "string" ? data.ingredient.trim().slice(0, 200) || undefined : undefined;
  const source: "box" | "corpus" = data?.source === "corpus" ? "corpus" : "box";
  return { cuisine, category, maxCookMinutes, includeUntimed, ingredient, source };
}

// --- §4 getRandomizerPool -------------------------------------------------

/**
 * The actual query logic (§4.2 box query / §4.4 corpus query + §4 facets),
 * factored out of the `createServerFn` handler so it can be exercised
 * directly by DB-backed tests: `createServerFn`-wrapped functions require the
 * TanStack Start runtime's `AsyncLocalStorage` context to invoke at all (no
 * harness for that exists in this repo's vitest setup — see
 * `randomizer.db.test.ts`'s header comment), so the handler below is a thin
 * auth-gate + delegate and this is where the real behavior — and its test
 * coverage — lives. `did`/`householdId` MUST come from the validated session
 * (`activeContext()`), never a client argument.
 */
export async function computeRandomizerPool(db: Kysely<DB>, did: string, householdId: string, input: ValidatedRandomizerInput): Promise<GetRandomizerPoolResult> {
  const { householdScopedQuery } = await import("./household/scoped-query");
  const { cuisine, category, maxCookMinutes, includeUntimed, ingredient, source } = input;

  // Facets are ALWAYS computed from the full box, regardless of the current
  // filters/source, so the filter selects never shrink/disappear (plan §4).
  const facetRows = await householdScopedQuery(db, did, householdId)
    .innerJoin("household_recipe as hr", "hr.household_id", "hm.household_id")
    .innerJoin("recipe as r", "r.id", "hr.recipe_id")
    .select(["r.recipe_cuisine as recipe_cuisine", "r.recipe_category as recipe_category"])
    .distinct()
    .execute();
  const cuisineSlugs = new Set<string>();
  const categorySlugs = new Set<string>();
  for (const row of facetRows) {
    if (row.recipe_cuisine) cuisineSlugs.add(row.recipe_cuisine);
    if (row.recipe_category) categorySlugs.add(row.recipe_category);
  }
  const toOptions = (slugs: Set<string>): RandomizerFacetOption[] =>
    [...slugs].map((slug) => ({ slug, label: prettify(slug) ?? slug })).sort((a, b) => a.label.localeCompare(b.label));

  let cappedAtLimit = false;
  let rows: Array<{
    id: string;
    name: string;
    origin: string;
    did: string | null;
    total_time_seconds: number | null;
    blob_cid: string | null;
    blob_mime: string | null;
    attr_display_name: string | null;
    attr_author: string | null;
    attr_publisher: string | null;
    attr_url: string | null;
    repo_handle: string | null;
  }>;

  if (source === "box") {
    rows = await householdScopedQuery(db, did, householdId)
      .innerJoin("household_recipe as hr", "hr.household_id", "hm.household_id")
      .innerJoin("recipe as r", "r.id", "hr.recipe_id")
      .leftJoin("recipe_image as img", (join) => join.onRef("img.recipe_id", "=", "r.id").on("img.ordinal", "=", 0))
      .leftJoin("recipe_attribution as attr", "attr.recipe_id", "r.id")
      .leftJoin("atproto_repo as repo", "repo.did", "r.did")
      .$if(!!cuisine, (q) => q.where("r.recipe_cuisine", "=", cuisine as string))
      .$if(!!category, (q) => q.where("r.recipe_category", "=", category as string))
      .$if(maxCookMinutes != null, (q) =>
        includeUntimed
          ? q.where((eb) => eb.or([eb("r.total_time_seconds", "<=", (maxCookMinutes as number) * 60), eb("r.total_time_seconds", "is", null)]))
          : q.where("r.total_time_seconds", "<=", (maxCookMinutes as number) * 60),
      )
      .$if(!!ingredient, (q) =>
        q.where((eb) =>
          eb.exists(eb.selectFrom("recipe_ingredient as ri").whereRef("ri.recipe_id", "=", "r.id").where("ri.text", "ilike", `%${ingredient}%`).select("ri.recipe_id")),
        ),
      )
      .select([
        "r.id as id",
        "r.name as name",
        "r.origin as origin",
        "r.did as did",
        "r.total_time_seconds as total_time_seconds",
        "img.blob_cid as blob_cid",
        "img.blob_mime as blob_mime",
        "attr.display_name as attr_display_name",
        "attr.author as attr_author",
        "attr.publisher as attr_publisher",
        "attr.url as attr_url",
        "repo.handle as repo_handle",
      ])
      .execute();
  } else {
    // Corpus widening (§4.4): public recipes, left-anti-joined against the
    // box so already-boxed recipes don't reappear. Still gated on
    // activeContext() (authenticated + active household) even though it
    // reads the public corpus — matches searchGlobalRecipes.
    const capped = await db
      .selectFrom("recipe as r")
      .leftJoin("recipe_image as img", (join) => join.onRef("img.recipe_id", "=", "r.id").on("img.ordinal", "=", 0))
      .leftJoin("recipe_attribution as attr", "attr.recipe_id", "r.id")
      .leftJoin("atproto_repo as repo", "repo.did", "r.did")
      .where("r.visibility", "=", "public")
      .where((eb) =>
        eb.not(eb.exists(eb.selectFrom("household_recipe as hr").select("hr.recipe_id").whereRef("hr.recipe_id", "=", "r.id").where("hr.household_id", "=", householdId))),
      )
      .$if(!!cuisine, (q) => q.where("r.recipe_cuisine", "=", cuisine as string))
      .$if(!!category, (q) => q.where("r.recipe_category", "=", category as string))
      .$if(maxCookMinutes != null, (q) =>
        includeUntimed
          ? q.where((eb) => eb.or([eb("r.total_time_seconds", "<=", (maxCookMinutes as number) * 60), eb("r.total_time_seconds", "is", null)]))
          : q.where("r.total_time_seconds", "<=", (maxCookMinutes as number) * 60),
      )
      .$if(!!ingredient, (q) =>
        q.where((eb) =>
          eb.exists(eb.selectFrom("recipe_ingredient as ri").whereRef("ri.recipe_id", "=", "r.id").where("ri.text", "ilike", `%${ingredient}%`).select("ri.recipe_id")),
        ),
      )
      .select([
        "r.id as id",
        "r.name as name",
        "r.origin as origin",
        "r.did as did",
        "r.total_time_seconds as total_time_seconds",
        "img.blob_cid as blob_cid",
        "img.blob_mime as blob_mime",
        "attr.display_name as attr_display_name",
        "attr.author as attr_author",
        "attr.publisher as attr_publisher",
        "attr.url as attr_url",
        "repo.handle as repo_handle",
      ])
      .limit(CORPUS_LIMIT + 1)
      .execute();
    cappedAtLimit = capped.length > CORPUS_LIMIT;
    rows = cappedAtLimit ? capped.slice(0, CORPUS_LIMIT) : capped;
  }

  const pool: RandomizerCard[] = rows.map((row) => {
    const rowSource = deriveSource({
      origin: row.origin,
      id: row.id,
      repoHandle: row.repo_handle,
      attrDisplayName: row.attr_display_name,
      attrAuthor: row.attr_author,
      attrPublisher: row.attr_publisher,
      attrUrl: row.attr_url,
    });
    return {
      recipeId: row.id,
      title: row.name,
      thumbUrl: row.did && row.blob_cid ? blobImageUrl(row.did, row.blob_cid, row.blob_mime, "feed_thumbnail") : null,
      sourceLabel: rowSource.label,
      sourceUrl: rowSource.url,
      totalTimeDisplay: totalTimeDisplay(row.total_time_seconds),
    };
  });

  return {
    pool,
    facets: {
      cuisines: toOptions(cuisineSlugs),
      categories: toOptions(categorySlugs),
    },
    cappedAtLimit,
  };
}

/**
 * Thin auth-gate + delegate: resolves the validated `{ did, householdId }`
 * from the session (never a client argument) and hands off to
 * {@link computeRandomizerPool} for the actual query logic.
 */
export const getRandomizerPool = createServerFn({ method: "GET" })
  .validator((data: GetRandomizerPoolInput) => validateRandomizerInput(data))
  .handler(async ({ data }): Promise<GetRandomizerPoolResult> => {
    const { getDb } = await import("#/lib/db");
    const { did, householdId } = await activeContext();
    return computeRandomizerPool(getDb(), did, householdId, data);
  });
