/**
 * Registry consistency: every feature folder is wired into the router, every sidebar item points
 * at a registered route, and an item is never shown to someone its route would turn away.
 */
import { describe, expect, it } from 'vitest'
import type { AccessRule } from '@/lib/permissions'
import { NAV } from './nav'
import type { FeatureRoutes, KadaiRoute } from './route-types'
import { FEATURES } from './routes'

const GROUPS = ['app', 'fullscreen', 'guest', 'public', 'session', 'admin'] as const

interface FlatRoute {
  path: string
  group: (typeof GROUPS)[number]
  handle: KadaiRoute['handle']
}

function flatten(routes: KadaiRoute[], group: FlatRoute['group'], base = ''): FlatRoute[] {
  return routes.flatMap((r) => {
    const path = r.index ? base || '/' : `${base}/${r.path ?? ''}`.replace(/\/+/g, '/')
    const self: FlatRoute = { path, group, handle: r.handle }
    return [self, ...flatten(r.children ?? [], group, path === '/' ? '' : path)]
  })
}

const allRoutes: FlatRoute[] = Object.values(FEATURES).flatMap((f: FeatureRoutes) =>
  GROUPS.flatMap((g) => flatten(f[g] ?? [], g)),
)

const ruleOf = (r: AccessRule | undefined) => ({
  permission: r?.permission === undefined ? [] : [r.permission].flat().slice().sort(),
  feature: r?.feature ?? null,
  mode: r?.mode ?? null,
  businessTypes: r?.businessTypes ? [...r.businessTypes].sort() : null,
  platformAdmin: r?.platformAdmin ?? false,
})

describe('route and navigation registries', () => {
  it('wires every features/<name>/routes.tsx into the router', () => {
    const files = Object.keys(import.meta.glob('../features/*/routes.tsx'))
    const names = files.map((f) => f.split('/')[2]).sort()
    expect(Object.keys(FEATURES).sort()).toEqual(names)
  })

  it('registers each route path once and gives every route a title', () => {
    const paths = allRoutes.map((r) => r.path)
    expect(paths.filter((p, i) => paths.indexOf(p) !== i)).toEqual([])
    expect(allRoutes.filter((r) => !r.handle?.title).map((r) => r.path)).toEqual([])
  })

  it('points every sidebar item at a route with the same access rule', () => {
    const items = NAV.flatMap((g) => g.items)
    expect(items.length).toBeGreaterThan(30)
    for (const item of items) {
      const route = allRoutes.find((r) => r.path === item.to)
      expect(route, `nav item ${item.id} → ${item.to}`).toBeDefined()
      expect(ruleOf(item), `access rule of nav item ${item.id}`).toEqual(ruleOf(route?.handle))
    }
    const ids = items.map((i) => i.id)
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([])
  })
})
