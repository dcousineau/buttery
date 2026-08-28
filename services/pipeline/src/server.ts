import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { FastifyAdapter } from "@bull-board/fastify";
import basicAuth from "@fastify/basic-auth";
import { timingSafeEqual } from "node:crypto";
import { buildApp } from "#/app.ts";
import { Autoscaler, DISABLED_STATE } from "#/lib/railway/autoscale.ts";
import { readBacklog } from "#/lib/bullmq/backlog.ts";
import { loadAutoscaleConfig } from "#/lib/railway/config.ts";

/**
 * The `pipeline` service: a Fastify server that hosts the Bull Board UI, exposes
 * a small API for enqueuing jobs, and (on Railway) runs the worker autoscaler.
 *
 * It is a *producer*, never a consumer — no `Worker` is constructed here. Jobs
 * are drained by `worker.ts`, deployed as its own Railway service so the fleet
 * can be scaled without restarting the dashboard, and vice versa.
 *
 * Routes:
 *   GET  /health          unauthenticated — Railway's healthcheck target (plugins/health.ts)
 *   GET  /                redirect to the board
 *   GET  /ui              Bull Board                       (basic auth)
 *   GET  /queues          every registered queue, its jobs and its backlog (basic auth)
 *   GET  /autoscale       last autoscaler decision as JSON (basic auth)
 *   POST /jobs/:queue     enqueue one job                  (basic auth)
 */

const BOARD_PATH = "/ui";

/** Constant-time compare that tolerates length mismatch without leaking it via early return. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    // Still burn a comparison so the failure costs the same as a wrong-value one.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

async function start(): Promise<void> {
  // `buildApp` autoloads `src/plugins/` (env, redis, db, workflow, health, ...)
  // then `src/queues/` — so by the time this call resolves, `app.bullmq`
  // is fully populated. Everything below is registered strictly after that,
  // and avvio's FIFO `register` queue is what keeps it boot-ordered after both
  // autoload passes even though nothing here awaits readiness directly — see
  // `app.ts`'s doc comment and the ordering finding in the decision journal.
  const app = await buildApp("server");

  const host = app.env.PIPELINE_HOST ?? (app.env.PRODUCTION ? "0.0.0.0" : "127.0.0.1");
  const auth = app.env.PIPELINE_AUTH_PASSWORD ? { username: app.env.PIPELINE_AUTH_USER ?? "buttery", password: app.env.PIPELINE_AUTH_PASSWORD } : undefined;

  app.get("/", async (_req, reply) => reply.redirect(BOARD_PATH, 302));

  const serverAdapter = new FastifyAdapter();
  createBullBoard({
    queues: app.bullmq.list().map((registration) => new BullMQAdapter(registration.queue)),
    serverAdapter,
  });
  serverAdapter.setBasePath(BOARD_PATH);

  const autoscaleConfig = loadAutoscaleConfig(app.env);
  const autoscaler = autoscaleConfig
    ? new Autoscaler(
        autoscaleConfig,
        app.bullmq.list().map((registration) => registration.queue),
        app.log,
      )
    : undefined;

  // Everything that can read a payload or move a job lives inside this scope, so
  // one `onRequest` hook covers the board, the JSON endpoints and the enqueue
  // API — a route added later inside the scope is protected by construction
  // rather than by remembering to list it.
  await app.register(async (scope) => {
    if (auth) {
      await scope.register(basicAuth, {
        authenticate: { realm: "Buttery pipeline" },
        validate: (username, password, _req, _reply, done) => {
          // Both halves compared in constant time, and both always compared:
          // returning early on a bad username would make it distinguishable
          // from a bad password by timing alone.
          const okUser = safeEqual(username, auth.username);
          const okPassword = safeEqual(password, auth.password);
          done(okUser && okPassword ? undefined : new Error("invalid credentials"));
        },
      });
      scope.addHook("onRequest", scope.basicAuth);
    }

    // `prefix` is the only option the adapter reads; the base path the UI builds
    // its own links from comes from `setBasePath` above.
    await scope.register(serverAdapter.registerPlugin(), { prefix: BOARD_PATH });

    // One endpoint, not two: what this build can run and what is currently
    // queued are the same question now that a queue is the unit rather than a
    // workflow graph. `GET /workflows` is gone with the engine that needed it —
    // there is no graph to describe ahead of time, only named jobs a processor
    // handles and whatever flows they choose to fan out at runtime.
    scope.get("/queues", async () => {
      const registrations = app.bullmq.list();
      const backlog = await readBacklog(registrations.map((registration) => registration.queue));
      return {
        ...backlog,
        queues: registrations.map(({ options }) => ({
          name: options.name,
          description: options.description,
          jobs: options.jobs,
          defaultJob: options.defaultJob,
          schedule: options.schedule ?? null,
          maxInFlight: options.globalConcurrency ?? null,
        })),
      };
    });

    scope.get("/autoscale", () => autoscaler?.state ?? DISABLED_STATE);

    scope.post<{ Params: { queue: string }; Body: { name?: string; data?: unknown } | undefined }>("/jobs/:queue", async (req, reply) => {
      const registration = app.bullmq.get(req.params.queue);
      if (!registration) {
        return reply.status(404).send({ error: `unknown queue "${req.params.queue}"` });
      }

      const body = req.body ?? {};
      const name = body.name ?? registration.options.defaultJob;
      // Rejected here rather than enqueued: a job whose name no processor
      // handles would otherwise sit in the failed tab with an "unknown job"
      // error, which is a worse way to learn you typed it wrong.
      if (!registration.options.jobs.some((job) => job.name === name)) {
        return reply.status(400).send({
          error: `queue "${registration.options.name}" has no job "${name}"`,
          jobs: registration.options.jobs.map((job) => job.name),
        });
      }

      const job = await registration.queue.add(name, body.data ?? {});
      app.log.info({ queue: registration.options.name, jobId: job.id, name: job.name }, "job enqueued");
      return reply.status(202).send({ queue: registration.options.name, jobId: job.id, name: job.name });
    });
  });

  // `plugins/bullmq.ts`'s `onReady` hook reconciles schedulers and global
  // concurrency for role "server" — it runs during `app.listen()` below, before
  // the port is bound. A boot that cannot reach Redis fails there, as a failed
  // deployment, not as a healthy service with no schedules.
  await app.listen({ port: app.env.PORT, host });
  app.log.info(
    {
      url: `http://${host}:${app.env.PORT}${BOARD_PATH}`,
      queues: app.bullmq.list().map((registration) => registration.options.name),
      auth: auth ? "basic" : "none",
    },
    "pipeline server listening",
  );

  if (!auth) {
    app.log.warn("Bull Board is unauthenticated — set PIPELINE_AUTH_PASSWORD to require a login");
  }

  autoscaler?.start();

  // Railway sends SIGTERM and waits before SIGKILL; `app.close()` runs every
  // plugin's `preClose`/`onClose` in reverse registration order, which is what
  // drains workers (n/a here — this process holds none), closes queues and
  // the flow producer, then Redis and the pool.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");
    autoscaler?.stop();
    await app.close();
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      void shutdown(signal).catch((err: unknown) => {
        app.log.error({ err: String(err) }, "shutdown failed");
        process.exit(1);
      });
    });
  }
}

await start();
