import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { requireMcpAuth } from "@better-auth/mcp";
import { auth, MCP_RESOURCE } from "../../lib/auth";
import { APP_URL } from "../../lib/atproto/oauth-node";
import { getDb } from "../../lib/db";
import { isMcpGrantActive } from "../mcp-connections";
import { skills } from "./skills";

// The 2026-07-28 MCP profile is stateless: a fresh server per request, no
// session store. `legacy: "reject"` refuses the older session-oriented protocol.
const mcpHandler = createMcpHandler(
  () => {
    const server = new McpServer({ name: "buttery", version: "0.0.0" });
    for (const register of skills) register(server);
    return server;
  },
  { legacy: "reject" },
);

/** RFC 9728 challenge for a token whose grant was withdrawn, so the client re-runs the OAuth flow. */
const revokedResponse = () =>
  new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "This connection was disconnected. Connect again to continue." }, id: null }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer error="invalid_token", error_description="grant revoked", resource_metadata="${APP_URL}/.well-known/oauth-protected-resource/mcp"`,
    },
  });

/**
 * Bearer-token-gated MCP entry; unauthenticated callers get the RFC 9728 401 challenge.
 *
 * `requireMcpAuth` only checks the JWT signature, issuer, audience and expiry,
 * so a disconnected app's access token would otherwise keep working until it
 * expires. The extra check makes "Disconnect" immediate (see mcp-connections.ts).
 */
export const handleMcpRequest = requireMcpAuth(
  auth,
  async (request, claims) => {
    if (!(await isMcpGrantActive(getDb(), claims)) || typeof claims.sub !== "string") return revokedResponse();
    // Hand the verified identity to the tools. `sub` is the signature-checked user id; tools
    // look the DID up from it and never accept an identity as an argument. The bearer token
    // itself isn't passed on (`token` is required by the type, nothing reads it).
    const clientId = typeof claims.client_id === "string" ? claims.client_id : typeof claims.azp === "string" ? claims.azp : "";
    return mcpHandler.fetch(request, { authInfo: { token: "", clientId, scopes: [], extra: { userId: claims.sub } } });
  },
  { resource: MCP_RESOURCE },
);
