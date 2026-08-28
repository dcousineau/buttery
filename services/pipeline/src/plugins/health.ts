import fp from "fastify-plugin";

/**
 * The unauthenticated healthcheck (S1). Replaces the `GET /health` route
 * registered inline in `src/server.ts` — Railway polls this to decide
 * whether a deployment is healthy, and it has no credentials, so it stays
 * outside the board's basic-auth scope.
 *
 * The workflow names come from `fastify.workflows` (S4's registry), read at
 * request time — not at boot, so `dependencies: ["workflow"]` costs nothing
 * here even though the registry is only fully populated once the second
 * autoload pass (`src/workflows/`) has run, well after this plugin's own
 * registration.
 */
export default fp(
  (fastify) => {
    fastify.get("/health", () => ({
      status: "ok",
      queues: fastify.workflows.list().map((registration) => registration.spec.name),
    }));
  },
  { name: "health", dependencies: ["workflow"] },
);
