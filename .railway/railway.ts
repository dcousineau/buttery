import { bucket, defineRailway, github, postgres, project, redis, ref, service } from "railway/iac";

export default defineRailway((ctx) => {
  const db = postgres("postgres");

  // Redis — backs the scrape rate limiter (SET NX PX per-account key) and a
  // general-purpose cache. Railway exposes REDIS_URL (private-network host);
  // the web service consumes it as REDIS_URL (see services/web/src/lib/redis.ts).
  const cache = redis("redis");

  // @todo REMOVE BOTH OF THESE once `railway dev` no longer needs them.
  //
  // Public TCP proxies put Postgres and Redis on the open internet, behind
  // nothing but a password. We do not want that — production datastores should
  // be reachable over private networking only, never publicly. They are here
  // solely because `railway dev` cannot work without them.
  //
  // The dependency is structural, not a bug we can wait out quietly: the CLI
  // derives a service's local port mapping from its *public* networking config
  // and nothing else. From the original `railway dev` PR
  // (railwayapp/cli#710, and unchanged since):
  //
  //     pub fn get_ports(&self) -> Vec<i64> {
  //         // networking.service_domains[*].port + networking.tcp_proxies.keys()
  //     }
  //
  // No domain and no TCP proxy → no ports → the generated docker-compose.yml
  // gets no `ports:` key for that service at all, silently, while `railway run`
  // still hands the app a `…@localhost:<port>` URL. The app then spins on
  // ECONNREFUSED with nothing explaining why. `scripts/dev/railway-containers.mjs`
  // fails its readiness probe on exactly that and says so in the log pane.
  //
  // Not a regression — that is how the feature shipped (2025-12-12), and no
  // issue tracks it. `railway dev` is still marked experimental. Watch for a
  // release that decouples local port publishing from public networking; when
  // one lands, delete these two lines and the proxies with them.
  //
  // Worth knowing meanwhile: dev traffic does NOT flow through the public
  // endpoints. `railway dev` allocates its own host port per container and
  // rewrites the service's RAILWAY_TCP_PROXY_DOMAIN/PORT to
  // `localhost:<that port>`, which is what `railway run` injects — so the app
  // always talks to the local container, never to production. Verify with:
  //   railway run --service buttery -- printenv DATABASE_URL REDIS_URL
  //
  // Keyed by application port. Railway assigns the public port itself, and it
  // is unrelated to the local one; never hardcode either.
  //
  // `railway config plan` reports "Update postgres/redis networking" on every
  // run, including immediately after a successful apply — the current-state
  // snapshot reads networking back as null, so it can never see that the
  // proxies already exist. The apply is idempotent (verified: postgres kept its
  // existing proxy id and port), so treat that pair of lines as noise.
  db.networking = { tcpProxies: { "5432": {} } };
  cache.networking = { tcpProxies: { "6379": {} } };

  // S3-compatible object storage for Buttery-owned uploads (pre-publish recipe
  // draft images). Buckets are per-environment with isolated credentials.
  // Railway provides BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY/REGION/ENDPOINT as
  // referenceable outputs; the web service consumes them as BLOB_S3_* (see
  // services/web/src/lib/blob-storage.ts). Draft bytes live here until publish,
  // when they're read back and uploaded to the user's PDS as an atproto blob.
  const uploads = bucket("buttery-uploads", { region: "iad" });

  // Public origin for this environment. Single source of truth: feeds both
  // better-auth (`BETTER_AUTH_URL`) and the client bundle (`VITE_APP_URL`, which
  // Vite inlines at build time for og:image / og:url / canonical — see
  // services/web/src/lib/seo.ts).
  // @todo If multiple environments are introduced, this should be dynamic.
  const publicOrigin = "https://buttery.recipes";

  // GitHub-triggered deploys: pushes to the repo build & deploy automatically.
  //
  // Monorepo (pnpm workspace): Railway builds from the repo root — no
  // rootDirectory — so the whole workspace + lockfile are present. The build
  // filters to the web service and its deps (`@buttery/web...`, trailing `...`
  // pulls in @buttery/lexicons and builds it first). watchPatterns keep pushes
  // that only touch other future services from rebuilding web.
  const web = service("buttery", {
    source: github("dcousineau/buttery"),
    build: {
      buildCommand: "pnpm install --frozen-lockfile && pnpm --filter @buttery/web... build",
      watchPatterns: ["services/web/**", "packages/lexicons/**", "pnpm-lock.yaml"],
    },
    // Runs after build, before the new container serves traffic, inside the
    // built app image with DATABASE_URL injected. Migrations must succeed
    // (exit 0) or the deploy is aborted and the old container keeps serving.
    // `migrate latest` is idempotent, so a no-op deploy re-runs it harmlessly.
    // Requires kysely-ctl in the web package `dependencies` (Railpack prunes
    // devDeps from the runtime image). The web service owns the db shape for
    // now; when db is extracted to @buttery/db this filter moves with it.
    preDeploy: "pnpm --filter @buttery/web db:migrate:up",
    start: "pnpm --filter @buttery/web start",
    env: {
      DATABASE_URL: db.env.DATABASE_URL,
      // Redis — scrape rate limiter + general cache (private networking).
      REDIS_URL: cache.env.REDIS_URL,
      // Public origin — used as better-auth baseURL and to derive the atproto
      // OAuth client_id / redirect URI.
      BETTER_AUTH_URL: publicOrigin,
      // Same origin, exposed to the Vite build so it's inlined into the client
      // bundle for SEO/OG absolute URLs (must be present at BUILD time).
      VITE_APP_URL: publicOrigin,
      // Generated by Railway on first apply in each environment (better-auth
      // wants 32+ chars); preserveExisting keeps the current value thereafter.
      BETTER_AUTH_SECRET: { generator: "secret(44)", preserveExisting: true },
      // PostHog project token (a public `phc_` client key). Kept out of this
      // open-source repo: imported from a Railway project shared variable, whose
      // value is managed in the dashboard under the project's shared variables.
      // It's referenced twice — inlined into the client bundle at BUILD time
      // (VITE_, see services/web/src/routes/__root.tsx) and read at RUNTIME by
      // posthog-node (below). Railway injects the resolved reference into both
      // the build and runtime environments, so the VITE_ inline works.
      VITE_PUBLIC_POSTHOG_PROJECT_TOKEN: ctx.shared.POSTHOG_PROJECT_TOKEN,
      VITE_PUBLIC_POSTHOG_HOST: "https://event.buttery.recipes",
      // PostHog server config — read at RUNTIME by posthog-node to evaluate the
      // `invited` access flag server-side and identify people by handle (see
      // services/web/src/lib/posthog-server.ts). Server-to-server, so it talks to
      // PostHog's ingestion host directly, not the client reverse-proxy.
      POSTHOG_PROJECT_TOKEN: ctx.shared.POSTHOG_PROJECT_TOKEN,
      POSTHOG_HOST: "https://us.i.posthog.com",
      // Object storage (buttery-uploads bucket) — S3-compatible, virtual-hosted.
      BLOB_S3_ENDPOINT: ref(uploads, "ENDPOINT"),
      BLOB_S3_REGION: ref(uploads, "REGION"),
      BLOB_S3_BUCKET: ref(uploads, "BUCKET"),
      BLOB_S3_ACCESS_KEY_ID: ref(uploads, "ACCESS_KEY_ID"),
      BLOB_S3_SECRET_ACCESS_KEY: ref(uploads, "SECRET_ACCESS_KEY"),
    },
  });
  // CDN caching is enabled for this service but is not expressible in the IaC
  // DSL (as of railway@3.6.0 / CLI 5.28); it is managed via `railway cdn`:
  //   railway cdn status --service buttery
  // Current settings: enabled, html-caching=auto, default-ttl=2h, swr honored,
  // purge-on-deploy=html.

  // Future services live in this same monorepo and are added as sibling
  // service() entries, each with its own narrow watchPatterns so they build
  // independently of web:
  //   - a dedicated api service      → filter @buttery/api...,    watch services/api/** + shared packages
  //   - atproto sync listeners/workers → filter @buttery/worker..., long-running
  // Shared code they consume (lexicons today; db later) goes under packages/.

  // Cron: sweep the atproto network and reconcile the Postgres recipe index.
  // A cron service's container is stopped between runs (true scale-to-zero,
  // $0 idle) — do NOT enable the Serverless/app-sleeping toggle here (that's
  // for always-on HTTP services and adds cold-boot 502s). See plan §5.
  //
  // No build step: Node 26 runs the TypeScript directly. Same monorepo build
  // model as web — install the whole workspace, run the package's start. It's
  // a pure DB writer, so it owns no migrations (web's preDeploy ships the DDL).
  const sync = service("atproto-cron-sync", {
    source: github("dcousineau/buttery"),
    build: {
      buildCommand: "pnpm install --frozen-lockfile",
      watchPatterns: ["services/atproto-cron-sync/**", "pnpm-lock.yaml"],
    },
    start: "pnpm --filter @buttery/atproto-cron-sync start",
    deploy: {
      // Hourly (UTC). Cost-optimal default; index-on-write covers Buttery's own
      // writes, so this only reconciles cross-app edits. Tighten to */15 only
      // if freshness demands (measure the first real sweep first — plan §8).
      cronSchedule: "0 * * * *",
      // A completed cron must not be restarted into a loop. Use ON_FAILURE with
      // a small maxRetries only if you want auto-retry before the next run.
      restartPolicyType: "NEVER",
    },
    env: {
      // Private networking; reuse the same Postgres (ingress not billed as egress).
      DATABASE_URL: db.env.DATABASE_URL,
      RELAY_URL: "https://relay1.us-east.bsky.network",
    },
  });

  return project("buttery", {
    resources: [db, cache, uploads, web, sync],
  });
});
