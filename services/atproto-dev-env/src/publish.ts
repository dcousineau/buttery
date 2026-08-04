// Programmatic publish helper for autonomous test-eval loops. Logs in to the
// running dev-env with the seed account and writes a valid
// exchange.recipe.recipe record to its PDS — no interactive OAuth needed.
//
// NOTE: this is a VERIFICATION SEEDER, not buttery's real publish path. The
// real user flow is the buttery app's OAuth publish (see the service README).
// This helper exists so an agent can seed a known record and confirm the
// read/cron pipeline end-to-end without a human in the loop. It writes the same
// collection + required fields (name/text/ingredients/instructions/*At), so the
// read helper and cron sync treat it identically.
//
//   pnpm --filter @buttery/atproto-dev-env seed
//   pnpm --filter @buttery/atproto-dev-env seed -- --name "Test Stew" --rkey 01HTEST...

import { AtpAgent } from "@atproto/api";
import { config } from "#/client.ts";
import { RECIPE_COLLECTION } from "#/config.ts";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const cfg = config();
const name = flag("name") ?? "Dev-env Test Recipe";
const rkey = flag("rkey");

const agent = new AtpAgent({ service: cfg.pdsUrl });
await agent.login({ identifier: cfg.handle, password: cfg.password }).catch((e: unknown) => {
  throw new Error(`login failed for ${cfg.handle}. Is the dev-env running (pnpm --filter @buttery/atproto-dev-env start)?\n${String(e)}`);
});
const did = agent.session?.did;
if (!did) throw new Error("no session did after login");

const now = new Date().toISOString();
const res = await agent.com.atproto.repo.createRecord({
  repo: did,
  collection: RECIPE_COLLECTION,
  ...(rkey ? { rkey } : {}),
  record: {
    $type: RECIPE_COLLECTION,
    name,
    text: "Seeded by the dev-env publish helper for verification.",
    ingredients: ["1 cup verification", "2 tbsp isolation"],
    instructions: ["Boot dev-env.", "Publish.", "Read back.", "Assert."],
    createdAt: now,
    updatedAt: now,
  },
});

console.log(`DID ${did}`);
console.log(`CREATED ${res.data.uri}`);
console.log(`CID ${res.data.cid}`);
