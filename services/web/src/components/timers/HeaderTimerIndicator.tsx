import { AlarmClock, BellOff, BellRing, Timer as TimerIcon } from "lucide-react";
import { useHydratedSession } from "#/lib/auth-client";
import { Popover, PopoverContent, PopoverTrigger } from "#/components/ui/popover";
import { cn } from "#/lib/utils";
import { useHydrateTimers, useTimers, useTimerSummary } from "#/lib/timers/store";
import { TimerRow } from "./TimerRow";

/**
 * The always-mounted header timer indicator (plan §6.4). A clock button with a
 * count badge of in-progress timers; while any timer is **alarming-unacked** it
 * adopts the alarm accent and **shakes continuously** (with a steady alarm ring
 * as the non-motion equivalent under reduced-motion). Clicking opens a popover
 * grouping **Done — needs ack** and **In progress**. Reads the global store and
 * hydrates it once, after first render, so SSR and hydration agree (§4.1a).
 */
export function HeaderTimerIndicator() {
  useHydrateTimers();
  // Hydration-safe by construction: the timer store fills in from an effect and
  // `useHydratedSession` withholds the session until the same point, so the
  // first client render of this indicator matches the SSR pass that had neither.
  const { data: session } = useHydratedSession();
  const { inProgress, alarming, total } = useTimerSummary();
  const { timers, muted, setMuted } = useTimers();

  // Keep the eager store hydrating on every page, but only surface the control
  // for a signed-in user who has (or could have) timers.
  if (!session && total === 0) return null;

  const hasAlarming = alarming > 0;
  const done = timers.filter((t) => t.status === "alarming");
  const active = timers.filter((t) => t.status !== "alarming");

  const accessibleName = hasAlarming ? `Timers — ${alarming} done, needs attention` : inProgress > 0 ? `Timers — ${inProgress} in progress` : "Timers";

  return (
    <>
      {/* Politely announce start / expiry — counts only, so ticks don't spam SRs.
          Kept OUTSIDE the labelled trigger to avoid double-announcing its name. */}
      <span role="status" aria-live="polite" className="sr-only">
        {accessibleName}
      </span>
      <Popover>
        <PopoverTrigger
          aria-label={accessibleName}
          className={cn(
            "relative inline-flex size-(--control-h-sm) shrink-0 items-center justify-center rounded-lg border-2 border-border bg-card text-foreground shadow-pop-sm transition-all outline-none hover:-translate-y-0.5 hover:shadow-pop focus-visible:ring-3 focus-visible:ring-ring/50 active:translate-y-0.5 active:shadow-none",
            hasAlarming && "border-destructive text-destructive ring-2 ring-destructive/60",
            hasAlarming && "motion-safe:animate-timer-shake",
          )}
        >
          {hasAlarming ? <AlarmClock className="size-4 touch:size-5" aria-hidden="true" /> : <TimerIcon className="size-4 touch:size-5" aria-hidden="true" />}
          {inProgress > 0 && (
            <span
              aria-hidden="true"
              className={cn(
                "absolute -top-1.5 -right-1.5 grid min-w-4.5 place-content-center rounded-full border-2 border-border px-1 text-[0.625rem] font-bold leading-none",
                hasAlarming ? "bg-destructive text-primary-foreground" : "bg-primary text-primary-foreground",
              )}
            >
              {inProgress}
            </span>
          )}
        </PopoverTrigger>

        <PopoverContent aria-label="Timers">
          <div className="flex items-center justify-between gap-2 px-1 pb-2">
            <h2 className="display-title m-0 text-base text-foreground">Timers</h2>
            <button
              type="button"
              onClick={() => setMuted(!muted)}
              aria-pressed={muted}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {muted ? <BellOff className="size-3.5" aria-hidden="true" /> : <BellRing className="size-3.5" aria-hidden="true" />}
              {muted ? "Muted" : "Sound on"}
            </button>
          </div>

          {total === 0 ? (
            <p className="m-0 px-1 py-6 text-center text-sm text-muted-foreground">No timers yet. Tap a time in a recipe to start one.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {done.length > 0 && (
                <Group label="Done — needs ack">
                  {done.map((t) => (
                    <TimerRow key={t.id} timer={t} />
                  ))}
                </Group>
              )}
              {active.length > 0 && (
                <Group label="In progress">
                  {active.map((t) => (
                    <TimerRow key={t.id} timer={t} />
                  ))}
                </Group>
              )}
            </div>
          )}
        </PopoverContent>
      </Popover>
    </>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 px-1 text-[0.6875rem] font-bold tracking-wide text-muted-foreground uppercase">{label}</p>
      {children}
    </div>
  );
}
