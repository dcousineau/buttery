import * as z from "zod";
import { APIError, createAuthEndpoint, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { ATPROTO_SCOPE, getAtprotoOAuthClient } from "./oauth-node";
import { didDocumentUrl } from "./endpoints";
import type { BetterAuthPlugin } from "better-auth";

const APPVIEW = "https://public.api.bsky.app";

/**
 * The `account.issuer` half of the account key better-auth 1.7 recognizes an
 * external account by (the other half is `accountId`, the DID). `local:` rather
 * than `local:oauth:` follows better-auth's own SIWE plugin: this plugin resolves
 * the identity itself instead of registering an OAuth provider with better-auth.
 * A real atproto issuer would be the entryway/PDS, which moves when an account
 * migrates hosts, while the DID never does.
 *
 * Existing rows were backfilled with this exact string by migration
 * 1787189370526_add_account_issuer — change the two together or sign-in stops
 * matching existing accounts.
 */
const ATPROTO_ACCOUNT_ISSUER = "local:atproto";

/** What we learn about an account from its DID document. Both fields are
 * best-effort — the DID alone is enough to sign in. */
interface DidIdentity {
  /** Current handle from `alsoKnownAs` (`at://handle`), or null. */
  handle: string | null;
  /** PDS service endpoint URL (`#atproto_pds`), or null. */
  pds: string | null;
}

/**
 * Resolve a DID's document and extract its current handle and PDS endpoint in
 * one fetch. Returns nulls (never throws) when the doc can't be fetched — the
 * DID alone is enough to sign in.
 */
async function resolveDidIdentity(did: string): Promise<DidIdentity> {
  try {
    const docUrl = didDocumentUrl(did);
    if (!docUrl) return { handle: null, pds: null };
    const res = await fetch(docUrl);
    if (!res.ok) return { handle: null, pds: null };
    const doc = (await res.json()) as {
      alsoKnownAs?: Array<string>;
      service?: Array<{ id: string; type: string; serviceEndpoint: string }>;
    };
    const aka = doc.alsoKnownAs?.find((a) => a.startsWith("at://"));
    const handle = aka ? aka.slice("at://".length) : null;
    const pds = doc.service?.find((s) => s.id.endsWith("#atproto_pds") || s.type === "AtprotoPersonalDataServer")?.serviceEndpoint ?? null;
    return { handle, pds };
  } catch {
    return { handle: null, pds: null };
  }
}

/**
 * Best-effort fetch of the account's profile avatar via the public Bluesky
 * appview (`app.bsky.actor.getProfile`). Returns a ready-to-use CDN image URL,
 * or null when the account has no avatar / isn't indexed / the call fails.
 * Cosmetic only — never blocks sign-in.
 */
async function fetchAvatarUrl(did: string): Promise<string | null> {
  try {
    const res = await fetch(`${APPVIEW}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`);
    if (!res.ok) return null;
    const profile = (await res.json()) as { avatar?: string };
    return profile.avatar ?? null;
  } catch {
    return null;
  }
}

/**
 * Better-auth plugin wrapping the server-side atproto OAuth client.
 *
 * `POST /atproto/sign-in` — resolves the handle's PDS, runs PAR, and returns
 * the authorization URL for the browser to redirect to.
 *
 * `GET /atproto/callback` — the OAuth redirect URI. Exchanges the code
 * (DPoP-bound), upserts the user keyed by DID, creates a better-auth
 * session, and redirects home.
 */
export const atprotoPlugin = () => {
  return {
    id: "atproto",
    endpoints: {
      signInWithAtproto: createAuthEndpoint(
        "/atproto/sign-in",
        {
          method: "POST",
          body: z.object({ handle: z.string().trim().min(1) }),
        },
        async (ctx) => {
          const client = getAtprotoOAuthClient();
          try {
            // Same scope string as the client metadata — an authorize request
            // may only narrow the registered scope, never widen it.
            const url = await client.authorize(ctx.body.handle, {
              scope: ATPROTO_SCOPE,
            });
            return ctx.json({ url: url.toString() });
          } catch (err) {
            ctx.context.logger.error("atproto authorize failed", err);
            throw new APIError("BAD_REQUEST", {
              message: err instanceof Error ? err.message : "Failed to start atproto sign-in",
            });
          }
        },
      ),
      atprotoCallback: createAuthEndpoint("/atproto/callback", { method: "GET" }, async (ctx) => {
        const client = getAtprotoOAuthClient();
        let did: string;
        try {
          const params = new URLSearchParams(ctx.query as Record<string, string>);
          const result = await client.callback(params);
          did = result.session.did;
        } catch (err) {
          ctx.context.logger.error("atproto callback failed", err);
          throw ctx.redirect("/login?auth_error=atproto");
        }

        // Resolve identity (handle + PDS) and profile avatar in parallel — both
        // best-effort and non-blocking; the DID alone is enough to sign in.
        const [{ handle, pds }, image] = await Promise.all([resolveDidIdentity(did), fetchAvatarUrl(did)]);
        const { internalAdapter } = ctx.context;

        const account = await internalAdapter.findAccountByKey({ issuer: ATPROTO_ACCOUNT_ISSUER, accountId: did });
        let user = account ? await internalAdapter.findUserById(account.userId) : null;

        if (!user) {
          user = await internalAdapter.createUser(
            {
              // better-auth requires a unique email; atproto has none, so
              // derive a non-routable placeholder from the DID.
              email: `${did.replaceAll(":", ".")}@atproto.invalid`,
              emailVerified: true,
              name: handle ?? did,
              did,
              handle,
              image,
              pds,
            },
            // Provisioning origin, recorded by better-auth's creation seam and
            // passed to any `validateUserInfo` gate. atproto sign-in is OAuth,
            // and this plugin's id is the provider it came from.
            { method: "oauth", oauth: { providerId: "atproto" } },
          );
          await internalAdapter.createAccount({
            userId: user.id,
            providerId: "atproto",
            issuer: ATPROTO_ACCOUNT_ISSUER,
            accountId: did,
          });
        } else {
          // Refresh the cached identity/profile on each login — handles change,
          // avatars change, accounts migrate PDS. Only write changed fields
          // (and never null out a good cached value with a failed lookup).
          // The adapter's user type is the base better-auth shape; the atproto
          // plugin's custom columns (handle/pds) aren't reflected on it, so read
          // them through a narrowing cast (same pattern as the sign-out hook).
          const cached = user as { name: string; handle?: string | null; image?: string | null; pds?: string | null };
          const updates: { name?: string; handle?: string; image?: string; pds?: string } = {};
          if (handle && cached.name !== handle) updates.name = handle;
          if (handle && cached.handle !== handle) updates.handle = handle;
          if (image && cached.image !== image) updates.image = image;
          if (pds && cached.pds !== pds) updates.pds = pds;
          if (Object.keys(updates).length > 0) {
            user = await internalAdapter.updateUser(user.id, updates);
          }
        }

        const session = await internalAdapter.createSession(user.id);
        await setSessionCookie(ctx, { session, user });
        throw ctx.redirect("/");
      }),
    },
    hooks: {
      before: [
        {
          matcher: (context) => context.path === "/sign-out",
          handler: createAuthMiddleware(async (ctx) => {
            // Best-effort: revoke the stored atproto tokens alongside the
            // better-auth session so no orphaned PDS grants linger.
            const session = await getSessionFromCtx(ctx);
            const did = (session?.user as { did?: string } | undefined)?.did;
            if (did) {
              await getAtprotoOAuthClient()
                .revoke(did)
                .catch(() => {});
            }
          }),
        },
      ],
    },
    schema: {
      user: {
        fields: {
          did: { type: "string", required: false, unique: true, input: false },
          handle: { type: "string", required: false, input: false },
          // atproto PDS host (see migration 1785500000000_add_user_pds).
          // Server-set from the DID doc; surfaces on `session.user.pds`.
          pds: { type: "string", required: false, input: false },
        },
      },
      atprotoState: {
        modelName: "atproto_oauth_state",
        fields: {
          key: { type: "string", required: true, unique: true },
          value: { type: "string", required: true },
          createdAt: { type: "date", required: true },
        },
      },
      atprotoSession: {
        modelName: "atproto_oauth_session",
        fields: {
          key: { type: "string", required: true, unique: true },
          value: { type: "string", required: true },
          createdAt: { type: "date", required: true },
          updatedAt: { type: "date", required: true },
        },
      },
    },
    rateLimit: [
      {
        pathMatcher: (path) => path === "/atproto/sign-in",
        max: 10,
        window: 60,
      },
    ],
  } satisfies BetterAuthPlugin;
};
