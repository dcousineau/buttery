/**
 * Generate `packages/food/src/lexicon.json` from the Open Food Facts
 * ingredients taxonomy (plan §4.2).
 *
 * Run by hand; the output is checked in. The running app never calls this, never
 * calls Open Food Facts, and never calls an LLM — that is the point (plan D15),
 * and it is what keeps the claim on `/ai-usage` true.
 *
 *   node scripts/build-food-lexicon.ts
 *   node scripts/build-food-lexicon.ts --sha=<commit>      # re-pin the source
 *   node scripts/build-food-lexicon.ts --taxonomy=<path>   # use a local copy
 *   node scripts/build-food-lexicon.ts --langs=en,fr       # keep more languages
 *
 * The pipeline is: fetch the taxonomy at a pinned commit → parse its blocks into
 * `{ id, parents[], names }` → resolve an aisle for every food by walking to its
 * nearest mapped ancestor → resolve staple/ignored the same way → emit a compact
 * lookup table plus a normalized name index.
 *
 * The generated file carries a `__meta.sourceCommit`, so a lexicon can always be
 * traced back to the exact taxonomy revision it came from. Regenerating from a
 * newer commit is a deliberate, reviewable diff rather than a silent drift.
 *
 * The output is ODbL-licensed derived data. `lexicon.LICENSE.md` is written
 * beside it because JSON takes no comments (plan D16).
 */

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AISLES, DEFAULT_AISLE, type Aisle } from "../packages/food/src/aisles.ts";
import { normalizeFoodName, slugifyFoodName } from "../packages/food/src/normalize.ts";
import type { AllergenSlug, FoodTag, TriState } from "../packages/food/src/traits.ts";
import { FOOD_AISLE_MAP } from "./food-aisle-map.ts";
import { FOOD_ALLERGEN_MAP, OFF_ALLERGEN_MAP } from "./food-allergens.ts";
import { IGNORED_NODES, STAPLE_NODES } from "./food-staples.ts";
import { EXTRA_FOODS, EXTRA_SYNONYMS } from "./food-synonyms.ts";
import { FOOD_TAG_MAP } from "./food-tags.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "packages/food/src");
const OUT_JSON = join(OUT_DIR, "lexicon.json");
const OUT_LICENSE = join(OUT_DIR, "lexicon.LICENSE.md");
const OUT_TRAITS_JSON = join(OUT_DIR, "traits.json");

/**
 * The pinned Open Food Facts revision. Bumping this is the only supported way
 * to take a taxonomy update, and it must land together with the regenerated
 * `lexicon.json` in the same commit.
 */
const SOURCE_COMMIT = "b48d721b5c196b0db607dab1f5ba031c123a8f2f";
const SOURCE_PATH = "taxonomies/food/ingredients.txt";
const SOURCE_REPO = "openfoodfacts/openfoodfacts-server";

/** Target from plan §4.2. Exceeding it is a hard failure, not a warning. */
const MAX_GZIP_BYTES = 100 * 1024;

/**
 * `traits.json`'s own budget (plan §4.1, D9) — separate from `MAX_GZIP_BYTES`
 * above on purpose: traits are server-only, so this has real headroom over
 * the client bundle's number. Measured against the pinned taxonomy: ~25KB
 * gzip — comfortable margin under this.
 */
const TRAITS_MAX_GZIP_BYTES = 200 * 1024;

// --- CLI ------------------------------------------------------------------

function flag(name: string): string | undefined {
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

const sourceCommit = flag("sha") ?? SOURCE_COMMIT;
const localTaxonomy = flag("taxonomy");
const languages = (flag("langs") ?? "en")
  .split(",")
  .map((l) => l.trim())
  .filter(Boolean);

// --- taxonomy parsing -----------------------------------------------------

/**
 * A language line is `xx: value`; a property line is `prop:xx: value`. Splitting
 * on the first colon and testing the key against this is what tells them apart,
 * so `wikidata:en: Q1234` never gets mistaken for a name.
 */
const LANG_KEY = /^[a-z]{2,3}$/;
const PARENT_LINE = /^<\s*([a-z]{2,3}):\s*(.+)$/;

/**
 * The three `prop:en:` properties plan §4.1 needs. Matched against the whole
 * line (not the first-colon split above) because the key we want —
 * `vegan:en` — spans the taxonomy's first *two* colons, not its first one.
 */
const PROPERTY_LINE = /^(vegan|vegetarian|allergens):([a-z]{2,3}):\s*(.*)$/;
const TRI_STATE_VALUES = new Set(["yes", "no", "maybe"]);

interface TaxonomyEntry {
  /** Canonical id, e.g. `en:chicken-breast`. */
  id: string;
  /** Parent references as written, e.g. `en:chicken-meat`. Resolved later. */
  parentRefs: string[];
  /** Language code → names, first name canonical. */
  names: Map<string, string[]>;
  /** `vegan:en:` value, first occurrence per block wins. */
  vegan?: "yes" | "no" | "maybe";
  /** `vegetarian:en:` value, first occurrence per block wins. */
  vegetarian?: "yes" | "no" | "maybe";
  /** `allergens:en:` value(s), raw OFF allergen ids, e.g. `["en:gluten"]`. */
  allergens?: string[];
}

function parseTaxonomy(text: string): TaxonomyEntry[] {
  const entries: TaxonomyEntry[] = [];

  // Blocks are separated by a blank line. A block with no language line at all
  // is a comment or a `synonyms:`/`stopwords:` header, not a food.
  for (const block of text.split(/\n\s*\n/)) {
    const names = new Map<string, string[]>();
    const parentRefs: string[] = [];
    let vegan: TaxonomyEntry["vegan"];
    let vegetarian: TaxonomyEntry["vegetarian"];
    let allergens: string[] | undefined;

    for (const raw of block.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;

      const parent = PARENT_LINE.exec(line);
      if (parent) {
        parentRefs.push(`${parent[1]}:${slugifyFoodName(parent[2])}`);
        continue;
      }

      // Property lines never pass the LANG_KEY test below (their pre-colon key
      // is a property name like `vegan`, not a 2-3 letter language code), so
      // they are always headed for `continue` either way. Pull the three we
      // care about out before that happens.
      const property = PROPERTY_LINE.exec(line);
      if (property) {
        const [, prop, lang, rawValue] = property;
        if (lang === "en") {
          const value = rawValue.trim();
          if (prop === "vegan" && vegan === undefined && TRI_STATE_VALUES.has(value)) {
            vegan = value as TaxonomyEntry["vegan"];
          } else if (prop === "vegetarian" && vegetarian === undefined && TRI_STATE_VALUES.has(value)) {
            vegetarian = value as TaxonomyEntry["vegetarian"];
          } else if (prop === "allergens" && allergens === undefined && value) {
            allergens = value
              .split(",")
              .map((v) => v.trim())
              .filter(Boolean);
          }
        }
        continue;
      }

      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const key = line.slice(0, colon).trim();
      if (!LANG_KEY.test(key)) continue; // a property line we don't track
      // Only the first line per language counts; later ones are property values
      // that happen to share a language prefix.
      if (names.has(key)) continue;

      const values = line
        .slice(colon + 1)
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
      if (values.length) names.set(key, values);
    }

    // The id takes the language of the block's FIRST language line, matching how
    // Open Food Facts mints ids.
    const idLang = [...names.keys()][0];
    if (!idLang) continue;
    const canonical = names.get(idLang)![0];
    entries.push({ id: `${idLang}:${slugifyFoodName(canonical)}`, parentRefs, names, vegan, vegetarian, allergens });
  }

  return entries;
}

// --- inheritance ----------------------------------------------------------

/**
 * Walk a node's ancestors breadth-first and return the first mapped value.
 *
 * Breadth-first, not depth-first, because taxonomy nodes are multi-parent:
 * `en:black-pepper` sits under both `en:pepper` and `en:seed`, and the nearer
 * of the two should win regardless of the order the file lists them in. A
 * `seen` set makes the walk safe against the cycles the taxonomy really does
 * contain (`en:vegetable` is, transitively, its own ancestor).
 */
function nearestMapped<T>(id: string, parents: Map<string, string[]>, map: Record<string, T>): T | undefined {
  let frontier = [id];
  const seen = new Set<string>();

  while (frontier.length) {
    // Check the whole level before descending, so distance always wins.
    for (const node of frontier) {
      const hit = map[node];
      if (hit !== undefined) return hit;
    }
    const next: string[] = [];
    for (const node of frontier) {
      if (seen.has(node)) continue;
      seen.add(node);
      for (const parent of parents.get(node) ?? []) {
        if (!seen.has(parent)) next.push(parent);
      }
    }
    frontier = next;
  }

  return undefined;
}

/**
 * Walk a node's ancestors the same multi-parent, cycle-safe way as
 * {@link nearestMapped}, but fold the UNION of every mapped value found along
 * the walk instead of returning the first hit.
 *
 * Diet properties have one authoritative answer per node, so the nearest
 * declaration should win — that is `nearestMapped`. Allergens and tags don't
 * work that way: a food can carry several at once (`en:pesto` is milk *and*
 * tree nuts, plan §4.1), and a distant ancestor's allergen is additional
 * information, never something a nearer, unrelated ancestor should be able to
 * override by omission. So every level contributes here instead of the first
 * hit short-circuiting the rest.
 */
function ancestorUnion<T>(id: string, parents: Map<string, string[]>, map: Record<string, readonly T[]>): T[] {
  const result = new Set<T>();
  let frontier = [id];
  const seen = new Set<string>();

  while (frontier.length) {
    for (const node of frontier) {
      for (const value of map[node] ?? []) result.add(value);
    }
    const next: string[] = [];
    for (const node of frontier) {
      if (seen.has(node)) continue;
      seen.add(node);
      for (const parent of parents.get(node) ?? []) {
        if (!seen.has(parent)) next.push(parent);
      }
    }
    frontier = next;
  }

  return [...result];
}

// --- output shape ---------------------------------------------------------

interface LexiconFood {
  /** Aisle. */
  a: Aisle;
  /**
   * Canonical display name — one string, not the name list the plan sketched.
   *
   * Synonyms are not stored per food because `index` already holds every one of
   * them as a normalized key pointing back here, and that is the only thing the
   * matcher's suffix and fuzzy passes need. Carrying them twice pushed the file
   * past its gzip budget (plan §4.2) for no runtime gain: the UI only ever
   * displays the canonical name.
   */
  n: string;
  /** Staple — shown in the add preview but unchecked. Omitted when false. */
  s?: 1;
  /** Ignored — dropped from the add preview entirely. Omitted when false. */
  x?: 1;
}

interface Lexicon {
  __meta: {
    source: string;
    license: string;
    sourceRepo: string;
    sourceCommit: string;
    generatedFrom: string;
    taxonomySha256: string;
    languages: string[];
    foodCount: number;
    indexCount: number;
  };
  foods: Record<string, LexiconFood>;
  index: Record<string, string>;
}

// --- main -----------------------------------------------------------------

async function loadTaxonomy(): Promise<string> {
  if (localTaxonomy) {
    console.log(`Reading taxonomy from ${localTaxonomy}`);
    return readFileSync(localTaxonomy, "utf8");
  }
  const url = `https://raw.githubusercontent.com/${SOURCE_REPO}/${sourceCommit}/${SOURCE_PATH}`;
  console.log(`Fetching ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Taxonomy fetch failed: ${response.status} ${response.statusText}`);
  return response.text();
}

const raw = await loadTaxonomy();
const taxonomySha256 = createHash("sha256").update(raw).digest("hex");
const entries = parseTaxonomy(raw);
console.log(`Parsed ${entries.length} taxonomy entries`);

// Name → id, used to resolve `< en: chicken meat` parent references. Every
// language is indexed here even when only English is emitted, because a parent
// may be referenced in a language the child does not carry.
const idByName = new Map<string, string>();
for (const entry of entries) {
  for (const [lang, names] of entry.names) {
    for (const name of names) {
      const key = `${lang}:${slugifyFoodName(name)}`;
      if (!idByName.has(key)) idByName.set(key, entry.id);
    }
  }
}
for (const entry of entries) idByName.set(entry.id, entry.id);

const parents = new Map<string, string[]>();
for (const entry of entries) {
  parents.set(
    entry.id,
    entry.parentRefs.map((ref) => idByName.get(ref)).filter((id): id is string => Boolean(id)),
  );
}

// A mapping keyed on an id the taxonomy no longer has is almost always a typo or
// a rename that a refresh introduced. Fail rather than silently lose the aisle.
const known = new Set(entries.map((e) => e.id));
const orphans = [
  ...Object.keys(FOOD_AISLE_MAP).map((id) => [id, "food-aisle-map.ts"] as const),
  ...Object.keys(STAPLE_NODES).map((id) => [id, "food-staples.ts (STAPLE_NODES)"] as const),
  ...Object.keys(IGNORED_NODES).map((id) => [id, "food-staples.ts (IGNORED_NODES)"] as const),
  ...Object.keys(EXTRA_SYNONYMS).map((id) => [id, "food-synonyms.ts (EXTRA_SYNONYMS)"] as const),
  // `OFF_ALLERGEN_MAP` is NOT included here: its keys are OFF allergen-taxonomy
  // tokens (from `allergens.txt`, values of `allergens:en:`), not ingredient
  // node ids, so they are never expected to appear in `known`.
  ...Object.keys(FOOD_ALLERGEN_MAP).map((id) => [id, "food-allergens.ts (FOOD_ALLERGEN_MAP)"] as const),
  ...Object.keys(FOOD_TAG_MAP).map((id) => [id, "food-tags.ts (FOOD_TAG_MAP)"] as const),
].filter(([id]) => !known.has(id));
if (orphans.length) {
  for (const [id, where] of orphans) console.error(`  unknown taxonomy id ${id} (${where})`);
  throw new Error(`${orphans.length} mapped id(s) are not in the taxonomy at ${sourceCommit.slice(0, 12)}`);
}

// An `EXTRA_FOODS` entry for something the taxonomy has since grown a node for
// is a mapping that should be promoted, not silently shadowed.
const redundant = Object.entries(EXTRA_FOODS).filter(([, food]) => food.names.some((name) => idByName.has(`en:${slugifyFoodName(name)}`)));
if (redundant.length) {
  for (const [id, food] of redundant) {
    const hit = food.names.map((n) => idByName.get(`en:${slugifyFoodName(n)}`)).find(Boolean);
    console.error(`  ${id} duplicates taxonomy node ${hit} — move it to EXTRA_SYNONYMS`);
  }
  throw new Error(`${redundant.length} EXTRA_FOODS entr(y|ies) shadow a real taxonomy node`);
}

const badAisles = Object.entries(FOOD_AISLE_MAP).filter(([, aisle]) => !AISLES.includes(aisle));
if (badAisles.length) throw new Error(`Unknown aisle(s) in food-aisle-map.ts: ${badAisles.map(([id, a]) => `${id}=${a}`).join(", ")}`);

const foods: Record<string, LexiconFood> = {};
const index: Record<string, string> = {};
const aisleCounts = new Map<Aisle, number>();

/** Nodes that something else inherits from — never pruned, however obscure. */
const hasChildren = new Set<string>();
for (const parentIds of parents.values()) for (const parentId of parentIds) hasChildren.add(parentId);

/**
 * The prune plan §4.2 authorises when the file runs over budget: an `other`
 * leaf with a single name is the least useful row in the lexicon. It carries no
 * aisle information (`other` is what a miss resolves to anyway), it teaches the
 * tree nothing (nothing inherits from it), and its one name is more likely to be
 * a label-reading additive — `en:disodium-5-ribonucleotide` — than a line
 * anybody writes on a recipe.
 *
 * Dropping it costs one thing only: the line falls back to normalized-name
 * identity instead of a slug. It still parses, still consolidates with an
 * identical line from another recipe, and still lands in `other`.
 */
function prunable(id: string, aisle: Aisle, names: string[], staple: boolean, ignored: boolean): boolean {
  return aisle === DEFAULT_AISLE && !staple && !ignored && names.length === 1 && !hasChildren.has(id);
}

let pruned = 0;

for (const entry of entries) {
  const emitted = [...languages.flatMap((lang) => entry.names.get(lang) ?? []), ...(EXTRA_SYNONYMS[entry.id] ?? [])];
  // English-only by default: an entry with no English name has nothing a recipe
  // line written in English could ever match against.
  if (!emitted.length) continue;

  const aisle = nearestMapped(entry.id, parents, FOOD_AISLE_MAP) ?? DEFAULT_AISLE;
  const staple = nearestMapped(entry.id, parents, STAPLE_NODES) ?? false;
  const ignored = nearestMapped(entry.id, parents, IGNORED_NODES) ?? false;

  if (prunable(entry.id, aisle, emitted, staple, ignored)) {
    pruned += 1;
    continue;
  }

  const food: LexiconFood = { a: aisle, n: emitted[0] };
  if (staple) food.s = 1;
  if (ignored) food.x = 1;
  foods[entry.id] = food;
  aisleCounts.set(aisle, (aisleCounts.get(aisle) ?? 0) + 1);

  for (const name of emitted) {
    const key = normalizeFoodName(name);
    // First writer wins. Entries appear roughly general-before-specific in the
    // file, so a bare "pepper" keeps pointing at the spice rather than being
    // captured by whichever niche pepper variety was parsed last.
    if (key && !(key in index)) index[key] = entry.id;
  }
}

// The taxonomy's own gaps, filled last so a real node always wins the index key.
for (const [id, food] of Object.entries(EXTRA_FOODS)) {
  const entry: LexiconFood = { a: food.aisle, n: food.names[0] };
  if (food.staple) entry.s = 1;
  foods[id] = entry;
  aisleCounts.set(food.aisle, (aisleCounts.get(food.aisle) ?? 0) + 1);
  for (const name of food.names) {
    const key = normalizeFoodName(name);
    if (key && !(key in index)) index[key] = id;
  }
}

console.log(
  `Emitted ${Object.keys(foods).length} foods, ${Object.keys(index).length} index keys (pruned ${pruned} single-name "other" leaves, added ${Object.keys(EXTRA_FOODS).length} off-taxonomy foods)`,
);
console.log("Aisle distribution:");
for (const aisle of AISLES) {
  const count = aisleCounts.get(aisle) ?? 0;
  console.log(`  ${aisle.padEnd(14)} ${String(count).padStart(5)}`);
}

// --- traits.json (plan §4.1) -----------------------------------------------

interface FoodTraits {
  vg?: TriState;
  vt?: TriState;
  al?: AllergenSlug[];
  tg?: FoodTag[];
}

interface TraitsFile {
  __meta: {
    source: string;
    license: string;
    sourceRepo: string;
    sourceCommit: string;
    generatedFrom: string;
    taxonomySha256: string;
    foodCount: number;
    veganCount: number;
    vegetarianCount: number;
    allergenCount: number;
    tagCount: number;
  };
  foods: Record<string, FoodTraits>;
}

const TRI_STATE: Record<string, TriState> = { yes: 1, no: 0, maybe: 2 };

// Diet: one authoritative value per node — nearest ancestor wins.
const veganSeed: Record<string, TriState> = {};
const vegetarianSeed: Record<string, TriState> = {};
for (const entry of entries) {
  if (entry.vegan) veganSeed[entry.id] = TRI_STATE[entry.vegan]!;
  if (entry.vegetarian) vegetarianSeed[entry.id] = TRI_STATE[entry.vegetarian]!;
}

// Allergens: the taxonomy's OWN `allergens:en:` property (translated through
// OFF_ALLERGEN_MAP) merged with the curated FOOD_ALLERGEN_MAP seed, then both
// folded together by the same ancestorUnion walk — a node can contribute via
// either or both paths.
const allergenSeed: Record<string, AllergenSlug[]> = {};
for (const [id, slugs] of Object.entries(FOOD_ALLERGEN_MAP)) allergenSeed[id] = [...slugs];
const unmappedAllergenTokens = new Set<string>();
for (const entry of entries) {
  if (!entry.allergens) continue;
  const mapped: AllergenSlug[] = [];
  for (const token of entry.allergens) {
    const hit = OFF_ALLERGEN_MAP[token];
    if (hit) mapped.push(...hit);
    else unmappedAllergenTokens.add(token);
  }
  if (mapped.length) allergenSeed[entry.id] = [...new Set([...(allergenSeed[entry.id] ?? []), ...mapped])];
}
if (unmappedAllergenTokens.size) {
  console.warn(`  allergens:en: token(s) with no OFF_ALLERGEN_MAP entry: ${[...unmappedAllergenTokens].join(", ")}`);
}

const foodTraits: Record<string, FoodTraits> = {};
let veganCount = 0;
let vegetarianCount = 0;
let allergenCount = 0;
let tagCount = 0;

for (const id of Object.keys(foods)) {
  const vg = nearestMapped(id, parents, veganSeed);
  const vt = nearestMapped(id, parents, vegetarianSeed);
  const al = ancestorUnion(id, parents, allergenSeed);
  const tg = ancestorUnion(id, parents, FOOD_TAG_MAP);

  if (vg === undefined && vt === undefined && al.length === 0 && tg.length === 0) continue;

  const traits: FoodTraits = {};
  if (vg !== undefined) {
    traits.vg = vg;
    veganCount += 1;
  }
  if (vt !== undefined) {
    traits.vt = vt;
    vegetarianCount += 1;
  }
  if (al.length) {
    traits.al = al;
    allergenCount += 1;
  }
  if (tg.length) {
    traits.tg = tg;
    tagCount += 1;
  }
  foodTraits[id] = traits;
}

console.log(
  `traits: ${Object.keys(foodTraits).length} foods carry a trait (vg ${veganCount}, vt ${vegetarianCount}, allergen ${allergenCount}, tag ${tagCount}), out of ${Object.keys(foods).length} lexicon foods`,
);

const traitsFile: TraitsFile = {
  __meta: {
    source: "Open Food Facts",
    license: "ODbL-1.0",
    sourceRepo: SOURCE_REPO,
    sourceCommit,
    generatedFrom: SOURCE_PATH,
    taxonomySha256,
    foodCount: Object.keys(foodTraits).length,
    veganCount,
    vegetarianCount,
    allergenCount,
    tagCount,
  },
  foods: foodTraits,
};

const traitsJson = `${JSON.stringify(traitsFile, null, 0)}\n`;
const traitsGzipBytes = gzipSync(traitsJson).byteLength;
console.log(`traits.json: ${(traitsJson.length / 1024).toFixed(1)} KB raw, ${(traitsGzipBytes / 1024).toFixed(1)} KB gzip`);
if (traitsGzipBytes > TRAITS_MAX_GZIP_BYTES) {
  throw new Error(`traits.json is ${(traitsGzipBytes / 1024).toFixed(1)} KB gzip, over the ${TRAITS_MAX_GZIP_BYTES / 1024} KB budget (plan §4.1)`);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_TRAITS_JSON, traitsJson);
console.log(`Wrote ${OUT_TRAITS_JSON}`);

// --- lexicon.json ------------------------------------------------------

const lexicon: Lexicon = {
  __meta: {
    source: "Open Food Facts",
    license: "ODbL-1.0",
    sourceRepo: SOURCE_REPO,
    sourceCommit,
    generatedFrom: SOURCE_PATH,
    taxonomySha256,
    languages,
    foodCount: Object.keys(foods).length,
    indexCount: Object.keys(index).length,
  },
  foods,
  index,
};

const json = `${JSON.stringify(lexicon, null, 0)}\n`;
const gzipBytes = gzipSync(json).byteLength;
console.log(`lexicon.json: ${(json.length / 1024).toFixed(1)} KB raw, ${(gzipBytes / 1024).toFixed(1)} KB gzip`);
if (gzipBytes > MAX_GZIP_BYTES) {
  throw new Error(`lexicon.json is ${(gzipBytes / 1024).toFixed(1)} KB gzip, over the ${MAX_GZIP_BYTES / 1024} KB budget (plan §4.2)`);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_JSON, json);
writeFileSync(
  OUT_LICENSE,
  `# lexicon.json / traits.json — license and provenance

Both \`lexicon.json\` and \`traits.json\` in this directory are **generated**.
Never hand-edit either; run \`node scripts/build-food-lexicon.ts\` from the repo
root instead. The aisle assignments \`lexicon.json\` encodes live in
\`scripts/food-aisle-map.ts\` and \`scripts/food-staples.ts\`; the vegan,
vegetarian, allergen and tag facts \`traits.json\` encodes live in
\`scripts/food-allergens.ts\` and \`scripts/food-tags.ts\` (diet properties come
straight from the taxonomy's own \`vegan:en:\` / \`vegetarian:en:\` values, with
no hand-authored map). Those are the files to edit.

\`traits.json\` is server-only (plan D9) — see \`packages/food/src/traits.ts\`.

## Source

Derived from the [Open Food Facts](https://world.openfoodfacts.org/) ingredients
taxonomy, \`${SOURCE_PATH}\` in
[\`${SOURCE_REPO}\`](https://github.com/${SOURCE_REPO}), at commit
\`${sourceCommit}\` (sha256 of the source file:
\`${taxonomySha256}\`).

See \`docs/resources/OPENFOODFACTS.md\` for what Open Food Facts is and where the
rest of its data lives.

## License

Open Food Facts data is published under the
[Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).

Both files are a **derived database** under that license: they reuse the
taxonomy's food identifiers, English names, hierarchy and (for \`traits.json\`)
its own diet and allergen properties, and add Buttery's own assignments on top
— aisle, staple and ignore for \`lexicon.json\`; allergen and tag seeds for
\`traits.json\`. As derived databases they are offered under the ODbL as well,
and the attribution above must travel with both.

Buttery credits Open Food Facts on its \`/acknowledgements\` page.
`,
);

console.log(`\nWrote ${OUT_JSON}`);
console.log(`Wrote ${OUT_LICENSE}`);
