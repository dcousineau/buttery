import { hasTime } from "#/lib/timers/parse";
import { LineEditor, type EditorMode } from "./LineEditor";

// Looks like it mentions a duration ("bake 25 minutes") but nothing parseable.
const TIME_WORDS = /\b\d+\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/i;

/**
 * Instructions card body (plan §A5). Numbered steps. Runs the timer/duration
 * extractor per step and hints — never blocks — when a step reads like it has a
 * time but none parses, since explicit durations power cook-mode timers later.
 */
function warnStep(line: string): string | null {
  if (!line.trim()) return null;
  if (TIME_WORDS.test(line) && !hasTime(line)) return "Add a clear time like “bake 25 min” to power cook-mode timers.";
  return null;
}

export function InstructionsEditor({
  lines,
  onChange,
  mode,
  onModeChange,
  rowId,
  rowProblem,
}: {
  lines: string[];
  onChange: (l: string[]) => void;
  mode: EditorMode;
  onModeChange: (m: EditorMode) => void;
  /** Pass-through to {@link LineEditor}: DOM ids so a caller can focus one row. */
  rowId?: (index: number) => string | undefined;
  /** Pass-through to {@link LineEditor}: a blocking problem with one row. */
  rowProblem?: (index: number) => string | null;
}) {
  return (
    <LineEditor
      lines={lines}
      onChange={onChange}
      mode={mode}
      onModeChange={onModeChange}
      rowId={rowId}
      rowProblem={rowProblem}
      numbered
      multiline
      countNoun="steps"
      pastePlaceholder={"Heat the oven to 190°C and line a muffin tin.\nWhisk the dry ingredients, then fold in the wet.\nBake 25–30 minutes until golden."}
      pasteHelp="One step per line. Blank lines are ignored."
      addLabel="Add a step"
      warn={warnStep}
    />
  );
}
