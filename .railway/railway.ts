import { bucket, defineRailway, github, image, postgres, project, redis, ref, service, type VariableValue } from "railway/iac";

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

  // The SDK types `ctx.shared` with an `any` index signature (it can't know a
  // project's shared variables), so pin the type once here rather than letting
  // `any` spread through the env maps below.
  const posthogProjectToken = ctx.shared.POSTHOG_PROJECT_TOKEN as VariableValue;

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
      // THE analytics gate. PostHog is production-only: it captures nothing and
      // writes nothing anywhere else, so dev/test/staging can never dirty the
      // project (services/web/src/lib/analytics.ts + lib/posthog-server.ts).
      // Both halves are strict allowlists on the string "true" — unset is OFF.
      // The VITE_ one is inlined at BUILD time, the bare one read at RUNTIME.
      //
      // Do NOT lift these into a shared variable: shared variables are what
      // `railway run` hands a developer's laptop, which is precisely the leak
      // this closes. They belong to the deployed service and nothing else.
      // If a second environment is ever added, this must become conditional on
      // it — a staging deploy gets "false".
      VITE_PUBLIC_POSTHOG_ENABLED: "true",
      POSTHOG_ENABLED: "true",
      // PostHog project token (a public `phc_` client key). Kept out of this
      // open-source repo: imported from a Railway project shared variable, whose
      // value is managed in the dashboard under the project's shared variables.
      // It's referenced twice — inlined into the client bundle at BUILD time
      // (VITE_, see services/web/src/routes/__root.tsx) and read at RUNTIME by
      // posthog-node (below). Railway injects the resolved reference into both
      // the build and runtime environments, so the VITE_ inline works.
      VITE_PUBLIC_POSTHOG_PROJECT_TOKEN: posthogProjectToken,
      VITE_PUBLIC_POSTHOG_HOST: "https://event.buttery.recipes",
      // PostHog server config — read at RUNTIME by posthog-node to evaluate the
      // `invited` access flag server-side and identify people by handle (see
      // services/web/src/lib/posthog-server.ts). Server-to-server, so it talks to
      // PostHog's ingestion host directly, not the client reverse-proxy.
      POSTHOG_PROJECT_TOKEN: posthogProjectToken,
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
  //   - a dedicated api service → filter @buttery/api..., watch services/api/** + shared packages
  // Shared code they consume (lexicons today; db later) goes under packages/.

  // --- Temporal ------------------------------------------------------------
  //
  // A self-hosted Temporal cluster, modelled on Railway's own
  // "Temporal | Durable Workflows, No Elasticsearch" template
  // (railway.com/deploy/temporal-or-durable-workflows-no-elastic): the server,
  // its Postgres, the Web UI, and a basic-auth proxy in front of the UI. No
  // Elasticsearch — visibility runs on Postgres, which costs full-text search
  // over workflow attributes and saves ~650 MiB of memory. For the volumes this
  // project has, that is the right trade.
  //
  // This is the honest price of the Temporal build, and it is four services
  // where BullMQ needed none: the queue there was the Redis the app already had.
  // Everything below exists before a single workflow runs.

  // Temporal's own database, holding both the main and the visibility schemas.
  // Deliberately NOT the app's `postgres` above: auto-setup creates databases
  // and runs schema migrations on boot, its visibility tables take a write on
  // every workflow state transition, and neither belongs in the database serving
  // the app. Collapsing the two would save a service if cost ever demands it —
  // point POSTGRES_SEEDS/USER/PWD at `db` and give the schemas their own names.
  const temporalDb = postgres("temporal-postgres");

  // The server: frontend, history, matching and worker roles in one container,
  // which is what `auto-setup` is for. It also creates the databases, applies the
  // schema and registers the default namespace on first boot, so there is no
  // separate admin-tools step to run by hand.
  //
  // Pinned by digest-less tag on purpose — a Temporal server upgrade is a schema
  // migration, and it should be a deliberate edit to this line rather than
  // something a redeploy picks up.
  const temporal = service("temporal", {
    source: image("temporalio/auto-setup:1.29.7"),
    env: {
      // `postgres12` is the driver name for every modern Postgres, not a version
      // claim about the server. `_pgx` is the alternative driver; the default is
      // the one the template and Temporal's own compose files use.
      DB: "postgres12",
      POSTGRES_SEEDS: temporalDb.env.PGHOST,
      DB_PORT: temporalDb.env.PGPORT,
      POSTGRES_USER: temporalDb.env.PGUSER,
      POSTGRES_PWD: temporalDb.env.PGPASSWORD,
      DBNAME: "temporal",
      VISIBILITY_DBNAME: "temporal_visibility",

      // Visibility on Postgres. The variable is what keeps auto-setup from
      // expecting an Elasticsearch cluster it would otherwise wait for forever.
      ENABLE_ES: "false",

      // Set once, at creation, and unchangeable afterwards: the shard count is
      // baked into how history is distributed, and changing it means a new
      // cluster and a migration. 512 is the template's choice and is generous
      // for this workload — the cost of picking too high is memory, the cost of
      // picking too low is a migration nobody wants to do.
      NUM_HISTORY_SHARDS: "512",

      // Railway's private network is IPv6-only. Without this the server binds
      // 0.0.0.0 and every private-network client — the UI, the worker — gets
      // connection refused against a port that is demonstrably open.
      BIND_ON_IP: "::",

      // The namespace the worker polls and the CLI defaults to. 72 hours of
      // history retention: long enough to debug last night's sweep, short enough
      // that the visibility tables do not grow without bound.
      DEFAULT_NAMESPACE: "default",
      DEFAULT_NAMESPACE_RETENTION: "72h",
    },
  });

  // gRPC on 7233 over a public TCP proxy, so the `temporal` CLI on a laptop can
  // reach this cluster — `temporal --address <proxy host>:<proxy port> workflow
  // list`. The deployed worker does NOT use it; it dials
  // temporal.railway.internal over private networking.
  //
  // Assigned as a property rather than passed to `service()`, which silently
  // drops a `networking` key from its config (verified against railway@3.10.0 by
  // compiling the graph both ways) — the same reason `db.networking` above is
  // written this way.
  //
  // Note what this is: an unauthenticated gRPC endpoint on the public internet.
  // A self-hosted Temporal has no authentication of its own — that is what
  // Temporal Cloud sells — so anyone who finds the host:port can start and
  // terminate workflows. Acceptable only because the port is randomly assigned
  // and unadvertised; if that stops being good enough, delete this and reach the
  // cluster through `railway ssh` instead.
  temporal.networking = { tcpProxies: { "7233": {} } };

  // The Web UI: every workflow, its input, its result, each activity attempt and
  // each retry, with a "start workflow" button. It is the thing the BullMQ build
  // had to stand up itself (a Fastify service, Bull Board, basic auth, a
  // healthcheck and a place in the IaC) and here is a container with one variable.
  //
  // No public domain of its own — it is only reachable through `temporal-auth`
  // below, because the UI has no login and can terminate any workflow in the
  // cluster.
  const temporalUi = service("temporal-ui", {
    source: image("temporalio/ui:2.53.1"),
    env: {
      // Private DNS is `<service name>.railway.internal`, always.
      TEMPORAL_ADDRESS: "temporal.railway.internal:7233",
      TEMPORAL_UI_PORT: "8080",
      // The UI serves an API for its own frontend; without an allowed origin it
      // rejects the browser's requests. Point it at the auth proxy's domain once
      // one exists (see the note on `temporalAuth`).
      TEMPORAL_CORS_ORIGINS: "",
    },
  });

  // Basic auth in front of the UI. The same image the Railway template uses: a
  // Caddy reverse proxy whose only job is to demand a password before passing
  // traffic to a private service.
  //
  // It has NO generated domain in this file: Railway owns generated domains and
  // `railway config pull` deliberately omits them. Give it one with
  //   railway domain --service temporal-auth
  // and then set TEMPORAL_CORS_ORIGINS on `temporal-ui` to that origin.
  const temporalAuth = service("temporal-auth", {
    source: image("ghcr.io/brody192/railway-caddy-basic-auth:main"),
    env: {
      PROXY_PASS: "http://temporal-ui.railway.internal:8080",
      USERNAME: "buttery",
      // Generated by Railway on first apply; preserveExisting keeps it
      // thereafter. Read the value out of this service's variables to log in.
      PASSWORD: { generator: "secret(32)", preserveExisting: true },
    },
  });

  // --- The worker ----------------------------------------------------------
  //
  // Our code: one process that polls the `buttery` task queue and runs every
  // workflow and activity in @buttery/worker. No HTTP, no state, nothing kept
  // between tasks — so a replica can be added or removed at any time, and a
  // draining one finishes its in-flight activities before it exits.
  //
  // `packages/recipe-schemas/**` is in watchPatterns because the atproto-sync
  // workflow renders records through it, and a change there that did not
  // redeploy the fleet would leave it rendering by yesterday's rules.
  const worker = service("worker", {
    source: github("dcousineau/buttery"),
    build: {
      // No build step: Node 26 runs the TypeScript directly. The worker bundles
      // its own workflow code at boot (see services/worker/src/worker.ts).
      buildCommand: "pnpm install --frozen-lockfile",
      watchPatterns: ["services/worker/**", "packages/recipe-schemas/**", "pnpm-lock.yaml"],
    },
    start: "pnpm --filter @buttery/worker start",

    // Schedules live in the cluster, not in this repo, so they are reconciled on
    // every deploy: created, updated, and REMOVED when no workflow declares them
    // any more. preDeploy is exactly the right place — it runs once per deploy,
    // in the built image, before any new container serves, and a non-zero exit
    // aborts the deploy and keeps the old containers up.
    //
    // The BullMQ build could not do this. Its schedulers lived in Redis and had
    // to be reconciled by a process that was always up and that there was
    // exactly one of, which is part of why that design needed a second
    // always-on service.
    preDeploy: "pnpm --filter @buttery/worker schedules:sync",

    // Declared, unlike the BullMQ fleet's, and that is the point: there is no
    // autoscaler here and nothing needs one. A worker pulls tasks when it has
    // capacity, so a backlog waits in Temporal instead of piling into a process
    // — depth is absorbed by WORKER_MAX_CONCURRENT_ACTIVITIES first, and only
    // then by this number. Raise it when the queue's schedule-to-start latency
    // says so, in a commit, rather than by a control loop holding a Railway API
    // token.
    replicas: 1,

    // No healthcheck: there is no server to probe. Railway treats a long-running
    // process with no healthcheck path as healthy once it starts.
    env: {
      TEMPORAL_ADDRESS: "temporal.railway.internal:7233",
      TEMPORAL_NAMESPACE: "default",
      TEMPORAL_TASK_QUEUE: "buttery",

      // Workflows read and write the recipe index in the APP's database (not
      // Temporal's). Private networking; web's preDeploy owns the migrations, so
      // this service ships no DDL.
      DATABASE_URL: db.env.DATABASE_URL,

      // Read by the `atproto-sync` workflow, which is the retired cron service's
      // sweep — same code, same variables, now living in @buttery/worker.
      // ATPROTO_PLC_URL is deliberately unset: absent, the sweep resolves DIDs
      // through plc.directory, which is what production wants.
      RELAY_URL: "https://relay1.us-east.bsky.network",

      // Hourly (UTC), the same cadence the retired cron service ran on.
      // Cost-optimal default; index-on-write covers Buttery's own writes, so this
      // only reconciles cross-app edits. Tighten to */15 only if freshness
      // demands it (measure a real sweep first).
      //
      // Read by preDeploy, not by the running worker: emptying this variable and
      // redeploying REMOVES the schedule rather than orphaning one that keeps
      // firing from a config nothing in the repo mentions.
      ATPROTO_SYNC_SCHEDULE: "0 * * * *",

      NODE_ENV: "production",
    },
  });

  // There is no `atproto-cron-sync` service any more. The sweep it ran hourly is
  // now the `atproto-sync` workflow, scheduled by Temporal and run by `worker`
  // above — see services/worker/src/workflows/atproto-sync/.
  //
  // Deleting it is a DESTRUCTIVE plan item, so the apply that lands this change
  // needs `railway config apply --confirm-destructive`. Nothing is lost with it:
  // the service held no volume and no state, and its DATABASE_URL and RELAY_URL
  // moved to `worker`. The sweep is still runnable by hand, now as
  // `pnpm --filter @buttery/worker sync:once` against whichever cluster
  // TEMPORAL_ADDRESS names.

  return project("buttery", {
    resources: [db, cache, uploads, web, temporalDb, temporal, temporalUi, temporalAuth, worker],
  });
});
