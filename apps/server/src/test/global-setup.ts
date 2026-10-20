/**
 * Vitest global setup: makes sure the test database exists (created with the owner role when
 * missing), migrates it and applies the runtime role's grants — once per test run. Test files
 * then create their own tenants, so they can run in parallel without truncation.
 */
import pg from 'pg'
import { loadDotEnv } from '../config'
import { migrate } from '../db/migrator'
import { testDatabaseUrls } from './env'

async function ensureDatabase(systemUrl: string): Promise<void> {
  const url = new URL(systemUrl)
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unsafe test database name "${name}"`)
  url.pathname = '/postgres'
  const client = new pg.Client({ connectionString: url.toString() })
  await client.connect()
  try {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
    if (exists.rowCount === 0) {
      try {
        await client.query(`CREATE DATABASE ${name}`)
      } catch (err) {
        // Another test run created it concurrently.
        if ((err as { code?: string }).code !== '42P04') throw err
      }
    }
  } finally {
    await client.end()
  }
}

export default async function setup(): Promise<void> {
  loadDotEnv()
  const { systemUrl, appRole } = testDatabaseUrls()
  await ensureDatabase(systemUrl)
  await migrate({
    connectionString: systemUrl,
    appRole,
    logger: { info: () => undefined, warn: (m) => console.warn(`[test migrate] ${m}`) },
  })
}
