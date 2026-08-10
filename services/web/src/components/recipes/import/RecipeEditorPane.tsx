import { useState } from "react";
import type { RecipeRecordInput } from "#/server/recipes-write";
import type { ImportItem } from "#/lib/recipe-import/machine.ts";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "#/components/ui/alert";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import { IngredientsEditor } from "#/components/recipes/create/IngredientsEditor";
import { InstructionsEditor } from "#/components/recipes/create/InstructionsEditor";
import type { EditorMode } from "#/components/recipes/create/LineEditor";
import { LocalImage } from "./LocalImage.tsx";

/**
 * The full editor over one imported recipe (plan §10.2, D25).
 *
 * D25 is explicit that this reuses the create form's editors rather than growing a second
 * set: `IngredientsEditor` and `InstructionsEditor` already carry the paste/rows modes, the
 * amount hint, and the timer hint, and an import-only copy of them would drift the moment
 * either is improved. Only the *shell* is import-specific — the duplicate banner, the
 * position counter, and the Skip/Keep footer that walks the group.
 *
 * Editing sets `edited` on the item, which is what `finalizeOutcome` reports as
 * `editedBeforeCommit` (§7.7) — the figure that tells us whether the extractor is good
 * enough, so it must come from real edits and not from opening the screen.
 */
export function RecipeEditorPane({
  item,
  importerLabel,
  position,
  total,
  localImageUrl,
  onPatch,
  onClose,
  onSkip,
  onKeepNext,
  onOpenCompare,
}: {
  item: ImportItem;
  importerLabel: string;
  position: number;
  total: number;
  localImageUrl: (path: string | null) => string | null;
  onPatch: (patch: Partial<RecipeRecordInput>) => void;
  onClose: () => void;
  onSkip: () => void;
  onKeepNext: () => void;
  onOpenCompare: () => void;
}) {
  const [ingMode, setIngMode] = useState<EditorMode>("rows");
  const [stepMode, setStepMode] = useState<EditorMode>("rows");
  const flagged = item.verdict === "maybe" || item.verdict === "in_box";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-none items-center gap-3 border-b-2 border-border px-5 py-2.5">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Back to the list
        </Button>
        <div className="ml-auto text-[0.8125rem] text-muted-foreground">
          {position} of {total}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-auto px-5 py-4">
        {flagged ? (
          <Alert variant="destructive">
            <AlertTitle>This might already be in your box</AlertTitle>
            <AlertDescription>{item.existing ? `${item.existing.name} · added ${new Date(item.existing.addedAt).toLocaleDateString()}` : "A recipe in your box has a matching key."}</AlertDescription>
            {item.existing ? (
              <AlertAction>
                <Button variant="outline" size="sm" onClick={onOpenCompare}>
                  Compare
                </Button>
              </AlertAction>
            ) : null}
          </Alert>
        ) : null}

        <div className="flex items-start gap-4">
          <LocalImage url={localImageUrl(item.localImagePath)} alt="" className="h-[90px] w-[120px] flex-none" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <label htmlFor={`name-${item.clientId}`} className="sr-only">
              Recipe name
            </label>
            <Input id={`name-${item.clientId}`} size="lg" className="font-semibold" value={item.record.name} onChange={(event) => onPatch({ name: event.target.value })} />
            <div className="text-[0.8125rem] text-muted-foreground">{item.sourceUrl ?? item.sourceText ?? `${item.entryName} · no source`}</div>
          </div>
        </div>

        <div className="grid gap-3.5 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-[0.9375rem]">Ingredients · {item.record.ingredients.length}</CardTitle>
            </CardHeader>
            <CardContent>
              <IngredientsEditor lines={item.record.ingredients} onChange={(lines) => onPatch({ ingredients: lines })} mode={ingMode} onModeChange={setIngMode} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-[0.9375rem]">Steps · {item.record.instructions.length}</CardTitle>
            </CardHeader>
            <CardContent>
              <InstructionsEditor lines={item.record.instructions} onChange={(lines) => onPatch({ instructions: lines })} mode={stepMode} onModeChange={setStepMode} />
            </CardContent>
          </Card>
        </div>

        {item.tags.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {/* The importer's own word for its folders — never a hard-coded product name (§2.5). */}
            <span className="mr-1 text-xs text-muted-foreground">{importerLabel} categories, kept as keywords</span>
            {item.tags.map((tag) => (
              <Badge key={tag} variant="outline" size="xs">
                {tag}
              </Badge>
            ))}
          </div>
        ) : null}
      </div>

      <div className="flex flex-none items-center gap-3 border-t-2 border-border bg-card px-5 py-2.5">
        <Button variant="outline" onClick={onSkip}>
          Skip this one
        </Button>
        <div className="ml-auto" />
        <Button variant="secondary" onClick={onKeepNext}>
          Keep · next
        </Button>
      </div>
    </div>
  );
}
