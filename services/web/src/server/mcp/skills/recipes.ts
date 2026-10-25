import * as z from "zod";
import { getDb } from "#/lib/db";
import { assertMember } from "../../authz";
import { listHouseholdsForDid } from "../../household/households";
import { readHouseholdRecipeDetail, readHouseholdRecipeRows } from "../../household-recipes";
import { callerDid, NOT_SIGNED_IN, text } from "../caller";
import { chooseHousehold } from "../household-context";
import type { McpServer } from "@modelcontextprotocol/server";

const householdId = z.string().optional().describe("Which household to read from. Omit if the user has just one.");

/**
 * Reads a household's recipe box. Both tools return the same DTOs the web app renders
 * (`HouseholdRecipeRow` / `HouseholdRecipeDetail`), tags and enrichment included.
 */
export function registerRecipesSkill(server: McpServer): void {
  server.registerTool(
    "list_recipes",
    {
      description:
        "List every recipe in one of the user's households: id, title, favorite, source, total time, keywords, who added it, and whether it is unpublished or unavailable. Use get_recipe with a recipeId for the ingredients, instructions and tags. " +
        "householdId is optional when the user has exactly one household. With several, call list_households and ask the user which to use.",
      inputSchema: z.object({ householdId }),
    },
    async ({ householdId }, ctx) => {
      const did = await callerDid(ctx);
      if (!did) return text(NOT_SIGNED_IN, true);

      const choice = chooseHousehold(await listHouseholdsForDid(getDb(), did), householdId);
      if (!choice.ok) return text(choice.message, true);
      await assertMember(did, choice.household.id);

      return text(JSON.stringify(await readHouseholdRecipeRows(getDb(), did, choice.household.id), null, 2));
    },
  );

  server.registerTool(
    "get_recipe",
    {
      description:
        "Get one recipe in full: description, ingredients, instructions, keywords, yield, times, nutrition, the household's note, and the diet and allergen tags. Get the recipeId from list_recipes. " +
        "householdId is optional when the user has exactly one household. With several, call list_households and ask the user which to use.",
      inputSchema: z.object({
        recipeId: z.string().min(1).max(512).describe("The recipeId from list_recipes."),
        householdId,
      }),
    },
    async ({ recipeId, householdId }, ctx) => {
      const did = await callerDid(ctx);
      if (!did) return text(NOT_SIGNED_IN, true);

      const choice = chooseHousehold(await listHouseholdsForDid(getDb(), did), householdId);
      if (!choice.ok) return text(choice.message, true);
      await assertMember(did, choice.household.id);

      const recipe = await readHouseholdRecipeDetail(getDb(), did, choice.household.id, recipeId);
      if (!recipe) return text(`No recipe "${recipeId}" in "${choice.household.name}". Call list_recipes for valid ids.`, true);
      return text(JSON.stringify(recipe, null, 2));
    },
  );
}
