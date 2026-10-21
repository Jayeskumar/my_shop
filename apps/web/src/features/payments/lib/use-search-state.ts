/**
 * List page state kept in the URL (?dir=&method=&from=&to=&q=&offset=&id=…), so a refresh, the
 * back button or a shared link restores the same view. Values equal to their default are left
 * out of the URL; changing a filter resets to the first page. `id` (the open detail drawer) and
 * `offset` never reset the page.
 */
import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router'

const KEEP_PAGE = new Set(['offset', 'limit', 'id'])

export function useSearchState<K extends string>(
  defaults: Readonly<Record<K, string>>,
): [Record<K, string>, (patch: Partial<Record<K, string>>) => void] {
  const [params, setParams] = useSearchParams()
  const keys = Object.keys(defaults) as K[]
  const state = useMemo(() => {
    const out = {} as Record<K, string>
    for (const key of keys) out[key] = params.get(key) ?? defaults[key]
    return out
    // `defaults` is a module constant at every call site; its keys never change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params])

  const update = useCallback(
    (patch: Partial<Record<K, string>>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          let resetPage = false
          for (const [key, value] of Object.entries(patch) as [K, string | undefined][]) {
            if (!KEEP_PAGE.has(key)) resetPage = true
            if (value === undefined || value === '' || value === defaults[key]) next.delete(key)
            else next.set(key, value)
          }
          if (resetPage && !('offset' in patch)) next.delete('offset')
          return next
        },
        { replace: true },
      )
    },
    [setParams, defaults],
  )
  return [state, update]
}

/** Non-negative integer from a URL value, else the fallback. */
export function intParam(value: string, fallback: number): number {
  const n = Number(value)
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback
}
