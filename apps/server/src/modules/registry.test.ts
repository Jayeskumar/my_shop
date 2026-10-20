/**
 * Registry consistency (ARCHITECTURE.md §3.1): every module folder is registered exactly once,
 * under its own name, and matches the shared route-catalogue / web feature ownership map.
 */
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { JOB_DEFINITIONS } from '../jobs/registry'
import { MODULES } from './index'
import { MODULE_NAMES } from './module'

const here = path.dirname(fileURLToPath(import.meta.url))

describe('module registry', () => {
  it('registers every modules/<name> folder exactly once, in MODULE_NAMES order', async () => {
    const entries = await readdir(here, { withFileTypes: true })
    const folders = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
    expect([...MODULE_NAMES].sort()).toEqual(folders)
    expect(MODULES.map((m) => m.name)).toEqual([...MODULE_NAMES])
  })

  it('has a shared contract file for every module', async () => {
    const apiDir = path.resolve(here, '../../../../packages/shared/src/api')
    const files = (await readdir(apiDir)).filter((f) => f.endsWith('.ts'))
    for (const name of MODULE_NAMES) expect(files).toContain(`${name}.ts`)
  })

  it('names every job after an existing module (or core)', () => {
    const owners = new Set<string>([...MODULE_NAMES, 'core'])
    for (const job of JOB_DEFINITIONS) expect(owners).toContain(job.name.split('.')[0])
  })
})
