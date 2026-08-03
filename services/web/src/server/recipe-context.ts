/**
 * The authenticated-mutation prologue shared by the recipe server functions:
 * resolve the caller's DID + active household, redirecting to /login when there
 * is no session and throwing NotAMemberError when no household is active. Mirrors
 * the private `activeContext()` in `server/household-recipes.ts` (extracted so the
 * create/publish flow in `server/recipes-write.ts` can reuse it). Server-only.
 */
export async function activeContext(): Promise<{ did: string; householdId: string }> {
  const { getServerSession } = await import("./household/session");
  const { NotAMemberError } = await import("./household/errors");
  const { redirect } = await import("@tanstack/react-router");
  const session = await getServerSession();
  const did = session?.user.did ?? null;
  if (!did) throw redirect({ to: "/login" });
  const householdId = session?.session.active_household_id ?? null;
  if (!householdId) throw new NotAMemberError();
  return { did, householdId };
}
