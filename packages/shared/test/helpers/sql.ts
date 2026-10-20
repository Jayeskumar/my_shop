import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../../../apps/server/migrations/', import.meta.url),
)

/** Concatenated text of every migration file (lexical order). */
export function readMigrations(): string {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(MIGRATIONS_DIR + f, 'utf8'))
    .join('\n')
}

/** Every `CHECK (col IN ('a', 'b'))` keyed by "table.column". */
export function sqlEnumChecks(sql = readMigrations()): Map<string, string[]> {
  const out = new Map<string, string[]>()
  // Strip line comments so commented examples are not parsed.
  const text = sql.replace(/--[^\n]*/g, '')
  for (const block of text.split(/CREATE TABLE /).slice(1)) {
    const table = /^(\w+)/.exec(block)?.[1]
    if (!table) continue
    const body = block.split(/;\s*\n/)[0] ?? ''
    for (const m of body.matchAll(/CHECK\s*\((\w+)\s+IN\s*\(([^)]*)\)\)/g)) {
      const values = [...(m[2] ?? '').matchAll(/'([^']*)'/g)].map((v) => v[1]!)
      out.set(`${table}.${m[1]!}`, values)
    }
  }
  return out
}
