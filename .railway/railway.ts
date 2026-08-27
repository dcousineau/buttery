import { bucket, defineRailway, github, postgres, project, redis, ref, service, type VariableValue } from "railway/iac";

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
      watchPatterns: ["services/web/**", "packages/food/**", "packages/lexicons/**", "packages/pipeline-contract/**", "pnpm-lock.yaml"],
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

  // --- Data pipelines (BullMQ) ---------------------------------------------
  //
  // One package (@buttery/pipeline), deployed as two services because the two
  // halves scale for different reasons: exactly one dashboard is enough and it
  // has to stay up, while the worker fleet grows with the backlog and shrinks
  // when it drains. See services/pipeline/README.md.
  //
  // Both install the whole workspace and run the package's start script, with no
  // build step (Node 26 runs the TypeScript directly), and share one
  // watchPatterns set, so a change to the package redeploys the pair together
  // and they never run different code. Three workspace packages are in the set
  // because the workflows read them, and a change to one that did not redeploy
  // the pair would leave the fleet running by yesterday's rules:
  // `packages/recipe-schemas/**` (atproto-sync renders records through it),
  // `packages/food/**` (recipe-enrichment matches ingredient lines through its
  // lexicon and classifies from its traits), and `packages/pipeline-contract/**`
  // (the queue and step names the web app enqueues against — a rename there that
  // reached only one side is the exact failure that package exists to prevent).
  const pipelineBuild = {
    buildCommand: "pnpm install --frozen-lockfile",
    watchPatterns: ["services/pipeline/**", "packages/food/**", "packages/pipeline-contract/**", "packages/recipe-schemas/**", "pnpm-lock.yaml"],
  };

  // The producer + Bull Board UI. Holds no queue state of its own — everything
  // it shows lives in Redis — so it is a plain stateless HTTP service.
  //
  // It has NO generated domain in this file: Railway domains are created by the
  // platform and `railway config pull` deliberately omits them. Give it one with
  //   railway domain --service pipeline
  // (or add a custom subdomain to `domains:` here once its DNS exists). The board
  // is behind basic auth either way — see PIPELINE_AUTH_PASSWORD below.
  const pipeline = service("pipeline", {
    source: github("dcousineau/buttery"),
    build: pipelineBuild,
    start: "pnpm --filter @buttery/pipeline start",
    // Gates zero-downtime deploys, and matters more here than usual: the
    // autoscaler lives in this service, so a container that is up but not
    // serving is also a fleet that has stopped being resized.
    healthcheck: "/health",
    env: {
      REDIS_URL: cache.env.REDIS_URL,
      // Read by the service to require a board password and to bind 0.0.0.0.
      NODE_ENV: "production",
      PIPELINE_AUTH_USER: "buttery",
      // The board shows every job payload and can retry, promote and delete
      // jobs, so it is never public. Railway generates this on first apply and
      // preserveExisting keeps it thereafter; read the value out of the service's
      // variables in the dashboard to log in.
      PIPELINE_AUTH_PASSWORD: { generator: "secret(44)", preserveExisting: true },

      // --- schedules ---------------------------------------------------------
      // Hourly (UTC), the same cadence the retired cron service ran on. Cost-optimal default; index-on-write covers Buttery's own writes, so
      // this only reconciles cross-app edits. Tighten to */15 only if freshness
      // demands it (measure a real sweep first).
      //
      // Read by the SERVER, not the workers: the server reconciles BullMQ's job
      // schedulers at boot, and it is the one process there is exactly one of.
      // Emptying this variable removes the scheduler rather than orphaning it.
      ATPROTO_SYNC_SCHEDULE: "0 * * * *",

      // How many repos one sweep may sweep at once, across the whole fleet.
      // BullMQ enforces it in Redis rather than per process, which is what makes
      // it survive the autoscaler moving `pipeline-worker`'s replica count
      // around underneath it. Read by the SERVER, which reconciles it onto the
      // queue at boot the same way it does the schedule.
      ATPROTO_SYNC_MAX_IN_FLIGHT: "8",

      // The same limit for the second workflow: how many recipes the fleet may
      // classify at once. It matters more here than it looks, because the
      // producer never throttles — an hourly sweep that advances a few thousand
      // sync rows enqueues a few thousand `enrich` jobs in one pass, and this is
      // the only thing that stops them crowding out everything else on the fleet.
      //
      // Read by the SERVER, like the one above: `reconcile.ts` and `/workflows`
      // are the only readers of a workflow's `globalConcurrency`, so setting it
      // on `pipeline-worker` would be a variable nothing reads. There is no
      // RECIPE_ENRICHMENT_SCHEDULE to go with it: backfill is a deliberate act
      // (plan D15), reached with POST /jobs/recipe-enrichment.
      RECIPE_ENRICHMENT_MAX_IN_FLIGHT: "16",

      // --- workflow: recipe-enrichment, LLM second opinion --------------------
      // The `llm-enrich` step (services/pipeline/src/workflows/recipe-enrichment/
      // llm/). Read by the WORKER, which is the only process that ever calls a
      // model — the same set is on `pipeline` so a `run:once` from that
      // container behaves identically instead of silently skipping.
      //
      // FAIL-CLOSED, twice over. `LLM_ENRICHMENT_ENABLED` is left UNSET here on
      // purpose: unset means "defer to the PostHog flag", and the flag
      // (`llm-enrichment-enabled`) starts at 0% rollout, so landing this deploy
      // spends nothing. Setting it to "true" here would bypass the flag for the
      // whole corpus in one apply — the override exists for dev and emergencies,
      // not for rollout. Ratchet the flag in PostHog instead.
      LLM_ENRICHMENT_PROVIDER: "moonshot",
      // No default in code (llm plan §6.1): Moonshot renames models, and a wrong
      // id should be a runtime error someone reads at deploy rather than a
      // constant that quietly rots in the source tree. Verify against
      // platform.moonshot.ai before changing it.
      LLM_ENRICHMENT_MODEL: "kimi-k2-0905-preview",
      MOONSHOT_BASE_URL: "https://api.moonshot.ai/v1",

      // PostHog, for the flag, the prompt and `$ai_generation` capture. Same
      // project as web's — the gate and the ingestion host are the same
      // variables, read by the pipeline's own posthog-node client
      // (llm/posthog.ts, which copies services/web/src/lib/posthog-server.ts).
      POSTHOG_ENABLED: "true",
      POSTHOG_PROJECT_TOKEN: posthogProjectToken,
      POSTHOG_HOST: "https://us.i.posthog.com",
      // The prompts API is the odd one out: @posthog/ai's `Prompts` client
      // authenticates with a PERSONAL api key against the APP host, and uses
      // the project TOKEN above to select the project — not the project token
      // against the ingestion host (llm plan §5.2).
      //
      // POSTHOG_PROJECT_ID is deliberately NOT set: nothing reads it. The
      // hand-rolled REST fetch it existed for is gone, and the official client
      // identifies the project from POSTHOG_PROJECT_TOKEN. The id (538428, the
      // "Buttery" project) is still what a human needs for the §5 PostHog-side
      // setup — it just is not a variable this service consumes.

      // MOONSHOT_API_KEY and POSTHOG_PERSONAL_API_KEY are deliberately NOT
      // declared here, for the same reason RAILWAY_API_TOKEN is not (see the
      // autoscaler block): IaC cannot mint either, and a declared-but-empty
      // variable would clobber a hand-set one on the next apply. Set them on
      // both services in the dashboard — the personal key needs exactly the
      // `llm_prompt:read` scope. Until MOONSHOT_API_KEY exists the provider
      // refuses to build and the step records an error rather than guessing.
      //
      // LLM_INPUT_TOKEN_PRICE_USD / LLM_OUTPUT_TOKEN_PRICE_USD are also unset:
      // they are only needed if PostHog cannot price the Kimi model itself
      // (llm plan §5.3) — check the first real generations before setting them.

      // --- autoscaler --------------------------------------------------------
      // The loop is opt-in and OFF until a Railway API token exists.
      //
      // `RAILWAY_API_TOKEN` is deliberately NOT declared here. IaC cannot mint a
      // token, and a declared-but-empty variable would either clobber a
      // hand-set one on the next apply or need a preserve() for a value that
      // may not exist yet. Create a *project* token scoped to this environment
      // (project settings → Tokens) and set RAILWAY_API_TOKEN on this service in
      // the dashboard. Until then the fleet simply stays where it is set.
      AUTOSCALE_TARGET_SERVICE: "pipeline-worker",
      AUTOSCALE_MIN_REPLICAS: "1",
      AUTOSCALE_MAX_REPLICAS: "5",
      AUTOSCALE_BACKLOG_PER_REPLICA: "25",
      AUTOSCALE_INTERVAL_SECONDS: "60",
      AUTOSCALE_SCALE_DOWN_COOLDOWN_SECONDS: "300",
      // Flip to "true" for the first run after setting the token: the loop then
      // logs every decision it would have made without touching the fleet.
      AUTOSCALE_DRY_RUN: "false",
    },
  });

  // The consumer fleet. Stateless by construction — no HTTP, nothing kept
  // between jobs — which is the precondition for Railway adding and removing
  // replicas underneath it. A removed replica is drained rather than killed, and
  // `worker.close()` finishes its in-flight jobs before exiting.
  //
  // NOTE: `replicas` is deliberately absent. The autoscaler owns that number at
  // runtime via serviceInstanceUpdate, and declaring it here would make every
  // `railway config apply` yank the fleet back to a hardcoded count — including
  // in the middle of a backlog. The bounds live in the autoscaler's
  // AUTOSCALE_MIN/MAX_REPLICAS above, which is the only place they belong.
  //
  // No healthcheck either: there is no server to probe. Railway treats a
  // long-running process with no healthcheck path as healthy once it starts.
  const pipelineWorker = service("pipeline-worker", {
    source: github("dcousineau/buttery"),
    build: pipelineBuild,
    start: "pnpm --filter @buttery/pipeline start:worker",
    env: {
      REDIS_URL: cache.env.REDIS_URL,
      // Workflows read and write the recipe index. Private networking; web's
      // preDeploy owns the migrations, so this service ships no DDL.
      DATABASE_URL: db.env.DATABASE_URL,
      // Read by the `atproto-sync` workflow, which is the retired cron service's
      // sweep — same code, same variables, now living in @buttery/pipeline.
      // ATPROTO_PLC_URL is deliberately unset: absent, the sweep resolves DIDs
      // through plc.directory, which is what production wants.
      RELAY_URL: "https://relay1.us-east.bsky.network",
      NODE_ENV: "production",

      // --- workflow: recipe-enrichment, LLM second opinion --------------------
      // The `llm-enrich` step (services/pipeline/src/workflows/recipe-enrichment/
      // llm/). Read by the WORKER, which is the only process that ever calls a
      // model — the same set is on `pipeline` so a `run:once` from that
      // container behaves identically instead of silently skipping.
      //
      // FAIL-CLOSED, twice over. `LLM_ENRICHMENT_ENABLED` is left UNSET here on
      // purpose: unset means "defer to the PostHog flag", and the flag
      // (`llm-enrichment-enabled`) starts at 0% rollout, so landing this deploy
      // spends nothing. Setting it to "true" here would bypass the flag for the
      // whole corpus in one apply — the override exists for dev and emergencies,
      // not for rollout. Ratchet the flag in PostHog instead.
      LLM_ENRICHMENT_PROVIDER: "moonshot",
      // No default in code (llm plan §6.1): Moonshot renames models, and a wrong
      // id should be a runtime error someone reads at deploy rather than a
      // constant that quietly rots in the source tree. Verify against
      // platform.moonshot.ai before changing it.
      LLM_ENRICHMENT_MODEL: "kimi-k2-0905-preview",
      MOONSHOT_BASE_URL: "https://api.moonshot.ai/v1",

      // PostHog, for the flag, the prompt and `$ai_generation` capture. Same
      // project as web's — the gate and the ingestion host are the same
      // variables, read by the pipeline's own posthog-node client
      // (llm/posthog.ts, which copies services/web/src/lib/posthog-server.ts).
      POSTHOG_ENABLED: "true",
      POSTHOG_PROJECT_TOKEN: posthogProjectToken,
      POSTHOG_HOST: "https://us.i.posthog.com",
      // The prompts API is the odd one out: @posthog/ai's `Prompts` client
      // authenticates with a PERSONAL api key against the APP host, and uses
      // the project TOKEN above to select the project — not the project token
      // against the ingestion host (llm plan §5.2).
      //
      // POSTHOG_PROJECT_ID is deliberately NOT set: nothing reads it. The
      // hand-rolled REST fetch it existed for is gone, and the official client
      // identifies the project from POSTHOG_PROJECT_TOKEN. The id (538428, the
      // "Buttery" project) is still what a human needs for the §5 PostHog-side
      // setup — it just is not a variable this service consumes.

      // MOONSHOT_API_KEY and POSTHOG_PERSONAL_API_KEY are deliberately NOT
      // declared here, for the same reason RAILWAY_API_TOKEN is not (see the
      // autoscaler block): IaC cannot mint either, and a declared-but-empty
      // variable would clobber a hand-set one on the next apply. Set them on
      // both services in the dashboard — the personal key needs exactly the
      // `llm_prompt:read` scope. Until MOONSHOT_API_KEY exists the provider
      // refuses to build and the step records an error rather than guessing.
      //
      // LLM_INPUT_TOKEN_PRICE_USD / LLM_OUTPUT_TOKEN_PRICE_USD are also unset:
      // they are only needed if PostHog cannot price the Kimi model itself
      // (llm plan §5.3) — check the first real generations before setting them.
    },
  });

  // There is no `atproto-cron-sync` service any more. The sweep it ran hourly is
  // now the `atproto-sync` workflow, scheduled by BullMQ and drained by
  // `pipeline-worker` above — see services/pipeline/src/workflows/atproto-sync/.
  //
  // Deleting it is a DESTRUCTIVE plan item, so the apply that lands this change
  // needs `railway config apply --confirm-destructive`. Nothing is lost with it:
  // the service held no volume and no state, and its DATABASE_URL and RELAY_URL
  // moved to `pipeline-worker`. The sweep is still runnable by hand, now as
  // `pnpm --filter @buttery/pipeline sync:once`.

  return project("buttery", {
    resources: [db, cache, uploads, web, pipeline, pipelineWorker],
  });
});
