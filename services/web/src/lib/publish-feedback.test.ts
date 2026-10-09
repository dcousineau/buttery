import { describe, expect, it } from "vitest";
import { PUBLISH_DISABLED_MESSAGE, PUBLISH_FAILED_MESSAGE, describePublishError, describePublishOutcome } from "./publish-feedback";

/**
 * Every arm of `SaveRecipeResult` maps to feedback, and only a real publish
 * counts as success. The duplicate case is the one that shipped silent: the
 * confirm dialog closed and the recipe stayed private with nothing said.
 */

describe("describePublishOutcome", () => {
  it("treats a published ok as the only success", () => {
    expect(describePublishOutcome({ status: "ok", recipeId: "r1", published: true })).toEqual({ kind: "success", recipeId: "r1" });
  });

  it("does not call an unpublished ok a success", () => {
    const feedback = describePublishOutcome({ status: "ok", recipeId: "r1", published: false });
    expect(feedback).toMatchObject({ kind: "toast", reason: "not_published" });
  });

  it("explains a duplicate and links to the recipe that already exists", () => {
    const feedback = describePublishOutcome({ status: "duplicate", existingRecipeId: "r-existing" });
    expect(feedback).toMatchObject({ kind: "toast", reason: "duplicate", openRecipeId: "r-existing" });
    if (feedback.kind === "toast") expect(feedback.message).toMatch(/already published/);
    // No source id (a first-time create): nothing to offer to replace.
    expect(feedback).not.toHaveProperty("replacesRecipeId");
  });

  it("carries the draft being published so the link can offer to replace it", () => {
    const feedback = describePublishOutcome({ status: "duplicate", existingRecipeId: "r-existing" }, "r-draft");
    expect(feedback).toMatchObject({ kind: "toast", reason: "duplicate", openRecipeId: "r-existing", replacesRecipeId: "r-draft" });
  });

  it("never offers to replace a recipe with itself", () => {
    const feedback = describePublishOutcome({ status: "duplicate", existingRecipeId: "r1" }, "r1");
    expect(feedback).toMatchObject({ openRecipeId: "r1" });
    expect(feedback).not.toHaveProperty("replacesRecipeId");
  });

  it("ignores the source id for anything but a duplicate", () => {
    expect(describePublishOutcome({ status: "ok", recipeId: "r1", published: true }, "r1")).toEqual({ kind: "success", recipeId: "r1" });
  });

  it("surfaces the first non-empty validation issue", () => {
    const feedback = describePublishOutcome({
      status: "invalid",
      issues: [
        { path: "name", message: "  " },
        { path: "recipeId", message: "Draft not found." },
        { path: "text", message: "Too long." },
      ],
    });
    expect(feedback).toMatchObject({ kind: "toast", reason: "invalid", variant: "destructive", message: "Couldn’t publish: Draft not found." });
  });

  it("falls back to a generic sentence when invalid carries no issues", () => {
    const feedback = describePublishOutcome({ status: "invalid", issues: [] });
    expect(feedback).toMatchObject({ kind: "toast", reason: "invalid" });
    if (feedback.kind === "toast") expect(feedback.message).toMatch(/^Couldn’t publish/);
  });

  it("says publishing is turned off", () => {
    expect(describePublishOutcome({ status: "publish_disabled", recipeId: "r1" })).toEqual({
      kind: "toast",
      reason: "publish_disabled",
      message: PUBLISH_DISABLED_MESSAGE,
      variant: "default",
    });
  });

  it("hands reauth to the caller's reconnect prompt", () => {
    expect(describePublishOutcome({ status: "reauth_required", recipeId: "r1", missingScope: "repo:exchange.recipe.recipe" })).toEqual({
      kind: "reauth",
      missingScope: "repo:exchange.recipe.recipe",
    });
  });
});

describe("describePublishError", () => {
  it("gives a generic retry message instead of the raw error", () => {
    expect(describePublishError(new TypeError("fetch failed"))).toEqual({ kind: "toast", reason: "error", message: PUBLISH_FAILED_MESSAGE, variant: "destructive" });
  });
});
