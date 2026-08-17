import { defineConfig } from "kysely-ctl";
import { PostgresDialect } from "kysely";
import { getPool } from "./src/lib/db";

// kysely-ctl config: drives `pnpm db:migrate:*` and `pnpm db:seed:*`.
//
// The CLI runs outside the app runtime, so nothing injects .env for us the way
// the dev server / railway does. Load it here — `.env` lives in this package
// (services/web), which is also the cwd for `pnpm --filter @buttery/web`. No-op
// when the file is absent (e.g. on Railway, where DATABASE_URL is already in
// the environment).
try {
  process.loadEnvFile();
} catch {
  // No .env file present — rely on the ambient environment.
}

export default defineConfig({
  // Reuse the app's shared Postgres pool so migrations hit the DB through the
  // same connection infrastructure as runtime queries (see src/lib/db.ts).
  dialect: new PostgresDialect({ pool: getPool() }),
  migrations: {
    // Kept under src/db per the project's DB layout (see src/db/README.md).
    migrationFolder: "src/db/migrations",
  },
  // Dev fixtures, and nothing else. Seeds are NEVER wired into a process, a
  // hook or a script that runs on its own — `process-compose.yaml`'s `migrate`
  // process stays `db:migrate:up` only. A human types `pnpm db:seed:run`, or
  // nothing happens. See `.agents/skills/local-dev/SKILL.md`.
  seeds: {
    // Beside the migrations, same reason. `allowJS` stays at its `false`
    // default — every seed here is TypeScript, loaded through kysely-ctl's
    // jiti loader (which, unlike plain `node`, transforms TS rather than only
    // stripping it).
    seedFolder: "src/db/seeds",
  },
});
