import { useState } from "react";
import { Plus } from "lucide-react";
import { cn } from "#/lib/utils";

/**
 * The inline "new collection" row at the foot of the tree (§7).
 *
 * Purely presentational: it collects a name and hands it up. The tree owns the
 * mutation and the "select what was just created" navigation, which is what lets
 * milestone 4's sheet reuse this row unchanged.
 *
 * Three behaviours the spec pins down, and one it does not:
 *
 * - **Enter creates and selects.** It is a real `<form>`, so Enter is the
 *   browser's submit and not a `keydown` listener pretending to be one.
 * - **Escape discards** — the one keystroke with no native equivalent, so it is
 *   the one listener here.
 * - **Duplicate names never error** (§8). Nothing in this row validates a name
 *   against the existing ones, on purpose; the server allows duplicates and a
 *   quick-add that refused one would be lying about the model.
 * - Blur is left alone. It closes the row only when nothing has been typed;
 *   clicking away from half a name keeps the half-name, because losing typed
 *   text to a stray click is the worst outcome available here.
 */
export function QuickAddRow({
  onCreate,
  pending = false,
  disabled = false,
  disabledHint,
}: {
  /** Called with a trimmed, non-empty name. */
  onCreate: (name: string) => void;
  pending?: boolean;
  disabled?: boolean;
  /** Tooltip explaining a disabled row (offline). */
  disabledHint?: string;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");

  function close() {
    setOpen(false);
    setName("");
  }

  if (!open) {
    return (
      <button
        type="button"
        disabled={disabled}
        title={disabledHint}
        onClick={() => setOpen(true)}
        className={cn(
          // 44px on a coarse pointer, like every other row in the tree — see
          // `CollectionRow` for why the variant is the input device and not the
          // viewport width.
          "flex w-full cursor-(--cursor-interactive) items-center gap-2 px-2.5 py-1.5 text-[0.8125rem] font-semibold text-muted-foreground transition-colors pointer-coarse:min-h-11",
          "not-disabled:hover:bg-accent/40 not-disabled:hover:text-foreground disabled:opacity-60",
          "focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-ring",
        )}
      >
        <Plus className="size-3.5 shrink-0" aria-hidden="true" />
        New collection
      </button>
    );
  }

  return (
    <form
      className="flex items-center gap-2 px-2.5 py-1 pointer-coarse:min-h-11"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = name.trim();
        if (!trimmed) {
          close();
          return;
        }
        onCreate(trimmed);
        close();
      }}
    >
      <Plus className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      {/* Not the `Input` primitive: this is a row in a tree, not a form field —
        it has to sit flush at row height with no border of its own, and the
        primitive's job is to look like a field. */}
      <input
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- the field exists only because the member just asked for it; focus follows the click the way it would into a dialog
        autoFocus
        value={name}
        disabled={pending}
        // The lexicon's own cap (§1). The server counts UTF-8 bytes and is
        // authoritative; this is the guard that stops someone typing 900
        // characters into a 100-character field.
        maxLength={100}
        aria-label="Name the new collection"
        placeholder="Weeknights"
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            close();
          }
        }}
        onBlur={() => {
          if (!name.trim()) close();
        }}
        className="min-w-0 flex-1 border-0 bg-transparent py-0.5 text-[0.8125rem] font-semibold text-foreground outline-none placeholder:font-medium placeholder:text-muted-foreground pointer-coarse:min-h-9"
      />
    </form>
  );
}
