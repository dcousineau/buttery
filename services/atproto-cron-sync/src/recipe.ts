import type { Pool, PoolClient } from "pg";
import type { PdsRecord } from "#/pds.ts";

// Record projection, lightweight validation, and the two write statements.
// All network input is untrusted (plan §1): store the raw record as jsonb,
// project a few columns, mark a validation status, never throw a repo's other
// records away because one was malformed.

type ValidationStatus = "valid" | "invalid" | "unknown";

/** The columns we project + write for one record, ready to bind. */
export interface RecipeRow {
  did: string;
  rkey: string;
  collection: string;
  uri: string;
  cid: string;
  rev: string;
  record: Record<string, unknown>;
  name: string | null;
  recordCreatedAt: string | null;
  recordUpdatedAt: string | null;
  validationStatus: ValidationStatus;
}

// at://<did>/<collection>/<rkey> — take the last path segment as the rkey.
function rkeyFromUri(uri: string): string | null {
  const parts = uri
    .replace(/^at:\/\//, "")
    .split("/")
    .filter(Boolean);
  return parts.length === 3 ? parts[2] : null;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

// Structural check against exchange.recipe.recipe's required fields (name,
// text, ingredients, instructions, createdAt, updatedAt). Full lexicon
// validation is a web-side read concern (plan §3 / §7) — this is only enough
// to set validation_status.
function validate(record: Record<string, unknown>): ValidationStatus {
  const ok =
    isNonEmptyString(record.name) &&
    typeof record.text === "string" &&
    isStringArray(record.ingredients) &&
    isStringArray(record.instructions) &&
    isNonEmptyString(record.createdAt) &&
    isNonEmptyString(record.updatedAt);
  return ok ? "valid" : "invalid";
}

// Project a datetime field to a string Postgres can cast to timestamptz, or
// null when absent/unparseable. Never let a bad value abort the row.
function projectDatetime(v: unknown): string | null {
  if (!isNonEmptyString(v)) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : v;
}

/** Build a bindable row from a raw PDS record, or null if it has no usable rkey. */
export function toRecipeRow(did: string, collection: string, rev: string, rec: PdsRecord): RecipeRow | null {
  const rkey = rkeyFromUri(rec.uri);
  if (!rkey) return null;
  const record = rec.value;
  return {
    did,
    rkey,
    collection,
    uri: rec.uri,
    cid: rec.cid,
    rev,
    record,
    name: isNonEmptyString(record.name) ? record.name : null,
    recordCreatedAt: projectDatetime(record.createdAt),
    recordUpdatedAt: projectDatetime(record.updatedAt),
    validationStatus: validate(record),
  };
}

// Rev-guarded upsert keyed on (did, rkey). A stale duplicate loses the
// `atproto_collection_recipe.rev < excluded.rev` guard and no-ops. Re-create
// resurrects a soft-deleted row (deleted_at → null).
const UPSERT_RECIPE_SQL = `
insert into atproto_collection_recipe
  (did, rkey, collection, uri, cid, rev, record, name,
   record_created_at, record_updated_at, validation_status, indexed_at, deleted_at)
values
  ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), null)
on conflict (did, rkey) do update set
  cid                = excluded.cid,
  rev                = excluded.rev,
  record             = excluded.record,
  name               = excluded.name,
  record_created_at  = excluded.record_created_at,
  record_updated_at  = excluded.record_updated_at,
  validation_status  = excluded.validation_status,
  indexed_at         = now(),
  deleted_at         = null
where atproto_collection_recipe.rev < excluded.rev
`;

/** Upsert one row. Returns 1 if the guard let the write through, else 0. */
export async function upsertRecipe(client: PoolClient, row: RecipeRow): Promise<number> {
  const res = await client.query(UPSERT_RECIPE_SQL, [
    row.did,
    row.rkey,
    row.collection,
    row.uri,
    row.cid,
    row.rev,
    row.record, // pg serializes the object into jsonb
    row.name,
    row.recordCreatedAt,
    row.recordUpdatedAt,
    row.validationStatus,
  ]);
  return res.rowCount ?? 0;
}

const SOFT_DELETE_SQL = `
update atproto_collection_recipe
   set deleted_at = now()
 where did = $1
   and deleted_at is null
   and rkey <> all($2::text[])
`;

/**
 * Soft-delete rows for `did` whose rkey was NOT seen in this sweep. Only safe
 * for a DID whose full listRecords enumeration succeeded — the caller gates on
 * that (plan §1 step 5). Returns the number of rows soft-deleted.
 */
export async function reconcileDeletes(pool: Pool, did: string, seenRkeys: string[]): Promise<number> {
  const res = await pool.query(SOFT_DELETE_SQL, [did, seenRkeys]);
  return res.rowCount ?? 0;
}
