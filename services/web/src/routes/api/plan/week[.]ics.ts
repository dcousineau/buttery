import { createFileRoute } from "@tanstack/react-router";
import { buildWeekIcs, icsFilename } from "#/lib/plan/ics";
import { parseWeekParam } from "#/lib/plan/week";
import { siteUrl } from "#/lib/seo";

/**
 * Authenticated `.ics` download of one planned week (plan §9.3 / D13).
 *
 * There is deliberately NO token URL and NO public endpoint: a household's plan
 * is private (§2.1), so the export is session-gated exactly like every other
 * read. That is also why this is a route rather than a server function — the
 * browser has to be able to hit it with a plain link and get a file back.
 *
 * The household id comes from `session.active_household_id`, never from a query
 * param; `?week=` is the only client input, it is validated with
 * `parseWeekParam`, and `readMealPlanWeek` re-snaps it with `weekStartFor`
 * against the household's `week_start_day` (§5) — so a caller can neither read
 * another household nor pin the export to a mid-week offset.
 *
 * Server-only dependencies (session, db, the week read) are pulled in with
 * dynamic `import()` inside the handler, matching `src/server/*`: nothing here
 * drags `pg` toward the client bundle.
 */

function problem(status: number, message: string): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store" },
  });
}

async function handler({ request }: { request: Request }): Promise<Response> {
  const { getServerSession } = await import("#/server/household/session");
  const { assertMember } = await import("#/server/authz");
  const { readMealPlanWeek } = await import("#/server/meal-plan");
  const { getDb } = await import("#/lib/db");

  const session = await getServerSession(request);
  const did = session?.user.did ?? null;
  if (!did) return problem(401, "Sign in to download your meal plan.");
  const householdId = session?.session.active_household_id ?? null;
  if (!householdId) return problem(403, "No active household.");

  // Membership is re-checked here even though `readMealPlanWeek`'s scoped join
  // already enforces it: without this, a stale `active_household_id` would
  // silently download an empty calendar instead of saying what went wrong.
  try {
    await assertMember(did, householdId);
  } catch {
    return problem(403, "You are not a member of this household.");
  }

  // `?week=` is a hint. Malformed values fall back to the current week rather
  // than erroring, matching `/plan`'s behaviour (§15.3).
  const week = parseWeekParam(new URL(request.url).searchParams.get("week") ?? undefined) ?? undefined;
  const planWeek = await readMealPlanWeek(getDb(), did, householdId, week);

  const body = buildWeekIcs(planWeek, { siteUrl: siteUrl() });

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="${icsFilename(planWeek.weekStart)}"`,
      // Private household data: never let a shared cache hold on to it.
      "cache-control": "private, no-store",
    },
  });
}

export const Route = createFileRoute("/api/plan/week.ics")({
  server: {
    handlers: {
      GET: handler,
    },
  },
});
