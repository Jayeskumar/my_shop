/**
 * Route contract for feature modules (ARCHITECTURE.md §16). Each feature exports
 * `routes: FeatureRoutes` from src/features/<name>/routes.tsx; app/routes.tsx mounts the groups
 * under the right guards/layouts. Every route carries a `handle`:
 *
 *   { path: 'catalog/products', handle: { title: 'nav:titles.products', permission: 'catalog.read' },
 *     lazy: page(() => import('./pages/ProductsPage')) }
 *
 * handle.permission (any-of) / feature / mode / businessTypes / platformAdmin are enforced by
 * the RouteAccess guard (403 page, upgrade page, 404 for the other deployment mode), and
 * handle.title drives the document title, breadcrumbs and the placeholder page.
 */
import type { ComponentType } from 'react'
import type { RouteObject } from 'react-router'
import type { TranslationKey } from '@/lib/i18n-resources'
import type { AccessRule } from '@/lib/permissions'

export interface KadaiRouteHandle extends AccessRule {
  /** i18n key of the page title, e.g. 'nav:titles.products'. */
  title: TranslationKey
  /** Parent crumb shown before the title (e.g. list page of a detail page). */
  parent?: { title: TranslationKey; to: string }
}

export type KadaiRoute = RouteObject & {
  handle?: KadaiRouteHandle
  children?: KadaiRoute[]
}

export interface FeatureRoutes {
  /** Inside the app shell (sidebar + top bar); needs a signed-in member of a business. */
  app?: KadaiRoute[]
  /** Signed-in member, full screen without the shell (POS counter). */
  fullscreen?: KadaiRoute[]
  /** Signed-out pages (login, signup…); signed-in users are sent to the app. */
  guest?: KadaiRoute[]
  /** No authentication at all (public invoice link, customer display window). */
  public?: KadaiRoute[]
  /** Signed in, no business needed (choose business). */
  session?: KadaiRoute[]
  /** Kadai platform administrators (cloud), inside the shell, no business needed. */
  admin?: KadaiRoute[]
}

/**
 * Code-split page loader for a route's `lazy` field:
 *   lazy: page(() => import('./pages/ProductsPage'))   // module must `export default` the page
 */
export function page(loader: () => Promise<{ default: ComponentType }>): NonNullable<RouteObject['lazy']> {
  return async () => {
    const mod = await loader()
    return { Component: mod.default }
  }
}
