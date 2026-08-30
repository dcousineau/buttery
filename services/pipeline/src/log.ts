// Structured console logging. One JSON object per line so Railway's log viewer
// (and any downstream ingestion) can parse fields without a format — the same
// shape @buttery/web emits, deliberately: both feed one log stream per
// environment and there is no reason for them to disagree.
//
// `role` distinguishes the ways this one package runs — the API/board service, a
// worker replica, the one-shot CLI — and `replica` carries Railway's per-replica
// id, which is the only way to tell autoscaled worker containers apart.

type Fields = Record<string, unknown>;

// Set by the entrypoint rather than read from the environment: which role a
// process is playing is decided by which file Node was pointed at, and a start
// command that forgot to also export a matching variable would silently mislabel
// every line it logs.
let role = "server";

/** Called once, at the top of an entrypoint, before anything else logs. */
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
