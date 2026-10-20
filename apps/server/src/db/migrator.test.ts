import { copyFile, mkdtemp, readdir, rm, writeFile, appendFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testDatabaseUrls } from '../test/env'
import { testEnv } from '../test/helpers'
import {
  ChecksumMismatchError,
  checksumOf,
  defaultMigrationsDir,
  migrate,
  migrationStatus,
  readMigrationFiles,
} from './migrator'

// Each run gets its own throw-away database created by the owner role.
const dbName = `kadai_mig_${process.pid}_${Date.now().toString(36)}`

function urlFor(database: string): string {
  const u = new URL(testDatabaseUrls(testEnv()).systemUrl)
  u.pathname = `/${database}`
  return u.toString()
}

async function admin(sqlText: string): Promise<void> {
  const client = new pg.Client({ connectionString: urlFor('postgres') })
  await client.connect()
  try {
    await client.query(sqlText)
  } finally {
    await client.end()
  }
}

describe('migrator', () => {
  let dir: string
  const warnings: string[] = []
  const logger = { info: () => undefined, warn: (m: string) => warnings.push(m) }
  const opts = () => ({
    connectionString: urlFor(dbName),
    appRole: 'kadai_app',
    migrationsDir: dir,
    logger,
  })

  beforeAll(async () => {
    await admin(`CREATE DATABASE ${dbName}`)
    dir = await mkdtemp(path.join(os.tmpdir(), 'kadai-migrations-'))
    for (const f of await readdir(defaultMigrationsDir())) {
      if (f.endsWith('.sql'))
        await copyFile(path.join(defaultMigrationsDir(), f), path.join(dir, f))
    }
  })

  afterAll(async () => {
    await admin(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
    await rm(dir, { recursive: true, force: true })
  })

  it('applies every migration once and is idempotent on rerun', async () => {
    const files = await readMigrationFiles(dir)
    const first = await migrate(opts())
    expect(first.applied).toEqual(files.map((f) => f.name))
    const second = await migrate(opts())
    expect(second.applied).toEqual([])
    const status = await migrationStatus({ connectionString: urlFor(dbName), migrationsDir: dir })
    expect(status.every((s) => s.state === 'applied')).toBe(true)
  })

  it('applies grants for the runtime role and records checksums', async () => {
    const client = new pg.Client({ connectionString: urlFor(dbName) })
    await client.connect()
    try {
      const res = await client.query<{ name: string; checksum: string }>(
        'SELECT name, checksum FROM schema_migrations ORDER BY name',
      )
      const files = await readMigrationFiles(dir)
      expect(res.rows).toEqual(files.map((f) => ({ name: f.name, checksum: f.checksum })))
      const grant = await client.query<{ ok: boolean }>(
        "SELECT has_table_privilege('kadai_app', 'public.products', 'INSERT') AS ok",
      )
      expect(grant.rows[0]?.ok).toBe(true)
      const revoked = await client.query<{ ok: boolean }>(
        "SELECT has_table_privilege('kadai_app', 'public.auth_sessions', 'SELECT') AS ok",
      )
      expect(revoked.rows[0]?.ok).toBe(false)
    } finally {
      await client.end()
    }
  })

  it('applies a pending file that sorts before applied ones, with a warning', async () => {
    await writeFile(path.join(dir, '0099_late_band.sql'), 'CREATE TABLE zz_late (id int);\n')
    await writeFile(
      path.join(dir, '0090_parallel_band.sql'),
      'CREATE TABLE zz_parallel (id int);\n',
    )
    // Apply 0099 first (as if another module's migration had landed), then 0090 arrives.
    await rm(path.join(dir, '0090_parallel_band.sql'))
    expect((await migrate(opts())).applied).toEqual(['0099_late_band.sql'])
    await writeFile(
      path.join(dir, '0090_parallel_band.sql'),
      'CREATE TABLE zz_parallel (id int);\n',
    )
    warnings.length = 0
    const res = await migrate(opts())
    expect(res.applied).toEqual(['0090_parallel_band.sql'])
    expect(res.outOfOrder).toEqual(['0090_parallel_band.sql'])
    expect(warnings.some((w) => w.includes('out of order'))).toBe(true)
  })

  it('refuses to run when an applied migration file was modified', async () => {
    await appendFile(path.join(dir, '0099_late_band.sql'), '-- edited after apply\n')
    await expect(migrate(opts())).rejects.toBeInstanceOf(ChecksumMismatchError)
    const status = await migrationStatus({ connectionString: urlFor(dbName), migrationsDir: dir })
    expect(status.find((s) => s.name === '0099_late_band.sql')?.state).toBe('checksum_mismatch')
  })

  it('treats CRLF and LF checkouts as the same file', () => {
    expect(checksumOf('SELECT 1;\r\nSELECT 2;\r\n')).toBe(checksumOf('SELECT 1;\nSELECT 2;\n'))
  })

  it('rejects invalid file names and duplicate numbers', async () => {
    const bad = await mkdtemp(path.join(os.tmpdir(), 'kadai-bad-migrations-'))
    try {
      await writeFile(path.join(bad, '0001_a.sql'), '')
      await writeFile(path.join(bad, '0001_b.sql'), '')
      await expect(readMigrationFiles(bad)).rejects.toThrow(/Duplicate migration number/)
      await rm(path.join(bad, '0001_b.sql'))
      await writeFile(path.join(bad, 'Add-Stuff.sql'), '')
      await expect(readMigrationFiles(bad)).rejects.toThrow(/Invalid migration file name/)
    } finally {
      await rm(bad, { recursive: true, force: true })
    }
  })
})
