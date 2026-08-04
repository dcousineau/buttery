// Shared config for the local ATProto dev-env: the runner (main.ts) and the
// standalone read/publish helpers all read the same knobs so they agree on
// ports and the seed account without extra wiring.
//
// Node runs this `.ts` directly (type-stripping) — keep everything erasable
// (no enum/namespace/param-props), and import local files with explicit `.ts`.

export interface DevEnvConfig {
  /** PDS (OAuth authz server + repo host). Fixed so `services/web/.env` can point at it. */
  pdsPort: number;
  pdsUrl: string;
  /** Local PLC/DID registry — keeps DID resolution off the real plc.directory. */
  plcPort: number;
  plcUrl: string;
  /** Seed account. Handle ends in `.test` (dev-env convention). */
  handle: string;
  email: string;
  password: string;
}

function port(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got ${raw}`);
  return n;
}

export function loadConfig(): DevEnvConfig {
  const pdsPort = port("ATPROTO_DEV_PDS_PORT", 2583);
  const plcPort = port("ATPROTO_DEV_PLC_PORT", 2582);
  // dev-env binds hostname `localhost`; match it so OAuth issuer/DID-doc URLs
  // line up with what buttery resolves.
  return {
    pdsPort,
    pdsUrl: `http://localhost:${pdsPort}`,
    plcPort,
    plcUrl: `http://localhost:${plcPort}`,
    handle: process.env.ATPROTO_DEV_HANDLE ?? "chef.test",
    email: process.env.ATPROTO_DEV_EMAIL ?? "chef@dev.local",
    password: process.env.ATPROTO_DEV_PASSWORD ?? "devpw-chef-000",
  };
}

export const RECIPE_COLLECTION = "exchange.recipe.recipe";
