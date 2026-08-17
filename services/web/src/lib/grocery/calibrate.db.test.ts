import { writeFileSync } from "node:fs";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import type { DB } from "#/db/types";
import { AISLES, type Aisle } from "./aisles";
import { type FoodMatch, type Lexicon, categorizeWith, loadLexicon } from "./categorize";
import { parseIngredientLine } from "./parse";

/**
 * The calibration sweep (grocery-list plan §9).
 *
 * Runs the parse → categorize cascade across every distinct
 * `recipe_ingredient.text` in the dev database and asserts the plan's target:
 * **at least 90% of lines resolve to a `food_slug`**.
 *
 * This is a test rather than a one-off script on purpose. The match rate is not
 * a number you measure once and write down — it moves every time the aisle map,
 * the synonym pass, or the parser changes, and the only way it stays honest is
 * if a regression fails a build the way any other regression does. It lives
 * under `.db.test.ts` so it skips silently without a database, and so it reads
 * its corpus from the real imported recipes rather than a fixture somebody
 * curated to pass.
 *
 * It also writes `.dev-logs/grocery-calibration.md` on every run: the rate, the
 * cascade-step histogram, the aisle distribution, and — the useful part — every
 * unmatched line. That file is the worklist for `scripts/food-aisle-map.ts` and
 * `scripts/food-synonyms.ts`. It is gitignored along with the rest of
 * `.dev-logs/`; the measured rate belongs in the results log, not in the repo as
 * a build artifact.
 */

const REPORT = ".dev-logs/grocery-calibration.md";

/** Plan §9: "Target ≥ 90% of lines resolving to a `food_slug`." */
const TARGET_MATCH_RATE = 0.9;

/**
 * Below this many lines the percentage is noise — a five-recipe database can
 * hit 100% or 60% on one bad line. Assert only once the corpus can carry it.
 */
const MIN_CORPUS = 100;

let skipReason = "";

function announceSkip(reason: string): void {
  skipReason = reason;
  process.stderr.write(`\nSKIPPING grocery calibration — ${reason}.\nSeed the dev database (node scripts/seed-dev-recipes.ts) and re-run with DATABASE_URL set.\n\n`);
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

function writeReport(swept: Swept[], rate: number): void {
  const byStep = new Map<string, number>();
  const byAisle = new Map<Aisle, number>();
  for (const row of swept) {
    byStep.set(row.match.via, (byStep.get(row.match.via) ?? 0) + 1);
    byAisle.set(row.match.aisle, (byAisle.get(row.match.aisle) ?? 0) + 1);
  }

  const misses = swept.filter((row) => row.match.foodSlug === null);
  const lines = [
    "# Grocery lexicon calibration",
    "",
    `Corpus: **${swept.length}** distinct ingredient lines from the dev database.`,
    `Matched to a food: **${swept.length - misses.length}** (**${(rate * 100).toFixed(1)}%**), target ${(TARGET_MATCH_RATE * 100).toFixed(0)}%.`,
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
    writeFileSync(REPORT, lines.join("\n"));
  } catch {
    // The report is a convenience, not the test. A missing .dev-logs directory
    // must not fail a calibration run that otherwise measured fine.
  }
}

describe.skipIf(!db)(db ? "grocery lexicon calibration (§9)" : `grocery lexicon calibration (§9) — SKIPPED: ${skipReason}`, () => {
  it(`resolves at least ${TARGET_MATCH_RATE * 100}% of the real corpus to a food`, async () => {
    const [lexicon, rows] = await Promise.all([loadLexicon(), db!.selectFrom("recipe_ingredient").select("text").distinct().orderBy("text").execute()]);

    const swept = sweep(
      lexicon,
      rows.map((row) => row.text),
    );

    if (swept.length < MIN_CORPUS) {
      process.stderr.write(`\nGrocery calibration: only ${swept.length} lines in the corpus (need ${MIN_CORPUS} to assert). Seed with \`node scripts/seed-dev-recipes.ts\`.\n\n`);
      expect(swept.length).toBeGreaterThanOrEqual(0);
      return;
    }

    const matched = swept.filter((row) => row.match.foodSlug !== null).length;
    const rate = matched / swept.length;
    writeReport(swept, rate);

    process.stderr.write(`\nGrocery calibration: ${matched}/${swept.length} lines matched (${(rate * 100).toFixed(1)}%). Report: ${REPORT}\n\n`);
    expect(rate).toBeGreaterThanOrEqual(TARGET_MATCH_RATE);
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
