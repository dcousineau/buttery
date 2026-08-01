import { Fragment, useMemo } from "react";
import { parseStep } from "#/lib/timers/parse";
import { TimeToken } from "#/components/timers/TimeToken";

/**
 * Renders a recipe step, turning any duration into a tappable {@link TimeToken}
 * (plan §10). Shared by the `/household/recipes/{id}` detail method list and
 * cook-mode `StepView`, so "tap a duration to start a timer" behaves identically
 * in both places — only the token styling differs by `variant`.
 */
export function StepText({ text, recipeId, recipeTitle, variant = "detail" }: { text: string; recipeId: string; recipeTitle: string; variant?: "detail" | "cook" }) {
  const tokens = useMemo(() => parseStep(text), [text]);
  return (
    <>
      {tokens.map((token, i) =>
        token.isTime ? <TimeToken key={i} token={token} recipeId={recipeId} recipeTitle={recipeTitle} variant={variant} /> : <Fragment key={i}>{token.text}</Fragment>,
      )}
    </>
  );
}
