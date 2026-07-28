// Structured console logging. One JSON object per line so Railway's log
// viewer (and any downstream ingestion) can parse fields without a format.

type Fields = Record<string, unknown>;

function emit(stream: "stdout" | "stderr", level: string, msg: string, fields?: Fields): void {
  const line = JSON.stringify({ level, msg, ...fields });
  if (stream === "stderr") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export const log = {
  info: (msg: string, fields?: Fields) => emit("stdout", "info", msg, fields),
  warn: (msg: string, fields?: Fields) => emit("stdout", "warn", msg, fields),
  error: (msg: string, fields?: Fields) => emit("stderr", "error", msg, fields),
};
