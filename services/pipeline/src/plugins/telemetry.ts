import fp from "fastify-plugin";
import { trace } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { PostHogSpanProcessor } from "@posthog/ai/otel";

/**
 * PostHog AI observability, over OpenTelemetry — the supported path for AI SDK
 * v7, and the reason the hand-rolled `$ai_generation` builder is gone.
 *
 * ── WHY NOT `withTracing`, AND WHY NOT KEEP HAND-ROLLING ───────────────────
 *
 * `capture.ts` used to carry a comment claiming `@posthog/ai` was rejected
 * because it "pins its own OTel dependency stack". That was false —
 * `@posthog/ai/vercel`'s `withTracing` imports only `uuid` and `@posthog/core`.
 * The real blocker is narrower and harder: `withTracing` throws outright unless
 * the model reports `specificationVersion` `v2` or `v3`, and
 * `@openrouter/ai-sdk-provider@3` under `ai@7` reports **`v4`**. Its own error
 * message names the replacement — "Use @ai-sdk/otel with @posthog/ai/otel for
 * AI SDK v7 models" — and PostHog's docs say the same. So the model-wrapper
 * path is not a choice we declined; it is one this stack cannot take.
 *
 * What is left is this: register a tracer provider whose only span processor
 * ships AI spans to PostHog's OTLP endpoint, and let the AI SDK emit the spans.
 * PostHog turns `gen_ai.*` spans into `$ai_generation` events server-side, so
 * the events look identical to the ones the native SDK wrappers produce — and
 * nothing in this repo has to know their shape any more.
 *
 * ── `BasicTracerProvider`, NOT `NodeSDK` ───────────────────────────────────
 *
 * Measured, not assumed, and it cost an afternoon: `NodeSDK` constructed with
 * `{ spanProcessors: [...] }` and started produced spans that were genuinely
 * recording (`SpanImpl`, `isRecording() === true`) and exported **none** of
 * them. The obvious suspect — two copies of `@opentelemetry/sdk-trace-base`,
 * so that the processor class was from a different module instance than the
 * provider used — was checked and refuted: resolving that package from here
 * and from inside `@opentelemetry/sdk-node` returns the same path. Swapping
 * `NodeSDK` for `BasicTracerProvider` with the identical processor exported
 * immediately. `NodeSDK` registers a provider but does not wire a
 * caller-supplied `spanProcessors` array on this version.
 *
 * That turned out to be the better shape anyway. `NodeSDK` exists to bootstrap
 * auto-instrumentation, metrics and logs — a whole observability stack this
 * service does not want. All we need is one provider and one processor.
 *
 * ── A PLUGIN, NOT AN ENTRYPOINT IMPORT ─────────────────────────────────────
 *
 * The usual OTel advice is to bootstrap before anything else imports the
 * instrumented library, which would mean a `--import` flag or a side-effecting
 * import at the top of `server.ts`, `worker.ts` and `cli/trigger.ts`. Not
 * needed here, because of when the AI call actually happens: `generateText`
 * runs inside a BullMQ job, long after `buildApp()` has finished. The provider
 * only has to be registered before the first SPAN, not before the first
 * import, and the per-call integration in `queues/recipe-enrichment/index.ts`
 * constructs its tracer at call time. Verified: registering the provider after
 * `ai` is already imported still captures every span.
 *
 * So it is a plugin, which buys the repo's own idioms — one shutdown path
 * through `onClose`, config from `fastify.env`, no launch command to keep in
 * sync across Railway, `process-compose` and `package.json`.
 *
 * ── FAIL-CLOSED, LIKE EVERY OTHER POSTHOG SURFACE ──────────────────────────
 *
 * No `POSTHOG_ENABLED=true`, or no project token, and this plugin registers
 * nothing at all: no provider, no processor, no exporter, no background timer.
 * The AI SDK then emits spans into the API's default no-op tracer and the job
 * is unaffected. That matches `plugins/posthog.ts`, which returns a `null`
 * client rather than throwing, and it is why a dev machine or a test run pays
 * nothing for this module existing.
 */

/** Names the service in every exported span, so PostHog can tell the worker fleet's traces from anything else that ever ships to this project. */
const SERVICE_NAME = "buttery-pipeline";

export interface TelemetryService {
  /**
   * Whether a provider was actually registered. `false` is the normal state in
   * dev and test — read it to decide whether to bother building per-call
   * telemetry options, not to decide whether the job may run.
   */
  readonly enabled: boolean;
  /**
   * Push any batched spans to PostHog now.
   *
   * Load-bearing on a worker: `PostHogSpanProcessor` batches, and a Railway
   * replica scaled down mid-drain would otherwise lose the generations for the
   * jobs it just finished — the exact jobs someone is most likely to be
   * looking for. Wired into `onClose` below rather than into `worker.ts`'s
   * signal handler so there is one shutdown path, not two.
   */
  forceFlush(): Promise<void>;
}

declare module "fastify" {
  interface FastifyInstance {
    telemetry: TelemetryService;
  }
}

export default fp(
  (fastify) => {
    const enabled = fastify.env.POSTHOG_ENABLED === "true" && Boolean(fastify.env.POSTHOG_PROJECT_TOKEN);

    if (!enabled) {
      fastify.decorate("telemetry", { enabled: false, forceFlush: () => Promise.resolve() } satisfies TelemetryService);
      return;
    }

    const processor = new PostHogSpanProcessor({
      projectToken: fastify.env.POSTHOG_PROJECT_TOKEN as string,
      // The INGESTION host, same as the capture client in `plugins/posthog.ts`
      // — not the app host the `Prompts` client talks to. `PostHogSpanProcessor`
      // defaults to `https://us.i.posthog.com` on its own, but passing it keeps
      // both PostHog paths reading one variable instead of one reading a
      // variable and the other a library default.
      host: fastify.env.POSTHOG_HOST ?? "https://us.i.posthog.com",
    });

    const provider = new BasicTracerProvider({
      resource: resourceFromAttributes({ "service.name": SERVICE_NAME }),
      spanProcessors: [processor],
    });

    // `provider.register()` does not exist on `BasicTracerProvider` (that is
    // `NodeTracerProvider`'s convenience method, from a package we do not
    // depend on) — setting the global directly is the same thing without it.
    trace.setGlobalTracerProvider(provider);
    fastify.log.info({ service: SERVICE_NAME }, "posthog ai telemetry registered");

    fastify.decorate("telemetry", {
      enabled: true,
      forceFlush: async () => {
        try {
          await processor.forceFlush();
        } catch (err) {
          // Telemetry must never fail a shutdown any more than it may fail a
          // job. A replica that cannot reach PostHog on its way out still has
          // to exit.
          fastify.log.warn({ err: err instanceof Error ? err.message : String(err) }, "telemetry flush failed");
        }
      },
    } satisfies TelemetryService);

    fastify.addHook("onClose", async () => {
      await fastify.telemetry.forceFlush();
      await provider.shutdown().catch((err: unknown) => {
        fastify.log.warn({ err: err instanceof Error ? err.message : String(err) }, "telemetry shutdown failed");
      });
    });
  },
  { name: "telemetry", dependencies: ["env"] },
);
