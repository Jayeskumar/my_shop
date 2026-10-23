/**
 * Page state kept in the URL (?from=&to=&store=&offset=…), so a refresh, the back button or a
 * shared link restores the same view. `set` replaces history entries (filters are not steps);
 * changing anything but the page offset resets to page 1.
 */
import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router'
import { isDateStr } from '@kadai/shared/fy'
import { isUuid } from '@kadai/shared/ids'

export type UrlPatch = Record<string, string | number | boolean | null | undefined>

export function useUrlState(): {
  params: URLSearchParams
  get: (key: string) => string | null
  /** A business date param ('YYYY-MM-DD') or the fallback. */
  date: (key: string, fallback: string) => string
  /** A uuid param, else null. */
  id: (key: string) => string | null
  /** One of the allowed values, else the fallback. */
  oneOf: <T extends string>(key: string, allowed: readonly T[], fallback: T) => T
  int: (key: string, fallback: number) => number
  set: (patch: UrlPatch, options?: { push?: boolean }) => void
} {
  const [params, setParams] = useSearchParams()
  const get = useCallback((key: string) => params.get(key), [params])
  const date = useCallback(
    (key: string, fallback: string) => {
      const v = params.get(key)
      return v && isDateStr(v) ? v : fallback
    },
    [params],
  )
  const id = useCallback(
    (key: string) => {
      const v = params.get(key)
      return v && isUuid(v) ? v : null
    },
    [params],
  )
  const oneOf = useCallback(
    <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
      const v = params.get(key)
      return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
    },
    [params],
  )
  const int = useCallback(
    (key: string, fallback: number) => {
      const raw = params.get(key)
      const n = raw === null ? Number.NaN : Number(raw)
      return Number.isSafeInteger(n) && n >= 0 ? n : fallback
    },
    [params],
  )
  const set = useCallback(
    (patch: UrlPatch, options: { push?: boolean } = {}) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          for (const [key, value] of Object.entries(patch)) {
            if (value === null || value === undefined || value === '' || value === false) {
              next.delete(key)
            } else {
              next.set(key, String(value))
            }
          }
          if (!('offset' in patch) && Object.keys(patch).some((k) => k !== 'id' && k !== 'tab')) {
            next.delete('offset')
          }
          return next
        },
        { replace: !options.push },
      )
    },
    [setParams],
  )
  return useMemo(
    () => ({ params, get, date, id, oneOf, int, set }),
    [params, get, date, id, oneOf, int, set],
  )
}
