import * as z from "zod";
import { getDb } from "#/lib/db";
import type { RecipeRecordInput } from "#/lib/recipe-record";
import { assertMember } from "../../authz";
import { listHouseholdsForDid } from "../../household/households";
import { runSave } from "../../recipes-write";
import { callerDid, NOT_SIGNED_IN, text } from "../caller";
import { chooseHousehold } from "../household-context";
import type { McpServer } from "@modelcontextprotocol/server";

/** Saves an agent-written recipe into one of the caller's households. */
export function registerCreateRecipeSkill(server: McpServer): void {
  server.registerTool(
    "create_recipe",
    {
      description:
        "Save a new recipe to one of the user's households. Read the recipe schema first and run validate_recipe on a draft; this runs the same checks. It is saved as a draft by default and is never published to the user's atproto account. " +
        "householdId is optional when the user has exactly one household. With several, call list_households and ask the user which to use.",
      inputSchema: z.object({
        record: z.record(z.string(), z.unknown()).describe("The recipe record. $type, createdAt, updatedAt and embed are handled for you."),
        sourceUrl: z.string().optional().describe("The page the recipe came from, if any. Buttery derives the website attribution from it."),
        householdId: z.string().optional().describe("Which household to save into. Omit if the user has just one."),
        visibility: z.enum(["draft", "private"]).optional().describe('"draft" (default) is a work in progress; "private" puts it in the household\'s recipes.'),
      }),
    },
    async ({ record, sourceUrl, householdId, visibility }, ctx) => {
      const did = await callerDid(ctx);
      if (!did) return text(NOT_SIGNED_IN, true);

      const choice = chooseHousehold(await listHouseholdsForDid(getDb(), did), householdId);
      if (!choice.ok) return text(choice.message, true);
      const { household } = choice;

      // The chokepoint every household write passes through, even though `chooseHousehold`
      // already limited the choice to this user's own households.
      await assertMember(did, household.id);

      const result = await runSave(
        getDb(),
        { did, householdId: household.id },
        { record: record as RecipeRecordInput, sourceUrl: sourceUrl ?? null, visibility: visibility ?? "draft", publish: false },
      );

      switch (result.status) {
        case "ok":
          return text(`Saved to "${household.name}" as a ${visibility ?? "draft"}. Recipe id: ${result.recipeId}`);
        case "invalid":
          return text(`Not saved:\n${result.issues.map((i) => `- ${i.path}: ${i.message}`).join("\n")}`, true);
        default:
          // `publish: false` rules out the other statuses; fail loudly if that ever changes.
          return text(`Unexpected result: ${result.status}`, true);
      }
    },
  );
}
