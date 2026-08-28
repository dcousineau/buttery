import fp from "fastify-plugin";

/**
 * The unauthenticated healthcheck (S1). Replaces the `GET /health` route
 * registered inline in `src/server.ts` — Railway polls this to decide
 * whether a deployment is healthy, and it has no credentials, so it stays
 * outside the board's basic-auth scope and outside any workflow-registry
 * dependency (`dependencies: []`).
 *
 * `server.ts`'s current handler also reports the workflow names it knows
 * about; that piece moves to `plugins/workflow.ts` once a workflow registry
 * exists as a decorator (S2/S3). Until then this is deliberately smaller
 * than the route it will eventually replace — nothing wires to it yet.
 */
export default fp(
  (fastify) => {
    fastify.get("/health", () => ({ status: "ok" }));
  },
  { name: "health", dependencies: [] },
);
