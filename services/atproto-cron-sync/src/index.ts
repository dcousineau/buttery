// Public entry point for the package. `src/main.ts` is the CLI (one sweep, then
// exit); everything a *caller* needs is re-exported here so the sweep can also
// be driven from somewhere else — today that is the `atproto-sync` BullMQ
// pipeline in @buttery/pipeline, which runs it on a schedule.
//
// Nothing else in `src/` is part of the contract. Internal modules keep talking
// to each other through the `#/*` subpath imports declared in package.json.

export { loadConfig, RECIPE_COLLECTION, type Config } from "#/config.ts";
export { closeDb } from "#/db.ts";
export { runSweep, type SweepSummary } from "#/sweep.ts";
