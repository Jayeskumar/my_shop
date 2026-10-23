/**
 * List page state kept in the URL (?q=&store=&offset=…), so a refresh, the back button or a
 * shared link restores the same view. Values are strings; a value equal to its default (or '')
 * is removed from the URL. Changing anything but `offset` / `limit` goes back to the first page.
 */
import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router'

export const PAGE_SIZES = [20, 50, 100, 200] as const
export const DEFAULT_PAGE_SIZE = 50

type StateOf<K extends string> = Record<K, string> & { offset: number; limit: number }

export function useUrlState<K extends string>(
  defaults: Record<K, string>,
  options: { limit?: number } = {},
): [StateOf<K>, (patch: Partial<Record<K, string>> & { offset?: number; limit?: number }) => void] {
  const [params, setParams] = useSearchParams()
  const defaultLimit = options.limit ?? DEFAULT_PAGE_SIZE

  const state = useMemo(() => {
    const out: Record<string, string | number> = {}
    for (const [key, value] of Object.entries(defaults) as [K, string][]) {
      out[key] = params.get(key) ?? value
    }
    const offset = Number(params.get('offset') ?? 0)
    const limit = Number(params.get('limit') ?? defaultLimit)
    out.offset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0
    out.limit = (PAGE_SIZES as readonly number[]).includes(limit) ? limit : defaultLimit
    return out as StateOf<K>
    // `defaults` is a literal per page; its values are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, defaultLimit, JSON.stringify(defaults)])

  const update = useCallback(
    (patch: Partial<Record<K, string>> & { offset?: number; limit?: number }) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          let resetsPage = false
          for (const [key, value] of Object.entries(patch) as [string, unknown][]) {
            if (key === 'offset' || key === 'limit') {
              const n = Number(value)
              const isDefault = key === 'offset' ? n === 0 : n === defaultLimit
              if (isDefault) next.delete(key)
              else next.set(key, String(n))
              continue
            }
            resetsPage = true
            const fallback = (defaults as Record<string, string>)[key]
            if (value === undefined || value === '' || value === fallback) next.delete(key)
            else next.set(key, String(value))
          }
          if (resetsPage && !('offset' in patch)) next.delete('offset')
          return next
        },
        { replace: true },
      )
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setParams, defaultLimit, JSON.stringify(defaults)],
  )

  return [state, update]
}

/** Comma list in a URL value → array (empty string → []). */
export function splitList(value: string): string[] {
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
}
