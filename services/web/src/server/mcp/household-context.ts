import type { HouseholdSummary } from "#/lib/api/types";

export type HouseholdChoice = { ok: true; household: HouseholdSummary } | { ok: false; message: string };

export const NO_HOUSEHOLD_MESSAGE = "This account isn't in a household yet. The user needs to finish onboarding in person, in the Buttery app, before you can continue.";

/**
 * Which household an agent's write lands in. An MCP call has no "active household"
 * the way a browser session does, so the agent has to name one, and the only
 * ambiguity worth bothering the user about is a real one: two or more households.
 *
 * Every refusal is written for the agent to act on, not just to read.
 */
export function chooseHousehold(households: readonly HouseholdSummary[], requestedId?: string | null): HouseholdChoice {
  if (households.length === 0) {
    return { ok: false, message: NO_HOUSEHOLD_MESSAGE };
  }
  if (requestedId) {
    const household = households.find((h) => h.id === requestedId);
    if (household) return { ok: true, household };
    return { ok: false, message: `householdId "${requestedId}" isn't one of this user's households. Call list_households and use one of those ids.` };
  }
  if (households.length === 1) return { ok: true, household: households[0] };
  return {
    ok: false,
    message: "This user is in more than one household. Call list_households, ask the user which one to use, and pass its id as householdId for the rest of this chat.",
  };
}
