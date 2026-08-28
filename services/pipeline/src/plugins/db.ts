import { Pool } from "pg";
import fp from "fastify-plugin";

/**
 * The service-wide pg pool (S1, D4). Replaces the two identical per-workflow
 * pools — `workflows/recipe-enrichment/lib/db.ts` and its atproto-sync
 * twin — with one pool decorated as `fastify.db`, closed in `onClose`. There
 * is no per-workflow reason for two pools to exist; it was only ever that
 * there was nowhere else to put one. Functions that take `pool: Pool` today
 * keep taking it — only the source of the pool changes, and only once a
 * later step gives their callers `fastify` in scope.
 */
export default fp(
  (fastify) => {
    const pool = new Pool({ connectionString: fastify.env.DATABASE_URL });

    fastify.decorate("db", pool);

    fastify.addHook("onClose", async () => {
      await pool.end();
    });
  },
  { name: "db", dependencies: ["env"] },
);

declare module "fastify" {
  interface FastifyInstance {
    db: Pool;
  }
}
