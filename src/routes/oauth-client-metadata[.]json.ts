import { createFileRoute } from '@tanstack/react-router'
import { clientMetadata } from '../lib/atproto/oauth-node'

// atproto client metadata document — its URL is the OAuth client_id in
// production (see oauth-node.ts).
export const Route = createFileRoute('/oauth-client-metadata.json')({
  server: {
    handlers: {
      GET: () => Response.json(clientMetadata),
    },
  },
})
