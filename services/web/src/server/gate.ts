import { createServerFn } from "@tanstack/react-start";
import type { GateState } from "#/lib/api/types";

/**
 * Post-login access gate, backed by the PostHog `invited` feature flag. Every
 * authenticated page renders through this: a signed-in user whose `invited` flag
 * is off sees the waitlist screen instead of the app (see `src/routes/__root.tsx`).
 *
 * `authed` is false for signed-out visitors — the gate never applies to them, so
 * marketing / login / public share pages render normally. Only a signed-in but
 * not-invited caller is `{ authed: true, invited: false }`.
 *
 * In dev/test the flag is not consulted at all and every signed-in caller is
 * invited — see {@link import("./posthog-server").isInvited}.
 *
 * Lives under `src/server/` (it moved there with the offline plan's §4.3 port
 * boundary): it is a `createServerFn` with a dynamic `import()` prologue, which is
 * server business logic by the AGENTS.md convention, not a shared client util.
 *
 * The `posthog-node` SDK and the server-session helper are imported dynamically
 * inside the handler so this module stays browser-safe: `getGateState` is pulled
 * into the client bundle, but neither the SDK nor `auth.api` ever runs there.
 */

export type { GateState };

export const getGateState = createServerFn({ method: "GET" }).handler(async (): Promise<GateState> => {
  const { getServerSession } = await import("#/server/household/session");
  const session = await getServerSession();
  const did = session?.user.did;
  if (!did) return { authed: false, invited: false };

  const { isInvited, identify } = await import("#/lib/posthog-server");
  const handle = session.user.handle ?? undefined;
  const personProperties = handle ? { handle } : undefined;
  // Evaluate the flag and durably attach the handle in parallel; both key on the
  // DID so PostHog stays filterable by handle instead of the opaque DID alone.
  const [invited] = await Promise.all([isInvited(did, personProperties), handle ? identify(did, { handle }) : Promise.resolve()]);
  return { authed: true, invited };
});
