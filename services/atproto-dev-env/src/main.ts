// Local ATProto dev-env runner. Boots an isolated PDS + local PLC (no AppView,
// no relay) via @atproto/dev-env, seeds one `.test` account, prints the env
// block for `services/web/.env`, then stays alive until interrupted.
//
// Isolation guarantee: DIDs are registered in the LOCAL PLC and the PDS is
// local, so nothing here is visible to plc.directory, bsky.social, or the relay.
//
// State PERSISTS in `cfg.dataDir` (gitignored), so the seed account keeps one
// stable `did:plc` across restarts and buttery's Postgres rows stay resolvable.
// Delete that directory to start over with a new DID.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { TestNetworkNoAppView } from "@atproto/dev-env";
import { AtpAgent } from "@atproto/api";
import { DEV_JWT_SECRET, DEV_PLC_ROTATION_KEY_HEX, loadConfig, RECIPE_COLLECTION } from "#/config.ts";
import { FilePlcDatabase } from "#/plc-store.ts";

const cfg = loadConfig();

// dev-env creates its own default temp dirs but assumes any path we pass in
// already exists — better-sqlite3 refuses to create the parent directory.
const pdsDir = join(cfg.dataDir, "pds");
const blobsDir = join(cfg.dataDir, "blobs");
await mkdir(pdsDir, { recursive: true });
await mkdir(blobsDir, { recursive: true });

const plcDb = await FilePlcDatabase.open(join(cfg.dataDir, "plc.json"));
const restored = plcDb.didCount;

const net = await TestNetworkNoAppView.create({
  // `db` is not in dev-env's `PlcConfig` type, but TestPlc spreads its config
  // AFTER the default `plc.Database.mock()`, so this replaces it.
  plc: { port: cfg.plcPort, db: plcDb } as { port: number },
  pds: {
    port: cfg.pdsPort,
    // dev-env defaults these to fresh mkdtemp dirs and a random rotation key,
    // which is what made the DID change every boot. Pin all three.
    dataDirectory: pdsDir,
    blobstoreDiskLocation: blobsDir,
    plcRotationKeyK256PrivateKeyHex: DEV_PLC_ROTATION_KEY_HEX,
    jwtSecret: DEV_JWT_SECRET,
  },
});

// Idempotent seed: the account survives in the persisted PDS, so a restart must
// resolve the existing DID rather than fail on a taken handle.
const agent = new AtpAgent({ service: net.pds.url });
let did: string;
let seeded: string;
try {
  await agent.createAccount({ handle: cfg.handle, email: cfg.email, password: cfg.password });
  did = agent.session?.did ?? "(unknown)";
  seeded = restored === 0 ? "created" : "created (new account in existing store)";
} catch {
  await agent.login({ identifier: cfg.handle, password: cfg.password });
  did = agent.session?.did ?? "(unknown)";
  seeded = "restored";
}

const line = "─".repeat(72);
console.log(`\n${line}`);
console.log("  Local ATProto dev-env is UP (isolated — never touches the real network)");
console.log(line);
console.log(`  PDS:    ${net.pds.url}`);
console.log(`  PLC:    ${net.plc.url}`);
console.log(`  Handle: ${cfg.handle}`);
console.log(`  DID:    ${did}   (stable — ${seeded})`);
console.log(`  Pass:   ${cfg.password}`);
console.log(`  State:  ${cfg.dataDir}   (${restored} DID(s) restored; delete to reset)`);
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
