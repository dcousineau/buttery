import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { DragHandle, DropLine, insertionPointAt } from "#/components/ui/drag-reorder";
import { FieldWarning } from "#/components/ui/field";
import { Input } from "#/components/ui/input";
import { Textarea } from "#/components/ui/textarea";
import { useDragHandle } from "#/lib/hooks/use-drag-source";
import { moveToInsertionPoint } from "#/lib/reorder";
import { cn } from "#/lib/utils";

export type EditorMode = "paste" | "rows";

/**
 * Dual-mode ("Paste a list" ↔ "Rows") line editor shared by the ingredients and
 * instructions cards (plan §A5). Both serialize to a flat `string[]`. Pasting
 * multi-line text auto-flips to Rows so per-row soft warnings are visible. Rows
 * support drag-reorder + delete. `warn(line)` is an advisory hint (⚠︎) in the amber
 * warning state, never a blocker — save gating is attribution + lexicon validation
 * only, and that gate is what `rowProblem` paints red.
 */
export function LineEditor({
  lines,
  onChange,
  mode,
  onModeChange,
  numbered = false,
  multiline = false,
  countNoun,
  pastePlaceholder,
  pasteHelp,
  addLabel,
  warn,
  rowId,
  rowProblem,
}: {
  lines: string[];
  onChange: (lines: string[]) => void;
  mode: EditorMode;
  onModeChange: (m: EditorMode) => void;
  numbered?: boolean;
  multiline?: boolean;
  countNoun: string;
  pastePlaceholder: string;
  pasteHelp: React.ReactNode;
  addLabel: string;
  warn?: (line: string) => string | null;
  /**
   * DOM id for row `index`. Set by a caller that has to *send someone to a row* — the
   * import review's "Needs a fix" group focuses and scrolls the exact step the lexicon
   * rejected, and it cannot do that without an addressable element.
   */
  rowId?: (index: number) => string | undefined;
  /**
   * A hard problem with row `index` (as opposed to `warn`'s advisory hint about its
   * contents). Rendered in the destructive colour and given precedence — it suppresses
   * the hint entirely — because "this is 120 characters too long to save" and "no amount
   * read" are not the same news and must not wear the same paint.
   */
  rowProblem?: (index: number) => string | null;
}) {
  const [dragging, setDragging] = useState<number | null>(null);
  /**
   * Where the dragged row would land, as an *insertion point* — 0…lines.length,
   * counted between rows rather than on them. A drop target painted on a row
   * cannot say whether the row lands above or below it; a line drawn in the gap
   * can, so that is what the drag reads and what it draws.
   */
  const [dropAt, setDropAt] = useState<number | null>(null);
  // Rows are draggable only while a grip is held. A row that is draggable all the
  // time steals click-and-drag inside its own input — the browser starts the row
  // drag instead of selecting text — and reordering is the handle's job anyway
  // ("Drag the handle to reorder", below). One hook for every row is enough: only
  // one grip can be under the pointer, so only the pressed row can start a drag.
  const { armed, handleProps, disarm } = useDragHandle();
  const count = lines.filter((l) => l.trim()).length;

  function setRow(i: number, text: string) {
    const next = [...lines];
    next[i] = text;
    onChange(next);
  }
  function removeRow(i: number) {
    onChange(lines.filter((_, j) => j !== i));
  }
  function addRow() {
    onChange([...lines, ""]);
  }
  /** `at` is an insertion point (see `dropAt`), not a row index. */
  function moveRow(from: number, at: number) {
    const next = moveToInsertionPoint(lines, from, at);
    if (next !== lines) onChange(next);
  }
  function endDrag() {
    setDragging(null);
    setDropAt(null);
    disarm();
  }
  // Switching to Rows compacts the text block: blank lines (e.g. paragraph
  // spacing in a pasted method) must never become empty rows.
  function toRows() {
    onChange(lines.filter((l) => l.trim() !== ""));
    onModeChange("rows");
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-end gap-2">
        <Badge variant="outline" size="xs">
          {count} {countNoun}
        </Badge>
        <div className="flex overflow-hidden rounded-lg border-2 border-border shadow-(--shadow-pop-sm)">
          <SegButton active={mode === "paste"} onClick={() => onModeChange("paste")}>
            {numbered ? "Paste steps" : "Paste a list"}
          </SegButton>
          <SegButton active={mode === "rows"} onClick={toRows} bordered>
            {numbered ? "Steps" : "Rows"}
          </SegButton>
        </div>
      </div>

      {mode === "paste" ? (
        <div className="flex flex-col gap-2">
          <Textarea
            rows={numbered ? 8 : 9}
            value={lines.join("\n")}
            onChange={(e) => onChange(e.target.value.split("\n"))}
            onPaste={(e) => {
              const text = e.clipboardData.getData("text");
              if (text.includes("\n")) {
                e.preventDefault();
                const existing = lines.filter((l) => l.trim() !== "");
                // Split the pasted block into rows, trimming each and dropping
                // blank lines (paragraph spacing) so we never create empty rows.
                const pasted = text
                  .split("\n")
                  .map((l) => l.trim())
                  .filter(Boolean);
                onChange([...existing, ...pasted]);
                onModeChange("rows");
              }
            }}
            placeholder={pastePlaceholder}
          />
          <p className="bt-field-description m-0">{pasteHelp}</p>
        </div>
      ) : (
        <div
          // Reordering listens at the list, not at each row: the 10px gaps between
          // rows belong to no row, and a drag read row-by-row goes blind exactly
          // where the drop line is drawn.
          onDragOver={(e) => {
            if (dragging === null) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setDropAt(insertionPointAt(e.currentTarget, e.clientY, "[data-line-row]"));
          }}
          onDragLeave={(e) => {
            // Only a departure from the list itself counts — crossing between two
            // rows fires dragleave too, and hiding the line there would strobe it.
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null);
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (dragging !== null && dropAt !== null) moveRow(dragging, dropAt);
            endDrag();
          }}
          className="flex flex-col gap-2.5"
        >
          {lines.map((line, i) => {
            const problem = rowProblem?.(i) ?? null;
            // A problem hides the hint: the row already has one thing to say, and the
            // louder one wins. Only one of the two states ever reaches the control.
            const hint = problem ? null : (warn?.(line) ?? null);
            const id = rowId?.(i);
            return (
              <div
                key={i}
                data-line-row=""
                draggable={armed}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  setDragging(i);
                  setDropAt(i);
                }}
                onDragEnd={endDrag}
                className={cn("relative flex flex-col gap-1", dragging === i && "opacity-40")}
              >
                {/* The drop line, drawn in the gap above this row — and, for the last
                    row, below it, the one landing place no gap above a row can express. */}
                {dropAt === i && <DropLine className="-top-[6.5px]" />}
                {dropAt === lines.length && i === lines.length - 1 && <DropLine className="-bottom-[6.5px]" />}
                <div className={cn("flex gap-2", multiline ? "items-start" : "items-center")}>
                  {/* The grip is the whole drag affordance now, so it gets a padded box
                      to grab rather than 16 square pixels of icon. The negative margin
                      keeps the row drawn where it was. */}
                  <DragHandle label="Reorder" {...handleProps} className={cn(multiline && "mt-1.5")} />
                  {numbered && (
                    <span
                      className={cn(
                        "grid size-7 shrink-0 place-content-center rounded-full border-2 border-border bg-secondary text-xs font-bold text-secondary-foreground",
                        multiline && "mt-0.5",
                      )}
                    >
                      {i + 1}
                    </span>
                  )}
                  <div className="grid min-w-0 flex-1">
                    {multiline ? (
                      // A step row grows with its text: two rows is the floor, and a long
                      // step is read in full rather than through a scrollbar. The paste
                      // box above deliberately does not — it is a fixed window onto a
                      // block someone may have pasted a whole cookbook into.
                      <Textarea
                        id={id}
                        rows={2}
                        autosize
                        value={line}
                        onChange={(e) => setRow(i, e.target.value)}
                        aria-invalid={problem ? true : undefined}
                        data-warning={hint ? true : undefined}
                      />
                    ) : (
                      <Input id={id} value={line} onChange={(e) => setRow(i, e.target.value)} aria-invalid={problem ? true : undefined} data-warning={hint ? true : undefined} />
                    )}
                  </div>
                  <Button variant="ghost" size="icon-sm" onClick={() => removeRow(i)} aria-label="Remove" className={cn(multiline && "mt-0.5")}>
                    <Trash2 className="size-3.5" aria-hidden="true" />
                  </Button>
                </div>
                {problem && (
                  <p className="ml-6 flex items-center gap-1 text-[0.6875rem] font-medium text-destructive">
                    <span aria-hidden="true">⚠︎</span>
                    {problem}
                  </p>
                )}
                <FieldWarning className="ml-6 text-[0.6875rem] font-medium">{hint}</FieldWarning>
              </div>
            );
          })}
          <div className="mt-0.5 flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={addRow}>
              <Plus data-icon="inline-start" aria-hidden="true" />
              {addLabel}
            </Button>
            <span className="text-xs text-muted-foreground">Drag the handle to reorder.</span>
          </div>
        </div>
      )}
    </div>
  );
}

function SegButton({ active, onClick, bordered, children }: { active: boolean; onClick: () => void; bordered?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-7 cursor-(--cursor-interactive) px-2.5 text-xs font-semibold transition-colors",
        bordered && "border-l-2 border-border",
        active ? "bg-primary text-primary-foreground" : "bg-background text-foreground hover:bg-accent",
      )}
    >
      {children}
    </button>
  );
}
