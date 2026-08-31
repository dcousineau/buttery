import type { PostHog } from "posthog-node";
import { Prompts } from "@posthog/ai";
import fp from "fastify-plugin";
import { fetchPrompt, type PromptsClient, type ResolvedPrompt, PROMPT_CACHE_TTL_SECONDS } from "#/lib/posthog/prompt-fetch.ts";

/**
 * The service-wide PostHog surface (S1, corrected in S1a): both PostHog
 * clients the pipeline needs, decorated as one `PostHogService` because they
 * are two credentials for the same product, not two unrelated resources.
 *
 * ── Why one plugin holds two clients with two different credentials ────────
 * `client` captures events (`$ai_generation` and friends): it authenticates
 * with the PROJECT token against the INGESTION host (`POSTHOG_PROJECT_TOKEN`,
 * `POSTHOG_HOST`, default `https://us.i.posthog.com`), because an event
 * belongs to a project and is written through ingestion. `fetchPrompt` reads
 * PostHog Prompt Management, which is a workspace asset rather than an
 * event: it authenticates with a PERSONAL API key against the APP host
 * (`POSTHOG_PERSONAL_API_KEY`, scope `llm_prompt:read`, `POSTHOG_APP_HOST`,
 * default `https://us.posthog.com`), and still needs the project token to
 * select which project's prompts to read. That contrast — event vs.
 * workspace asset, project token vs. personal key, ingestion host vs. app
 * host — is exactly why both clients belong in one plugin: split across two
 * plugins, the reason they differ has nowhere to be written down.
 *
 * `client` is legitimately `null` when PostHog is not enabled
 * (`POSTHOG_ENABLED !== "true"`) or enabled but unconfigured (no
 * `POSTHOG_PROJECT_TOKEN`) — every consumer treats absence as the ordinary,
 * expected state that the source module's fail-closed design requires, not
 * as an error to throw at boot. The `Prompts` client degrades the same way:
 * `fetchPrompt` falls back to the caller's `fallbackText` whenever it is
 * unconfigured, unreachable, or too slow (see `lib/posthog/prompt-fetch.ts`).
 *
 * `posthog-node` is imported dynamically, and only when PostHog is actually
 * enabled, so that a process which never enables it (the trigger CLI, most local
 * dev, most tests) never pulls the dependency in — the same rule the source
 * module follows for the same reason. `@posthog/ai`'s `Prompts` has no such
 * gate today because it is a much lighter import; this plugin still only
 * constructs it when the personal-key credentials are present.
 *
 * What is recipe-specific — `captureEvent`'s shaping of `$ai_generation`
 * payloads — stays out of this plugin and out of `plugins/ai.ts` too; it is
 * queue-owned and lives in `queues/recipe-enrichment/lib/capture.ts`.
 *
 * Note that no client here gates anything any more: the LLM kill switch used
 * to be a PostHog flag read through this plugin and is now a plain env var
 * (`queues/recipe-enrichment/lib/gate.ts`). PostHog receives what happened;
 * it does not decide whether it happens. This plugin's job is only the two clients and
 * the one teardown hook a client actually needs.
 */
export interface PostHogService {
  /** Event capture client — project token, ingestion host. `null` when PostHog capture is disabled or unconfigured. */
  client: PostHog | null;
  /** Fetch a named PostHog-managed prompt, falling back to `fallbackText` on any failure. The `Prompts` client is built once, at plugin registration. */
  fetchPrompt(name: string, fallbackText: string): Promise<ResolvedPrompt>;
}

export default fp(
  async (fastify) => {
    const client = await buildCaptureClient(fastify.env.POSTHOG_ENABLED, fastify.env.POSTHOG_PROJECT_TOKEN, fastify.env.POSTHOG_HOST);
    const promptsClient = buildPromptsClient({
      posthogPersonalApiKey: fastify.env.POSTHOG_PERSONAL_API_KEY,
      posthogProjectToken: fastify.env.POSTHOG_PROJECT_TOKEN,
      posthogAppHost: fastify.env.POSTHOG_APP_HOST,
    });

    const posthog: PostHogService = {
      client,
      fetchPrompt: (name, fallbackText) => fetchPrompt(promptsClient, name, fallbackText),
    };

    fastify.decorate("posthog", posthog);

    // `Prompts` has no teardown of its own — only the capture client holds a
    // flush queue worth draining.
    fastify.addHook("onClose", async () => {
      await client?.shutdown();
    });
  },
  { name: "posthog", dependencies: ["env"] },
);

async function buildCaptureClient(enabled: string | undefined, token: string | undefined, host: string | undefined): Promise<PostHog | null> {
  if (enabled !== "true") return null; // dev / test / staging → total no-op
  if (!token) return null; // opted in but not configured
  const { PostHog } = await import("posthog-node");
  return new PostHog(token, {
    host: host ?? "https://us.i.posthog.com",
    // `$ai_generation` events are one-per-job, not high-frequency like a
    // browser session — flush each one promptly rather than batching on a
    // long-running worker replica that may be killed between jobs.
    flushAt: 1,
    flushInterval: 10_000,
  });
}

interface PromptsClientEnv {
  posthogPersonalApiKey: string | undefined;
  posthogProjectToken: string | undefined;
  posthogAppHost: string | undefined;
}

/** Build the `Prompts` client, or `null` when this environment is not configured for prompt management. Called once, at plugin boot. */
function buildPromptsClient(env: PromptsClientEnv): PromptsClient | null {
  if (!env.posthogPersonalApiKey || !env.posthogProjectToken) return null;
  return new Prompts({
    personalApiKey: env.posthogPersonalApiKey,
    projectApiKey: env.posthogProjectToken,
    host: env.posthogAppHost ?? "https://us.posthog.com",
    defaultCacheTtlSeconds: PROMPT_CACHE_TTL_SECONDS,
  });
}

declare module "fastify" {
  interface FastifyInstance {
    posthog: PostHogService;
  }
}
