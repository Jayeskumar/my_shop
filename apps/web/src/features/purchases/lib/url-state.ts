/**
 * List page state kept in the URL (?q=&filter=&sort=&offset=&limit=&from=&to=&supplier_id=&store_id=),
 * so a refresh, the back button or a shared link restores the same view. Changing a filter
 * resets to page 1.
 */
import { isDateStr } from '@kadai/shared/fy'
import { isUuid } from '@kadai/shared/ids'
import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router'

export interface ListState<F extends string> {
  q: string
  filter: F
  sort: string
  offset: number
  limit: number
  from: string
  to: string
  supplier_id: string
  store_id: string
}

export const LIST_PAGE_SIZES = [20, 50, 100, 200] as const

const RESETS_PAGE = ['q', 'filter', 'sort', 'from', 'to', 'supplier_id', 'store_id'] as const

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
    const date = (k: string): string => {
      const v = params.get(k) ?? ''
      return isDateStr(v) ? v : ''
    }
    const supplier = params.get('supplier_id') ?? ''
    const store = params.get('store_id') ?? ''
    return {
      q: params.get('q') ?? '',
      filter:
        filter && (defaults.filters as readonly string[]).includes(filter)
          ? (filter as F)
          : defaults.filter,
      sort: sort && defaults.sorts.includes(sort.replace(/^-/, '')) ? sort : defaults.sort,
      offset: Number.isSafeInteger(offset) && offset >= 0 ? offset : 0,
      limit: (LIST_PAGE_SIZES as readonly number[]).includes(limit) ? limit : defaultLimit,
      from: date('from'),
      to: date('to'),
      supplier_id: isUuid(supplier) ? supplier : '',
      store_id: isUuid(store) ? store : '',
    }
  }, [params, defaults.filter, defaults.filters, defaults.sort, defaults.sorts, defaultLimit])

  const update = useCallback(
    (patch: Partial<ListState<F>>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          const resetsPage = RESETS_PAGE.some((k) => k in patch)
          for (const [k, value] of Object.entries(patch) as [keyof ListState<F>, unknown][]) {
            const isDefault =
              value === '' ||
              value === undefined ||
              (k === 'filter' && value === defaults.filter) ||
              (k === 'sort' && value === defaults.sort) ||
              (k === 'offset' && value === 0) ||
              (k === 'limit' && value === defaultLimit)
            if (isDefault) next.delete(k)
            else next.set(k, String(value))
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
