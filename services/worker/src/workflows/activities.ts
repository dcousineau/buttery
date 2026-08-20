import * as atprotoSync from "#/workflows/atproto-sync/activities.ts";
import * as demo from "#/workflows/demo/activities.ts";

/**
 * Every activity implementation, in one flat object — the shape
 * `Worker.create({ activities })` wants.
 *
 * Flat because Temporal identifies an activity by a single string name, the one
 * `proxyActivities` looks up from inside a workflow. That makes names a shared
 * namespace across every workflow in the service, so they are merged here with a
 * collision check rather than a spread: two workflows that both export
 * `enumerate` would otherwise silently register one implementation for both, and
 * the loser's runs would quietly do the wrong work.
 */

type ActivityModule = Record<string, unknown>;

function merge(modules: Record<string, ActivityModule>): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const owner: Record<string, string> = {};
  for (const [source, module] of Object.entries(modules)) {
    for (const [name, value] of Object.entries(module)) {
      if (typeof value !== "function") continue;
      if (name in merged) {
        throw new Error(`Duplicate activity "${name}": defined by both ${owner[name]} and ${source}. Activity names are global — rename one.`);
      }
      merged[name] = value;
      owner[name] = source;
    }
  }
  return merged;
}

export const activities = merge({ "atproto-sync": atprotoSync, demo });

export const ACTIVITY_NAMES: readonly string[] = Object.keys(activities);
