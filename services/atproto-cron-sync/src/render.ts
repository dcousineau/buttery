import type { Pool, PoolClient } from "pg";
import { compact, snakeCase, startCase, uniq } from "es-toolkit";
// dayjs + its duration plugin (parses ISO-8601 duration strings). Node's native
// ESM resolver needs the explicit `.js` on the plugin subpath.
import dayjs from "dayjs";
import duration from "dayjs/plugin/duration.js";
import type { RecipeRow } from "#/recipe.ts";
import { log } from "#/log.ts";

dayjs.extend(duration);

// The "rendered" recipe layer: project a validated raw record into the
// normalized `recipe` + child tables that power browse/search. The cron owns
// ONLY `origin = 'sync'` rows (see the recipe_rendered migration); it never
// overwrites a locally-authored row's content, and reconciles just cid/rev
// once a local recipe has been published to the network.
//
// All input is untrusted (plan §1). We hand-parse the raw jsonb defensively —
// no `@buttery/lexicons` import (plan §3) — and only ever render records that
// already passed `validate()` (validation_status = 'valid').

// --- defensive extraction helpers ---------------------------------------

type Json = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function strArray(v: unknown, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0).map((x) => (x.length > maxLen ? x.slice(0, maxLen) : x));
}

function obj(v: unknown): Json | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}

function intOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
}

// Decimals are stored as strings in the vendored lexicon; keep them as strings
// (Postgres numeric accepts a numeric string), null on anything unparseable.
function numericStr(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string" && v.length > 0 && !Number.isNaN(Number(v))) return v;
  return null;
}

function datetime(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  return Number.isNaN(Date.parse(s)) ? null : s;
}

// ISO-8601 duration → seconds via dayjs' duration plugin (Y/M normalized by
// dayjs). Requires a leading "P"; returns null on absent/unparseable/zero input.
function durationSeconds(v: unknown): number | null {
  const s = str(v);
  if (!s || s[0] !== "P") return null;
  const secs = dayjs.duration(s).asSeconds();
  return Number.isFinite(secs) && secs > 0 ? Math.round(secs) : null;
}

// --- attribution (union → flat columns) ---------------------------------

interface Attribution {
  kind: string;
  displayName: string | null;
  author: string | null;
  publisher: string | null;
  url: string | null;
  license: string | null;
  raw: Json;
}

// $type e.g. "exchange.recipe.defs#attributionPerson" → kind "person".
function attributionKind(type: string | null): string {
  const frag = type?.split("#attribution")[1];
  return frag ? frag[0].toLowerCase() + frag.slice(1) : "unknown";
}

function parseAttribution(v: unknown): Attribution | null {
  const a = obj(v);
  if (!a) return null;
  return {
    kind: attributionKind(str(a.$type)),
    // Generic pluck works across all 6 members: person/website/product carry
    // `name`, publication/show carry `title`.
    displayName: str(a.name) ?? str(a.title),
    author: str(a.author),
    publisher: str(a.publisher),
    url: str(a.url),
    license: str(a.license),
    raw: a,
  };
}

// --- images -------------------------------------------------------------

interface ImageRow {
  alt: string | null;
  blobCid: string | null;
  blobMime: string | null;
  blobSize: number | null;
  aspectW: number | null;
  aspectH: number | null;
}

// Blob shape in a record: { $type:'blob', ref:{ $link:'<cid>' }, mimeType, size }.
function parseImages(embed: unknown): ImageRow[] {
  const e = obj(embed);
  const images = e && Array.isArray(e.images) ? e.images : [];
  const out: ImageRow[] = [];
  for (const raw of images.slice(0, 4)) {
    const img = obj(raw);
    if (!img) continue;
    const blob = obj(img.image);
    const ref = blob ? obj(blob.ref) : null;
    const ar = obj(img.aspectRatio);
    out.push({
      alt: str(img.alt),
      blobCid: str(ref?.$link) ?? str(blob?.ref),
      blobMime: str(blob?.mimeType),
      blobSize: intOrNull(blob?.size),
      aspectW: intOrNull(ar?.width),
      aspectH: intOrNull(ar?.height),
    });
  }
  return out;
}

// --- token vocabulary ---------------------------------------------------

// Upstream token NSID (e.g. "exchange.recipe.defs#cuisineItalian") → our
// internal vocab entry. Loaded once per process from recipe_vocab_alias.
interface VocabEntry {
  dimension: string;
  slug: string;
  label: string;
}
type VocabMap = Map<string, VocabEntry>;

let vocabPromise: Promise<VocabMap> | null = null;

const LOAD_VOCAB_SQL = `
select a.external_ref, a.dimension, a.slug, v.label
  from recipe_vocab_alias a
  join recipe_vocab v on v.dimension = a.dimension and v.slug = a.slug
`;

/** Load + memoize the alias map (first render call populates it for the run). */
function getVocab(client: PoolClient): Promise<VocabMap> {
  if (!vocabPromise) {
    vocabPromise = client.query<{ external_ref: string; dimension: string; slug: string; label: string }>(LOAD_VOCAB_SQL).then((res) => {
      const map: VocabMap = new Map();
      for (const r of res.rows) map.set(r.external_ref, { dimension: r.dimension, slug: r.slug, label: r.label });
      return map;
    });
  }
  return vocabPromise;
}

// Upstream token prefix per internal dimension (mirrors the migration seed).
const DIM_PREFIX: Record<string, string> = {
  cooking_method: "cookingMethod",
  cuisine: "cuisine",
  category: "category",
  diet: "diet",
};

// Auto-register an unknown token IF it is a well-formed recipe-defs token for
// the expected dimension — e.g. the upstream lexicon added a new cuisine. This
// is deliberately narrow: input is untrusted, so we only accept the exact
// `exchange.recipe.defs#<prefix><CamelSuffix>` shape (≤64 alnum suffix) so a
// junk string can never pollute the vocab. Everything else is dropped.
async function registerToken(client: PoolClient, vocab: VocabMap, ref: string, dimension: string): Promise<VocabEntry | null> {
  const prefix = DIM_PREFIX[dimension];
  const m = new RegExp(`^exchange\\.recipe\\.defs#${prefix}([A-Z][A-Za-z0-9]{0,63})$`).exec(ref);
  if (!m) return null;
  const suffix = m[1];
  const entry: VocabEntry = { dimension, slug: snakeCase(suffix), label: startCase(suffix) };
  // Idempotent: concurrent DIDs may discover the same token this sweep.
  await client.query(`insert into recipe_vocab (dimension, slug, label, source) values ($1,$2,$3,'discovered') on conflict do nothing`, [entry.dimension, entry.slug, entry.label]);
  await client.query(`insert into recipe_vocab_alias (external_ref, dimension, slug) values ($1,$2,$3) on conflict do nothing`, [ref, entry.dimension, entry.slug]);
  vocab.set(ref, entry);
  log.info("discovered vocab token", { dimension, ref, slug: entry.slug });
  return entry;
}

// Resolve an upstream token to our vocab entry. A known ref must land in the
// expected dimension (a record could put a diet token in the cuisine field);
// an unknown-but-well-formed ref is auto-registered.
async function resolveToken(client: PoolClient, vocab: VocabMap, ref: unknown, dimension: string): Promise<VocabEntry | null> {
  const s = str(ref);
  if (!s) return null;
  const hit = vocab.get(s);
  if (hit) return hit.dimension === dimension ? hit : null;
  return registerToken(client, vocab, s, dimension);
}

// --- projected recipe shape ---------------------------------------------

interface RenderedRecipe {
  id: string;
  did: string;
  rkey: string;
  uri: string;
  cid: string;
  rev: string;
  name: string;
  description: string | null;
  recipeYield: string | null;
  prepTime: string | null;
  cookTime: string | null;
  totalTime: string | null;
  prepTimeSeconds: number | null;
  cookTimeSeconds: number | null;
  totalTimeSeconds: number | null;
  cookingMethod: string | null;
  recipeCuisine: string | null;
  recipeCategory: string | null;
  suitableForDiet: string[] | null;
  calories: number | null;
  fatContent: string | null;
  proteinContent: string | null;
  carbohydrateContent: string | null;
  publishedAt: string | null;
  recordCreatedAt: string | null;
  recordUpdatedAt: string | null;
  ingredients: string[];
  instructions: string[];
  keywords: string[];
  images: ImageRow[];
  attribution: Attribution | null;
  // Display labels of the mapped tokens, for the search document (weight B).
  vocabLabels: string[];
}

async function project(client: PoolClient, row: RecipeRow, vocab: VocabMap): Promise<RenderedRecipe> {
  const r = row.record;
  // Map upstream token NSIDs → internal slugs. Unknown-but-well-formed tokens
  // are auto-registered; other unmapped values are dropped (still preserved
  // verbatim in the raw atproto_collection_recipe row).
  const method = await resolveToken(client, vocab, r.cookingMethod, "cooking_method");
  const cuisine = await resolveToken(client, vocab, r.recipeCuisine, "cuisine");
  const category = await resolveToken(client, vocab, r.recipeCategory, "category");
  const dietEntries: VocabEntry[] = [];
  for (const t of strArray(r.suitableForDiet, 128)) {
    const e = await resolveToken(client, vocab, t, "diet");
    if (e) dietEntries.push(e);
  }
  const dietSlugs = uniq(dietEntries.map((e) => e.slug));
  const vocabLabels = compact([method, cuisine, category, ...dietEntries]).map((e) => e.label);
  return {
    id: row.rkey, // the recipe's ULID (rkey for synced records)
    did: row.did,
    rkey: row.rkey,
    uri: row.uri,
    cid: row.cid,
    rev: row.rev,
    name: str(r.name) ?? "",
    description: str(r.text),
    recipeYield: str(r.recipeYield),
    prepTime: str(r.prepTime),
    cookTime: str(r.cookTime),
    totalTime: str(r.totalTime),
    prepTimeSeconds: durationSeconds(r.prepTime),
    cookTimeSeconds: durationSeconds(r.cookTime),
    totalTimeSeconds: durationSeconds(r.totalTime),
    cookingMethod: method?.slug ?? null,
    recipeCuisine: cuisine?.slug ?? null,
    recipeCategory: category?.slug ?? null,
    suitableForDiet: dietSlugs.length ? dietSlugs : null,
    calories: intOrNull(obj(r.nutrition)?.calories),
    fatContent: numericStr(obj(r.nutrition)?.fatContent),
    proteinContent: numericStr(obj(r.nutrition)?.proteinContent),
    carbohydrateContent: numericStr(obj(r.nutrition)?.carbohydrateContent),
    // Synced records have been public since they were authored.
    publishedAt: datetime(r.createdAt),
    recordCreatedAt: row.recordCreatedAt,
    recordUpdatedAt: row.recordUpdatedAt,
    ingredients: strArray(r.ingredients, 500),
    instructions: strArray(r.instructions, 1000),
    keywords: strArray(r.keywords, 64),
    images: parseImages(r.embed),
    attribution: parseAttribution(r.attribution),
    vocabLabels,
  };
}

// --- SQL ----------------------------------------------------------------

// Content upsert, scoped to sync-owned rows and guarded on rev advance. A
// conflicting local row fails the `origin = 'sync'` guard and is left intact.
const UPSERT_RECIPE_SQL = `
insert into recipe
  (id, origin, visibility, did, rkey, uri, cid, rev, name, description, recipe_yield,
   prep_time, cook_time, total_time, prep_time_seconds, cook_time_seconds, total_time_seconds,
   cooking_method, recipe_cuisine, recipe_category, suitable_for_diet,
   calories, fat_content, protein_content, carbohydrate_content,
   published_at, record_created_at, record_updated_at, indexed_at)
values
  ($1,'sync','public',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26, now())
on conflict (id) do update set
  did = excluded.did, rkey = excluded.rkey, uri = excluded.uri, cid = excluded.cid, rev = excluded.rev,
  name = excluded.name, description = excluded.description, recipe_yield = excluded.recipe_yield,
  prep_time = excluded.prep_time, cook_time = excluded.cook_time, total_time = excluded.total_time,
  prep_time_seconds = excluded.prep_time_seconds, cook_time_seconds = excluded.cook_time_seconds,
  total_time_seconds = excluded.total_time_seconds, cooking_method = excluded.cooking_method,
  recipe_cuisine = excluded.recipe_cuisine, recipe_category = excluded.recipe_category,
  suitable_for_diet = excluded.suitable_for_diet, calories = excluded.calories,
  fat_content = excluded.fat_content, protein_content = excluded.protein_content,
  carbohydrate_content = excluded.carbohydrate_content, published_at = excluded.published_at,
  record_created_at = excluded.record_created_at, record_updated_at = excluded.record_updated_at,
  indexed_at = now()
where recipe.origin = 'sync' and (recipe.rev is null or recipe.rev < excluded.rev)
`;

// A local recipe that has since been published shows up in the network sweep.
// Reconcile only cid/rev/indexed_at — never its web-owned content/visibility.
const RECONCILE_LOCAL_SQL = `
update recipe set cid = $2, rev = $3, indexed_at = now()
where id = $1 and origin = 'local' and (rev is null or rev < $3)
`;

const DELETE_RENDERED_SQL = `delete from recipe where id = $1 and origin = 'sync'`;

const DEL_INGREDIENTS = `delete from recipe_ingredient where recipe_id = $1`;
const DEL_INSTRUCTIONS = `delete from recipe_instruction where recipe_id = $1`;
const DEL_IMAGES = `delete from recipe_image where recipe_id = $1`;
const DEL_KEYWORDS = `delete from recipe_keyword where recipe_id = $1`;
const DEL_ATTRIBUTION = `delete from recipe_attribution where recipe_id = $1`;

const UPSERT_SEARCH_SQL = `
insert into recipe_search (recipe_id, search_tsv) values
  ($1,
     setweight(to_tsvector('english', $2), 'A')
  || setweight(to_tsvector('english', $3), 'B')
  || setweight(to_tsvector('english', $4), 'C')
  || setweight(to_tsvector('english', $5), 'D'))
on conflict (recipe_id) do update set search_tsv = excluded.search_tsv
`;

// The only two tables `insertLines` writes. `table` is interpolated into the
// SQL (a bare identifier can't be a bind param), so it MUST come from this
// closed set — never from a record or any other untrusted source. All row
// VALUES are still parameterized; this guard just fences the identifier.
const LINE_TABLES = new Set(["recipe_ingredient", "recipe_instruction"]);

// Bulk-insert ordered lines into an (recipe_id, ordinal, text) child table.
// Params: $1 = recipe_id, then ordinals $2..$(n+1), then texts.
async function insertLines(client: PoolClient, table: string, id: string, lines: string[]): Promise<void> {
  if (!LINE_TABLES.has(table)) throw new Error(`insertLines: refusing unknown table ${table}`);
  if (!lines.length) return;
  const rows = lines.map((_, i) => `($1, $${2 + i}, $${2 + lines.length + i})`);
  await client.query(`insert into ${table} (recipe_id, ordinal, text) values ${rows.join(", ")}`, [id, ...lines.map((_, i) => i), ...lines]);
}

// --- public API ---------------------------------------------------------

/**
 * Render one validated record into the recipe layer. Invalid records remove any
 * previously-rendered sync row. Must run on the same per-DID client as the raw
 * upsert so writes for one DID never interleave (plan §1).
 */
export async function renderRecipe(client: PoolClient, row: RecipeRow): Promise<void> {
  if (row.validationStatus !== "valid") {
    // A record that turned invalid should not linger in the rendered layer.
    await client.query(DELETE_RENDERED_SQL, [row.rkey]);
    return;
  }

  const vocab = await getVocab(client);
  const p = await project(client, row, vocab);

  const res = await client.query(UPSERT_RECIPE_SQL, [
    p.id,
    p.did,
    p.rkey,
    p.uri,
    p.cid,
    p.rev,
    p.name,
    p.description,
    p.recipeYield,
    p.prepTime,
    p.cookTime,
    p.totalTime,
    p.prepTimeSeconds,
    p.cookTimeSeconds,
    p.totalTimeSeconds,
    p.cookingMethod,
    p.recipeCuisine,
    p.recipeCategory,
    p.suitableForDiet,
    p.calories,
    p.fatContent,
    p.proteinContent,
    p.carbohydrateContent,
    p.publishedAt,
    p.recordCreatedAt,
    p.recordUpdatedAt,
  ]);

  // The content upsert did nothing: either a stale rev (children already
  // current) or the id belongs to a local row. Reconcile the local case's
  // cid/rev and stop — never touch a local row's children/search.
  if ((res.rowCount ?? 0) === 0) {
    await client.query(RECONCILE_LOCAL_SQL, [p.id, p.cid, p.rev]);
    return;
  }

  // We own this sync row and it advanced: re-derive all children + search.
  await client.query(DEL_INGREDIENTS, [p.id]);
  await client.query(DEL_INSTRUCTIONS, [p.id]);
  await client.query(DEL_IMAGES, [p.id]);
  await client.query(DEL_KEYWORDS, [p.id]);
  await client.query(DEL_ATTRIBUTION, [p.id]);

  await insertLines(client, "recipe_ingredient", p.id, p.ingredients);
  await insertLines(client, "recipe_instruction", p.id, p.instructions);

  if (p.images.length) {
    const rows = p.images.map((_, i) => {
      const b = i * 7;
      return `($1, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8})`;
    });
    const params: unknown[] = [p.id];
    p.images.forEach((img, i) => params.push(i, img.alt, img.blobCid, img.blobMime, img.blobSize, img.aspectW, img.aspectH));
    await client.query(`insert into recipe_image (recipe_id, ordinal, alt, blob_cid, blob_mime, blob_size, aspect_w, aspect_h) values ${rows.join(", ")}`, params);
  }

  // Dedupe keywords (PK is (recipe_id, keyword)).
  const keywords = uniq(p.keywords);
  if (keywords.length) {
    const rows = keywords.map((_, i) => `($1, $${i + 2})`);
    await client.query(`insert into recipe_keyword (recipe_id, keyword) values ${rows.join(", ")}`, [p.id, ...keywords]);
  }

  if (p.attribution) {
    const a = p.attribution;
    await client.query(`insert into recipe_attribution (recipe_id, kind, display_name, author, publisher, url, license, raw) values ($1,$2,$3,$4,$5,$6,$7,$8)`, [
      p.id,
      a.kind,
      a.displayName,
      a.author,
      a.publisher,
      a.url,
      a.license,
      a.raw,
    ]);
  }

  // Weighted search document: A=name, B=facets+attribution, C=ingredients,
  // D=description+instructions.
  const attrText = p.attribution ? compact([p.attribution.displayName, p.attribution.author, p.attribution.publisher]).join(" ") : "";
  // Facets use human labels ("Gluten Free"), not slugs, so fulltext matches on
  // natural words rather than "gluten_free".
  const facets = compact([...p.keywords, ...p.vocabLabels, attrText]).join(" ");
  await client.query(UPSERT_SEARCH_SQL, [p.id, p.name, facets, p.ingredients.join(" "), [p.description ?? "", ...p.instructions].join(" ")]);
}

/**
 * Remove rendered sync rows for `did` whose rkey was NOT seen this sweep,
 * mirroring the raw-layer soft-delete. Rendered rows are hard-deleted (children
 * + search cascade) so dead recipes never surface in search. Only local rows
 * are exempt (they are never keyed by a network sweep's did). Returns rows deleted.
 */
export async function deleteRenderedForDid(pool: Pool, did: string, seenRkeys: string[]): Promise<number> {
  const res = await pool.query(`delete from recipe where did = $1 and origin = 'sync' and id <> all($2::text[])`, [did, seenRkeys]);
  return res.rowCount ?? 0;
}
