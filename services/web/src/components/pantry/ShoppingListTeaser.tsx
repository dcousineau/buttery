import { ShoppingBasket } from "lucide-react";
import { Badge } from "#/components/ui/badge";
import { cn } from "#/lib/utils";

/**
 * The shopping list, before there is a shopping list.
 *
 * Static by construction — there is nothing to configure, because there is
 * nothing behind it yet. It exists for the same reason the nav keeps `soon`
 * chips on Collections and the randomizer: the roadmap is part of the copy, and
 * a household that plans a week should be told where the list will show up
 * rather than left wondering whether they missed it.
 *
 * It is deliberately **not** a `Card`. Cards in this system are 2px ink and a
 * hard `pop-md` shadow, which reads as a live object you can act on; this panel
 * takes the softened `border-border/60` and no shadow at all, the same treatment
 * the empty-plan panel uses, so it sits visibly a step behind the real card next
 * to it. Making it a card and then subtracting the card's construction would
 * just be a card pretending.
 */

export interface ShoppingListTeaserProps {
  className?: string;
}

export function ShoppingListTeaser({ className }: ShoppingListTeaserProps) {
  return (
    <div className={cn("flex flex-wrap items-center gap-4 rounded-xl border-2 border-border/60 bg-muted/45 p-5", className)}>
      <ShoppingBasket className="size-10 flex-none text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-[1_1_10rem]">
        <div className="flex items-center gap-2">
          <h2 className="m-0 text-xl leading-[1.1] font-bold text-foreground">Shopping list</h2>
          <Badge variant="outline" size="xs" className="text-[0.6rem] tracking-[0.05em] uppercase">
            soon
          </Badge>
        </div>
        <p className="mt-1.5 mb-0 text-sm text-muted-foreground text-pretty">
          Every recipe on the plan will roll up into one list, grouped by aisle, shared with the household. It isn’t built yet — this is where it will live.
        </p>
      </div>
    </div>
  );
}
