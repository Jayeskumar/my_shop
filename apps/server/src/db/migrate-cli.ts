/**
 * `pnpm --filter @kadai/server db:migrate [--status] [--dry-run]` (dist: `node dist/migrate.js`).
 * Uses DATABASE_SYSTEM_URL (owner role) and grants runtime privileges to DATABASE_APP_ROLE.
 */
import { parseArgs } from 'node:util'
import { ConfigError, loadConfig } from '../config'
import { formatStatus, migrate, migrationStatus } from './migrator'

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      status: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      dir: { type: 'string' },
    },
  })
  const config = loadConfig()
  const connectionString = config.database.systemUrl
  if (values.status) {
    const entries = await migrationStatus({ connectionString, migrationsDir: values.dir })
    console.warn(formatStatus(entries))
    // Exit code 2 = modified applied migration (CI / deploy gate); pending files are not an error.
    return entries.some((e) => e.state === 'checksum_mismatch') ? 2 : 0
  }
  const result = await migrate({
    connectionString,
    appRole: config.database.appRole,
    migrationsDir: values.dir,
    dryRun: values['dry-run'],
  })
  if (values['dry-run']) console.warn(`pending: ${result.applied.join(', ') || '(none)'}`)
  return 0
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof ConfigError ? err.message : err)
    process.exit(1)
  },
)
