import { Link } from "@tanstack/react-router";
import { failedItems, finalizeOutcome, type ImportState } from "#/lib/recipe-import/machine.ts";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { cn } from "#/lib/utils.ts";
import { useScreenHeading } from "./useScreenHeading.ts";

/**
 * "The pantry is stocked" — the summary (plan §10.1, §7.7).
 *
 * The four tiles are the whole outcome, and the failure list is the only place the user will
 * ever see which entries did not make it: §7.7 reconciles counters into the session row, but
 * the *names* are client-side state and vanish on reload. The screen says so rather than
 * letting someone discover it after closing the tab.
 *
 * It also says the one thing a network-shaped app has to say out loud: nothing here was
 * published. Everything imported is private to the household until the user publishes it.
 */
export function ImportDoneScreen({ state, importerLabel, householdName, onRestart }: { state: ImportState; importerLabel: string; householdName: string; onRestart: () => void }) {
  const heading = useScreenHeading<HTMLHeadingElement>();
  const outcome = finalizeOutcome(state);
  const failures = failedItems(state);

  const byReason = [...failures.reduce((map, failure) => map.set(failure.message, [...(map.get(failure.message) ?? []), failure]), new Map<string, typeof failures>())].sort((a, b) => b[1].length - a[1].length);

  const tiles: { value: number; label: string; tone?: "primary" | "danger" }[] = [
    { value: outcome.imported, label: "imported", tone: "primary" },
    { value: outcome.linked, label: "linked to public" },
    { value: outcome.skippedDuplicate + outcome.skippedUser, label: "skipped" },
    { value: outcome.failed + outcome.parseFailures, label: "didn't make it", tone: "danger" },
  ];

  return (
    <div className="flex flex-1 overflow-auto px-6 py-10">
      <div className="m-auto flex w-[min(680px,100%)] flex-col gap-5">
        <div className="flex flex-col items-start">
          <Badge variant="secondary" size="xs" className="mb-3">
            Import complete
          </Badge>
          <h1 ref={heading} tabIndex={-1} className="display-title m-0 text-4xl/[1.08] outline-none">
            The pantry is stocked
          </h1>
          <p className="mt-3 mb-0 text-base text-pretty text-muted-foreground">
            {outcome.imported + outcome.linked} {outcome.imported + outcome.linked === 1 ? "recipe" : "recipes"} from {importerLabel} are in{" "}
            <strong className="text-foreground">{householdName}</strong>. They're private to your household — nothing was published to the network. Open any one and publish it
            yourself when you're ready.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {tiles.map((tile) => (
            <div key={tile.label} className={cn("rounded-2xl border-2 border-border p-3.5", tile.tone === "primary" ? "bg-secondary shadow-pop-md" : "bg-card")}>
              <div className={cn("display-title text-[1.75rem]/[1]", tile.tone === "danger" && tile.value > 0 && "text-destructive")}>{tile.value}</div>
              <div className={cn("mt-0.5 text-xs", tile.tone === "primary" ? "" : "text-muted-foreground")}>{tile.label}</div>
            </div>
          ))}
        </div>

        {failures.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Didn't make it — find these in {importerLabel}</CardTitle>
            </CardHeader>
            <CardContent>
              {/* Grouped by reason, because the reason is the actionable half: "no source we
                  can attribute it to" and "couldn't be read" send the user to two different
                  places, and a bare list of 7 names sends them nowhere. */}
              {byReason.map(([reason, entries]) => (
                <div key={reason} className="mb-3 last:mb-0">
                  <div className="text-sm font-semibold">{reason}</div>
                  <p className="m-0 mt-1 text-sm/[1.7] text-muted-foreground">{entries.map((failure) => failure.entryName).join(" · ")}</p>
                </div>
              ))}
              <p className="m-0 mt-2 text-xs text-muted-foreground">This summary isn't saved anywhere — copy the list before you leave.</p>
            </CardContent>
          </Card>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button size="lg" render={<Link to="/household/recipes" />} nativeButton={false}>
            Open your recipe box
          </Button>
          <Button variant="ghost" size="lg" onClick={onRestart}>
            Import another export
          </Button>
        </div>
      </div>
    </div>
  );
}
