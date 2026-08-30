import { getJson } from "#/queues/atproto-sync/lib/http.ts";

// Discovery: page com.atproto.sync.listReposByCollection on the relay to find
// every DID that holds an `exchange.recipe.recipe` record. Served by the new
// relays' collectiondir microservice — "not strictly required by the protocol"
// (plan §8 open question 1), so keep an eye on availability.

const PAGE_LIMIT = 2000;

interface ListReposByCollectionResponse {
  cursor?: string;
  repos?: Array<{ did: string }>;
}

/**
 * Yield DIDs holding `collection`, paging until the cursor is exhausted or
 * `maxRepos` DIDs have been emitted. Async generator so the caller can start
 * per-DID work without buffering the whole network in memory.
 */
export async function* enumerateDids(relayUrl: string, collection: string, maxRepos?: number): AsyncGenerator<string> {
  let cursor: string | undefined;
  let emitted = 0;
  do {
    const url = new URL("/xrpc/com.atproto.sync.listReposByCollection", relayUrl);
    url.searchParams.set("collection", collection);
    url.searchParams.set("limit", String(PAGE_LIMIT));
    if (cursor) url.searchParams.set("cursor", cursor);

    const page = await getJson<ListReposByCollectionResponse>(url.toString());
    for (const repo of page.repos ?? []) {
      if (!repo.did) continue;
      yield repo.did;
      emitted++;
      if (maxRepos && emitted >= maxRepos) return;
    }
    cursor = page.cursor;
  } while (cursor);
}

interface ListReposResponse {
  cursor?: string;
  repos?: Array<{ did: string; active?: boolean }>;
}

/**
 * Yield every active DID hosted by a single PDS, via `com.atproto.sync.listRepos`.
 *
 * The local-dev enumeration source (`SYNC_PDS_URL`): the atproto dev-env ships
 * no relay, and its PDS rejects unauthenticated `listReposByCollection` with
 * `AuthMissing`, so this is how a local sweep finds the repos to read. It is
 * not collection-filtered — repos with no `exchange.recipe.recipe` records just
 * sweep to zero records — which is fine at dev-env scale and wrong at network
 * scale, so nothing points this at a real PDS.
 */
export async function* enumerateDidsFromPds(pdsUrl: string, maxRepos?: number): AsyncGenerator<string> {
  let cursor: string | undefined;
  let emitted = 0;
  do {
    const url = new URL("/xrpc/com.atproto.sync.listRepos", pdsUrl);
    // listRepos caps `limit` at 1000, unlike listReposByCollection's 2000.
    url.searchParams.set("limit", "1000");
    if (cursor) url.searchParams.set("cursor", cursor);

    const page = await getJson<ListReposResponse>(url.toString());
    for (const repo of page.repos ?? []) {
      // `active: false` is a deactivated/taken-down repo — listRecords on it
      // fails, so skip rather than book a per-DID error every sweep.
      if (!repo.did || repo.active === false) continue;
      yield repo.did;
      emitted++;
      if (maxRepos && emitted >= maxRepos) return;
    }
    cursor = page.cursor;
  } while (cursor);
}
