import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import type { DroppedFile } from "@buttery/recipe-extract/import";
import { requireActiveHousehold } from "#/lib/api";
import { DEFAULT_IMPORTER_ID, requireImporter } from "#/lib/recipe-import/importers.ts";
import { useImportSession } from "#/lib/recipe-import/useImportSession.ts";
import { ImportCommittingScreen } from "#/components/recipes/import/ImportCommittingScreen";
import { ImportDoneScreen } from "#/components/recipes/import/ImportDoneScreen";
import { ImportDropScreen } from "#/components/recipes/import/ImportDropScreen";
import { ImportReadingScreen } from "#/components/recipes/import/ImportReadingScreen";
import { ImportReviewScreen } from "#/components/recipes/import/ImportReviewScreen";
import { seo } from "#/lib/seo";

/**
 * Bulk import (`/household/recipes/import`, plan §9, §10).
 *
 * `recipes_` (trailing underscore) keeps the path but escapes the recipes master–detail
 * layout: this screen owns the viewport for the length of the flow, and loading the whole
 * ledger behind it would be 341 rows of wasted work at exactly the moment the tab is busy
 * parsing 341 files.
 *
 * The route resolves **one** importer and hands it down (§9, §17). Phase 1 ships a single
 * importer, and a chooser with one option is worse than no chooser; when the second lands,
 * this constant becomes a picker and nothing below it changes, because every screen from here
 * down speaks `RecipeImporter` and `ImportCandidate` and none of them names an app (§2.5).
 */
export const Route = createFileRoute("/household/recipes_/import")({
  loader: async () => requireActiveHousehold(),
  head: () => ({ meta: seo({ title: "Import recipes · Buttery", description: "Bring a whole recipe box into Buttery." }) }),
  component: ImportPage,
});

function ImportPage() {
  const { name } = Route.useLoaderData();
  const importer = useMemo(() => requireImporter(DEFAULT_IMPORTER_ID), []);
  const session = useImportSession({ importer });
  const { state, dispatch, announcement } = session;
  const [fileCount, setFileCount] = useState(0);

  // A reload mid-commit strands the user with a half-filled box and no way to know where it
  // stopped. The browser only allows the generic prompt, which is enough: it turns a reflex
  // ⌘R into a decision. Nothing already saved is ever lost — §7.5's chunks are independent —
  // so this is a courtesy, not a correctness guard.
  useEffect(() => {
    if (state.phase !== "committing") return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [state.phase]);

  function onFiles(files: DroppedFile[], folderName: string | null) {
    if (files.length === 0) {
      dispatch({ type: "failed", failure: { code: "not_recognized", message: "That drop had no files in it.", retryable: true } });
      return;
    }
    setFileCount(files.length);
    session.start(files, folderName);
  }

  // The shell's `main` is `overflow-hidden`, but every wrapper above it is content-sized, so a
  // 341-row pane simply grows the document and takes the rail, the header, and the primary
  // button with it. This screen owns the viewport for the length of the flow (§10.1), so it
  // states its own height rather than inheriting one that isn't bounded: everything below
  // scrolls inside its pane, and the footer's single primary button is always on screen.
  return (
    <div className="flex h-[calc(100svh-var(--header-height,4rem))] flex-none flex-col overflow-hidden">
      {/* The one live region for the whole flow. `useImportSession` throttles what it says to
          stage and chunk boundaries — announcing every tick of a 341-item parse makes the
          screen unusable with a screen reader running (§10.4). */}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>

      {state.phase === "drop" || state.phase === "failed" ? (
        <ImportDropScreen importer={importer} householdName={name} failure={state.error} onFiles={onFiles} />
      ) : state.phase === "reading" ? (
        <ImportReadingScreen importerLabel={importer.label} fileName={state.fileName} fileCount={fileCount} progress={state.progress} onCancel={session.cancel} />
      ) : state.phase === "review" ? (
        <ImportReviewScreen session={session} onCommit={() => dispatch({ type: "commit_start" })} />
      ) : state.phase === "committing" ? (
        <ImportCommittingScreen state={state} onRetry={session.retryChunk} onCancel={() => dispatch({ type: "finalized" })} />
      ) : (
        <ImportDoneScreen state={state} importerLabel={importer.label} householdName={name} onRestart={session.cancel} />
      )}
    </div>
  );
}
