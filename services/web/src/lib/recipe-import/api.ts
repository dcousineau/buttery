import { importTransport } from "#/lib/api";
import type { ImportApi } from "./contracts.ts";

/**
 * The import flow's binding to the app-wide transport port (§7).
 *
 * Every other client module — the machine, the commit driver, every component — depends on
 * the `ImportApi` port in `./contracts.ts`, so the whole flow runs in a unit test against a
 * fake with no network and no database (§16.22), and swapping the transport is one file.
 *
 * That file used to be this one. The offline plan (§4.3) widened the same idea to the whole
 * app, so the server functions now live behind `src/lib/api/transport.ts` and this is the
 * adapter that shapes them into `ImportApi` — a rename of the seam, not a move of it.
 *
 * The calls are otherwise unwrapped on purpose: no retry, no caching, no error translation.
 * Retry belongs to the commit driver, which knows which chunk failed and what has already
 * landed (§7.5), and turning a thrown server error into UI copy belongs to the screen that
 * has to show it (§10.3).
 */
export const importApi: ImportApi = {
  openSession: importTransport.openSession,
  probeDuplicates: importTransport.probeDuplicates,
  getComparison: importTransport.getComparison,
  commitChunk: importTransport.commitChunk,
  finalizeSession: importTransport.finalizeSession,
  // Best-effort telemetry: the session is already lost, and a second failure here must not
  // replace the message the user is about to be shown.
  failSession: async (data) => {
    await importTransport.failSession(data).catch(() => undefined);
  },
};
