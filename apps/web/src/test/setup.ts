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

// min-width / max-width queries follow window.innerWidth (jsdom default 1024 = desktop layout);
// tests can resize with `window.innerWidth = 390`.
function evaluateMedia(query: string): boolean {
  const min = /\(min-width:\s*(\d+)px\)/.exec(query)
  const max = /\(max-width:\s*(\d+)px\)/.exec(query)
  if (min?.[1] && window.innerWidth < Number(min[1])) return false
  if (max?.[1] && window.innerWidth > Number(max[1])) return false
  return Boolean(min || max)
}
if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      get matches() {
        return evaluateMedia(query)
      },
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList
}
// Node's BroadcastChannel crosses worker threads, so parallel test files would receive each
// other's auth/display broadcasts. Use an in-thread implementation with the same semantics
// (async delivery to the other instances of the same name, never to the sender).
class ThreadLocalBroadcastChannel extends EventTarget {
  static registry = new Map<string, Set<ThreadLocalBroadcastChannel>>()
  onmessage: ((event: MessageEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent) => void) | null = null
  private closed = false
  constructor(readonly name: string) {
    super()
    const peers = ThreadLocalBroadcastChannel.registry.get(name) ?? new Set()
    peers.add(this)
    ThreadLocalBroadcastChannel.registry.set(name, peers)
  }
  postMessage(data: unknown): void {
    if (this.closed) throw new Error('BroadcastChannel is closed')
    const copy = structuredClone(data)
    for (const peer of ThreadLocalBroadcastChannel.registry.get(this.name) ?? []) {
      if (peer === this) continue
      setTimeout(() => {
        if (peer.closed) return
        const event = new MessageEvent('message', { data: copy })
        peer.onmessage?.(event)
        peer.dispatchEvent(event)
      }, 0)
    }
  }
  close(): void {
    this.closed = true
    ThreadLocalBroadcastChannel.registry.get(this.name)?.delete(this)
  }
}
globalThis.BroadcastChannel = ThreadLocalBroadcastChannel as unknown as typeof BroadcastChannel

Element.prototype.scrollIntoView ??= function scrollIntoView() {}
// jsdom has no layout; ScrollRestoration calls scrollTo on navigation.
window.scrollTo = () => {}
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
