import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { requireMcpAuth } from "@better-auth/mcp";
import { auth, MCP_RESOURCE } from "../../lib/auth";
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

/** Bearer-token-gated MCP entry; unauthenticated callers get the RFC 9728 401 challenge. */
export const handleMcpRequest = requireMcpAuth(auth, (request) => mcpHandler.fetch(request), { resource: MCP_RESOURCE });
