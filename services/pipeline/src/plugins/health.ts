import fp from "fastify-plugin";

/**
 * The unauthenticated healthcheck (S1). Replaces the `GET /health` route
 * registered inline in `src/server.ts` — Railway polls this to decide
 * whether a deployment is healthy, and it has no credentials, so it stays
 * outside the board's basic-auth scope.
 *
 * The queue names come from `fastify.bullmq`'s registry, read at REQUEST time
 * — not at boot, which is what makes `dependencies: ["bullmq"]` cheap here
 * even though the registry is only fully populated once the second autoload
 * pass (`src/queues/`) has run, well after this plugin's own registration.
 */
export default fp(
  (fastify) => {
    fastify.get("/health", () => ({
      status: "ok",
      queues: fastify.bullmq.list().map((registration) => registration.options.name),
    }));
  },
  { name: "health", dependencies: ["bullmq"] },
);
