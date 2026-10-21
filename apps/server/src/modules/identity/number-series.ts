/**
 * Document number series (docs/API.md "identity" → number series; ARCHITECTURE.md §8.1).
 *
 * Numbers are allocated only by core/numbering (nextNumber, gapless, row-locked). This module
 * lists every series of a financial year — used ones from `number_series`, unused ones with
 * `id: null` and the default prefix core/numbering would create them with — and lets an admin
 * customise them:
 *   - POST creates a series before its first document (e.g. continue the old software's numbers);
 *   - PATCH changes prefix / padding / next number: next_number only increases; the prefix of a
 *     series that already issued documents changes only with `force` (audited separately);
 *   - every result must fit the 16-character GST limit with A-Z 0-9 / - (seriesFormatIssues);
 *   - two series of the same FY never share a prefix (their numbers would collide).
 */
import type { z } from 'zod'
import {
  NumberSeriesDocTypeSchema,
  type NumberSeriesDocType,
  isFy,
  isUuid,
  newId,
} from '@kadai/shared'
import {
  GST_SERIES_DOC_TYPES,
  type NumberSeries,
  type NumberSeriesCreateSchema,
  type NumberSeriesListQuerySchema,
  type NumberSeriesUpdateSchema,
  REGISTER_SERIES_DOC_TYPES,
  formatSeriesNumber,
  seriesFormatIssues,
  seriesMaxLength,
} from '@kadai/shared/api/identity'
import { audit, diffChanges } from '../../core/audit'
import { assertNotStale, notFound, validationError } from '../../core/errors'
import { assertStoreAccess } from '../../core/http'
import { DEFAULT_PADDING, PREFIX_TEMPLATES, renderPrefix } from '../../core/numbering'
import type { Tx } from '../../db/tenant'
import { type Ctx, iso, lockKey, reasonConflict, reasonUnprocessable, tenantToday } from './common'

type ListQuery = z.output<typeof NumberSeriesListQuerySchema>
type CreateBody = z.output<typeof NumberSeriesCreateSchema>
type UpdateBody = z.output<typeof NumberSeriesUpdateSchema>

const DOC_TYPES = NumberSeriesDocTypeSchema.options

interface SeriesKey {
  store_id: string
  register_id: string | null
  doc_type: NumberSeriesDocType
  fy: string
}

const keyOf = (k: SeriesKey) => `${k.store_id}:${k.register_id ?? '-'}:${k.doc_type}:${k.fy}`

/** The default prefix template rendered for a store / register (what nextNumber would create). */
export function defaultPrefix(
  docType: NumberSeriesDocType,
  storeCode: string,
  registerCode: string | null,
  fy: string,
): string {
  const t = PREFIX_TEMPLATES[docType]
  const template = registerCode && t.register ? t.register : t.store
  return renderPrefix(template, { store: storeCode, register: registerCode, fy })
}

/** Default padding: 5, shrunk to fit the doc type's maximum length (at least 1 for display). */
export function defaultPadding(docType: NumberSeriesDocType, prefix: string): number {
  return Math.max(1, Math.min(DEFAULT_PADDING, seriesMaxLength(docType) - prefix.length))
}

async function assertValidFy(tx: Tx, ctx: Ctx, fy: string): Promise<{ startMonth: number }> {
  const cal = await tenantToday(tx, ctx)
  if (!isFy(fy, cal.fyStartMonth)) {
    throw validationError([{ path: 'fy', message: 'fy', code: 'fy' }])
  }
  return { startMonth: cal.fyStartMonth }
}

function formatIssuesOrThrow(input: {
  doc_type: NumberSeriesDocType
  prefix: string
  padding: number
  next_number: number
}): void {
  const issues = seriesFormatIssues(input)
  if (issues.length) {
    throw validationError(
      issues.map((i) => ({ path: i.path, message: i.code, code: i.code })),
      issues[0]!.code,
    )
  }
}

interface SeriesRow {
  id: string
  store_id: string
  register_id: string | null
  doc_type: string
  fy: string
  prefix: string
  next_number: number
  padding: number
  updated_at: Date
}

function toSeries(
  key: SeriesKey,
  codes: { store_code: string; register_code: string | null },
  row: Pick<SeriesRow, 'id' | 'prefix' | 'padding' | 'next_number' | 'updated_at'> | null,
): NumberSeries {
  const prefix =
    row?.prefix ?? defaultPrefix(key.doc_type, codes.store_code, codes.register_code, key.fy)
  const padding = row?.padding ?? defaultPadding(key.doc_type, prefix)
  const next = row?.next_number ?? 1
  return {
    id: row?.id ?? null,
    key: keyOf(key),
    store_id: key.store_id,
    store_code: codes.store_code,
    register_id: key.register_id,
    register_code: codes.register_code,
    doc_type: key.doc_type,
    fy: key.fy,
    prefix,
    padding,
    next_number: next,
    next: formatSeriesNumber(prefix, next, padding),
    issued_count: next - 1,
    max_length: seriesMaxLength(key.doc_type),
    is_gst_document: GST_SERIES_DOC_TYPES.includes(key.doc_type),
    updated_at: row ? iso(row.updated_at) : null,
  }
}

interface Universe {
  stores: Array<{ id: string; code: string; is_active: boolean }>
  registers: Array<{ id: string; store_id: string; code: string; is_active: boolean }>
  rows: SeriesRow[]
}

/** Stores, registers and series rows of a FY (store-scoped for scoped callers). */
async function loadUniverse(tx: Tx, ctx: Ctx, fy: string, storeId?: string): Promise<Universe> {
  const scope = storeId ? [storeId] : ctx.storeIds
  if (scope !== null && scope.length === 0) return { stores: [], registers: [], rows: [] }
  let storesQ = tx
    .selectFrom('stores')
    .select(['id', 'code', 'is_active'])
    .where('tenant_id', '=', ctx.tenantId)
  let regsQ = tx
    .selectFrom('registers')
    .select(['id', 'store_id', 'code', 'is_active'])
    .where('tenant_id', '=', ctx.tenantId)
  let rowsQ = tx
    .selectFrom('number_series')
    .select([
      'id',
      'store_id',
      'register_id',
      'doc_type',
      'fy',
      'prefix',
      'next_number',
      'padding',
      'updated_at',
    ])
    .where('tenant_id', '=', ctx.tenantId)
    .where('fy', '=', fy)
  if (scope !== null) {
    storesQ = storesQ.where('id', 'in', [...scope])
    regsQ = regsQ.where('store_id', 'in', [...scope])
    rowsQ = rowsQ.where('store_id', 'in', [...scope])
  }
  const [stores, registers, rows] = await Promise.all([
    storesQ.orderBy('code').execute(),
    regsQ.orderBy('code').execute(),
    rowsQ.execute(),
  ])
  return { stores, registers, rows }
}

/** GET /number-series — every series of the FY, used or not. */
export async function listNumberSeries(
  tx: Tx,
  ctx: Ctx,
  query: ListQuery,
): Promise<NumberSeries[]> {
  if (query.store_id) assertStoreAccess(ctx, query.store_id)
  const cal = await tenantToday(tx, ctx)
  const fy = query.fy ?? cal.fy
  await assertValidFy(tx, ctx, fy)
  const u = await loadUniverse(tx, ctx, fy, query.store_id)
  const byKey = new Map(
    u.rows.map((r) => [
      keyOf({
        store_id: r.store_id,
        register_id: r.register_id,
        doc_type: r.doc_type as NumberSeriesDocType,
        fy,
      }),
      r,
    ]),
  )
  const usedStores = new Set(u.rows.map((r) => r.store_id))
  const usedRegisters = new Set(u.rows.map((r) => r.register_id).filter((id): id is string => !!id))
  const docTypes = query.doc_type ? [query.doc_type] : DOC_TYPES
  const out: NumberSeries[] = []
  for (const store of u.stores) {
    if (!store.is_active && !usedStores.has(store.id)) continue
    const registers = u.registers.filter(
      (r) => r.store_id === store.id && (r.is_active || usedRegisters.has(r.id)),
    )
    for (const docType of docTypes) {
      const storeKey: SeriesKey = { store_id: store.id, register_id: null, doc_type: docType, fy }
      out.push(
        toSeries(
          storeKey,
          { store_code: store.code, register_code: null },
          byKey.get(keyOf(storeKey)) ?? null,
        ),
      )
      if (!REGISTER_SERIES_DOC_TYPES.includes(docType)) continue
      for (const reg of registers) {
        const regKey: SeriesKey = { store_id: store.id, register_id: reg.id, doc_type: docType, fy }
        out.push(
          toSeries(
            regKey,
            { store_code: store.code, register_code: reg.code },
            byKey.get(keyOf(regKey)) ?? null,
          ),
        )
      }
    }
  }
  return out
}

/**
 * 409 prefix_in_use when another series of the FY — existing, or the default of one not used
 * yet — would produce the same numbers.
 */
async function assertPrefixFree(tx: Tx, ctx: Ctx, fy: string, prefix: string, self: SeriesKey) {
  // Serialise prefix changes of one FY: two admins cannot both claim the same free prefix.
  await lockKey(tx, `kadai_series_prefix:${ctx.tenantId}:${fy}`)
  // The caller's scope limits what they see; the clash check must cover every store.
  const all = await loadUniverse(tx, { ...ctx, storeIds: null }, fy)
  const selfKey = keyOf(self)
  const taken = new Map<string, string>()
  for (const r of all.rows) {
    taken.set(
      keyOf({
        store_id: r.store_id,
        register_id: r.register_id,
        doc_type: r.doc_type as NumberSeriesDocType,
        fy,
      }),
      r.prefix,
    )
  }
  for (const store of all.stores) {
    for (const docType of DOC_TYPES) {
      const sk = keyOf({ store_id: store.id, register_id: null, doc_type: docType, fy })
      if (!taken.has(sk)) taken.set(sk, defaultPrefix(docType, store.code, null, fy))
      if (!REGISTER_SERIES_DOC_TYPES.includes(docType)) continue
      for (const reg of all.registers.filter((r) => r.store_id === store.id)) {
        const rk = keyOf({ store_id: store.id, register_id: reg.id, doc_type: docType, fy })
        if (!taken.has(rk)) taken.set(rk, defaultPrefix(docType, store.code, reg.code, fy))
      }
    }
  }
  for (const [key, p] of taken) {
    if (key !== selfKey && p === prefix) {
      throw reasonConflict('prefix_in_use', `Another series of ${fy} already uses "${prefix}"`, {
        key,
      })
    }
  }
}

async function codesOf(tx: Tx, ctx: Ctx, storeId: string, registerId: string | null) {
  const store = await tx
    .selectFrom('stores')
    .select(['code'])
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', storeId)
    .executeTakeFirstOrThrow()
  const register = registerId
    ? await tx
        .selectFrom('registers')
        .select(['code'])
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', '=', registerId)
        .executeTakeFirstOrThrow()
    : null
  return { store_code: store.code, register_code: register?.code ?? null }
}

/** POST /number-series — customise a series before its first document. */
export async function createNumberSeries(
  tx: Tx,
  ctx: Ctx,
  body: CreateBody,
): Promise<NumberSeries> {
  await assertValidFy(tx, ctx, body.fy)
  if (body.register_id && !REGISTER_SERIES_DOC_TYPES.includes(body.doc_type)) {
    throw validationError([
      { path: 'register_id', message: 'register_series_only', code: 'register_series_only' },
    ])
  }
  const store = isUuid(body.store_id)
    ? await tx
        .selectFrom('stores')
        .select(['id', 'code', 'is_active'])
        .where('tenant_id', '=', ctx.tenantId)
        .where('id', '=', body.store_id)
        .executeTakeFirst()
    : undefined
  if (!store) {
    throw validationError([{ path: 'store_id', message: 'store_unknown', code: 'store_unknown' }])
  }
  assertStoreAccess(ctx, store.id)
  if (!store.is_active) throw reasonUnprocessable('store_inactive', 'This store is deactivated')
  let registerCode: string | null = null
  if (body.register_id) {
    const reg = isUuid(body.register_id)
      ? await tx
          .selectFrom('registers')
          .select(['id', 'code', 'store_id', 'is_active'])
          .where('tenant_id', '=', ctx.tenantId)
          .where('id', '=', body.register_id)
          .executeTakeFirst()
      : undefined
    if (!reg) {
      throw validationError([
        { path: 'register_id', message: 'register_unknown', code: 'register_unknown' },
      ])
    }
    if (reg.store_id !== store.id) {
      throw reasonUnprocessable('register_store_mismatch', 'The counter belongs to another store')
    }
    if (!reg.is_active)
      throw reasonUnprocessable('register_inactive', 'This counter is deactivated')
    registerCode = reg.code
  }
  const key: SeriesKey = {
    store_id: store.id,
    register_id: body.register_id,
    doc_type: body.doc_type,
    fy: body.fy,
  }
  let existingQ = tx
    .selectFrom('number_series')
    .select('id')
    .where('tenant_id', '=', ctx.tenantId)
    .where('store_id', '=', store.id)
    .where('doc_type', '=', body.doc_type)
    .where('fy', '=', body.fy)
  existingQ = body.register_id
    ? existingQ.where('register_id', '=', body.register_id)
    : existingQ.where('register_id', 'is', null)
  const existing = await existingQ.executeTakeFirst()
  if (existing) {
    throw reasonConflict('series_exists', 'This series already exists; edit it instead', {
      id: existing.id,
    })
  }
  const prefix = body.prefix ?? defaultPrefix(body.doc_type, store.code, registerCode, body.fy)
  const padding = body.padding ?? defaultPadding(body.doc_type, prefix)
  formatIssuesOrThrow({ doc_type: body.doc_type, prefix, padding, next_number: body.next_number })
  await assertPrefixFree(tx, ctx, body.fy, prefix, key)
  const id = newId()
  const row = await tx
    .insertInto('number_series')
    .values({
      id,
      tenant_id: ctx.tenantId,
      store_id: store.id,
      register_id: body.register_id,
      doc_type: body.doc_type,
      fy: body.fy,
      prefix,
      padding,
      next_number: body.next_number,
    })
    .returning(['id', 'prefix', 'padding', 'next_number', 'updated_at'])
    .executeTakeFirstOrThrow()
  const series = toSeries(key, { store_code: store.code, register_code: registerCode }, row)
  await audit(tx, ctx, {
    action: 'number_series.create',
    entity_type: 'number_series',
    entity_id: id,
    summary: `Number series ${body.doc_type} ${body.fy} set up: next ${series.next}`,
    changes: { prefix, padding, next_number: body.next_number, key: series.key },
  })
  return series
}

/** PATCH /number-series/:id. */
export async function updateNumberSeries(
  tx: Tx,
  ctx: Ctx,
  id: string,
  body: UpdateBody,
): Promise<NumberSeries> {
  if (!isUuid(id)) throw notFound('number series', id)
  // Same row lock as nextNumber: no document can take a number while the series changes.
  const row = await tx
    .selectFrom('number_series')
    .select([
      'id',
      'store_id',
      'register_id',
      'doc_type',
      'fy',
      'prefix',
      'next_number',
      'padding',
      'updated_at',
    ])
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst()
  if (!row) throw notFound('number series', id)
  assertStoreAccess(ctx, row.store_id)
  assertNotStale(row.updated_at, body.if_updated_at, 'number series', id)
  const docType = row.doc_type as NumberSeriesDocType
  const key: SeriesKey = {
    store_id: row.store_id,
    register_id: row.register_id,
    doc_type: docType,
    fy: row.fy,
  }
  const issued = row.next_number - 1
  const prefix = body.prefix ?? row.prefix
  const padding = body.padding ?? row.padding
  const nextNumber = body.next_number ?? row.next_number
  const prefixChange = prefix !== row.prefix
  if (prefixChange && issued > 0 && !body.force) {
    throw reasonConflict(
      'series_in_use',
      `${issued} document(s) already carry this prefix; changing it needs force`,
      { issued_count: issued },
    )
  }
  if (nextNumber < row.next_number) {
    throw validationError([
      { path: 'next_number', message: 'next_number_decrease', code: 'next_number_decrease' },
    ])
  }
  formatIssuesOrThrow({ doc_type: docType, prefix, padding, next_number: nextNumber })
  if (prefixChange) await assertPrefixFree(tx, ctx, row.fy, prefix, key)
  const codes = await codesOf(tx, ctx, row.store_id, row.register_id)
  const before = { prefix: row.prefix, padding: row.padding, next_number: row.next_number }
  const after = { prefix, padding, next_number: nextNumber }
  const changes = diffChanges(before, after)
  if (!changes) return toSeries(key, codes, row)
  const updated = await tx
    .updateTable('number_series')
    .set(after)
    .where('tenant_id', '=', ctx.tenantId)
    .where('id', '=', id)
    .returning(['id', 'prefix', 'padding', 'next_number', 'updated_at'])
    .executeTakeFirstOrThrow()
  const series = toSeries(key, codes, updated)
  const forced = prefixChange && issued > 0
  await audit(tx, ctx, {
    action: forced ? 'number_series.prefix_force_change' : 'number_series.update',
    entity_type: 'number_series',
    entity_id: id,
    summary: forced
      ? `Prefix of ${docType} ${row.fy} forced from "${row.prefix}" to "${prefix}" after ${issued} document(s)`
      : `Number series ${docType} ${row.fy} changed: next ${series.next}`,
    changes: { ...changes, ...(forced ? { forced: true, issued_count: issued } : {}) },
  })
  return series
}
