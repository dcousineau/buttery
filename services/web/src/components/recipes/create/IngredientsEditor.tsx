import { splitIngredient } from "#/lib/recipe-scale";
import { LineEditor, type EditorMode } from "./LineEditor";

/**
 * Ingredients card body (plan §A5). Runs the amount/unit extractor per row and
 * hints — never blocks — when no quantity can be read, nudging structured input
 * that later powers shopping-list quantity math.
 */
function warnIngredient(line: string): string | null {
  if (!line.trim()) return null;
  const { amount } = splitIngredient(line);
  if (!amount.trim()) return "Couldn't read an amount — try “2 tbsp butter”.";
  return null;
}

export function IngredientsEditor({
  lines,
  onChange,
  mode,
  onModeChange,
}: {
  lines: string[];
  onChange: (l: string[]) => void;
  mode: EditorMode;
  onModeChange: (m: EditorMode) => void;
}) {
  return (
    <LineEditor
      lines={lines}
      onChange={onChange}
      mode={mode}
      onModeChange={onModeChange}
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
