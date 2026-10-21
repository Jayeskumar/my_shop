/**
 * Every module's route catalogue in one map (docs/API.md). Used by the server's route
 * registration / OpenAPI tests and by cross-module contract tests. The web app imports the
 * individual `@kadai/shared/api/<module>` files instead (smaller bundles).
 */
import { accountingRoutes } from './accounting'
import { authRoutes } from './auth'
import { catalogRoutes } from './catalog'
import type { RouteDef, RouteScope } from './common'
import { identityRoutes } from './identity'
import { inventoryRoutes } from './inventory'
import { licensingPublicRoutes, licensingRoutes } from './licensing'
import { notificationsRoutes } from './notifications'
import { onpremRoutes } from './onprem'
import { partiesRoutes } from './parties'
import { paymentsRoutes } from './payments'
import { platformRoutes } from './platform'
import { purchasesRoutes } from './purchases'
import { reportsRoutes } from './reports'
import { salesRoutes } from './sales'

/**
 * Catalogue name → routes. The key is the server module that registers the catalogue
 * (`licensingPublic` is registered by the licensing module under /public/v1).
 */
export const ROUTE_CATALOGUES = {
  auth: authRoutes,
  identity: identityRoutes,
  catalog: catalogRoutes,
  parties: partiesRoutes,
  inventory: inventoryRoutes,
  sales: salesRoutes,
  payments: paymentsRoutes,
  purchases: purchasesRoutes,
  accounting: accountingRoutes,
  reports: reportsRoutes,
  notifications: notificationsRoutes,
  platform: platformRoutes,
  licensing: licensingRoutes,
  licensingPublic: licensingPublicRoutes,
  onprem: onpremRoutes,
} as const satisfies Record<string, Record<string, RouteDef>>

export type RouteCatalogueName = keyof typeof ROUTE_CATALOGUES

export interface CatalogueRoute {
  catalogue: RouteCatalogueName
  key: string
  def: RouteDef
}

/** Every catalogued route, flattened (catalogue order, then definition order). */
export function allCatalogueRoutes(): CatalogueRoute[] {
  return (
    Object.entries(ROUTE_CATALOGUES) as [RouteCatalogueName, Record<string, RouteDef>][]
  ).flatMap(([catalogue, routes]) =>
    Object.entries(routes).map(([key, def]) => ({ catalogue, key, def })),
  )
}

/** `api GET /products/:id` — the identity Fastify uses for a route (scope prefix + method + path). */
export function routeIdentity(def: Pick<RouteDef, 'scope' | 'method' | 'path'>): string {
  const scope: RouteScope = def.scope ?? 'api'
  return `${scope} ${def.method} ${def.path}`
}
