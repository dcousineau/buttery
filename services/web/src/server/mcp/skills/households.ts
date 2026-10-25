import * as z from "zod";
import { getDb } from "#/lib/db";
import { listHouseholdsForDid } from "../../household/households";
import { callerDid, NOT_SIGNED_IN, text } from "../caller";
import { NO_HOUSEHOLD_MESSAGE } from "../household-context";
import type { McpServer } from "@modelcontextprotocol/server";

/** Households the caller belongs to. */
export function registerHouseholdSkill(server: McpServer): void {
  server.registerTool(
    "list_households",
    {
      description:
        "List the households the user belongs to (id, name, their role, member count). Use it to find the householdId that create_recipe needs when the user is in more than one.",
      inputSchema: z.object({}),
    },
    async (_args, ctx) => {
      const did = await callerDid(ctx);
      if (!did) return text(NOT_SIGNED_IN, true);
      const households = await listHouseholdsForDid(getDb(), did);
      if (households.length === 0) return text(NO_HOUSEHOLD_MESSAGE, true);
      return text(JSON.stringify(households, null, 2));
    },
  );
}
