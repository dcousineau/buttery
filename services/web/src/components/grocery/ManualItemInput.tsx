import { useRef, useState } from "react";
import { Plus } from "lucide-react";
import { addManualGroceryItem } from "#/server/grocery";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { cn } from "#/lib/utils";

/**
 * "Two limes" — one field, one button, no preview (plan §7).
 *
 * A typed line skips the confirm-preview D9 requires of recipe adds, because
 * typing it IS the confirmation: there is nothing the dialog could show you that
 * you did not just write. The server parses, categorizes and commits in one
 * call.
 *
 * This component owns its own write, unlike everything else on the route, for
 * one reason: there is no honest optimistic row to paint. The aisle, the parsed
 * quantity and whether the line merges into something already on the list are
 * all the lexicon's answers, not the client's — guessing them would flash a
 * wrong aisle on every add. So it sends, reports, and lets the route invalidate.
 *
 * The field keeps focus and clears after a success, because the way anyone
 * actually uses this is four things in a row before putting the phone down.
 */

export interface ManualItemInputProps {
  /** Fired once the server has taken the line. The route invalidates + toasts. */
  onAdded: (text: string, result: { itemId: string; merged: boolean }) => void;
  onError: (message: string) => void;
  className?: string;
}

export function ManualItemInput({ onAdded, onError, className }: ManualItemInputProps) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  function submit() {
    const trimmed = text.trim();
    if (trimmed === "" || pending) return;
    setPending(true);
    addManualGroceryItem({ data: { text: trimmed } })
      .then((result) => {
        setText("");
        onAdded(trimmed, result);
      })
      .catch((error: unknown) => {
        onError(error instanceof Error ? error.message : "That didn't save. Try again.");
      })
      .finally(() => {
        setPending(false);
        field.current?.focus();
      });
  }

  return (
    <form
      className={cn("flex items-center gap-2", className)}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Input
        ref={field}
        size="lg"
        className="min-w-0 flex-1"
        value={text}
        onChange={(event) => setText(event.target.value)}
        // The placeholder is doing teaching work: an amount and a unit are what
        // let a typed line merge with the same food off a recipe.
        placeholder="Add an item — “2 limes”, “a bag of ice”"
        aria-label="Add an item to the list"
        disabled={pending}
        maxLength={200}
      />
      <Button type="submit" size="lg" disabled={pending || text.trim() === ""}>
        <Plus data-icon="inline-start" aria-hidden="true" />
        {pending ? "Adding…" : "Add"}
      </Button>
    </form>
  );
}
