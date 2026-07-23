import { Pool } from 'pg'

// Server-only module: reads DATABASE_URL from the process environment.
// On Railway this is injected from the postgres service (see .railway/railway.ts);
// locally `railway dev` injects it, or set it in .env (see .env.example).
let pool: Pool | undefined

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set')
    }
    pool = new Pool({ connectionString })
  }
  return pool
}
