import { LexError, asAtUriString, toDatetimeString } from "@atproto/lex";
import collection from "@buttery/lexicons/exchange/recipe/collection";
import type { Main as CollectionRecord } from "@buttery/lexicons/exchange/recipe/collection";
import { getUserRecipeClient, withScopeCheck } from "./recipe-writes";

export type { CollectionRecord };

/**
 * The atproto write layer for `exchange.recipe.collection`.
 *
 * Everything here mirrors `recipe-writes.ts` — same client acquisition
 * (`getUserRecipeClient`), same under-scoped-grant translation
 * (`withScopeCheck` → `AtprotoScopeError`) — with one structural difference
 * that shapes the whole module: the collection lexicon declares
 * `"key": "tid"`, so unlike a recipe (whose rkey *is* its local ULID) the
 * record key is **minted by the PDS** and only learned from the create
 * response. Callers must persist the returned `rkey` — it is the only handle
 * for every later put/delete.
 */

/**
 * Build the record body for a collection. Pure: no clock, no network, no DB —
 * every input is passed in, which is what makes it unit-testable
 * (`collection-record.test.ts`).
 *
 * - `recipes` is written in the order given. **Array order is the collection
 *   order** in the lexicon, so callers pass entries already sorted by their
 *   `position`. An empty list omits the field entirely rather than publishing
 *   `recipes: []` — the lexicon marks it optional and an absent array is the
 *   canonical spelling of "empty collection".
 * - `description` maps onto the lexicon's `text`; `null` omits it.
 * - `createdAt` is the *frozen* `record_created_at`, not "now". A record's
 *   `createdAt` must not drift across re-puts, so the caller replays the value
 *   stamped at first publish.
 */
export function buildCollectionRecord(input: {
  name: string;
  description: string | null;
  recipes: Array<{ uri: string; cid: string }>;
  createdAt: Date;
  updatedAt: Date;
}): CollectionRecord {
  return {
    $type: "exchange.recipe.collection",
    name: input.name,
    ...(input.description === null ? {} : { text: input.description }),
    ...(input.recipes.length === 0
      ? {}
      : {
          // The ref's `uri` is a branded `AtUriString`, and `asAtUriString` is
          // the lexicon's own `at-uri` check — so the cast doubles as a guard:
          // a malformed uri fails here, in a pure function with the offending
          // value in hand, rather than as an opaque PDS 400 mid-publish.
          recipes: input.recipes.map((ref) => ({ uri: asAtUriString(ref.uri), cid: ref.cid })),
        }),
    createdAt: toDatetimeString(input.createdAt),
    updatedAt: toDatetimeString(input.updatedAt),
  };
}

/**
 * `commit` is optional in `com.atproto.repo.{create,put}Record`'s output
 * schema, so the rev is typed as possibly-absent even though every PDS
 * implementation returns it. Falling back to `""` is deliberate: the local
 * publish columns are all-or-none NOT NULL, and throwing *after* the PDS has
 * already accepted the write would strand a live record with no local row
 * pointing at it. An unknown rev is inert here (collections are push-only in
 * v1 — the cron sync never reads them) and the next successful re-put
 * overwrites it with the real value.
 */
function revOf(res: { commit?: { rev: string } }): string {
  return res.commit?.rev ?? "";
}

/** Is this the PDS refusing a compare-and-swap because the record moved under us? */
function isInvalidSwap(err: unknown): boolean {
  return err instanceof LexError && err.error === "InvalidSwap";
}

/**
 * Create the collection record in `did`'s repo, letting the **PDS mint the
 * TID**: `client.create` omits `rkey` for a tid-keyed schema, and the minted
 * key comes back as the last segment of the returned `at://` uri. That parse
 * is the only way to learn it — there is no client-side TID minter available
 * (the `TID` class lives in a transitive `@atproto/common-web`, deliberately
 * not a dependency).
 */
export async function createCollectionRecord(did: string, record: CollectionRecord): Promise<{ uri: string; cid: string; rkey: string; rev: string }> {
  const client = await getUserRecipeClient(did);
  const res = await withScopeCheck(() => client.create(collection, record));
  const rkey = res.uri.slice(res.uri.lastIndexOf("/") + 1);
  if (!rkey) throw new Error(`PDS returned a collection uri with no record key: ${res.uri}`);
  return { uri: res.uri, cid: res.cid, rkey, rev: revOf(res) };
}

/**
 * Re-put the record at `rkey`, guarded by `swapRecord: priorCid` so a write
 * racing another editor's write fails instead of silently clobbering it.
 *
 * On `InvalidSwap` we retry **once, unguarded**. That is not a fallback to
 * last-write-wins out of laziness: the local database is the source of truth
 * for a collection, the record is a projection of it, and the losing side of
 * the race is by definition the newer DB state. Re-putting it is the correct
 * repair. One retry (not a loop) bounds the work; a second collision leaves
 * the caller to mark `record_stale` and try again on the next write.
 */
export async function putCollectionRecord(did: string, rkey: string, record: CollectionRecord, priorCid: string): Promise<{ uri: string; cid: string; rev: string }> {
  const client = await getUserRecipeClient(did);
  const write = (swapRecord?: string) => withScopeCheck(() => client.put(collection, record, swapRecord === undefined ? { rkey } : { rkey, swapRecord }));
  let res;
  try {
    res = await write(priorCid);
  } catch (err) {
    if (!isInvalidSwap(err)) throw err;
    res = await write();
  }
  return { uri: res.uri, cid: res.cid, rev: revOf(res) };
}

/**
 * Delete the record at `rkey` from `did`'s repo. Idempotent: a
 * `RecordNotFound` means the caller's goal — no such record on the PDS — is
 * already met, so it resolves rather than throwing. This matters because both
 * callers (unpublish, and delete-collection's PDS-first ordering) treat a
 * throw as "leave the local rows alone and retry later", which would otherwise
 * wedge forever on an already-deleted record.
 */
export async function deleteCollectionRecord(did: string, rkey: string): Promise<void> {
  const client = await getUserRecipeClient(did);
  try {
    await withScopeCheck(() => client.delete(collection, { rkey }));
  } catch (err) {
    if (err instanceof LexError && err.error === "RecordNotFound") return;
    throw err;
  }
}
