import { createFileRoute } from "@tanstack/react-router";
import { auth } from "#/lib/auth";

/**
 * The admin's better-auth endpoint. Same path as the app's (`/api/auth/*`) but
 * a different origin, a different secret, different tables and a different
 * cookie prefix — see `src/lib/auth.ts`. Nothing is shared but the shape.
 */
const handle = ({ request }: { request: Request }) => auth.handler(request);

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: handle,
      POST: handle,
    },
  },
});
