import { Link } from "@tanstack/react-router";
import { BookOpenText, CalendarRange, ShoppingBasket } from "lucide-react";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/utils";

/**
 * The two flavours of "there is nothing here", kept apart the way
 * `RecipeLedger` keeps them apart: a list that has never had anything on it is a
 * different message from a list you have just finished shopping.
 *
 * - `empty` — nothing has been added. It explains where lines come from and
 *   points at the two places they come from, because a shopping list with no
 *   entry point is a dead end.
 * - `cleared` — everything on the list is checked off. Nothing to do here but
 *   say so; the rows are still on screen above until they retire (plan D10).
 */

export interface GroceryEmptyStateProps {
  variant?: "empty" | "cleared";
  className?: string;
}

export function GroceryEmptyState({ variant = "empty", className }: GroceryEmptyStateProps) {
  if (variant === "cleared") {
    return (
      <div className={cn("flex flex-col items-center gap-1.5 px-6 py-14 text-center", className)}>
        <ShoppingBasket className="size-10 text-muted-foreground" aria-hidden="true" />
        <p className="m-0 text-base font-bold text-foreground">That's everything.</p>
        <p className="m-0 max-w-sm text-sm text-muted-foreground text-pretty">
          Every line is in the cart. Checked items stay visible for an hour, then retire on their own — or clear them now and start the next trip clean.
        </p>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col items-center gap-3 px-6 py-14 text-center", className)}>
      <ShoppingBasket className="size-10 text-muted-foreground" aria-hidden="true" />
      <div className="flex flex-col gap-1">
        <p className="m-0 text-base font-bold text-foreground">Nothing on the list yet</p>
        <p className="m-0 max-w-sm text-sm text-muted-foreground text-pretty">
          Pull a recipe in from your box, roll up a week from the planner, or type what you need above. Everything lands in one running list, grouped by aisle.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button size="lg" variant="outline" nativeButton={false} render={<Link to="/household/recipes" />}>
          <BookOpenText data-icon="inline-start" aria-hidden="true" />
          Open your box
        </Button>
        <Button size="lg" variant="outline" nativeButton={false} render={<Link to="/household/plan" />}>
          <CalendarRange data-icon="inline-start" aria-hidden="true" />
          Open the planner
        </Button>
      </div>
    </div>
  );
}
