import { getJson } from "#/workflows/atproto-sync/lib/http.ts";

// Record listing straight off a repo's PDS, unauthenticated (plan §1 step 3).

const PAGE_LIMIT = 100;

/** One record as returned by com.atproto.repo.listRecords. */
export interface PdsRecord {
  uri: string;
  cid: string;
  value: Record<string, unknown>;
}

interface ListRecordsResponse {
  cursor?: string;
  records?: PdsRecord[];
}

interface LatestCommitResponse {
  cid: string;
  rev: string;
}

/**
 * The repo's current commit `rev` (a TID). Used as the rev-guard on every
 * record write this sweep: monotonic per repo, so upserts are order-insensitive
 * and duplicate-safe (plan §1 "Idempotency"). One call per DID.
 */
export async function getRepoRev(pds: string, did: string): Promise<string> {
  const url = new URL("/xrpc/com.atproto.sync.getLatestCommit", pds);
  url.searchParams.set("did", did);
  const { rev } = await getJson<LatestCommitResponse>(url.toString());
  return rev;
}

/**
 * Page a repo's records for `collection`, following the cursor to completion.
 * Returns the full list — one repo's records are small; buffering a single
 * repo (not the whole network) is fine.
 */
export async function listRecords(pds: string, did: string, collection: string): Promise<PdsRecord[]> {
  const out: PdsRecord[] = [];
  let cursor: string | undefined;
  do {
    const url = new URL("/xrpc/com.atproto.repo.listRecords", pds);
    url.searchParams.set("repo", did);
    url.searchParams.set("collection", collection);
    url.searchParams.set("limit", String(PAGE_LIMIT));
    if (cursor) url.searchParams.set("cursor", cursor);

    const page = await getJson<ListRecordsResponse>(url.toString());
    for (const rec of page.records ?? []) {
      if (rec.uri && rec.cid && rec.value) out.push(rec);
    }
    cursor = page.cursor;
  } while (cursor);
  return out;
}
