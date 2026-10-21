/**
 * List page state kept in the URL (?q=&filter=&sort=&offset=&limit=&tag=), so a refresh, the
 * back button or a shared link restores the same view. Changing a filter resets to page 1.
 */
import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router'

export interface ListState<F extends string> {
  q: string
  filter: F
  sort: string
  offset: number
  limit: number
  tag: string
}

const PAGE_SIZES = [20, 50, 100, 200] as const

export function useListState<F extends string>(defaults: {
  filter: F
  filters: readonly F[]
  sort: string
  sorts: readonly string[]
  limit?: number
}): [ListState<F>, (patch: Partial<ListState<F>>) => void] {
  const [params, setParams] = useSearchParams()
  const defaultLimit = defaults.limit ?? 50

  const state = useMemo<ListState<F>>(() => {
    const filter = params.get('filter')
    const sort = params.get('sort')
    const offset = Number(params.get('offset') ?? 0)
    const limit = Number(params.get('limit') ?? defaultLimit)
    return {
      q: params.get('q') ?? '',
      filter:
        filter && (defaults.filters as readonly string[]).includes(filter)
          ? (filter as F)
          : defaults.filter,
      sort: sort && defaults.sorts.includes(sort.replace(/^-/, '')) ? sort : defaults.sort,
      offset: Number.isSafeInteger(offset) && offset >= 0 ? offset : 0,
      limit: (PAGE_SIZES as readonly number[]).includes(limit) ? limit : defaultLimit,
      tag: params.get('tag') ?? '',
    }
  }, [params, defaults.filter, defaults.filters, defaults.sort, defaults.sorts, defaultLimit])

  const update = useCallback(
    (patch: Partial<ListState<F>>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          const resetsPage = 'q' in patch || 'filter' in patch || 'tag' in patch || 'sort' in patch
          for (const [key, value] of Object.entries(patch) as [keyof ListState<F>, unknown][]) {
            const isDefault =
              value === '' ||
              value === undefined ||
              (key === 'filter' && value === defaults.filter) ||
              (key === 'sort' && value === defaults.sort) ||
              (key === 'offset' && value === 0) ||
              (key === 'limit' && value === defaultLimit)
            if (isDefault) next.delete(key)
            else next.set(key, String(value))
          }
          if (resetsPage && !('offset' in patch)) next.delete('offset')
          return next
        },
        { replace: true },
      )
    },
    [setParams, defaults.filter, defaults.sort, defaultLimit],
  )

  return [state, update]
}

export const LIST_PAGE_SIZES = PAGE_SIZES
