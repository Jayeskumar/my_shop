/**
 * Colour theme: 'system' (default, follows prefers-color-scheme), 'light' or 'dark', saved in
 * localStorage (`kadai.theme`) and applied as the `dark` class on <html> (public/theme-init.js
 * applies it before first paint).
 */
import { useSyncExternalStore } from 'react'
import { storage } from './storage'

export type ThemePreference = 'system' | 'light' | 'dark'
const KEY = 'theme'

const isPreference = (v: unknown): v is ThemePreference => v === 'system' || v === 'light' || v === 'dark'

let preference: ThemePreference = storage.get<ThemePreference>(KEY, 'system', isPreference)
const listeners = new Set<() => void>()

function systemDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false
}

export function isDarkTheme(pref: ThemePreference = preference): boolean {
  return pref === 'dark' || (pref === 'system' && systemDark())
}

function apply(): void {
  if (typeof document === 'undefined') return
  const dark = isDarkTheme()
  const root = document.documentElement
  root.classList.toggle('dark', dark)
  root.style.colorScheme = dark ? 'dark' : 'light'
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])')
  if (meta) meta.content = dark ? '#042F2E' : '#0F766E'
}

export function getThemePreference(): ThemePreference {
  return preference
}

export function setThemePreference(next: ThemePreference): void {
  preference = next
  storage.set(KEY, next)
  apply()
  for (const l of [...listeners]) l()
}

let watching = false
/** Applies the theme and follows OS changes while preference is 'system'. Call once at start. */
export function initTheme(): void {
  apply()
  if (watching || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
  watching = true
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (preference === 'system') {
      apply()
      for (const l of [...listeners]) l()
    }
  })
}

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => preference,
    () => preference,
  )
}
