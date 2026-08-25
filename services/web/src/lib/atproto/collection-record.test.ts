import { describe, expect, it } from "vitest";
import { $safeValidate } from "@buttery/lexicons/exchange/recipe/collection";
import { buildCollectionRecord } from "./collection-writes";

/**
 * `buildCollectionRecord` is the whole of the collection publish path that can be
 * tested without a PDS: everything else in `collection-writes.ts` is a network call.
 * The properties worth pinning are the ones a reader of the lexicon cannot infer and
 * a future refactor could quietly break — array order *is* the collection order,
 * "empty" and "no description" are spelled as absent fields rather than empty ones,
 * and `createdAt` is replayed from storage rather than read off the clock.
 */

const RECIPE_URI = "at://did:plc:z72i7hdynmk6r22z27h6tvur/exchange.recipe.recipe/01JX0000000000000000000000";
const OTHER_URI = "at://did:plc:z72i7hdynmk6r22z27h6tvur/exchange.recipe.recipe/01JX0000000000000000000001";
const THIRD_URI = "at://did:plc:z72i7hdynmk6r22z27h6tvur/exchange.recipe.recipe/01JX0000000000000000000002";

const CID_A = "bafyreidwslb22nkaxoadyaqlhlxgntmiq4jdenhkbrxhcq6avxlt75br5u";
const CID_B = "bafyreib7ytgp45cyodrmbwm7ohzq74dfnsg63va4yhl5hu3wwdn6nbpc6m";
const CID_C = "bafyreielloo3bqj5wjbfnsbjvi3evkimnuxlummlsizkjk4tco4vju2vl4";

const CREATED = new Date("2026-08-20T10:00:00.000Z");
const UPDATED = new Date("2026-08-21T18:30:00.000Z");

function build(over: Partial<Parameters<typeof buildCollectionRecord>[0]> = {}) {
  return buildCollectionRecord({ name: "Weeknight dinners", description: null, recipes: [], createdAt: CREATED, updatedAt: UPDATED, ...over });
}

describe("buildCollectionRecord", () => {
  it("writes the refs in the order given, because that order is the collection's order", () => {
    // The lexicon has no position field: the only place a collection's ordering can
    // live once published is the index of each ref. A `.sort()` slipped in anywhere
    // between the DB read and here would silently republish someone's hand-ordered
    // collection in some other order.
    const record = build({
      recipes: [
        { uri: OTHER_URI, cid: CID_B },
        { uri: THIRD_URI, cid: CID_C },
        { uri: RECIPE_URI, cid: CID_A },
      ],
    });
    expect(record.recipes).toEqual([
      { uri: OTHER_URI, cid: CID_B },
      { uri: THIRD_URI, cid: CID_C },
      { uri: RECIPE_URI, cid: CID_A },
    ]);
  });

  it("omits `recipes` for an empty collection rather than publishing an empty array", () => {
    // `recipes` is optional in the lexicon, so an empty collection is legal — and
    // absent is its canonical spelling. Publishing `recipes: []` would be valid but
    // is a second way to say the same thing for every consumer to handle.
    const record = build({ recipes: [] });
    expect(record.recipes).toBeUndefined();
    expect(Object.hasOwn(record, "recipes")).toBe(false);
  });

  it("omits `text` when there is no description", () => {
    // `description` is NULL-means-none locally; `text` is optional upstream. The one
    // shape that must never reach a PDS is `text: undefined`, which is not valid lex
    // data — hence the own-property assertion rather than a `toBeUndefined()`.
    const record = build({ description: null });
    expect(Object.hasOwn(record, "text")).toBe(false);
  });

  it("maps a description onto the lexicon's `text`", () => {
    expect(build({ description: "Fast, boring, reliable." }).text).toBe("Fast, boring, reliable.");
  });

  it("replays the createdAt it is handed instead of stamping now", () => {
    // Re-puts rebuild the record from scratch, so `createdAt` has to come from the
    // frozen `record_created_at` column. If this function reached for the clock, every
    // edit would move the record's creation date forward.
    const record = build({ recipes: [{ uri: RECIPE_URI, cid: CID_A }] });
    expect(record.createdAt).toBe("2026-08-20T10:00:00.000Z");
    expect(record.updatedAt).toBe("2026-08-21T18:30:00.000Z");
    expect(record.createdAt).not.toBe(record.updatedAt);
  });

  it("produces a record the lexicon itself accepts", () => {
    // The build is hand-rolled rather than routed through `$build`, so the generated
    // schema gets the last word on both the full and the minimal shape.
    expect($safeValidate(build({ description: "Notes.", recipes: [{ uri: RECIPE_URI, cid: CID_A }] })).success).toBe(true);
    expect($safeValidate(build()).success).toBe(true);
  });

  it("rejects a ref that is not an at:// uri", () => {
    // A bad ref is worth catching here, with the offending uri in hand, rather than as
    // an opaque 400 from the PDS halfway through a publish.
    expect(() => build({ recipes: [{ uri: "https://buttery.recipes/r/01JX", cid: CID_A }] })).toThrow();
  });

  it("stamps the record `$type`", () => {
    expect(build().$type).toBe("exchange.recipe.collection");
  });
});
