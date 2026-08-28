import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { FastifyAdapter } from "@bull-board/fastify";
import basicAuth from "@fastify/basic-auth";
import { timingSafeEqual } from "node:crypto";
import { buildApp } from "#/app.ts";
import { Autoscaler, DISABLED_STATE } from "#/autoscale.ts";
import { readBacklog } from "#/lib/bullmq/backlog.ts";
import { loadAutoscaleConfig } from "#/config.ts";
import { log } from "#/log.ts";

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
 *   GET  /workflows       the graphs this build can run       (basic auth)
 *   GET  /queues          job counts per queue as JSON     (basic auth)
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
  // then `src/workflows/` — so by the time this call resolves, `app.workflows`
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
    queues: app.workflows.list().map((registration) => new BullMQAdapter(registration.queue)),
    serverAdapter,
  });
  serverAdapter.setBasePath(BOARD_PATH);

  const autoscaleConfig = loadAutoscaleConfig();
  const autoscaler = autoscaleConfig
    ? new Autoscaler(
        autoscaleConfig,
        app.workflows.list().map((registration) => registration.queue),
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

    // What this build knows how to run, straight off the registry: the steps a
    // workflow will move through and the schedule it is on. The board shows jobs;
    // this shows the shape they will take before any of them exist.
    scope.get("/workflows", () =>
      app.workflows.list().map(({ spec }) => ({
        name: spec.name,
        description: spec.description,
        entry: spec.entry,
        steps: spec.steps,
        schedule: spec.schedule ?? null,
        maxInFlight: spec.globalConcurrency ?? null,
      })),
    );

    scope.get("/queues", async () => {
      const registrations = app.workflows.list();
      const snapshot = await readBacklog(registrations.map((registration) => registration.queue));
      return {
        ...snapshot,
        descriptions: Object.fromEntries(registrations.map((registration) => [registration.spec.name, registration.spec.description])),
      };
    });

    scope.get("/autoscale", () => autoscaler?.state ?? DISABLED_STATE);

    scope.post<{ Params: { queue: string }; Body: { name?: string; data?: unknown } | undefined }>("/jobs/:queue", async (req, reply) => {
      const registration = app.workflows.get(req.params.queue);
      if (!registration) {
        return reply.status(404).send({ error: `unknown queue "${req.params.queue}"` });
      }

      const body = req.body ?? {};
      // A job's name is the step it runs. Default to the graph's root; naming
      // another step is how you re-run one by hand from the board's payload.
      const job = await registration.queue.add(body.name ?? registration.spec.entry, body.data ?? {});
      log.info("job enqueued", { queue: registration.spec.name, jobId: job.id, name: job.name });
      return reply.status(202).send({ queue: registration.spec.name, jobId: job.id, name: job.name });
    });
  });

  // `plugins/workflow.ts`'s `onReady` hook reconciles schedules and global
  // concurrency for role "server" — it runs during `app.listen()` below, before
  // the port is bound. A boot that cannot reach Redis fails there, as a failed
  // deployment, not as a healthy service with no schedules.
  await app.listen({ port: app.env.PORT, host });
  log.info("pipeline server listening", {
    url: `http://${host}:${app.env.PORT}${BOARD_PATH}`,
    queues: app.workflows.list().map((registration) => registration.spec.name),
    auth: auth ? "basic" : "none",
  });

  if (!auth) {
    log.warn("Bull Board is unauthenticated — set PIPELINE_AUTH_PASSWORD to require a login");
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
    log.info("shutting down", { signal });
    autoscaler?.stop();
    await app.close();
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      void shutdown(signal).catch((err: unknown) => {
        log.error("shutdown failed", { err: String(err) });
        process.exit(1);
      });
    });
  }
}

await start().catch((err: unknown) => {
  log.error("pipeline server failed to start", { err: String(err) });
  process.exit(1);
});
