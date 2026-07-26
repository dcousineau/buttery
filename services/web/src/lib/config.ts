import { createServerFn } from "@tanstack/react-start";

/**
 * Soft-launch gate, backed by the Railway `coming-soon` feature flag. While the
 * flag serves `true`, the app renders only the coming-soon page and the login +
 * recipe server APIs refuse requests.
 *
 * The flag is project-scoped with a single rule that serves `true` only when the
 * `environment` attribute is `production`; everywhere else it falls through to
 * the flag's `false` default.
 *
 * The `environment` attribute we pass is *not* `RAILWAY_ENVIRONMENT_NAME` alone:
 * `railway dev` / `railway run` inject the production environment's variables
 * locally (including `RAILWAY_ENVIRONMENT_NAME=production`), so the name can't
 * tell a real deployment from local dev. Deployment-runtime-only vars like
 * `RAILWAY_REPLICA_ID` / `RAILWAY_DEPLOYMENT_ID` are absent locally, so we key
 * off those — local dev reports `development` and is never gated.
 *
 * The Railway SDK is imported dynamically and read lazily so this module stays
 * browser-safe: `getComingSoon` is pulled into the client bundle, but neither
 * the SDK nor `process.env` ever runs there.
 */

/** Memoized one-shot init of the Railway flags SDK for this server process. */
let flagsInit: Promise<typeof import("railway").flags> | null = null;

/** The Railway environment this process is actually *deployed* to, or
 * `development` when running locally (even under `railway dev`, which injects
 * the production environment's vars). Presence of a deployment-runtime-only var
 * is the reliable "am I really on Railway" signal. */
function deployedEnvironment(): string {
  const onRailway = Boolean(process.env.RAILWAY_REPLICA_ID ?? process.env.RAILWAY_DEPLOYMENT_ID);
  return onRailway ? (process.env.RAILWAY_ENVIRONMENT_NAME ?? "development") : "development";
}

/** True only on the production Railway deployment. Doubles as the read fallback
 * so the gate fails safe — it stays up in production even if the flags SDK can't
 * reach Railway (e.g. no project token wired yet) and never blocks local dev. */
function isProduction(): boolean {
  return deployedEnvironment() === "production";
}

async function getFlags() {
  if (!flagsInit) {
    flagsInit = import("railway").then(async ({ flags }) => {
      // No credential (local dev): skip init entirely. Reads return their
      // fallback, so the gate is off in dev and we avoid a noisy init error.
      if (!process.env.RAILWAY_TOKEN && !process.env.RAILWAY_API_TOKEN) return flags;
      try {
        // Reads RAILWAY_TOKEN (project token) / RAILWAY_API_TOKEN + RAILWAY_PROJECT_ID.
        await flags.init();
      } catch (err) {
        console.warn("[flags] Railway feature-flag init failed; using fallbacks", err);
      }
      return flags;
    });
  }
  return flagsInit;
}

export async function isComingSoon(): Promise<boolean> {
  const flags = await getFlags();
  return flags.getBoolean("coming-soon", { environment: deployedEnvironment() }, isProduction());
}

/** Surface the soft-launch flag to the SSR / browser render. */
export const getComingSoon = createServerFn({ method: "GET" }).handler(() => isComingSoon());
