import { Dices, FolderLock, ShoppingBasket } from "lucide-react";
import { Badge } from "#/components/ui/badge";

/**
 * "Waiting on a full box" — the three pantry features that need recipes before
 * they mean anything, kept visible with a `soon` chip rather than hidden until
 * they ship (BRAND.md: the roadmap is part of the copy).
 *
 * Muted panels, no hard shadow: nothing here is clickable, and a sticker that
 * lifts would promise otherwise. The meal planner is deliberately absent — it is
 * shipped, and lives at `/household/plan`.
 *
 * Purely presentational, no props beyond layout.
 */
export function LockedFeaturesStrip({ className }: { className?: string }) {
  return (
    <section className={className}>
      <h2 className="display-title m-0 text-xl leading-[1.1] text-foreground">Waiting on a full box</h2>
      <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-4">
        {LOCKED_FEATURES.map(({ icon: Icon, title, body }) => (
          <div key={title} className="flex min-w-0 items-start gap-3 rounded-xl border-2 border-border bg-muted/45 p-4">
            <span className="inline-flex pt-0.5 text-muted-foreground">
              <Icon className="size-5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-2 font-semibold text-foreground">
                {title}
                <Badge variant="outline" size="xs" className="text-[0.6rem] tracking-[0.05em] uppercase">
                  soon
                </Badge>
              </div>
              <p className="mt-1 mb-0 text-[0.8125rem] text-pretty text-muted-foreground">{body}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

const LOCKED_FEATURES = [
  { icon: FolderLock, title: "Collections", body: "Sort the box into shelves only your household can open." },
  { icon: ShoppingBasket, title: "Shopping list", body: "One list for the week, grouped by aisle, shared with the household." },
  { icon: Dices, title: "Randomizer", body: "Can’t decide? Roll the dice, dinner picks itself." },
];
