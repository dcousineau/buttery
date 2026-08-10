import { useRef, useState } from "react";
import { GripVertical, Plus, Trash2 } from "lucide-react";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Textarea } from "#/components/ui/textarea";
import { cn } from "#/lib/utils";

export type EditorMode = "paste" | "rows";

/**
 * Dual-mode ("Paste a list" ↔ "Rows") line editor shared by the ingredients and
 * instructions cards (plan §A5). Both serialize to a flat `string[]`. Pasting
 * multi-line text auto-flips to Rows so per-row soft warnings are visible. Rows
 * support drag-reorder + delete. `warn(line)` is an advisory hint (⚠︎), never a
 * blocker — save gating is attribution + lexicon validation only.
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
   * contents). Rendered in the destructive colour and given precedence, because "this is
   * 120 characters too long to save" and "couldn't read an amount" are not the same news.
   */
  rowProblem?: (index: number) => string | null;
}) {
  const dragIndex = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
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
  function reorder(from: number, to: number) {
    if (from === to) return;
    const next = [...lines];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(next);
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
        <div className="flex flex-col gap-2.5">
          {lines.map((line, i) => {
            const problem = rowProblem?.(i) ?? null;
            const hint = problem ?? warn?.(line) ?? null;
            const id = rowId?.(i);
            return (
              <div
                key={i}
                draggable
                onDragStart={() => (dragIndex.current = i)}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(i);
                }}
                onDrop={() => {
                  if (dragIndex.current != null) reorder(dragIndex.current, i);
                  dragIndex.current = null;
                  setDragOver(null);
                }}
                onDragEnd={() => {
                  dragIndex.current = null;
                  setDragOver(null);
                }}
                className={cn("flex flex-col gap-1", dragOver === i && "opacity-60")}
              >
                <div className={cn("flex gap-2", multiline ? "items-start" : "items-center")}>
                  <GripVertical className={cn("size-4 shrink-0 cursor-grab text-muted-foreground", multiline && "mt-2.5")} aria-hidden="true" />
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
                      <Textarea id={id} rows={2} value={line} onChange={(e) => setRow(i, e.target.value)} aria-invalid={hint ? true : undefined} />
                    ) : (
                      <Input id={id} value={line} onChange={(e) => setRow(i, e.target.value)} aria-invalid={hint ? true : undefined} />
                    )}
                  </div>
                  <Button variant="ghost" size="icon-sm" onClick={() => removeRow(i)} aria-label="Remove" className={cn(multiline && "mt-0.5")}>
                    <Trash2 className="size-3.5" aria-hidden="true" />
                  </Button>
                </div>
                {hint && (
                  <p className={cn("ml-6 flex items-center gap-1 text-[0.6875rem] font-medium", problem ? "text-destructive" : "text-muted-foreground")}>
                    <span aria-hidden="true">⚠︎</span>
                    {hint}
                  </p>
                )}
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
