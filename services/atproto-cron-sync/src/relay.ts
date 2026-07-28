import { getJson } from "#/http.ts";

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
