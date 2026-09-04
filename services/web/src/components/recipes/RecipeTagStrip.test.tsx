// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";

import { RecipeTagStrip } from "./RecipeTagStrip.tsx";

/**
 * The one behaviour a pure-function test cannot cover: a TOUCH tap opens the
 * provenance popup.
 *
 * This is why the strip uses `Infotip` (a Popover) rather than `Tooltip`. Base
 * UI's tooltip is hover-and-keyboard only by construction — `mouseOnly` hover,
 * `:focus-visible`-gated focus — so there was no event sequence an iOS user
 * could produce that opened it. If someone ever "simplifies" this back to a
 * `Tooltip`, these tests are what goes red.
 *
 * Everything about WHICH tags render and WHAT they say is covered by
 * `lib/recipe-tags.test.ts` against the pure merge; this file only pokes the
 * interaction, and only on the LLM chip — the rules chip shares one component.
 */

const AUTHOR = { cuisine: null, category: null, cookingMethod: null, diets: [] };

const LLM_LABEL = {
  dimension: "cuisine" as const,
  slug: "thai",
  verdict: "likely",
  source: "llm" as const,
  note: "fish sauce and lemongrass",
  method: "llm:openrouter:model@v1",
};

afterEach(cleanup);

function chip() {
  const element = screen.getByText("Thai").closest("[data-source='llm']");
  expect(element).not.toBeNull();
  return element!;
}

/** What iOS actually sends: a touch-typed pointerdown, then the click Safari synthesizes after it. */
function tap(element: Element) {
  fireEvent.pointerDown(element, { pointerType: "touch" });
  fireEvent.pointerUp(element, { pointerType: "touch" });
  fireEvent.click(element, { detail: 0 });
}

test("a touch tap opens the AI provenance popup", () => {
  render(<RecipeTagStrip author={AUTHOR} labels={[LLM_LABEL]} />);
  expect(screen.queryByText(/Identified by AI/)).toBeNull();

  tap(chip());

  expect(screen.getByText("Identified by AI — fish sauce and lemongrass")).toBeTruthy();
});

test("a second tap closes it again", () => {
  render(<RecipeTagStrip author={AUTHOR} labels={[LLM_LABEL]} />);

  tap(chip());
  expect(screen.getByText(/Identified by AI/)).toBeTruthy();

  tap(chip());
  expect(screen.queryByText(/Identified by AI/)).toBeNull();
});

// The disclosure semantics are the second half of what the Popover swap bought:
// a screen reader user can now find the provenance deliberately instead of
// depending on a hover-only `aria-describedby` that never fires on touch.
test("the chip exposes disclosure semantics, not a hover-only description", () => {
  render(<RecipeTagStrip author={AUTHOR} labels={[LLM_LABEL]} />);
  const trigger = chip();

  expect(trigger.getAttribute("aria-expanded")).toBe("false");

  tap(trigger);

  expect(trigger.getAttribute("aria-expanded")).toBe("true");
});

// The chip is a `span`, so every scrap of button semantics on it comes from
// `nativeButton={false}`. That prop defaults to `true`; left alone the chip is
// unreachable by keyboard, and nothing else in the suite would notice.
test("the chip is keyboard reachable and activates on Enter", () => {
  render(<RecipeTagStrip author={AUTHOR} labels={[LLM_LABEL]} />);
  const trigger = chip();

  expect(trigger.getAttribute("role")).toBe("button");
  expect(trigger.getAttribute("tabindex")).toBe("0");

  // Base UI opens on the keydown itself — no synthesized click needed, and
  // firing one here would toggle it straight back shut.
  fireEvent.keyDown(trigger, { key: "Enter" });

  expect(screen.getByText(/Identified by AI/)).toBeTruthy();
});

// The rules chip is a second, separate branch of `RecipeTagBadge`. It was left
// behind on `Tooltip` once during this very change and only a lint error
// caught it — so it gets its own tap assertion rather than trusting that both
// branches were edited together.
test("the rules-classifier chip opens on tap too", () => {
  render(<RecipeTagStrip author={AUTHOR} labels={[{ dimension: "allergen", slug: "milk", verdict: "contains", source: "rules", note: null, method: "rules@2" }]} />);

  const trigger = screen.getByText(/milk/i).closest("[data-source='rules']");
  expect(trigger).not.toBeNull();

  fireEvent.pointerDown(trigger!, { pointerType: "touch" });
  fireEvent.click(trigger!, { detail: 0 });

  expect(screen.getByText(/Detected from the ingredient list/)).toBeTruthy();
});
