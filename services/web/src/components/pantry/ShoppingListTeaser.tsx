import { Link } from "@tanstack/react-router";
import { ShoppingBasket } from "lucide-react";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { cn } from "#/lib/utils";

/**
 * The shopping list card on `/household`.
 *
 * This used to be the feature's placeholder — softened border, no shadow, a
 * `soon` chip — and its own doc explained that it was deliberately **not** a
 * `Card` because a card reads as a live object you can act on. It is one now.
 * The list is built, so the panel takes the full card construction (2px ink,
 * `shadow-pop-md`) and matches `WeekAheadCard` beside it in the same grid.
 *
 * Still presentational: it links, it does not fetch. Anything that needs to know
 * what is on the list belongs on the list.
 */

export interface ShoppingListTeaserProps {
  className?: string;
}

export function ShoppingListTeaser({ className }: ShoppingListTeaserProps) {
  return (
    <Card className={cn("gap-0", className)}>
      <CardHeader>
        <span className="inline-flex text-muted-foreground">
          <ShoppingBasket className="size-5" aria-hidden="true" />
        </span>
        <CardTitle>Shopping list</CardTitle>
        <CardDescription>One running list for the household — pull in a recipe or a whole week from the planner and it consolidates itself, grouped by aisle.</CardDescription>
      </CardHeader>
      <CardContent>
        <Button size="sm" nativeButton={false} render={<Link to="/household/list" />}>
          <ShoppingBasket data-icon="inline-start" aria-hidden="true" />
          Open the list
        </Button>
      </CardContent>
    </Card>
  );
}
