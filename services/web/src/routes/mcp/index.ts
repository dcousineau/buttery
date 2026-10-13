import { createFileRoute } from "@tanstack/react-router";
import { handleMcpRequest } from "../../server/mcp/server";

// Stateless MCP: every JSON-RPC message is an independent POST, so GET/DELETE
// (session streams) are not supported.
const methodNotAllowed = () => new Response(null, { status: 405, headers: { Allow: "POST" } });

export const Route = createFileRoute("/mcp/")({
  server: {
    handlers: {
      POST: ({ request }) => handleMcpRequest(request),
      GET: methodNotAllowed,
      DELETE: methodNotAllowed,
    },
  },
});
