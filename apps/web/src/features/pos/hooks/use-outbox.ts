/**
 * Offline bills of this counter: live view of the outbox (IndexedDB) and the background upload
 * (POST /pos/sync) — right after a bill is queued, when the connection returns, and every 30 s
 * while something is waiting. Results (renumbered / failed) stay visible in the sync panel.
 */
import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useEffect, useRef, useState } from 'react'
import { type OutboxEntry, offlineDb } from '@/lib/offline/db'
import { useOnline } from '@/lib/online'
import { type SyncRunResult, isConnectivityError, syncOutbox } from '../lib/sync'
import type { PosRegisterScope } from '../lib/types'

const RETRY_MS = 30_000

export interface PosOutbox {
  /** Every document of this counter still in the outbox (newest last), plus recent synced ones. */
  entries: OutboxEntry[]
  unsynced: number
  failed: number
  syncing: boolean
  lastRun: SyncRunResult | null
  lastRunAt: number | null
  syncNow: () => Promise<SyncRunResult | null>
}

export function useOutbox(scope: PosRegisterScope | null, enabled = true): PosOutbox {
  const { online } = useOnline()
  const [syncing, setSyncing] = useState(false)
  const [lastRun, setLastRun] = useState<SyncRunResult | null>(null)
  const [lastRunAt, setLastRunAt] = useState<number | null>(null)
  const running = useRef<Promise<SyncRunResult | null> | null>(null)
  const tenantId = scope?.tenantId ?? ''
  const registerId = scope?.registerId ?? null

  const entries =
    useLiveQuery(
      async () => {
        if (!tenantId || !registerId) return []
        const rows = await offlineDb.outbox
          .orderBy('seq')
          .filter((r) => r.tenant_id === tenantId && r.register_id === registerId)
          .toArray()
        // Synced rows of the last 24 hours remain visible (reprint, renumber review).
        const cutoff = new Date(Date.now() - 86_400_000).toISOString()
        return rows.filter((r) => r.status !== 'synced' || (r.synced_at ?? '') >= cutoff)
      },
      [tenantId, registerId],
      [],
    ) ?? []

  const unsynced = entries.filter((e) => e.status !== 'synced').length
  const failed = entries.filter((e) => e.status === 'failed').length
  // Rejected documents (validation…) wait for a manual retry; connectivity failures retry alone.
  const retryable = entries.filter(
    (e) =>
      e.status === 'pending' ||
      e.status === 'syncing' ||
      (e.status === 'failed' && isConnectivityError(e.last_error?.code)),
  ).length

  const scopeRef = useRef(scope)
  useEffect(() => {
    scopeRef.current = scope
  })

  const syncNow = useCallback((): Promise<SyncRunResult | null> => {
    const s = scopeRef.current
    if (!s?.registerId) return Promise.resolve(null)
    if (running.current) return running.current
    setSyncing(true)
    const work = syncOutbox({ tenantId: s.tenantId, registerId: s.registerId, registerKey: s.key })
      .then((r) => {
        setLastRun(r)
        setLastRunAt(Date.now())
        return r
      })
      .finally(() => {
        running.current = null
        setSyncing(false)
      })
    running.current = work
    return work
  }, [])

  // Upload whenever there is something to send and the server is reachable.
  useEffect(() => {
    if (!enabled || !online || retryable === 0) return
    void syncNow()
    const timer = setInterval(() => void syncNow(), RETRY_MS)
    return () => clearInterval(timer)
  }, [enabled, online, retryable, syncNow])

  return { entries, unsynced, failed, syncing, lastRun, lastRunAt, syncNow }
}
