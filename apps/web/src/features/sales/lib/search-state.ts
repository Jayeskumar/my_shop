/**
 * List page state kept in the URL (?q=&period=&status=…), so a refresh, the back button or a
 * shared link restores the same view. Every value is a string; a value equal to its default is
 * removed from the URL. Changing anything but the page (offset / limit) goes back to page 1.
 */
import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router'

export const LIST_PAGE_SIZES = [20, 50, 100, 200] as const

type PageKeys = 'offset' | 'limit'

export function useSearchState<K extends string>(
  defaults: Readonly<Record<K, string>>,
): [
  Readonly<Record<K | PageKeys, string>>,
  (patch: Partial<Record<K | PageKeys, string>>) => void,
] {
  const [params, setParams] = useSearchParams()
  const all = useMemo(
    () => ({ ...defaults, offset: '0', limit: '50' }) as Record<K | PageKeys, string>,
    // The defaults object is a module constant on every page; its identity is stable.
    [defaults],
  )

  const state = useMemo(() => {
    const out = { ...all }
    for (const key of Object.keys(all) as (K | PageKeys)[]) {
      const value = params.get(key)
      if (value !== null) out[key] = value
    }
    return out
  }, [params, all])

  const update = useCallback(
    (patch: Partial<Record<K | PageKeys, string>>) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          for (const [key, value] of Object.entries(patch) as [
            K | PageKeys,
            string | undefined,
          ][]) {
            if (value === undefined || value === all[key]) next.delete(key)
            else next.set(key, value)
          }
          const pageOnly = Object.keys(patch).every((k) => k === 'offset' || k === 'limit')
          if (!pageOnly) next.delete('offset')
          return next
        },
        { replace: true },
      )
    },
    [setParams, all],
  )

  return [state, update]
}

/** offset / limit of the state as numbers (invalid → first page of 50). */
export function pageOf(state: { offset: string; limit: string }): {
  offset: number
  limit: number
} {
  const offset = Number(state.offset)
  const limit = Number(state.limit)
  return {
    offset: Number.isSafeInteger(offset) && offset >= 0 ? offset : 0,
    limit: (LIST_PAGE_SIZES as readonly number[]).includes(limit) ? limit : 50,
  }
}

/** A value of a closed set, else the fallback. */
export function oneOf<V extends string>(value: string, options: readonly V[], fallback: V): V {
  return (options as readonly string[]).includes(value) ? (value as V) : fallback
}
