import "#/env.ts";
import { getJson } from "#/queues/atproto-sync/lib/http.ts";

// DID → PDS endpoint + handle resolution. Ported (not imported) from
// services/web/src/lib/atproto/recipes.ts `resolvePds` — different package, no
// shared lib yet (plan §1 step 2). did:plc via plc.directory; did:web via the
// host's /.well-known/did.json.
//
// Local dev: set ATPROTO_PLC_URL (e.g. http://localhost:2582 from
// services/atproto-dev-env) + SYNC_ONLY_DID to sweep the local dev network
// instead of the real one. Unset → plc.directory (prod, unchanged).

// Read per call rather than at module load: this module is imported while the
// worker is booting, and a top-level read would freeze whatever `process.env`
// happened to hold at that instant. Trailing-slash tolerant — plc.directory and
// dev-env's PLC both accept `/<did>`.
function plcDirectoryUrl(): string {
  return (process.env.ATPROTO_PLC_URL ?? "https://plc.directory").replace(/\/+$/, "");
}

interface DidDocument {
  alsoKnownAs?: string[];
  service?: Array<{ id: string; type: string; serviceEndpoint: string }>;
}

export interface ResolvedIdentity {
  pds: string;
  /** The DID's primary handle (from `alsoKnownAs`), a cache-only claim — never
   * treat as truth (plan §2 atproto_repo notes). null if the doc asserts none. */
  handle: string | null;
}

/** First `at://<handle>` entry in `alsoKnownAs`, minus the scheme. */
function handleFromDoc(doc: DidDocument): string | null {
  const aka = doc.alsoKnownAs?.find((a) => a.startsWith("at://"));
  return aka ? aka.slice("at://".length) || null : null;
}

/** Resolve a DID document → its atproto PDS endpoint + primary handle. */
export async function resolveIdentity(did: string): Promise<ResolvedIdentity> {
  let docUrl: string;
  if (did.startsWith("did:plc:")) {
    docUrl = `${plcDirectoryUrl()}/${did}`;
  } else if (did.startsWith("did:web:")) {
    const host = did.slice("did:web:".length).split(":").join("/");
    docUrl = `https://${decodeURIComponent(host)}/.well-known/did.json`;
  } else {
    throw new Error(`Unsupported DID method: ${did}`);
  }

  const doc = await getJson<DidDocument>(docUrl);
  const pds = doc.service?.find((s) => s.id.endsWith("#atproto_pds") || s.type === "AtprotoPersonalDataServer");
  if (!pds) throw new Error(`No PDS endpoint in DID document for ${did}`);
  return { pds: pds.serviceEndpoint, handle: handleFromDoc(doc) };
}
