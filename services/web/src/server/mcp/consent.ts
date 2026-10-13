import { createServerFn } from "@tanstack/react-start";
import * as z from "zod";

// Server half of the MCP consent screen (routes/mcp/auth.tsx). better-auth
// redirects the browser there with a signed query; the signature is the only
// proof the request came from /oauth2/authorize, so every call re-verifies it.

export type ConsentClient = { id: string; name: string | null; uri: string | null; logo: string | null };

export type ConsentContext =
  | { status: "invalid" }
  | { status: "signed-out" }
  | {
      status: "ready";
      client: ConsentClient;
      scopes: string[];
      account: { name: string; image: string | null };
      redirectHost: string | null;
    };

const queryInput = z.object({ query: z.string().max(8192) });

async function verified(query: string) {
  const { verifyOAuthQueryParams } = await import("@better-auth/oauth-provider");
  const { auth } = await import("../../lib/auth");
  const { secret } = await auth.$context;
  return (await verifyOAuthQueryParams(query.replace(/^\?/, ""), secret)) ? { auth, params: new URLSearchParams(query.replace(/^\?/, "")) } : null;
}

export const loadConsent = createServerFn({ method: "GET" })
  .validator((data: unknown) => queryInput.parse(data))
  .handler(async ({ data }): Promise<ConsentContext> => {
    const ok = await verified(data.query);
    if (!ok) return { status: "invalid" };
    const { getRequest } = await import("@tanstack/react-start/server");
    const headers = getRequest().headers;
    const session = await ok.auth.api.getSession({ headers });
    if (!session) return { status: "signed-out" };

    const clientId = ok.params.get("client_id");
    if (!clientId) return { status: "invalid" };
    const client = await ok.auth.api.getOAuthClientPublic({ headers, query: { client_id: clientId } }).catch(() => null);

    let redirectHost: string | null = null;
    try {
      const redirect = ok.params.get("redirect_uri");
      if (redirect) redirectHost = new URL(redirect).host;
    } catch {
      redirectHost = null;
    }

    return {
      status: "ready",
      client: { id: clientId, name: client?.client_name ?? null, uri: client?.client_uri ?? null, logo: client?.logo_uri ?? null },
      scopes: (ok.params.get("scope") ?? "").split(" ").filter(Boolean),
      account: { name: session.user.name, image: session.user.image ?? null },
      redirectHost,
    };
  });

export const decideConsent = createServerFn({ method: "POST" })
  .validator((data: unknown) => queryInput.extend({ accept: z.boolean() }).parse(data))
  .handler(async ({ data }): Promise<{ url: string }> => {
    const ok = await verified(data.query);
    if (!ok) throw new Error("This request expired. Start the connection again from your app.");
    const { getRequest } = await import("@tanstack/react-start/server");
    const result = await ok.auth.api.oauth2Consent({
      headers: getRequest().headers,
      body: { accept: data.accept, oauth_query: data.query.replace(/^\?/, "") },
    });
    return { url: result.url };
  });
