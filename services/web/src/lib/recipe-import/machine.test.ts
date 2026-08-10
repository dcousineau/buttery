import { describe, expect, it } from "vitest";
import type { ImportCandidate } from "@buttery/recipe-extract/import";
import type { CommitItemResult, ProbeVerdict } from "./contracts.ts";
import {
  batchDuplicateOf,
  commitBlockedReason,
  commitChunks,
  commitItemFor,
  commitProgress,
  defaultAction,
  failedItems,
  finalizeOutcome,
  importEventForWorkerMessage,
  initialState,
  itemsInGroup,
  nextCommitChunk,
  probeItems,
  railCounts,
  railGroupOf,
  reduce,
  selectedForCommit,
  type ImportEvent,
  type ImportState,
} from "./machine.ts";
import { NO_SOURCE_GROUP_KEY } from "./source-groups.ts";
import type { ImportWorkerEvent, ParsedItem } from "./worker-protocol.ts";

/**
 * The client state machine (plan §9), driven end to end as plain function calls.
 *
 * The point of `machine.ts` being a pure reducer is that `drop → reading → review →
 * committing → done` — failed chunk, retry, and all — can be exercised with no DOM, no
 * worker, no network, and no database. Two properties in here are load-bearing rather than
 * illustrative:
 *
 *   - **§7.1 keys-only.** `probeItems` is asserted on its exact key set, not just on the
 *     values it carries, so a later edit that starts shipping ingredients to the probe
 *     fails here instead of shipping.
 *   - **§7.5 resumability.** A failed chunk retried must re-send only the items with no
 *     result yet; the test below fails the first chunk, half-answers it, and checks the
 *     retry payload is the complement.
 */

let seq = 0;

function candidate(over: Partial<ImportCandidate> & { name?: string } = {}): ImportCandidate {
  const n = ++seq;
  const { name, ...rest } = over;
  return {
    kind: "candidate",
    clientId: `c${n}`,
    recipe: { name: name ?? `Recipe ${n}`, ingredients: [`${n} eggs`, "salt"], instructions: ["Mix.", "Bake."] },
    sourceUrl: null,
    sourceText: null,
    notes: null,
    tags: [],
    imageUrl: null,
    localImagePath: null,
    entryName: `Recipe ${n}.html`,
    meta: {},
    ...rest,
  };
}

function parsed(c: ImportCandidate, keys: { sourceUrlKey?: string | null; contentFp?: string } = {}): ParsedItem {
  return { candidate: c, sourceUrlKey: keys.sourceUrlKey ?? null, contentFp: keys.contentFp ?? `sha256:${c.clientId}` };
}

function run(state: ImportState, ...events: ImportEvent[]): ImportState {
  return events.reduce(reduce, state);
}

/** Drive `drop → reading → review` for a set of parsed items, with every verdict `new`. */
function toReview(items: ParsedItem[], verdicts?: ProbeVerdict[]): ImportState {
  return run(
    initialState("fixture"),
    { type: "drop_accepted", fileName: "My Recipes" },
    { type: "session_opened", sessionId: "s1" },
    { type: "parse_complete", result: { items, failures: [] } },
    { type: "probe_complete", verdicts: verdicts ?? items.map((item) => ({ clientId: item.candidate.clientId, verdict: "new" as const })) },
  );
}

describe("phases", () => {
  it("walks drop → reading → review → committing → done", () => {
    const items = [parsed(candidate({ sourceUrl: "https://example.com/a" })), parsed(candidate({ sourceUrl: "https://example.com/b" }))];

    let state = initialState("fixture");
    expect(state.phase).toBe("drop");

    state = reduce(state, { type: "drop_accepted", fileName: "My Recipes" });
    expect(state.phase).toBe("reading");
    expect(state.progress).toEqual({ stage: "read", done: 0, total: null });

    state = reduce(state, { type: "session_opened", sessionId: "s1" });
    state = reduce(state, { type: "progress", progress: { stage: "parse", done: 1, total: 2 } });
    expect(state.progress).toEqual({ stage: "parse", done: 1, total: 2 });

    state = reduce(state, { type: "parse_complete", result: { items, failures: [] } });
    expect(state.phase).toBe("reading");
    expect(state.progress?.stage).toBe("probe");
    expect(state.items).toHaveLength(2);

    state = reduce(state, { type: "probe_complete", verdicts: items.map((item) => ({ clientId: item.candidate.clientId, verdict: "new" as const })) });
    expect(state.phase).toBe("review");
    expect(state.progress).toBeNull();
    // Both have URLs, so no source group needs answering and the rail opens on the first
    // group that has anything in it.
    expect(state.activeGroup).toBe("ready");

    state = reduce(state, { type: "commit_start" });
    expect(state.phase).toBe("committing");
    expect(state.commit?.order).toHaveLength(2);

    const results: CommitItemResult[] = state.commit!.order.map((clientId) => ({ clientId, status: "imported" as const, recipeId: `r-${clientId}` }));
    state = reduce(state, { type: "chunk_complete", results });
    expect(commitProgress(state)).toEqual({ done: 2, total: 2 });
    expect(nextCommitChunk(state)).toBeNull();

    state = reduce(state, { type: "finalized" });
    expect(state.phase).toBe("done");
    expect(state.commit?.finalized).toBe(true);
    expect(finalizeOutcome(state).imported).toBe(2);
  });

  it("late worker progress cannot drag a finished run back to reading", () => {
    const state = toReview([parsed(candidate())]);
    const after = reduce(state, { type: "progress", progress: { stage: "parse", done: 3, total: 9 } });
    expect(after.phase).toBe("review");
    expect(after.progress).toBeNull();
  });

  it("a failure moves to `failed` and keeps the reason", () => {
    const state = reduce(initialState("fixture"), { type: "failed", failure: { code: "too_large", message: "That folder is too big.", retryable: true } });
    expect(state.phase).toBe("failed");
    expect(state.error?.code).toBe("too_large");
  });
});

describe("probe payload", () => {
  it("sends keys only — never a recipe body (§7.1)", () => {
    const beef = candidate({ name: "Beef Bourguignon", sourceUrl: "https://example.com/beef", notes: "Nana's" });
    const state = toReview([parsed(beef, { sourceUrlKey: "example.com/beef", contentFp: "sha256:aaa" })]);

    const payload = probeItems(state);
    expect(payload).toHaveLength(1);
    // The exact key set, not a subset: an added field is the failure this guards against.
    expect(Object.keys(payload[0]).sort()).toEqual(["clientId", "contentFp", "sourceUrlKey", "title"]);
    expect(payload[0]).toEqual({ clientId: beef.clientId, sourceUrlKey: "example.com/beef", contentFp: "sha256:aaa", title: "Beef Bourguignon" });

    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("eggs");
    expect(serialized).not.toContain("Nana's");
    expect(serialized).not.toContain("Bake.");
  });
});

describe("in-batch collapse (§6.3)", () => {
  it("keeps the first entry per key and counts the rest", () => {
    const a = candidate({ sourceUrl: "https://example.com/x" });
    const b = candidate({ sourceUrl: "https://example.com/x" });
    const c = candidate();
    const state = toReview(
      [parsed(a, { sourceUrlKey: "example.com/x" }), parsed(b, { sourceUrlKey: "example.com/x" }), parsed(c, { contentFp: "sha256:zzz" })],
      // Only the survivors are probed.
      [
        { clientId: a.clientId, verdict: "new" },
        { clientId: c.clientId, verdict: "new" },
      ],
    );

    expect(state.items.map((item) => item.clientId)).toEqual([a.clientId, c.clientId]);
    expect(state.collapsedInBatch).toBe(1);
  });
});

describe("verdicts and rail groups", () => {
  it("defaults each verdict the way §6.3's table does", () => {
    expect(defaultAction("new")).toBe("import");
    expect(defaultAction("maybe")).toBe("import");
    expect(defaultAction("in_box")).toBe("skip");
    expect(defaultAction("public_exists")).toBe("link");
    expect(defaultAction("dupe_in_batch")).toBe("skip");

    expect(railGroupOf("new")).toBe("ready");
    expect(railGroupOf("maybe")).toBe("maybe");
    expect(railGroupOf("in_box")).toBe("in_box");
    expect(railGroupOf("dupe_in_batch")).toBe("in_box");
    expect(railGroupOf("public_exists")).toBe("public");
  });

  it("counts `sources` as cross-cutting, so the rail does not sum to the total (§10.3)", () => {
    const withUrl = candidate({ sourceUrl: "https://example.com/a" });
    const noUrl = candidate({ sourceText: "Ottolenghi Simple pg 174" });
    const noSource = candidate();
    const state = toReview([parsed(withUrl), parsed(noUrl), parsed(noSource)]);

    const counts = railCounts(state);
    expect(counts.ready).toBe(3);
    expect(counts.sources).toBe(2); // both URL-less items, also counted under `ready`
    expect(counts.sources + counts.maybe + counts.in_box + counts.public + counts.ready).toBeGreaterThan(state.items.length);
    // Two distinct strings: the book, and the synthetic "no source at all" group (§8.2).
    expect(state.groups.map((group) => group.key).sort()).toEqual([NO_SOURCE_GROUP_KEY, "Ottolenghi Simple pg 174"]);
    expect(counts.unansweredGroups).toBe(2);
  });

  it("seeds `existing` from the probe and lands the rail on the first non-empty group", () => {
    // Both carry a URL, so the cross-cutting `sources` group is empty and the rail opens on
    // the first verdict group instead.
    const mine = candidate({ sourceUrl: "https://example.com/m" });
    const flagged = candidate({ sourceUrl: "https://example.com/f" });
    const state = toReview(
      [parsed(mine, { sourceUrlKey: "example.com/m" }), parsed(flagged, { sourceUrlKey: "example.com/f" })],
      [
        { clientId: mine.clientId, verdict: "in_box", existing: { recipeId: "r1", name: "Mine", addedAt: "2026-01-01T00:00:00Z", addedByHandle: "@dan" } },
        { clientId: flagged.clientId, verdict: "maybe", candidates: [{ recipeId: "r2", name: "Close", addedAt: "2026-01-02T00:00:00Z", addedByHandle: null }] },
      ],
    );

    expect(state.activeGroup).toBe("maybe");
    expect(state.activeItemId).toBe(flagged.clientId);
    expect(itemsInGroup(state, "in_box")[0].existing?.recipeId).toBe("r1");
    expect(itemsInGroup(state, "maybe")[0].matches).toHaveLength(1);
    expect(itemsInGroup(state, "in_box")[0].action).toBe("skip");
  });
});

describe("attribution gating (§8, §10.1)", () => {
  it("blocks commit until every distinct source string is answered", () => {
    const state = toReview([parsed(candidate({ sourceText: "Gordon Ramsay" })), parsed(candidate({ sourceText: "Gordon Ramsay" }))]);
    expect(state.groups).toHaveLength(1);
    expect(commitBlockedReason(state)).toBe("1 source needs an answer before anything can be imported.");

    const key = state.groups[0].key;
    const partial = run(state, { type: "set_group_kind", groupKey: key, kind: "publication" }, { type: "set_group_field", groupKey: key, field: "publicationTitle", value: "Ramsay in 10" });
    // Publication needs BOTH title and author — the lexicon requires both and the server
    // silently drops a half-filled one, so the client refuses to send it.
    expect(commitBlockedReason(partial)).not.toBeNull();

    const answered = reduce(partial, { type: "set_group_field", groupKey: key, field: "publicationAuthor", value: "Gordon Ramsay" });
    expect(commitBlockedReason(answered)).toBeNull();
    expect(railCounts(answered).unansweredGroups).toBe(0);
  });

  it("resolves each item's attribution from its group, verbatim source text and all", () => {
    const state = toReview([parsed(candidate({ sourceText: "Ottolenghi Simple pg 174" }))]);
    const key = state.groups[0].key;
    const answered = run(
      state,
      { type: "set_group_kind", groupKey: key, kind: "publication" },
      { type: "set_group_field", groupKey: key, field: "publicationAuthor", value: "Yotam Ottolenghi" },
    );

    const commitItem = commitItemFor(answered, answered.items[0]);
    expect(commitItem.action).toBe("import");
    if (commitItem.action !== "import") throw new Error("unreachable");
    // The `pg 174` split prefilled the title; the page reference is not lost because
    // `sourceText` rides along whole (§8.1, §12.5).
    expect(commitItem.attribution).toEqual({ kind: "publication", title: "Ottolenghi Simple", author: "Yotam Ottolenghi" });
    expect(commitItem.sourceText).toBe("Ottolenghi Simple pg 174");
  });

  it("sends no attribution when the URL already answers it", () => {
    const state = toReview([parsed(candidate({ sourceUrl: "https://example.com/a", sourceText: "example.com" }))]);
    expect(state.groups).toHaveLength(0);
    const commitItem = commitItemFor(state, state.items[0]);
    if (commitItem.action !== "import") throw new Error("unreachable");
    expect(commitItem.attribution).toBeNull();
    expect(commitItem.sourceUrl).toBe("https://example.com/a");
  });

  it("`skip` leaves the group's recipes behind rather than importing them unattributed (§8.1)", () => {
    // The server refuses a record with no lexicon-valid attribution, so "leave it
    // unattributed" is not a thing the client can send — the chip means `skipped:user`.
    const state = toReview([parsed(candidate({ sourceText: "from mum" })), parsed(candidate({ sourceText: "from mum" })), parsed(candidate({ sourceUrl: "https://example.com/a" }))]);
    const key = state.groups[0].key;

    const answered = reduce(state, { type: "set_group_kind", groupKey: key, kind: "skip" });

    expect(answered.items.filter((item) => item.action === "skip")).toHaveLength(2);
    expect(selectedForCommit(answered).map((item) => item.sourceUrl)).toEqual(["https://example.com/a"]);
    expect(commitBlockedReason(answered)).toBeNull(); // the URL-answered one still imports
    expect(commitItemFor(answered, answered.items[0]).action).toBe("skip");
  });

  it("re-answering a skipped group brings its recipes back", () => {
    const state = toReview([parsed(candidate({ sourceText: "Nana's book" }))]);
    const key = state.groups[0].key;

    let next = reduce(state, { type: "set_group_kind", groupKey: key, kind: "skip" });
    expect(next.items[0].action).toBe("skip");

    next = reduce(next, { type: "set_group_kind", groupKey: key, kind: "person" });
    next = reduce(next, { type: "set_group_field", groupKey: key, field: "personName", value: "Nana" });

    expect(next.items[0].action).toBe("import");
    const commitItem = commitItemFor(next, next.items[0]);
    if (commitItem.action !== "import") throw new Error("unreachable");
    expect(commitItem.attribution).toEqual({ kind: "person", name: "Nana" });
    expect(commitItem.sourceText).toBe("Nana's book");
  });

  it("a group answered only with `skip` leaves nothing to write, and that is a finishable import", () => {
    const state = toReview([parsed(candidate({ sourceText: "from mum" }))]);
    const key = state.groups[0].key;

    const answered = reduce(state, { type: "set_group_kind", groupKey: key, kind: "skip" });

    // Every source string is answered, so nothing is blocking: a commit that writes nothing
    // is a real outcome, and the user still has to be able to reach the summary that says so.
    expect(selectedForCommit(answered)).toHaveLength(0);
    expect(commitBlockedReason(answered)).toBeNull();
    // It is still SENT, as a `skip` item: that is the only way the session row can account
    // for the recipe (§7.2).
    expect(commitItemFor(answered, answered.items[0])).toEqual({ clientId: answered.items[0].clientId, entryName: answered.items[0].entryName, action: "skip", reason: "user" });
  });
});

describe("per-item decisions", () => {
  it("an override implies import, and stepping off import retracts it (D23)", () => {
    const mine = candidate();
    let state = toReview(
      [parsed(mine)],
      [{ clientId: mine.clientId, verdict: "in_box", existing: { recipeId: "r1", name: "Mine", addedAt: "2026-01-01T00:00:00Z", addedByHandle: null } }],
    );
    expect(state.items[0].action).toBe("skip");

    state = reduce(state, { type: "set_override", clientId: mine.clientId, override: true });
    expect(state.items[0]).toMatchObject({ override: true, action: "import" });
    const commitItem = commitItemFor(state, state.items[0]);
    if (commitItem.action !== "import") throw new Error("unreachable");
    expect(commitItem.override).toBe("duplicate");

    state = reduce(state, { type: "set_action", clientId: mine.clientId, action: "skip" });
    expect(state.items[0]).toMatchObject({ override: false, action: "skip" });
  });

  it("a `link` sends the existing recipe id and no record", () => {
    const pub = candidate();
    const state = toReview(
      [parsed(pub)],
      [{ clientId: pub.clientId, verdict: "public_exists", existing: { recipeId: "r9", name: "Public", addedAt: "2026-01-01T00:00:00Z", addedByHandle: "@someone" } }],
    );
    expect(state.items[0].action).toBe("link");
    const commitItem = commitItemFor(state, state.items[0]);
    if (commitItem.action !== "link") throw new Error("unreachable");
    expect(commitItem.existingRecipeId).toBe("r9");
    expect(commitItem).not.toHaveProperty("record");
  });

  it("bulk group actions only touch that group", () => {
    const a = candidate();
    const b = candidate();
    const state = toReview([parsed(a), parsed(b)], [
      { clientId: a.clientId, verdict: "new" },
      { clientId: b.clientId, verdict: "public_exists", existing: { recipeId: "r1", name: "P", addedAt: "2026-01-01T00:00:00Z", addedByHandle: null } },
    ]);

    const skipped = reduce(state, { type: "set_group_actions", group: "public", action: "skip" });
    expect(skipped.items.find((item) => item.clientId === a.clientId)?.action).toBe("import");
    expect(skipped.items.find((item) => item.clientId === b.clientId)?.action).toBe("skip");
    expect(selectedForCommit(skipped)).toHaveLength(1);
  });

  it("editing a record marks the item edited and is counted in the outcome", () => {
    const state = toReview([parsed(candidate())]);
    const edited = reduce(state, { type: "edit_record", clientId: state.items[0].clientId, patch: { name: "Better name" } });
    expect(edited.items[0].record.name).toBe("Better name");
    expect(edited.items[0].edited).toBe(true);
    expect(finalizeOutcome(edited).editedBeforeCommit).toBe(1);
  });
});

describe("commit chunking and resumability (§7.2, §7.5)", () => {
  const many = () => Array.from({ length: 60 }, () => parsed(candidate({ sourceUrl: `https://example.com/${++seq}` })));

  it("cuts chunks at 25 and skips everything already selected out", () => {
    const state = toReview(many());
    const committing = reduce(state, { type: "commit_start" });
    expect(committing.commit?.order).toHaveLength(60);
    expect(commitChunks(committing.commit!.order).map((c) => c.length)).toEqual([25, 25, 10]);

    const first = nextCommitChunk(committing)!;
    expect(first.index).toBe(0);
    expect(first.items).toHaveLength(25);
  });

  it("a failed chunk retried re-sends that chunk and nothing already committed", () => {
    let state = reduce(toReview(many()), { type: "commit_start" });

    // Chunk 0 lands.
    const chunk0 = nextCommitChunk(state)!;
    const landed: CommitItemResult[] = chunk0.items.map((item) => ({ clientId: item.clientId, status: "imported" as const, recipeId: `r-${item.clientId}` }));
    state = reduce(state, { type: "chunk_complete", results: landed });

    // Chunk 1 throws — the driver dispatches `chunk_failed`, which carries no results.
    const chunk1 = nextCommitChunk(state)!;
    expect(chunk1.index).toBe(1);
    state = reduce(state, { type: "chunk_failed", message: "network down" });

    expect(state.commit?.chunkError).toBe("network down");
    // Nothing moves while a chunk is failed — that is what stops the driver's loop, and it
    // is why pressing retry twice cannot double-send.
    expect(nextCommitChunk(state)).toBeNull();

    state = reduce(state, { type: "chunk_retry" });
    const retried = nextCommitChunk(state)!;
    expect(retried.index).toBe(1);
    expect(retried.items.map((item) => item.clientId)).toEqual(chunk1.items.map((item) => item.clientId));
    // None of chunk 0's items are re-sent: they already carry a result.
    const committed = new Set(landed.map((result) => result.clientId));
    expect(retried.items.every((item) => !committed.has(item.clientId))).toBe(true);
  });

  it("a chunk whose items all have results is skipped rather than re-sent", () => {
    const started = reduce(toReview(many()), { type: "commit_start" });
    const order = started.commit!.order;
    // Chunk 0 already has answers while the index still points at it — what a resumed
    // commit looks like from `nextCommitChunk`'s side.
    const results: Record<string, CommitItemResult> = {};
    for (const clientId of order.slice(0, 25)) results[clientId] = { clientId, status: "imported", recipeId: `r-${clientId}` };
    const resumed: ImportState = { ...started, commit: { ...started.commit!, chunkIndex: 0, results } };

    const next = nextCommitChunk(resumed)!;
    expect(next.index).toBe(1);
    expect(next.items.map((item) => item.clientId)).toEqual(order.slice(25, 50));
  });

  it("commit_start sends every item, including the ones that will do nothing", () => {
    const a = candidate({ sourceUrl: "https://example.com/a" });
    const b = candidate({ sourceUrl: "https://example.com/b" });
    let state = toReview([parsed(a), parsed(b)]);
    state = reduce(state, { type: "set_action", clientId: b.clientId, action: "skip" });
    state = reduce(state, { type: "commit_start" });
    // `b` writes nothing, but it is a decision the user made and the only party that can put
    // it in `recipe_import_session.skipped_count` is the server (§7.2, §7.7).
    expect(state.commit?.order).toEqual([a.clientId, b.clientId]);
    expect(selectedForCommit(state)).toHaveLength(1);
    const chunk = nextCommitChunk(state)!;
    expect(chunk.items.map((item) => item.action)).toEqual(["import", "skip"]);
  });
});

describe("outcome (§7.7)", () => {
  it("derives every counter from observed results, never from a running tally", () => {
    const a = candidate({ sourceUrl: "https://example.com/a" });
    const b = candidate({ sourceUrl: "https://example.com/b" });
    const c = candidate({ sourceUrl: "https://example.com/c" });
    const d = candidate({ sourceUrl: "https://example.com/d" });

    let state = toReview([parsed(a), parsed(b), parsed(c), parsed(d)], [
      { clientId: a.clientId, verdict: "new" },
      { clientId: b.clientId, verdict: "public_exists", existing: { recipeId: "r1", name: "P", addedAt: "2026-01-01T00:00:00Z", addedByHandle: null } },
      { clientId: c.clientId, verdict: "new" },
      { clientId: d.clientId, verdict: "in_box", existing: { recipeId: "r2", name: "M", addedAt: "2026-01-01T00:00:00Z", addedByHandle: null } },
    ]);
    state = { ...state, failures: [{ kind: "failure", clientId: "f1", entryName: "Broken.html", message: "no title" }] };
    state = reduce(state, { type: "commit_start" });
    state = reduce(state, {
      type: "chunk_complete",
      results: [
        { clientId: a.clientId, status: "imported", recipeId: "r-a" },
        { clientId: b.clientId, status: "linked", recipeId: "r1" },
        { clientId: c.clientId, status: "failed", message: "boom" },
      ],
    });
    state = reduce(state, { type: "finalized" });

    const outcome = finalizeOutcome(state);
    expect(outcome).toMatchObject({ total: 5, imported: 1, linked: 1, failed: 1, parseFailures: 1 });
    // `d` was never sent (in_box defaults to skip) and is counted as a *duplicate* skip: the
    // machine skipped it because the probe said it is already here, not because the user
    // dropped it (D24).
    expect(outcome.skippedDuplicate).toBe(1);
    expect(outcome.skippedUser).toBe(0);

    // A retried chunk overwrites its item's result instead of adding to a tally.
    const retried = reduce(state, { type: "chunk_complete", results: [{ clientId: c.clientId, status: "imported", recipeId: "r-c" }] });
    expect(finalizeOutcome(retried)).toMatchObject({ imported: 2, failed: 0 });

    expect(failedItems(state).map((failure) => failure.entryName)).toEqual(["Broken.html", c.entryName]);
  });

  it("separates the two skip reasons D24 asks the summary to keep apart", () => {
    const mine = candidate({ sourceUrl: "https://example.com/mine" });
    const dropped = candidate({ sourceUrl: "https://example.com/dropped" });
    const maybe = candidate({ sourceUrl: "https://example.com/maybe" });

    let state = toReview([parsed(mine), parsed(dropped), parsed(maybe)], [
      { clientId: mine.clientId, verdict: "in_box", existing: { recipeId: "r1", name: "Mine", addedAt: "2026-01-01T00:00:00Z", addedByHandle: null } },
      { clientId: dropped.clientId, verdict: "new" },
      { clientId: maybe.clientId, verdict: "maybe", candidates: [{ recipeId: "r2", name: "Close", addedAt: "2026-01-01T00:00:00Z", addedByHandle: null }] },
    ]);

    // The user unticks a `new` row, and decides a `maybe` is a dupe at the queue. Both are
    // decisions the user made; only the `in_box` row was skipped by the machine.
    state = run(state, { type: "set_action", clientId: dropped.clientId, action: "skip" }, { type: "set_action", clientId: maybe.clientId, action: "skip" });

    const outcome = finalizeOutcome(state);
    expect(outcome.skippedDuplicate).toBe(1);
    expect(outcome.skippedUser).toBe(2);

    // Overriding the duplicate moves it out of both tallies — it is an import now.
    const overridden = reduce(state, { type: "set_override", clientId: mine.clientId, override: true });
    expect(finalizeOutcome(overridden)).toMatchObject({ skippedDuplicate: 0, skippedUser: 2, overriddenDuplicate: 1 });
  });
});

describe("re-importing an export that is already in the box (§16.12)", () => {
  /** Every entry comes back `in_box` — what the second run of the same export looks like. */
  function reimport(count: number): ImportState {
    const candidates = Array.from({ length: count }, (_, i) => candidate({ sourceUrl: `https://example.com/${i}` }));
    return toReview(
      candidates.map((c) => parsed(c, { sourceUrlKey: `example.com/${c.clientId}` })),
      candidates.map((c) => ({ clientId: c.clientId, verdict: "in_box" as const, existing: { recipeId: `r-${c.clientId}`, name: c.recipe.name ?? "", addedAt: "2026-01-01T00:00:00Z", addedByHandle: "@dan" } })),
    );
  }

  it("reaches the summary with nothing selected instead of dead-ending on the review screen", () => {
    let state = reimport(12);

    expect(itemsInGroup(state, "in_box")).toHaveLength(12);
    expect(selectedForCommit(state)).toHaveLength(0);
    // The whole of the defect: a disabled primary button here is a flow with no exit, and
    // §16.12's "reports 341 duplicates" is unreachable.
    expect(commitBlockedReason(state)).toBeNull();

    state = reduce(state, { type: "commit_start" });
    expect(state.phase).toBe("committing");
    // All 12 are in the order even though none of them writes anything: a skip the server
    // never sees is a recipe `recipe_import_session` cannot account for (§7.2).
    expect(state.commit?.order).toHaveLength(12);
    expect(commitProgress(state)).toEqual({ done: 0, total: 12 });

    const chunk = nextCommitChunk(state)!;
    expect(chunk.items).toHaveLength(12);
    expect(chunk.items.every((item) => item.action === "skip" && item.reason === "duplicate")).toBe(true);

    state = reduce(state, { type: "chunk_complete", results: chunk.items.map((item) => ({ clientId: item.clientId, status: "skipped" as const, reason: "duplicate" as const })) });
    expect(nextCommitChunk(state)).toBeNull();

    state = reduce(state, { type: "finalized" });
    expect(state.phase).toBe("done");
    expect(finalizeOutcome(state)).toMatchObject({ total: 12, imported: 0, linked: 0, skippedDuplicate: 12, skippedUser: 0, failed: 0, parseFailures: 0 });
  });

  it("sends every skip with the reason D24 splits on, and never counts one twice", () => {
    // The defect this replaced: skips were dropped from `commit.order`, so the server saw an
    // empty commit, could derive nothing, and the client had to fold all 12 into the one
    // counter §7.7 let it report — `0 imported / 54 already yours / 287 you skipped` on
    // screen against `imported 0, skipped 341` in the row. Now the wire carries the same
    // split the screen shows, and there is only one number.
    // Nine the probe found in the box, three the user unticked by hand.
    const dupes = Array.from({ length: 9 }, (_, i) => candidate({ sourceUrl: `https://example.com/dupe-${i}` }));
    const mine = Array.from({ length: 3 }, (_, i) => candidate({ sourceUrl: `https://example.com/mine-${i}` }));
    let state = toReview(
      [...dupes, ...mine].map((c) => parsed(c)),
      [
        ...dupes.map((c) => ({ clientId: c.clientId, verdict: "in_box" as const, existing: { recipeId: `r-${c.clientId}`, name: "", addedAt: "2026-01-01T00:00:00Z", addedByHandle: null } })),
        ...mine.map((c) => ({ clientId: c.clientId, verdict: "new" as const })),
      ],
    );
    for (const c of mine) state = reduce(state, { type: "set_action", clientId: c.clientId, action: "skip" });

    state = reduce(state, { type: "commit_start" });
    const chunk = nextCommitChunk(state)!;
    const reasons = chunk.items.map((item) => (item.action === "skip" ? item.reason : "sent"));
    expect(reasons.filter((r) => r === "user")).toHaveLength(3);
    expect(reasons.filter((r) => r === "duplicate")).toHaveLength(9);

    state = run(
      state,
      { type: "chunk_complete", results: chunk.items.map((item) => ({ clientId: item.clientId, status: "skipped" as const, reason: item.action === "skip" ? item.reason! : "user" })) },
      { type: "finalized" },
    );

    const shown = finalizeOutcome(state);
    expect(shown).toMatchObject({ skippedDuplicate: 9, skippedUser: 3 });
    // Every recipe is accounted for exactly once — the property `skipped_count < total_count`
    // used to violate.
    expect(shown.imported + shown.linked + shown.skippedDuplicate + shown.skippedUser + shown.failed + shown.parseFailures).toBe(shown.total);
  });

  it("counts a replayed item once, as the import it was — not as a second import or a duplicate", () => {
    // The server's ledger answers a re-sent item with `imported` and the SAME recipe id
    // (never `skipped: duplicate`, which would report the same recipe twice). `results` is
    // keyed by clientId, so the second answer overwrites the first.
    const c = candidate({ sourceUrl: "https://example.com/a" });
    let state = reduce(toReview([parsed(c)]), { type: "commit_start" });
    const landed: CommitItemResult[] = [{ clientId: c.clientId, status: "imported", recipeId: "r-a" }];
    state = run(state, { type: "chunk_complete", results: landed }, { type: "chunk_complete", results: landed }, { type: "finalized" });

    expect(finalizeOutcome(state)).toMatchObject({ total: 1, imported: 1, linked: 0, skippedDuplicate: 0, skippedUser: 0, failed: 0 });
  });

  it("leaves a duplicate the server itself declined in `skippedDuplicate`", () => {
    // A `new` verdict the server found in the box anyway (the review screen let the user edit
    // it into a match after the probe ran). The server's answer wins over the client's guess.
    const c = candidate({ sourceUrl: "https://example.com/a" });
    let state = toReview([parsed(c)]);
    state = reduce(state, { type: "commit_start" });
    state = reduce(state, { type: "chunk_complete", results: [{ clientId: c.clientId, status: "skipped", reason: "duplicate" }] });
    state = reduce(state, { type: "finalized" });

    expect(finalizeOutcome(state)).toMatchObject({ skippedDuplicate: 1, skippedUser: 0 });
  });

  it("still reaches it when the user skips a box-full of new recipes by hand", () => {
    // Same shape, different reason — the condition is "nothing left to import", not "they
    // were all duplicates".
    const candidates = [candidate({ sourceUrl: "https://example.com/a" }), candidate({ sourceUrl: "https://example.com/b" })];
    let state = toReview(candidates.map((c) => parsed(c)));
    state = reduce(state, { type: "set_group_actions", group: "ready", action: "skip" });

    expect(commitBlockedReason(state)).toBeNull();
    state = reduce(state, { type: "commit_start" });
    const chunk = nextCommitChunk(state)!;
    expect(chunk.items.every((item) => item.action === "skip" && item.reason === "user")).toBe(true);

    state = run(
      state,
      { type: "chunk_complete", results: chunk.items.map((item) => ({ clientId: item.clientId, status: "skipped" as const, reason: "user" as const })) },
      { type: "finalized" },
    );
    expect(state.phase).toBe("done");
    expect(finalizeOutcome(state)).toMatchObject({ skippedDuplicate: 0, skippedUser: 2 });
  });

  it("still reaches the summary when the export produced nothing at all", () => {
    // The genuinely empty order — every entry failed to parse. `nextCommitChunk` has nothing
    // to send and the driver finalizes immediately; this is the defect-2 fix and it survives
    // sending skips.
    let state = run(
      initialState("fixture"),
      { type: "drop_accepted", fileName: "My Recipes" },
      { type: "session_opened", sessionId: "s1" },
      { type: "parse_complete", result: { items: [], failures: [{ kind: "failure", clientId: "f1", entryName: "Broken.html", message: "no title" }] } },
      { type: "probe_complete", verdicts: [] },
    );
    state = reduce(state, { type: "commit_start" });
    expect(state.commit?.order).toEqual([]);
    expect(nextCommitChunk(state)).toBeNull();
    expect(commitProgress(state)).toEqual({ done: 0, total: 0 });

    state = reduce(state, { type: "finalized" });
    expect(state.phase).toBe("done");
    expect(finalizeOutcome(state)).toMatchObject({ total: 1, imported: 0, parseFailures: 1 });
  });
});

describe("`dupe_in_batch` (§6.3)", () => {
  it("is reachable past the client's collapse, and lands as a skipped duplicate of a named entry", () => {
    // The client collapses on the URL key when there is one and the fingerprint otherwise;
    // the server claims BOTH key spaces for every item it lets through. Two entries saved
    // from different sites with the same name and ingredients therefore survive the collapse
    // (`u:a` ≠ `u:b`) and the second comes back a batch dupe off the shared fingerprint.
    const first = candidate({ name: "Ragù", sourceUrl: "https://a.example/ragu" });
    const second = candidate({ name: "Ragù", sourceUrl: "https://b.example/ragu" });
    const state = toReview(
      [parsed(first, { sourceUrlKey: "a.example/ragu", contentFp: "sha256:same" }), parsed(second, { sourceUrlKey: "b.example/ragu", contentFp: "sha256:same" })],
      [
        { clientId: first.clientId, verdict: "new" },
        { clientId: second.clientId, verdict: "dupe_in_batch", duplicateOfClientId: first.clientId },
      ],
    );

    // Both survived the collapse: this is not a case the client can pretend away.
    expect(state.items).toHaveLength(2);
    expect(state.collapsedInBatch).toBe(0);

    const dupe = state.items[1];
    expect(dupe.verdict).toBe("dupe_in_batch");
    expect(dupe.action).toBe("skip");
    expect(itemsInGroup(state, "in_box")).toEqual([dupe]);
    // It has no household match to name, so the UI names the entry it duplicates instead of
    // claiming a recipe in the box that does not exist.
    expect(dupe.existing).toBeNull();
    expect(batchDuplicateOf(state, dupe)?.clientId).toBe(first.clientId);
    expect(batchDuplicateOf(state, state.items[0])).toBeNull();

    expect(finalizeOutcome(state)).toMatchObject({ skippedDuplicate: 1, skippedUser: 0 });

    // And it is overridable like any other duplicate row (D23).
    const overridden = reduce(state, { type: "set_override", clientId: dupe.clientId, override: true });
    const commitItem = commitItemFor(overridden, overridden.items[1]);
    if (commitItem.action !== "import") throw new Error("unreachable");
    expect(commitItem.override).toBe("duplicate");
  });
});

describe("importEventForWorkerMessage", () => {
  it("maps every worker message to the event the machine expects", () => {
    expect(importEventForWorkerMessage({ type: "read", entries: 12 })).toEqual({ type: "progress", progress: { stage: "read", done: 12, total: null } });
    expect(importEventForWorkerMessage({ type: "parse", done: 3, total: 341 })).toEqual({ type: "progress", progress: { stage: "parse", done: 3, total: 341 } });
    expect(importEventForWorkerMessage({ type: "keys", done: 341, total: 341 })).toEqual({ type: "progress", progress: { stage: "keys", done: 341, total: 341 } });

    const result = { items: [], failures: [] };
    expect(importEventForWorkerMessage({ type: "done", result })).toEqual({ type: "parse_complete", result });
    expect(importEventForWorkerMessage({ type: "error", code: "too_many_entries", message: "way too many" })).toEqual({
      type: "failed",
      failure: { code: "too_many_entries", message: "way too many", retryable: true },
    });
  });

  it("drives the reading screen when fed straight into the reducer", () => {
    const messages: ImportWorkerEvent[] = [
      { type: "read", entries: 341 },
      { type: "parse", done: 341, total: 341 },
      { type: "keys", done: 341, total: 341 },
      { type: "done", result: { items: [parsed(candidate())], failures: [] } },
    ];
    const state = messages.map(importEventForWorkerMessage).reduce(reduce, reduce(initialState("fixture"), { type: "drop_accepted", fileName: "My Recipes" }));
    expect(state.phase).toBe("reading");
    expect(state.progress).toEqual({ stage: "probe", done: 0, total: 1 });
  });
});
