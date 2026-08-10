import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { DroppedFile, RecipeImporter } from "@buttery/recipe-extract/import";
import type { ImporterId } from "#/lib/recipe-import-ids";
import { importApi } from "./api.ts";
import { type ComparisonResult, type ImportApi, type ProbeVerdict, PROBE_CHUNK_SIZE, COMPARISON_CHUNK_SIZE } from "./contracts.ts";
import { createLocalImageCache, type LocalImageCache } from "./image-cache.ts";
import {
  commitProgress,
  finalizeOutcome,
  importEventForWorkerMessage,
  initialState,
  nextCommitChunk,
  probeItems,
  reduce,
  type ImportEvent,
  type ImportState,
  type StageProgress,
} from "./machine.ts";
import type { ImportWorkerEvent, ImportWorkerRequest } from "./worker-protocol.ts";

/**
 * The effect half of the import client (plan §9).
 *
 * `machine.ts` decides what is true; this hook is everything that talks to the outside
 * world — the parse worker, the five server functions, and the object URLs behind the local
 * image previews. Keeping them apart is what lets the whole flow, failed chunk and retry
 * included, be unit-tested as plain function calls.
 *
 * Three driver effects, each guarded by a ref so React's double-invoked effects (and any
 * re-render mid-flight) cannot send the same request twice:
 *
 *   1. **parse** — imperative, started by `start()`: one worker per drop, terminated on
 *      cancel, on a second drop, and on unmount.
 *   2. **probe** — runs once the parse lands and the session is open, in chunks of 200.
 *   3. **commit** — chunks of 25, resumable: a failed chunk stops the loop and `retry()`
 *      re-sends only the items that still have no result (§7.5).
 */

/** Injectable for tests; production callers get the real server functions. */
export interface UseImportSessionOptions {
  importer: RecipeImporter;
  api?: ImportApi;
  /** Overridable so a test can drive the pipeline without a worker (§16.22). */
  createWorker?: () => Worker;
}

export interface ComparisonStore {
  /** recipeId → body, for everything fetched so far. Ids the household cannot see stay absent. */
  entries: ComparisonResult;
  loading: boolean;
  error: string | null;
  /** Fetches only ids not already held. Safe to call on every render of a compare view. */
  load: (recipeIds: readonly string[]) => void;
}

export interface UseImportSession {
  state: ImportState;
  dispatch: (event: ImportEvent) => void;
  importer: RecipeImporter;
  /** Begin a run. `fileName` is what the user handed us — the dropped folder's name. */
  start: (files: DroppedFile[], fileName: string | null) => void;
  /** Abandon everything in flight and return to the drop screen. */
  cancel: () => void;
  /** Retry the chunk that failed, without re-sending what already committed (§7.5). */
  retryChunk: () => void;
  /** An object URL for a candidate's local image, or null (§11). Revoked by this hook. */
  localImageUrl: (localImagePath: string | null) => string | null;
  comparisons: ComparisonStore;
  /**
   * The throttled `aria-live="polite"` text (§10.4). Updated at stage and chunk boundaries
   * only — announcing every tick makes the flow unusable with a screen reader running.
   */
  announcement: string;
}

/** Default worker factory. Vite rewrites this `new URL(...)` form at build time. */
function defaultCreateWorker(): Worker {
  return new Worker(new URL("./parse.worker.ts", import.meta.url), { type: "module" });
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useImportSession({ importer, api = importApi, createWorker = defaultCreateWorker }: UseImportSessionOptions): UseImportSession {
  const [state, dispatch] = useReducer(reduce, importer.id, initialState);

  const workerRef = useRef<Worker | null>(null);
  const imagesRef = useRef<LocalImageCache | null>(null);
  const probeRunRef = useRef(false);
  const commitChunkRef = useRef<number | null>(null);
  const finalizeRef = useRef(false);
  // The reducer is the source of truth, but the async drivers need the *latest* state at
  // await boundaries, where a closure would be stale. Written in an effect rather than during
  // render — a ref mutated mid-render is torn under concurrent rendering — and declared
  // before the driver effects so it is already current when they run.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  const teardown = useCallback(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
    imagesRef.current?.dispose();
    imagesRef.current = null;
    probeRunRef.current = false;
    commitChunkRef.current = null;
    finalizeRef.current = false;
  }, []);

  useEffect(() => teardown, [teardown]);

  // --- parse ------------------------------------------------------------

  const start = useCallback(
    (files: DroppedFile[], fileName: string | null) => {
      teardown();
      dispatch({ type: "drop_accepted", fileName });
      imagesRef.current = createLocalImageCache(files);

      // Opening the session and parsing are independent; run them at once so the user is
      // not waiting on a round trip before the bar moves. The probe effect waits for both.
      // `RecipeImporter.id` is a plain string on the seam (an importer is not allowed to
      // know the app's id union); the registry asserts key and id agree at module load, so
      // every id reaching here is a registered one and the server re-validates regardless.
      const importerId = importer.id as ImporterId;
      void api
        .openSession({ importer: importerId, fileName, totalCount: files.length })
        .then((session) => dispatch({ type: "session_opened", sessionId: session.sessionId }))
        .catch((error: unknown) => dispatch({ type: "failed", failure: { code: "session_failed", message: messageOf(error), retryable: true } }));

      const worker = createWorker();
      workerRef.current = worker;
      worker.addEventListener("message", (event: MessageEvent<ImportWorkerEvent>) => {
        const message = event.data;
        // What the message *means* is `machine.ts`'s call and is unit-tested there; what it
        // *costs* — a terminated worker, a §13 failure report — is this listener's.
        dispatch(importEventForWorkerMessage(message));
        if (message.type === "done") {
          worker.terminate();
          if (workerRef.current === worker) workerRef.current = null;
        } else if (message.type === "error") {
          const sessionId = stateRef.current.sessionId;
          if (sessionId) void api.failSession({ sessionId, stage: "parse", message: message.message });
        }
      });
      // A worker that dies outright (a syntax error in a chunk it lazily loaded, an OOM)
      // fires `error`, not a message — without this the reading screen spins forever.
      worker.addEventListener("error", (event) => {
        dispatch({ type: "failed", failure: { code: "unknown", message: event.message || "The reader stopped unexpectedly.", retryable: true } });
      });

      const request: ImportWorkerRequest = { type: "start", importerId: importer.id, files };
      worker.postMessage(request);
    },
    [api, createWorker, importer.id, teardown],
  );

  const cancel = useCallback(() => {
    teardown();
    dispatch({ type: "reset" });
  }, [teardown]);

  // --- probe ------------------------------------------------------------

  const probeStage = state.phase === "reading" && state.progress?.stage === "probe";
  useEffect(() => {
    if (!probeStage || !state.sessionId || probeRunRef.current) return;
    if (state.items.length === 0) {
      // Nothing parsed cleanly: skip the round trip and let review show the failure list.
      probeRunRef.current = true;
      dispatch({ type: "probe_complete", verdicts: [] });
      return;
    }
    probeRunRef.current = true;
    const sessionId = state.sessionId;

    void (async () => {
      try {
        const chunks = chunk(probeItems(stateRef.current), PROBE_CHUNK_SIZE);
        const verdicts: ProbeVerdict[] = [];
        let done = 0;
        for (const items of chunks) {
          const result = await api.probeDuplicates({ sessionId, items });
          verdicts.push(...result);
          done += items.length;
          dispatch({ type: "progress", progress: { stage: "probe", done, total: stateRef.current.items.length } });
        }
        dispatch({ type: "probe_complete", verdicts });
      } catch (error) {
        const message = messageOf(error);
        dispatch({ type: "failed", failure: { code: "probe_failed", message, retryable: true } });
        void api.failSession({ sessionId, stage: "probe", message });
      }
    })();
  }, [api, probeStage, state.items.length, state.sessionId]);

  // --- commit -----------------------------------------------------------

  useEffect(() => {
    if (state.phase !== "committing" || !state.commit || state.commit.chunkError) return;
    const sessionId = state.sessionId;
    if (!sessionId) return;

    const next = nextCommitChunk(state);

    if (!next) {
      if (finalizeRef.current) return;
      finalizeRef.current = true;
      void (async () => {
        try {
          await api.finalizeSession({ sessionId, outcome: finalizeOutcome(stateRef.current) });
        } catch {
          // §7.7 is idempotent and the recipes are already saved; a failed finalize costs
          // the session row's `complete` status and the telemetry event, not the user's
          // import. Showing them an error here would be a lie about what happened.
        }
        dispatch({ type: "finalized" });
      })();
      return;
    }

    if (commitChunkRef.current === next.index) return;
    commitChunkRef.current = next.index;
    void (async () => {
      try {
        const results = await api.commitChunk({ sessionId, items: next.items });
        dispatch({ type: "chunk_complete", results });
      } catch (error) {
        dispatch({ type: "chunk_failed", message: messageOf(error) });
      } finally {
        commitChunkRef.current = null;
      }
    })();
  }, [api, state]);

  const retryChunk = useCallback(() => {
    commitChunkRef.current = null;
    dispatch({ type: "chunk_retry" });
  }, []);

  // --- local images -----------------------------------------------------

  const localImageUrl = useCallback((localImagePath: string | null) => {
    if (!localImagePath) return null;
    return imagesRef.current?.get(localImagePath) ?? null;
  }, []);

  // --- comparisons ------------------------------------------------------

  const [comparisonEntries, setComparisonEntries] = useState<ComparisonResult>({});
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [comparisonError, setComparisonError] = useState<string | null>(null);
  // Ids already fetched — including ones that came back absent, so an unreadable id is not
  // re-requested on every render (§7.6: absent is a normal answer, not an error).
  const requestedRef = useRef(new Set<string>());

  const loadComparison = useCallback(
    (recipeIds: readonly string[]) => {
      const sessionId = stateRef.current.sessionId;
      if (!sessionId) return;
      const missing = recipeIds.filter((id) => id && !requestedRef.current.has(id));
      if (missing.length === 0) return;
      for (const id of missing) requestedRef.current.add(id);

      setComparisonLoading(true);
      setComparisonError(null);
      void (async () => {
        try {
          for (const ids of chunk(missing, COMPARISON_CHUNK_SIZE)) {
            const result = await api.getComparison({ sessionId, recipeIds: ids });
            setComparisonEntries((prev) => ({ ...prev, ...result }));
          }
        } catch (error) {
          // A failed comparison is not a failed import: the user loses the side-by-side,
          // not their recipes, so it reports locally and the session stays alive (§10.3).
          for (const id of missing) requestedRef.current.delete(id);
          setComparisonError(messageOf(error));
        } finally {
          setComparisonLoading(false);
        }
      })();
    },
    [api],
  );

  const comparisons = useMemo<ComparisonStore>(
    () => ({ entries: comparisonEntries, loading: comparisonLoading, error: comparisonError, load: loadComparison }),
    [comparisonEntries, comparisonLoading, comparisonError, loadComparison],
  );

  // --- live-region text -------------------------------------------------

  const announcement = useAnnouncement(state);

  return { state, dispatch, importer, start, cancel, retryChunk, localImageUrl, comparisons, announcement };
}

/** Announcements land on chunk boundaries — every 25 items — and on every stage change. */
const ANNOUNCE_EVERY = 25;

function stageLabel(stage: StageProgress["stage"], done: number, total: number): string {
  switch (stage) {
    case "read":
      // Indeterminate by construction: the walk has no total until it ends, so the text is
      // constant and the region announces once rather than counting up at a screen reader.
      return "Reading your recipe box.";
    case "parse":
      return `Reading your recipes. ${done} of ${total} read.`;
    case "keys":
      return `Checking your recipes. ${done} of ${total} checked.`;
    case "probe":
      return `Looking for recipes you already have. ${done} of ${total} checked.`;
  }
}

/**
 * Throttled live-region text (§10.4).
 *
 * The value only *changes* at a boundary, so the region is not re-announced on every tick
 * even though it re-renders on every one.
 */
function useAnnouncement(state: ImportState): string {
  return useMemo(() => {
    if (state.phase === "reading" && state.progress) {
      const { stage, done, total } = state.progress;
      if (total === null) return stageLabel(stage, 0, 0);
      const at = Math.min(Math.floor(done / ANNOUNCE_EVERY) * ANNOUNCE_EVERY, total);
      return stageLabel(stage, at, total);
    }
    if (state.phase === "committing") {
      const { done, total } = commitProgress(state);
      const at = Math.min(Math.floor(done / ANNOUNCE_EVERY) * ANNOUNCE_EVERY, total);
      if (state.commit?.chunkError) return "Saving stopped. Nothing already saved is lost.";
      return `Saving your recipes. ${at} of ${total} saved.`;
    }
    if (state.phase === "review") return "Your recipes are ready to review.";
    if (state.phase === "done") return "Import finished.";
    if (state.phase === "failed") return state.error?.message ?? "The import stopped.";
    return "";
  }, [state]);
}
