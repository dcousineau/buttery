import type {
  CommitChunkInput,
  CommitItem,
  CommitItemResult,
  ComparisonInput,
  ComparisonResult,
  ExistingRef,
  FinalizeInput,
  FinalizeResult,
  ImportFailureStage,
  ImportSessionView,
  OpenImportSessionInput,
  ProbeInput,
  ProbeItem,
  ProbeVerdict,
} from "#/server/recipe-import";

/**
 * The client's view of the §7 server contracts, and the port it speaks them through.
 *
 * **Every shape is imported, not restated.** `services/web/src/server/recipe-import.ts` is
 * the §7 implementation and owns these types; a parallel copy here would be a second place
 * for a field to be added, and the compiler would not notice the drift until something
 * silently stopped being sent. `import type` is erased at build time, so nothing of the
 * server module reaches the client bundle through this file.
 *
 * Why a port and not direct calls: the state machine, the commit driver, and their unit
 * tests need to run the whole pipeline with no network and no database, and acceptance
 * §16.22 wants a fixture importer driven parse → probe → commit "without editing a single
 * pipeline module". An interface, filled in by `./api.ts` with the real `createServerFn`
 * handlers, gives both and keeps the client↔server coupling in exactly one file.
 */

export type {
  CommitChunkInput,
  CommitItem,
  CommitItemResult,
  ComparisonInput,
  ComparisonResult,
  ExistingRef,
  FinalizeInput,
  FinalizeResult,
  ImportFailureStage,
  ImportSessionView,
  OpenImportSessionInput,
  ProbeInput,
  ProbeItem,
  ProbeVerdict,
};

export type { FinalizeOutcome } from "#/server/recipe-import";

/**
 * The verdict names.
 *
 * Five, not §6.3's four: the server also reports `dupe_in_batch` for a second item claiming a
 * key an earlier item already took, because the collapse is a *client* behaviour it cannot
 * assume ran.
 *
 * **It comes back even though this client does collapse**, because the two sides claim
 * different key spaces. `machine.ts`'s `parse_complete` collapses on one key per item — the
 * URL key when there is one, the fingerprint otherwise — while `runProbeImportDuplicates`
 * claims *both* for every item it lets through. Two entries with different URLs and identical
 * name + ingredients therefore have different client keys (`u:a`, `u:b`) and both survive the
 * collapse, and the server hands the second one `dupe_in_batch` off the shared fingerprint.
 * A Paprika export with the same recipe saved from two sites is exactly that shape.
 *
 * So the machine handles the verdict for real rather than asserting it away: it keeps
 * `duplicateOfClientId`, lists the row under "Already yours" skipped by default, and says it
 * duplicates another recipe *in this folder* instead of claiming a household match it does
 * not have.
 */
export type VerdictKind = ProbeVerdict["verdict"];

/** Chunk size 25 (§7.2, D11) — what the commit driver splits on, and a server-side 400 above. */
export const COMMIT_CHUNK_SIZE = 25;

/** §7.1 is sized for one call per ~200 items; the client chunks at that size. */
export const PROBE_CHUNK_SIZE = 200;

/** `getImportComparison` takes ≤ 25 recipe ids per call (§7.6). */
export const COMPARISON_CHUNK_SIZE = 25;

/**
 * Everything the client needs from the server, and nothing else.
 *
 * `probeDuplicates` and `commitChunk` take one chunk's worth and return the elements bare,
 * exactly as the server functions do — the chunking loops live in the client (§7.1, §7.2),
 * not behind this interface, because both loops have UI (progress, retry) attached to their
 * boundaries.
 */
export interface ImportApi {
  openSession(input: OpenImportSessionInput): Promise<ImportSessionView>;
  probeDuplicates(input: ProbeInput): Promise<ProbeVerdict[]>;
  getComparison(input: ComparisonInput): Promise<ComparisonResult>;
  commitChunk(input: CommitChunkInput): Promise<CommitItemResult[]>;
  finalizeSession(input: FinalizeInput): Promise<FinalizeResult>;
  /** §13's terminal failure. Best-effort: a failed `failSession` must not mask the failure. */
  failSession(input: { sessionId: string; stage: ImportFailureStage; message: string }): Promise<void>;
}
