import type { SaveRecipeResult } from "#/lib/api";

/**
 * What the user should be told after asking to publish a recipe.
 *
 * Publishing resolves most of its refusals instead of throwing them (see
 * `SaveRecipeResult`), so every caller has to read the union, and a caller that
 * only checks for the cases it knows about treats the rest as success: the
 * dialog closes, a `recipe_published` event fires, and the recipe is still
 * private. This mapping is the one place that reads the union for feedback. Its
 * `switch` is exhaustive, so a status added to the union fails to compile here
 * rather than falling through to "published" at some call site.
 *
 * - `success` — the recipe is public now. The only kind analytics should count.
 * - `reauth` — the atproto grant predates the scopes publishing needs. Callers
 *   already render their own reconnect prompt for this, so it carries no message.
 * - `toast` — anything else. `reason` says which refusal it was, for callers
 *   that have a richer surface than a toast for some of them (the create form
 *   has inline issues and a duplicate dialog). `openRecipeId` is set when there
 *   is an existing recipe worth linking to; `replacesRecipeId` is set beside it
 *   when the recipe being published is a copy of that one, so the link can
 *   offer to swap the copy out (`?replaces=` on the recipe route).
 */
export type PublishFeedback =
  | { kind: "success"; recipeId: string }
  | { kind: "reauth"; missingScope: string | null }
  | {
      kind: "toast";
      reason: "duplicate" | "invalid" | "publish_disabled" | "not_published" | "error";
      message: string;
      /** `destructive` for failures; `default` for refusals that are nobody's fault. */
      variant: "default" | "destructive";
      openRecipeId?: string;
      replacesRecipeId?: string;
    };

export const PUBLISH_DISABLED_MESSAGE = "Publishing is turned off right now — kept private.";
export const PUBLISH_FAILED_MESSAGE = "Couldn’t publish right now. Try again.";

/**
 * `sourceRecipeId` is the recipe the publish was asked for, when the caller
 * has one (publishing an existing draft). A first-time create has no id to
 * hand over yet, so its duplicate link is a plain "Open it".
 */
export function describePublishOutcome(result: SaveRecipeResult, sourceRecipeId?: string): PublishFeedback {
  switch (result.status) {
    case "ok":
      // `ok` also covers a plain draft save. Reaching here after asking to
      // publish and getting `published: false` means it is still private, which
      // is not something to celebrate silently.
      return result.published
        ? { kind: "success", recipeId: result.recipeId }
        : { kind: "toast", reason: "not_published", message: "Saved, but not published — it’s still private.", variant: "default" };
    case "invalid": {
      const first = result.issues.find((issue) => issue.message.trim())?.message.trim();
      return {
        kind: "toast",
        reason: "invalid",
        message: first ? `Couldn’t publish: ${first}` : "Couldn’t publish — something in this recipe needs fixing first.",
        variant: "destructive",
      };
    }
    case "duplicate":
      // Dedupe is by source link: another public recipe already credits the
      // same page, and publishing a second copy would split its readers.
      return {
        kind: "toast",
        reason: "duplicate",
        message: "This one’s already published — a public recipe from the same source link exists.",
        variant: "default",
        openRecipeId: result.existingRecipeId,
        // A recipe cannot replace itself; that would offer to unbox the very
        // recipe the reader is being sent to.
        ...(sourceRecipeId && sourceRecipeId !== result.existingRecipeId ? { replacesRecipeId: sourceRecipeId } : {}),
      };
    case "publish_disabled":
      return { kind: "toast", reason: "publish_disabled", message: PUBLISH_DISABLED_MESSAGE, variant: "default" };
    case "reauth_required":
      return { kind: "reauth", missingScope: result.missingScope };
    default: {
      const unhandled: never = result;
      return unhandled;
    }
  }
}

/**
 * A publish that threw — network down, server 500, a PDS error that isn't a
 * scope problem. The raw message is for the console, not the reader: it is a
 * stack-trace sentence ("fetch failed") that offers nothing to act on.
 */
export function describePublishError(_error: unknown): PublishFeedback {
  return { kind: "toast", reason: "error", message: PUBLISH_FAILED_MESSAGE, variant: "destructive" };
}
