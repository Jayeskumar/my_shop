/**
 * List screen state kept in the URL (?q=&status=&sort=&offset=…), so refresh, back and shared
 * links restore the same view. Changing anything but the page resets to the first page.
 */
import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router'

export type ListParams<K extends string> = Record<K, string> & { offset: number }

export function useListParams<K extends string>(
  defaults: Record<K, string>,
): [ListParams<K>, (patch: Partial<Record<K, string>> & { offset?: number }) => void] {
  const [params, setParams] = useSearchParams()
  const keys = Object.keys(defaults) as K[]
  const state = useMemo(() => {
    const out = {} as Record<K, string>
    for (const k of keys) out[k] = params.get(k) ?? defaults[k]
    const offset = Number(params.get('offset') ?? 0)
    return { ...out, offset: Number.isSafeInteger(offset) && offset >= 0 ? offset : 0 }
    // `defaults` is a literal per screen; its keys never change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params])
  const update = useCallback(
    (patch: Partial<Record<K, string>> & { offset?: number }) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          for (const [key, value] of Object.entries(patch) as [string, string | number][]) {
            if (key === 'offset') continue
            const def = (defaults as Record<string, string>)[key]
            if (value === '' || value === def) next.delete(key)
            else next.set(key, String(value))
          }
          if (patch.offset !== undefined && patch.offset > 0)
            next.set('offset', String(patch.offset))
          else next.delete('offset')
          return next
        },
        { replace: true },
      )
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setParams],
  )
  return [state, update]
}
