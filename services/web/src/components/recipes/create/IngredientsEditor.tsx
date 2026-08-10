import { splitIngredient } from "#/lib/recipe-scale";
import { LineEditor, type EditorMode } from "./LineEditor";

/**
 * Ingredients card body (plan §A5). Runs the amount/unit extractor per row and
 * hints — never blocks — when no quantity can be read, nudging structured input
 * that later powers shopping-list quantity math.
 *
 * The wording carries its own weight: "salt to taste" and "a splash of vinegar" are
 * how people actually write recipes, so the hint has to name the upside without
 * implying anything is wrong. Amber, not red (see Input's `data-warning`).
 */
function warnIngredient(line: string): string | null {
  if (!line.trim()) return null;
  const { amount } = splitIngredient(line);
  if (!amount.trim()) return "No amount read — optional, but “2 tbsp” helps lists.";
  return null;
}

export function IngredientsEditor({
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
      countNoun="ingredients"
      pastePlaceholder={"1 1/2 cups all-purpose flour\n1/2 cup granulated sugar\n2 tsp baking powder"}
      pasteHelp={
        <>
          One ingredient per line, however you'd write it on a card. Switch to <strong className="text-foreground">Rows</strong> to reorder them.
        </>
      }
      addLabel="Add an ingredient"
      warn={warnIngredient}
    />
  );
}
