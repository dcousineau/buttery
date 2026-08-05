// Shared config for the local ATProto dev-env: the runner (main.ts) and the
// standalone read/publish helpers all read the same knobs so they agree on
// ports and the seed account without extra wiring.
//
// Node runs this `.ts` directly (type-stripping) — keep everything erasable
// (no enum/namespace/param-props), and import local files with explicit `.ts`.

import { resolve } from "node:path";

/**
 * Repo root, derived from this file's location (`services/atproto-dev-env/src`)
 * rather than `process.cwd()`. process-compose launches the runner with cwd set
 * to the service directory while `pnpm --filter` and a bare `node …/main.ts`
 * use the repo root — a cwd-relative data dir would therefore give the seed
 * account a DIFFERENT stable DID per launch method, which is the exact bug the
 * persistent store exists to prevent.
 */
const REPO_ROOT = resolve(import.meta.dirname, "../../..");

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
  /**
   * Directory holding the PDS data dir, blobstore, and the PLC snapshot. State
   * persists across restarts so the seed account keeps ONE stable `did:plc` and
   * buttery's Postgres rows stay resolvable. Delete it to start clean.
   *
   * Always `<repo>/.dev-data/atproto` unless `ATPROTO_DEV_DATA_DIR` overrides —
   * see {@link REPO_ROOT} for why this is not cwd-relative.
   */
  dataDir: string;
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
    dataDir: process.env.ATPROTO_DEV_DATA_DIR ?? resolve(REPO_ROOT, ".dev-data/atproto"),
  };
}

/**
 * PDS PLC rotation key, fixed for local dev.
 *
 * `@atproto/dev-env` mints a random one per boot. The rotation key signs the
 * genesis operation that a `did:plc` is derived from, so a fresh key means a
 * fresh DID even with a persistent PLC — it has to be pinned for the DID to be
 * stable. Dev-only throwaway: this network is unreachable from the real
 * atmosphere and holds nothing of value.
 */
export const DEV_PLC_ROTATION_KEY_HEX = "7f9b1a1c0d4e2f38a5c6b7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2";

/** PDS JWT signing secret, fixed so sessions survive a dev-env restart. */
export const DEV_JWT_SECRET = "buttery-dev-env-jwt-secret-do-not-use-anywhere-else";

export const RECIPE_COLLECTION = "exchange.recipe.recipe";
