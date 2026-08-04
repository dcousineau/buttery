// Local ATProto dev-env runner. Boots an isolated PDS + local PLC (no AppView,
// no relay) via @atproto/dev-env, seeds one `.test` account, prints the env
// block for `services/web/.env`, then stays alive until interrupted.
//
// Isolation guarantee: DIDs are registered in the LOCAL PLC and the PDS is
// local, so nothing here is visible to plc.directory, bsky.social, or the relay.
// State is in-memory — every restart mints a NEW did:plc, so re-login in buttery
// (and re-run any publish) after a restart.

import { TestNetworkNoAppView } from "@atproto/dev-env";
import { AtpAgent } from "@atproto/api";
import { loadConfig, RECIPE_COLLECTION } from "#/config.ts";

const cfg = loadConfig();

const net = await TestNetworkNoAppView.create({
  pds: { port: cfg.pdsPort },
  plc: { port: cfg.plcPort },
});

// Seed the dev account. Fresh network each boot, so this always creates.
const agent = new AtpAgent({ service: net.pds.url });
await agent.createAccount({ handle: cfg.handle, email: cfg.email, password: cfg.password });
const did = agent.session?.did ?? "(unknown)";

const line = "─".repeat(72);
console.log(`\n${line}`);
console.log("  Local ATProto dev-env is UP (isolated — never touches the real network)");
console.log(line);
console.log(`  PDS:    ${net.pds.url}`);
console.log(`  PLC:    ${net.plc.url}`);
console.log(`  Handle: ${cfg.handle}`);
console.log(`  DID:    ${did}   (new each restart — in-memory)`);
console.log(`  Pass:   ${cfg.password}   (for the programmatic publish helper)`);
console.log(line);
console.log("  Add these to services/web/.env to publish locally via the app:\n");
console.log(`    ATPROTO_HANDLE_RESOLVER=${net.pds.url}`);
console.log(`    ATPROTO_PLC_URL=${net.plc.url}`);
console.log(`    ATPROTO_PUBLISH_ENABLED=true`);
console.log(line);
console.log("  Verify / drive from another terminal:");
console.log(`    pnpm --filter @buttery/atproto-dev-env seed   # write a sample ${RECIPE_COLLECTION}`);
console.log(`    pnpm --filter @buttery/atproto-dev-env records   # read records back (agent verify path)`);
console.log(`${line}\n  Ctrl-C to stop.\n`);

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.log(`\n${signal} received — shutting down dev-env…`);
  try {
    await net.close();
  } finally {
    process.exit(0);
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// Keep the process alive (dev-env servers hold the event loop, but be explicit).
await new Promise<never>(() => {});
