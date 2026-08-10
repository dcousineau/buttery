import { Link } from "@tanstack/react-router";
import { AlarmClock, Pause, Play, Plus, X } from "lucide-react";
import { Button } from "#/components/ui/button";
import { Progress } from "#/components/ui/progress";
import { cn } from "#/lib/utils";
import { remainingMs, useTimers, type Timer } from "#/lib/timers/store";

/** `90061` ms → `"1:01:01"`, `1500000` → `"25:00"`, floored at `0:00`. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * One timer, shared by the header popover, the on-recipe strip, and cook mode's
 * `TimersPanel` (plan §12). Subscribes to the store itself so its remaining ticks
 * live wherever it is mounted. Alarming rows lead with **Ack** (the primary
 * finish action, which removes the timer); running/paused rows show remaining +
 * a progress bar with pause/resume + dismiss.
 */
export function TimerRow({
  timer,
  showRecipe = true,
  onNavigate,
  accent = "primary",
}: {
  timer: Timer;
  showRecipe?: boolean;
  onNavigate?: () => void;
  /** Non-alarming accent (progress + recipe link). Cook mode uses the butter
   * "secondary" so nothing in that surface reads as the tomato "primary". */
  accent?: "primary" | "secondary";
}) {
  const { pause, resume, ack, dismiss, addMinute } = useTimers();
  const alarming = timer.status === "alarming";
  const paused = timer.status === "paused";
  const remaining = remainingMs(timer);
  const progress = timer.totalMs > 0 ? Math.min(1, Math.max(0, 1 - remaining / timer.totalMs)) : 0;
  const gold = accent === "secondary";

  return (
    <div className={cn("flex flex-col gap-1.5 rounded-lg border-2 border-border bg-card p-2.5", alarming && "border-destructive bg-destructive/10")}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-baseline gap-1.5 truncate">
          <span className="truncate font-semibold text-foreground">{timer.label}</span>
          {/* The originally-configured duration, so a mid-run timer reads "5m set, 1:55 left". */}
          <span className="shrink-0 font-mono text-[0.7rem] text-muted-foreground tabular-nums">{formatRemaining(timer.totalMs)}</span>
        </span>
        {alarming ? (
          <span className="inline-flex shrink-0 items-center gap-1 font-bold text-destructive">
            <AlarmClock className="size-3.5" aria-hidden="true" />
            Time!
          </span>
        ) : (
          <span className={cn("shrink-0 font-mono text-sm tabular-nums", paused ? "text-muted-foreground" : "text-foreground")}>
            {formatRemaining(remaining)}
            {paused && <span className="ml-1 text-[0.7rem] font-semibold uppercase">paused</span>}
          </span>
        )}
      </div>

      {showRecipe && (
        <Link
          to="/household/recipes/$id"
          params={{ id: timer.recipeId }}
          onClick={onNavigate}
          className="w-fit max-w-full truncate text-xs font-semibold text-muted-foreground no-underline hover:text-foreground hover:underline"
        >
          {timer.recipeTitle}
        </Link>
      )}

      {!alarming && <Progress value={progress * 100} variant={gold ? "secondary" : "default"} aria-label="Timer progress" label={`${formatRemaining(remaining)} left`} />}

      <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
        {alarming ? (
          <>
            <Button size="sm" onClick={() => ack(timer.id)}>
              Dismiss
            </Button>
            <Button size="sm" variant="outline" onClick={() => addMinute(timer.id)}>
              <Plus data-icon="inline-start" aria-hidden="true" />1 min
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="outline" onClick={() => (paused ? resume(timer.id) : pause(timer.id))} aria-label={paused ? "Resume timer" : "Pause timer"}>
              {paused ? <Play data-icon="inline-start" aria-hidden="true" /> : <Pause data-icon="inline-start" aria-hidden="true" />}
              {paused ? "Resume" : "Pause"}
            </Button>
            <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => dismiss(timer.id)} aria-label="Dismiss timer">
              <X data-icon="inline-start" aria-hidden="true" />
              Dismiss
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
