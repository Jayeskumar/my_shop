/**
 * Upload of the offline outbox (POST /pos/sync, ARCHITECTURE.md §12): every pending document of
 * the counter in creation order (invoices first, then credit notes — the server processes them in
 * that order, one transaction each), at most 200 of a kind per request. Per-item results update
 * the outbox rows (created / duplicate / renumbered → synced, failed → failed with the error), and
 * the series state the server returns realigns local numbering.
 */
import {
  type PosSyncResult,
  type SyncCreditNote,
  type SyncInvoice,
  type SyncItemResult,
  salesRoutes,
} from '@kadai/shared/api/sales'
import { callRoute, isApiError } from '@/lib/api'
import { type OutboxEntry, outbox } from '@/lib/offline/db'
import { reconcileSeries } from './series'

export const SYNC_BATCH_SIZE = 200

export interface SyncRunResult {
  attempted: number
  created: number
  duplicates: number
  renumbered: number
  failed: number
  results: SyncItemResult[]
  /** The request itself failed (offline, server down…): items stay queued. */
  error: unknown
}

/** Splits the queue into the next request: oldest first, up to the batch size per kind. */
export function nextBatch(pending: readonly OutboxEntry[]): {
  invoices: OutboxEntry[]
  credit_notes: OutboxEntry[]
} {
  const ordered = [...pending].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
  return {
    invoices: ordered.filter((e) => e.kind === 'invoice').slice(0, SYNC_BATCH_SIZE),
    credit_notes: ordered.filter((e) => e.kind === 'credit_note').slice(0, SYNC_BATCH_SIZE),
  }
}

/** Applies the per-item results to the outbox rows. */
export async function applySyncResults(
  sent: readonly OutboxEntry[],
  result: PosSyncResult,
): Promise<void> {
  const byRef = new Map(result.results.map((r) => [r.client_ref, r]))
  for (const entry of sent) {
    const r = byRef.get(entry.client_ref)
    if (!r) {
      await outbox.markFailed(entry.client_ref, {
        code: 'NO_RESULT',
        message: 'The server returned no result for this document',
      })
      continue
    }
    if (r.status === 'failed' || !r.id) {
      await outbox.markFailed(entry.client_ref, {
        code: r.error?.code ?? 'SYNC_FAILED',
        message: r.error?.message ?? 'Upload failed',
      })
    } else {
      await outbox.markSynced(entry.client_ref, {
        server_id: r.id,
        server_number: r.number,
        renumbered: r.status === 'renumbered',
      })
    }
  }
}

/**
 * Uploads what is pending for a counter. Never throws: a failed request leaves the documents
 * queued (`error` is set) and they are retried on the next run.
 */
export async function syncOutbox(input: {
  tenantId: string
  registerId: string
  registerKey: string
  signal?: AbortSignal
}): Promise<SyncRunResult> {
  const total: SyncRunResult = {
    attempted: 0,
    created: 0,
    duplicates: 0,
    renumbered: 0,
    failed: 0,
    results: [],
    error: null,
  }
  const tried = new Set<string>()
  // Several requests when more than a batch is waiting.
  for (let round = 0; round < 50; round++) {
    const pending = await outbox.pending(input.tenantId, input.registerId)
    // Rows already tried in this run (failed) are not resent until the next run.
    const fresh = pending.filter((e) => !tried.has(e.client_ref))
    if (fresh.length === 0) break
    const batch = nextBatch(fresh)
    const sent = [...batch.invoices, ...batch.credit_notes]
    if (sent.length === 0) break
    for (const e of sent) tried.add(e.client_ref)
    await outbox.markSyncing(sent.map((e) => e.client_ref))
    let result: PosSyncResult
    try {
      const res = await callRoute(salesRoutes.posSync, {
        body: {
          register_id: input.registerId,
          invoices: batch.invoices.map((e) => e.payload as SyncInvoice),
          credit_notes: batch.credit_notes.map((e) => e.payload as SyncCreditNote),
        },
        ...(input.signal ? { signal: input.signal } : {}),
        timeoutMs: 120_000,
      })
      result = res.data
    } catch (error) {
      // Back to the queue with the reason (a 4xx for the whole request is shown in the panel).
      const code = isApiError(error) ? error.code : 'NETWORK_ERROR'
      const message = error instanceof Error ? error.message : String(error)
      for (const e of sent) await outbox.markFailed(e.client_ref, { code, message })
      total.error = error
      return total
    }
    await applySyncResults(sent, result)
    await reconcileSeries(input.tenantId, input.registerKey, result.series)
    total.attempted += sent.length
    total.created += result.created
    total.duplicates += result.duplicates
    total.renumbered += result.renumbered
    total.failed += result.failed
    total.results.push(...result.results)
  }
  return total
}

/** Outbox errors that a retry cannot fix (shown as "needs attention"). */
export function isConnectivityError(code: string | undefined): boolean {
  return code === 'NETWORK_ERROR' || code === 'TIMEOUT' || code === 'BAD_RESPONSE'
}

/** True for errors meaning "the server could not be reached" (fall back to the offline path). */
export function isOfflineError(error: unknown): boolean {
  return isApiError(error) && error.isNetworkError
}
