import { type Kysely, sql } from "kysely";
import { snakeCase, startCase } from "es-toolkit";

/**
 * The "rendered" recipe layer — the normalized, search-optimized projection of
 * validated recipe records. Where `atproto_collection_recipe` is lossless raw
 * storage keyed on `(did, rkey)`, these tables are the app's canonical recipe
 * model that both the web app (browse/search) and — eventually — local
 * authoring read and write. See `docs/plans/01-atproto-cron-sync-service.md`.
 *
 * Tables (7):
 *   - `recipe`               — one row per live, valid recipe
 *   - `recipe_search`        — 1:1 weighted tsvector (isolates heavy GIN)
 *   - `recipe_ingredient`    — ordered ingredient lines
 *   - `recipe_instruction`   — ordered instruction steps
 *   - `recipe_image`         — embedded image blob refs
 *   - `recipe_keyword`       — tags (open vocab; faceting)
 *   - `recipe_attribution`   — 1:1 flattened attribution union
 *
 * Identity: `recipe.id` is the recipe's ULID. For records synced from the
 * network it is the atproto `rkey` (recipe.exchange rkeys are ULIDs); for
 * locally-authored recipes it is a locally minted ULID that becomes the `rkey`
 * on publish — so the id survives the private → public transition unchanged.
 *
 * Lifecycle: `origin` ('sync' | 'local') decides who owns a row. The cron sync
 * service writes/reconciles ONLY `origin = 'sync'` rows; local draft/private
 * recipes (`origin = 'local'`, authored web-side) are never touched by it
 * beyond a cid/rev reconcile once they are published to the network.
 * `visibility` ('draft' | 'private' | 'public') gates read access per viewer.
 * Household ownership of local recipes is deferred to the households feature.
 *
 * `Kysely<any>` is intentional: migrations are frozen in time and must not
 * track the evolving `DB` interface (matches the initial migration).
 */

const now = sql`now()`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  // Fuzzy / substring matching on recipe names (search complement to tsvector).
  await sql`create extension if not exists pg_trgm`.execute(db);

  // --- recipe -----------------------------------------------------------
  await db.schema
    .createTable("recipe")
    // ULID: the rkey for synced records, a minted ULID for local ones.
    .addColumn("id", "text", (col) => col.primaryKey())
    // Ownership / lifecycle.
    .addColumn("origin", "text", (col) => col.notNull()) // 'sync' | 'local'
    .addColumn("visibility", "text", (col) => col.notNull().defaultTo("public")) // 'draft' | 'private' | 'public'
    // atproto identity — null until published to the network.
    .addColumn("did", "text")
    .addColumn("rkey", "text")
    .addColumn("uri", "text")
    .addColumn("cid", "text")
    .addColumn("rev", "text") // render/reconcile guard
    // Projected content.
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("description", "text") // record.text
    .addColumn("recipe_yield", "text")
    .addColumn("prep_time", "text") // raw ISO-8601 duration string (lossless)
    .addColumn("cook_time", "text")
    .addColumn("total_time", "text")
    .addColumn("prep_time_seconds", "integer") // parsed — sort / range filter
    .addColumn("cook_time_seconds", "integer")
    .addColumn("total_time_seconds", "integer")
    .addColumn("cooking_method", "text") // single token
    .addColumn("recipe_cuisine", "text") // single token
    .addColumn("recipe_category", "text") // single token
    .addColumn("suitable_for_diet", sql`text[]`) // small closed-vocab tokens
    // Nutrition, inlined 1:1.
    .addColumn("calories", "integer")
    .addColumn("fat_content", "numeric")
    .addColumn("protein_content", "numeric")
    .addColumn("carbohydrate_content", "numeric")
    // Timestamps.
    .addColumn("published_at", "timestamptz") // private → public transition
    .addColumn("record_created_at", "timestamptz") // authored (record.createdAt)
    .addColumn("record_updated_at", "timestamptz")
    .addColumn("indexed_at", "timestamptz", (col) => col.notNull().defaultTo(now))
    .execute();

  // atproto identity is unique when present; local drafts have null did/rkey.
  await sql`
    create unique index recipe_did_rkey_key
      on recipe (did, rkey)
      where did is not null
  `.execute(db);

  // Fuzzy name search.
  await sql`
    create index recipe_name_trgm_idx
      on recipe using gin (name gin_trgm_ops)
  `.execute(db);

  // Facet / filter columns.
  await db.schema.createIndex("recipe_cuisine_idx").on("recipe").column("recipe_cuisine").execute();
  await db.schema.createIndex("recipe_category_idx").on("recipe").column("recipe_category").execute();
  await db.schema.createIndex("recipe_cooking_method_idx").on("recipe").column("cooking_method").execute();
  await db.schema.createIndex("recipe_record_created_at_idx").on("recipe").column("record_created_at").execute();
  await db.schema.createIndex("recipe_visibility_idx").on("recipe").column("visibility").execute();
  // Cron reconciliation scopes on origin.
  await db.schema.createIndex("recipe_origin_idx").on("recipe").column("origin").execute();
  // Multi-value diet tokens.
  await sql`create index recipe_suitable_for_diet_idx on recipe using gin (suitable_for_diet)`.execute(db);

  // --- recipe_search ----------------------------------------------------
  // 1:1 weighted tsvector, split off so the heavy GIN never bloats the hot
  // recipe row. Composed by the writer (A=name, B=keywords/cuisine/category/
  // method/attribution, C=ingredients, D=description/instructions).
  await db.schema
    .createTable("recipe_search")
    .addColumn("recipe_id", "text", (col) => col.primaryKey().references("recipe.id").onDelete("cascade"))
    .addColumn("search_tsv", sql`tsvector`, (col) => col.notNull())
    .execute();

  await sql`create index recipe_search_tsv_idx on recipe_search using gin (search_tsv)`.execute(db);

  // --- recipe_ingredient ------------------------------------------------
  await db.schema
    .createTable("recipe_ingredient")
    .addColumn("recipe_id", "text", (col) => col.notNull().references("recipe.id").onDelete("cascade"))
    .addColumn("ordinal", "integer", (col) => col.notNull())
    .addColumn("text", "text", (col) => col.notNull())
    .addPrimaryKeyConstraint("recipe_ingredient_pkey", ["recipe_id", "ordinal"])
    .execute();

  // --- recipe_instruction -----------------------------------------------
  await db.schema
    .createTable("recipe_instruction")
    .addColumn("recipe_id", "text", (col) => col.notNull().references("recipe.id").onDelete("cascade"))
    .addColumn("ordinal", "integer", (col) => col.notNull())
    .addColumn("text", "text", (col) => col.notNull())
    .addPrimaryKeyConstraint("recipe_instruction_pkey", ["recipe_id", "ordinal"])
    .execute();

  // --- recipe_image -----------------------------------------------------
  // Blob refs only; CDN / getBlob resolution is a web read-path concern.
  await db.schema
    .createTable("recipe_image")
    .addColumn("recipe_id", "text", (col) => col.notNull().references("recipe.id").onDelete("cascade"))
    .addColumn("ordinal", "integer", (col) => col.notNull())
    .addColumn("alt", "text")
    .addColumn("blob_cid", "text")
    .addColumn("blob_mime", "text")
    .addColumn("blob_size", "integer")
    .addColumn("aspect_w", "integer")
    .addColumn("aspect_h", "integer")
    .addPrimaryKeyConstraint("recipe_image_pkey", ["recipe_id", "ordinal"])
    .execute();

  // --- recipe_keyword ---------------------------------------------------
  await db.schema
    .createTable("recipe_keyword")
    .addColumn("recipe_id", "text", (col) => col.notNull().references("recipe.id").onDelete("cascade"))
    .addColumn("keyword", "text", (col) => col.notNull())
    .addPrimaryKeyConstraint("recipe_keyword_pkey", ["recipe_id", "keyword"])
    .execute();

  // Facet counts (group by keyword across recipes).
  await db.schema.createIndex("recipe_keyword_keyword_idx").on("recipe_keyword").column("keyword").execute();

  // --- recipe_attribution -----------------------------------------------
  // The attribution union (6 member shapes) flattened to common searchable
  // columns + lossless `raw` jsonb spillover.
  await db.schema
    .createTable("recipe_attribution")
    .addColumn("recipe_id", "text", (col) => col.primaryKey().references("recipe.id").onDelete("cascade"))
    .addColumn("kind", "text", (col) => col.notNull()) // original|person|publication|website|show|product
    .addColumn("display_name", "text") // person/website/product name OR publication/show title
    .addColumn("author", "text")
    .addColumn("publisher", "text")
    .addColumn("url", "text")
    .addColumn("license", "text")
    .addColumn("raw", "jsonb", (col) => col.notNull())
    .execute();

  // --- recipe_vocab + recipe_vocab_alias --------------------------------
  // Internal canonical vocabulary for the token dimensions (diet, cuisine,
  // category, cooking_method). Recipe columns store our own `slug`, never the
  // upstream NSID. `recipe_vocab_alias` maps upstream token ids → a slug; it is
  // N:1 so a future recipe type's vocab can fold onto the same internal slug.
  await db.schema
    .createTable("recipe_vocab")
    .addColumn("dimension", "text", (col) => col.notNull()) // diet|cuisine|category|cooking_method
    .addColumn("slug", "text", (col) => col.notNull()) // internal snake_case id
    .addColumn("label", "text", (col) => col.notNull()) // display label
    // 'seed' = shipped in this migration; 'discovered' = auto-added by a sweep
    // that met an unknown-but-well-formed token (curate these later).
    .addColumn("source", "text", (col) => col.notNull().defaultTo("seed"))
    .addPrimaryKeyConstraint("recipe_vocab_pkey", ["dimension", "slug"])
    .execute();

  await db.schema
    .createTable("recipe_vocab_alias")
    .addColumn("external_ref", "text", (col) => col.primaryKey()) // e.g. exchange.recipe.defs#cuisineItalian
    .addColumn("dimension", "text", (col) => col.notNull())
    .addColumn("slug", "text", (col) => col.notNull())
    .addForeignKeyConstraint("recipe_vocab_alias_vocab_fkey", ["dimension", "slug"], "recipe_vocab", ["dimension", "slug"], (fk) => fk.onDelete("cascade"))
    .execute();

  await db.schema.createIndex("recipe_vocab_alias_slug_idx").on("recipe_vocab_alias").columns(["dimension", "slug"]).execute();

  await seedVocab(db);
}

// Upstream token suffixes per dimension (from exchange.recipe.defs). The token
// id is `${NSID}#${prefix}${Suffix}`; the internal slug/label derive from the
// Suffix. Seeded 1:1 today; aliases can later fan in from other vocabs.
const VOCAB_NSID = "exchange.recipe.defs";
const VOCAB: Record<string, { prefix: string; suffixes: string[] }> = {
  category: {
    prefix: "category",
    suffixes: ["Appetizer", "Beverage", "Breakfast", "Brunch", "Cocktail", "Dessert", "Dinner", "Entree", "Garnish", "KidFriendly", "Lunch", "Salad", "Side", "Snack", "Soup"],
  },
  cooking_method: {
    prefix: "cookingMethod",
    suffixes: ["AirFrying", "Baking", "Broiling", "Frying", "Grilling", "NoCook", "PressureCooking", "Roasting", "Sauteing", "SlowCooking", "Steaming"],
  },
  cuisine: {
    prefix: "cuisine",
    // oxfmt-ignore
    suffixes: ["African", "American", "Australian", "Brazilian", "British", "Caribbean", "Chinese", "Creole", "European", "French", "German", "Greek", "Indian", "Indonesian", "Italian", "Japanese", "Korean", "Lebanese", "Mediterranean", "Mexican", "MiddleEastern", "Moroccan", "Peruvian", "Polish", "Portuguese", "Russian", "Southern", "Spanish", "TexMex", "Texan", "Thai", "Turkish", "Vietnamese"],
  },
  diet: {
    prefix: "diet",
    suffixes: ["Diabetic", "GlutenFree", "Halal", "Keto", "Kosher", "LowCalorie", "LowCarb", "LowFat", "Paleo", "Vegan", "Vegetarian"],
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedVocab(db: Kysely<any>): Promise<void> {
  // slug: snakeCase("GlutenFree") → "gluten_free"; label: startCase → "Gluten Free".
  const vocabRows: { dimension: string; slug: string; label: string }[] = [];
  const aliasRows: { external_ref: string; dimension: string; slug: string }[] = [];
  for (const [dimension, { prefix, suffixes }] of Object.entries(VOCAB)) {
    for (const suffix of suffixes) {
      const slug = snakeCase(suffix);
      vocabRows.push({ dimension, slug, label: startCase(suffix) });
      aliasRows.push({ external_ref: `${VOCAB_NSID}#${prefix}${suffix}`, dimension, slug });
    }
  }
  await db.insertInto("recipe_vocab").values(vocabRows).execute();
  await db.insertInto("recipe_vocab_alias").values(aliasRows).execute();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("recipe_vocab_alias").ifExists().execute();
  await db.schema.dropTable("recipe_vocab").ifExists().execute();
  // Children drop via cascade with `recipe`, but drop explicitly for clarity.
  await db.schema.dropTable("recipe_attribution").ifExists().execute();
  await db.schema.dropTable("recipe_keyword").ifExists().execute();
  await db.schema.dropTable("recipe_image").ifExists().execute();
  await db.schema.dropTable("recipe_instruction").ifExists().execute();
  await db.schema.dropTable("recipe_ingredient").ifExists().execute();
  await db.schema.dropTable("recipe_search").ifExists().execute();
  await db.schema.dropTable("recipe").ifExists().execute();
  // Leave the pg_trgm extension — other schema may depend on it.
}
