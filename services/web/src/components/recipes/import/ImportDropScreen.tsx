import { useId, useRef, useState } from "react";
import type { DroppedFile, RecipeImporter } from "@buttery/recipe-extract/import";
import { filesFromDataTransfer, filesFromInput } from "#/lib/recipe-import/drop-files.ts";
import type { ImportFailure } from "#/lib/recipe-import/machine.ts";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { cn } from "#/lib/utils.ts";
import { useScreenHeading } from "./useScreenHeading.ts";

/**
 * The launch screen — **the one importer-specific screen** (plan §9, §10).
 *
 * Every word on it comes from `importer.dropCopy`, so this component renders a launch point
 * for any importer without naming one. Adding Mela means writing Mela's `dropCopy`; this
 * file does not change.
 */

/** Copy for each way a drop can be rejected (§10.3: the comp draws no error states). */
const FAILURE_COPY: Record<string, { title: string; body: string }> = {
  too_large: { title: "That folder is too big", body: "Imports are capped at 200 MB — far more than a full recipe box. Try exporting again without the extras." },
  too_many_entries: { title: "That folder holds too many files", body: "Imports are capped at 5,000 files. That is many times a full recipe box, so this is probably not an export folder." },
  path_escape: { title: "We couldn't read that folder safely", body: "One of the file names in it points outside the folder, so nothing was read." },
  not_recognized: { title: "That doesn't look like an export", body: "Nothing in the folder matched what this importer expects. Check that you picked the folder itself, not the file inside it." },
  probe_failed: { title: "We couldn't check your box", body: "Your recipes were read fine, but checking them against what you already have failed. Nothing was saved." },
  session_failed: { title: "We couldn't start the import", body: "Nothing was read and nothing was saved. Try again in a moment." },
  unknown: { title: "Something went wrong reading that folder", body: "Nothing was saved. Try again, or pick the folder a second time." },
};

export function ImportDropScreen({
  importer,
  householdName,
  failure,
  onFiles,
}: {
  importer: RecipeImporter;
  householdName: string;
  failure: ImportFailure | null;
  onFiles: (files: DroppedFile[], folderName: string | null) => void;
}) {
  const heading = useScreenHeading<HTMLHeadingElement>();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const inputId = useId();
  const copy = importer.dropCopy;
  const error = failure ? (FAILURE_COPY[failure.code] ?? FAILURE_COPY.unknown) : null;

  // `{household}` is a token rather than a slot so the importer's sentence stays one
  // translatable string and the importer never learns what a household is (§2.5).
  const [ledeBefore, ledeAfter] = copy.lede.split("{household}");

  async function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    setReading(true);
    try {
      const dropped = await filesFromDataTransfer(event.dataTransfer);
      onFiles(dropped.files, dropped.rootName);
    } finally {
      setReading(false);
    }
  }

  return (
    <div className="flex flex-1 overflow-auto px-6 py-10">
      <div className="m-auto flex w-[min(680px,100%)] flex-col gap-5">
        <div className="flex flex-col items-start">
          <Badge variant="secondary" size="xs" className="mb-3">
            Bulk import
          </Badge>
          <h1 ref={heading} tabIndex={-1} className="display-title m-0 text-4xl/[1.1] outline-none">
            {copy.title}
          </h1>
          <p className="mt-3 mb-0 text-base text-pretty text-muted-foreground">
            {ledeBefore}
            {ledeAfter === undefined ? null : <strong className="text-foreground">{householdName}</strong>}
            {ledeAfter}
          </p>
        </div>

        {error ? (
          <Alert variant="destructive">
            <AlertTitle>{error.title}</AlertTitle>
            <AlertDescription>{error.body}</AlertDescription>
          </Alert>
        ) : null}

        {/* The drag target is a region, not a control: the accessible way in is the button
            inside it, which is a real button in the tab order. Dropping is a mouse-only
            gesture by nature, so it never becomes the only path (§10.4). */}
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => void handleDrop(event)}
          className={cn(
            "flex flex-col items-center gap-3.5 rounded-2xl border-2 border-dashed border-border bg-card px-6 py-10 transition-colors",
            dragging && "border-primary bg-accent",
          )}
        >
          <div aria-hidden="true" className="h-11 w-14 rounded-lg border-2 border-border bg-background shadow-pop-sm" />
          <div className="text-[1.0625rem] font-semibold">{copy.heading}</div>
          <div className="text-center text-[0.8125rem] text-muted-foreground">{copy.body}</div>
          <Button variant="secondary" size="lg" disabled={reading} onClick={() => inputRef.current?.click()}>
            {copy.cta}
          </Button>
          {/* `webkitdirectory` is the picker half of D19: it is what makes "choose a folder"
              actually choose a folder. React types it as a DOM attribute, hence the cast. */}
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            multiple
            className="sr-only"
            aria-label={copy.cta}
            {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
            onChange={(event) => {
              const picked = filesFromInput(event.target.files);
              // Reset so picking the same folder twice still fires a change event.
              event.target.value = "";
              onFiles(picked.files, picked.rootName);
            }}
          />
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="display-title text-xl">{copy.help.title}</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="m-0 list-decimal pl-[1.1rem] text-sm/[1.7] text-muted-foreground">
              {copy.help.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            {copy.help.links.length > 0 ? (
              <p className="mt-3.5 mb-0 text-sm text-muted-foreground">
                Step by step from {importer.label}:{" "}
                {copy.help.links.map((link, i) => (
                  <span key={link.href}>
                    {i > 0 ? " · " : null}
                    <a href={link.href} target="_blank" rel="noreferrer" className="font-semibold underline">
                      {link.label}
                    </a>
                  </span>
                ))}
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
