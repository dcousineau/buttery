/**
 * The port surface. **Import from `#/lib/api`, never from `#/server/**`.**
 *
 * That one rule (offline plan §4.3) buys three things at once:
 *
 * - **Offline.** A read that goes through `queries.ts` is cached, persisted to
 *   IndexedDB, refetched on reconnect and mirrored ahead of time. A read that
 *   bypasses it is none of those. The boundary has to be somewhere legible, and
 *   "does it come from the port?" is legible.
 * - **The API service (§7).** Every call site already speaks plain functions with
 *   natural arguments, so extracting a REST service is a rewrite of
 *   `transport.ts` and nothing else.
 * - **Bundle hygiene.** One module reaches into `#/server/**`, so "did this
 *   component just drag a server module into the client bundle?" has one place
 *   to look rather than fifty.
 *
 * `transport.ts` is re-exported wholesale because a mutation that has no
 * `mutationOptions` factory yet (household admin, invites, authoring, import)
 * still has to be callable — it just does not get the offline machinery. Reads
 * that matter offline are the ones with a factory in `queries.ts`.
 */

export * from "./transport";
export * from "./queries";
export * from "./mutations";
export { keys, OFFLINE_FALLBACK_KEYS } from "./keys";
export { isForbidden, isOffline, isSessionExpired, shouldRetry } from "./errors";
export type * from "./types";
