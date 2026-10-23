/** Product names (UI language) for a list of ids — one GET /products?ids= call, cached. */
import { catalogRoutes } from '@kadai/shared/api/catalog'
import { useMemo } from 'react'
import { localizedName } from '@/lib/i18n'
import { useRouteQuery } from '@/lib/query'

export function useProductNames(ids: readonly string[]): {
  names: Map<string, string>
  loading: boolean
} {
  const sorted = useMemo(() => [...new Set(ids)].sort(), [ids])
  const q = useRouteQuery(
    catalogRoutes.listProducts,
    { query: { ids: sorted, limit: Math.min(200, Math.max(1, sorted.length)) } },
    { enabled: sorted.length > 0, staleTime: 60_000 },
  )
  const names = useMemo(
    () => new Map((q.data?.data ?? []).map((p) => [p.id, localizedName(p.name, p.name_ta)])),
    [q.data],
  )
  return { names, loading: q.isPending && sorted.length > 0 }
}
