import { registerCreateRecipeSkill } from "./create-recipe";
import { registerHouseholdSkill } from "./households";
import { registerRecipeSchemaSkill } from "./recipe-schema";
import { registerRecipesSkill } from "./recipes";
import type { McpServer } from "@modelcontextprotocol/server";

// One entry per skill (tools / prompts / resources). Add a file beside this one
// exporting a `register*Skill(server)` and list it here.
export const skills: ReadonlyArray<(server: McpServer) => void> = [registerRecipeSchemaSkill, registerHouseholdSkill, registerCreateRecipeSkill, registerRecipesSkill];
