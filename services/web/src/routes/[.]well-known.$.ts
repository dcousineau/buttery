import { createFileRoute } from "@tanstack/react-router";
import { auth } from "../lib/auth";

// OAuth discovery lives at the origin root (RFC 8414 / RFC 9728), outside the
// /api/auth mount, so MCP clients can't reach it through the auth catch-all.
// better-auth's plugins answer these paths from `auth.handler` themselves:
//   /.well-known/oauth-protected-resource[/mcp]
//   /.well-known/oauth-authorization-server/api/auth
//   /.well-known/openid-configuration/api/auth
const handle = ({ request }: { request: Request }) => auth.handler(request);

export const Route = createFileRoute("/.well-known/$")({
  server: {
    handlers: {
      GET: handle,
      HEAD: handle,
    },
  },
});
