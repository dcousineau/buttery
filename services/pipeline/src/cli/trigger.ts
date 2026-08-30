import { buildApp } from "#/app.ts";

/**
 * Add one job to a queue, print its id, and exit.
 *
 *   pnpm --filter @buttery/pipeline trigger <queue> [--job=name] [--flag] [--flag=value]
 *   pnpm --filter @buttery/pipeline sync:trigger --dry-run      # the same, for atproto-sync
 *
 * ── THIS USED TO RUN THE WORK. NOW IT ONLY ENQUEUES IT. ────────────────────
 *
 * The file this replaced (`run-once.ts`) ran a whole graph to completion in
 * this process, through `consoleHost` — a second execution engine that
 * re-implemented fan-out so a graph could run without a worker. That host is
 * deleted, and nothing here resurrects it. This file does not run anything:
 * it assumes a pipeline server and a worker fleet are already up, calls
 * `queue.add(...)` exactly the way `POST /jobs/:queue` does, and exits. The
 * job then runs wherever every other job runs — on the worker fleet, subject
 * to the same concurrency caps and retries as one enqueued from the board or
 * from a schedule — and you watch it happen in Bull Board instead of in this
 * terminal.
 *
 * That is a real behavior change, not a rename, and it is worth the loss of
 * the old "run it right here" convenience: one execution engine, not two.
 * `consoleHost` and the real worker could disagree — about concurrency,
 * about which errors were unrecoverable, about how a failed child's failure
 * reached its parent — and a workflow that only broke in one of the two
 * hosts was a workflow nobody had actually tested in production shape. A CLI
 * that can only enqueue cannot drift from the queue that actually runs it,
 * because it IS the queue that actually runs it.
 *
 * The corollary: this command now needs Redis AND a running worker to see
 * anything happen. `docker compose up -d redis`, `pnpm dev`, `pnpm dev:worker`
 * — then this — then the board.
 *
 * Flags become the job's payload, same as before: `--dry-run` is
 * `{"dryRun": true}` and `--label=hello` is `{"label": "hello"}`.
 *
 * `--job=<name>` replaces the old `--step=`; it selects which of the queue's
 * registered job names to add (default: the registration's `defaultJob`) and
 * is validated against `registration.options.jobs` before anything is sent to
 * Redis — the same check, for the same reason, as `server.ts`'s
 * `POST /jobs/:queue`. The CLI and the HTTP endpoint are two doors onto the
 * same `queue.add` call and must not disagree about what is enqueueable.
 *
 * `buildApp("cli")` registers every queue the same way the server and the
 * worker do, but `plugins/bullmq.ts`'s `onReady` builds no `Worker`s and
 * reconciles no schedulers for this role — the registry exists purely so this
 * file can look a queue up and call `.add()` on the real `Queue`.
 */

interface Invocation {
  queue: string;
  /** `--job=`, or undefined for the queue's `defaultJob`. */
  job?: string;
  payload: Record<string, unknown>;
}

/** Consumed by this file rather than passed through as payload. */
const JOB_FLAG = "--job=";

/** `--dry-run` → `dryRun: true`; `--max-repos=3` → `maxRepos: "3"`. */
function toPayloadKey(flag: string): string {
  return flag.replace(/^--/, "").replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function parseArgv(argv: string[]): Invocation | undefined {
  const queue = argv.filter((arg) => !arg.startsWith("--"))[0];
  if (!queue) return undefined;

  let job: string | undefined;
  const payload: Record<string, unknown> = {};
  for (const arg of argv.filter((a) => a.startsWith("--"))) {
    if (arg.startsWith(JOB_FLAG)) {
      job = arg.slice(JOB_FLAG.length);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq === -1) payload[toPayloadKey(arg)] = true;
    else payload[toPayloadKey(arg.slice(0, eq))] = arg.slice(eq + 1);
  }
  return { queue, job, payload };
}

async function main(): Promise<void> {
  const invocation = parseArgv(process.argv.slice(2));

  const app = await buildApp("cli");
  await app.ready();

  const registration = invocation ? app.bullmq.get(invocation.queue) : undefined;
  if (!invocation || !registration) {
    app.log.error({ queues: app.bullmq.list().map((r) => r.options.name) }, "usage: trigger <queue> [--job=name] [--flag] [--flag=value]");
    process.exitCode = 2;
    await app.close();
    return;
  }

  const jobName = invocation.job ?? registration.options.defaultJob;
  // Same rejection `POST /jobs/:queue` makes, and for the same reason: a job
  // name no processor handles would otherwise sit in the failed tab with an
  // "unknown job" error, which is a worse way to learn you typed it wrong.
  if (!registration.options.jobs.some((j) => j.name === jobName)) {
    app.log.error({ queue: registration.options.name, job: jobName, jobs: registration.options.jobs.map((j) => j.name) }, "no such job");
    process.exitCode = 2;
    await app.close();
    return;
  }

  try {
    const job = await registration.queue.add(jobName, invocation.payload);
    app.log.info(
      { queue: registration.options.name, job: job.name, jobId: job.id },
      `job enqueued — watch the "${registration.options.name}" queue in Bull Board (GET /ui) to see it run`,
    );
  } catch (err) {
    // The whole premise of this command is "a server is already running" —
    // Redis unreachable here almost always means that premise is false, not
    // that Redis itself is misconfigured. Say so plainly rather than letting
    // ioredis's own retry/connect error speak for itself.
    app.log.error({ queue: registration.options.name, err: String(err) }, "could not enqueue — is a pipeline server up and reachable?");
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

await main();
