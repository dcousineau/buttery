import { commitImportChunk, failImportSession, finalizeImportSession, getImportComparison, openImportSession, probeImportDuplicates } from "#/server/recipe-import";
import type { ImportApi } from "./contracts.ts";

/**
 * The one place the import client touches the server (§7).
 *
 * Every other client module — the machine, the commit driver, every component — depends on
 * the `ImportApi` port in `./contracts.ts`, so the whole flow runs in a unit test against a
 * fake with no network and no database (§16.22), and swapping the transport is one file.
 *
 * The calls are otherwise unwrapped on purpose: no retry, no caching, no error translation.
 * Retry belongs to the commit driver, which knows which chunk failed and what has already
 * landed (§7.5), and turning a thrown server error into UI copy belongs to the screen that
 * has to show it (§10.3).
 */
export const importApi: ImportApi = {
  openSession: (data) => openImportSession({ data }),
  probeDuplicates: (data) => probeImportDuplicates({ data }),
  getComparison: (data) => getImportComparison({ data }),
  commitChunk: (data) => commitImportChunk({ data }),
  finalizeSession: (data) => finalizeImportSession({ data }),
  // Best-effort telemetry: the session is already lost, and a second failure here must not
  // replace the message the user is about to be shown.
  failSession: async (data) => {
    await failImportSession({ data }).catch(() => undefined);
  },
};
