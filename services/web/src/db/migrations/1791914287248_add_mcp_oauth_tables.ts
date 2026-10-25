import { type Kysely, sql } from "kysely";

/**
 * Tables for the better-auth `jwt()` + `mcp()` (OAuth 2.1 provider) plugins that
 * back the `/mcp` endpoint. Names are snake_case like every table Buttery owns;
 * better-auth addresses its models in camelCase, so src/lib/auth-schema.ts maps
 * each model and field onto the names below. The table list mirrors
 * `getAuthTables()` for the plugin set in src/lib/auth.ts.
 *
 * Every user-owned row cascades on user delete, so wiping a user (see
 * scripts/reset-user-data.ts) never trips over a token or consent row.
 *
 * `Kysely<any>` is intentional: migrations are frozen in time.
 */

const now = sql`CURRENT_TIMESTAMP`;
// better-auth's Kysely adapter always JSON-encodes array fields (supportsArrays is
// hardcoded false), so these are JSON text rather than Postgres arrays.
const textArray = sql`text`;

// oxlint-disable-next-line typescript/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("jwks")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("public_key", "text", (col) => col.notNull())
    .addColumn("private_key", "text", (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) => col.notNull().defaultTo(now))
    .addColumn("expires_at", "timestamptz")
    .addColumn("alg", "text")
    .addColumn("crv", "text")
    .execute();

  await db.schema
    .createTable("oauth_client")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("client_id", "text", (col) => col.notNull().unique())
    .addColumn("client_secret", "text")
    .addColumn("client_discovery_id", "text")
    .addColumn("disabled", "boolean")
    .addColumn("skip_consent", "boolean")
    .addColumn("enable_end_session", "boolean")
    .addColumn("subject_type", "text")
    .addColumn("scopes", textArray)
    .addColumn("client_credentials_scopes", textArray)
    .addColumn("user_id", "text", (col) => col.references("user.id").onDelete("cascade"))
    .addColumn("created_at", "timestamptz", (col) => col.defaultTo(now))
    .addColumn("updated_at", "timestamptz", (col) => col.defaultTo(now))
    .addColumn("name", "text")
    .addColumn("uri", "text")
    .addColumn("icon", "text")
    .addColumn("contacts", textArray)
    .addColumn("tos", "text")
    .addColumn("policy", "text")
    .addColumn("software_id", "text")
    .addColumn("software_version", "text")
    .addColumn("software_statement", "text")
    .addColumn("redirect_uris", textArray, (col) => col.notNull())
    .addColumn("post_logout_redirect_uris", textArray)
    .addColumn("backchannel_logout_uri", "text")
    .addColumn("backchannel_logout_session_required", "boolean")
    .addColumn("token_endpoint_auth_method", "text")
    .addColumn("application_type", "text")
    .addColumn("jwks", "text")
    .addColumn("jwks_uri", "text")
    .addColumn("grant_types", textArray)
    .addColumn("response_types", textArray)
    .addColumn("require_pkce", "boolean")
    .addColumn("dpop_bound_access_tokens", "boolean")
    .addColumn("reference_id", "text")
    .addColumn("metadata", "jsonb")
    .execute();

  await db.schema
    .createTable("oauth_resource")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("identifier", "text", (col) => col.notNull().unique())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("access_token_ttl", "integer")
    .addColumn("refresh_token_ttl", "integer")
    .addColumn("signing_algorithm", "text")
    .addColumn("signing_key_id", "text")
    .addColumn("allowed_scopes", textArray)
    .addColumn("custom_claims", "jsonb")
    .addColumn("dpop_bound_access_tokens_required", "boolean")
    .addColumn("disabled", "boolean")
    .addColumn("created_at", "timestamptz", (col) => col.defaultTo(now))
    .addColumn("updated_at", "timestamptz", (col) => col.defaultTo(now))
    .addColumn("policy_version", "integer")
    .addColumn("metadata", "jsonb")
    .execute();

  await db.schema
    .createTable("oauth_client_resource")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("client_id", "text", (col) => col.notNull().references("oauth_client.client_id").onDelete("cascade"))
    .addColumn("resource_id", "text", (col) => col.notNull().references("oauth_resource.identifier").onDelete("cascade"))
    .addColumn("metadata", "jsonb")
    .addColumn("created_at", "timestamptz", (col) => col.defaultTo(now))
    .execute();

  await db.schema
    .createTable("oauth_refresh_token")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("token", "text", (col) => col.notNull().unique())
    .addColumn("client_id", "text", (col) => col.notNull().references("oauth_client.client_id").onDelete("cascade"))
    .addColumn("session_id", "text", (col) => col.references("session.id").onDelete("set null"))
    .addColumn("user_id", "text", (col) => col.notNull().references("user.id").onDelete("cascade"))
    .addColumn("reference_id", "text")
    .addColumn("authorization_code_id", "text")
    .addColumn("resources", textArray)
    .addColumn("requested_user_info_claims", textArray)
    .addColumn("expires_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.defaultTo(now))
    .addColumn("revoked", "timestamptz")
    .addColumn("rotated_at", "timestamptz")
    .addColumn("rotation_replay_response", "text")
    .addColumn("rotation_replay_expires_at", "timestamptz")
    .addColumn("auth_time", "timestamptz")
    .addColumn("confirmation", "jsonb")
    .addColumn("scopes", textArray, (col) => col.notNull())
    .execute();

  await db.schema
    .createTable("oauth_access_token")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("token", "text", (col) => col.unique())
    .addColumn("client_id", "text", (col) => col.notNull().references("oauth_client.client_id").onDelete("cascade"))
    .addColumn("session_id", "text", (col) => col.references("session.id").onDelete("set null"))
    .addColumn("user_id", "text", (col) => col.references("user.id").onDelete("cascade"))
    .addColumn("reference_id", "text")
    .addColumn("authorization_code_id", "text")
    .addColumn("resources", textArray)
    .addColumn("requested_user_info_claims", textArray)
    .addColumn("refresh_id", "text", (col) => col.references("oauth_refresh_token.id").onDelete("cascade"))
    .addColumn("expires_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (col) => col.defaultTo(now))
    .addColumn("revoked", "timestamptz")
    .addColumn("confirmation", "jsonb")
    .addColumn("scopes", textArray, (col) => col.notNull())
    .execute();

  await db.schema
    .createTable("oauth_consent")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("client_id", "text", (col) => col.notNull().references("oauth_client.client_id").onDelete("cascade"))
    .addColumn("user_id", "text", (col) => col.references("user.id").onDelete("cascade"))
    .addColumn("reference_id", "text")
    .addColumn("resources", textArray)
    .addColumn("requested_user_info_claims", textArray)
    .addColumn("scopes", textArray, (col) => col.notNull())
    .addColumn("created_at", "timestamptz", (col) => col.defaultTo(now))
    .addColumn("updated_at", "timestamptz", (col) => col.defaultTo(now))
    .execute();

  await db.schema
    .createTable("oauth_client_assertion")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("expires_at", "timestamptz", (col) => col.notNull())
    .execute();

  await db.schema.createIndex("oauth_client_user_id_idx").on("oauth_client").column("user_id").execute();
  await db.schema.createIndex("oauth_client_resource_client_id_idx").on("oauth_client_resource").column("client_id").execute();
  await db.schema.createIndex("oauth_refresh_token_user_id_idx").on("oauth_refresh_token").column("user_id").execute();
  await db.schema.createIndex("oauth_refresh_token_client_id_idx").on("oauth_refresh_token").column("client_id").execute();
  await db.schema.createIndex("oauth_access_token_user_id_idx").on("oauth_access_token").column("user_id").execute();
  await db.schema.createIndex("oauth_access_token_client_id_idx").on("oauth_access_token").column("client_id").execute();
  await db.schema.createIndex("oauth_consent_user_id_idx").on("oauth_consent").column("user_id").execute();
  await db.schema.createIndex("oauth_consent_client_id_idx").on("oauth_consent").column("client_id").execute();
}

// oxlint-disable-next-line typescript/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  // Reverse dependency order; indexes drop with their tables.
  await db.schema.dropTable("oauth_client_assertion").ifExists().execute();
  await db.schema.dropTable("oauth_consent").ifExists().execute();
  await db.schema.dropTable("oauth_access_token").ifExists().execute();
  await db.schema.dropTable("oauth_refresh_token").ifExists().execute();
  await db.schema.dropTable("oauth_client_resource").ifExists().execute();
  await db.schema.dropTable("oauth_resource").ifExists().execute();
  await db.schema.dropTable("oauth_client").ifExists().execute();
  await db.schema.dropTable("jwks").ifExists().execute();
}
