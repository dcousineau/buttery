import { Timer as TimerIcon } from "lucide-react";
import { cn } from "#/lib/utils";
import { useTimers } from "#/lib/timers/store";
import type { TimeToken as TimeTokenData } from "#/lib/timers/parse";

/**
 * A tappable duration inside a recipe step — tapping it starts a global,
 * recipe-tagged timer (plan §10). Shared by the detail-pane method list (subtle
 * underline) and cook-mode `StepView` (bolder gold underline). `stopPropagation`
 * keeps a tap from also centring the step in cook mode's focus-scroll.
 */
export function TimeToken({ token, recipeId, recipeTitle, variant = "detail" }: { token: TimeTokenData; recipeId: string; recipeTitle: string; variant?: "detail" | "cook" }) {
  const { add } = useTimers();

  function start(e: React.MouseEvent) {
    e.stopPropagation();
    add({ recipeId, recipeTitle, label: token.label, seconds: token.seconds });
  }

  return (
    <button
      type="button"
      onClick={start}
      title={`Start a ${token.label.toLowerCase()} timer`}
      aria-label={`Start a ${token.label.toLowerCase()} timer for ${token.text}`}
      className={cn(
        // Default inline-block flow (not inline-flex) so the button's baseline is
        // its text baseline and it sits on the surrounding line; the icon is an
        // inline, em-sized glyph nudged to sit centred on the text.
        "rounded-[6px] font-semibold underline decoration-2 underline-offset-2 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
        variant === "detail"
          ? "text-primary decoration-primary/40 hover:bg-primary/10 hover:decoration-primary"
          : "text-secondary decoration-secondary/60 hover:bg-secondary/15 hover:decoration-secondary",
      )}
    >
      <TimerIcon className="mr-1 inline-block size-[0.9em] align-[-0.15em]" aria-hidden="true" />
      {token.text}
    </button>
  );
}
