/**
 * The register's offline catalogue: opens instantly from IndexedDB (works offline), then
 * refreshes from GET /pos/bootstrap — a full load the first time, deltas afterwards — every
 * 5 minutes, when the window regains focus and when the connection comes back.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useOnline } from '@/lib/online'
import { loadContext, syncCatalog } from '../lib/catalog'
import type { PosContext, PosRegisterScope } from '../lib/types'

export const CATALOG_REFRESH_MS = 5 * 60_000

export type CatalogStatus = 'loading' | 'ready' | 'empty' | 'error'

export interface PosCatalog {
  status: CatalogStatus
  context: PosContext | null
  syncing: boolean
  error: unknown
  /** Bumped after every successful sync (re-read cached rows). */
  revision: number
  refresh: (options?: { full?: boolean }) => Promise<PosContext | null>
}

export function usePosCatalog(scope: PosRegisterScope | null): PosCatalog {
  const { online } = useOnline()
  const [context, setContext] = useState<PosContext | null>(null)
  const [status, setStatus] = useState<CatalogStatus>('loading')
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [revision, setRevision] = useState(0)
  const running = useRef<Promise<PosContext | null> | null>(null)
  const scopeKey = scope ? `${scope.tenantId}|${scope.key}` : ''
  const scopeRef = useRef(scope)
  useEffect(() => {
    scopeRef.current = scope
  })

  const refresh = useCallback((options: { full?: boolean } = {}): Promise<PosContext | null> => {
    const s = scopeRef.current
    if (!s) return Promise.resolve(null)
    if (running.current) return running.current
    setSyncing(true)
    const work = syncCatalog(
      s.tenantId,
      s.key,
      s.registerId ? { register_id: s.registerId } : { store_id: s.storeId },
      options,
    )
      .then((ctx) => {
        setContext(ctx)
        setStatus('ready')
        setError(null)
        setRevision((r) => r + 1)
        return ctx
      })
      .catch((e: unknown) => {
        setError(e)
        setStatus((st) => (st === 'ready' ? 'ready' : 'error'))
        return null
      })
      .finally(() => {
        running.current = null
        setSyncing(false)
      })
    running.current = work
    return work
  }, [])

  // Open from the cache, then refresh.
  useEffect(() => {
    if (!scope) return
    let cancelled = false
    setStatus('loading')
    setContext(null)
    void loadContext(scope.tenantId, scope.key).then((cached) => {
      if (cancelled) return
      if (cached) {
        setContext(cached)
        setStatus('ready')
        setRevision((r) => r + 1)
      }
      void refresh().then((ctx) => {
        if (!cancelled && !ctx && !cached) setStatus('error')
      })
    })
    return () => {
      cancelled = true
    }
    // scopeKey identifies the scope by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, refresh])

  // Periodic + focus + reconnect refresh.
  useEffect(() => {
    if (!scope) return
    const timer = setInterval(() => void refresh(), CATALOG_REFRESH_MS)
    const onFocus = (): void => {
      if (document.visibilityState === 'visible') void refresh()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, refresh])

  const wasOnline = useRef(online)
  useEffect(() => {
    if (online && !wasOnline.current) void refresh()
    wasOnline.current = online
  }, [online, refresh])

  return { status, context, syncing, error, revision, refresh }
}
