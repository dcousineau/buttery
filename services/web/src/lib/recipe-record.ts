import { $safeValidate, main as recipeRecordSchema } from "@buttery/lexicons/exchange/recipe/recipe";
import type { Main as RecipeRecord } from "@buttery/lexicons/exchange/recipe/recipe";

/**
 * The recipe record's shape and the one validator that judges it.
 *
 * This module exists so the *client* can ask "would the server reject this?" without
 * guessing. `persistRecipeDraft` (services/web/src/server/recipes-write.ts) is the single
 * write path and gates on `exchange.recipe.recipe`'s lexicon schema; the import review
 * screen's "Needs a fix" rail group has to answer the same question before the commit, and
 * a second hand-written copy of the length caps would drift from the lexicon the moment
 * anyone edited a `maxLength` — the user would be told 1000 while the server enforced 1200.
 *
 * So both sides call in here, and everything below is derived from the generated schema
 * objects rather than restated. It lives in `#/lib` because the import pipeline may not
 * import `#/server/*` for values (the client bundle would swallow `createServerFn` and the
 * db) — `#/lib` is the ground both sides legally stand on. Nothing here touches the network,
 * the filesystem or the DOM; it is pure and isomorphic.
 */

// The record the client sends — everything the author controls. $type and the
// createdAt/updatedAt timestamps are stamped server-side; `embed` (the image
// blob) is built server-side on publish, never sent over the wire.
export type RecipeRecordInput = Omit<RecipeRecord, "$type" | "createdAt" | "updatedAt" | "embed">;

/** One lexicon rejection, addressed by dotted record path. What `saveRecipe` reports. */
export interface FieldIssue {
  path: string;
  message: string;
}

/**
 * A structural view of `@atproto/lex-schema`'s runtime schema objects.
 *
 * The generated `l.record<'any', Main>(...)` call resolves to the overload whose `schema`
 * is typed `Validator<Omit<Main, '$type'>>` — an interface with `safeValidate` and nothing
 * else — even though the value at runtime is the `ObjectSchema` it was handed. These types
 * describe only what the walk below reads, so the one cast is narrow and checked: if the
 * library's runtime shape changes, `SHAPE` is `undefined` and `recipeRecordProblems` returns
 * nothing rather than throwing (see the guard in `computeProblems`).
 */
interface LexIssue {
  readonly code: string;
  readonly message: string;
  /** `too_big` / `too_small` carry the cap and what was measured. */
  readonly maximum?: number;
  readonly minimum?: number;
  readonly actual?: number;
  /** What was measured: "string" (characters), "array" (elements), … */
  readonly type?: string;
}
type LexResult = { success: true } | { success: false; reason: { issues: readonly LexIssue[] } };
interface LexValidator {
  readonly type: string;
  /** Element schema on arrays; the wrapped schema on `optional`. */
  readonly validator?: LexValidator;
  safeValidate(input: unknown): LexResult;
}

const SHAPE: Record<string, LexValidator> | undefined = (recipeRecordSchema.schema as unknown as { shape?: Record<string, LexValidator> }).shape;

/**
 * Fields the author cannot be held responsible for, and why each one is excluded.
 *
 * Every exclusion is a case where a problem here would be a *lie* — the user would be shown
 * a blocker for something the server either fills in itself or quietly repairs.
 */
const NOT_THE_AUTHORS_TO_ANSWER = new Set([
  // Stamped by `persistRecipeDraft` after this record leaves the client.
  "$type",
  "createdAt",
  "updatedAt",
  // Built server-side from the uploaded/fetched image bytes on publish.
  "embed",
  // The lexicon marks attribution optional; Buttery's stricter "every recipe needs a
  // source" rule lives in `resolveAttribution`, and the import rail already asks that
  // question as its own step ("Needs a source"). Reporting it here would double-ask it.
  "attribution",
  // `applyTags` in server/recipe-import.ts drops keywords longer than 64 characters
  // *before* validating, so an over-long tag can never become a server rejection.
  "keywords",
]);

/**
 * How a field is named to a human.
 *
 * `label` titles the card ("Step 4"); `subject` opens the sentence ("This step is 1,120
 * characters…"). Lexicon paths are wire names — telling someone their `instructions.0` is
 * too big is the raw Zod-ish message the rail exists to replace.
 */
interface FieldCopy {
  label: (index: number | null) => string;
  subject: string;
  /** Plural noun, for a cap on the number of elements rather than their length. */
  plural?: string;
}

const ORDINAL_COPY = (noun: string, subject: string, plural: string): FieldCopy => ({
  label: (index) => (index === null ? noun : `${noun} ${index + 1}`),
  subject,
  plural,
});

const FIELD_COPY: Record<string, FieldCopy> = {
  name: { label: () => "Recipe name", subject: "The recipe name" },
  text: { label: () => "Description", subject: "The description" },
  ingredients: ORDINAL_COPY("Ingredient", "This ingredient", "ingredients"),
  instructions: ORDINAL_COPY("Step", "This step", "steps"),
  recipeYield: { label: () => "Yield", subject: "The yield" },
  prepTime: { label: () => "Prep time", subject: "The prep time" },
  cookTime: { label: () => "Cook time", subject: "The cook time" },
  totalTime: { label: () => "Total time", subject: "The total time" },
  recipeCategory: { label: () => "Category", subject: "The category" },
  recipeCuisine: { label: () => "Cuisine", subject: "The cuisine" },
  cookingMethod: { label: () => "Cooking method", subject: "The cooking method" },
  suitableForDiet: ORDINAL_COPY("Diet tag", "This diet tag", "diet tags"),
  nutrition: { label: () => "Nutrition", subject: "The nutrition facts" },
};

/** The fields `RecipeEditorPane` can actually put a cursor in. */
const EDITABLE_FIELDS = new Set(["name", "text", "ingredients", "instructions"]);

/** One thing the server would reject, said the way a person would say it. */
export interface RecordProblem {
  /** Dotted lexicon path — `instructions.3`. Stable id for a card. */
  path: string;
  /** Top-level record key — `instructions`. */
  field: string;
  /** Position within an array field, or null for the field as a whole. */
  index: number | null;
  /** Card title — "Step 4". */
  label: string;
  /** Plain-language failure — "This step is 1,120 characters; the limit is 1,000." */
  message: string;
  /** Whether the import editor can focus this field, or the fix has to happen upstream. */
  editable: boolean;
}

const NUMBER = new Intl.NumberFormat("en-US");

function copyFor(field: string): FieldCopy {
  return FIELD_COPY[field] ?? { label: () => field, subject: `“${field}”` };
}

/**
 * Turn one lexicon issue into a sentence.
 *
 * The size codes get real copy because they are the ones that actually fire on real exports
 * (a Paprika step pasted from a blog runs past 1,000 characters routinely). Everything else
 * falls back to the library's own message, which is at least accurate — better a slightly
 * technical sentence than a confidently wrong friendly one.
 */
function describe(field: string, issue: LexIssue): string {
  const copy = copyFor(field);
  const measuringElements = issue.type === "array";
  const subject = measuringElements ? "This recipe" : copy.subject;
  const unit = measuringElements ? (copy.plural ?? "entries") : "characters";
  const verb = measuringElements ? "has" : "is";

  if (issue.code === "too_big" && issue.maximum !== undefined && issue.actual !== undefined) {
    return `${subject} ${verb} ${NUMBER.format(issue.actual)} ${unit}; the limit is ${NUMBER.format(issue.maximum)}.`;
  }
  if (issue.code === "too_small" && issue.minimum !== undefined && issue.actual !== undefined) {
    if (issue.minimum === 1 && issue.actual === 0) {
      return measuringElements ? `This recipe has no ${unit}.` : `${subject} is empty.`;
    }
    return `${subject} ${verb} ${NUMBER.format(issue.actual)} ${unit}; at least ${NUMBER.format(issue.minimum)} required.`;
  }
  if (issue.code === "required_key" || issue.code === "invalid_type") return `${subject} is missing.`;
  return issue.message;
}

function problemFor(field: string, index: number | null, issue: LexIssue): RecordProblem {
  return {
    path: index === null ? field : `${field}.${index}`,
    field,
    index,
    label: copyFor(field).label(index),
    message: describe(field, issue),
    editable: EDITABLE_FIELDS.has(field),
  };
}

/** `optional(x)` / `withDefault(x)` wrap the schema that carries the real constraint. */
function unwrap(validator: LexValidator): LexValidator {
  let node = validator;
  while ((node.type === "optional" || node.type === "withDefault") && node.validator) node = node.validator;
  return node;
}

function computeProblems(record: RecipeRecordInput): RecordProblem[] {
  if (!SHAPE) return [];
  const problems: RecordProblem[] = [];
  const value = record as unknown as Record<string, unknown>;

  for (const [field, validator] of Object.entries(SHAPE)) {
    if (NOT_THE_AUTHORS_TO_ANSWER.has(field)) continue;
    const inner = unwrap(validator);
    const held = value[field];

    // Arrays are walked element by element on purpose. `ObjectSchema` stops at the first
    // failing property and `ArraySchema` stops at the first failing element, so a single
    // whole-record `$safeValidate` reports one issue no matter how many are wrong — the
    // user would fix step 3, re-check, and be told about step 7. Three over-long steps
    // have to be three cards.
    if (inner.type === "array" && inner.validator && Array.isArray(held)) {
      const whole = validator.safeValidate(held);
      if (!whole.success) {
        // Only the cap on the *number* of elements; per-element failures come from the loop.
        for (const issue of whole.reason.issues) if (issue.type === "array") problems.push(problemFor(field, null, issue));
      }
      const element = inner.validator;
      held.forEach((entry, index) => {
        const result = element.safeValidate(entry);
        if (result.success) return;
        for (const issue of result.reason.issues) problems.push(problemFor(field, index, issue));
      });
      continue;
    }

    const result = validator.safeValidate(held);
    if (result.success) continue;
    for (const issue of result.reason.issues) problems.push(problemFor(field, null, issue));
  }

  return problems;
}

/**
 * Memoised because the import rail asks this of every item on every render.
 *
 * Records are replaced wholesale by the state machine's reducer (never mutated in place),
 * so identity is a sound cache key and an edit always misses. A `WeakMap` keeps a 341-recipe
 * import from pinning every intermediate draft it ever produced.
 */
const CACHE = new WeakMap<object, RecordProblem[]>();

/**
 * Everything the lexicon would reject about this record, in record order.
 *
 * Empty means `persistRecipeDraft` will not return `status: "invalid"` for it — the same
 * schema, minus the fields listed in `NOT_THE_AUTHORS_TO_ANSWER` that the server fills in
 * or repairs on the way through.
 */
export function recipeRecordProblems(record: RecipeRecordInput): RecordProblem[] {
  const cached = CACHE.get(record);
  if (cached) return cached;
  const problems = computeProblems(record);
  CACHE.set(record, problems);
  return problems;
}

/**
 * The write path's gate: validate an assembled record against the lexicon.
 *
 * `persistRecipeDraft` calls this, which is what makes `recipeRecordProblems` above a real
 * prediction rather than a parallel opinion.
 */
export function validateRecipeRecord(full: unknown): { status: "ok"; record: RecipeRecord } | { status: "invalid"; issues: FieldIssue[] } {
  const validated = $safeValidate(full);
  if (validated.success) return { status: "ok", record: validated.value };
  return {
    status: "invalid",
    issues: validated.reason.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  };
}
