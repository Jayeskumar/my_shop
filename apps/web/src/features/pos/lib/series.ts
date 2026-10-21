/**
 * Offline invoice numbering (ARCHITECTURE.md §8.1, §12). The register's series is used by this
 * device only, so the POS keeps its own copy of the series state (prefix + next number) in
 * IndexedDB and takes numbers from it atomically — in the same Dexie transaction that queues the
 * bill in the outbox — so two quick bills can never get the same number. At sync the server keeps
 * the number when it is the series' next one, else renumbers (shown in the sync panel).
 */
import { type SeriesState, formatSeriesNumber } from '@kadai/shared/api/sales'
import { fyOf } from '@kadai/shared/fy'
import {
  type NewOutboxEntry,
  type OfflineSeriesState,
  type OutboxEntry,
  meta,
  metaKeys,
  offlineDb,
  outbox,
} from '@/lib/offline/db'

function isSeriesState(v: unknown): v is OfflineSeriesState {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as OfflineSeriesState).prefix === 'string' &&
    Number.isSafeInteger((v as OfflineSeriesState).next_number) &&
    Number.isSafeInteger((v as OfflineSeriesState).padding) &&
    typeof (v as OfflineSeriesState).fy === 'string'
  )
}

export async function readSeries(
  tenantId: string,
  registerKey: string,
  docType: string,
): Promise<OfflineSeriesState | null> {
  const v = await meta.get<unknown>(metaKeys.series(tenantId, registerKey, docType))
  return isSeriesState(v) ? v : null
}

/**
 * Merges the server's series state into the local one: a new prefix / FY replaces it; otherwise
 * the higher next number wins (local is ahead while offline bills wait for upload, the server is
 * ahead after online bills).
 */
export function mergeSeries(
  local: OfflineSeriesState | null,
  server: Pick<SeriesState, 'prefix' | 'next_number' | 'padding' | 'fy'>,
): OfflineSeriesState {
  const fromServer: OfflineSeriesState = {
    prefix: server.prefix,
    next_number: server.next_number,
    padding: server.padding,
    fy: server.fy,
  }
  if (!local || local.prefix !== server.prefix || local.fy !== server.fy) return fromServer
  return { ...fromServer, next_number: Math.max(local.next_number, server.next_number) }
}

export async function reconcileSeries(
  tenantId: string,
  registerKey: string,
  server: SeriesState | null,
): Promise<void> {
  if (!server) return
  const key = metaKeys.series(tenantId, registerKey, server.doc_type)
  await offlineDb.transaction('rw', offlineDb.meta, async () => {
    const local = await readSeries(tenantId, registerKey, server.doc_type)
    await meta.set(key, mergeSeries(local, server))
  })
}

/**
 * After an online bill: the server took a number from the same series, so move the local next
 * number past it ('S1-A/2627/00042' → next 43).
 */
export async function advanceSeriesPast(
  tenantId: string,
  registerKey: string,
  docType: string,
  number: string | null,
): Promise<void> {
  if (!number) return
  const key = metaKeys.series(tenantId, registerKey, docType)
  await offlineDb.transaction('rw', offlineDb.meta, async () => {
    const local = await readSeries(tenantId, registerKey, docType)
    if (!local || !number.startsWith(local.prefix)) return
    const rest = number.slice(local.prefix.length)
    if (!/^\d+$/.test(rest)) return
    const seq = Number(rest)
    if (seq + 1 > local.next_number) await meta.set(key, { ...local, next_number: seq + 1 })
  })
}

/** The next number of a local series state, or null when it cannot be used for `date`. */
export function nextOfflineNumber(
  state: OfflineSeriesState | null,
  date: string,
  fyStartMonth: number,
): string | null {
  if (!state) return null
  // A new financial year needs the new prefix from the server: the bill is numbered at sync.
  if (fyOf(date, fyStartMonth) !== state.fy) return null
  return formatSeriesNumber(state.prefix, state.next_number, state.padding)
}

/**
 * Queues an offline bill: takes the next local number and adds the outbox row in ONE
 * transaction. `build` receives the number (null = numbered at sync) and returns the payload.
 */
export async function queueOfflineDocument(input: {
  entry: Omit<NewOutboxEntry, 'number' | 'payload'>
  docType: string | null
  date: string
  fyStartMonth: number
  registerKey: string
  build: (number: string | null) => unknown
}): Promise<OutboxEntry> {
  const { entry } = input
  return offlineDb.transaction('rw', [offlineDb.meta, offlineDb.outbox], async () => {
    const existing = await outbox.get(entry.client_ref)
    if (existing) return existing
    let number: string | null = null
    if (input.docType) {
      const key = metaKeys.series(entry.tenant_id, input.registerKey, input.docType)
      const state = await readSeries(entry.tenant_id, input.registerKey, input.docType)
      number = nextOfflineNumber(state, input.date, input.fyStartMonth)
      if (number && state) await meta.set(key, { ...state, next_number: state.next_number + 1 })
    }
    return outbox.enqueue({ ...entry, number, payload: input.build(number) })
  })
}
