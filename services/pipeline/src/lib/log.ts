// This is no longer the pipeline's logger — `app.ts` configures Fastify's own
// pino instance for that, and every entrypoint logs through `app.log` /
// `fastify.log` now. What survives here is the fallback for exactly two pure
// helpers deep in `workflows/atproto-sync/lib/` that have no Fastify instance
// to reach for and whose callers' own exported signatures were not worth
// changing just to thread one through:
//
//   - `lib/http.ts`'s `getJson` (the "http retry" warn) — 4 callers across
//     `lib/relay.ts`, `lib/pds.ts` and `lib/identity.ts`.
//   - `lib/render.ts`'s `renderRecipe` (the "discovered vocab token" info) —
//     8 call sites in `lib/render.db.test.ts`.
//
// One JSON object per line so Railway's log viewer (and any downstream
// ingestion) can parse fields without a format — the same shape @buttery/web
// emits, deliberately: both feed one log stream per environment and there is
// no reason for them to disagree. `app.ts` configures pino to emit that
// identical line shape, so these two lines and every `fastify.log.*` line
// land on the wire looking the same.
//
// `role` distinguishes the ways this one package runs — the API/board service, a
// worker replica, the one-shot CLI — and `replica` carries Railway's per-replica
// id, which is the only way to tell autoscaled worker containers apart.

type Fields = Record<string, unknown>;

// Set by `buildApp` rather than read from the environment: which role a
// process is playing is decided by which file Node was pointed at, and a start
// command that forgot to also export a matching variable would silently mislabel
// every line it logs.
let role = "server";

/** Called once, by `buildApp`, before anything else logs. */
export function setLogRole(next: string): void {
  role = next;
}

function emit(stream: "stdout" | "stderr", level: string, msg: string, fields?: Fields): void {
  const line = JSON.stringify({
    level,
    msg,
    svc: "pipeline",
    role,
    ...(process.env.RAILWAY_REPLICA_ID ? { replica: process.env.RAILWAY_REPLICA_ID } : {}),
    ...fields,
  });
  if (stream === "stderr") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export const log = {
  info: (msg: string, fields?: Fields) => emit("stdout", "info", msg, fields),
  warn: (msg: string, fields?: Fields) => emit("stdout", "warn", msg, fields),
  error: (msg: string, fields?: Fields) => emit("stderr", "error", msg, fields),
};
