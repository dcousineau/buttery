import * as z from "zod";
import { validateRecipeRecord } from "#/lib/recipe-record";
import type { RecipeRecordInput } from "#/lib/recipe-record";
import { resolveAttribution } from "../../recipes-write";
import type { McpServer } from "@modelcontextprotocol/server";

// The lexicon documents in `packages/lexicons/lexicons/` are the source of truth for
// every record Buttery reads or writes. They are bundled verbatim (`?raw`) and served
// as-is, so nothing here restates a schema and a lexicon change shows up on its own.
// The glob also picks up the vendored atproto lexicons the recipe lexicons `ref`.
const documents = import.meta.glob("../../../../../../packages/lexicons/lexicons/**/*.json", {
  query: "?raw",
  import: "default",
  eager: true,
});

const RECIPE_NSID = "exchange.recipe.recipe";

/** nsid → raw lexicon JSON, keyed off each document's own `id`. */
const schemas = new Map<string, string>(Object.values(documents).map((raw) => [(JSON.parse(raw) as { id: string }).id, raw]));

const schemaUri = (nsid: string) => `buttery://lexicon/${nsid}`;

// Same source for the resources and for `get_recipe_schema`, so the two cannot disagree.
function schemaOrError(nsid: string) {
  const raw = schemas.get(nsid);
  if (raw) return { content: [{ type: "text" as const, text: raw }] };
  return { isError: true, content: [{ type: "text" as const, text: `No lexicon named "${nsid}". Known: ${[...schemas.keys()].sort().join(", ")}` }] };
}

/**
 * Recipe schemas for agents: every lexicon as a readable Resource, plus two tools for
 * clients that don't surface resources to the model on their own.
 */
export function registerRecipeSchemaSkill(server: McpServer): void {
  for (const [nsid, raw] of schemas) {
    server.registerResource(nsid, schemaUri(nsid), { title: nsid, description: `atproto lexicon ${nsid}`, mimeType: "application/json" }, (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: raw }],
    }));
  }

  server.registerTool(
    "get_recipe_schema",
    {
      description: `Return an atproto lexicon (JSON) by nsid. Defaults to ${RECIPE_NSID}, the schema for a recipe record. Same content as the buttery://lexicon/{nsid} resources.`,
      inputSchema: z.object({ nsid: z.string().optional() }),
    },
    ({ nsid }) => schemaOrError(nsid ?? RECIPE_NSID),
  );

  server.registerTool(
    "validate_recipe",
    {
      description: `Check a draft recipe record against the ${RECIPE_NSID} lexicon and list what is wrong. Read the schema first (resource ${schemaUri(RECIPE_NSID)} or get_recipe_schema). Also enforces Buttery's rule that every recipe has a source. Does not save anything.`,
      inputSchema: z.object({
        record: z.record(z.string(), z.unknown()).describe("The recipe record. $type, createdAt and updatedAt may be omitted; they are stamped on save."),
        sourceUrl: z.string().optional().describe("The page the recipe came from, if any. Buttery derives the website attribution from it."),
      }),
    },
    ({ record, sourceUrl }) => {
      // The same two gates a real save runs, so this verdict is the save's verdict: the
      // lexicon (`validateRecipeRecord`) and Buttery's stricter every-recipe-needs-a-source
      // rule (`resolveAttribution`), which the lexicon marks optional.
      const now = new Date().toISOString();
      const validated = validateRecipeRecord({ $type: RECIPE_NSID, createdAt: now, updatedAt: now, ...record });
      const problems = validated.status === "invalid" ? validated.issues.map((issue) => `${issue.path}: ${issue.message}`) : [];
      if (!resolveAttribution(record as RecipeRecordInput, sourceUrl ?? null)) {
        problems.push("attribution: Buttery requires a source. Pass sourceUrl, or an attribution object (person, publication or website).");
      }
      if (problems.length === 0) return { content: [{ type: "text", text: "Valid." }] };
      return { isError: true, content: [{ type: "text", text: `Invalid:\n${problems.map((p) => `- ${p}`).join("\n")}` }] };
    },
  );
}
