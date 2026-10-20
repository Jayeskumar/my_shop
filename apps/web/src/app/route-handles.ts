import { useMatches, type UIMatch } from 'react-router'
import type { KadaiRouteHandle } from './route-types'

function isHandle(value: unknown): value is KadaiRouteHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as KadaiRouteHandle).title === 'string'
  )
}

/** Matched routes that carry a Kadai handle, outermost first. */
export function useRouteHandles(): { match: UIMatch; handle: KadaiRouteHandle }[] {
  const matches = useMatches()
  return matches.flatMap((match) =>
    isHandle(match.handle) ? [{ match, handle: match.handle }] : [],
  )
}

/** Handle of the deepest matched route (the current page). */
export function useCurrentHandle(): KadaiRouteHandle | null {
  const handles = useRouteHandles()
  return handles[handles.length - 1]?.handle ?? null
}
