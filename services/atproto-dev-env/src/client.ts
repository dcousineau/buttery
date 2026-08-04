// Helpers for the standalone read/publish scripts. These talk to the ALREADY
// RUNNING dev-env over HTTP (they do NOT boot their own network) — so the
// records you write and read are the same ones buttery publishes to.

import { loadConfig, type DevEnvConfig } from "#/config.ts";

/** Resolve the seed handle → its (per-run) did via the running PDS. */
export async function resolveDid(cfg: DevEnvConfig): Promise<string> {
  const url = `${cfg.pdsUrl}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(cfg.handle)}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`resolveHandle failed (${res.status}). Is the dev-env running? Start it with:\n  pnpm --filter @buttery/atproto-dev-env start`);
  }
  const body = (await res.json()) as { did?: string };
  if (!body.did) throw new Error(`resolveHandle returned no did for ${cfg.handle}`);
  return body.did;
}

export function config(): DevEnvConfig {
  return loadConfig();
}
