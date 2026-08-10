import type { StageProgress } from "#/lib/recipe-import/machine.ts";
import { Button } from "#/components/ui/button";
import { Progress } from "#/components/ui/progress";
import { useScreenHeading } from "./useScreenHeading.ts";

/**
 * "Reading your recipe box…" (plan §10.1).
 *
 * One bar for four stages. §9's pipeline has `parse`, `keys`, and `probe` as separate steps,
 * but the design deliberately presents them as a single wait: the user cannot act on the
 * difference between "extracting" and "hashing", and three bars in a row reads as three
 * failures waiting to happen. The stage only changes the label under the bar.
 *
 * The first stage has no total — the folder walk is a lazy iterator, so the count is not
 * knowable until it ends — and the bar renders its indeterminate state rather than
 * pretending to a percentage.
 */

const STAGE_HINT: Record<StageProgress["stage"], string> = {
  read: "Looking through the folder.",
  parse: "Reading each recipe.",
  keys: "Working out short keys so your box can be checked without uploading anything.",
  probe: "Checking those keys against the recipes you already have.",
};

function stageLine(progress: StageProgress, importerLabel: string): string {
  const { stage, done, total } = progress;
  if (stage === "read") return `Opening the ${importerLabel} folder…`;
  if (total === null) return `${done} so far`;
  if (stage === "probe") return `${done} of ${total} checked against your box`;
  if (stage === "keys") return `${done} of ${total} keyed`;
  return `${done} of ${total} read`;
}

export function ImportReadingScreen({
  importerLabel,
  fileName,
  fileCount,
  progress,
  onCancel,
}: {
  importerLabel: string;
  fileName: string | null;
  fileCount: number;
  progress: StageProgress | null;
  onCancel: () => void;
}) {
  const heading = useScreenHeading<HTMLHeadingElement>();
  const stage = progress ?? { stage: "read" as const, done: 0, total: null };
  const line = stageLine(stage, importerLabel);

  return (
    <div className="flex flex-1 overflow-auto px-6 py-10">
      <div className="m-auto flex w-[min(560px,100%)] flex-col gap-5">
        <h1 ref={heading} tabIndex={-1} className="display-title m-0 text-[2rem]/[1.1] outline-none">
          Reading your recipe box…
        </h1>
        <p className="m-0 text-sm text-muted-foreground">
          {[fileName, fileCount > 0 ? `${fileCount} ${fileCount === 1 ? "file" : "files"}` : null].filter(Boolean).join(" · ")}
        </p>

        {/* `aria-label` names the bar; `label` is its `aria-valuetext`, the human count. The
            live region that actually announces progress is throttled elsewhere (§10.4) —
            this bar is what a screen-reader user reads on demand, not what interrupts them. */}
        <Progress
          value={stage.total === null ? null : stage.done}
          max={stage.total ?? 100}
          label={line}
          aria-label="Reading your recipe box"
          variant="secondary"
          className="h-8 rounded-xl border-2 border-border bg-card shadow-pop-sm"
        />

        <p className="m-0 text-base font-semibold">{line}</p>
        <p className="m-0 text-[0.8125rem] text-muted-foreground">{STAGE_HINT[stage.stage]}</p>
        <p className="m-0 text-[0.8125rem] text-muted-foreground">
          Recipes are parsed on your own machine. Only short dedupe keys — never ingredients or instructions — are sent to check what you already have.
        </p>

        <div>
          {/* Nothing has been written yet at this point, so leaving costs the user nothing —
              but a wait with no exit is a trap, especially on a 341-file folder. */}
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Stop and start over
          </Button>
        </div>
      </div>
    </div>
  );
}
