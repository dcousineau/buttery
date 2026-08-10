import { commitChunks, commitProgress, type ImportState } from "#/lib/recipe-import/machine.ts";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Button } from "#/components/ui/button";
import { Progress } from "#/components/ui/progress";
import { useScreenHeading } from "./useScreenHeading.ts";

/**
 * "Filling your box…" (plan §10.1, §7.5).
 *
 * The import is written in chunks of 25 and each chunk is a separate transaction, so a
 * failure part-way through leaves everything before it saved. That is a *feature* and the
 * screen says so in both states: the alert while it runs, and the retry copy when a chunk
 * fails. Retrying re-sends only the items with no result yet, so pressing it twice cannot
 * double-write.
 */
export function ImportCommittingScreen({ state, onRetry, onCancel }: { state: ImportState; onRetry: () => void; onCancel: () => void }) {
  const heading = useScreenHeading<HTMLHeadingElement>();
  const { done, total } = commitProgress(state);
  const chunks = commitChunks(state.commit?.order ?? []).length;
  const chunkNumber = Math.min(chunks, Math.floor(done / 25) + 1);
  const failed = state.commit?.chunkError ?? null;

  return (
    <div className="flex flex-1 overflow-auto px-6 py-10">
      <div className="m-auto flex w-[min(560px,100%)] flex-col gap-4">
        <h1 ref={heading} tabIndex={-1} className="display-title m-0 text-[2rem]/[1.1] outline-none">
          {failed ? "Saving stopped" : "Filling your box…"}
        </h1>

        <Progress
          value={done}
          max={Math.max(total, 1)}
          label={`${done} of ${total} saved`}
          aria-label="Saving your recipes"
          variant="secondary"
          className="h-8 rounded-xl border-2 border-border bg-card shadow-pop-sm"
        />

        <p className="m-0 text-base font-semibold">
          {done} of {total} saved{chunks > 0 ? ` · batch ${chunkNumber} of ${chunks}` : ""}
        </p>

        {failed ? (
          <Alert variant="destructive">
            <AlertTitle>That batch didn't save</AlertTitle>
            <AlertDescription>
              {failed} — the {done} already saved are safe in your box. Trying again picks up only what's missing.
            </AlertDescription>
          </Alert>
        ) : (
          <Alert>
            <AlertTitle>Keep this tab open</AlertTitle>
            <AlertDescription>Closing it stops the import where it stands. Nothing already saved is lost, and running it again picks up only what's missing.</AlertDescription>
          </Alert>
        )}

        {failed ? (
          <div className="flex flex-wrap gap-2">
            <Button onClick={onRetry}>Try that batch again</Button>
            <Button variant="ghost" onClick={onCancel}>
              Stop here
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
