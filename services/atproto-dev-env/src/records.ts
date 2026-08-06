// Read helper (the agent verify path). Resolves the seed handle → did against
// the running dev-env PDS, lists its exchange.recipe.recipe records, and prints
// deterministic, greppable output so a test-eval loop can assert on it.
//
// Read-only: unauthenticated listRecords, no writes, no deletes.
//
//   pnpm --filter @buttery/atproto-dev-env records

import { config, resolveDid } from "#/client.ts";
import { RECIPE_COLLECTION } from "#/config.ts";

interface RecordItem {
  uri: string;
  cid: string;
  value: { name?: string; updatedAt?: string };
}

const cfg = config();
const did = await resolveDid(cfg);
console.log(`DID ${did}`);

const url = `${cfg.pdsUrl}/xrpc/com.atproto.repo.listRecords?repo=${encodeURIComponent(did)}&collection=${RECIPE_COLLECTION}`;
const res = await fetch(url, { headers: { accept: "application/json" } });
if (!res.ok) throw new Error(`listRecords failed (${res.status})`);
const body = (await res.json()) as { records?: RecordItem[] };
const records = body.records ?? [];

console.log(`COUNT ${records.length}`);
for (const r of records) {
  const rkey = r.uri.split("/").pop() ?? "?";
  console.log(`RECORD ${rkey}\t${r.value.name ?? "(no name)"}\t${r.value.updatedAt ?? ""}`);
}
