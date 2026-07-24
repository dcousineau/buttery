import { createFileRoute } from "@tanstack/react-router";
import { auth } from "../../../lib/auth";
import { isComingSoon } from "../../../lib/config";

// While the soft-launch gate is up, refuse auth requests at the API level —
// not only in the UI — so login stays off even to direct callers.
const handle = ({ request }: { request: Request }) => (isComingSoon() ? new Response("Not available yet", { status: 503 }) : auth.handler(request));

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: handle,
      POST: handle,
    },
  },
});
