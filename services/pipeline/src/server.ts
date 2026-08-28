import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { FastifyAdapter } from "@bull-board/fastify";
import basicAuth from "@fastify/basic-auth";
import Fastify from "fastify";
import { timingSafeEqual } from "node:crypto";
import { Autoscaler, DISABLED_STATE } from "#/autoscale.ts";
import { readBacklog } from "#/lib/bullmq/backlog.ts";
import { loadAutoscaleConfig, loadConfig } from "#/config.ts";
import { WORKFLOWS, findWorkflow } from "#/workflows/index.ts";
import { log } from "#/log.ts";
import { closeQueues, getQueues } from "#/queues.ts";
import { closeRedis } from "#/redis.ts";
import { reconcileQueues } from "#/lib/bullmq/reconcile.ts";

/**
 * The `pipeline` service: a Fastify server that hosts the Bull Board UI, exposes
 * a small API for enqueuing jobs, and (on Railway) runs the worker autoscaler.
 *
 * It is a *producer*, never a consumer — no `Worker` is constructed here. Jobs
 * are drained by `worker.ts`, deployed as its own Railway service so the fleet
 * can be scaled without restarting the dashboard, and vice versa.
 *
 * Routes:
 *   GET  /health          unauthenticated — Railway's healthcheck target
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
  const config = loadConfig();
  const queues = getQueues(config.redisUrl);

  const app = Fastify({
    // The service already emits structured JSON through `log`; Fastify's own
    // pino output would be a second, differently-shaped stream in the same logs.
    logger: false,
    // Railway terminates TLS in front of the container.
    trustProxy: true,
  });

  // Unauthenticated and outside the board's scope: Railway polls this to decide
  // whether a new deployment is healthy, and it has no credentials.
  app.get("/health", () => ({ status: "ok", queues: WORKFLOWS.map((workflow) => workflow.name) }));

  app.get("/", async (_req, reply) => reply.redirect(BOARD_PATH, 302));

  const serverAdapter = new FastifyAdapter();
  createBullBoard({
    queues: [...queues.values()].map((queue) => new BullMQAdapter(queue)),
    serverAdapter,
  });
  serverAdapter.setBasePath(BOARD_PATH);

  const autoscaleConfig = loadAutoscaleConfig();
  const autoscaler = autoscaleConfig ? new Autoscaler(autoscaleConfig, queues.values()) : undefined;

  // Everything that can read a payload or move a job lives inside this scope, so
  // one `onRequest` hook covers the board, the JSON endpoints and the enqueue
  // API — a route added later inside the scope is protected by construction
  // rather than by remembering to list it.
  await app.register(async (scope) => {
    const auth = config.server.auth;
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
      WORKFLOWS.map((workflow) => ({
        name: workflow.name,
        description: workflow.description,
        entry: workflow.entry,
        steps: workflow.steps,
        schedule: workflow.schedule?.() ?? null,
        maxInFlight: workflow.globalConcurrency?.() ?? null,
      })),
    );

    scope.get("/queues", async () => {
      const snapshot = await readBacklog(queues.values());
      return {
        ...snapshot,
        descriptions: Object.fromEntries(WORKFLOWS.map((workflow) => [workflow.name, workflow.description])),
      };
    });

    scope.get("/autoscale", () => autoscaler?.state ?? DISABLED_STATE);

    scope.post<{ Params: { queue: string }; Body: { name?: string; data?: unknown } | undefined }>("/jobs/:queue", async (req, reply) => {
      const workflow = findWorkflow(req.params.queue);
      const queue = queues.get(req.params.queue);
      if (!workflow || !queue) {
        return reply.status(404).send({ error: `unknown queue "${req.params.queue}"` });
      }

      const body = req.body ?? {};
      // A job's name is the step it runs. Default to the graph's root; naming
      // another step is how you re-run one by hand from the board's payload.
      const job = await queue.add(body.name ?? workflow.entry, body.data ?? {});
      log.info("job enqueued", { queue: workflow.name, jobId: job.id, name: job.name });
      return reply.status(202).send({ queue: workflow.name, jobId: job.id, name: job.name });
    });
  });

  // Before listening: a boot that cannot reach Redis should fail as a failed
  // deployment rather than as a healthy service with no schedules.
  await reconcileQueues(queues);

  await app.listen({ port: config.server.port, host: config.server.host });
  log.info("pipeline server listening", {
    url: `http://${config.server.host}:${config.server.port}${BOARD_PATH}`,
    queues: WORKFLOWS.map((workflow) => workflow.name),
    auth: config.server.auth ? "basic" : "none",
  });

  if (!config.server.auth) {
    log.warn("Bull Board is unauthenticated — set PIPELINE_AUTH_PASSWORD to require a login");
  }

  autoscaler?.start();

  // Railway sends SIGTERM and waits before SIGKILL; close in dependency order so
  // in-flight requests finish and no queue is left holding the Redis socket.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { signal });
    autoscaler?.stop();
    await app.close();
    await closeQueues();
    await closeRedis();
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
