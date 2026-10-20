/**
 * Core CLI commands. Modules add theirs via `cliCommands` in their module definition; cli.ts
 * merges both maps (a module may not override a core command).
 */
import { parseArgs } from 'node:util'
import { newId, normalizeIndianPhone } from '@kadai/shared'
import { loadConfig } from '../config'
import { assertPasswordPolicy, hashPassword } from '../core/passwords'
import { createDatabases } from '../db'
import { formatStatus, migrate, migrationStatus } from '../db/migrator'
import { runCleanup } from '../jobs/core-jobs'
import { runLicenseCli } from './license-cli'
import type { CliCommand } from './types'

const migrateCmd: CliCommand = {
  summary: 'Apply pending database migrations (--status to only report, --dry-run)',
  usage: 'migrate [--status] [--dry-run]',
  async run(args, io) {
    const { values } = parseArgs({ args, options: { status: { type: 'boolean' }, 'dry-run': { type: 'boolean' } } })
    const config = loadConfig()
    if (values.status) {
      const entries = await migrationStatus({ connectionString: config.database.systemUrl })
      io.out(formatStatus(entries))
      return entries.some((e) => e.state === 'checksum_mismatch') ? 2 : 0
    }
    const res = await migrate({
      connectionString: config.database.systemUrl,
      appRole: config.database.appRole,
      dryRun: values['dry-run'] ?? false,
      logger: { info: (m) => io.log(m), warn: (m) => io.log(`WARNING: ${m}`) },
    })
    if (values['dry-run']) io.out(res.applied.join('\n'))
    return 0
  },
}

const createPlatformAdmin: CliCommand = {
  summary: 'Create (or promote) a platform administrator (cloud SaaS vendor staff)',
  usage: 'create-platform-admin --name <name> (--phone <mobile> | --email <email>) [--password <pw>]  (or KADAI_ADMIN_PASSWORD)',
  async run(args, io) {
    const { values } = parseArgs({
      args,
      options: { name: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' }, password: { type: 'string' } },
    })
    const password = values.password ?? process.env.KADAI_ADMIN_PASSWORD
    if (!values.name || (!values.phone && !values.email)) {
      io.log(`usage: ${this.usage}`)
      return 64
    }
    const phone = values.phone ? normalizeIndianPhone(values.phone) : null
    if (values.phone && !phone) throw new Error('invalid Indian mobile number')
    const email = values.email?.trim().toLowerCase() ?? null
    if (password) assertPasswordPolicy(password, { phone, email, name: values.name })
    const config = loadConfig()
    const db = createDatabases(config, { applicationName: 'kadai-cli' })
    try {
      // system db: platform admins are global identities (no tenant).
      const existing = await db.systemDb
        .selectFrom('users')
        .select(['id'])
        .where((eb) => eb.or([...(phone ? [eb('phone', '=', phone)] : []), ...(email ? [eb('email', '=', email)] : [])]))
        .executeTakeFirst()
      const passwordHash = password ? await hashPassword(password) : null
      if (existing) {
        await db.systemDb
          .updateTable('users')
          .set({
            is_platform_admin: true,
            full_name: values.name,
            ...(passwordHash ? { password_hash: passwordHash, password_changed_at: new Date() } : {}),
          })
          .where('id', '=', existing.id)
          .execute()
        io.log(`promoted existing user ${existing.id} to platform admin`)
        io.out(existing.id)
      } else {
        if (!passwordHash) throw new Error('a password is required for a new user (--password or KADAI_ADMIN_PASSWORD)')
        const id = newId()
        await db.systemDb
          .insertInto('users')
          .values({ id, full_name: values.name, phone, email, password_hash: passwordHash, password_changed_at: new Date(), is_platform_admin: true, preferred_locale: 'en' })
          .execute()
        io.log(`created platform admin ${id}`)
        io.out(id)
      }
      return 0
    } finally {
      await db.destroy()
    }
  },
}

const issueLicense: CliCommand = {
  summary: 'Vendor license tool: keygen | sign | verify (see scripts/dev-keys/README.md)',
  usage: 'issue-license <keygen|sign|verify> [options]',
  run: (args, io) => runLicenseCli(args, io),
}

const cleanup: CliCommand = {
  summary: 'Run the core cleanup now (expired idempotency keys, old OTPs and sessions)',
  async run(_args, io) {
    const config = loadConfig()
    const db = createDatabases(config, { applicationName: 'kadai-cli' })
    try {
      io.out(JSON.stringify(await runCleanup(db.systemDb)))
      return 0
    } finally {
      await db.destroy()
    }
  },
}

export const CORE_COMMANDS: Readonly<Record<string, CliCommand>> = {
  migrate: migrateCmd,
  'create-platform-admin': createPlatformAdmin,
  'issue-license': issueLicense,
  cleanup,
}
