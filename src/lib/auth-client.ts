import { createAuthClient } from 'better-auth/react'
import { atprotoClient } from './atproto/better-auth-client-plugin'

export const authClient = createAuthClient({
  plugins: [atprotoClient()],
})
