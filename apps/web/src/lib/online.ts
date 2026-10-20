/**
 * Connectivity: browser online/offline events + server reachability (`GET /health/live`).
 * One shared store for the whole app: polling starts with the first subscriber, runs every 30 s
 * while reachable and every 10 s while not, and the API client reports request outcomes so a
 * failure is noticed immediately (no polling lag at the billing counter).
 */
import { useSyncExternalStore } from 'react'

export interface OnlineState {
  /** navigator.onLine (false = definitely offline; true = maybe online). */
  browserOnline: boolean
  /** Last check of the Kadai server (null = not checked yet). */
  serverReachable: boolean | null
  lastCheckedAt: number | null
}

export interface OnlineStatus extends OnlineState {
  /** Usable for server calls: browser online and the server not known to be down. */
  online: boolean
}

const HEALTH_PATH = '/health/live'
const POLL_ONLINE_MS = 30_000
const POLL_OFFLINE_MS = 10_000
const CHECK_TIMEOUT_MS = 5_000

let state: OnlineState = {
  browserOnline: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  serverReachable: null,
  lastCheckedAt: null,
}
let snapshot: OnlineStatus = toStatus(state)
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setTimeout> | null = null
let checking: Promise<boolean> | null = null
let started = false

function toStatus(s: OnlineState): OnlineStatus {
  return { ...s, online: s.browserOnline && s.serverReachable !== false }
}

function setState(patch: Partial<OnlineState>): void {
  const next = { ...state, ...patch }
  if (
    next.browserOnline === state.browserOnline &&
    next.serverReachable === state.serverReachable &&
    next.lastCheckedAt === state.lastCheckedAt
  ) {
    return
  }
  const reachabilityChanged =
    next.serverReachable !== state.serverReachable || next.browserOnline !== state.browserOnline
  state = next
  snapshot = toStatus(state)
  for (const l of [...listeners]) l()
  if (reachabilityChanged && started) schedule()
}

/** Pings the server now. Concurrent calls share one request. */
export function checkServer(): Promise<boolean> {
  checking ??= (async () => {
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)
    try {
      const origin = typeof location === 'undefined' ? 'http://localhost' : location.origin
      const response = await fetch(new URL(HEALTH_PATH, origin).toString(), {
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal,
      })
      const ok = response.ok
      setState({ serverReachable: ok, lastCheckedAt: Date.now() })
      return ok
    } catch {
      setState({ serverReachable: false, lastCheckedAt: Date.now() })
      return false
    } finally {
      clearTimeout(t)
      checking = null
    }
  })()
  return checking
}

function schedule(): void {
  if (timer) clearTimeout(timer)
  if (!started) return
  const delay = state.browserOnline && state.serverReachable !== false ? POLL_ONLINE_MS : POLL_OFFLINE_MS
  timer = setTimeout(() => {
    timer = null
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
    if (!hidden && state.browserOnline) void checkServer()
    schedule()
  }, delay)
}

function onBrowserOnline(): void {
  setState({ browserOnline: true })
  void checkServer()
}
function onBrowserOffline(): void {
  setState({ browserOnline: false })
}
function onVisible(): void {
  if (document.visibilityState === 'visible' && state.browserOnline) void checkServer()
}

function start(): void {
  if (started || typeof window === 'undefined') return
  started = true
  window.addEventListener('online', onBrowserOnline)
  window.addEventListener('offline', onBrowserOffline)
  document.addEventListener('visibilitychange', onVisible)
  void checkServer()
  schedule()
}

function stop(): void {
  if (!started) return
  started = false
  window.removeEventListener('online', onBrowserOnline)
  window.removeEventListener('offline', onBrowserOffline)
  document.removeEventListener('visibilitychange', onVisible)
  if (timer) clearTimeout(timer)
  timer = null
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  start()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) stop()
  }
}

/** Current connectivity; re-renders on change. */
export function useOnline(): OnlineStatus {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot)
}

export function getOnlineStatus(): OnlineStatus {
  return snapshot
}

/** Called by the API client when a request got no response at all. */
export function reportNetworkFailure(): void {
  if (state.serverReachable !== false) setState({ serverReachable: false, lastCheckedAt: Date.now() })
}

/** Called by the API client when a response arrived (any status). */
export function reportNetworkSuccess(): void {
  if (state.serverReachable !== true || !state.browserOnline)
    setState({ serverReachable: true, browserOnline: true, lastCheckedAt: Date.now() })
}

/** Test helper. */
export function _resetOnlineForTests(next?: Partial<OnlineState>): void {
  stop()
  listeners.clear()
  state = { browserOnline: true, serverReachable: null, lastCheckedAt: null, ...next }
  snapshot = toStatus(state)
}
