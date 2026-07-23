import * as z from 'zod'
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
} from 'better-auth/api'
import { setSessionCookie } from 'better-auth/cookies'
import { getAtprotoOAuthClient } from './oauth-node'
import type { BetterAuthPlugin } from 'better-auth'

/**
 * Resolve the current handle for a DID from its DID document's alsoKnownAs
 * (`at://handle`). Returns null when the doc can't be fetched — the DID
 * alone is enough to sign in.
 */
async function resolveHandleForDid(did: string): Promise<string | null> {
  try {
    let docUrl: string
    if (did.startsWith('did:plc:')) {
      docUrl = `https://plc.directory/${did}`
    } else if (did.startsWith('did:web:')) {
      const host = did.slice('did:web:'.length).split(':').join('/')
      docUrl = `https://${decodeURIComponent(host)}/.well-known/did.json`
    } else {
      return null
    }
    const res = await fetch(docUrl)
    if (!res.ok) return null
    const doc = (await res.json()) as { alsoKnownAs?: Array<string> }
    const aka = doc.alsoKnownAs?.find((a) => a.startsWith('at://'))
    return aka ? aka.slice('at://'.length) : null
  } catch {
    return null
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
    id: 'atproto',
    endpoints: {
      signInWithAtproto: createAuthEndpoint(
        '/atproto/sign-in',
        {
          method: 'POST',
          body: z.object({ handle: z.string().trim().min(1) }),
        },
        async (ctx) => {
          const client = getAtprotoOAuthClient()
          try {
            const url = await client.authorize(ctx.body.handle, {
              scope: 'atproto',
            })
            return ctx.json({ url: url.toString() })
          } catch (err) {
            ctx.context.logger.error('atproto authorize failed', err)
            throw new APIError('BAD_REQUEST', {
              message:
                err instanceof Error
                  ? err.message
                  : 'Failed to start atproto sign-in',
            })
          }
        },
      ),
      atprotoCallback: createAuthEndpoint(
        '/atproto/callback',
        { method: 'GET' },
        async (ctx) => {
          const client = getAtprotoOAuthClient()
          let did: string
          try {
            const params = new URLSearchParams(
              ctx.query as Record<string, string>,
            )
            const result = await client.callback(params)
            did = result.session.did
          } catch (err) {
            ctx.context.logger.error('atproto callback failed', err)
            throw ctx.redirect('/?auth_error=atproto')
          }

          const handle = await resolveHandleForDid(did)
          const { internalAdapter } = ctx.context

          const account = await internalAdapter.findAccountByProviderId(
            did,
            'atproto',
          )
          let user = account
            ? await internalAdapter.findUserById(account.userId)
            : null

          if (!user) {
            user = await internalAdapter.createUser({
              // better-auth requires a unique email; atproto has none, so
              // derive a non-routable placeholder from the DID.
              email: `${did.replaceAll(':', '.')}@atproto.invalid`,
              emailVerified: true,
              name: handle ?? did,
              did,
              handle,
            })
            await internalAdapter.createAccount({
              userId: user.id,
              providerId: 'atproto',
              accountId: did,
            })
          } else if (handle && user.name !== handle) {
            user = await internalAdapter.updateUser(user.id, {
              name: handle,
              handle,
            })
          }

          const session = await internalAdapter.createSession(user.id)
          await setSessionCookie(ctx, { session, user })
          throw ctx.redirect('/')
        },
      ),
    },
    hooks: {
      before: [
        {
          matcher: (context) => context.path === '/sign-out',
          handler: createAuthMiddleware(async (ctx) => {
            // Best-effort: revoke the stored atproto tokens alongside the
            // better-auth session so no orphaned PDS grants linger.
            const session = await getSessionFromCtx(ctx)
            const did = (session?.user as { did?: string } | undefined)?.did
            if (did) {
              await getAtprotoOAuthClient()
                .revoke(did)
                .catch(() => {})
            }
          }),
        },
      ],
    },
    schema: {
      user: {
        fields: {
          did: { type: 'string', required: false, unique: true, input: false },
          handle: { type: 'string', required: false, input: false },
        },
      },
      atprotoState: {
        modelName: 'atproto_oauth_state',
        fields: {
          key: { type: 'string', required: true, unique: true },
          value: { type: 'string', required: true },
          createdAt: { type: 'date', required: true },
        },
      },
      atprotoSession: {
        modelName: 'atproto_oauth_session',
        fields: {
          key: { type: 'string', required: true, unique: true },
          value: { type: 'string', required: true },
          createdAt: { type: 'date', required: true },
          updatedAt: { type: 'date', required: true },
        },
      },
    },
    rateLimit: [
      {
        pathMatcher: (path) => path === '/atproto/sign-in',
        max: 10,
        window: 60,
      },
    ],
  } satisfies BetterAuthPlugin
}
