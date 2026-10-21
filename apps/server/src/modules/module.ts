/**
 * Business module definition (ARCHITECTURE.md §3.1). Each module folder exports one definition
 * from its index.ts; modules/index.ts registers them all:
 *
 *   routes        → under /api/v1     (auth required by default; `config: { public: true }` opts out)
 *   publicRoutes  → under /public/v1  (no auth; rate limited per IP)
 *   webhooks      → under /webhooks   (no auth; verify signatures with `req.rawBody`)
 *   cliCommands   → extra `cli <name>` subcommands (e.g. platform's `backup`)
 *
 * Jobs are declared separately in modules/<m>/jobs.ts (collected by jobs/registry.ts) so the
 * worker does not depend on route code.
 */
import type { CliCommand } from '../cli/types'
import type { KadaiPlugin } from '../core/http'

export const MODULE_NAMES = [
  'auth',
  'identity',
  'catalog',
  'parties',
  'inventory',
  'sales',
  'payments',
  'purchases',
  'accounting',
  'reports',
  'notifications',
  'platform',
  'licensing',
  'onprem',
] as const
export type ModuleName = (typeof MODULE_NAMES)[number]

export interface KadaiModule {
  name: ModuleName
  routes?: KadaiPlugin
  publicRoutes?: KadaiPlugin
  webhooks?: KadaiPlugin
  cliCommands?: Readonly<Record<string, CliCommand>>
}

/** Identity helper for module definitions (keeps the literal type). */
export function defineModule<const M extends KadaiModule>(module: M): M {
  return module
}
