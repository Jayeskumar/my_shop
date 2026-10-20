import { useSyncExternalStore } from 'react'

/** Tailwind breakpoints (min-width). */
export const BREAKPOINTS = { sm: 640, md: 768, lg: 1024, xl: 1280 } as const

function getMatch(query: string): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query).matches
    : false
}

/** Subscribes to a CSS media query. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
      const mql = window.matchMedia(query)
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    },
    () => getMatch(query),
    () => false,
  )
}

/** True from the given Tailwind breakpoint up (`useBreakpoint('md')` = tablet/desktop). */
export function useBreakpoint(bp: keyof typeof BREAKPOINTS): boolean {
  return useMediaQuery(`(min-width: ${BREAKPOINTS[bp]}px)`)
}
