import { createFileRoute } from "@tanstack/react-router";
import { auth } from "../../../lib/auth";

const handle = ({ request }: { request: Request }) => auth.handler(request);

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: handle,
      POST: handle,
    },
  },
});
