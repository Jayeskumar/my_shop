/**
 * Regenerates src/db/schema.generated.ts from the migrations (ARCHITECTURE.md §6.4):
 *
 *   1. (re)creates a scratch database (KADAI_CODEGEN_DB, default `kadai_codegen`) with the owner
 *      role from DATABASE_SYSTEM_URL,
 *   2. applies every migration with the real migrator,
 *   3. runs kysely-codegen against it (public schema only, `date` as string),
 *   4. post-processes the output to match the pg type parsers in src/db/pool.ts
 *      (int8 → number, date → string, timestamptz → Date, json/jsonb → unknown JsonValue on read and
 *      JSON text on write) and adds a header, so the output is deterministic and commit-friendly,
 *   5. drops the scratch database.
 *
 * `--check` regenerates into memory and exits 1 when the committed file is out of date (CI).
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import pg from 'pg'
import { loadConfig } from '../src/config'
import { migrate } from '../src/db/migrator'

const here = path.dirname(fileURLToPath(import.meta.url))
const OUT_FILE = path.resolve(here, '../src/db/schema.generated.ts')

function withDatabase(url: string, database: string): string {
  const u = new URL(url)
  u.pathname = `/${database}`
  return u.toString()
}

async function admin(url: string, statements: string[]): Promise<void> {
  const client = new pg.Client({ connectionString: withDatabase(url, 'postgres') })
  await client.connect()
  try {
    for (const s of statements) await client.query(s)
  } finally {
    await client.end()
  }
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(args[0] ?? cmd)} exited with ${code}`))))
  })
}

const HEADER = `/**
 * GENERATED FILE — do not edit. Regenerate with \`pnpm --filter @kadai/server db:types\`.
 *
 * Kysely table types introspected from the migrated schema (kysely-codegen), post-processed to match
 * the pg type parsers in src/db/pool.ts:
 *   int8        → number (safe-integer checked at parse time)
 *   date        → 'YYYY-MM-DD' string
 *   timestamptz → Date on read; Date or ISO string on write
 *   json/jsonb  → \`unknown\` on read (validate with zod); JSON text on write — use \`jsonb(value)\`
 *                 from src/db/json.ts so arrays are never sent as Postgres array literals
 */
`

/** Applies the type mapping; throws when kysely-codegen's output shape is not recognised. */
export function postProcess(source: string): string {
  let out = source.replace(/^\/\*\*[\s\S]*?\*\/\n+/, '')
  const replace = (re: RegExp, replacement: string, what: string): void => {
    if (!re.test(out)) throw new Error(`db-types: could not find ${what} in kysely-codegen output`)
    out = out.replace(re, replacement)
  }
  replace(
    /export type Int8 = ColumnType<[^;]+>;/,
    'export type Int8 = ColumnType<number, bigint | number, bigint | number>;',
    'the Int8 type',
  )
  replace(
    /export type Json = [^;]+;/,
    [
      '/** JSON as read from json/jsonb columns: deliberately `unknown` — validate before use. */',
      'export type JsonValue = unknown;',
      '',
      '/** json/jsonb column: read `unknown`, write JSON text (see `jsonb()` in src/db/json.ts). */',
      'export type Json = ColumnType<JsonValue, string, string>;',
    ].join('\n'),
    'the Json type',
  )
  // Drop kysely-codegen's structural JSON helper types (replaced by the unknown JsonValue above).
  out = out.replace(/export type Json(Array|Object|Primitive|Value) = [\s\S]*?;\n\n/g, (m) =>
    m.startsWith('export type JsonValue = unknown') ? m : '',
  )
  if (/export type Timestamp = /.test(out) && !/export type Timestamp = ColumnType<Date, Date \| string, Date \| string>;/.test(out)) {
    throw new Error('db-types: unexpected Timestamp mapping in kysely-codegen output')
  }
  return `${HEADER}\n${out.trimEnd()}\n`
}

async function generate(): Promise<string> {
  const config = loadConfig()
  const scratch = process.env.KADAI_CODEGEN_DB ?? 'kadai_codegen'
  if (!/^[a-z_][a-z0-9_]*$/.test(scratch)) throw new Error('KADAI_CODEGEN_DB must be a plain identifier')
  const systemUrl = config.database.systemUrl
  const scratchUrl = withDatabase(systemUrl, scratch)
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'kadai-codegen-'))
  await admin(systemUrl, [`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`, `CREATE DATABASE ${scratch}`])
  try {
    await migrate({
      connectionString: scratchUrl,
      appRole: config.database.appRole,
      logger: { info: () => undefined, warn: (m) => console.warn(`[migrate] ${m}`) },
    })
    const require = createRequire(import.meta.url)
    const pkgPath = require.resolve('kysely-codegen/package.json')
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as { bin: string | Record<string, string> }
    const binRel = typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin['kysely-codegen'] ?? Object.values(pkg.bin)[0])
    if (!binRel) throw new Error('kysely-codegen bin not found')
    const raw = path.join(tmp, 'schema.ts')
    await run(process.execPath, [
      path.resolve(path.dirname(pkgPath), binRel),
      '--dialect=postgres',
      `--url=${scratchUrl}`,
      '--default-schema=public',
      '--include-pattern=public.*',
      '--date-parser=string',
      '--log-level=warn',
      `--out-file=${raw}`,
    ])
    return postProcess(await readFile(raw, 'utf8'))
  } finally {
    await rm(tmp, { recursive: true, force: true })
    await admin(systemUrl, [`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`])
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { check: { type: 'boolean', default: false } } })
  const next = await generate()
  if (values.check) {
    const current = await readFile(OUT_FILE, 'utf8').catch(() => '')
    if (current !== next) {
      console.error('src/db/schema.generated.ts is out of date: run `pnpm --filter @kadai/server db:types`')
      process.exit(1)
    }
    console.warn('schema.generated.ts is up to date')
    return
  }
  await writeFile(OUT_FILE, next)
  console.warn(`wrote ${path.relative(process.cwd(), OUT_FILE)}`)
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
