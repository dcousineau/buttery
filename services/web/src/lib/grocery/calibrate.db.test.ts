import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import type { DB } from "#/db/types";
import { AISLES, type Aisle } from "@buttery/food/aisles";
import { type FoodMatch, type Lexicon, categorizeWith, loadLexicon } from "@buttery/food/categorize";
import { parseIngredientLine } from "@buttery/food/parse";

/**
 * The calibration sweep (grocery-list plan §9).
 *
 * Runs the parse → categorize cascade across the seeded ingredient corpora and
 * asserts a match-rate floor for each one.
 *
 * This is a test rather than a one-off script on purpose. The match rate is not
 * a number you measure once and write down — it moves every time the aisle map,
 * the synonym pass, or the parser changes, and the only way it stays honest is
 * if a regression fails a build the way any other regression does. It lives
 * under `.db.test.ts` so it skips silently without a database, and so it reads
 * its corpus from seeded recipes rather than a fixture somebody curated to pass.
 *
 * **Two corpora, two assertions.** The sweep used to run over every distinct
 * `recipe_ingredient.text` in the database, which meant the corpus was whatever
 * happened to be sitting in that developer's dev database — on a machine with a
 * few thousand synced recipes the rate read 94.4%, on a seeds-only database
 * 91.0%, and neither number was attributable to anything. Each `it` now scopes
 * itself by recipe-id prefix:
 *
 * - `seed-%` — the hand-written dev corpus in `1787000664088_dev_recipes.ts`.
 *   This is the corpus the 90% target of §9 was written against and it resolves
 *   at **100%**. It is also, being hand-written, exactly the corpus that cannot
 *   demonstrate a miss: the lexicon and this seed were built alongside each
 *   other.
 * - `netseed-%` — the network corpus in `1787688761627_network_recipe_corpus.ts`,
 *   a census of real atproto-authored recipes committed without looking at
 *   whether their lines match. It resolves at **89.0%** of distinct lines
 *   (1378/1548), and that gap is the point of it existing.
 *
 * The network floor sits deliberately below its measured rate — see
 * `NETWORK_TARGET_MATCH_RATE`. Do not raise either rate by editing a corpus.
 * Curating the corpus against the matcher is the exact failure the network seed
 * was added to correct.
 *
 * Both sweeps write a report under `.dev-logs/`: the rate, the cascade-step
 * histogram, the aisle distribution, and — the useful part — every unmatched
 * line. Those files are the worklist for `scripts/food-aisle-map.ts` and
 * `scripts/food-synonyms.ts`. They are gitignored along with the rest of
 * `.dev-logs/`; the measured rate belongs in the results log, not in the repo as
 * a build artifact.
 */

/**
 * Resolved from this module rather than `process.cwd()`: vitest runs with the
 * package as its working directory, so a repo-root-relative path silently wrote
 * nothing and the report looked like it had never run.
 */
const DEV_LOGS = join(dirname(fileURLToPath(import.meta.url)), "../../../../../.dev-logs");

/** Plan §9: "Target ≥ 90% of lines resolving to a `food_slug`." Measured over `seed-%`: 100.0% (330/330). */
const TARGET_MATCH_RATE = 0.9;

/**
 * The floor for the network corpus, which measured **89.0%** (1378/1548
 * distinct lines) when it was committed — recorded in
 * `docs/plans/results/2026-08-20-recipe-enrichment-results.md`.
 *
 * Set below the measurement on purpose. A floor pinned at the measured rate
 * goes red on a one-line drift and teaches people to edit the number; a floor
 * with roughly sixty lines of headroom stays quiet through ordinary lexicon
 * churn and goes red when a synonym pass or a parser change costs real
 * coverage. It is a regression detector, not a restatement of the measurement.
 *
 * It is lower than `TARGET_MATCH_RATE` because the corpora differ, not because
 * the target was relaxed: over half the misses here are non-English ingredient
 * names, which the Open Food Facts English taxonomy structurally cannot carry.
 * If phase 2 adds multilingual resolution this should be raised to match.
 */
const NETWORK_TARGET_MATCH_RATE = 0.85;

/**
 * Below this many lines the percentage is noise — a five-recipe database can
 * hit 100% or 60% on one bad line. Assert only once the corpus can carry it.
 */
const MIN_CORPUS = 100;

let skipReason = "";

function announceSkip(reason: string): void {
  skipReason = reason;
  process.stderr.write(`\nSKIPPING grocery calibration — ${reason}.\nSeed the dev database (pnpm --filter @buttery/web db:seed:run) and re-run with DATABASE_URL set.\n\n`);
}

async function connectOrSkip(): Promise<Kysely<DB> | null> {
  if (!process.env.DATABASE_URL) {
    announceSkip("DATABASE_URL is not set");
    return null;
  }
  const { getDb } = await import("#/lib/db");
  const db = getDb();
  try {
    await Promise.race([
      sql`select 1 from recipe_ingredient limit 0`.execute(db),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out after 5s")), 5_000).unref?.()),
    ]);
    return db;
  } catch (error) {
    announceSkip(`no reachable migrated database (${error instanceof Error ? error.message : String(error)})`);
    await db.destroy().catch(() => {});
    return null;
  }
}

const db = await connectOrSkip();

interface Swept {
  raw: string;
  name: string;
  match: FoodMatch;
}

/**
 * Every distinct ingredient line belonging to recipes whose id starts with
 * `prefix`. `like 'seed-%'` anchors at the start, so it does not also collect
 * the `netseed-` corpus — the two stay disjoint.
 */
async function corpusFor(prefix: string): Promise<string[]> {
  const rows = await db!
    .selectFrom("recipe_ingredient")
    .innerJoin("recipe", "recipe.id", "recipe_ingredient.recipe_id")
    .select("recipe_ingredient.text")
    .distinct()
    .where("recipe.id", "like", `${prefix}%`)
    .orderBy("recipe_ingredient.text")
    .execute();
  return rows.map((row) => row.text);
}

function sweep(lexicon: Lexicon, lines: readonly string[]): Swept[] {
  const out: Swept[] = [];
  for (const raw of lines) {
    const parsed = parseIngredientLine(raw);
    // Section headings are not ingredients and must not drag the rate down.
    if (parsed.isGroupHeader || !parsed.name) continue;
    out.push({ raw, name: parsed.name, match: categorizeWith(lexicon, parsed.name) });
  }
  return out;
}

function writeReport(report: string, title: string, target: number, swept: Swept[], rate: number): void {
  const byStep = new Map<string, number>();
  const byAisle = new Map<Aisle, number>();
  for (const row of swept) {
    byStep.set(row.match.via, (byStep.get(row.match.via) ?? 0) + 1);
    byAisle.set(row.match.aisle, (byAisle.get(row.match.aisle) ?? 0) + 1);
  }

  const misses = swept.filter((row) => row.match.foodSlug === null);
  const lines = [
    `# Grocery lexicon calibration — ${title}`,
    "",
    `Corpus: **${swept.length}** distinct ingredient lines from the dev database.`,
    `Matched to a food: **${swept.length - misses.length}** (**${(rate * 100).toFixed(1)}%**), floor ${(target * 100).toFixed(0)}%.`,
    "",
    "## Cascade step",
    "",
    "| step | lines |",
    "| --- | ---: |",
    ...["exact", "singular", "trimmed", "suffix", "fuzzy", "miss"].map((step) => `| ${step} | ${byStep.get(step) ?? 0} |`),
    "",
    "## Aisle distribution",
    "",
    "| aisle | lines |",
    "| --- | ---: |",
    ...AISLES.map((aisle) => `| ${aisle} | ${byAisle.get(aisle) ?? 0} |`),
    "",
    "## Unmatched lines",
    "",
    "The worklist for `scripts/food-aisle-map.ts` and `scripts/food-synonyms.ts`.",
    "",
    ...(misses.length ? misses.map((row) => `- \`${row.name}\`  ← ${row.raw}`) : ["_None._"]),
    "",
    "## Matched into `other`",
    "",
    "Resolved to a food, but that food has no aisle — candidates for the aisle map.",
    "",
    ...(() => {
      const other = swept.filter((row) => row.match.foodSlug !== null && row.match.aisle === "other");
      return other.length ? other.map((row) => `- \`${row.name}\` → ${row.match.foodSlug}`) : ["_None._"];
    })(),
    "",
  ];

  try {
    mkdirSync(dirname(report), { recursive: true });
    writeFileSync(report, lines.join("\n"));
  } catch {
    // The report is a convenience, not the test. A missing .dev-logs directory
    // must not fail a calibration run that otherwise measured fine.
  }
}

/** One corpus, swept and asserted. Returns nothing; the assertion is the point. */
async function assertCorpus(title: string, prefix: string, target: number, report: string): Promise<void> {
  const [lexicon, lines] = await Promise.all([loadLexicon(), corpusFor(prefix)]);
  const swept = sweep(lexicon, lines);

  if (swept.length < MIN_CORPUS) {
    process.stderr.write(
      `\nGrocery calibration (${title}): only ${swept.length} lines in the corpus (need ${MIN_CORPUS} to assert). Seed with \`pnpm --filter @buttery/web db:seed:run\`.\n\n`,
    );
    expect(swept.length).toBeGreaterThanOrEqual(0);
    return;
  }

  const matched = swept.filter((row) => row.match.foodSlug !== null).length;
  const rate = matched / swept.length;
  writeReport(report, title, target, swept, rate);

  process.stderr.write(`\nGrocery calibration (${title}): ${matched}/${swept.length} lines matched (${(rate * 100).toFixed(1)}%). Report: ${report}\n\n`);
  expect(rate).toBeGreaterThanOrEqual(target);
}

describe.skipIf(!db)(db ? "grocery lexicon calibration (§9)" : `grocery lexicon calibration (§9) — SKIPPED: ${skipReason}`, () => {
  it(`resolves at least ${TARGET_MATCH_RATE * 100}% of the dev corpus to a food`, async () => {
    await assertCorpus("dev corpus", "seed-", TARGET_MATCH_RATE, join(DEV_LOGS, "grocery-calibration.md"));
  });

  it(`resolves at least ${NETWORK_TARGET_MATCH_RATE * 100}% of the network corpus to a food`, async () => {
    await assertCorpus("network corpus", "netseed-", NETWORK_TARGET_MATCH_RATE, join(DEV_LOGS, "grocery-calibration-network.md"));
  });

  it("never assigns a line an aisle outside the canonical set", async () => {
    const [lexicon, rows] = await Promise.all([loadLexicon(), db!.selectFrom("recipe_ingredient").select("text").distinct().limit(2000).execute()]);

    for (const row of sweep(
      lexicon,
      rows.map((r) => r.text),
    )) {
      expect(AISLES).toContain(row.match.aisle);
    }
  });
});
