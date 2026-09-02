import type { ExtractedRecipe, ImportCandidate, ImportParseFailure, JsonObject } from "@buttery/recipe-extract/import";
import { recipeRecordProblems, type RecipeRecordInput } from "#/lib/recipe-record";
import type { AttributionChoice } from "#/lib/api";
import {
  COMMIT_CHUNK_SIZE,
  type CommitItem,
  type CommitItemResult,
  type ExistingRef,
  type FinalizeOutcome,
  type ProbeItem,
  type ProbeVerdict,
  type VerdictKind,
} from "./contracts.ts";
import { buildSourceGroups, liveSourceGroups, type SourceGroup } from "./source-groups.ts";
import type { ImportWorkerErrorCode, ImportWorkerEvent, ParseResult } from "./worker-protocol.ts";

/**
 * The import client's state machine (plan §9), as a pure reducer.
 *
 * Everything that decides *what is true* lives here; everything that talks to a worker, a
 * server function, or an object URL lives in `useImportSession.ts`. The split is what makes
 * the flow testable without a DOM, a network, or a database — `machine.test.ts` drives
 * `drop → reading → review → committing → done` (including a failed chunk and its retry)
 * as plain function calls.
 *
 * Naming: the plan's seven-step pipeline (`drop → parse → keys → probe → review → commit →
 * summary`) and the design's five screens (`drop → reading → review → committing → done`)
 * are the same machine at two resolutions. `parse`, `keys`, and `probe` are presented as one
 * "Reading your recipe box…" bar (§10.1), so they are **stages inside** the `reading` phase
 * rather than phases of their own — `ImportState.phase` is what the route renders, and
 * `ImportState.progress.stage` is what the bar's label says. A sixth phase, `failed`, covers
 * §10.3's undrawn error states.
 *
 * Nothing here names an importer (§2.5): the importer id is an opaque string carried for the
 * session row, and every decision below is made from `ImportCandidate` and a `ProbeVerdict`.
 */

// --- phases -------------------------------------------------------------

export type ImportPhase = "drop" | "reading" | "review" | "committing" | "done" | "failed";

/** Progress stages inside `reading`, in order. `total: null` means indeterminate. */
export type ReadingStage = "read" | "parse" | "keys" | "probe";

export interface StageProgress {
  stage: ReadingStage;
  done: number;
  total: number | null;
}

export interface ImportFailure {
  code: ImportWorkerErrorCode | "probe_failed" | "session_failed";
  message: string;
  /** Whether the drop screen should offer "try again" over "start over". */
  retryable: boolean;
}

// --- per-recipe decisions ----------------------------------------------

export type ItemAction = "import" | "link" | "skip";

export interface ImportItem {
  clientId: string;
  /** Export-relative provenance; the failure list and the sidecar both use it (§7.2, §12.5). */
  entryName: string;
  sourceUrlKey: string | null;
  contentFp: string;
  sourceText: string | null;
  sourceUrl: string | null;
  imageUrl: string | null;
  /** Source-relative path into the dropped folder; local preview bytes only (§11). */
  localImagePath: string | null;
  notes: string | null;
  tags: string[];
  meta: JsonObject;
  /** The editable record. Starts as the parsed candidate; §7.3 edits mutate a copy. */
  record: RecipeRecordInput;
  /** True once the user changed anything — drives `outcome.editedBeforeCommit` (§7.7). */
  edited: boolean;
  verdict: VerdictKind;
  /**
   * For a `dupe_in_batch`: the earlier item in **this drop** that claimed the key first.
   * Null for every other verdict. The row is skipped by default like any duplicate, but the
   * copy it shows has to say "another recipe in this folder", not "already in your box" —
   * there is no `existing` for it, because nothing was matched in the household.
   */
  duplicateOfClientId: string | null;
  /** The matched recipe for `in_box` / `public_exists`; the first candidate for `maybe`. */
  existing: ExistingRef | null;
  /** Every trigram match for a `maybe` (§7.1). Empty otherwise. */
  matches: ExistingRef[];
  action: ItemAction;
  /** Set only on an `in_box` item the user chose to re-import anyway (§6.3, D23). */
  override: boolean;
}

/**
 * The rail groups, top to bottom, exactly as the design orders them (§10.1).
 *
 * Two of the six are **cross-cutting** rather than verdict slices — `sources` ("who wrote
 * this?") and `issues` ("the server will refuse this") — so one recipe can be listed in two
 * groups and the counts do not sum to the item total (§10.3).
 *
 * `issues` sits immediately before `ready` because it is the last thing that can go wrong on
 * the way in and the only one whose fix is *editing*, not choosing. Learning about a 1,120-
 * character step on the done screen, after the import, with the editor gone, is not a report
 * — it is a dead end.
 */
export type RailGroupId = "sources" | "maybe" | "in_box" | "public" | "issues" | "ready";

export const RAIL_GROUP_IDS: readonly RailGroupId[] = ["sources", "maybe", "in_box", "public", "issues", "ready"];

// --- attribution --------------------------------------------------------

/** The four chips (§8.2). `skip` means "leave it unattributed", which is a real answer. */
export type AttributionKind = "publication" | "person" | "website" | "skip";

/**
 * One source group's answer. All five text fields are held at once rather than in a
 * discriminated union so that switching chips and switching back does not silently discard
 * what the user typed — a real hazard when the four chips sit in one radio group.
 */
export interface GroupChoice {
  /** `null` until the user picks a chip. Unanswered groups gate commit (§10.1). */
  kind: AttributionKind | null;
  publicationTitle: string;
  publicationAuthor: string;
  personName: string;
  websiteName: string;
  websiteUrl: string;
}

function emptyChoice(group: SourceGroup): GroupChoice {
  return {
    kind: null,
    // The `pg 174` split's prefill (§10.2). A prefill, never an answer: `kind` stays null.
    publicationTitle: group.titlePrefill,
    publicationAuthor: "",
    personName: group.sourceText ?? "",
    websiteName: group.sourceText ?? "",
    websiteUrl: "",
  };
}

/**
 * Is this group answered well enough to commit?
 *
 * Mirrors `attributionFromChoice` in `services/web/src/server/recipes-write.ts`: publication
 * needs both title and author (both lexicon-required — never fabricate one from the other),
 * person needs a name, website needs a URL. `skip` needs nothing. Getting this wrong in the
 * lenient direction means the server silently drops the attribution the user typed, so the
 * client refuses to send an incomplete one.
 */
export function isGroupAnswered(choice: GroupChoice | undefined): boolean {
  if (!choice || choice.kind === null) return false;
  switch (choice.kind) {
    case "publication":
      return choice.publicationTitle.trim().length > 0 && choice.publicationAuthor.trim().length > 0;
    case "person":
      return choice.personName.trim().length > 0;
    case "website":
      return choice.websiteUrl.trim().length > 0;
    case "skip":
      return true;
  }
}

/** The `AttributionChoice` a group's answer sends, or `null` for "leave it unattributed". */
export function choiceToAttribution(choice: GroupChoice | undefined): AttributionChoice | null {
  if (!isGroupAnswered(choice) || !choice) return null;
  switch (choice.kind) {
    case "publication":
      return { kind: "publication", title: choice.publicationTitle.trim(), author: choice.publicationAuthor.trim() };
    case "person":
      return { kind: "person", name: choice.personName.trim() };
    case "website":
      return { kind: "website", name: choice.websiteName.trim(), url: choice.websiteUrl.trim() };
    case "skip":
    default:
      return null;
  }
}

// --- commit -------------------------------------------------------------

export interface CommitState {
  /** Every clientId being committed, in the order chunks are cut from it. */
  order: string[];
  /** Index of the chunk currently in flight or next to send. */
  chunkIndex: number;
  /** Per-item outcomes, accumulated across chunks. Keyed by clientId. */
  results: Record<string, CommitItemResult>;
  /** Set when a chunk failed as a whole; the UI offers a retry and nothing else moves. */
  chunkError: string | null;
  /** True once `finalizeImportSession` returned (§7.7). */
  finalized: boolean;
}

// --- state --------------------------------------------------------------

export interface ImportState {
  phase: ImportPhase;
  importerId: string;
  /** What the user handed us — the dropped folder's name. `recipe_import_session.file_name`. */
  fileName: string | null;
  sessionId: string | null;
  progress: StageProgress | null;
  items: ImportItem[];
  /** clientId → index into `items`. Rebuilt whenever `items` is replaced, never appended to. */
  itemIndex: Record<string, number>;
  failures: ImportParseFailure[];
  /**
   * Entries dropped before the probe because an earlier entry carried the same key
   * (`dupe_in_batch`, §6.3). Reported, not shown as failures.
   */
  collapsedInBatch: number;
  groups: SourceGroup[];
  groupChoices: Record<string, GroupChoice>;
  activeGroup: RailGroupId;
  /** The row the preview pane is showing, within `activeGroup`. */
  activeItemId: string | null;
  /** Non-null while the full editor is open over the preview (§7.3, D25). */
  editingItemId: string | null;
  commit: CommitState | null;
  error: ImportFailure | null;
}

export function initialState(importerId: string): ImportState {
  return {
    phase: "drop",
    importerId,
    fileName: null,
    sessionId: null,
    progress: null,
    items: [],
    itemIndex: {},
    failures: [],
    collapsedInBatch: 0,
    groups: [],
    groupChoices: {},
    activeGroup: "sources",
    activeItemId: null,
    editingItemId: null,
    commit: null,
    error: null,
  };
}

// --- events -------------------------------------------------------------

export type ImportEvent =
  | { type: "drop_accepted"; fileName: string | null }
  | { type: "session_opened"; sessionId: string }
  | { type: "progress"; progress: StageProgress }
  | { type: "parse_complete"; result: ParseResult }
  | { type: "probe_complete"; verdicts: ProbeVerdict[] }
  | { type: "failed"; failure: ImportFailure }
  | { type: "reset" }
  // review
  | { type: "select_group"; group: RailGroupId }
  | { type: "select_item"; clientId: string | null }
  | { type: "set_group_kind"; groupKey: string; kind: AttributionKind }
  | { type: "set_group_field"; groupKey: string; field: Exclude<keyof GroupChoice, "kind">; value: string }
  | { type: "set_action"; clientId: string; action: ItemAction }
  | { type: "set_group_actions"; group: RailGroupId; action: ItemAction }
  | { type: "set_override"; clientId: string; override: boolean }
  | { type: "open_editor"; clientId: string }
  | { type: "close_editor" }
  | { type: "edit_record"; clientId: string; patch: Partial<RecipeRecordInput> }
  // commit
  | { type: "commit_start" }
  | { type: "chunk_complete"; results: CommitItemResult[] }
  | { type: "chunk_failed"; message: string }
  | { type: "chunk_retry" }
  | { type: "finalized" };

/**
 * The `ImportEvent` a worker message becomes (§9).
 *
 * Pure and total, and deliberately *not* inlined in the hook's `message` listener: the
 * translation is the one place a stage can be mislabelled or a total dropped, and as a plain
 * function it is testable without a DOM, a worker, or React. Side effects that belong to
 * particular messages — terminating the worker on `done`, reporting `error` to
 * `failImportSession` (§13) — stay in the listener, because they are not part of what the
 * message *means*.
 */
export function importEventForWorkerMessage(message: ImportWorkerEvent): ImportEvent {
  switch (message.type) {
    case "read":
      // The walk has no total until it ends, so this stage is indeterminate by construction.
      return { type: "progress", progress: { stage: "read", done: message.entries, total: null } };
    case "parse":
    case "keys":
      return { type: "progress", progress: { stage: message.type, done: message.done, total: message.total } };
    case "done":
      return { type: "parse_complete", result: message.result };
    case "error":
      // Every worker-level failure is retryable: the user still has the folder, and nothing
      // has been written yet (§10.2).
      return { type: "failed", failure: { code: message.code, message: message.message, retryable: true } };
  }
}

// --- helpers ------------------------------------------------------------

/**
 * Everything the lexicon record holds, with the four required fields defaulted.
 *
 * `imageUrl` and `vocab` are extractor-side scratch, not record fields: the image travels
 * beside the record (§11) — as `CommitItem.imageUploadId` once the browser has put the bytes
 * in Buttery's storage, with `imageSourceUrl` logged alongside them — and free-text vocab is
 * resolved server-side (§12.3).
 */
function toRecordInput(recipe: ExtractedRecipe): RecipeRecordInput {
  const { imageUrl: _imageUrl, vocab: _vocab, name, text, ingredients, instructions, ...rest } = recipe;
  return { ...rest, name: name ?? "", text: text ?? "", ingredients: ingredients ?? [], instructions: instructions ?? [] };
}

/** The key an item collapses on: the URL key when it has one, the fingerprint otherwise (§6.1). */
function batchKey(item: { sourceUrlKey: string | null; contentFp: string }): string {
  return item.sourceUrlKey ? `u:${item.sourceUrlKey}` : `f:${item.contentFp}`;
}

function indexOf(items: readonly ImportItem[]): Record<string, number> {
  const index: Record<string, number> = {};
  items.forEach((item, i) => (index[item.clientId] = i));
  return index;
}

function patchItem(state: ImportState, clientId: string, patch: (item: ImportItem) => ImportItem): ImportState {
  const i = state.itemIndex[clientId];
  if (i === undefined) return state;
  const items = state.items.slice();
  items[i] = patch(items[i]);
  return { ...state, items };
}

/** The default action for a verdict (§6.3's table, verbatim). */
export function defaultAction(verdict: VerdictKind): ItemAction {
  switch (verdict) {
    case "in_box":
      return "skip"; // skip by default, overridable per row (D23)
    case "public_exists":
      return "link"; // link-or-skip; the design defaults the group to all-selected (D22)
    case "maybe":
      return "import"; // import, flagged — never auto-skip
    case "dupe_in_batch":
      return "skip"; // a second copy of something else in this same drop
    case "new":
      return "import";
  }
}

/**
 * Which rail group an item is listed under. `sources` is cross-cutting and computed
 * separately.
 *
 * `dupe_in_batch` has no group of its own, but it is **reachable** (see `contracts.ts`): the
 * client's collapse and the server's claim use different key spaces, so two entries with
 * different URLs and identical name + ingredients both survive `parse_complete` and the
 * second one comes back a batch dupe. Those items list under "Already yours" — skipped by
 * default, visible, and overridable — with copy of their own (`duplicateOfClientId`),
 * because "already in your box" would be a lie about a recipe that is only in this folder.
 */
export function railGroupOf(verdict: VerdictKind): Exclude<RailGroupId, "sources" | "issues"> {
  switch (verdict) {
    case "maybe":
      return "maybe";
    case "in_box":
    case "dupe_in_batch":
      return "in_box";
    case "public_exists":
      return "public";
    case "new":
      return "ready";
  }
}

/**
 * The items listed in a rail group.
 *
 * The four verdict groups are a partition. The two cross-cutting groups are questions, and
 * both are asked **only about recipes that are actually going to be written** — an item the
 * user is skipping raises neither, because nothing about it reaches the server.
 *
 * - `sources`: no URL, so a source group has to answer for its attribution. Skipping the
 *   item withdraws the question; overriding it back to `import` re-asks it. This matters on
 *   the second import of the same folder, where the honest answer is "nothing needs a
 *   source" and the unfiltered version said "92".
 * - `issues`: the lexicon would reject this record as it stands. `link` items write no
 *   record at all (they only point at a recipe that already exists), so only `import` items
 *   can raise it.
 *
 * A recipe can appear in both cross-cutting groups **and** its verdict group at once, which
 * is why the rail's counts do not sum to the item total (§10.3) and why the rail says so.
 */
export function itemsInGroup(state: ImportState, group: RailGroupId): ImportItem[] {
  if (group === "sources") return state.items.filter((item) => !item.sourceUrl && item.action !== "skip");
  if (group === "issues") return state.items.filter((item) => item.action === "import" && recipeRecordProblems(item.record).length > 0);
  return state.items.filter((item) => railGroupOf(item.verdict) === group);
}

/**
 * The source groups still in play: those with at least one member whose attribution still
 * matters. Both the commit gate and the cards on screen read from this, so a group nobody is
 * importing from is neither shown nor counted against the user.
 *
 * **A group answered "Skip these" stays, whole.** That answer is *why* its recipes are
 * skipped (`set_group_kind`), so dropping the group for having no live members would delete
 * the card the moment it was answered — taking the count, the "44 left behind" line, and any
 * way to change your mind with it. Its members are therefore treated as live here, and only
 * here: they are still not listed under "Need a source" in the rail, because nothing is going
 * to be written for them.
 */
export function sourceGroupsInPlay(state: ImportState): SourceGroup[] {
  const skippedByTheirAnswer = new Set(state.groups.filter((group) => state.groupChoices[group.key]?.kind === "skip").flatMap((group) => group.clientIds));
  const live = new Set(state.items.filter((item) => !item.sourceUrl && (item.action !== "skip" || skippedByTheirAnswer.has(item.clientId))).map((item) => item.clientId));
  return liveSourceGroups(state.groups, (clientId) => live.has(clientId));
}

function unansweredSourceGroups(state: ImportState): number {
  return sourceGroupsInPlay(state).filter((group) => !isGroupAnswered(state.groupChoices[group.key])).length;
}

export interface RailCounts {
  sources: number;
  maybe: number;
  in_box: number;
  public: number;
  issues: number;
  ready: number;
  /** Source groups still in play and still without an answer. Zero unlocks commit (§10.1). */
  unansweredGroups: number;
}

export function railCounts(state: ImportState): RailCounts {
  return {
    sources: itemsInGroup(state, "sources").length,
    maybe: itemsInGroup(state, "maybe").length,
    in_box: itemsInGroup(state, "in_box").length,
    public: itemsInGroup(state, "public").length,
    issues: itemsInGroup(state, "issues").length,
    ready: itemsInGroup(state, "ready").length,
    unansweredGroups: unansweredSourceGroups(state),
  };
}

/**
 * Items the commit will actually write something for. Drives the primary button's count — "Add
 * 287 recipes" is about what lands in the box, not about how many items the chunk loop sends
 * (which is all of them, skips included: see `commit_start`).
 */
export function selectedForCommit(state: ImportState): ImportItem[] {
  return state.items.filter((item) => item.action !== "skip");
}

/**
 * The earlier entry in this same drop that a `dupe_in_batch` row duplicates, when the client
 * still holds it. Null for every other verdict.
 */
export function batchDuplicateOf(state: ImportState, item: ImportItem): ImportItem | null {
  if (!item.duplicateOfClientId) return null;
  const i = state.itemIndex[item.duplicateOfClientId];
  return i === undefined ? null : (state.items[i] ?? null);
}

/**
 * Commit is blocked until every distinct source string is answered (§10.1) — the primary
 * button reads "Sort the sources first" until then. Returned as a reason string rather than
 * a boolean because §10.4 requires a disabled primary button to have a reachable reason.
 *
 * **An all-skip commit is not blocked.** Re-importing an export that is already in the box
 * puts every row in "Already yours" with `action: 'skip'`, and so does skipping everything by
 * hand; that is a finished import with nothing to write, not a dead end. Blocking it stranded
 * the user on the review screen with a disabled button and no way to reach the summary that
 * §16.12 asks for ("imports nothing **and reports 341 duplicates**"). The commit still runs:
 * the chunks carry nothing but `skip` items, which write no recipes, and
 * `finalizeImportSession` closes the session with the real counters (§7.7) — so the numbers
 * land in the session row and the §13 event, not just on screen.
 *
 * The genuinely empty order — an export whose every entry failed to parse — still reaches
 * `done`: `nextCommitChunk` returns null immediately and the hook finalizes.
 *
 * **"Needs a fix" does not block either.** The `issues` group is an offer, not a gate: a
 * user who does not want to rewrite a 1,120-character step should be able to press the
 * button and let those few land in "didn't make it" with the server's own reason, exactly as
 * they did before the group existed. Blocking would hold 331 good recipes hostage to 10.
 */
export function commitBlockedReason(state: ImportState): string | null {
  const unanswered = unansweredSourceGroups(state);
  if (unanswered > 0) return `${unanswered} ${unanswered === 1 ? "source needs" : "sources need"} an answer before anything can be imported.`;
  return null;
}

// --- probe / commit payloads -------------------------------------------

/**
 * The probe payload: **keys only** (§7.1).
 *
 * This function is the privacy property. It reads exactly four fields off each item and a
 * recipe body cannot reach the wire through it; `machine.test.ts` asserts the key set of the
 * emitted objects so that stays true under later edits.
 */
export function probeItems(state: ImportState): ProbeItem[] {
  return state.items.map((item) => ({
    clientId: item.clientId,
    sourceUrlKey: item.sourceUrlKey,
    contentFp: item.contentFp,
    title: item.record.name,
  }));
}

/** The group holding an item's attribution answer, or null when the URL already answers it. */
function groupKeyFor(item: ImportItem, groups: readonly SourceGroup[]): string | null {
  if (item.sourceUrl) return null;
  const group = groups.find((g) => g.clientIds.includes(item.clientId));
  return group?.key ?? null;
}

/** One item's `CommitItem`, resolved against its group's attribution answer. */
export function commitItemFor(state: ImportState, item: ImportItem): CommitItem {
  // The reason travels with the skip: the server records it and derives both of D24's skip
  // counters from the rows, and it cannot work this out for itself — a skip carries no record
  // and no keys, and `dupe_in_batch` (two copies inside one drop, neither in the box) is
  // invisible to it entirely.
  if (item.action === "skip") return { clientId: item.clientId, entryName: item.entryName, action: "skip", reason: isDuplicateSkip(item) ? "duplicate" : "user" };

  if (item.action === "link") {
    return {
      clientId: item.clientId,
      entryName: item.entryName,
      action: "link",
      // `link` is only ever offered for a `public_exists` verdict, whose `existing` the probe
      // filled in; the server revalidates the id regardless (§7.2).
      existingRecipeId: item.existing?.recipeId ?? "",
      notes: item.notes,
      // Verbatim, whatever the user classified it as — the pipeline writes it to the
      // reserved `source_text` sidecar key and has no other way to learn it (§8.2, §12.5).
      sourceText: item.sourceText,
      meta: item.meta,
    };
  }

  const groupKey = groupKeyFor(item, state.groups);
  return {
    clientId: item.clientId,
    entryName: item.entryName,
    action: "import",
    record: item.record,
    sourceUrl: item.sourceUrl,
    // Null when the URL carries the attribution — the server derives Website from it (§8.2).
    attribution: groupKey ? choiceToAttribution(state.groupChoices[groupKey]) : null,
    // Provenance only. `imageUploadId` is filled in by the staging pass just
    // before the chunk is sent (`stage-images.ts`), and the server records this
    // beside those bytes — it never fetches it and never renders it.
    imageSourceUrl: item.imageUrl,
    notes: item.notes,
    tags: item.tags,
    // Preserved verbatim regardless of the classification above (§8.2, §12.5).
    sourceText: item.sourceText,
    ...(item.override ? { override: "duplicate" as const } : {}),
    meta: item.meta,
  };
}

/** Chunk boundaries over `CommitState.order`, at the §7.2 size of 25. */
export function commitChunks(order: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < order.length; i += COMMIT_CHUNK_SIZE) chunks.push(order.slice(i, i + COMMIT_CHUNK_SIZE));
  return chunks;
}

/**
 * The next chunk to send, or null when the commit is done.
 *
 * **Resumability (§7.5):** items that already carry a result are filtered out, so a retried
 * chunk re-sends only what has no answer yet. Combined with the server's per-item dedupe
 * re-check, a chunk whose response was lost converges instead of duplicating. A chunk that
 * empties out entirely is skipped rather than sent.
 */
export function nextCommitChunk(state: ImportState): { index: number; items: CommitItem[] } | null {
  const commit = state.commit;
  if (!commit || commit.chunkError) return null;
  const chunks = commitChunks(commit.order);
  for (let index = commit.chunkIndex; index < chunks.length; index++) {
    const pending = chunks[index].filter((clientId) => !commit.results[clientId]);
    if (pending.length === 0) continue;
    const items = pending.map((clientId) => commitItemFor(state, state.items[state.itemIndex[clientId]]));
    return { index, items };
  }
  return null;
}

export interface CommitProgress {
  done: number;
  total: number;
}

export function commitProgress(state: ImportState): CommitProgress {
  const commit = state.commit;
  if (!commit) return { done: 0, total: 0 };
  return { done: Object.keys(commit.results).length, total: commit.order.length };
}

/**
 * What the summary screen shows and what `finalizeImportSession` is told (§7.7).
 *
 * Derived from observed per-item results, never incremented as they arrive: `results` is keyed
 * by `clientId`, so a retried chunk overwrites its item's entry rather than adding to a tally.
 * That is what makes the server's replay convergence legible on screen — **a re-sent item that
 * already imported comes back `imported` with the same recipe id, not `skipped: duplicate`**,
 * and it lands on the same key it landed on the first time. One recipe, one tile, one count.
 *
 * The server derives the same five numbers from its own rows, and since every item — skips
 * included — is now sent, both sides are counting the same events rather than one side
 * counting rows and the other counting decisions.
 */
export function finalizeOutcome(state: ImportState): FinalizeOutcome {
  const results = Object.values(state.commit?.results ?? {});
  const outcome: FinalizeOutcome = {
    total: state.items.length + state.failures.length,
    imported: 0,
    linked: 0,
    skippedDuplicate: 0,
    skippedUser: 0,
    failed: 0,
    overriddenDuplicate: state.items.filter((item) => item.override && item.action === "import").length,
    editedBeforeCommit: state.items.filter((item) => item.edited).length,
    parseFailures: state.failures.length,
    distinctSourceStringsClassified: state.groups.filter((group) => isGroupAnswered(state.groupChoices[group.key])).length,
  };
  for (const result of results) {
    if (result.status === "imported") outcome.imported++;
    else if (result.status === "linked") outcome.linked++;
    else if (result.status === "failed") outcome.failed++;
    else if (result.reason === "duplicate") outcome.skippedDuplicate++;
    else outcome.skippedUser++;
  }
  // A skip whose chunk never got an answer — the commit was abandoned, or a chunk failed and
  // the user left. Every item is sent now (see `commit_start`), so in a completed run this
  // loop adds nothing and the tiles are exactly the results the server returned; it exists so
  // a half-finished session still shows the user's own decisions rather than five zeros.
  for (const item of state.items) {
    if (item.action !== "skip") continue;
    if (state.commit?.results[item.clientId]) continue;
    if (isDuplicateSkip(item)) outcome.skippedDuplicate++;
    else outcome.skippedUser++;
  }
  return outcome;
}

/**
 * Was this skip the duplicate's doing or the user's?
 *
 * Verdict-driven, not history-driven: `in_box` and `dupe_in_batch` are the two verdicts whose
 * default action is `skip` *because the recipe already exists* (§6.3's table). `maybe`
 * defaults to `import`, so skipping one is a decision the user made at the duplicate queue,
 * and a `new` or `public_exists` row only reaches `skip` by being unticked or by its source
 * group being answered "Skip these" — all of which are the user's.
 */
export function isDuplicateSkip(item: ImportItem): boolean {
  return item.action === "skip" && !item.override && (item.verdict === "in_box" || item.verdict === "dupe_in_batch");
}

/** Per-item outcomes joined back to their export entry names, for the done screen's list. */
export interface FailedItemView {
  clientId: string;
  entryName: string;
  message: string;
}

export function failedItems(state: ImportState): FailedItemView[] {
  const out: FailedItemView[] = [];
  for (const failure of state.failures) out.push({ clientId: failure.clientId, entryName: failure.entryName, message: failure.message });
  for (const result of Object.values(state.commit?.results ?? {})) {
    if (result.status !== "failed") continue;
    const item = state.items[state.itemIndex[result.clientId]];
    out.push({ clientId: result.clientId, entryName: item?.entryName ?? result.clientId, message: result.message });
  }
  return out;
}

// --- reducer ------------------------------------------------------------

export function reduce(state: ImportState, event: ImportEvent): ImportState {
  switch (event.type) {
    case "drop_accepted":
      return { ...initialState(state.importerId), phase: "reading", fileName: event.fileName, progress: { stage: "read", done: 0, total: null } };

    case "session_opened":
      return { ...state, sessionId: event.sessionId };

    case "progress":
      // Late progress from a worker that was terminated (or from a run the user already left)
      // must not drag the screen back to `reading`.
      return state.phase === "reading" ? { ...state, progress: event.progress } : state;

    case "parse_complete": {
      // In-batch collapse (§6.3, `dupe_in_batch`): first entry wins, the rest are counted and
      // dropped before the probe so 341 entries never become 341 probe rows with duplicates
      // racing each other into the same key.
      const seen = new Set<string>();
      const items: ImportItem[] = [];
      let collapsed = 0;
      for (const parsed of event.result.items) {
        const key = batchKey(parsed);
        if (seen.has(key)) {
          collapsed++;
          continue;
        }
        seen.add(key);
        items.push(itemFromCandidate(parsed.candidate, parsed.sourceUrlKey, parsed.contentFp));
      }

      const groups = buildSourceGroups(items);
      const groupChoices: Record<string, GroupChoice> = {};
      for (const group of groups) groupChoices[group.key] = emptyChoice(group);

      return {
        ...state,
        phase: "reading",
        progress: { stage: "probe", done: 0, total: items.length },
        items,
        itemIndex: indexOf(items),
        failures: event.result.failures,
        collapsedInBatch: collapsed,
        groups,
        groupChoices,
      };
    }

    case "probe_complete": {
      const byId = new Map(event.verdicts.map((verdict) => [verdict.clientId, verdict]));
      const items = state.items.map((item) => {
        const verdict = byId.get(item.clientId);
        if (!verdict) return item; // no verdict = treat as new, which is what it was seeded as
        const existing = verdict.verdict === "in_box" || verdict.verdict === "public_exists" ? verdict.existing : null;
        const matches = verdict.verdict === "maybe" ? verdict.candidates : [];
        // Kept, not discarded: it is the only thing that can name what this row duplicates,
        // and a `dupe_in_batch` has no `existing` to fall back on.
        const duplicateOfClientId = verdict.verdict === "dupe_in_batch" ? verdict.duplicateOfClientId : null;
        return { ...item, verdict: verdict.verdict, duplicateOfClientId, existing: existing ?? matches[0] ?? null, matches, action: defaultAction(verdict.verdict) };
      });
      const next: ImportState = { ...state, phase: "review", progress: null, items, itemIndex: indexOf(items) };
      // The rail is worked top to bottom; land on the first group that has anything in it.
      const first = RAIL_GROUP_IDS.find((group) => itemsInGroup(next, group).length > 0) ?? "ready";
      const firstItem = itemsInGroup(next, first)[0] ?? null;
      return { ...next, activeGroup: first, activeItemId: firstItem?.clientId ?? null };
    }

    case "failed":
      return { ...state, phase: "failed", progress: null, error: event.failure };

    case "reset":
      return initialState(state.importerId);

    case "select_group": {
      const items = itemsInGroup(state, event.group);
      return { ...state, activeGroup: event.group, activeItemId: items[0]?.clientId ?? null, editingItemId: null };
    }

    case "select_item":
      return { ...state, activeItemId: event.clientId, editingItemId: null };

    case "set_group_kind": {
      const current = state.groupChoices[event.groupKey];
      if (!current) return state;
      const groupChoices = { ...state.groupChoices, [event.groupKey]: { ...current, kind: event.kind } };

      // §8.1's table: "Skip these" produces `skipped:user`, **not** an unattributed import.
      // The server refuses a record with no lexicon-valid attribution ("This recipe has no
      // source we can attribute it to."), so a client that left these as imports would send
      // a chunk it knows will fail and report it to the user as a failure rather than as the
      // choice they made. Flipping back to a real classification restores the verdict's
      // default action, so answering, undoing, and re-answering costs nothing.
      if (event.kind === "skip" || current.kind === "skip") {
        const members = new Set(state.groups.find((group) => group.key === event.groupKey)?.clientIds ?? []);
        if (members.size > 0) {
          const items = state.items.map((item) =>
            members.has(item.clientId) ? { ...item, action: event.kind === "skip" ? ("skip" as const) : defaultAction(item.verdict), override: false } : item,
          );
          return { ...state, items, groupChoices };
        }
      }

      return { ...state, groupChoices };
    }

    case "set_group_field": {
      const current = state.groupChoices[event.groupKey];
      if (!current) return state;
      return { ...state, groupChoices: { ...state.groupChoices, [event.groupKey]: { ...current, [event.field]: event.value } } };
    }

    case "set_action":
      return patchItem(state, event.clientId, (item) => ({
        ...item,
        action: event.action,
        // Stepping off "import" retracts the override; leaving it set would re-import a known
        // duplicate the moment the user toggled back, which they did not ask for twice.
        override: event.action === "import" ? item.override : false,
      }));

    case "set_group_actions": {
      const ids = new Set(itemsInGroup(state, event.group).map((item) => item.clientId));
      const items = state.items.map((item) => (ids.has(item.clientId) ? { ...item, action: event.action, override: event.action === "import" ? item.override : false } : item));
      return { ...state, items };
    }

    case "set_override":
      return patchItem(state, event.clientId, (item) => ({ ...item, override: event.override, action: event.override ? "import" : "skip" }));

    case "open_editor":
      return { ...state, editingItemId: event.clientId, activeItemId: event.clientId };

    case "close_editor":
      return { ...state, editingItemId: null };

    case "edit_record":
      return patchItem(state, event.clientId, (item) => ({ ...item, record: { ...item.record, ...event.patch }, edited: true }));

    case "commit_start": {
      // EVERY item, skips included (§7.2). A skip is a decision the user made, not a gap, and
      // it is the only way the server can record one: dropping them from the order left the
      // session row counting 54 of 341 recipes while the screen accounted for all of them.
      // The cost is what §7.2 signs up for — ~14 chunks of no-op items on a full re-import,
      // each one statement server-side.
      const order = state.items.map((item) => item.clientId);
      return { ...state, phase: "committing", editingItemId: null, commit: { order, chunkIndex: 0, results: {}, chunkError: null, finalized: false } };
    }

    case "chunk_complete": {
      if (!state.commit) return state;
      const results = { ...state.commit.results };
      for (const result of event.results) results[result.clientId] = result;
      return { ...state, commit: { ...state.commit, results, chunkIndex: state.commit.chunkIndex + 1, chunkError: null } };
    }

    case "chunk_failed":
      if (!state.commit) return state;
      return { ...state, commit: { ...state.commit, chunkError: event.message } };

    case "chunk_retry":
      // The chunk index does not move: the same chunk is re-sent, minus whatever already has
      // a result. That is the whole of §7.5's client half.
      if (!state.commit) return state;
      return { ...state, commit: { ...state.commit, chunkError: null } };

    case "finalized":
      if (!state.commit) return { ...state, phase: "done" };
      return { ...state, phase: "done", commit: { ...state.commit, finalized: true } };
  }
}

// --- candidate → item ---------------------------------------------------

/**
 * The machine holds `ImportItem`s, not candidates: the candidate's recipe body would
 * otherwise be retained twice for the whole session. `ImportItem` is structurally a
 * `GroupableCandidate`, so `buildSourceGroups` reads items directly.
 */
function itemFromCandidate(candidate: ImportCandidate, sourceUrlKey: string | null, contentFp: string): ImportItem {
  const record = toRecordInput(candidate.recipe);
  return {
    clientId: candidate.clientId,
    entryName: candidate.entryName,
    sourceUrlKey,
    contentFp,
    sourceText: candidate.sourceText,
    sourceUrl: candidate.sourceUrl,
    imageUrl: candidate.imageUrl,
    localImagePath: candidate.localImagePath,
    notes: candidate.notes,
    tags: candidate.tags,
    meta: candidate.meta,
    record,
    edited: false,
    verdict: "new",
    duplicateOfClientId: null,
    existing: null,
    matches: [],
    action: "import",
    override: false,
  };
}

export type { ImportParseFailure };
