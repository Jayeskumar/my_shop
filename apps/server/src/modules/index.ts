/**
 * Business module registry (ARCHITECTURE.md §3.1, §7.1 step 7). Pre-wired: every module is listed
 * here once; module owners only edit their own folder.
 *
 * Each module plugin is registered in its own encapsulated scope (its hooks/decorators do not
 * leak to other modules) under the scope prefix, and its routes are tagged with the module name
 * for the OpenAPI document.
 */
import type { FastifyInstance } from 'fastify'
import { ROUTE_SCOPE_PREFIX } from '@kadai/shared/api/common'
import type { KadaiPlugin } from '../core/http'
import { accountingModule } from './accounting'
import { authModule } from './auth'
import { catalogModule } from './catalog'
import { identityModule } from './identity'
import { inventoryModule } from './inventory'
import type { KadaiModule } from './module'
import { notificationsModule } from './notifications'
import { partiesModule } from './parties'
import { paymentsModule } from './payments'
import { platformModule } from './platform'
import { purchasesModule } from './purchases'
import { reportsModule } from './reports'
import { salesModule } from './sales'

export type { KadaiModule, ModuleName } from './module'
export { defineModule } from './module'

export const MODULES: readonly KadaiModule[] = [
  authModule,
  identityModule,
  catalogModule,
  partiesModule,
  inventoryModule,
  salesModule,
  paymentsModule,
  purchasesModule,
  accountingModule,
  reportsModule,
  notificationsModule,
  platformModule,
]

type Scope = 'routes' | 'publicRoutes' | 'webhooks'
const SCOPES: ReadonlyArray<[Scope, string]> = [
  ['routes', ROUTE_SCOPE_PREFIX.api],
  ['publicRoutes', ROUTE_SCOPE_PREFIX.public],
  ['webhooks', ROUTE_SCOPE_PREFIX.webhook],
]

/** Registers every module's route plugins under /api/v1, /public/v1 and /webhooks. */
export async function registerModules(
  app: FastifyInstance,
  modules: readonly KadaiModule[] = MODULES,
): Promise<void> {
  const names = new Set<string>()
  for (const m of modules) {
    if (names.has(m.name)) throw new Error(`module "${m.name}" is registered twice`)
    names.add(m.name)
  }
  for (const [scope, prefix] of SCOPES) {
    const plugins = modules.filter((m) => m[scope]).map((m) => [m.name, m[scope]!] as const)
    if (plugins.length === 0) continue
    await app.register(
      async (scoped) => {
        for (const [name, plugin] of plugins) {
          await scoped.register(async (moduleScope) => {
            moduleScope.addHook('onRoute', (opts) => {
              const schema = (opts.schema ?? {}) as { tags?: string[] }
              if (!schema.tags) opts.schema = { ...opts.schema, tags: [name] }
            })
            await moduleScope.register(plugin as KadaiPlugin)
          })
        }
      },
      { prefix },
    )
  }
}
