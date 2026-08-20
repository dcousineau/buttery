import type { Pool } from "pg";
import { createAtprotoSyncActivities } from "#/workflows/atproto-sync/activities.ts";
import { demoActivities } from "#/workflows/demo/activities.ts";

/**
 * Every activity implementation, in the flat object `Worker.create` wants.
 *
 * Activities that need something long-lived get it here rather than reaching for
 * a module-level singleton: `worker.ts` owns the database pool, passes it in, and
 * closes it on shutdown. That is what keeps the activities themselves plain
 * functions over their dependencies — and what lets a test call one with a pool
 * of its own.
 */
export interface ActivityDeps {
  pool: Pool;
}

export function createActivities(deps: ActivityDeps) {
  return {
    ...createAtprotoSyncActivities(deps),
    ...demoActivities,
  };
}
