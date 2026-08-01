import { BellOff, BellRing } from "lucide-react";
import { useRecipeTimers, useTimers } from "#/lib/timers/store";
import { TimerRow } from "#/components/timers/TimerRow";

/**
 * The cook-mode timers panel — the **global** store filtered to this recipe (plan
 * §4.2 / §6.5), plus the global mute toggle. Cook mode has no private timer state;
 * every timer here is the same one the header indicator shows. Sits pinned at the
 * foot of the cook-phase sidebar: a heading with a live status summary, then the
 * per-recipe timer rows (or a hint to start one).
 */
export function TimersPanel({ recipeId }: { recipeId: string }) {
  const timers = useRecipeTimers(recipeId);
  const { muted, setMuted } = useTimers();
  const ordered = [...timers].sort((a, b) => Number(b.status === "alarming") - Number(a.status === "alarming"));

  const done = timers.filter((t) => t.status === "alarming").length;
  const active = timers.length - done;
  const summary = timers.length === 0 ? "none yet" : [done ? `${done} done` : null, active ? `${active} running` : null].filter(Boolean).join(" · ");

  return (
    <section aria-label="Timers" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="display-title m-0 text-base text-foreground">Timers</h2>
          <span className="truncate text-xs font-semibold text-muted-foreground">{summary}</span>
        </div>
        <button
          type="button"
          onClick={() => setMuted(!muted)}
          aria-pressed={muted}
          aria-label={muted ? "Unmute timer alarms" : "Mute timer alarms"}
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {muted ? <BellOff className="size-3.5" aria-hidden="true" /> : <BellRing className="size-3.5" aria-hidden="true" />}
          {muted ? "Muted" : "Sound on"}
        </button>
      </div>
      {ordered.length === 0 ? (
        <p className="m-0 text-sm text-muted-foreground">Tap a time in a step to start one.</p>
      ) : (
        <ul className="m-0 flex max-h-[34vh] list-none flex-col gap-2 overflow-y-auto p-0">
          {ordered.map((t) => (
            <li key={t.id}>
              <TimerRow timer={t} showRecipe={false} accent="secondary" />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
