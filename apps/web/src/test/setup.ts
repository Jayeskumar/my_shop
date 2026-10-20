import '@testing-library/jest-dom/vitest'
import 'fake-indexeddb/auto'
import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest'
import { _resetApiStateForTests } from '@/lib/api'
import { _resetAuthForTests } from '@/lib/auth'
import { initI18n, setLanguage } from '@/lib/i18n'
import { _resetOnlineForTests } from '@/lib/online'
import { storage } from '@/lib/storage'
import { server } from './msw'

// --- jsdom gaps used by Radix / cmdk / layout code -------------------------------------------
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver

if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList
}
Element.prototype.scrollIntoView ??= function scrollIntoView() {}
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.releasePointerCapture ??= () => {}
Element.prototype.setPointerCapture ??= () => {}

// Tests assert English copy unless they switch language explicitly.
initI18n('en')

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))

beforeEach(async () => {
  localStorage.clear()
  storage._resetMemory()
  _resetApiStateForTests()
  _resetAuthForTests()
  _resetOnlineForTests()
  await setLanguage('en', { persist: false })
})

afterEach(() => {
  cleanup()
  server.resetHandlers()
})

afterAll(() => server.close())
